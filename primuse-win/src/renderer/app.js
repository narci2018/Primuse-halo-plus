'use strict';
/* Primuse 桌面版渲染层。只做视图与播放器编排，任何网络请求都在主进程。 */

const api = window.primuse;
const audio = document.getElementById('audio');

const PLATFORM_LABEL = {
  all: '全部',
  qq: 'QQ',
  netease: '网易',
  kugou: '酷狗',
  kuwo: '酷我',
  bilibili: 'Bili',
  custom: '自定义',
};

const state = {
  meta: null,
  route: 'home',
  sources: [],
  servers: [],
  favorites: [],
  playlists: [],
  playlistView: null,
  sheet: null,
  menu: null,
  history: [],
  results: [],
  searching: false,
  progress: null,
  filter: 'all',
  keyword: '',
  queue: [],
  order: [],
  index: -1,
  repeat: 'off',
  shuffle: false,
  volume: 0.8,
  lyrics: null,
  lyricRows: [],
  lyricIndex: -1,
  drawer: null,
  serverView: { sourceID: null, items: [], total: 0, skip: 0, filter: '', loading: false, error: null },
  form: null,
  settings: {},
  sync: null,
  syncBusy: false,
  syncError: null,
  syncResult: null,
};

const LIKED_PLAYLIST_ID = 'primuse.system.liked'; // MusicLibrary.swift:5138

/* ── 小工具 ───────────────────────────── */

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function coverOf(track) {
  let url = track.coverURL || null;
  if (!url) return null;
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('/')) return null; // 相对路径需要服务器上下文，交给主代理的场景已在 mapTrack 里补全
  // 服务器源的封面要带 Authorization，浏览器不会自动加，所以走本地代理
  if (track.kind === 'server' && state.meta && state.meta.proxyBaseUrl && /^https?:\/\//.test(url)) {
    return `${state.meta.proxyBaseUrl}/img?u=${encodeURIComponent(url)}`;
  }
  return url;
}

let toastTimer = null;
function toast(message, bad = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, bad ? 4200 : 2200);
}

const trackKey = (t) => `${t.kind || 'aggregated'}:${t.sourceID || t.platform}:${t.rawID}`;

function isFavorite(track) {
  return state.favorites.some((t) => trackKey(t) === trackKey(track));
}

// MARK: - 歌单读取（真源在主进程 store，渲染层只拿快照）

function playlistById(id) {
  return state.playlists.find((p) => p.id === id) || null;
}

function playlistSongs(id) {
  if (id === LIKED_PLAYLIST_ID) return state.favorites; // 「我喜欢」= favorites 的派生视图
  return (playlistById(id) || { songs: [] }).songs;
}

function inPlaylist(id, track) {
  const key = trackKey(track);
  return playlistSongs(id).some((t) => trackKey(t) === key);
}

function fmtDate(ms) {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function playlistSubtitle(p) {
  const when = fmtDate(p.updatedAt || p.createdAt);
  return `${p.songs.length} 首${when ? ` · ${when}` : ''}`;
}

async function reloadPlaylists() {
  const res = await api.playlists.list();
  if (res.ok) state.playlists = res.value || [];
  state.favorites = playlistSongs(LIKED_PLAYLIST_ID);
  if (state.playlistView) {
    const one = await api.playlists.get(state.playlistView.id);
    if (one.ok) state.playlistView = one.value;
  }
}

function playlistError(res) {
  if (res.ok) return false;
  toast(res.error || '操作失败', true);
  return true;
}

let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    api.queue.save({ items: state.queue, index: state.index });
    api.player.save({ volume: state.volume, repeat: state.repeat, shuffle: state.shuffle });
  }, 600);
}

/* ── 视图 ─────────────────────────────── */

function songRow(track, listRef, idx) {
  const key = trackKey(track);
  const currentKey = state.queue[state.index] ? trackKey(state.queue[state.index]) : null;
  const playing = key === currentKey;
  const badge =
    track.kind === 'server'
      ? `<span class="badge server">${esc(track.sourceName || '服务器源')}</span>`
      : `<span class="badge ${esc(track.platform)}">${esc(PLATFORM_LABEL[track.platform] || track.platform)}</span>`;
  const unresolved = track.unresolved ? '<span class="badge unresolved" title="同步下来的是歌单结构，本机没有这台服务器源">无对应源</span>' : '';
  const cover = coverOf(track);
  const ref = `${esc(listRef)}:${idx}`;
  const rowActions =
    listRef === 'currentPlaylist'
      ? `<button class="icon-btn" data-next="${ref}" title="接下来播放">⇥</button>
      <button class="icon-btn" data-remove-from-playlist="${ref}" title="从歌单中移除">✕</button>`
      : '';
  return `<tr data-play="${ref}" class="${playing ? 'playing' : ''}">
    <td class="col-play"><button class="icon-btn" data-play="${ref}">${playing ? '▮▮' : '▶'}</button></td>
    <td style="width:44px">${cover ? `<img class="mini-cover" src="${esc(cover)}" loading="lazy">` : '<span class="mini-cover"></span>'}</td>
    <td>${esc(track.title)}</td>
    <td>${esc(track.artist || '')}</td>
    <td>${esc(track.album || '')}</td>
    <td class="col-flags">${badge}${unresolved}</td>
    <td class="muted">${track.duration ? fmtTime(track.duration) : '--:--'}</td>
    <td class="col-flags"><button class="icon-btn ${isFavorite(track) ? 'on' : ''}" data-fav="${ref}">${isFavorite(track) ? '♥' : '♡'}</button>
      <button class="icon-btn" data-queue="${ref}">＋队列</button>
      <button class="icon-btn" data-add-to-playlist="${ref}" title="添加到歌单">＋歌单</button>${rowActions}</td>
  </tr>`;
}

function songTable(tracks, listRef, emptyText) {
  if (!tracks.length) return `<p class="muted">${esc(emptyText)}</p>`;
  return `<table class="songs"><thead><tr>
      <th></th><th></th><th>标题</th><th>艺人</th><th>专辑</th><th>平台</th><th>时长</th><th></th>
    </tr></thead><tbody>${tracks.map((t, i) => songRow(t, listRef, i)).join('')}</tbody></table>`;
}

function viewHome() {
  const enabled = state.sources.filter((s) => s.isEnabled).length;
  const perPlatform = {};
  for (const s of state.sources) {
    if (!s.isEnabled) continue;
    perPlatform[s.platform] = (perPlatform[s.platform] || 0) + 1;
  }
  const serverCards = state.servers
    .map((s) => `<div class="card"><b>${esc(s.name || s.host)}</b><span>${esc(s.host)}${s.port ? `:${s.port}` : ''} · ${s.useSSL ? 'https' : 'http'}</span><div class="row" style="margin-top:8px"><button data-nav="server:${esc(s.id)}">打开曲库</button><button class="ghost" data-nav="addServer:${esc(s.id)}">编辑</button></div></div>`)
    .join('');

  return `<h2>发现</h2><p class="sub">在线聚合音源开箱即用，本 App 没有账号、也没有登录墙。</p>
    <div class="cards">
      <div class="card"><b>在线聚合线路</b><span>${enabled} / ${state.sources.length} 条已启用</span>
        <div class="row" style="margin-top:8px"><button data-nav="online">管理线路</button><button data-nav="search">去搜索</button></div></div>
      <div class="card"><b>我喜欢</b><span>${state.favorites.length} 首</span><div class="row" style="margin-top:8px"><button data-nav="favorites">打开</button></div></div>
      <div class="card"><b>歌单</b><span>${visiblePlaylists().length} 个 · 云端${state.sync && state.sync.lastBackupAt ? '已备份' : '未备份'}</span><div class="row" style="margin-top:8px"><button data-nav="playlists">打开</button><button class="ghost" data-sync-backup="1">上传歌单</button></div></div>
      <div class="card"><b>最近播放</b><span>${state.history.length} 首</span><div class="row" style="margin-top:8px"><button data-nav="history">打开</button></div></div>
      <div class="card"><b>服务器型源</b><span>${state.servers.length} 台已配置</span><div class="row" style="margin-top:8px"><button data-nav="addServer">添加道理鱼 / 服务器源</button></div></div>
    </div>
    <h2 style="font-size:16px">平台可用性</h2>
    <p class="sub">每个平台的线路数（多线路会按优先级自动降级重试）。</p>
    <div class="cards">${['qq', 'netease', 'kugou', 'kuwo', 'bilibili']
      .map((p) => `<div class="card"><b>${esc(PLATFORM_LABEL[p])}</b><span>${perPlatform[p] || 0} 条线路</span><div class="row" style="margin-top:8px"><button data-platform-search="${p}">搜索</button></div></div>`)
      .join('')}</div>
    ${serverCards ? `<h2 style="font-size:16px">我的服务器源</h2><div class="cards">${serverCards}</div>` : ''}`;
}

