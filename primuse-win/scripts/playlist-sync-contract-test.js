'use strict';
/**
 * 歌单同步契约测试（离线，不需要 Electron，也不许打真服务器）。
 *
 * 依据两份真源：
 *   - 客户端：primuse/Primuse/Services/Playlist/PlaylistSyncService.swift
 *   - 服务端：cf-sync-server/functions/api/sync-playlists.js（D1 表 device_playlists）
 * 以及 2026-10-14 从 https://primuse-sync-server.pages.dev 实测 GET 回来的真实数据形状：
 *   {"id":"agg_qq_004TXgZ41ST7lB","title":"黄昏…","artist":"落日微醺","album":"…",
 *    "duration":245.28,"filePath":"/aggregated/qq/004TXgZ41ST7lB.mp3","sourceId":"system-aggregated-music"}
 *
 * 运行：node scripts/playlist-sync-contract-test.js
 */

const http = require('http');
const path = require('path');

// sync.js 依赖 store（Electron 模块），这里先把它换成内存假实现，再 require 真的 sync.js
const storePath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'store.js'));

const IPHONE_DEVICE_ID = '86A75176-7E98-48AC-9E80-32FD9875974F';
const LIKED_ID = 'primuse.system.liked';

const state = {
  rows: new Map(), // device_id -> row（模拟 D1 的 device_playlists 表）
  requests: [],
  owned: true,
  deviceId: 'WINDOWS-OWN-DEVICE-ID',
  favorites: [],
  playlists: [],
};

function likedView() {
  return { id: LIKED_ID, name: '我喜欢', isSystem: true, createdAt: 0, updatedAt: 0, songs: state.favorites };
}

require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    DEFAULT_SYNC_URL: 'https://primuse-sync-server.pages.dev/api/sync-playlists',
    LIKED_PLAYLIST_ID: LIKED_ID,
    sync: {
      ensureDeviceId: () => ({
        serverURL: SERVER_URL(),
        deviceId: state.deviceId,
        deviceName: 'test-win',
        platform: 'Windows',
        ownedByThisDevice: state.owned,
      }),
      config: () => ({ serverURL: SERVER_URL(), deviceId: state.deviceId, ownedByThisDevice: state.owned }),
      markBackedUp: (at) => {
        state.lastBackupAt = at;
      },
    },
    playlists: {
      LIKED_ID,
      list: () => [likedView(), ...state.playlists],
      get: (id) => (id === LIKED_ID ? likedView() : state.playlists.find((p) => p.id === id) || null),
      mergeIncoming: (incoming) => {
        let created = 0;
        let matched = 0;
        let songs = 0;
        for (const raw of incoming) {
          if (raw.id === LIKED_ID) {
            for (const t of raw.songs) {
              if (!state.favorites.some((f) => f.rawID === t.rawID && f.platform === t.platform)) {
                state.favorites.push(t);
                songs += 1;
              }
            }
            matched += 1;
            continue;
          }
          let pl = state.playlists.find((p) => p.id === raw.id || p.name === raw.name);
          if (!pl) {
            pl = { id: raw.id, name: raw.name, createdAt: raw.createdAt, updatedAt: raw.updatedAt, songs: [] };
            state.playlists.push(pl);
            created += 1;
          } else matched += 1;
          for (const t of raw.songs) {
            if (!pl.songs.some((x) => x.rawID === t.rawID && x.platform === t.platform)) {
              pl.songs.push(t);
              songs += 1;
            }
          }
        }
        return { created, matched, songs };
      },
    },
    servers: { list: () => [{ id: 'dly-local-1', name: '本机道理鱼', host: '127.0.0.1' }] },
  },
};

let PORT = 0;
let iphoneRawSnapshot = null;
const SERVER_URL = () => `http://127.0.0.1:${PORT}/api/sync-playlists`;

const sync = require(path.join(__dirname, '..', 'src', 'main', 'sync.js'));

// MARK: - 假服务器（照 cf-sync-server 的语义）

