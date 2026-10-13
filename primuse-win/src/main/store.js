'use strict';
/**
 * 本地持久化：设置、线路、服务器型源、歌单（含「我喜欢」）、最近播放、队列、同步配置。
 *
 * iPhone 侧的对应物：
 *   - 聚合线路清单 → UserDefaults 键 `primuse.aggregated_sources.v2`（AggregatedSourceStore.swift:9）
 *   - 服务器源的连接参数 → `MusicSource`（host/port/useSsl/basePath/username，MusicSource.swift:1136-1152）
 *   - **密码 → Keychain**（AddSourceView.swift:1435 `KeychainService.setPassword`）
 *     Windows 的等价物是 Electron `safeStorage`（DPAPI，按当前用户加密），落在 userData 下。
 *   - 歌单 → `Playlist` + `PlaylistSong(playlistID, songID, sortOrder)`
 *     （PrimuseKit/.../Models/Playlist.swift:4-109，建表 LibraryDatabase.swift:91-104，
 *      读时按 `sortOrder ASC`（:446-457），追加用 `MAX(sortOrder)+1`（:458-463））。
 *     Windows 没有 GRDB，歌单成员直接内联成 JSON 数组 —— 数组顺序就是 sortOrder。
 *     内联而不是只存 songID 的原因：iPhone 有整库（歌曲表）可以按 id 查回曲目，
 *     Windows 首版没有本地文件库，一个只有 id 的歌单成员是放不出声的空壳。
 *   - 「我喜欢」→ `MusicLibrary.likedSongsPlaylistID = "primuse.system.liked"`
 *     （MusicLibrary.swift:5138，首次 toggle 时懒建 :5140）。Windows 同样懒建，
 *     但把它做成 `favorites` 数组的**派生视图**：一份真源，同步时按同一个固定 id 上报，
 *     这样多端（iPhone ↔ Windows）拉到的「我喜欢」能对得上，也不会出现两份收藏。
 *
 * 备注：`Album`（专辑）在原 App 里是派生数据（id = SHA256(artist+album)），用户不能增删改，
 * 所以本文件只提供歌单（playlist）的 CRUD，不提供专辑的 CRUD。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const { normalizeSources, DEFAULT_SOURCES } = require('./aggregated');

const LIKED_PLAYLIST_ID = 'primuse.system.liked'; // MusicLibrary.swift:5138
const LIKED_PLAYLIST_NAME = '我喜欢'; // playlist_liked_name（Localizable.strings:1315）
const DEFAULT_SYNC_URL = 'https://primuse-sync-server.pages.dev/api/sync-playlists'; // PlaylistSyncService.swift:9

let cache = null;
let flushTimer = null;

function files() {
  const dir = app.getPath('userData');
  return { dir, data: path.join(dir, 'primuse.json'), creds: path.join(dir, 'credentials.json') };
}

function defaults() {
  return {
    version: 1,
    aggregatedSources: normalizeSources([]),
    serverSources: [],
    favorites: [],
    history: [],
    playlists: [],
    queue: { items: [], index: 0, position: 0 },
    player: { volume: 0.8, repeat: 'off', shuffle: false },
    settings: { minimizeToTray: true, platformFilter: 'all', pageSize: 100 },
    // deviceId 由本机生成并持有（ownedByThisDevice），永不与 iPhone 那台设备共用，
    // 否则备份会覆盖掉他手机上的 232 首真实数据。
    sync: { serverURL: DEFAULT_SYNC_URL, deviceId: '', deviceName: '', platform: 'Windows', ownedByThisDevice: false, lastBackupAt: 0 },
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function load() {
  if (cache) return cache;
  const { data } = files();
  const stored = readJson(data);
  cache = { ...defaults(), ...(stored || {}) };
  cache.aggregatedSources = normalizeSources(cache.aggregatedSources);
  cache.serverSources = (cache.serverSources || []).map((s) => ({ insecureTLS: false, kind: 'daoliyu', ...s }));
  cache.playlists = (cache.playlists || [])
    .filter((p) => p && p.id && p.id !== LIKED_PLAYLIST_ID) // 「我喜欢」永远派生自 favorites
    .map((p) => ({ songs: [], ...p, songs: (p.songs || []).filter(Boolean) }));
  cache.sync = { ...defaults().sync, ...(stored && stored.sync ? stored.sync : {}) };
  if (!cache.sync.serverURL) cache.sync.serverURL = DEFAULT_SYNC_URL;
  if (!cache.sync.deviceName) cache.sync.deviceName = hostname();
  return cache;
}

function hostname() {
  try {
    return os.hostname() || 'Windows PC';
  } catch {
    return 'Windows PC';
  }
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

function save(now = false) {
  if (flushTimer) clearTimeout(flushTimer);
  const flush = () => {
    flushTimer = null;
    const { data } = files();
    try {
      fs.mkdirSync(path.dirname(data), { recursive: true });
      writeJson(data, cache);
    } catch (error) {
      console.error('[store] 写入失败', error.message);
    }
  };
  if (now) flush();
  else flushTimer = setTimeout(flush, 250);
}

// MARK: - 凭据（密码）

function credentialsAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function setPassword(sourceID, password) {
  const { creds } = files();
  const map = readJson(creds) || {};
  if (!password) {
    delete map[sourceID];
  } else if (credentialsAvailable()) {
    map[sourceID] = { encrypted: safeStorage.encryptString(password).toString('base64') };
  } else {
    // DPAPI 不可用时才退化成明文，并把这一事实暴露给 UI（不要静默降级）
    map[sourceID] = { plain: password, warning: '本机 safeStorage 不可用，密码以明文存储' };
  }
  writeJson(creds, map);
}

function getPassword(sourceID) {
  const { creds } = files();
  const map = readJson(creds) || {};
  const entry = map[sourceID];
  if (!entry) return '';
  if (entry.encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'));
    } catch {
      return '';
    }
  }
  return entry.plain || '';
}

// MARK: - 聚合线路

function updateAggregated(fn) {
  const state = load();
  state.aggregatedSources = fn(state.aggregatedSources.slice());
  save();
  return state.aggregatedSources;
}

const aggregated = {
  list: () => load().aggregatedSources,
  toggle(id) {
    return updateAggregated((list) => list.map((s) => (s.id === id ? { ...s, isEnabled: !s.isEnabled } : s)));
  },
  upsert(source) {
    return updateAggregated((list) => {
      const next = { latencyMs: 0, isEnabled: true, priority: 5, ...source };
      if (!next.id) next.id = `user-${Date.now().toString(36)}`;
      const idx = list.findIndex((s) => s.id === next.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...next };
      else list.push(next);
      list.sort((a, b) => b.priority - a.priority);
      return list;
    });
  },
  remove(id) {
    return updateAggregated((list) => list.filter((s) => s.id !== id && !String(s.id).startsWith('default-')));
  },
  reset() {
    return updateAggregated(() => normalizeSources(DEFAULT_SOURCES.map((d) => ({ ...d }))));
  },
  setLatency(id, latencyMs) {
    return updateAggregated((list) => list.map((s) => (s.id === id ? { ...s, latencyMs } : s)));
  },
};

// MARK: - 服务器型源（密码单独存，列表里只留非敏感字段）

const servers = {
  list: () => load().serverSources.map(({ hasPassword, ...rest }) => ({ ...rest, hasPassword: Boolean(getPassword(rest.id)) })),
  full: (id) => {
    const found = load().serverSources.find((s) => s.id === id);
    if (!found) return null;
    return { ...found, password: getPassword(id) };
  },
  upsert(config) {
    const state = load();
    const next = { kind: 'daoliyu', insecureTLS: false, useSSL: false, port: null, basePath: '', ...config };
    if (!next.id) next.id = `dly-${Date.now().toString(36)}`;
    const idx = state.serverSources.findIndex((s) => s.id === next.id);
    const { password, ...persisted } = next;
    if (idx >= 0) state.serverSources[idx] = { ...state.serverSources[idx], ...persisted };
    else state.serverSources.push(persisted);
    if (password !== undefined) setPassword(next.id, password);
    save();
    return servers.list();
  },
  remove(id) {
    const state = load();
    state.serverSources = state.serverSources.filter((s) => s.id !== id);
    setPassword(id, '');
    save();
    return servers.list();
  },
};

// MARK: - 收藏 / 历史 / 队列

function trackKey(track) {
  return `${track.kind}:${track.sourceID || track.platform}:${track.rawID}`;
}

const library = {
  favorites: () => load().favorites,
  isFavorite(track) {
    const key = trackKey(track);
    return load().favorites.some((t) => trackKey(t) === key);
  },
  toggleFavorite(track) {
    const state = load();
    const key = trackKey(track);
    const idx = state.favorites.findIndex((t) => trackKey(t) === key);
    if (idx >= 0) state.favorites.splice(idx, 1);
    else state.favorites.unshift({ ...track, addedAt: Date.now() });
    save();
    return state.favorites;
  },
  pushHistory(track, playedSeconds = 0) {
    const state = load();
    const key = trackKey(track);
    state.history = state.history.filter((t) => trackKey(t) !== key);
    state.history.unshift({ ...track, playedAt: Date.now(), playedSeconds });
    state.history = state.history.slice(0, 500);
    save();
    return state.history;
  },
  history: () => load().history,
  clearHistory() {
    const state = load();
    state.history = [];
    save();
    return [];
  },
  saveQueue(queue) {
    const state = load();
    state.queue = queue || { items: [], index: 0, position: 0 };
    save();
    return state.queue;
  },
  queue: () => load().queue,
  setPlayer(patch) {
    const state = load();
    state.player = { ...state.player, ...(patch || {}) };
    save();
    return state.player;
  },
  player: () => load().player,
  setSettings(patch) {
    const state = load();
    state.settings = { ...state.settings, ...(patch || {}) };
    save();
    return state.settings;
  },
  settings: () => load().settings,
};

// MARK: - 歌单（我喜欢 = favorites 的派生视图；其余歌单存本机 JSON）

/** MusicLibrary.swift:5138 —— 同步时按这个固定 id 上报，多端才能对上同一个「我喜欢」 */
function likedView(state) {
  let createdAt = Infinity;
  let updatedAt = 0;
  for (const t of state.favorites) {
    const at = Number(t.addedAt) || 0;
    if (at) {
      if (at < createdAt) createdAt = at;
      if (at > updatedAt) updatedAt = at;
    }
  }
  return {
    id: LIKED_PLAYLIST_ID,
    name: LIKED_PLAYLIST_NAME,
    isSystem: true,
    createdAt: Number.isFinite(createdAt) ? createdAt : updatedAt,
    updatedAt,
    songs: state.favorites,
  };
}