function viewSearch() {
  const counts = {};
  for (const t of state.results) counts[t.platform] = (counts[t.platform] || 0) + 1;
  const tabs = ['all', ...Object.keys(PLATFORM_LABEL).filter((p) => p !== 'all' && counts[p])]
    .map((p) => `<button class="tab ${state.filter === p ? 'active' : ''}" data-filter="${p}">${PLATFORM_LABEL[p]}${p === 'all' ? ` (${state.results.length})` : ` (${counts[p]})`}</button>`)
    .join('');

  const filtered = filteredResults();
  const head = state.searching
    ? `<p class="sub">正在并发打 ${state.sources.filter((s) => s.isEnabled).length} 条线路…已探测 ${state.progress ? state.progress.done : 0}/${state.progress ? state.progress.total : '?'} 条，先回来的 ${state.results.length} 条已上屏</p>`
    : `<p class="sub">${state.keyword ? `“${esc(state.keyword)}” 共 ${state.results.length} 条` : '输入关键词开始搜索'}</p>`;

  return `<h2>搜索</h2>${head}<div class="tabs">${tabs}</div>
    ${state.results.length ? songTable(filtered, 'results', '') : `<p class="muted">搜索结果来自内置的 9 条聚合线路（与 iPhone 版同一份清单）。若某平台一直为空，可在「在线聚合线路」里换线路或调优先级。</p>`}`;
}

function filteredResults() {
  return state.filter === 'all' ? state.results : state.results.filter((t) => t.platform === state.filter);
}

function viewFavorites() {
  return viewPlaylistFor(LIKED_PLAYLIST_ID, '我喜欢');
}

function visiblePlaylists() {
  // PlaylistListView.swift:36-38 —— 歌单总览过滤掉「我喜欢」，它走侧栏的固定入口。
  return state.playlists.filter((p) => !p.isSystem);
}

/**
 * PlaylistArtworkView 的取图规则（PrimuseKit/.../Playlist.swift:169-227）：
 * 不是"取第一首"，而是用 playlist.id + 排序后的成员 ID 做稳定哈希来排名挑一张。
 * 这里保留"稳定"这个关键性质（同一歌单每次打开封面不变、两端一致），用 FNV-1a 取模实现。
 */
function playlistCover(p) {
  const candidates = (p.songs || []).map(coverOf).filter(Boolean);
  if (!candidates.length) return '<span class="pl-cover">♪</span>';
  const basis = `${p.id}|${(p.songs || []).map((t) => trackKey(t)).sort().join(',')}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const url = candidates[hash % candidates.length];
  return `<span class="pl-cover"><img class="pl-cover" src="${esc(url)}" loading="lazy" alt=""></span>`;
}

function viewPlaylists() {
  const list = visiblePlaylists();
  const rows = list
    .map(
      (p) => `<div class="playlist-row" data-nav="playlist:${esc(p.id)}">
        ${playlistCover(p)}
        <div>
          <div class="pl-name">${esc(p.name)}</div>
          <div class="pl-sub">${esc(playlistSubtitle(p))}</div>
        </div>
        <div class="pl-count">${p.songs.length} 首</div>
        <div class="row" style="justify-content:flex-end">
          <button class="icon-btn" data-play-playlist="${esc(p.id)}" title="全部播放">▶</button>
          <button class="icon-btn" data-nav="playlist:${esc(p.id)}" title="打开">›</button>
        </div>
      </div>`
    )
    .join('');

  const empty = `<p class="muted">没有歌单<br>创建歌单来整理你的音乐。<button class="ghost small" data-new-playlist="1">新建歌单</button></p>`;

  return `<p class="eyebrow">资料库</p><h2>歌单</h2>
    <p class="sub">${list.length ? `${list.length} 个歌单 · 共 ${list.reduce((n, p) => n + p.songs.length, 0)} 首` : '创建歌单来整理你的音乐'}</p>
    <div class="row" style="margin-bottom:14px">
      <button data-new-playlist="1">新建歌单</button>
      <button class="ghost" data-sync-backup="1">上传歌单</button>
      <button class="ghost" data-sync-restore="1">下载歌单</button>
      <button class="ghost" data-import-file="1">导入歌单</button>
      <button class="ghost" data-nav="sync">歌单同步</button>
    </div>
    ${list.length ? rows : empty}`;
}

function viewPlaylist() {
  return viewPlaylistFor(state.playlistView ? state.playlistView.id : LIKED_PLAYLIST_ID);
}

function viewPlaylistFor(id, fallbackName) {
  const p = id === LIKED_PLAYLIST_ID
    ? { id, name: fallbackName || '我喜欢', isSystem: true, songs: state.favorites, updatedAt: 0 }
    : playlistById(id) || { id, name: '找不到歌单', songs: [] };
  const menuOpen = state.menu === `playlist:${p.id}`;
  // PlaylistDetailView.swift:287-363 的 ellipsis 菜单顺序。
  // 省略项：更换封面 / 选择（批量）/ 刮削缺失元数据 —— 前两项依赖本地封面文件与多选态，
  // 第三项是 iPhone 的元数据刮削，Windows 版没有本地歌曲表，不适用。
  const menu = menuOpen
    ? `<div class="menu-pop">
        <button data-reorder="1">重新排序</button>
        <button data-queue-playlist="1">加入播放队列</button>
        <button data-next-playlist="1">接下来播放</button>
        ${p.isSystem ? '' : '<button data-rename-playlist="1">重命名</button>'}
        <button data-pl-export="1">导出</button>
        ${p.isSystem ? '' : `<button class="danger" data-remove-playlist="1">删除歌单</button>`}
      </div>`
    : '';

  return `<p class="eyebrow">${p.isSystem ? '音乐库' : '歌单'}</p><h2>${esc(p.name)}</h2>
    <p class="sub">${p.songs.length} 首歌曲${p.isSystem ? ' · 点心形即收藏' : ` · ${esc(fmtDate(p.updatedAt || p.createdAt))}`}</p>
    <div class="row" style="margin-bottom:14px">
      <button data-play-playlist="${esc(p.id)}">全部播放</button>
      <button class="ghost" data-shuffle-playlist="${esc(p.id)}">随机播放</button>
      <div class="menu">
        <button class="ghost" data-pl-menu="${esc(p.id)}">⋯</button>
        ${menu}
      </div>
    </div>
    ${p.songs.length
      ? songTable(p.songs, 'currentPlaylist', '')
      : `<p class="muted">这首歌单还是空的。在搜索结果里点「＋歌单」，或在服务器源列表里加入。</p>`}`;
}

function viewSync() {
  const cfg = state.sync || {};
  const devices = state.syncDevices || [];
  return `<h2>歌单同步</h2>
    <p class="sub">同步的是<b>歌单结构</b>（歌单名与曲目元数据），不是歌曲源。音频仍在播放瞬间由本机线路解析：内置聚合线路或你自建的服务器型源。</p>
    ${state.syncBusy ? '<p class="sub">正在与云端通信…</p>' : ''}
    ${state.syncError ? `<p class="err">${esc(state.syncError)}</p>` : ''}
    ${state.syncResult ? `<p class="ok">${esc(state.syncResult)}</p>` : ''}
    <form class="grid" id="sync-form">
      <label>服务器端点 (API URL)</label><input name="serverURL" value="${esc(cfg.serverURL || '')}" placeholder="${esc(cfg.defaultServerURL || '')}">
      <label>设备名称</label><input name="deviceName" value="${esc(cfg.deviceName || '')}">
      <label>本机唯一标识 (机器码)</label><input value="${esc(cfg.deviceId || '尚未生成')}" readonly>
      <label>最近备份时间</label><input value="${esc(cfg.lastBackupAt ? new Date(cfg.lastBackupAt).toLocaleString('zh-Hans-CN') : '从未备份')}" readonly>
      <div></div>
      <div class="row">
        <button type="submit">保存</button>
        <button type="button" data-sync-backup="1">立即备份到云端（上传歌单）</button>
        <button type="button" data-sync-restore="1">从云端恢复歌单（拉取同步）</button>
        <button type="button" class="ghost" data-sync-devices="1">查看云端设备列表 / 跨设备导入</button>
      </div>
    </form>
    <p class="sub">备份会将当前设备的所有自建歌单及曲目上传至云端；恢复会从云端拉取已保存的歌单并合并到本地。<br>
    本机用自己的机器码备份，<b>不会</b>覆盖 iPhone 那台设备的数据。</p>
    ${devices.length
      ? `<h2 style="font-size:16px">云端设备</h2><table class="songs"><thead><tr><th>设备</th><th>平台</th><th>歌单</th><th>歌曲</th><th>更新于</th><th></th></tr></thead><tbody>${devices
          .map(
            (d) => `<tr><td>${esc(d.device_name || d.device_id)}</td><td>${esc(d.platform || '')}</td><td class="muted">${d.playlist_count}</td><td class="muted">${d.song_count}</td><td class="muted">${esc(fmtDate(d.updated_at))}</td>
              <td>${d.device_id === cfg.deviceId ? '<span class="badge">本机</span>' : `<button class="ghost small" data-sync-import="${esc(d.device_id)}">下载它的歌单</button>`}</td></tr>`
          )
          .join('')}</tbody></table>`
      : ''}`;
}

function viewHistory() {
  return `<h2>最近播放</h2><p class="sub">${state.history.length} 首。<button class="ghost small" data-clear-history="1">清空</button></p>${songTable(state.history, 'history', '还没有播放记录。')}`;
}

function viewOnline() {
  const rows = state.sources
    .map(
      (s) => `<div class="line-item">
        <div><div class="name">${esc(s.name)}</div><div class="muted" style="font-size:11px">${esc(s.baseURL)}</div></div>
        <div><span class="badge ${esc(s.platform)}">${PLATFORM_LABEL[s.platform] || s.platform}</span></div>
        <div class="muted">${esc(s.protocolType)}</div>
        <div class="muted">p${s.priority}</div>
        <div class="row">
          <button class="ghost small" data-toggle-source="${esc(s.id)}">${s.isEnabled ? '停用' : '启用'}</button>
        </div>
      </div>`
    )
    .join('');

  const latency = state.sources.filter((s) => s.latencyMs > 0).length;
  return `<h2>在线聚合线路</h2>
    <p class="sub">与 iPhone 版 <code>AggregatedSourceStore.defaultSources</code> 同一份清单（9 条）。线路挂了可以自己加，不用等发版。</p>
    <div class="row" style="margin-bottom:14px">
      <button data-ping-all="1">检测全部延迟${latency ? `（已测 ${latency} 条）` : ''}</button>
      <button class="ghost" data-add-source="1">添加线路</button>
      <button class="ghost" data-reset-sources="1">恢复默认 9 条</button>
    </div>
    ${state.form === 'addSource' ? addSourceForm() : ''}
    ${rows}`;
}

function addSourceForm() {
  return `<form class="grid" id="source-form">
    <label>名称</label><input name="name" placeholder="例：网易云 (我的备用线路)" required>
    <label>地址</label><input name="baseURL" placeholder="https://xxx/api.php 或 http://ip/path" required>
    <label>平台</label><select name="platform">${['netease', 'qq', 'kugou', 'kuwo', 'bilibili']
      .map((p) => `<option value="${p}">${PLATFORM_LABEL[p]}</option>`)
      .join('')}</select>
    <label>协议</label><select name="protocolType">${['meting', 'hyw', 'nxinxz', 'openApi']
      .map((p) => `<option value="${p}">${p}</option>`)
      .join('')}</select>
    <label>优先级</label><input name="priority" type="number" value="5" min="0" max="99">
    <div></div><div class="row"><button type="submit">保存</button><button type="button" class="ghost" data-cancel-form="1">取消</button></div>
  </form>`;
}

function viewServerNew() {
  const editing = state.formServerId ? state.servers.find((s) => s.id === state.formServerId) : null;
  const v = (key, fallback = '') => (editing ? editing[key] ?? fallback : fallback);
  return `<h2>${editing ? '编辑服务器源' : '添加服务器源'}</h2>
    <p class="sub">地址、账号、密码只保存在本机（密码走 Windows DPAPI / safeStorage 加密），不会发到任何聊天或第三方。iPhone 版同一个道理。</p>
    ${state.formError ? `<p class="err">${esc(state.formError)}</p>` : ''}
    ${state.formResult ? `<p class="ok">${esc(state.formResult)}</p>` : ''}
    <form class="grid" id="server-form">
      <label>类型</label><select name="kind"><option value="daoliyu"${v('kind', 'daoliyu') === 'daoliyu' ? ' selected' : ''}>道理鱼 DaoLiYu</option></select>
      <label>名称</label><input name="name" value="${esc(v('name', '我的道理鱼'))}">
      <label>地址 host</label><input name="host" value="${esc(v('host'))}" placeholder="例 music.example.com 或 192.168.1.20" required>
      <label>端口</label><input name="port" value="${esc(v('port') || '')}" placeholder="留空按 http/https 默认">
      <label>使用 https</label><select name="useSSL"><option value="0"${v('useSSL') ? '' : ' selected'}>否</option><option value="1"${v('useSSL') ? ' selected' : ''}>是</option></select>
      <label>子路径 basePath</label><input name="basePath" value="${esc(v('basePath'))}" placeholder="例 /music（留空表示根路径）">
      <label>用户名</label><input name="username" value="${esc(v('username'))}" required>
      <label>密码</label><input name="password" type="password" placeholder="${editing && v('hasPassword') ? '已保存，留空表示不修改' : ''}">
      <label>自签名证书</label><select name="insecureTLS"><option value="0"${v('insecureTLS') ? '' : ' selected'}>校验（默认）</option><option value="1"${v('insecureTLS') ? ' selected' : ''}>忽略（自签名 https 才需要）</option></select>
      <div></div>
      <div class="row">
        <button type="button" data-test-server="1">测试连接</button>
        <button type="submit">保存</button>
        ${editing ? `<button type="button" class="ghost" data-remove-server="${esc(editing.id)}">删除</button>` : ''}
      </div>
      <input type="hidden" name="id" value="${esc(v('id') || '')}">
    </form>`;
}

function viewServerBrowse() {
  const view = state.serverView;
  const server = state.servers.find((s) => s.id === view.sourceID);
  if (!server) return `<h2>服务器源</h2><p class="err">找不到该源，请重新添加。</p>`;

  const filtered = view.filter
    ? view.items.filter((t) =>
        `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(view.filter.toLowerCase())
      )
    : view.items;

  return `<h2>${esc(server.name || server.host)}</h2>
    <p class="sub">${view.total ? `服务器共 ${view.total} 首` : '正在读取曲目列表'} · 已载入 ${view.items.length} 首 · 本 App 按 iPhone 的方式做整库分页（服务端 skip/take），搜索在已载入范围内过滤。</p>
    <div class="row" style="margin-bottom:12px">
      <input id="server-filter" placeholder="在已载入的曲目里过滤" value="${esc(view.filter)}" style="padding:7px 9px;border-radius:7px;border:1px solid var(--line);background:var(--bg-3);color:var(--text);min-width:260px">
      <button data-load-more="1" ${view.loading ? 'disabled' : ''}>${view.loading ? '载入中…' : '继续载入下一页'}</button>
      <button class="ghost" data-play-all="1">播放已载入全部</button>
      <button class="ghost" data-nav="addServer:${esc(server.id)}">编辑源</button>
    </div>
    ${view.error ? `<p class="err">${esc(view.error)}</p>` : ''}
    ${songTable(filtered, 'serverView', view.loading ? '正在载入…' : '还没有内容，点“继续载入下一页”。')}`;
}