function rowToJson(row) {
  return {
    device_id: row.deviceId,
    device_name: row.deviceName,
    platform: row.platform,
    playlists_json: JSON.stringify(row.playlists),
    playlist_count: row.playlists.length,
    song_count: row.playlists.reduce((n, p) => n + (p.songs || []).length, 0),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function serve(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    state.requests.push({ method: req.method, search: url.search, headers: req.headers, body });
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) {
        // 真服务器的列表查询不返回 playlists_json（只给概览字段），这里照做
        const devices = [...state.rows.values()]
          .map(rowToJson)
          .map(({ playlists_json, ...rest }) => rest)
          .sort((a, b) => b.updated_at - a.updated_at);
        return send(200, { code: 0, message: '获取设备列表成功', data: { devices } });
      }
      const row = state.rows.get(deviceId);
      if (!row) return send(404, { code: 404, message: '未找到该设备的歌单备份数据', data: null });
      const playlistId = url.searchParams.get('playlistId');
      if (playlistId) {
        const matched = row.playlists.find((p) => p.id === playlistId || p.name === playlistId);
        if (!matched) return send(404, { code: 404, message: '未找到指定歌单', data: null });
        return send(200, { code: 0, data: { deviceId: row.deviceId, deviceName: row.deviceName, playlist: matched } });
      }
      return send(200, {
        code: 0,
        message: '获取成功',
        data: {
          deviceId: row.deviceId,
          deviceName: row.deviceName,
          platform: row.platform,
          playlistCount: row.playlists.length,
          songCount: row.playlists.reduce((n, p) => n + (p.songs || []).length, 0),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          playlists: row.playlists,
        },
      });
    }

    if (req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return send(400, { code: 400, error: '请求格式错误，必须为合法 JSON' });
      }
      if (!payload.deviceId) return send(400, { code: 400, error: '缺少必需字段：deviceId' });
      if (!Array.isArray(payload.playlists)) return send(400, { code: 400, error: '缺少必需字段：playlists' });
      const now = Date.now();
      const existing = state.rows.get(payload.deviceId);
      state.rows.set(payload.deviceId, {
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        platform: payload.platform,
        playlists: payload.playlists,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      });
      return send(200, {
        code: 0,
        message: '歌单同步备份成功',
        data: {
          deviceId: payload.deviceId,
          playlistCount: payload.playlists.length,
          songCount: payload.playlists.reduce((n, p) => n + (p.songs || []).length, 0),
          updatedAt: now,
        },
      });
    }

    return send(405, { code: 405, error: '不支持的请求方法' });
  });
}

// MARK: - 断言

let failures = 0;
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

check('聚合曲目上报字段与 iPhone 实测字节一致', () => {
  const wire = sync.toWireSong({ kind: 'aggregated', platform: 'qq', rawID: '004TXgZ41ST7lB', title: '黄昏', artist: '落日微醺', album: '黄昏（R&B版）', duration: 245.28551020408165 });
  assert(wire.id === 'agg_qq_004TXgZ41ST7lB', `id 应为 agg_qq_…，实际 ${wire.id}`);
  assert(wire.filePath === '/aggregated/qq/004TXgZ41ST7lB.mp3', `filePath 实际 ${wire.filePath}`);
  assert(wire.sourceId === 'system-aggregated-music', `sourceId 实际 ${wire.sourceId}`);
  assert(Math.abs(wire.duration - 245.2855) < 0.01, 'duration 要带小数');
  assert(JSON.stringify(Object.keys(wire).sort()) === JSON.stringify(['album', 'artist', 'duration', 'filePath', 'id', 'sourceId', 'title']), 'SyncSongEntry 字段集合要完全一致');
});

check('云端条目能反解回可播放的聚合轨道（往返一致）', () => {
  const original = { kind: 'aggregated', platform: 'netease', rawID: '31477687', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269 };
  const back = sync.fromWireSong(sync.toWireSong(original));
  assert(back.kind === 'aggregated' && back.platform === 'netease' && back.rawID === '31477687', `反解失败 ${JSON.stringify(back)}`);
  assert(back.unresolved === false, '聚合曲目不应标 unresolved');
});

check(' filePath 兜底：id 不是 agg_ 时按 /aggregated/{platform}/{id}.mp3 反解', () => {
  const back = sync.fromWireSong({ id: 'weird-uuid', filePath: '/aggregated/kugou/ABC123.flac', title: 'X' });
  assert(back.platform === 'kugou' && back.rawID === 'ABC123', JSON.stringify(back));
});

