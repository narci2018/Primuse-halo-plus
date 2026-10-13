'use strict';
/**
 * 本地持久化：设置、线路、服务器型源、收藏、最近播放、队列。
 *
 * iPhone 侧的对应物：
 *   - 聚合线路清单 → UserDefaults 键 `primuse.aggregated_sources.v2`（AggregatedSourceStore.swift:9）
 *   - 服务器源的连接参数 → `MusicSource`（host/port/useSsl/basePath/username，MusicSource.swift:1136-1152）
 *   - **密码 → Keychain**（AddSourceView.swift:1435 `KeychainService.setPassword`）
 *     Windows 的等价物是 Electron `safeStorage`（DPAPI，按当前用户加密），落在 userData 下。
 *
 * 首版不写 SQLite：在线搜索与道理鱼浏览都不需要镜像整库（道理鱼走服务端分页
 * `skip/take`），少一个原生依赖也就少一类发版风险。
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { normalizeSources, DEFAULT_SOURCES } = require('./aggregated');

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
    queue: { items: [], index: 0, position: 0 },
    player: { volume: 0.8, repeat: 'off', shuffle: false },
    settings: { minimizeToTray: true, platformFilter: 'all', pageSize: 100 },
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
  return cache;
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

module.exports = { load, save, aggregated, servers, library, credentialsAvailable, trackKey };