function viewSettings() {
  const cfg = state.sync || {};
  return `<h2>设置</h2>
    <p class="sub">Primuse 桌面版 ${esc(state.meta?.version || '')} · Windows ${esc(state.meta?.platform || '')} · 本地代理 ${esc(state.meta?.proxyBaseUrl || '')}</p>
    <form class="grid" id="settings-form">
      <label>关闭窗口时最小化到托盘</label><select name="minimizeToTray"><option value="1"${state.settings.minimizeToTray === false ? '' : ' selected'}>是</option><option value="0"${state.settings.minimizeToTray === false ? ' selected' : ''}>否</option></select>
      <label>歌词面板自动跟随</label><select name="lyricsFollow"><option value="1"${state.settings.lyricsFollow === false ? '' : ' selected'}>是</option><option value="0"${state.settings.lyricsFollow === false ? ' selected' : ''}>否</option></select>
      <div></div><div class="row"><button type="submit">保存设置</button></div>
    </form>
    <h2 style="font-size:16px">歌单同步</h2>
    <p class="sub">${cfg.serverURL ? `服务器已配置：${esc(cfg.serverURL)}` : '未配置服务器'} · 机器码 ${esc(cfg.deviceId || '尚未生成')}<br>
    最近备份：${esc(cfg.lastBackupAt ? new Date(cfg.lastBackupAt).toLocaleString('zh-Hans-CN') : '从未备份')}</p>
    <div class="row" style="margin-bottom:16px">
      <button data-nav="sync">设置同步服务器</button>
      <button class="ghost" data-sync-backup="1">立即备份到云端（上传歌单）</button>
      <button class="ghost" data-sync-restore="1">从云端恢复歌单（拉取同步）</button>
    </div>
    <h2 style="font-size:16px">这个包是未签名的</h2>
    <p class="sub">首次运行 Windows 会弹 SmartScreen「未知发布者」——点「更多信息 → 仍要运行」。Mac 端对应的是 Gatekeeper 右键打开。</p>
    <h2 style="font-size:16px">与 iPhone 版一致的地方 / 还差的地方</h2>
    <p class="sub">一致：9 条聚合线路与优先级、四类协议（meting / hyw / nxinxz / openApi）的请求字段、道理鱼的登录与取流方式、无账号体系；
    歌单（新建 / 删除 / 重命名 / 加入 / 移除 / 重新排序）、「我喜欢」系统歌单固定 id、云端歌单备份与恢复的接口契约、播放模式（随机 / 顺序 / 列表循环 / 单曲循环）。<br>
    还差：本地文件与 SMB/NAS 扫描、CUE、scrobble、小组件、CloudKit 同步、AI 智能歌单与规则智能歌单（这些在 Windows 上要么换实现要么不适用）。</p>`;
}

/* ── 渲染 ─────────────────────────────── */

const LIST_ACCESS = {
  results: () => filteredResults(),
  favorites: () => state.favorites,
  history: () => state.history,
  serverView: () => state.serverView.items,
  queue: () => state.queue,
  currentPlaylist: () => (state.playlistView ? state.playlistView.songs : []),
};