check(' 其它设备的服务器源曲目：保留元数据并标 unresolved（不假装能播）', () => {
  const known = sync.fromWireSong({ id: 'dly_dly-local-1_9527', title: '本机有的源' });
  assert(known.kind === 'server' && known.sourceID === 'dly-local-1' && known.unresolved === false, JSON.stringify(known));
  const foreign = sync.fromWireSong({ id: 'dly_dly-other-9_9527', title: '别的机器上的道理鱼' });
  assert(foreign.unresolved === true && foreign.sourceID === 'dly-other-9', JSON.stringify(foreign));
});

check('备份：用本机自己的机器码 + X-Device-ID 头，且绝不碰 iPhone 那行', async () => {
  state.playlists = [
    { id: 'PL-1', name: '经典', createdAt: 1, updatedAt: 2, songs: [{ kind: 'aggregated', platform: 'netease', rawID: '31477687', title: '晴天', artist: '周杰伦', duration: 269 }] },
  ];
  state.favorites = [{ kind: 'aggregated', platform: 'qq', rawID: '004TXgZ41ST7lB', title: '黄昏', addedAt: 5 }];
  const iphoneSnapshot = JSON.stringify(state.rows.get(IPHONE_DEVICE_ID));
  const before = state.requests.length;
  const data = await sync.backup();
  const post = state.requests.slice(before).find((r) => r.method === 'POST');
  assert(post, '没有发出 POST');
  assert(post.headers['x-device-id'] === state.deviceId, `X-Device-ID 实际 ${post.headers['x-device-id']}`);
  assert(post.headers['content-type'].includes('application/json'), 'Content-Type 必须是 JSON');
  const payload = JSON.parse(post.body);
  assert(payload.deviceId === state.deviceId, 'deviceId 必须是本机的');
  assert(payload.platform === 'Windows', `platform 实际 ${payload.platform}`);
  const names = payload.playlists.map((p) => p.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['我喜欢', '经典']), `应把「我喜欢」一起上报，实际 ${names}`);
  assert(data.playlistCount === 2, `返回体 playlistCount 实际 ${data.playlistCount}`);
  assert(state.lastBackupAt, '备份成功要记下最近备份时间');
  assert(JSON.stringify(state.rows.get(IPHONE_DEVICE_ID)) === iphoneSnapshot, 'iPhone 那行数据不许被动到');
});

check(' 机器码不是本机持有时拒绝备份（防覆盖他人数据）', async () => {
  state.owned = false;
  const before = state.requests.filter((r) => r.method === 'POST').length;
  let error = null;
  try {
    await sync.backup();
  } catch (e) {
    error = e.message;
  }
  state.owned = true;
  assert(error && error.includes('覆盖'), `应拒绝并说明原因，实际 ${error}`);
  assert(state.requests.filter((r) => r.method === 'POST').length === before, '拒绝时不许发请求');
});

check('恢复：拉自己的备份并合并进本地', async () => {
  state.playlists = [];
  state.favorites = [];
  const res = await sync.restore();
  assert(res.empty === false, '不该是空');
  assert(res.created === 1 && res.matched === 1, `created/matched 实际 ${res.created}/${res.matched}`);
  assert(state.playlists.length === 1 && state.playlists[0].name === '经典', '本地应有「经典」');
  assert(state.favorites.length === 1 && state.favorites[0].platform === 'qq', '「我喜欢」应落回 favorites');
  assert(state.playlists[0].songs[0].rawID === '31477687', '曲目应可反解');
});

check(' 设备列表 + 跨设备下载（只读，不回写云端）', async () => {
  const list = await sync.devices();
  assert(list.length === 2, `应有两台设备，实际 ${list.length}`);
  const iphone = list.find((d) => d.device_id === IPHONE_DEVICE_ID);
  assert(iphone && iphone.platform === 'iOS' && iphone.song_count === 6 && iphone.playlist_count === 4, `iPhone 行实际 ${JSON.stringify(iphone)}`);

  const before = state.requests.length;
  const res = await sync.importFromDevice(IPHONE_DEVICE_ID);
  assert(res.deviceName === 'iPhone', '应带来源设备名');
  assert(state.playlists.some((p) => p.name === '神咒'), '本地应出现「神咒」');
  const agg = state.playlists.find((p) => p.name === '经典').songs.find((t) => t.rawID === '004TXgZ41ST7lB');
  assert(agg && agg.platform === 'qq' && agg.unresolved === false, 'iPhone 的聚合曲目应在本机可直接播');
  assert(state.requests.slice(before).every((r) => r.method === 'GET'), '跨设备导入只允许 GET');
  assert(JSON.stringify(state.rows.get(IPHONE_DEVICE_ID)) === iphoneRawSnapshot, '导入不许改写 iPhone 的备份');
});