function insertTrackIntoPlaylist(playlist, track) {
  const key = trackKey(track);
  if (playlist.songs.some((t) => trackKey(t) === key)) return false;
  // 追加语义：sortOrder = MAX+1（LibraryDatabase.swift:458-463）。
  // 「我喜欢」沿用现有页面的新在前（收藏是最近加的想立刻看到），普通歌单按加入顺序。
  if (playlist.id === LIKED_PLAYLIST_ID) playlist.songs.unshift({ ...track, addedAt: Date.now() });
  else playlist.songs.push({ ...track, addedAt: Date.now() });
  return true;
}

function removeTrackFromPlaylist(playlist, track) {
  const key = trackKey(track);
  const idx = playlist.songs.findIndex((t) => trackKey(t) === key);
  if (idx < 0) return false;
  playlist.songs.splice(idx, 1);
  return true;
}

const playlists = {
  LIKED_ID: LIKED_PLAYLIST_ID,
  /** MusicLibrary.swift:7707 —— 歌单总览按 updatedAt 倒序 */
  list() {
    const state = load();
    return [likedView(state), ...state.playlists.slice().sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))];
  },
  get(id) {
    const state = load();
    if (id === LIKED_PLAYLIST_ID) return likedView(state);
    return state.playlists.find((p) => p.id === id) || null;
  },
  create(name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('歌单名不能为空');
    const state = load();
    const exists = state.playlists.some((p) => p.name === clean) || clean === LIKED_PLAYLIST_NAME;
    if (exists) throw new Error(`已存在同名歌单「${clean}」`);
    const now = Date.now();
    // 与 Swift 一致用 UUID 形态的 id：他手机上「经典」就是 5CA0053C-DFD4-… 这种大写 UUID
    const playlist = { id: uuid(), name: clean, createdAt: now, updatedAt: now, songs: [] };
    state.playlists.push(playlist);
    save();
    return playlist;
  },
  rename(id, name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('歌单名不能为空');
    if (id === LIKED_PLAYLIST_ID) throw new Error('「我喜欢」是系统歌单，不能重命名');
    const state = load();
    const playlist = state.playlists.find((p) => p.id === id);
    if (!playlist) throw new Error('找不到该歌单');
    if (state.playlists.some((p) => p.id !== id && p.name === clean)) throw new Error(`已存在同名歌单「${clean}」`);
    playlist.name = clean;
    playlist.updatedAt = Date.now();
    save();
    return playlist;
  },
  remove(id) {
    if (id === LIKED_PLAYLIST_ID) throw new Error('「我喜欢」是系统歌单，不能删除');
    const state = load();
    const before = state.playlists.length;
    state.playlists = state.playlists.filter((p) => p.id !== id);
    if (state.playlists.length === before) throw new Error('找不到该歌单');
    save();
    return state.playlists;
  },
  /** sheet 里再点一次已勾选的歌单 = 移出（iPhone 的「添加到歌单」就是这个交互） */
  toggle(id, track) {
    const state = load();
    const playlist = id === LIKED_PLAYLIST_ID ? likedView(state) : state.playlists.find((p) => p.id === id);
    if (!playlist) throw new Error('找不到该歌单');
    const added = insertTrackIntoPlaylist(playlist, track);
    if (id === LIKED_PLAYLIST_ID && !added) removeTrackFromPlaylist(playlist, track);
    if (id !== LIKED_PLAYLIST_ID) {
      if (!added) removeTrackFromPlaylist(playlist, track);
      playlist.updatedAt = Date.now();
    }
    save();
    return { playlist: playlists.get(id), added };
  },
  add(id, track) {
    const state = load();
    const playlist = id === LIKED_PLAYLIST_ID ? likedView(state) : state.playlists.find((p) => p.id === id);
    if (!playlist) throw new Error('找不到该歌单');
    const added = insertTrackIntoPlaylist(playlist, track);
    if (id !== LIKED_PLAYLIST_ID) playlist.updatedAt = Date.now();
    save();
    return { playlist: playlists.get(id), added };
  },
  removeSong(id, track) {
    const state = load();
    const playlist = id === LIKED_PLAYLIST_ID ? likedView(state) : state.playlists.find((p) => p.id === id);
    if (!playlist) throw new Error('找不到该歌单');
    const removed = removeTrackFromPlaylist(playlist, track);
    if (id !== LIKED_PLAYLIST_ID) playlist.updatedAt = Date.now();
    save();
    return { playlist: playlists.get(id), removed };
  },
  /** 手动重排（对齐 PlaylistReorderSheet：只有上/下移动，没有按标题艺人自动排序） */
  move(id, from, to) {
    const state = load();
    const playlist = id === LIKED_PLAYLIST_ID ? likedView(state) : state.playlists.find((p) => p.id === id);
    if (!playlist) throw new Error('找不到该歌单');
    const i = Number(from);
    const j = Number(to);
    if (!Number.isInteger(i) || !Number.isInteger(j)) throw new Error('位置无效');
    if (i < 0 || i >= playlist.songs.length) return playlists.get(id);
    const clamped = Math.max(0, Math.min(playlist.songs.length - 1, j));
    const [item] = playlist.songs.splice(i, 1);
    playlist.songs.splice(clamped, 0, item);
    if (id !== LIKED_PLAYLIST_ID) playlist.updatedAt = Date.now();
    save();
    return playlists.get(id);
  },
  contains(id, track) {
    const playlist = playlists.get(id);
    if (!playlist) return false;
    const key = trackKey(track);
    return playlist.songs.some((t) => trackKey(t) === key);
  },
  /** 导入/恢复用：整份歌单合并进本地（同 id 或同名视为同一个，歌曲按 trackKey 去重） */
  mergeIncoming(incoming) {
    const state = load();
    let created = 0;
    let matched = 0;
    let songs = 0;
    for (const raw of incoming || []) {
      if (!raw) continue;
      const trackList = (raw.songs || []).filter(Boolean);
      if (raw.id === LIKED_PLAYLIST_ID || String(raw.name || '').trim() === LIKED_PLAYLIST_NAME) {
        for (const t of trackList) if (insertTrackIntoPlaylist(likedView(state), t)) songs += 1;
        matched += 1;
        continue;
      }
      let playlist =
        state.playlists.find((p) => p.id === raw.id) ||
        state.playlists.find((p) => p.name === String(raw.name || '').trim());
      if (!playlist) {
        playlist = { id: raw.id || uuid(), name: String(raw.name || '').trim() || '未命名歌单', createdAt: Number(raw.createdAt) || Date.now(), updatedAt: Date.now(), songs: [] };
        state.playlists.push(playlist);
        created += 1;
      } else {
        matched += 1;
      }
      for (const t of trackList) if (insertTrackIntoPlaylist(playlist, t)) songs += 1;
      playlist.updatedAt = Date.now();
    }
    save();
    return { created, matched, songs };
  },
};