function render() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    const route = btn.dataset.route;
    const active =
      route === state.route ||
      (route === 'playlists' && state.route === 'playlist') ||
      (route === 'settings' && state.route === 'sync');
    btn.classList.toggle('active', Boolean(active));
  });

  const views = {
    home: viewHome,
    search: viewSearch,
    favorites: viewFavorites,
    history: viewHistory,
    playlists: viewPlaylists,
    playlist: viewPlaylist,
    sync: viewSync,
    online: viewOnline,
    addServer: viewServerNew,
    server: viewServerBrowse,
    settings: viewSettings,
  };
  const view = views[state.route] || viewHome;

  const detail = $('detail');
  const focused = document.activeElement && document.activeElement.id;
  const keepFocus = focused && ['server-filter', 'sheet-name', 'playlist-filter'].includes(focused) ? focused : null;
  const caret = keepFocus ? document.activeElement.selectionStart : 0;
  const sameRoute = state.lastRoute === state.route;
  const prevScroll = detail.scrollTop;

  detail.innerHTML = view();
  detail.scrollTop = sameRoute ? prevScroll : 0;
  state.lastRoute = state.route;

  if (keepFocus) {
    const node = $(keepFocus);
    if (node) {
      node.focus();
      node.setSelectionRange(caret, caret);
    }
  }

  renderServerNav();
  renderPlaylistNav();
  renderSheet();
  if (state.drawer) renderDrawer();
  renderPlayerBar();
}

function renderServerNav() {
  $('server-nav').innerHTML = state.servers
    .map((s) => `<button class="nav-item ${state.route === 'server' && state.serverView.sourceID === s.id ? 'active' : ''}" data-nav="server:${esc(s.id)}">${esc(s.name || s.host)}</button>`)
    .join('')
    + '<button class="nav-item" data-nav="addServer">＋ 添加服务器源</button>';
}

/** MacSidebar.swift:158-233 —— 侧栏的「歌单」分区：过滤我喜欢，空态「暂无歌单」 */
function renderPlaylistNav() {
  const node = $('playlist-nav');
  if (!node) return;
  const list = visiblePlaylists().slice(0, 12);
  node.innerHTML =
    (list.length
      ? list
          .map(
            (p) => `<button class="nav-item ${state.route === 'playlist' && state.playlistView && state.playlistView.id === p.id ? 'active' : ''}" data-nav="playlist:${esc(p.id)}" title="${esc(p.name)}">${esc(p.name)}</button>`
          )
          .join('')
      : '<div class="muted" style="padding:4px 9px;font-size:12px">暂无歌单</div>')
    + '<button class="nav-item" data-new-playlist="1">＋ 新建歌单</button>';

  const liked = $('nav-liked-count');
  if (liked) liked.textContent = state.favorites.length ? ` ${state.favorites.length}` : '';
}

/* ── 弹层（sheet）─────────────────────── */

function closeSheet() {
  state.sheet = null;
  renderSheet();
}

function openSheet(sheet) {
  state.sheet = sheet;
  renderSheet();
}

function renderSheet() {
  const wrap = $('sheet');
  if (!state.sheet) {
    wrap.hidden = true;
    $('sheet-title').textContent = '';
    $('sheet-body').innerHTML = '';
    return;
  }
  wrap.hidden = false;
  const s = state.sheet;

  if (s.kind === 'add') {
    const track = s.track;
    $('sheet-title').textContent = '添加到歌单';
    // AddToPlaylistSheet（NowPlayingView.swift:4523-4756）：先"新建歌单"，
    // 下面每个歌单一行，勾上=已包含，再点一次是取消包含；「我喜欢」不在这里（走心形）。
    $('sheet-body').innerHTML = `<button class="sheet-item" data-sheet-create="1" style="border-bottom:1px solid var(--line)">
        <span class="nm" style="color:var(--accent-2)">＋ 新建歌单</span>
      </button>
      ${visiblePlaylists().length === 0
        ? '<p class="muted" style="padding:10px 2px">还没有歌单，先新建一个。</p>'
        : visiblePlaylists()
            .map(
              (p) => `<button class="sheet-item" data-sheet-toggle="${esc(p.id)}">
                ${playlistCover(p)}
                <span class="nm">${esc(p.name)}<br><span class="muted" style="font-size:11.5px">${p.songs.length} 首歌曲</span></span>
                <span class="check">${inPlaylist(p.id, track) ? '✓' : ''}</span>
              </button>`
            )
            .join('')}`;
    return;
  }

  if (s.kind === 'create' || s.kind === 'rename') {
    const isRename = s.kind === 'rename';
    $('sheet-title').textContent = isRename ? '重命名歌单' : '新建歌单';
    $('sheet-body').innerHTML = `<form id="sheet-form">
        <input id="sheet-name" placeholder="歌单名" value="${esc(isRename ? s.name : '')}" autocomplete="off" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg-3);color:var(--text)">
        ${s.error ? `<p class="err" style="margin:8px 0 0">${esc(s.error)}</p>` : ''}
        <div class="row" style="justify-content:flex-end;margin-top:12px">
          <button type="button" class="ghost" data-sheet-cancel="1">取消</button>
          <button type="submit">${isRename ? '保存' : '创建'}</button>
        </div>
      </form>`;
    const input = $('sheet-name');
    if (input) input.focus();
    return;
  }

  if (s.kind === 'reorder') {
    const songs = s.songs || [];
    $('sheet-title').textContent = '调整播放顺序';
    $('sheet-body').innerHTML = `<p class="muted" style="margin:0 0 10px">使用箭头移动歌曲${s.changed ? ' · 顺序已更改' : ''}</p>
      ${songs
        .map(
          (t, i) => `<div class="queue-item">
            <span class="muted">${i + 1}</span>
            <span class="t">${esc(t.title)}<br><span class="muted" style="font-size:11px">${esc(t.artist || '')}</span></span>
            <button class="icon-btn" data-move="${i}:-1" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="icon-btn" data-move="${i}:1" ${i === songs.length - 1 ? 'disabled' : ''}>▼</button>
          </div>`
        )
        .join('')}
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="ghost" data-sheet-cancel="1">取消</button>
        <button data-sheet-done="1">完成</button>
      </div>`;
    return;
  }

  toast('未知弹层', true);
}

/* ── 播放 ─────────────────────────────── */

let loadToken = 0;

/**
 * 队列顺序：AudioPlayerService.swift:10726-10737 —— 无种子 shuffle，再把当前曲换到第一位。
 * `state.order` 是 `state.queue` 的下标排列，`state.index` 始终是真实队列下标（列表高亮靠它）。
 */
function buildOrder(length, currentIndex, shuffle) {
  const arr = Array.from({ length }, (_, i) => i);
  if (!shuffle || length <= 1) return arr;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const at = arr.indexOf(currentIndex);
  if (at > 0) {
    const [hit] = arr.splice(at, 1);
    arr.unshift(hit);
  }
  return arr;
}

function orderPos() {
  const p = state.order.indexOf(state.index);
  return p < 0 ? 0 : p;
}

/** 按 随机/顺序 + 循环模式 求下一个队列下标；返回 null 表示到底了就停 */
function indexAfter(delta) {
  const len = state.order.length;
  if (!len) return null;
  let pos = orderPos() + delta;
  if (pos >= len) {
    if (state.repeat === 'all') pos = 0;
    else return null;
  }
  if (pos < 0) pos = state.repeat === 'all' ? len - 1 : 0;
  return state.order[pos];
}

async function playFrom(listRef, index, options = {}) {
  const list = LIST_ACCESS[listRef] ? LIST_ACCESS[listRef]() : [];
  if (!list.length) return;
  state.queue = list.slice();
  if (options.shuffle !== undefined) state.shuffle = Boolean(options.shuffle);
  const start = options.shuffle ? Math.floor(Math.random() * list.length) : index; // PlaylistDetailView:1106-1121
  await playAt(start, { pushHistory: true });
  if (state.drawer === 'queue') renderDrawer();
  persistSoon();
}

async function playAt(index, { pushHistory = true, force = false } = {}) {
  if (index < 0 || index >= state.queue.length) return;
  const track = state.queue[index];
  state.index = index;
  state.order = buildOrder(state.queue.length, index, state.shuffle);
  const token = ++loadToken;

  setPlayerMeta(track, null);
  toast(`解析：${track.title}`);

  const resolved = await api.playback.resolve(track, force);
  if (token !== loadToken) return;

  if (!resolved.ok || !resolved.url) {
    toast(`播放失败：${resolved.error || '未知原因'}`, true);
    setPlayerMeta(track, null);
    render();
    return;
  }

  audio.src = resolved.url;
  audio.volume = state.volume;
  try {
    await audio.play();
  } catch (error) {
    if (!force && state.queue[index] === track) {
      // 聚合直链有时效 / 会被 CDN 拒：强制重新解析一次再试
      toast('第一次取流失败，正在换线路重试…');
      await playAt(index, { pushHistory, force: true });
      return;
    }
    toast(`无法播放：${error.message}`, true);
  }

  if (pushHistory && track) api.library.pushHistory(track, 0);
  loadLyrics(track);
  render();
}