check(' 导入自己的 deviceId 时拒绝（避免自覆盖）', async () => {
  let error = null;
  try {
    await sync.importFromDevice(state.deviceId);
  } catch (e) {
    error = e.message;
  }
  assert(error && error.includes('本机'), `应拒绝自己的 deviceId，实际 ${error}`);
});

check(' 云端 404 要转成可读错误，而不是静默成功', async () => {
  let error = null;
  try {
    await sync.importFromDevice('NO-SUCH-DEVICE');
  } catch (e) {
    error = e.message;
  }
  assert(error && error.includes('未找到'), `实际 ${error}`);
});

check(' 本机从未备份过时 restore 返回 empty，而不是报错', async () => {
  state.deviceId = 'NEVER-BACKED-UP';
  const res = await sync.restore();
  state.deviceId = 'WINDOWS-OWN-DEVICE-ID';
  assert(res.empty === true, JSON.stringify(res));
});

// MARK: - 跑

(async () => {
  // 预置 iPhone 的真实备份（232 首里取 3 首代表，格式与线上一致）
  state.rows.set(IPHONE_DEVICE_ID, {
    deviceId: IPHONE_DEVICE_ID,
    deviceName: 'iPhone',
    platform: 'iOS',
    createdAt: 1,
    updatedAt: 1,
    playlists: [
      {
        id: '5CA0053C-DFD4-4B60-8558-E5A2B7C608E1',
        name: '经典',
        createdAt: 1,
        updatedAt: 2,
        songs: [
          { id: 'agg_qq_004TXgZ41ST7lB', title: '黄昏（纵然青丝如霜）', artist: '落日微醺', album: '黄昏（纵然青丝如霜）（R&B版）', duration: 245.2855, filePath: '/aggregated/qq/004TXgZ41ST7lB.mp3', sourceId: 'system-aggregated-music' },
          { id: 'agg_netease_31477687', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269.0, filePath: '/aggregated/netease/31477687.mp3', sourceId: 'system-aggregated-music' },
          { id: 'agg_kugou_abc', title: '酷狗样本', artist: '某人', album: '', duration: 0, filePath: '/aggregated/kugou/abc.mp3', sourceId: 'system-aggregated-music' },
        ],
      },
      { id: 'primuse.system.liked', name: '我喜欢', createdAt: 1, updatedAt: 2, songs: [{ id: 'agg_qq_004TXgZ41ST7lB', title: '黄昏（纵然青丝如霜）', artist: '落日微醺', duration: 245.2855, filePath: '/aggregated/qq/004TXgZ41ST7lB.mp3', sourceId: 'system-aggregated-music' }] },
      { id: '19F20EB4-B645-4BED-A4F9-2C1384F0BADD', name: '神咒', createdAt: 1, updatedAt: 2, songs: [{ id: 'agg_netease_999', title: '咒 A', artist: '', filePath: '/aggregated/netease/999.mp3', sourceId: 'system-aggregated-music' }] },
      { id: 'CF07F81A-6D6A-414C-9539-2E3517519379', name: '佛经', createdAt: 1, updatedAt: 2, songs: [{ id: 'agg_netease_888', title: '经 A', artist: '', filePath: '/aggregated/netease/888.mp3', sourceId: 'system-aggregated-music' }] },
    ],
  });
  iphoneRawSnapshot = JSON.stringify(state.rows.get(IPHONE_DEVICE_ID));

  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  PORT = server.address().port;
  console.log(`[contract] 假同步服务器 http://127.0.0.1:${PORT}/api/sync-playlists`);

  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL  ${name} — ${error.message}`);
    }
  }

  server.close();
  if (failures) {
    console.log(`[contract] RESULT failed: ${failures}/${checks.length}`);
    process.exit(1);
  }
  console.log(`[contract] RESULT ok: ${checks.length}/${checks.length} 通过`);
  process.exit(0);
})();
