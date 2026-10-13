// 只读探测真机云端：用 App 自己的网络栈（httpx = Node https）拉一次设备列表与
// iPhone 的备份，再交给 sync.fromWirePlaylist 走一遍真实反解。
//
// 为什么需要它：`playlist-sync-contract-test.js` 跑的是假服务器，证明的是"契约字段
// 没写错"；它证明不了"这台机器的网络能到 pages.dev"（本机 curl 就会撞上 Windows
// schannel 的 CRYPT_E_REVOCATION_OFFLINE，而 Node/BoringSSL 不做吊销检查，两条路
// 径结论可以相反）。这个脚本只 GET，绝不 POST —— 不许往用户的云端备份里写东西。
//
// 用法：node scripts/probe-live-sync.js [deviceId]
const path = require('path');
const Module = require('module');

// sync.js 顶部 require('./store')，而 store.js 依赖 electron（这里没有 Electron）。
// 与契约测试同一招：先把 store 换成内存桩，再 require 真的 sync.js。
const storePath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'store.js'));
const stub = new Module(storePath, null);
stub.filename = storePath;
stub.loaded = true;
stub.exports = {
  LIKED_PLAYLIST_ID: 'primuse.system.liked',
  sync: { config: () => ({ serverURL: process.env.PRIMUSE_SYNC_URL || 'https://primuse-sync-server.pages.dev/api/sync-playlists', deviceId: '', ownedByThisDevice: false }) },
  playlists: { list: () => [] },
};
require.cache[storePath] = stub;

const sync = require(path.join(__dirname, '..', 'src', 'main', 'sync.js'));

(async () => {
  const devices = await sync.devices();
  console.log(`[probe] 设备 ${devices.length} 台：`);
  for (const d of devices) {
    console.log(`  - ${d.device_name} / ${d.platform} / ${d.playlist_count} 个歌单 / ${d.song_count} 首 / ${new Date(d.updated_at).toLocaleString('zh-Hans-CN')}`);
  }

  const target = process.argv[2] || (devices[0] || {}).device_id;
  if (!target) {
    console.log('[probe] 云端没有任何设备行，跳过备份解析');
    return;
  }
  const data = await sync.fetchPlaylistRaw(target);
  const raw = (data && data.playlists) || [];
  const parsed = raw.map((p) => ({ name: p.name, songs: (p.songs || []).map((s) => sync.fromWireSong(s)) }));
  const all = parsed.flatMap((p) => p.songs);
  const unresolved = all.filter((t) => t.unresolved);
  console.log(
    `[probe] ${target} 的备份解析成功：${parsed.length} 个歌单 / ${all.length} 首，` +
      `可反解为聚合轨道 ${all.filter((t) => t.kind === 'aggregated').length} 首，` +
      `标「无对应源」${unresolved.length} 首`
  );
  for (const p of parsed) console.log(`  - ${p.name}：${p.songs.length} 首`);
  if (unresolved.length) console.log(`  未解析样例：${unresolved.slice(0, 3).map((t) => `${t.title || t.rawID}`).join('、')}`);
  console.log('[probe] 全程只发 GET，未上传任何数据');
})().catch((error) => {
  console.error('[probe] FAILED —', error.message);
  process.exit(1);
});