function setPlayerMeta(track, url) {
  $('pb-title').textContent = track ? track.title : '未播放';
  $('pb-artist').textContent = track ? `${track.artist || ''}${track.album ? ` — ${track.album}` : ''}` : '在左侧选一首歌开始';
  const cover = track ? coverOf(track) : null;
  $('pb-cover').src = cover || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  $('pb-like').classList.toggle('on', Boolean(track && isFavorite(track)));
  void url;

  if (track && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || '',
        album: track.album || '',
        artwork: cover ? [{ src: cover, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    } catch {
      /* MediaSession 不可用时忽略（任务栏按钮自然消失） */
    }
  }
}

async function step(delta) {
  if (!state.queue.length) return;
  const next = indexAfter(delta);
  if (next === null || next === undefined) return;
  await playAt(next);
}

function togglePlay() {
  if (!audio.src) {
    if (state.queue.length) playAt(0);
    return;
  }
  if (audio.paused) audio.play();
  else audio.pause();
}

function renderPlayerBar() {
  const track = state.queue[state.index];
  $('pb-play').textContent = state.playing ? '❚❚' : '▶';
  // MacBottomBar.swift:202-215：off 与 all 都用 repeat 图标、点亮态是 != off，one 用 repeat.1
  $('pb-repeat').textContent = state.repeat === 'one' ? '循环: 单曲' : state.repeat === 'all' ? '循环: 列表' : '循环: 关';
  $('pb-repeat').classList.toggle('on', state.repeat !== 'off');
  $('pb-shuffle').classList.toggle('on', Boolean(state.shuffle));
  $('pb-like').classList.toggle('on', Boolean(track && isFavorite(track)));
  if (track) $('pb-title').textContent = track.title;
}

/* ── 歌词 ─────────────────────────────── */

function parseLrc(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const marks = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d{1,3}))?\]/g)];
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!marks.length || !content) continue;
    for (const m of marks) {
      const ms = Number(String(m[3] ?? '0').padEnd(3, '0').slice(0, 3));
      rows.push({ at: Number(m[1]) * 60 + Number(m[2]) + ms / 1000, text: content });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

async function loadLyrics(track) {
  state.lyrics = null;
  state.lyricRows = [];
  state.lyricIndex = -1;
  if (state.drawer === 'lyrics') renderDrawer();
  const res = await api.playback.lyrics(track);
  if (state.queue[state.index] !== track) return;
  state.lyrics = res.ok ? res.lrc : null;
  state.lyricRows = state.lyrics ? parseLrc(state.lyrics) : [];
  if (state.drawer === 'lyrics') renderDrawer();
}

function renderDrawer() {
  const drawer = $('drawer');
  drawer.hidden = !state.drawer;
  if (!state.drawer) return;

  if (state.drawer === 'queue') {
    $('drawer-title').textContent = `队列（${state.queue.length}）`;
    $('drawer-body').innerHTML = state.queue.length
      ? state.queue
          .map(
            (t, i) => `<div class="queue-item ${i === state.index ? 'active' : ''}" data-queue-play="${i}">
              <span class="muted">${i + 1}</span>
              <span class="t">${esc(t.title)}<br><span class="muted" style="font-size:11px">${esc(t.artist || '')}</span></span>
              <button class="icon-btn ${isFavorite(t) ? 'on' : ''}" data-fav="queue:${i}">${isFavorite(t) ? '♥' : '♡'}</button>
            </div>`
          )
          .join('')
      : '<p class="muted">队列为空。</p>';
    return;
  }

  $('drawer-title').textContent = '歌词';
  if (!state.lyricRows.length) {
    $('drawer-body').innerHTML = `<p class="muted">${state.lyrics ? '这首歌的歌词没有可解析的时间轴。' : '当前没有歌词（服务器源优先取逐字歌词 lyricsSync）。'}</p>`;
    return;
  }
  $('drawer-body').innerHTML = `<div class="lyric-box">${state.lyricRows
    .map((row, i) => `<div class="lyric-line ${i === state.lyricIndex ? 'now' : ''}" id="ly-${i}" data-ly="${row.at}">${esc(row.text)}</div>`)
    .join('')}</div>`;
}

function updateLyricIndex() {
  if (!state.lyricRows.length) return;
  const now = audio.currentTime;
  let idx = -1;
  for (let i = 0; i < state.lyricRows.length; i += 1) {
    if (state.lyricRows[i].at <= now + 0.3) idx = i;
    else break;
  }
  if (idx === state.lyricIndex) return;
  const old = document.getElementById(`ly-${state.lyricIndex}`);
  if (old) old.classList.remove('now');
  state.lyricIndex = idx;
  const node = document.getElementById(`ly-${idx}`);
  if (node) {
    node.classList.add('now');
    if (state.settings.lyricsFollow !== false && state.drawer === 'lyrics') {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/* ── 事件 ─────────────────────────────── */

const CLICK_SELECTOR = [
  '[data-nav]', '[data-play]', '[data-fav]', '[data-queue]', '[data-filter]', '[data-toggle-source]', '[data-ping-all]',
  '[data-add-source]', '[data-reset-sources]', '[data-clear-history]', '[data-platform-search]', '[data-queue-play]',
  '[data-load-more]', '[data-play-all]', '[data-test-server]', '[data-remove-server]', '[data-cancel-form]', '[data-ly]',
  '[data-play-playlist]', '[data-shuffle-playlist]', '[data-new-playlist]', '[data-rename-playlist]', '[data-remove-playlist]',
  '[data-pl-menu]', '[data-pl-export]', '[data-reorder]', '[data-queue-playlist]', '[data-next-playlist]',
  '[data-add-to-playlist]', '[data-remove-from-playlist]', '[data-next]', '[data-move]',
  '[data-sheet-create]', '[data-sheet-toggle]', '[data-sheet-cancel]', '[data-sheet-done]',
  '[data-sync-backup]', '[data-sync-restore]', '[data-sync-devices]', '[data-sync-import]', '[data-import-file]',
].join(', ');

document.addEventListener('click', async (event) => {
  // 点菜单外任意处先收起 ⋯ 弹层（CSS :hover 之外的显隐只能自己管）
  if (state.menu && !event.target.closest('.menu')) state.menu = null;

  const target = event.target.closest(CLICK_SELECTOR);
  if (!target) {
    // 遮罩与 × 关闭弹层；弹层内部与 ⋯ 菜单内部的空白点击不动 UI（否则重绘会清掉正在输入的歌单名）
    if (event.target.id === 'sheet' || event.target.closest('#sheet-close')) closeSheet();
    else if (!event.target.closest('.sheet-card') && !event.target.closest('.menu')) render();
    return;
  }
  const d = target.dataset;

  const go = (route) => {
    state.route = route;
    render();
  };

  if (d.nav) {
    const [route, arg] = d.nav.split(':');
    if (route === 'server') {
      state.route = 'server';
      state.serverView = { sourceID: arg, items: [], total: 0, skip: 0, filter: '', loading: false, error: null };
      render();
      loadServerPage(0);
    } else if (route === 'addServer') {
      state.route = 'addServer';
      state.formServerId = arg || null;
      state.formError = null;
      state.formResult = null;
      render();
    } else if (route === 'playlist') {
      await openPlaylist(arg);
    } else if (route === 'sync') {
      await loadSyncConfig();
      go('sync');
    } else {
      go(route);
    }
    return;
  }

  // ── 歌单 ─────────────────────────────
  if (d.playPlaylist) {
    await playPlaylist(d.playPlaylist, false);
    return;
  }
  if (d.shufflePlaylist) {
    await playPlaylist(d.shufflePlaylist, true);
    return;
  }
  if (d.newPlaylist) {
    openSheet({ kind: 'create' });
    return;
  }
  if (d.renamePlaylist !== undefined) {
    const p = state.playlistView;
    if (p) openSheet({ kind: 'rename', id: p.id, name: p.name });
    return;
  }
  if (d.removePlaylist !== undefined) {
    const p = state.playlistView;
    if (!p || p.isSystem) return;
    state.menu = null;
    const res = await api.playlists.remove(p.id);
    if (!playlistError(res)) {
      toast(`已删除歌单「${p.name}」`);
      await reloadPlaylists();
      state.playlistView = null;
      state.route = 'playlists';
      render();
    }
    return;
  }
  if (d.plMenu) {
    state.menu = state.menu === `playlist:${d.plMenu}` ? null : `playlist:${d.plMenu}`;
    render();
    return;
  }
  if (d.plExport !== undefined) {
    state.menu = null;
    const p = state.playlistView;
    if (p) await exportPlaylist(p);
    return;
  }
  if (d.reorder !== undefined) {
    state.menu = null;
    const p = state.playlistView;
    if (p) openSheet({ kind: 'reorder', id: p.id, songs: p.songs.slice(), changed: false });
    else render();
    return;
  }
  if (d.queuePlaylist !== undefined) {
    state.menu = null;
    const p = state.playlistView;
    if (p && p.songs.length) {
      state.queue = state.queue.concat(p.songs);
      state.order = buildOrder(state.queue.length, state.index, state.shuffle);
      toast(`已把「${p.name}」的 ${p.songs.length} 首加入播放队列`);
      renderDrawer();
      persistSoon();
    } else render();
    return;
  }
  if (d.nextPlaylist !== undefined) {
    state.menu = null;
    const p = state.playlistView;
    if (p && p.songs.length) {
      const at = state.index + 1;
      state.queue = state.queue.slice(0, at).concat(p.songs, state.queue.slice(at));
      state.order = buildOrder(state.queue.length, state.index, state.shuffle);
      toast(`已把「${p.name}」排在当前曲目之后`);
      renderDrawer();
      persistSoon();
    } else render();
    return;
  }
  if (d.addToPlaylist) {
    const [list, idx] = d.addToPlaylist.split(':');
    const track = (LIST_ACCESS[list] || (() => []))()[Number(idx)];
    if (track) openSheet({ kind: 'add', track });
    return;
  }
  if (d.removeFromPlaylist !== undefined) {
    const [, idx] = d.removeFromPlaylist.split(':');
    const p = state.playlistView;
    const track = p ? p.songs[Number(idx)] : null;
    if (p && track) {
      const res = await api.playlists.removeSong(p.id, track);
      if (!playlistError(res)) {
        await reloadPlaylists();
        toast(`已从「${p.name}」移除：${track.title}`);
        render();
      }
    }
    return;
  }
  if (d.next !== undefined) {
    const [list, idx] = d.next.split(':');
    const track = (LIST_ACCESS[list] || (() => []))()[Number(idx)];
    if (track) {
      const at = state.index + 1;
      state.queue = state.queue.slice(0, at).concat([track], state.queue.slice(at));
      state.order = buildOrder(state.queue.length, state.index, state.shuffle);
      toast('已排在当前曲目之后');
      renderDrawer();
      persistSoon();
    }
    return;
  }

  // ── 弹层内动作 ───────────────────────
  if (d.sheetCreate) {
    openSheet({ kind: 'create', backTo: 'add' });
    return;
  }
  if (d.sheetToggle) {
    const s = state.sheet;
    if (s && s.kind === 'add') {
      const res = await api.playlists.toggleSong(d.sheetToggle, s.track);
      if (!playlistError(res)) {
        await reloadPlaylists();
        render();
      }
    }
    return;
  }
  if (d.sheetCancel) {
    closeSheet();
    return;
  }
  if (d.sheetDone) {
    const s = state.sheet;
    if (s && s.kind === 'reorder' && s.id) {
      state.playlistView = null;
      await reloadPlaylists();
      toast('顺序已更新');
    }
    closeSheet();
    return;
  }
  if (d.move !== undefined) {
    const [from, delta] = d.move.split(':').map(Number);
    const s = state.sheet;
    if (!s || s.kind !== 'reorder') return;
    const to = from + delta;
    if (to < 0 || to >= s.songs.length) return;
    const res = await api.playlists.move(s.id, from, to);
    if (!playlistError(res)) {
      s.songs = (res.value && res.value.songs) || s.songs;
      s.changed = true;
      renderSheet();
    }
    return;
  }

  // ── 云端同步 ─────────────────────────
  if (d.syncBackup) {
    await runSync('backup');
    return;
  }
  if (d.syncRestore) {
    await runSync('restore');
    return;
  }
  if (d.syncDevices) {
    await loadSyncDevices();
    return;
  }
  if (d.syncImport) {
    await importFromDevice(d.syncImport);
    return;
  }
  if (d.importFile) {
    const res = await api.sync.importFile();
    if (res.ok && res.data) {
      toast(`已导入 ${res.data.created} 个歌单、${res.data.songs} 首`);
      await reloadPlaylists();
    } else if (!res.canceled) toast(res.error || '导入失败', true);
    render();
    return;
  }

  if (d.play) {
    const [list, idx] = d.play.split(':');
    playFrom(list, Number(idx));
    return;
  }
  if (d.queuePlay !== undefined) {
    playAt(Number(d.queuePlay));
    return;
  }
  if (d.fav) {
    const [list, idx] = d.fav.split(':');
    const track = (LIST_ACCESS[list] || (() => []))()[Number(idx)];
    if (track) await toggleFavorite(track);
    return;
  }
  if (d.queue) {
    const [list, idx] = d.queue.split(':');
    const track = (LIST_ACCESS[list] || (() => []))()[Number(idx)];
    if (!track) return;
    state.queue = state.queue.concat([track]);
    state.order = buildOrder(state.queue.length, state.index, state.shuffle);
    toast('已加入队列');
    renderDrawer();
    persistSoon();
    return;
  }
  if (d.filter) {
    state.filter = d.filter;
    render();
    return;
  }
  if (d.platformSearch) {
    state.filter = d.platformSearch;
    go('search');
    $('search-input').focus();
    return;
  }
  if (d.toggleSource) {
    state.sources = await0(api.sources.toggle(d.toggleSource));
    return;
  }
  if (d.pingAll) {
    toast('正在逐条探测线路延迟…');
    api.sources.pingAll().then((list) => {
      state.sources = list;
      render();
    });
    return;
  }
  if (d.addSource) {
    state.form = state.form === 'addSource' ? null : 'addSource';
    render();
    return;
  }
  if (d.cancelForm) {
    state.form = null;
    render();
    return;
  }
  if (d.resetSources) {
    api.sources.reset().then((list) => {
      state.sources = list;
      toast('已恢复默认 9 条线路');
      render();
    });
    return;
  }
  if (d.clearHistory) {
    api.library.clearHistory().then(() => {
      state.history = [];
      render();
    });
    return;
  }
  if (d.loadMore) {
    loadServerPage(state.serverView.items.length);
    return;
  }
  if (d.playAll) {
    state.queue = state.serverView.items.slice();
    playAt(0);
    return;
  }
  if (d.testServer) {
    testServerForm();
    return;
  }
  if (d.removeServer) {
    api.server.remove(d.removeServer).then((list) => {
      state.servers = list;
      state.route = 'home';
      state.formServerId = null;
      toast('已删除');
      render();
    });
    return;
  }
  if (d.ly !== undefined) {
    audio.currentTime = Number(d.ly);
    return;
  }

  render();
});

function await0(promise) {
  promise
    .then(() => {
      api.sources.list().then((list) => {
        state.sources = list;
        render();
      });
    })
    .catch((error) => toast(String(error.message || error), true));
}

async function toggleFavorite(track) {
  const res = await api.library.toggleFavorite(track);
  state.favorites = res.favorites;
  await reloadPlaylists();
  render();
}

// MARK: - 歌单动作

async function openPlaylist(id) {
  const res = await api.playlists.get(id);
  if (playlistError(res)) return;
  state.playlistView = res.value;
  state.route = 'playlist';
  render();
}

async function playPlaylist(id, shuffled) {
  await ensurePlaylist(id);
  const songs = playlistSongs(id);
  if (!songs.length) {
    toast('这首歌单还没有歌曲', true);
    return;
  }
  // PlaylistDetailView.swift:1106-1121：随机播放 = 打开 shuffle 模式 + 随机起点
  state.queue = songs.slice();
  state.shuffle = Boolean(shuffled);
  const start = shuffled ? Math.floor(Math.random() * songs.length) : 0;
  await playAt(start, { pushHistory: true });
  persistSoon();
}

async function ensurePlaylist(id) {
  if (!playlistById(id)) await reloadPlaylists();
}

async function exportPlaylist(p) {
  const wire = {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt || 0,
    updatedAt: p.updatedAt || 0,
    songs: (p.songs || []).map(toWireSong),
  };
  const res = await api.sync.exportPlaylist(wire);
  if (res.ok) toast(`已导出：${res.filePath}`);
  else if (!res.canceled) toast(res.error || '导出失败', true);
  render();
}

/** 与 src/main/sync.js 的 toWireSong 同构（渲染层拿不到主进程模块，这里保持一致的字段） */
function toWireSong(track) {
  const shared = {
    title: track.title || '',
    artist: track.artist || null,
    album: track.album || null,
    duration: Number(track.duration) > 0 ? Number(track.duration) : null,
  };
  return track.kind === 'server'
    ? { ...shared, id: track.id || `dly_${track.sourceID}_${track.rawID}`, filePath: `/server/${track.sourceID}/${track.rawID}`, sourceId: track.sourceID }
    : { ...shared, id: `agg_${track.platform}_${track.rawID}`, filePath: `/aggregated/${track.platform}/${track.rawID}.mp3`, sourceId: 'system-aggregated-music' };
}

// MARK: - 云端同步

async function loadSyncConfig() {
  state.sync = await api.sync.config();
}

async function loadSyncDevices() {
  if (state.syncBusy) return;
  state.syncBusy = true;
  state.syncError = null;
  render();
  const res = await api.sync.devices();
  state.syncBusy = false;
  if (!res.ok) {
    state.syncError = res.error || '读取云端设备列表失败';
    state.syncDevices = [];
  } else {
    state.syncDevices = res.devices || [];
    if (!state.syncDevices.length) state.syncError = '云端还没有任何设备的备份';
  }
  if (state.route !== 'sync') state.route = 'sync';
  render();
}

async function importFromDevice(deviceId) {
  if (state.syncBusy) return;
  state.syncBusy = true;
  state.syncError = null;
  state.syncResult = null;
  render();
  const res = await api.sync.importFromDevice(deviceId);
  state.syncBusy = false;
  if (!res.ok) {
    state.syncError = res.error || '导入失败';
  } else {
    await reloadPlaylists();
    state.syncResult = `已从「${res.data.deviceName}」下载 ${res.data.created} 个新歌单、合并 ${res.data.matched} 个同名歌单，共写入 ${res.data.songs} 首`;
  }
  render();
}

async function runSync(kind) {
  if (state.syncBusy) return;
  state.syncBusy = true;
  state.syncError = null;
  state.syncResult = null;
  render();
  const res = kind === 'backup' ? await api.sync.backup() : await api.sync.restore();
  state.syncBusy = false;
  if (!res.ok) {
    state.syncError = res.error || (kind === 'backup' ? '备份失败' : '恢复失败');
  } else if (kind === 'backup') {
    await loadSyncConfig();
    state.syncResult = `备份成功：已成功将本地 ${res.data.playlists} 个歌单（共 ${res.data.songs} 首歌曲）备份至云端服务器！`;
  } else if (res.data.empty) {
    state.syncResult = '云端还没有本机的备份（本机机器码从未上传过）。可以从云端设备列表下载其它设备的歌单。';
  } else {
    await reloadPlaylists();
    state.syncResult = `恢复成功：已从云端拉取并同步 ${res.data.created} 个新建歌单、${res.data.matched} 个已存在歌单，共写入 ${res.data.songs} 首`;
  }
  if (state.route !== 'sync' && state.route !== 'playlists') state.route = 'sync';
  render();
}

let searchTimer = null;
let searchSeq = 0;

$('search-input').addEventListener('input', (event) => {
  const value = event.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(value), 220); // 与 Swift 侧 200ms 防抖同量级
});

async function runSearch(keyword) {
  state.keyword = keyword;
  if (state.route !== 'search') state.route = 'search';
  if (!keyword) {
    state.results = [];
    state.searching = false;
    render();
    return;
  }
  state.searching = true;
  state.results = [];
  const requestId = ++searchSeq;
  render();

  api.search.onPartial(({ requestId: id, items, progress }) => {
    if (id !== searchSeq) return;
    state.results = items;
    state.progress = progress;
    if (state.route === 'search') render();
  });

  const res = await api.search.aggregated(keyword, requestId);
  if (res.requestId !== searchSeq) return;
  state.searching = false;
  if (!res.ok) toast(res.error || '搜索失败', true);
  else if (!res.items.length) toast('未搜索到匹配歌曲', true);
  state.results = res.items;
  render();
}

async function loadServerPage(skip) {
  const view = state.serverView;
  view.loading = true;
  view.error = null;
  render();
  const res = await api.server.tracks(view.sourceID, skip, 100);
  view.loading = false;
  if (!res.ok) {
    view.error = res.error || '读取失败';
    render();
    return;
  }
  view.items = skip === 0 ? res.items : view.items.concat(res.items);
  view.total = res.total;
  view.skip = skip + res.items.length;
  render();
}

function formValues(form) {
  const out = {};
  for (const [key, value] of new FormData(form)) out[key] = value;
  return out;
}

function serverConfigFromForm(withPassword) {
  const form = $('server-form');
  if (!form) return null;
  const raw = formValues(form);
  const config = {
    kind: 'daoliyu',
    id: raw.id || undefined,
    name: raw.name || raw.host,
    host: (raw.host || '').trim(),
    port: raw.port ? Number(raw.port) : null,
    useSSL: raw.useSSL === '1',
    basePath: (raw.basePath || '').trim(),
    username: (raw.username || '').trim(),
    insecureTLS: raw.insecureTLS === '1',
  };
  if (withPassword && raw.password) config.password = raw.password;
  if (!config.id) config.unsaved = true;
  return config;
}

async function testServerForm() {
  const config = serverConfigFromForm(true);
  if (!config) return;
  state.formResult = null;
  state.formError = '正在登录并读取第一页…';
  render();
  const res = await api.server.test(config);
  if (res.ok) {
    state.formError = null;
    state.formResult = `连接成功：服务器有 ${res.total} 首曲目` + (res.sample && res.sample.length ? `，例如「${res.sample[0].title}」` : '');
  } else {
    state.formResult = null;
    state.formError = res.error || '连接失败';
  }
  render();
}

document.addEventListener('submit', async (event) => {
  const form = event.target;
  event.preventDefault();

  if (form.id === 'server-form') {
    const config = serverConfigFromForm(true);
    if (!config.host || !config.username) {
      state.formError = 'host 与用户名必填';
      render();
      return;
    }
    // 编辑已保存的源且没重填密码时，不带 password 字段即可保留原值
    if (!config.password) delete config.password;
    const saved = await api.server.upsert(config);
    state.servers = saved;
    state.formServerId = config.id || saved[saved.length - 1]?.id || null;
    state.formResult = '已保存';
    state.formError = null;
    state.route = 'addServer';
    toast('已保存到本机');
    render();
    return;
  }

  if (form.id === 'source-form') {
    const raw = formValues(form);
    await api.sources.upsert({
      name: raw.name,
      baseURL: raw.baseURL,
      platform: raw.platform,
      protocolType: raw.protocolType,
      priority: Number(raw.priority) || 0,
      isEnabled: true,
    });
    state.sources = await api.sources.list();
    state.form = null;
    toast('线路已添加');
    render();
    return;
  }

  if (form.id === 'sheet-form') {
    const s = state.sheet || {};
    const input = $('sheet-name');
    const name = input ? input.value.trim() : '';
    if (s.kind === 'create') {
      const res = await api.playlists.create(name);
      if (!res.ok) {
        state.sheet = { ...s, error: res.error };
        renderSheet();
        return;
      }
      await reloadPlaylists();
      if (s.backTo === 'add' && s.track) {
        // 新建完立刻把刚才那首加进去（iPhone 的 alert 关闭后仍在 sheet 里）
        const added = await api.playlists.add(res.value.id, s.track);
        if (!playlistError(added)) await reloadPlaylists();
        openSheet({ kind: 'add', track: s.track });
      } else {
        closeSheet();
        toast(`已创建歌单「${name}」`);
        state.playlistView = res.value;
        state.route = 'playlist';
      }
      render();
      return;
    }
    if (s.kind === 'rename') {
      const res = await api.playlists.rename(s.id, name);
      if (!res.ok) {
        state.sheet = { ...s, error: res.error };
        renderSheet();
        return;
      }
      await reloadPlaylists();
      closeSheet();
      toast('已重命名');
      render();
      return;
    }
    closeSheet();
    return;
  }

  if (form.id === 'sync-form') {
    const raw = formValues(form);
    const urlRes = await api.sync.setServerURL(raw.serverURL);
    if (!urlRes.ok) {
      state.syncError = urlRes.error;
      render();
      return;
    }
    state.sync = await api.sync.setDeviceName(raw.deviceName).then((r) => r.config);
    state.syncResult = '设置已保存';
    state.syncError = null;
    render();
    return;
  }

  if (form.id === 'settings-form') {
    const raw = formValues(form);
    state.settings = await api.settings.save({
      minimizeToTray: raw.minimizeToTray === '1',
      lyricsFollow: raw.lyricsFollow === '1',
    });
    toast('设置已保存');
    return;
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'server-filter') {
    state.serverView.filter = event.target.value;
    const table = document.querySelector('#detail table.songs');
    if (table) render();
    else state.serverView.filter = event.target.value;
  }
});

// 封面 404 时把 <img> 换成占位块。CSP 是 script-src 'self'，内联 onerror="this.remove()" 会被拦，
// 所以只能在捕获阶段统一处理。
document.addEventListener(
  'error',
  (event) => {
    const el = event.target;
    if (!el || el.tagName !== 'IMG') return;
    const holder = document.createElement('span');
    holder.className = el.className;
    el.replaceWith(holder);
  },
  true
);

/* ── audio 事件 ───────────────────────── */

audio.addEventListener('play', () => {
  state.playing = true;
  renderPlayerBar();
});
audio.addEventListener('pause', () => {
  state.playing = false;
  renderPlayerBar();
});
audio.addEventListener('timeupdate', () => {
  const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.queue[state.index] || {}).duration || 0;
  $('pb-seek').max = Math.floor(total);
  if (!$('pb-seek').dataset.dragging) $('pb-seek').value = Math.floor(audio.currentTime || 0);
  $('pb-current').textContent = fmtTime(audio.currentTime);
  $('pb-total').textContent = fmtTime(total);
  updateLyricIndex();
  if (audio.currentTime > 5) {
    const track = state.queue[state.index];
    if (track) api.library.pushHistory(track, Math.floor(audio.currentTime));
  }
});
audio.addEventListener('ended', () => {
  if (state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  const next = indexAfter(1);
  if (next !== null && next !== undefined) playAt(next);
  else {
    state.playing = false;
    renderPlayerBar();
  }
});
audio.addEventListener('error', () => {
  const track = state.queue[state.index];
  if (track && !audio.dataset.retried) {
    audio.dataset.retried = '1';
    playAt(state.index, { pushHistory: false, force: true });
    return;
  }
  toast('音频取流失败（线路可能被 CDN 拒绝或已过期），可在「在线聚合线路」换线路', true);
  delete audio.dataset.retried;
});
audio.addEventListener('loadedmetadata', () => {
  delete audio.dataset.retried;
});

$('pb-seek').addEventListener('input', (event) => {
  event.target.dataset.dragging = '1';
  $('pb-current').textContent = fmtTime(event.target.value);
});
$('pb-seek').addEventListener('change', (event) => {
  delete event.target.dataset.dragging;
  audio.currentTime = Number(event.target.value);
});
$('pb-volume').addEventListener('input', (event) => {
  state.volume = Number(event.target.value);
  audio.volume = state.volume;
  persistSoon();
});
$('pb-play').addEventListener('click', togglePlay);
$('pb-prev').addEventListener('click', () => step(-1));
$('pb-next').addEventListener('click', () => step(1));
$('pb-like').addEventListener('click', () => {
  const track = state.queue[state.index];
  if (track) toggleFavorite(track);
});
$('pb-repeat').addEventListener('click', () => {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  renderPlayerBar();
  persistSoon();
});
$('pb-shuffle').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  state.order = buildOrder(state.queue.length, state.index, state.shuffle);
  renderPlayerBar();
  persistSoon();
  toast(state.shuffle ? '随机播放：开' : '随机播放：关');
});
$('btn-queue').addEventListener('click', () => {
  state.drawer = state.drawer === 'queue' ? null : 'queue';
  renderDrawer();
});
$('btn-lyrics').addEventListener('click', () => {
  state.drawer = state.drawer === 'lyrics' ? null : 'lyrics';
  renderDrawer();
});
$('drawer-close').addEventListener('click', () => {
  state.drawer = null;
  renderDrawer();
});

document.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') {
    if (state.sheet) closeSheet();
    else if (state.menu) {
      state.menu = null;
      render();
    }
    return;
  }
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
  if (event.code === 'Space') {
    event.preventDefault();
    togglePlay();
  } else if (event.code === 'ArrowRight' && event.ctrlKey) step(1);
  else if (event.code === 'ArrowLeft' && event.ctrlKey) step(-1);
});

