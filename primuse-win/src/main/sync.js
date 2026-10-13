'use strict';
/**
 * 歌单云端同步（备份 / 恢复 / 跨设备导入）。
 *
 * 契约来自 `Primuse/Services/Playlist/PlaylistSyncService.swift`，服务端是
 * `cf-sync-server/functions/api/sync-playlists.js`（Cloudflare Pages + D1），
 * 现网已在 `https://primuse-sync-server.pages.dev` 跑着，iPhone 已经在往里写。
 *
 * 线上真实数据（2026-10-14 实测 GET 得到）：
 *   deviceId 86A75176-7E98-48AC-9E80-32FD9875974F / device_name "iPhone" / platform "iOS"
 *   4 个歌单：经典 232 首、我喜欢 1 首（id = primuse.system.liked）、神咒 2 首、佛经 6 首
 *   歌曲条目形如
 *   {"id":"agg_qq_004TXgZ41ST7lB","title":"黄昏…","artist":"落日微醺","album":"…",
 *    "duration":245.28,"filePath":"/aggregated/qq/004TXgZ41ST7lB.mp3","sourceId":"system-aggregated-music"}
 *
 * 关键分层（这一点是用户明确纠正过的）：**服务器同步的是歌单结构，不是歌曲源**。
 * 上传/下载的都是 id/title/artist/album/duration/filePath/sourceId；音频仍然由播放层
 * （内置聚合线路或本机道理鱼源）在播放瞬间解析。所以"同步成功"不等于"每首都放得响"，
 * 本机没有对应源的曲目会在 UI 上标「无对应源」，而不是假装能播。
 *
 * 与 iPhone 的语义差异（有意为之，否则 Windows 上会拿到空歌单）：
 * Swift 的 restore 是"按 id / title+artist 匹配到本地资料库已有歌曲"（:159-183），
 * 而 Windows 首版没有本地歌曲表 —— 照抄会得到一堆空歌单。因此 Windows 把云端条目
 * 直接落成自包含的歌单成员（能反解成 agg_/dly_ 轨道的就反解），不做本地库匹配。
 */

const store = require('./store');
const { request } = require('./httpx');

const SYSTEM_AGGREGATED_SOURCE_ID = 'system-aggregated-music'; // AggregatedMusicService.swift:10
const TIMEOUT_MS = 20000; // PlaylistSyncService.swift: request.timeoutInterval = 20

// MARK: - 轨道 ↔ 云端条目

/** 本地 track → 云端 song（字段集合与 SyncSongEntry 逐一对齐） */
function toWireSong(track) {
  const song = {
    id: '',
    title: String(track.title || ''),
    artist: track.artist || null,
    album: track.album || null,
    duration: Number(track.duration) > 0 ? Number(track.duration) : null,
    filePath: null,
    sourceId: null,
  };
  if (track.kind === 'server') {
    song.id = track.id || `dly_${track.sourceID}_${track.rawID}`;
    song.filePath = track.filePath || `/server/${track.sourceID}/${track.rawID}`;
    song.sourceId = track.sourceID;
  } else {
    // AggregatedMusicService.swift:228/269 与 AggregatedMusicModels.swift:144
    song.id = `agg_${track.platform}_${track.rawID}`;
    song.filePath = `/aggregated/${track.platform}/${track.rawID}.mp3`;
    song.sourceId = SYSTEM_AGGREGATED_SOURCE_ID;
  }
  return song;
}

/**
 * 云端 song → 本地 track。尽量反解成可直接交给 playback:resolve 的形状；
 * 反解不出来的（本机没有那台服务器源、或 id 不是我们的格式）保留元数据并打 unresolved，
 * UI 会标出来，播放失败时给可读原因。
 */
function fromWireSong(song) {
  const raw = song || {};
  const id = String(raw.id || '');
  const duration = Number(raw.duration) || 0;
  const base = {
    title: String(raw.title || '未知歌曲'),
    artist: raw.artist || '',
    album: raw.album || '',
    duration,
    coverURL: null,
  };

  const agg = id.match(/^agg_([a-z0-9]+)_(.+)$/i);
  if (agg) {
    return { ...base, kind: 'aggregated', platform: agg[1].toLowerCase(), rawID: agg[2], unresolved: false };
  }

  const byPath = String(raw.filePath || '').match(/^\/aggregated\/([a-z0-9]+)\/(.+?)\.[a-z0-9]+$/i);
  if (byPath) {
    return { ...base, kind: 'aggregated', platform: byPath[1].toLowerCase(), rawID: byPath[2], unresolved: false };
  }

  const localIds = new Set(store.servers.list().map((s) => s.id));
  const dly = id.match(/^dly_(.+?)_(.+)$/);
  if (dly && localIds.has(dly[1])) {
    const server = store.servers.list().find((s) => s.id === dly[1]);
    return { ...base, kind: 'server', sourceID: dly[1], sourceName: server.name || server.host, id, rawID: dly[2], unresolved: false };
  }
  if (dly) {
    return { ...base, kind: 'server', sourceID: dly[1], sourceName: '其它设备的服务器源', id, rawID: dly[2], unresolved: true };
  }

  return { ...base, kind: 'aggregated', platform: 'unknown', rawID: id || `sync_${Date.now().toString(36)}`, unresolved: true };
}

