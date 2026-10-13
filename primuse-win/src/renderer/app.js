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
  history: [],
  results: [],
  searching: false,
  progress: null,
  filter: 'all',
  keyword: '',
  queue: [],
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
};

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
  const cover = coverOf(track);
  return `<tr data-play="${esc(listRef)}:${idx}" class="${playing ? 'playing' : ''}">
    <td class="col-play"><button class="icon-btn" data-play="${esc(listRef)}:${idx}">${playing ? '▮▮' : '▶'}</button></td>
    <td style="width:44px">${cover ? `<img class="mini-cover" src="${esc(cover)}" loading="lazy" onerror="this.remove()">` : '<span class="mini-cover"></span>'}</td>
    <td>${esc(track.title)}</td>
    <td>${esc(track.artist || '')}</td>
    <td>${esc(track.album || '')}</td>
    <td class="col-flags">${badge}</td>
    <td class="muted">${track.duration ? fmtTime(track.duration) : '--:--'}</td>
    <td class="col-flags"><button class="icon-btn ${isFavorite(track) ? 'on' : ''}" data-fav="${esc(listRef)}:${idx}">${isFavorite(track) ? '♥' : '♡'}</button>
      <button class="icon-btn" data-queue="${esc(listRef)}:${idx}">＋队列</button></td>
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
      <div class="card"><b>我喜欢的</b><span>${state.favorites.length} 首</span><div class="row" style="margin-top:8px"><button data-nav="favorites">打开</button></div></div>
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
  return `<h2>我喜欢的</h2><p class="sub">${state.favorites.length} 首，仅存本机。</p>${songTable(state.favorites, 'favorites', '还没有收藏。播放列表右侧的 ♡ 可以收藏。')}`;
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
  return `<h2>设置</h2>
    <p class="sub">Primuse 桌面版 ${esc(state.meta?.version || '')} · Windows ${esc(state.meta?.platform || '')} · 本地代理 ${esc(state.meta?.proxyBaseUrl || '')}</p>
    <form class="grid" id="settings-form">
      <label>关闭窗口时最小化到托盘</label><select name="minimizeToTray"><option value="1"${state.settings.minimizeToTray === false ? '' : ' selected'}>是</option><option value="0"${state.settings.minimizeToTray === false ? ' selected' : ''}>否</option></select>
      <label>歌词面板自动跟随</label><select name="lyricsFollow"><option value="1"${state.settings.lyricsFollow === false ? '' : ' selected'}>是</option><option value="0"${state.settings.lyricsFollow === false ? ' selected' : ''}>否</option></select>
      <div></div><div class="row"><button type="submit">保存设置</button></div>
    </form>
    <h2 style="font-size:16px">这个包是未签名的</h2>
    <p class="sub">首次运行 Windows 会弹 SmartScreen「未知发布者」——点「更多信息 → 仍要运行」。Mac 端对应的是 Gatekeeper 右键打开。</p>
    <h2 style="font-size:16px">与 iPhone 版一致的地方 / 还差的地方</h2>
    <p class="sub">一致：9 条聚合线路与优先级、四类协议（meting / hyw / nxinxz / openApi）的请求字段、道理鱼的登录与取流方式、无账号体系。<br>
    还差：本地文件与 SMB/NAS 扫描、CUE、scrobble、小组件、CloudKit 同步（这些在 Windows 上要么换实现要么不适用）。</p>`;
}

/* ── 渲染 ─────────────────────────────── */

const LIST_ACCESS = {
  results: () => filteredResults(),
  favorites: () => state.favorites,
  history: () => state.history,
  serverView: () => state.serverView.items,
  queue: () => state.queue,
};

function render() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.route === state.route);
  });

  const views = {
    home: viewHome,
    search: viewSearch,
    favorites: viewFavorites,
    history: viewHistory,
    online: viewOnline,
    addServer: viewServerNew,
    server: viewServerBrowse,
    settings: viewSettings,
  };
  const view = views[state.route] || viewHome;

  const detail = $('detail');
  const keepFocus = document.activeElement && document.activeElement.id === 'server-filter' ? 'server-filter' : null;
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
  if (state.drawer) renderDrawer();
  renderPlayerBar();
}

function renderServerNav() {
  $('server-nav').innerHTML = state.servers
    .map((s) => `<button class="nav-item ${state.route === 'server' && state.serverView.sourceID === s.id ? 'active' : ''}" data-nav="server:${esc(s.id)}">${esc(s.name || s.host)}</button>`)
    .join('')
    + '<button class="nav-item" data-nav="addServer">＋ 添加服务器源</button>';
}

/* ── 播放 ─────────────────────────────── */

let loadToken = 0;

async function playFrom(listRef, index) {
  const list = LIST_ACCESS[listRef] ? LIST_ACCESS[listRef]() : [];
  if (!list.length) return;
  state.queue = list.slice();
  await playAt(index, { pushHistory: true });
  if (state.drawer === 'queue') renderDrawer();
  persistSoon();
}

async function playAt(index, { pushHistory = true, force = false } = {}) {
  if (index < 0 || index >= state.queue.length) return;
  const track = state.queue[index];
  state.index = index;
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
  let next = state.index + delta;
  if (state.shuffle) next = Math.floor(Math.random() * state.queue.length);
  if (next >= state.queue.length) next = state.repeat === 'all' ? 0 : state.queue.length - 1;
  if (next < 0) next = 0;
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
  $('pb-repeat').textContent = `循环: ${state.repeat === 'one' ? '单曲' : state.repeat === 'all' ? '列表' : '关'}`;
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

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-nav], [data-play], [data-fav], [data-queue], [data-filter], [data-toggle-source], [data-ping-all], [data-add-source], [data-reset-sources], [data-clear-history], [data-platform-search], [data-queue-play], [data-load-more], [data-play-all], [data-test-server], [data-remove-server], [data-cancel-form], [data-ly]');
  if (!target) return;
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
    } else {
      go(route);
    }
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
    const track = LIST_ACCESS[list]()[Number(idx)];
    toggleFavorite(track);
    return;
  }
  if (d.queue) {
    const [list, idx] = d.queue.split(':');
    state.queue.push(LIST_ACCESS[list][Number(idx)]);
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
  if (state.index < state.queue.length - 1) playAt(state.index + 1);
  else if (state.repeat === 'all') playAt(0);
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

/* ── 启动 ─────────────────────────────── */

api.sources.onLatency(({ id, latencyMs }) => {
  const hit = state.sources.find((s) => s.id === id);
  if (hit) hit.latencyMs = latencyMs;
  if (state.route === 'online') render();
});

(async function boot() {
  const [meta, sources, servers, favorites, history, queue, player, settings] = await Promise.all([
    api.meta(),
    api.sources.list(),
    api.server.list(),
    api.library.favorites(),
    api.library.history(),
    api.queue.load(),
    api.player.load(),
    api.settings.load(),
  ]);

  state.meta = meta;
  state.sources = sources;
  state.servers = servers;
  state.favorites = favorites;
  state.history = history;
  state.settings = settings || {};
  state.queue = (queue && queue.items) || [];
  state.index = queue && queue.items && queue.items.length ? Math.min(queue.index || 0, queue.items.length - 1) : -1;
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
    api.onSmokeRun(async ({ keyword }) => {
      $('search-input').value = keyword;
      await runSearch(keyword);
      api.smokeReport({
        ready: state.results.length > 0,
        rows: document.querySelectorAll('#detail table.songs tbody tr').length,
        hasPlayerBar: Boolean(document.getElementById('player-bar')),
        hasLoginWall: /登录|请先登录|注册/.test(document.body.innerText),
        resultCount: state.results.length,
        platforms: [...new Set(state.results.map((t) => t.platform))],
      });
    });
  }
})();