api.onPlayerCommand((command) => {
  if (command === 'toggle') togglePlay();
  else if (command === 'next') step(1);
  else if (command === 'previous') step(-1);
  else if (command === 'favorite') $('pb-like').click();
  else if (command === 'queue') $('btn-queue').click();
});

/* ── 冒烟：歌单界面的真实渲染 ─────────── */

function hasButton(scope, text) {
  return [...document.querySelectorAll(`${scope} button`)].some((b) => b.textContent.trim() === text);
}

let smokePlaylistProbe = null; // { id, was } —— 主进程截图后用 phase:'playlist-cleanup' 收走

async function smokePlaylistUI() {
  // 这一段只看 DOM：证明歌单"点得到、看得见"，而不是"代码里写了"。
  // 探针歌单先留着，让主进程截一张歌单页的图；随后由 playlist-cleanup 段删除。
  const probeA = { kind: 'aggregated', platform: 'netease', rawID: 'smoke-ui-a', title: '冒烟 UI 探针 A', artist: '探针', duration: 200 };
  const probeB = { kind: 'aggregated', platform: 'qq', rawID: 'smoke-ui-b', title: '冒烟 UI 探针 B', artist: '探针', duration: 180 };
  const was = { route: state.route, playlistView: state.playlistView };
  const created = await api.playlists.create('冒烟 UI 歌单');
  const id = created.ok ? created.value.id : LIKED_PLAYLIST_ID;
  if (created.ok) {
    await api.playlists.addSong(id, probeA);
    await api.playlists.addSong(id, probeB);
  }
  try {
    await reloadPlaylists();

    state.route = 'playlists';
    render();
    const list = {
      rows: document.querySelectorAll('#detail .playlist-row').length,
      navItems: document.querySelectorAll('#playlist-nav .nav-item').length,
      upload: hasButton('#detail', '上传歌单'),
      download: hasButton('#detail', '下载歌单'),
      cover: document.querySelectorAll('#detail .pl-cover img').length,
    };

    await openPlaylist(id);
    const detail = {
      name: (document.querySelector('#detail h2') || {}).textContent === '冒烟 UI 歌单',
      caption: /首歌曲/.test((document.querySelector('#detail .sub') || {}).textContent || ''),
      playAll: hasButton('#detail', '全部播放'),
      shufflePlay: hasButton('#detail', '随机播放'),
      menuButton: Boolean(document.querySelector('#detail [data-pl-menu]')),
      songs: document.querySelectorAll('#detail table.songs tbody tr').length,
      removeInRow: document.querySelectorAll('#detail [data-remove-from-playlist]').length,
      nextInRow: document.querySelectorAll('#detail [data-next]').length,
    };

    state.menu = `playlist:${id}`;
    render();
    const menuItems = [...document.querySelectorAll('#detail .menu-pop button')].map((b) => b.textContent.trim());

    openSheet({ kind: 'add', track: probeA, backTo: null });
    const sheet = {
      visible: $('sheet').hidden === false,
      title: $('sheet-title').textContent,
      items: document.querySelectorAll('#sheet-body .sheet-item').length,
      checked: [...document.querySelectorAll('#sheet-body .check')].filter((e) => e.textContent.trim() === '✓').length,
      createRow: hasButton('#sheet-body', '＋ 新建歌单'),
    };
    closeSheet();

    state.route = 'sync';
    render();
    const syncView = {
      form: Boolean(document.getElementById('sync-form')),
      deviceId: Boolean(document.querySelector('#sync-form input[readonly]')),
      backup: hasButton('#sync-form', '立即备份到云端（上传歌单）'),
      restore: hasButton('#sync-form', '从云端恢复歌单（拉取同步）'),
      // 原版没有"整库同步"按钮；这里必须明说同步的是歌单结构，不是歌曲源
      honest: /歌单结构/.test((document.querySelector('#detail .sub') || {}).textContent || ''),
    };

    // 停在歌单详情页，让主进程截这张图（搜索页那张证明不了这次的新功能）
    await openPlaylist(id);

    if (created.ok) smokePlaylistProbe = { id, was };
    return { ok: created.ok, list, detail, menuItems, sheet, syncView, error: created.ok ? null : created.error };
  } finally {
    closeSheet();
    state.menu = null;
  }
}