function toWirePlaylist(playlist) {
  return {
    id: playlist.id,
    name: playlist.name,
    createdAt: Number(playlist.createdAt) || 0,
    updatedAt: Number(playlist.updatedAt) || Number(playlist.createdAt) || 0,
    songs: (playlist.songs || []).map(toWireSong),
  };
}

function fromWirePlaylist(remote) {
  const songs = Array.isArray(remote && remote.songs) ? remote.songs.map(fromWireSong) : [];
  return {
    id: String((remote && remote.id) || ''),
    name: String((remote && remote.name) || '未命名歌单'),
    createdAt: Number(remote && remote.createdAt) || Date.now(),
    updatedAt: Number(remote && remote.updatedAt) || 0,
    songs,
  };
}

// MARK: - HTTP

function endpoint(serverURL, query) {
  const clean = String(serverURL || store.DEFAULT_SYNC_URL).trim();
  const url = new URL(clean);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

function unwrap(result, label) {
  const env = result.json;
  if (result.statusCode !== 200 || !env || typeof env !== 'object') {
    throw new Error(`${label}失败：HTTP ${result.statusCode} ${String(result.text || '').slice(0, 160)}`);
  }
  // Swift 的判定完全一致：statusCode 200 且 code == 0 才算成功
  if (env.code !== 0) {
    throw new Error(`${label}失败：${env.error || env.message || `code ${env.code}`}`);
  }
  return env.data;
}

async function postBackup(config, playlists) {
  const payload = {
    deviceId: config.deviceId,
    deviceName: config.deviceName || 'Windows PC',
    platform: 'Windows',
    playlists,
  };
  const result = await request(endpoint(config.serverURL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Device-ID': config.deviceId, // PlaylistSyncService.swift 带这个头
    },
    body: JSON.stringify(payload),
    timeoutMs: TIMEOUT_MS,
  });
  return unwrap(result, '备份');
}

// MARK: - 对外能力

async function backup() {
  const config = store.sync.ensureDeviceId();
  // 硬护栏：机器码必须是本机生成的。拿别人设备的 id 备份 = 用本机空歌单覆盖对方那行数据。
  if (!config.ownedByThisDevice || !config.deviceId) {
    throw new Error('本机还没有属于自己的机器码，为避免覆盖其它设备的备份，已拒绝上传');
  }
  const wire = store.playlists.list().map(toWirePlaylist);
  const data = await postBackup(config, wire);
  store.sync.markBackedUp(data && data.updatedAt);
  return { ...data, playlists: wire.length, songs: wire.reduce((n, p) => n + p.songs.length, 0) };
}

async function restore() {
  const config = store.sync.ensureDeviceId();
  const result = await request(endpoint(config.serverURL, { deviceId: config.deviceId }), {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Device-ID': config.deviceId },
    timeoutMs: TIMEOUT_MS,
  });
  if (result.statusCode === 404 || (result.json && result.json.code === 404)) {
    return { empty: true, created: 0, matched: 0, songs: 0, deviceId: config.deviceId };
  }
  const data = unwrap(result, '恢复');
  const incoming = (data.playlists || []).map(fromWirePlaylist);
  const merged = store.playlists.mergeIncoming(incoming);
  return { ...merged, ...pickCounts(data), empty: false };
}

/** 云端设备列表（不带 deviceId 的 GET；服务端 LIMIT 50，按 updated_at 倒序） */
async function devices() {
  const config = store.sync.config();
  const result = await request(endpoint(config.serverURL), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs: TIMEOUT_MS,
  });
  const data = unwrap(result, '读取设备列表');
  return (data && data.devices) || [];
}

/** 跨设备下载歌单：读别人那台设备的备份，合并进本机（本机机器码不变，绝不回写对方） */
async function importFromDevice(sourceDeviceId) {
  const config = store.sync.config();
  const id = String(sourceDeviceId || '').trim();
  if (!id) throw new Error('缺少 deviceId');
  if (id === config.deviceId) throw new Error('这就是本机自己的备份，用「从云端恢复歌单」即可');
  const result = await request(endpoint(config.serverURL, { deviceId: id }), {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Device-ID': id },
    timeoutMs: TIMEOUT_MS,
  });
  const data = unwrap(result, '拉取该设备歌单');
  const incoming = (data.playlists || []).map(fromWirePlaylist);
  const merged = store.playlists.mergeIncoming(incoming);
  return { ...merged, deviceName: data.deviceName || id, serverPlaylistCount: data.playlistCount || incoming.length };
}

/** 单个云端歌单的原始 JSON（「导出」菜单用） */
async function fetchPlaylistRaw(deviceId, playlistId) {
  const config = store.sync.config();
  const result = await request(endpoint(config.serverURL, { deviceId, playlistId }), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs: TIMEOUT_MS,
  });
  return unwrap(result, '读取歌单详情');
}

function localPlaylistSnapshot() {
  return store.playlists.list().map(toWirePlaylist);
}

function pickCounts(data) {
  return {
    serverPlaylistCount: data.playlistCount || 0,
    serverSongCount: data.songCount || 0,
    updatedAt: data.updatedAt || 0,
  };
}

module.exports = {
  backup,
  restore,
  devices,
  importFromDevice,
  fetchPlaylistRaw,
  localPlaylistSnapshot,
  toWireSong,
  fromWireSong,
  toWirePlaylist,
  fromWirePlaylist,
  SYSTEM_AGGREGATED_SOURCE_ID,
};