// MARK: - 云端同步配置（PlaylistSyncService.swift:11-13 的两个键）

const sync = {
  config() {
    const state = load();
    return { ...state.sync, defaultServerURL: DEFAULT_SYNC_URL };
  },
  setServerURL(url) {
    const state = load();
    const clean = String(url || '').trim();
    if (!/^https?:\/\//i.test(clean)) throw new Error('服务器 URL 格式无效');
    state.sync.serverURL = clean;
    save(true);
    return { ...state.sync };
  },
  setDeviceName(name) {
    const state = load();
    state.sync.deviceName = String(name || '').trim() || hostname();
    save(true);
    return { ...state.sync };
  },
  /** 机器码只由本机生成。ownedByThisDevice 是备份的前置条件：
   *  拿别人（例如 iPhone 那台）的机器码去备份，会把他 232 首的真实数据整行覆盖掉。 */
  ensureDeviceId() {
    const state = load();
    if (!state.sync.deviceId || !state.sync.ownedByThisDevice) {
      state.sync.deviceId = uuid();
      state.sync.ownedByThisDevice = true;
      if (!state.sync.deviceName) state.sync.deviceName = hostname();
      save(true);
    }
    return { ...state.sync };
  },
  markBackedUp(at) {
    const state = load();
    state.sync.lastBackupAt = Number(at) || Date.now();
    save(true);
    return { ...state.sync };
  },
};

module.exports = {
  load,
  save,
  aggregated,
  servers,
  library,
  playlists,
  sync,
  credentialsAvailable,
  trackKey,
  LIKED_PLAYLIST_ID,
  DEFAULT_SYNC_URL,
};