async function smokePlaylistCleanup() {
  if (!smokePlaylistProbe) return { removed: false, note: '没有待清理的探针（上一段就没建成功）' };
  const { id, was } = smokePlaylistProbe;
  const res = await api.playlists.remove(id);
  await reloadPlaylists();
  state.playlistView = state.playlistView && state.playlistView.id === id ? was.playlistView : state.playlistView;
  state.route = was.route;
  render();
  smokePlaylistProbe = null;
  return { removed: Boolean(res && res.ok), stillThere: state.playlists.some((p) => p.id === id), left: state.playlists.filter((p) => !p.isSystem).length };
}

/* ── 启动 ─────────────────────────────── */

api.sources.onLatency(({ id, latencyMs }) => {
  const hit = state.sources.find((s) => s.id === id);
  if (hit) hit.latencyMs = latencyMs;
  if (state.route === 'online') render();
});

(async function boot() {
  const [meta, sources, servers, favorites, history, queue, player, settings, playlistRes, syncConfig] = await Promise.all([
    api.meta(),
    api.sources.list(),
    api.server.list(),
    api.library.favorites(),
    api.library.history(),
    api.queue.load(),
    api.player.load(),
    api.settings.load(),
    api.playlists.list(),
    api.sync.config(),
  ]);

  state.meta = meta;
  state.sources = sources;
  state.servers = servers;
  state.favorites = favorites;
  state.playlists = (playlistRes && playlistRes.ok && playlistRes.value) || [];
  state.sync = syncConfig || {};
  state.history = history;
  state.settings = settings || {};
  state.queue = (queue && queue.items) || [];
  state.index = queue && queue.items && queue.items.length ? Math.min(queue.index || 0, queue.items.length - 1) : -1;
  state.order = buildOrder(state.queue.length, Math.max(0, state.index), Boolean(player.shuffle));
  state.volume = player.volume ?? 0.8;
  state.repeat = player.repeat || 'off';
  state.shuffle = Boolean(player.shuffle);
  audio.volume = state.volume;
  $('pb-volume').value = state.volume;
  $('version-tag').textContent = `${meta.version} · Windows`;

  if (state.index >= 0) setPlayerMeta(state.queue[state.index], null);
  render();

  if (meta.smoke) {
    // 主进程会发 smoke:run；这里把渲染层真实状态报回去
    api.onSmokeRun(async ({ keyword, phase }) => {
      if (phase === 'playlist-ui') {
        api.smokeReport(await smokePlaylistUI());
        return;
      }
      if (phase === 'playlist-cleanup') {
        api.smokeReport(await smokePlaylistCleanup());
        return;
      }
      $('search-input').value = keyword;
      await runSearch(keyword);
      api.smokeReport({
        ready: state.results.length > 0,
        rows: document.querySelectorAll('#detail table.songs tbody tr').length,
        hasPlayerBar: Boolean(document.getElementById('player-bar')),
        hasLoginWall: /登录|请先登录|注册/.test(document.body.innerText),
        resultCount: state.results.length,
        platforms: [...new Set(state.results.map((t) => t.platform))],
        // 歌单相关接线是否真在页面上（不是只写在代码里）
        navHasPlaylists: Boolean(document.querySelector('[data-route="playlists"]')),
        navHasLiked: Boolean(document.querySelector('[data-route="favorites"]')),
        playlistNav: Boolean(document.getElementById('playlist-nav')),
        shuffleButton: Boolean(document.getElementById('pb-shuffle')),
        repeatButton: Boolean(document.getElementById('pb-repeat')),
        addToPlaylistButtons: document.querySelectorAll('[data-add-to-playlist]').length,
        playlists: state.playlists.length,
      });
    });
  }
})();
