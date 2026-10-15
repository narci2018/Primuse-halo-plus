'use strict';
/*
 * Primuse Windows 版渲染层 —— 结构照 iPhone 版（不是 macOS 版）逐屏抄：
 *
 *   外壳      ContentView.swift:579-617（TabView 四 tab：首页 / 资料库 / 搜索 / 设置）
 *             ContentView.swift:2036-2053 + MiniPlayerView.swift:47-92（tab 上方 44pt 胶囊迷你条）
 *   首页      HomeView.swift（Hero 一键开听 → 继续听 → 快捷收藏 → 我的歌单 → 常听艺术家 → 听歌统计条）
 *   资料库    LibraryView.swift:495-587（「浏览资料库」图标行 + 计数 + 3 张叠封）
 *   歌曲行    SongRowView.swift:281-509（封面 44 / 标题 subheadline / 副行 caption / 尾列 ⋯ 32）
 *   搜索      SearchView.swift（search_prompt、最近搜索、结果分组，末组「全网聚合音乐」）
 *   设置      SettingsView.swift:164-356（节：资料库 / 播放 / 外观 / 同步 / 关于）
 *   音乐源    SourcesView.swift:589-940（源行进设置里，不在外层导航）
 *   播放浮层  NowPlayingView.swift:2100-2350（覆盖层，不是路由；shuffle·prev·play.circle.fill(56)·next·repeat）
 *   同步页    PlaylistSyncSettingsView.swift（文案 1:1，同步的是歌单结构不是歌曲源）
 *
 * 任何网络请求都在主进程；这里只做视图与播放器编排。
 */

const api = window.primuse;
const audio = document.getElementById('audio');

/* ── 常量 ─────────────────────────────── */

const LIKED_PLAYLIST_ID = 'primuse.system.liked'; // MusicLibrary.swift:5138

const PLATFORM_LABEL = {
  all: '全部',
  qq: 'QQ',
  netease: '网易',
  kugou: '酷狗',
  kuwo: '酷我',
  bilibili: 'Bili',
  custom: '自定义',
  server: '服务器',
};

/** FullscreenPlayerEffectSettings.swift:145-158 —— ThemeService 的 12 色板，顺序与命名照抄 */
const ACCENT_SWATCHES = [
  ['147d8a', '青'],
  ['2aaa8a', '翠绿'],
  ['1f8a5b', '森绿'],
  ['0a84ff', '蓝'],
  ['5e5ce6', '靛'],
  ['af52de', '紫'],
  ['ff2d55', '品红'],
  ['e8453c', '朱'],
  ['c96442', '赭'],
  ['ff9500', '橙'],
  ['d4a017', '金'],
  ['5e6b87', '石板'],
];

/** ThemeService.swift:61-62 + Assets AccentColor：默认强调色浅色 #147D8A / 深色 #54C79E */
const DEFAULT_ACCENT_LIGHT = '#147d8a';
const DEFAULT_ACCENT_DARK = '#54c79e';

const SORT_OPTIONS = [
  ['added', '添加日期'],
  ['title', '标题'],
  ['artist', '艺术家'],
  ['album', '专辑'],
  ['duration', '时长'],
  ['source', '来源日期'],
];

const TABS = [
  ['home', '首页', 'house.fill'],
  ['library', '资料库', 'books.vertical'],
  ['search', '搜索', 'magnifyingglass'],
  ['settings', '设置', 'gearshape'],
];

/* ── 状态 ─────────────────────────────── */

const state = {
  meta: null,

  // 导航：每个 tab 一条自己的栈（iPhone 的 TabView + NavigationStack）
  tab: 'home',
  stacks: { home: ['root'], library: ['root'], search: ['root'], settings: ['root'] },

  sources: [],
  servers: [],
  favorites: [],
  playlists: [],
  playlistView: null,
  history: [],
  detailSongs: [], // 专辑 / 艺术家页的当前曲目

  results: [],
  searching: false,
  progress: null,
  keyword: '',
  filter: 'all', // 搜索结果里的平台筛选 chip
  scope: 'aggregated', // 搜索范围：本机资料库 ⇄ 全网聚合
  searchHistory: [],

  queue: [],
  order: [],
  index: -1,
  playing: false,
  repeat: 'off',
  shuffle: false,
  volume: 0.8,

  lyrics: null,
  lyricRows: [],
  lyricIndex: -1,

  playerOpen: false,
  playerView: null, // null | 'lyrics'
  queueOpen: false,
  seekDrag: null,
  playerError: null,
  lastResolve: null, // { kind, upstream, at } —— 播放浮层底部那行「来自哪条线路」
  idCopied: false,

  sheet: null,
  menu: null, // 'playlist:<id>' 之类的行内菜单
  npMenu: false,

  selection: null, // { list, keys:Set } —— 批量选择态
  sort: { key: 'added', asc: false },

  serverView: { sourceID: null, items: [], total: 0, skip: 0, filter: '', loading: false, error: null },
  form: null,
  formServerId: null,
  formError: null,
  formResult: null,

  settings: {},
  theme: { mode: 'automatic', accent: '', coverDriven: true, lyricScale: 1, resolvedAccent: '' },

  sync: null,
  syncBusy: false,
  syncError: null,
  syncResult: null,
  syncDevices: [],

  // 云端音乐源（需求 1/4/5）。config 是主进程那份「只存一个 URL」的状态；
  // settings 是清单里下发的服务端设置（目前就是首页文案，按本机唯一标识关联）；
  // verdicts 是「检测全部可用」逐条落下来的结论，用来在页面上边跑边显示。
  cloud: { config: null, settings: null, busy: false, error: null, result: null, verdicts: {}, checking: false },
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

function fmtDate(ms) {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(ms) {
  const n = Number(ms);
  if (!n) return '';
  return new Date(n).toLocaleString('zh-Hans-CN', { hour12: false });
}

/** iPhone 的相对时间（歌单副标题「N 首歌曲 · 3 天前」） */
function fmtRelative(ms) {
  const n = Number(ms);
  if (!n) return '';
  const days = Math.floor((Date.now() - n) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return fmtDate(n);
}

/** HomeView 的时段问候（home_hero_narrative_*） */
function greeting(count) {
  const h = new Date().getHours();
  const n = count || 0;
  if (h < 5) return `今晚, 你的资料库里藏着 ${n} 个故事`;
  if (h < 12) return `早上好, 你的资料库里有 ${n} 个故事`;
  if (h < 18) return `下午好, 你的资料库里有 ${n} 个故事`;
  return `晚上好, 你的资料库里藏着 ${n} 个故事`;
}

const trackKey = (t) => `${t.kind || 'aggregated'}:${t.sourceID || t.platform}:${t.rawID}`;

function isFavorite(track) {
  return state.favorites.some((t) => trackKey(t) === trackKey(track));
}

function currentTrack() {
  return state.queue[state.index] || null;
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

let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    api.queue.save({ items: state.queue, index: state.index });
    api.player.save({ volume: state.volume, repeat: state.repeat, shuffle: state.shuffle });
  }, 600);
}

function saveThemeSoon() {
  clearTimeout(saveThemeSoon.timer);
  saveThemeSoon.timer = setTimeout(() => {
    api.settings.save({ theme: state.theme, searchHistory: state.searchHistory });
  }, 400);
}

/* ── 主题（ThemeService.swift:61-62 + 封面取色）───────── */

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** WCAG 相对亮度 —— 原版用它决定强调色上的文字是黑是白（阈值 0.179） */
function contrastOn(hexColor) {
  const n = hexColor.replace('#', '');
  const ch = (i) => parseInt(n.slice(i, i + 2), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
  return l > 0.179 ? '#0a0a0c' : '#ffffff';
}

function isDarkNow() {
  if (state.theme.mode === 'dark') return true;
  if (state.theme.mode === 'light') return false;
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyAccent(hex) {
  const root = document.documentElement;
  const color = hex || (isDarkNow() ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT);
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-soft', `rgba(${rgb.join(', ')}, 0.14)`);
  root.style.setProperty('--accent-soft-2', `rgba(${rgb.join(', ')}, 0.24)`);
  root.style.setProperty('--on-accent', contrastOn(color));
}

function applyAppearance() {
  const root = document.documentElement;
  if (state.theme.mode === 'automatic') root.removeAttribute('data-appearance');
  else root.setAttribute('data-appearance', state.theme.mode);
  applyAccent(state.theme.resolvedAccent || state.theme.accent || '');
}

/**
 * defaultCoverDrivenAccent = true：界面氛围色取自封面主色。
 * 算法照 CoverPalette：40×40 降采样 → 24 个色相桶 → 过滤 s≥0.24 且 0.10<v<0.95 → 权重 s²·(0.55+0.45v)
 * → 命中色归一到 S∈[0.35,0.92]、V∈[0.50,0.85]。
 * 跨域封面会污染 canvas，getImageData 抛 SecurityError → 退回用户设定色，不炸界面。
 */
function refreshAccentFromArtwork(url) {
  if (!state.theme.coverDriven || !url) {
    state.theme.resolvedAccent = '';
    applyAccent(state.theme.accent || '');
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const cv = document.createElement('canvas');
      cv.width = 40;
      cv.height = 40;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 40, 40);
      const data = ctx.getImageData(0, 0, 40, 40).data;
      const buckets = new Array(24).fill(0).map(() => ({ w: 0, h: 0, s: 0, v: 0 }));
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue;
        const px = rgbToHsv(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
        if (px.s < 0.24 || px.v <= 0.1 || px.v >= 0.95) continue;
        const b = buckets[Math.min(23, Math.floor(px.h / 15))];
        const w = px.s * px.s * (0.55 + 0.45 * px.v);
        b.w += w;
        b.h += px.h * w;
        b.s += px.s * w;
        b.v += px.v * w;
      }
      const best = buckets.reduce((a, b) => (b.w > (a ? a.w : -1) ? b : a), null);
      if (!best || best.w <= 0) throw new Error('no-swatch');
      const hex = hsvToHex(
        best.h / best.w,
        Math.min(0.92, Math.max(0.35, best.s / best.w)),
        Math.min(0.85, Math.max(0.5, best.v / best.w))
      );
      state.theme.resolvedAccent = hex;
      applyAccent(hex);
      if (state.playerOpen) $('player-bg').style.setProperty('--ambient', hex);
    } catch {
      // 多数第三方 CDN 不发 Access-Control-Allow-Origin，canvas 被污染读不回像素
      state.theme.resolvedAccent = '';
      applyAccent(state.theme.accent || '');
    }
  };
  img.onerror = () => applyAccent(state.theme.accent || '');
  img.src = url;
}

/* ── 歌单读取（真源在主进程 store，渲染层只拿快照）──────── */

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

function playlistSubtitle(p) {
  const when = fmtRelative(p.updatedAt || p.createdAt);
  return `${p.songs.length} 首歌曲${when ? ` · ${when}` : ''}`;
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

function visiblePlaylists() {
  // PlaylistListView.swift:36-38 —— 歌单总览过滤掉「我喜欢」，它走固定入口。
  return state.playlists.filter((p) => !p.isSystem);
}

/* ── 资料库（本机留存 = 我喜欢 + 歌单成员 + 最近播放）───── */

function libraryTracks() {
  const seen = new Map();
  const push = (t, addedAt) => {
    if (!t || !t.rawID) return;
    const k = trackKey(t);
    if (!seen.has(k)) seen.set(k, { ...t, addedAt: Number(addedAt) || 0 });
    else if ((Number(addedAt) || 0) > seen.get(k).addedAt) seen.get(k).addedAt = Number(addedAt) || 0;
  };
  for (const f of state.favorites) push(f, f.addedAt || f.playedAt || Date.now());
  for (const h of state.history) push(h.track || h, h.playedAt);
  for (const p of state.playlists) for (const s of p.songs || []) push(s, p.updatedAt);
  return [...seen.values()];
}

function sortedLibrary() {
  const { key, asc } = state.sort;
  const cmp = {
    added: (a, b) => a.addedAt - b.addedAt,
    title: (a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'),
    artist: (a, b) => String(a.artist || '').localeCompare(String(b.artist || ''), 'zh-Hans-CN'),
    album: (a, b) => String(a.album || '').localeCompare(String(b.album || ''), 'zh-Hans-CN'),
    duration: (a, b) => (a.duration || 0) - (b.duration || 0),
    source: (a, b) => a.addedAt - b.addedAt,
  }[key];
  return libraryTracks().sort((a, b) => (asc ? cmp(a, b) : -cmp(a, b)));
}

function groupBy(list, pick) {
  const map = new Map();
  for (const t of list) {
    const k = String(pick(t) || '').trim();
    if (!k) continue;
    if (!map.has(k)) map.set(k, { name: k, songs: [], cover: coverOf(t) || null, artist: t.artist || '' });
    const g = map.get(k);
    g.songs.push(t);
    if (!g.cover) g.cover = coverOf(t);
    if (!g.artist && t.artist) g.artist = t.artist;
  }
  return [...map.values()].sort((a, b) => b.songs.length - a.songs.length || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

const albumsOf = () => groupBy(libraryTracks(), (t) => t.album);
const artistsOf = () => groupBy(libraryTracks(), (t) => t.artist);

function weekStats() {
  const since = Date.now() - 7 * 86400000;
  const rows = state.history.filter((h) => Number(h.playedAt) >= since);
  return {
    count: new Set(rows.map((h) => trackKey(h))).size,
    days: new Set(rows.map((h) => fmtDate(h.playedAt))).size,
    seconds: rows.reduce((n, h) => n + (Number(h.playedSeconds) || Number(h.duration) || 0), 0),
  };
}

/* ── 列表访问（data-* 里的 "listRef:index" 靠它解析）───── */

function filteredResults() {
  if (state.scope === 'library') {
    const q = state.keyword.toLowerCase();
    return libraryTracks().filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
  }
  if (state.filter === 'all') return state.results;
  return state.results.filter((t) => (t.platform || 'server') === state.filter);
}

const LISTS = {
  results: () => filteredResults(),
  library: () => sortedLibrary(),
  liked: () => state.favorites,
  history: () => state.history,
  queue: () => state.queue,
  serverView: () => state.serverView.items,
  currentPlaylist: () => (state.playlistView ? state.playlistView.songs : []),
  detail: () => state.detailSongs,
  forYou: () => libraryTracks().slice(0, 12),
};

function listOf(ref) {
  const fn = LISTS[ref];
  return fn ? fn() : [];
}

function trackAt(ref) {
  const [list, idx] = String(ref).split(':');
  return listOf(list)[Number(idx)] || null;
}

/* ── 导航 ─────────────────────────────── */

function pageRef() {
  // 每个 tab 一条独立导航栈（iPhone NavigationStack）。栈永远至少装着 root：
  // 少了这层兜底，一次错误的 stacks 赋值会让整块内容渲染不出来。
  let stack = state.stacks[state.tab];
  if (!Array.isArray(stack) || !stack.length) {
    stack = ['root'];
    state.stacks[state.tab] = stack;
  }
  return stack[stack.length - 1];
}

/** 'root' | 'songs' | 'playlist:<id>' | 'server:<id>' | 'album:<n>' … */
function parsePage(ref) {
  const i = ref.indexOf(':');
  return i < 0 ? { name: ref, arg: '' } : { name: ref.slice(0, i), arg: ref.slice(i + 1) };
}

const LIBRARY_PAGES = ['songs', 'albums', 'album', 'artists', 'artist', 'playlists', 'playlist', 'liked', 'history', 'stats'];
const SETTINGS_PAGES = ['sources', 'lines', 'server', 'editServer', 'sync', 'appearance', 'about'];

function tabOfPage(name) {
  if (LIBRARY_PAGES.includes(name)) return 'library';
  if (SETTINGS_PAGES.includes(name)) return 'settings';
  return 'home';
}

function push(page) {
  state.stacks[state.tab].push(page);
  state.selection = null;
  render();
}

function pop() {
  const stack = state.stacks[state.tab];
  if (stack.length > 1) stack.pop();
  state.selection = null;
  render();
}

/** 原版从首页/资料库跳详情 = push；跨 tab 的跳转先切 tab 再 push */
function open(page, opts = {}) {
  const target = opts.tab || tabOfPage(parsePage(page).name);
  if (state.tab !== target) {
    state.tab = target;
    state.stacks[target] = ['root', page];
    state.selection = null;
    render();
  } else {
    push(page);
  }
}

function switchTab(tab) {
  if (state.tab === tab) {
    state.stacks[tab] = ['root']; // 再点一次回根页（原版行为）
    render();
    return;
  }
  state.tab = tab;
  render();
  if (tab === 'search') {
    const input = $('search-input');
    if (input) input.focus();
  }
}

/* ── 视图碎片 ─────────────────────────── */

const num = (n) => Number(n || 0).toLocaleString('zh-Hans-CN');

/**
 * 无封面时的占位色相。用户 2026-10-15 的原话："全部缩略图不要用灰色的"。
 *
 * 刻意不做成"随机"：FNV-1a 哈希 + 一张固定色相表，同名恒定同色（刷新不跳、
 * 两台机器上同一个歌单也是同一个颜色），不同名字岔开。色相表是手挑的 8 档鲜艳色，
 * 排掉了 200–260 那一段纯蓝紫（在深色底下发灰、看着还是像占位块）。
 */
const COVER_HUES = [348, 22, 45, 96, 158, 300, 330, 68];
function hueOf(seed) {
  const basis = String(seed == null ? '' : seed);
  let hash = 0x811c9dc5;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return COVER_HUES[hash % COVER_HUES.length];
}

function bgStyle(url, seed) {
  if (url) return ` style="background-image:url('${esc(url)}')"`;
  return ` style="--ph-hue:${hueOf(seed !== undefined && seed !== null && seed !== '' ? seed : 'primuse')}"`;
}

function badgeOf(track) {
  if (track.kind === 'server') return `<span class="badge server">${esc(track.sourceName || '服务器源')}</span>`;
  return `<span class="badge ${esc(track.platform || 'netease')}">${esc(PLATFORM_LABEL[track.platform] || track.platform || '')}</span>`;
}

const unresolvedBadge = '<span class="badge unresolved" title="同步下来的是歌单结构，本机没有这台服务器源">无对应源</span>';

/** 导航条：根页用 large title，push 进来的页用 inline + 返回（iOS NavigationBar 的两种形态） */
function navBar({ title, lead = '', large = false, backLabel = '返回', trailing = '' }) {
  if (large) {
    return `<div class="navbar"><div class="navbar-large"><span class="ttl">${esc(title)}</span>${
      lead ? `<span class="lead">${esc(lead)}</span>` : ''
    }${trailing}</div></div>`;
  }
  return `<div class="navbar"><div class="navbar-inline">
      <button class="back" data-back="1">${icon('chevron.left')}<span>${esc(backLabel)}</span></button>
      <span class="ttl">${esc(title)}</span>${trailing}
    </div></div>`;
}

function emptyState({ icon: name, title, desc, action }) {
  return `<div class="empty-state">${icon(name)}<div class="t">${esc(title)}</div><div class="d">${esc(desc)}</div>${action || ''}</div>`;
}

/** SongRowView.swift:281-509：封面 44 圆角 6 → 标题 subheadline + 副行 caption → 尾列角标与 ⋯ */
function songRow(track, listRef, idx) {
  const key = trackKey(track);
  const cur = currentTrack();
  const playing = cur && trackKey(cur) === key;
  const selected = state.selection && state.selection.list === listRef && state.selection.keys.has(key);
  const cover = coverOf(track);
  const ref = `${listRef}:${idx}`;
  const parts = [track.artist || '未知艺术家'];
  if (track.album) parts.push(track.album);
  if (track.duration) parts.push(fmtTime(track.duration));
  const sub = parts.map((p) => esc(p)).join('<span class="dot">·</span>');
  const check = state.selection
    ? `<span class="row-check">${icon(selected ? 'checkmark.circle.fill' : 'checkmark.circle')}</span>`
    : '';
  return `<div class="song-row${playing ? ' playing' : ''}${selected ? ' selected' : ''}" data-play="${ref}">
    <div class="song-cover${playing ? ' is-playing' : ''}"${bgStyle(cover, `${track.title}|${track.artist}`)}>${
      playing && state.playing ? '<span class="wave"><i></i><i></i><i></i></span>' : ''
    }</div>
    ${check}
    <div class="cols"><div class="song-title">${esc(track.title)}</div><div class="song-sub">${sub}</div></div>
    <div class="song-tail">${track.unresolved ? unresolvedBadge : badgeOf(track)}
      <button class="song-more" data-row-menu="${esc(ref)}" title="更多">${icon('ellipsis')}</button>
    </div>
  </div>`;
}

function songList(tracks, listRef, empty) {
  if (!tracks.length) return empty || '';
  return `<div class="section-list">${tracks
    .map((t, i) => songRow(t, listRef, i))
    .join('<div class="list-divider"></div>')}</div>`;
}

/** PlaylistArtworkView 的取图规则（PrimuseKit/.../Playlist.swift:169-227）：
 *  不是"取第一首"，而是用 playlist.id + 排序后的成员 ID 做稳定哈希挑一张 —— 两端一致、每次打开不变。 */
function playlistCoverURL(p) {
  const candidates = (p.songs || []).map(coverOf).filter(Boolean);
  if (!candidates.length) return null;
  const basis = `${p.id}|${(p.songs || []).map((t) => trackKey(t)).sort().join(',')}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return candidates[hash % candidates.length];
}

function coverSpan(p, cls) {
  const url = p.id === LIKED_PLAYLIST_ID ? (state.favorites.map(coverOf).find(Boolean) || null) : playlistCoverURL(p);
  return `<div class="${cls}"${bgStyle(url, p && p.name)}>${url ? '' : '♪'}</div>`;
}

function playlistRow(p) {
  return `<div class="pl-row" data-page="${p.id === LIKED_PLAYLIST_ID ? 'liked' : `playlist:${esc(p.id)}`}">
    ${coverSpan(p, 'pl-cover')}
    <div class="pl-body"><div class="pl-name">${esc(p.name)}</div><div class="pl-sub">${esc(playlistSubtitle(p))}</div></div>
    <span class="chev">${icon('chevron.right')}</span>
  </div>`;
}

/** 行内 ⋯ 菜单（.menu 容器 + .menu-pop 绝对定位）；条目 HTML 由 menuButtons 统一生成 */
function menuPop(open, items, cls = '') {
  if (!open) return '';
  return `<div class="menu-pop ${cls}">${menuButtons(items)}</div>`;
}

function menuItem(attr, label, opts = {}) {
  return { attr, label, ...opts };
}

/* ── 首页（HomeView.swift 的分区顺序）────────────────── */

/* 需求 5：首页 header 的文案由服务端设置，按"本机唯一标识"关联。
   清单里 settings.homeTitleFrom 会说明这个词是哪一层来的（device / global / default），
   拿不到清单时回落到"首页"，界面不能因为云端不可达而少一个标题。 */
function homeTitle() {
  const s = (state.cloud && state.cloud.settings) || {};
  return String(s.homeTitle || '').trim() || '首页';
}

function pageHome() {
  const library = libraryTracks();
  if (!library.length) {
    return (
      navBar({ title: homeTitle(), large: true }) +
      `<div class="page-body">${emptyState({
        icon: 'music.note',
        title: '欢迎使用猿音',
        desc: '在设置中添加音乐源，开始构建你的音乐库',
        action: `<button class="pill prominent" data-page="sources">${icon('externaldrive')}<span>音乐源管理</span></button>`,
      })}${heroForAggregated()}</div>`
    );
  }

  const heroCovers = library
    .slice(0, 4)
    .map((t) => coverOf(t))
    .filter(Boolean);
  const rotates = [-10, -3, 5, 12];
  const art = heroCovers.length
    ? `<div class="hero-art">${heroCovers
        .map(
          (u, i) =>
            `<span style="background-image:url('${esc(u)}');left:${i * 15}px;top:${i % 2 ? 6 : 2}px;transform:rotate(${rotates[i % 4]}deg);z-index:${i}"></span>`
        )
        .join('')}</div>`
    : '';

  const recent = state.history.slice(0, 12);
  const playlists = visiblePlaylists().slice(0, 4);
  const artists = artistsOf().slice(0, 8);
  const albums = albumsOf().slice(0, 8);
  const wk = weekStats();
  const hours = wk.seconds >= 3600 ? `${Math.floor(wk.seconds / 3600)} 小时` : `${Math.round(wk.seconds / 60)} 分钟`;

  const continueRow = recent.length
    ? `<div class="section">
        <div class="section-head"><h3>继续听</h3><button class="more" data-page="history">全部</button></div>
        <div class="hscroll">${recent
          .map(
            (t, i) => `<div class="hcard" data-play="history:${i}">
              <div class="song-cover"${bgStyle(coverOf(t), `history:${t.title}|${t.artist}`)}></div>
              <div class="cols"><div class="song-title">${esc(t.title)}</div><div class="song-sub">${esc(t.artist || '')}</div></div>
            </div>`
          )
          .join('')}</div>
      </div>`
    : '';

  const quick = `<div class="section">
      <div class="section-head"><h3>快捷收藏</h3></div>
      <div class="qa-grid">
        <div class="qa-item" data-page="liked"><div class="art"${bgStyle(state.favorites.map(coverOf).find(Boolean), '我喜欢')}>${
          state.favorites.map(coverOf).find(Boolean) ? '' : icon('heart.fill')
        }</div><div class="nm">我喜欢</div></div>
        <div class="qa-item" data-page="playlists"><div class="art">${icon('music.note.list')}</div><div class="nm">歌单</div></div>
        <div class="qa-item" data-page="albums"><div class="art"${bgStyle(albums[0] ? albums[0].cover : '', '专辑')}>${
          albums[0] && albums[0].cover ? '' : icon('square.stack')
        }</div><div class="nm">专辑</div></div>
        <div class="qa-item" data-page="artists"><div class="art"${bgStyle(artists[0] ? artists[0].cover : '', '艺术家')}>${
          artists[0] && artists[0].cover ? '' : icon('person.2')
        }</div><div class="nm">艺术家</div></div>
        <div class="qa-item" data-page="history"><div class="art">${icon('clock')}</div><div class="nm">最近播放</div></div>
        <div class="qa-item" data-page="sources"><div class="art">${icon('externaldrive')}</div><div class="nm">音乐源</div></div>
      </div>
    </div>`;

  const plSection = `<div class="section">
      <div class="section-head"><h3>我的歌单</h3><button class="more" data-page="playlists">全部</button></div>
      ${
        playlists.length
          ? `<div class="section-list">${playlists.map(playlistRow).join('<div class="list-divider"></div>')}</div>`
          : `<p class="hint">还没有歌单。<button class="ghost" data-new-playlist="1">新建歌单</button></p>`
      }
    </div>`;

  const artistSection = artists.length
    ? `<div class="section">
        <div class="section-head"><h3>常听艺术家</h3></div>
        <div class="hscroll">${artists
          .map(
            (a) => `<div class="qa-item" data-page="artist:${esc(a.name)}" style="width:76px">
              <div class="art" style="width:64px;height:64px;border-radius:50%;--ph-hue:${hueOf(`artist:${a.name}`)};${a.cover ? `background-image:url('${esc(a.cover)}')` : ''}">${
              a.cover ? '' : icon('person.2')
            }</div><div class="nm">${esc(a.name)}</div>
            </div>`
          )
          .join('')}</div>
      </div>`
    : '';

  const albumSection = albums.length
    ? `<div class="section">
        <div class="section-head"><h3>最近添加专辑</h3><button class="more" data-page="albums">全部</button></div>
        <div class="hscroll">${albums
          .map(
            (a) => `<div class="hcard" data-page="album:${esc(a.name)}" style="width:150px">
              <div class="song-cover"${bgStyle(a.cover, `album:${a.name}`)}></div>
              <div class="cols"><div class="song-title">${esc(a.name)}</div><div class="song-sub">${a.songs.length} 首</div></div>
            </div>`
          )
          .join('')}</div>
      </div>`
    : '';

  const statRow = `<div class="section">
      <div class="stat-bar" data-page="stats">
        <div class="sico" style="background:var(--accent)">${icon('chart.bar')}</div>
        <div style="flex:1"><div class="t">本周已听 ${num(wk.count)} 首 · ${hours}</div>
        <div class="s">${num(library.length)} 首在库 · ${num(visiblePlaylists().length)} 个歌单 · ${wk.days} 天有听</div></div>
        <span class="chev">${icon('chevron.right')}</span>
      </div>
    </div>`;

  return (
    navBar({ title: homeTitle(), large: true, trailing: `<button class="bar-btn ghost" data-page="stats">${icon('chart.bar')}</button>` }) +
    `<div class="page-body">
      <div class="hero">
        <div class="hero-top">
          <div class="hero-text"><div class="hero-greet">${esc(greeting(library.length))}</div><div class="hero-title">一键开听整个资料库</div></div>
          ${art}
        </div>
        <div class="hero-actions">
          <button class="btn-prominent" data-library-shuffle="1">随机播放</button>
          <button class="btn-bordered" data-library-play="1">全部播放</button>
        </div>
      </div>
      ${continueRow}${quick}${plSection}${artistSection}${albumSection}${statRow}
    </div>`
  );
}

/** 资料库为空时首页仍要能开听 —— 聚合线路不依赖本地库（SearchView.swift:486-487） */
function heroForAggregated() {
  return `<div class="section">
      <div class="section-head"><h3>全网聚合搜索</h3></div>
      <p class="hint">输入歌曲名或歌手，即可直接搜索并畅听全网聚合音乐</p>
      <div class="actions-row"><button class="pill prominent" data-tab="search">${icon('magnifyingglass')}<span>去搜索</span></button>
      <button class="pill" data-page="lines">${icon('sparkles')}<span>聚合音乐源设置</span></button></div>
    </div>`;
}

/* ── 资料库（LibraryView.swift:495-587 的 hub）────────── */

const HUB_ROWS = [
  ['songs', '歌曲', 'music.note', '#0a84ff', (s) => `${num(s.library)} 首歌曲`],
  ['albums', '专辑', 'square.stack', '#af52de', (s) => `${num(s.albums)} 张专辑`],
  ['artists', '艺术家', 'person.2', '#ff9500', (s) => `${num(s.artists)} 位艺术家`],
  ['playlists', '歌单', 'music.note.list', '#1f8a5b', (s) => `${num(s.playlists)} 个歌单`],
  ['liked', '我喜欢', 'heart.fill', '#ff2d55', (s) => `${num(s.favorites)} 首歌曲`],
  ['history', '最近播放', 'clock', '#5e6b87', (s) => `${num(s.history)} 首歌曲`],
  ['stats', '听歌统计', 'chart.bar', '#147d8a', (s) => `本周 ${num(s.week)} 首`],
];

function pageLibrary() {
  const library = libraryTracks();
  const albums = albumsOf();
  const artists = artistsOf();
  const counts = {
    library: library.length,
    albums: albums.length,
    artists: artists.length,
    playlists: visiblePlaylists().length,
    favorites: state.favorites.length,
    history: state.history.length,
    week: weekStats().count,
  };
  const coversFor = (ref) => {
    if (ref === 'songs') return library.slice(0, 3).map(coverOf);
    if (ref === 'albums') return albums.slice(0, 3).map((a) => a.cover);
    if (ref === 'artists') return artists.slice(0, 3).map((a) => a.cover);
    if (ref === 'playlists') return visiblePlaylists().slice(0, 3).map(playlistCoverURL);
    if (ref === 'liked') return state.favorites.slice(0, 3).map(coverOf);
    if (ref === 'history') return state.history.slice(0, 3).map(coverOf);
    return [];
  };

  const rows = HUB_ROWS.map(([ref, name, iconName, color, fmt]) => {
    const stack = coversFor(ref)
      .filter(Boolean)
      .map((u) => `<span${bgStyle(u)}></span>`)
      .join('');
    return `<div class="hub-row" data-page="${ref}">
      <div class="hub-ico" style="background:${color}">${icon(iconName)}</div>
      <div style="flex:1;min-width:0"><div class="hub-name">${name}</div><div class="hub-count">${esc(fmt(counts))}</div></div>
      <div class="hub-stack">${stack}</div><span class="chev">${icon('chevron.right')}</span>
    </div>`;
  }).join('');

  const sources = state.servers
    .map(
      (s) => `<div class="hub-row" data-page="server:${esc(s.id)}">
        <div class="hub-ico" style="background:#c96442">${icon('globe')}</div>
        <div style="flex:1;min-width:0"><div class="hub-name">${esc(s.name || s.host)}</div>
          <div class="hub-count">服务器型源 · ${esc(s.host)}${s.port ? `:${s.port}` : ''}</div></div>
        <span class="chev">${icon('chevron.right')}</span>
      </div>`
    )
    .join('');

  return (
    navBar({ title: '资料库', large: true, lead: `${num(counts.library)} 首 · ${num(counts.playlists)} 个歌单` }) +
    `<div class="page-body">
      <div class="section"><div class="section-head"><h3>浏览资料库</h3></div><div class="hub">${rows}</div></div>
      ${
        sources
          ? `<div class="section"><div class="section-head"><h3>我的音乐源</h3><button class="more" data-page="sources">管理</button></div>
             <div class="hub">${sources}</div></div>`
          : `<div class="section"><div class="section-head"><h3>我的音乐源</h3></div>
             <p class="hint">资料库目前只有本机收藏与歌单里的歌。添加自建服务器源（道理鱼）后可以整库浏览。</p>
             <div class="actions-row"><button class="pill" data-page="editServer">${icon('plus')}<span>添加音乐源</span></button></div></div>`
      }
    </div>`
  );
}

/* ── 歌曲 / 专辑 / 艺术家 ─────────────────────────── */

function pageSongs() {
  const tracks = sortedLibrary();
  const sortOpen = state.menu === 'sort';
  const items = [
    { head: '排序方式' },
    ...SORT_OPTIONS.map(([key, label]) => menuItem(`data-sort="${key}"`, label, { mark: state.sort.key === key ? (state.sort.asc ? '↑' : '↓') : '' })),
    '-',
    menuItem('data-select-mode="library"', '选择'),
    menuItem('data-play-all-of="library"', '全部播放'),
    menuItem('data-shuffle-all-of="library"', '随机播放'),
  ];
  const trailing = `<div class="menu bar-menu">
      <button class="bar-btn" data-menu="sort">${icon('line.3.horizontal.decrease.circle')}</button>
      ${menuPop(sortOpen, items, 'right')}
    </div>`;

  const head = `<div class="section-head"><h3>${num(tracks.length)} 首</h3></div>`;
  return (
    navBar({ title: '歌曲', trailing }) +
    `<div class="page-body">${
      tracks.length ? `${head}${songList(tracks, 'library')}` : emptyState({ icon: 'music.note', title: '没有歌曲', desc: '添加音乐源以开始使用', action: `<button class="pill" data-page="sources">${icon('externaldrive')}<span>音乐源管理</span></button>` })
    }</div>`
  );
}

function pageAlbums() {
  const albums = albumsOf();
  const rows = albums
    .map(
      (a) => `<div class="pl-row" data-page="album:${esc(a.name)}">
        <div class="pl-cover"${bgStyle(a.cover, `album:${a.name}`)}>${a.cover ? '' : '♪'}</div>
        <div class="pl-body"><div class="pl-name">${esc(a.name)}</div><div class="pl-sub">${esc(a.artist || '未知艺术家')} · ${a.songs.length} 首</div></div>
        <span class="chev">${icon('chevron.right')}</span>
      </div>`
    )
    .join('<div class="list-divider"></div>');
  return (
    navBar({ title: '专辑' }) +
    `<div class="page-body">${
      albums.length ? `<div class="section-list">${rows}</div>` : emptyState({ icon: 'square.stack', title: '没有专辑', desc: '添加音乐源以开始使用' })
    }</div>`
  );
}

function pageArtists() {
  const artists = artistsOf();
  const rows = artists
    .map(
      (a) => `<div class="pl-row" data-page="artist:${esc(a.name)}">
        <div class="pl-cover" style="border-radius:50%;${a.cover ? `background-image:url('${esc(a.cover)}')` : `--ph-hue:${hueOf(`artist:${a.name}`)}`}">${a.cover ? '' : icon('person.2')}</div>
        <div class="pl-body"><div class="pl-name">${esc(a.name)}</div><div class="pl-sub">${a.songs.length} 首歌曲</div></div>
        <span class="chev">${icon('chevron.right')}</span>
      </div>`
    )
    .join('<div class="list-divider"></div>');
  return (
    navBar({ title: '艺术家' }) +
    `<div class="page-body">${
      artists.length ? `<div class="section-list">${rows}</div>` : emptyState({ icon: 'person.2', title: '没有艺术家', desc: '添加音乐源以开始使用' })
    }</div>`
  );
}

/** 专辑 / 艺术家详情：detail-hero（180 封面 + 名称 + 计数）+ 全部播放 / 随机播放 */
function pageDetail(kind, name) {
  const groups = kind === 'album' ? albumsOf() : artistsOf();
  const g = groups.find((x) => x.name === name) || { name, songs: [], cover: null, artist: '' };
  state.detailSongs = g.songs;
  const sub = kind === 'album' ? esc(g.artist || '未知艺术家') : `${g.songs.length} 首歌曲`;
  return (
    navBar({ title: kind === 'album' ? '专辑' : '艺术家' }) +
    `<div class="page-body">
      <div class="detail-hero">
        <div class="detail-cover" style="${kind === 'artist' ? 'border-radius:50%;' : ''}${
          g.cover ? `background-image:url('${esc(g.cover)}')` : `--ph-hue:${hueOf(`${kind}:${g.name}`)}`
        }">${g.cover ? '' : icon(kind === 'album' ? 'square.stack' : 'person.2')}</div>
        <div class="detail-name">${esc(g.name)}</div><div class="detail-sub">${sub}</div>
      </div>
      <div class="detail-actions">
        <button class="pill prominent" data-play-all-of="detail">${icon('play.fill')}<span>全部播放</span></button>
        <button class="pill" data-shuffle-all-of="detail">${icon('shuffle')}<span>随机播放</span></button>
        <button class="pill" data-select-mode="detail">${icon('checkmark.circle')}<span>选择</span></button>
      </div>
      ${songList(g.songs, 'detail')}
    </div>`
  );
}

/* ── 歌单（PlaylistListView / PlaylistDetailView）─────── */

function likedAsPlaylist() {
  const when = state.favorites.length ? Math.max(...state.favorites.map((t) => Number(t.addedAt) || 0)) : 0;
  return { id: LIKED_PLAYLIST_ID, name: '我喜欢', isSystem: true, songs: state.favorites, createdAt: when, updatedAt: when };
}

function pagePlaylists() {
  const list = visiblePlaylists();
  const addOpen = state.menu === 'plAdd';
  const items = [
    menuItem('data-new-playlist="1"', '新建歌单', { icon: 'plus' }),
    menuItem('data-import-file="1"', '导入歌单', { icon: 'tray.and.arrow.down' }),
    '-',
    menuItem('data-sync-backup="1"', '上传歌单（备份到云端）', { icon: 'square.and.arrow.up' }),
    menuItem('data-sync-restore="1"', '下载歌单（从云端恢复）', { icon: 'arrow.clockwise' }),
    menuItem('data-page="sync"', '歌单同步设置', { icon: 'globe' }),
  ];
  const trailing = `<div class="menu"><button class="bar-btn" data-menu="plAdd" title="歌单操作">${icon('plus')}</button>${menuPop(addOpen, items, 'right')}</div>`;

  const rows = [playlistRow(likedAsPlaylist()), ...list.map(playlistRow)]
    .join('<div class="list-divider"></div>');

  return (
    navBar({ title: '歌单', trailing }) +
    `<div class="page-body">${
      list.length
        ? `<div class="section-list">${rows}</div>
           <p class="hint">${list.length} 个歌单 · 共 ${num(list.reduce((n, p) => n + p.songs.length, 0))} 首 ·
           云端备份：${state.sync && state.sync.lastBackupAt ? esc(fmtRelative(state.sync.lastBackupAt)) : '从未'}</p>`
        : `${emptyState({ icon: 'music.note.list', title: '没有歌单', desc: '创建歌单来整理你的音乐', action: `<button class="pill prominent" data-new-playlist="1">${icon('plus')}<span>新建歌单</span></button>` })}
           <div class="section-list">${rows}</div>`
    }</div>`
  );
}

function pagePlaylist(id) {
  const p =
    id === LIKED_PLAYLIST_ID
      ? likedAsPlaylist()
      : playlistById(id) || { id, name: '找不到歌单', songs: [], isSystem: false };
  state.playlistView = p; // LISTS.currentPlaylist 读它

  const menuOpen = state.menu === `playlist:${p.id}`;
  // PlaylistDetailView.swift:287-363 的 ⋯ 菜单顺序。省略项：更换封面（要本地图）、
  // 补齐缺失元数据（要本地歌曲表）、创建公开链接（要服务端分享域）—— Windows 侧不适用，写进方案文档。
  const items = [
    menuItem(`data-select-mode="currentPlaylist"`, '选择'),
    p.songs.length >= 2 ? menuItem('data-reorder="1"', '重新排序') : null,
    menuItem('data-queue-playlist="1"', '加入播放队列'),
    menuItem('data-next-playlist="1"', '接下来播放'),
    '-',
    p.isSystem ? null : menuItem('data-rename-playlist="1"', '重命名'),
    menuItem('data-pl-export="1"', '导出'),
    '-',
    p.isSystem ? null : menuItem('data-remove-playlist="1"', '删除歌单', { danger: true }),
  ].filter(Boolean);

  const menu = `<div class="menu"><button class="pill" data-pl-menu="${esc(p.id)}">${icon('ellipsis')}</button>${menuPop(
    menuOpen,
    items,
    'right'
  )}</div>`;

  return (
    navBar({ title: p.isSystem ? '我喜欢' : p.name }) +
    `<div class="page-body">
      <div class="detail-hero">
        ${coverSpan(p, 'detail-cover')}
        <div class="detail-name">${esc(p.name)}</div>
        <div class="detail-sub">${p.songs.length} 首歌曲${p.isSystem ? ' · 点心形即收藏' : ` · ${esc(fmtDate(p.updatedAt || p.createdAt))}`}</div>
      </div>
      <div class="detail-actions">
        <button class="pill prominent" data-play-playlist="${esc(p.id)}">${icon('play.fill')}<span>全部播放</span></button>
        <button class="pill" data-shuffle-playlist="${esc(p.id)}">${icon('shuffle')}<span>随机播放</span></button>
        ${menu}
      </div>
      ${
        p.songs.length
          ? songList(p.songs, 'currentPlaylist')
          : emptyState({ icon: 'music.note', title: '这首歌单还是空的', desc: '在搜索结果里点「添加到歌单」，或在服务器源列表里加入' })
      }
    </div>`
  );
}

function pageHistory() {
  const trailing = state.history.length ? `<button class="bar-btn ghost" data-clear-history="1">清空</button>` : '';
  return (
    navBar({ title: '最近播放', trailing }) +
    `<div class="page-body">${
      state.history.length
        ? songList(state.history, 'history')
        : emptyState({ icon: 'clock', title: '还没有播放记录', desc: '随便放一首歌，这里就会开始记录' })
    }</div>`
  );
}

function pageStats() {
  const wk = weekStats();
  const library = libraryTracks();
  const hours = wk.seconds >= 3600 ? `${(wk.seconds / 3600).toFixed(1)} 小时` : `${Math.round(wk.seconds / 60)} 分钟`;
  const row = (label, value) =>
    `<div class="srow"><span class="slabel">${esc(label)}</span><span class="svalue">${esc(value)}</span></div>`;
  const top = artistsOf()
    .slice(0, 5)
    .map(
      (a) => `<div class="srow"><span class="sico" style="background:var(--accent)">${icon('person.2')}</span>
        <span class="slabel">${esc(a.name)}<div class="ssub">${a.songs.length} 首在库</div></span><span class="chev">${icon('chevron.right')}</span></div>`
    )
    .join('<div class="sdiv"></div>');

  return (
    navBar({ title: '听歌统计' }) +
    `<div class="page-body">
      <div class="settings-group"><div class="group-title">本周（近 7 天）</div><div class="group-card">
        ${row('播放曲目', `${num(wk.count)} 首`)}
        ${row('收听时长', hours)}
        ${row('有听天数', `${wk.days} 天`)}
      </div></div>
      <div class="settings-group"><div class="group-title">本机资料库</div><div class="group-card">
        ${row('歌曲', `${num(library.length)} 首`)}
        ${row('我喜欢', `${num(state.favorites.length)} 首`)}
        ${row('歌单', `${num(visiblePlaylists().length)} 个`)}
        ${row('专辑', `${num(albumsOf().length)} 张`)}
        ${row('艺术家', `${num(artistsOf().length)} 位`)}
        ${row('播放记录', `${num(state.history.length)} 条`)}
      </div></div>
      <div class="settings-group"><div class="group-title">常听艺术家</div><div class="group-card">${
        top || `<div class="srow"><span class="slabel muted">还没有足够播放记录</span></div>`
      }</div></div>
      <p class="hint">听满 30 秒以上的歌会自动计入统计。继续听一会再回来看看。</p>
    </div>`
  );
}

/* ── 搜索（SearchView.swift）────────────────────────── */

function pageSearch() {
  const clearing = state.keyword ? `<button class="search-clear" data-clear-search="1">${icon('xmark')}</button>` : '';
  const bar = `<div class="searchbar"><div class="search-field">${icon('magnifyingglass')}
      <input id="search-input" type="search" placeholder="歌曲、艺术家、专辑、歌词" autocomplete="off" spellcheck="false" value="${esc(
        state.keyword
      )}" />${clearing}</div></div>`;

  const library = libraryTracks();
  if (!state.keyword) {
    const hist = state.searchHistory.length
      ? `<div class="section">
          <div class="section-head"><h3 style="font-size:var(--fs-footnote);color:var(--text-2);font-weight:600">最近搜索</h3>
            <button class="more" data-clear-search-history="1">清除全部</button></div>
          <div class="section-list">${state.searchHistory
            .map(
              (k) => `<div class="hist-row" data-history-search="${esc(k)}">${icon('clock')}<span>${esc(k)}</span>
                <button class="x" data-del-search-history="${esc(k)}">${icon('xmark')}</button></div>`
            )
            .join('')}</div>
        </div>`
      : '';
    const statsLine = library.length
      ? `<p class="hint">${num(library.length)} 首歌曲 · ${num(albumsOf().length)} 专辑 · ${num(artistsOf().length)} 艺术家</p>`
      : '';
    const wall = library.length
      ? ''
      : `<div class="empty-state">${icon('sparkles')}<div class="t">全网聚合搜索</div>
          <div class="d">输入歌曲名或歌手，即可直接搜索并畅听全网聚合音乐</div></div>`;
    return navBar({ title: '搜索', large: true }) + `<div class="page-body">${bar}${hist}${statsLine}${wall}</div>`;
  }

  const counts = {};
  for (const t of state.results) counts[t.platform] = (counts[t.platform] || 0) + 1;
  const chips = `<div class="chips">
      <button class="chip ${state.filter === 'all' ? 'active' : ''}" data-filter="all">全部 ${state.results.length}</button>
      ${Object.keys(counts)
        .map((p) => `<button class="chip ${state.filter === p ? 'active' : ''}" data-filter="${esc(p)}">${esc(PLATFORM_LABEL[p] || p)} ${counts[p]}</button>`)
        .join('')}
    </div>`;

  // 计数跟着筛选走：筛到「网易 23」还写「63 条」是自相矛盾的证据
  const rows = filteredResults();
  const groupTitle = state.filter === 'all' ? '全网聚合音乐' : `${PLATFORM_LABEL[state.filter] || state.filter} · 聚合音乐`;
  const head = `<div class="result-group">${icon('sparkles')}<span>${groupTitle}</span>
      <span class="path">${state.searching ? `${rows.length} 条 · 正在搜索全网聚合音源...` : `${rows.length} 条`}</span></div>`;

  return (
    navBar({
      title: '搜索',
      large: true,
      trailing: `<button class="bar-btn ghost" data-toggle-scope="1">${state.scope === 'aggregated' ? '全网聚合' : '本机范围'}</button>`,
    }) +
    `<div class="page-body">${bar}${chips}
      ${head}${
        rows.length
          ? songList(rows, 'results')
          : state.searching
          ? `<p class="hint">正在搜索全网聚合音源...（已探测 ${state.progress ? state.progress.done : 0}/${
              state.progress ? state.progress.total : '?'
            } 条线路）</p>`
          : emptyState({ icon: 'magnifyingglass', title: '未搜索到匹配歌曲', desc: '换个关键词，或在「聚合音乐源设置」里换线路' })
      }
      <p class="hint">${
        state.searching ? `已探测 ${state.progress ? state.progress.done : 0}/${state.progress ? state.progress.total : '?'} 条，先回来的已上屏` : ''
      }</p>
    </div>`
  );
}

/* ── 设置（SettingsView.swift:164-356 的节顺序）───────── */

function srow({ icon: iconName, color = 'var(--accent)', label, sub, value = '', page = '', attr = '', chev = true, html = '' }) {
  const inner = `<span class="sico" style="background:${color}">${icon(iconName)}</span>
    <span class="slabel">${esc(label)}${sub ? `<div class="ssub">${esc(sub)}</div>` : ''}</span>
    ${value ? `<span class="svalue">${esc(value)}</span>` : ''}${html}`;
  const act = page ? `data-page="${esc(page)}"` : attr;
  return `<div class="srow" ${act}>${inner}${chev && page ? `<span class="chev">${icon('chevron.right')}</span>` : ''}</div>`;
}

function group(title, rowsHtml) {
  return `<div class="settings-group"><div class="group-title">${esc(title)}</div><div class="group-card">${rowsHtml}</div></div>`;
}

const switchOn = (on) => `<span class="switch${on ? ' on' : ''}"><i></i></span>`;

function pageSettingsRoot() {
  const cfg = state.sync || {};
  const repeatLabel = state.repeat === 'one' ? '单曲循环' : state.repeat === 'all' ? '列表循环' : '顺序播放';
  return (
    navBar({ title: '设置', large: true }) +
    `<div class="page-body">
      ${group(
        '资料库',
        [
          srow({ icon: 'externaldrive', label: '音乐源管理', value: `${state.servers.length} 个源`, page: 'sources' }),
          srow({ icon: 'sparkles', color: '#af52de', label: '聚合音乐源设置', value: `已加载 ${state.sources.filter((s) => s.isEnabled).length}/${state.sources.length} 条线路`, page: 'lines' }),
          srow({ icon: 'plus', color: '#1f8a5b', label: '添加服务器源', sub: '道理鱼 DaoLiYu · 账号密码只存本机', page: 'editServer' }),
          srow({ icon: 'clock', color: '#5e6b87', label: '最近播放', value: `${state.history.length} 条`, page: 'history' }),
          srow({ icon: 'chart.bar', color: '#147d8a', label: '听歌统计', page: 'stats' }),
        ].join('')
      )}
      ${group(
        '播放',
        [
          srow({ icon: 'repeat', label: '播放模式', value: repeatLabel, attr: 'data-cycle-repeat="1"' }),
          srow({ icon: 'shuffle', label: '随机播放', attr: 'data-switch-shuffle="1"', html: switchOn(state.shuffle), chev: false }),
          srow({ icon: 'quote.bubble', label: '歌词面板自动跟随', attr: 'data-switch-lyrics-follow="1"', html: switchOn(state.settings.lyricsFollow !== false), chev: false }),
          // 需求 8：最小化后贴着任务栏挂一条单行歌词。关掉只是把这条窗口收走，
          // 播放器里的歌词浮层（上一行那个开关）不受影响。
          srow({
            icon: 'captions.bubble',
            label: '任务栏歌词',
            sub: '窗口最小化后，在任务栏上方单行显示当前这句',
            attr: 'data-switch-taskbar-lyric="1"',
            html: switchOn(state.settings.taskbarLyric !== false),
            chev: false,
          }),
          srow({
            icon: 'speaker.wave.2.fill',
            label: '音量',
            attr: 'data-volume-row="1"',
            html: `<input id="settings-volume" data-volume="1" type="range" min="0" max="1" step="0.01" value="${state.volume}" style="width:120px;accent-color:var(--accent)" />`,
            chev: false,
          }),
        ].join('')
      )}
      ${group(
        '外观',
        [
          srow({ icon: 'moon.zzz', label: '外观', value: state.theme.mode === 'automatic' ? '自动' : state.theme.mode === 'light' ? '浅色' : '深色', attr: 'data-cycle-appearance="1"' }),
          srow({ icon: 'tag', label: '主题色', value: state.theme.accent ? `#${state.theme.accent.replace('#', '').toUpperCase()}` : '默认', page: 'appearance' }),
          srow({ icon: 'wand.and.stars', label: '跟随封面氛围色', attr: 'data-switch-cover="1"', html: switchOn(state.theme.coverDriven), chev: false }),
        ].join('')
      )}
      ${group(
        '同步',
        [
          srow({
            icon: 'globe',
            color: '#0a84ff',
            label: '歌单同步',
            sub: '同步的是歌单结构，不是歌曲源',
            value: cfg.lastBackupAt ? fmtRelative(cfg.lastBackupAt) : cfg.serverURL ? '已配置' : '未配置',
            page: 'sync',
          }),
        ].join('')
      )}
      ${group(
        '关于',
        [
          srow({ icon: 'info.circle', color: '#5e6b87', label: '版本', value: `${state.meta ? state.meta.version : ''} (${state.meta ? state.meta.build : ''})`, page: 'about' }),
        ].join('')
      )}
      <p class="hint">关闭窗口时最小化到托盘 ${
        state.settings.minimizeToTray === false ? '关' : '开'
      } · 本地代理 ${esc(state.meta ? state.meta.proxyBaseUrl : '')}</p>
      <div class="actions-row"><button class="pill" data-switch-tray="1">托盘${state.settings.minimizeToTray === false ? '：关' : '：开'}</button></div>
    </div>`
  );
}

function pageAppearance() {
  const modes = [
    ['automatic', '自动'],
    ['light', '浅色'],
    ['dark', '深色'],
  ];
  const scales = [
    [0.85, '小'],
    [1, '中'],
    [1.2, '大'],
    [1.5, '特大'],
  ];
  return (
    navBar({ title: '外观' }) +
    `<div class="page-body">
      ${group(
        '外观模式',
        `<div class="srow">${modes
          .map(
            ([m, lab]) =>
              `<button class="chip ${state.theme.mode === m ? 'active' : ''}" data-appearance="${m}" style="flex:1">${lab}</button>`
          )
          .join('')}</div>`
      )}
      ${group(
        '主题色',
        `<div class="swatches">${ACCENT_SWATCHES.map(
          ([hex, name]) =>
            `<button class="swatch${state.theme.accent === `#${hex}` ? ' active' : ''}" style="background:#${hex}" data-set-accent="${hex}" title="${name}"></button>`
        ).join('')}</div>
         <div class="srow" data-reset-accent="1"><span class="sico" style="background:var(--cover-placeholder)">${icon('arrow.clockwise')}</span>
           <span class="slabel">使用默认主题色</span><span class="svalue">${isDarkNow() ? '深色 #54C79E' : '浅色 #147D8A'}</span></div>`
      )}
      ${group(
        '播放器',
        [
          srow({ icon: 'wand.and.stars', label: '跟随封面氛围色', attr: 'data-switch-cover="1"', html: switchOn(state.theme.coverDriven), chev: false }),
          srow({ icon: 'info.circle', label: '跨域封面读不到像素时自动退回主题色', chev: false, html: '<span class="svalue">默认开启</span>' }),
        ].join('')
      )}
      ${group(
        '歌词字号',
        `<div class="chips" style="padding:6px 14px 10px">${scales
          .map(
            ([s, lab]) => `<button class="chip ${Number(state.theme.lyricScale) === s ? 'active' : ''}" data-lyric-scale="${s}">${lab}</button>`
          )
          .join('')}</div>`
      )}
    </div>`
  );
}

/* ── 音乐源（SourcesView.swift:589-940）──────────────── */

function pageSources() {
  const trailing = `<div class="menu"><button class="bar-btn" data-page="editServer" title="添加音乐源">${icon('plus')}</button></div>`;
  const rows = state.servers
    .map((s) => {
      const menuOpen = state.menu === `source:${s.id}`;
      const items = [
        menuItem(`data-edit-server="${esc(s.id)}"`, '编辑'),
        menuItem(`data-test-server-row="${esc(s.id)}"`, '音乐源体检'),
        menuItem(`data-server-health="${esc(s.id)}"`, '深度扫描（重新载入整库）'),
        '-',
        menuItem(`data-remove-server="${esc(s.id)}"`, '删除', { danger: true }),
      ];
      return `<div class="srow" data-page="server:${esc(s.id)}" style="align-items:flex-start">
          <span class="sico photo" style="width:38px;height:38px;border-radius:9px;--ring:var(--accent)">${icon(s.useSSL ? 'globe' : 'wifi')}</span>
          <span class="slabel">${esc(s.name || s.host)}
            <div class="ssub">道理鱼 DaoLiYu · ${esc(s.username || '')}</div>
            <div class="route-bar">${icon(s.useSSL ? 'globe' : 'wifi')}<code>${esc(`${s.useSSL ? 'https' : 'http'}://${s.host}${s.port ? `:${s.port}` : ''}${s.basePath || ''}`)}</code></div>
          </span>
          <span class="capsule">${s.id === state.serverView.sourceID && state.serverView.total ? num(state.serverView.total) : '整库'} 首</span>
          <div class="menu"><button class="song-more" data-menu="source:${esc(s.id)}">${icon('ellipsis')}</button>${menuPop(menuOpen, items, 'right')}</div>
        </div>`;
    })
    .join('<div class="sdiv"></div>');

  const cloudCfg = (state.cloud && state.cloud.config) || {};
  const cloud = loadSummary(state.sources);
  const agg = `<div class="srow" data-page="lines" style="align-items:flex-start">
      <span class="sico photo" style="width:38px;height:38px;border-radius:9px;--ring:var(--accent)">${icon('sparkles')}</span>
      <span class="slabel">聚合音乐源<div class="ssub">云端清单下发 · 无需账号</div>
        <div class="route-bar">${icon('cloud')}<span>清单</span><code>${esc(cloudCfg.manifestURL || '未设置')}</code></div></span>
      <span class="capsule">已加载 ${cloud.loaded.length}/${state.sources.length} 条</span><span class="chev">${icon('chevron.right')}</span>
    </div>`;

  return (
    navBar({ title: '音乐源', trailing }) +
    `<div class="page-body">
      ${group('本机源', `${agg}${state.servers.length ? `<div class="sdiv"></div>${rows}` : ''}`)}
      ${
        state.servers.length
          ? ''
          : `<p class="hint">没有服务器型音乐源。添加 NAS / 自建服务器（道理鱼）后，它的整库会出现在资料库与搜索范围里。</p>
             <div class="actions-row"><button class="pill prominent" data-page="editServer">${icon('plus')}<span>添加音乐源</span></button></div>`
      }
    </div>`
  );
}

/* 「检测全部可用」的结论怎么上色（需求 2）。
   三类必须分开画，否则"我们没测出来"看起来像"它坏了"：
     ok → 可播；盲区（检不出结果）→ 未检出；其余 → 不可播 + 建议删除。 */
const VERDICT_BLIND = ['no_sample', 'runner_missing', 'unsupported', 'unchecked', 'error'];
function verdictOf(s) {
  const local = state.cloud.verdicts[s.id];
  if (local && local.status) return local;
  // 洛雪 js 音源本机跑不了脚本，它的结论只能是服务端体检下发的这一份（origin 如实标 server）。
  const c = s.check || {};
  return {
    status: c.status || 'unchecked',
    detail: c.detail || '服务端还没体检过这条',
    bytes: Number(c.bytes) || 0,
    origin: 'server',
  };
}
function verdictMark(s) {
  const v = verdictOf(s);
  if (v.status === 'ok') return { tone: 'ok', text: '可播' };
  if (VERDICT_BLIND.indexOf(v.status) >= 0) return { tone: 'blind', text: '未检出' };
  return { tone: 'bad', text: '不可播' };
}

/* 需求 1 + 3 在界面上的说法：线路表里只有「服务端确认可播」的那几条真的进了播放路径，
   其余的行照样画出来，但它们只负责回答"云端 50 条，本机为什么只加载了 14 条"。
   `loaded` 由主进程的 isLoadable 落一次（真相只有一份，渲染层不再自己判），
   这里只负责把"为什么没加载"归成一个能读出来的原因。 */
function isLoaded(s) {
  return s && s.loaded !== false;
}
function loadReason(s) {
  if (isLoaded(s)) return null;
  if (s.enabledOnServer === false) return '服务端已停用';
  if (s.suggestDelete) return '已判不可播';
  if (verdictMark(s).tone === 'blind') return '未检出 · 无法确认可播';
  return '不可播';
}
function loadSummary(sources) {
  const loaded = sources.filter(isLoaded);
  const skipped = sources.filter((s) => !isLoaded(s));
  const reasons = {};
  skipped.forEach((s) => {
    const k = loadReason(s);
    reasons[k] = (reasons[k] || 0) + 1;
  });
  const reasonText = Object.keys(reasons)
    .map((k) => `${k} ${reasons[k]} 条`)
    .join(' · ');
  return { loaded, skipped, reasonText: reasonText || '云端下发的每一条都能出声' };
}

function lineRow(s) {
  const mark = verdictMark(s);
  const v = verdictOf(s);
  const toneColor = mark.tone === 'ok' ? '#1f8a5b' : mark.tone === 'bad' ? '#c0392b' : '#5e6b87';
  const viaGateway = s.protocolType === 'lxjs';
  const suggest = mark.tone === 'bad' || Boolean(s.suggestDelete);
  // 「未加载」是需求 1/3 的落点：能出声的才进播放路径，其它只在这儿给一个说法，不参与搜索/取流。
  const notLoaded = s.loaded === false;
  return `<div class="srow" style="align-items:flex-start">
      <span class="sico photo" style="--ring:${toneColor}">${icon(mark.tone === 'ok' ? 'play.circle' : mark.tone === 'bad' ? 'exclamationmark.triangle' : 'questionmark.circle')}</span>
      <span class="slabel">${esc(s.name)}
        <div class="ssub">${esc(PLATFORM_LABEL[s.platform] || s.platform)} · ${esc(s.protocolType)} · 优先级 ${s.priority}${
          viaGateway ? ' · 服务端 runner 执行' : ''
        }</div>
        <div class="route-bar">${icon(viaGateway ? 'cloud' : 'globe')}<code>${esc(viaGateway ? '音乐网关 /api/music-gateway' : s.baseURL)}</code></div>
        <div class="ssub" style="margin-top:4px">${esc(String(v.detail || '').slice(0, 160))}${
          v.bytes ? ` · ${num(v.bytes)}B` : ''
        } · ${v.origin === 'local' ? '本机实测' : '服务端结论'}</div>
      </span>
      ${notLoaded ? '<span class="capsule" style="background:rgba(94,107,135,.18);color:#9fb0d6">未加载</span>' : ''}
      ${suggest ? '<span class="capsule" style="background:rgba(192,57,43,.16);color:#e07b6f">建议删除</span>' : ''}
      ${notLoaded && v.origin === 'local' && v.status === 'ok' ? '<span class="capsule">本机可播 · 待服务端确认</span>' : ''}
      <span class="capsule">${mark.text}</span>
    </div>`;
}

function pageLines() {
  const cfg = (state.cloud && state.cloud.config) || {};
  const st = state.cloud;
  const counts = state.sources.reduce(
    (acc, s) => {
      acc[verdictMark(s).tone] += 1;
      return acc;
    },
    { ok: 0, bad: 0, blind: 0 }
  );
  const byTone = (tone) => state.sources.filter((s) => verdictMark(s).tone === tone);
  const load = loadSummary(state.sources);
  const sections = [
    ['可播', byTone('ok')],
    ['未检出（不停用，也不判死）', byTone('blind')],
    ['不可播 · 建议删除', byTone('bad')],
  ]
    .filter(([, list]) => list.length)
    .map(([title, list]) => group(title, list.map(lineRow).join('<div class="sdiv"></div>')))
    .join('');

  return (
    navBar({
      title: '聚合音乐源',
      trailing: `<button class="bar-btn" data-cloud-refresh="1" title="刷新云端清单">${icon('arrow.clockwise')}</button>`,
    }) +
    `<div class="page-body">
      ${st.checking ? '<div class="hint">正在逐条真取音频字节…（搜索 → 解析直链 → Range 取 64KB 看魔数）</div>' : ''}
      ${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}
      ${st.result ? `<div class="ok">${esc(st.result)}</div>` : ''}
      <div class="actions-row">
        <button class="pill prominent" data-sources-check-all="1">${icon('checkmark.circle')}<span>检测全部可用</span></button>
        <button class="pill" data-cloud-refresh="1">${icon('arrow.clockwise')}<span>刷新云端清单</span></button>
      </div>
      ${group(
        '云端清单',
        `<div class="srow"><span class="sico photo" style="--ring:var(--accent)">${icon('link')}</span>
            <span class="slabel">音乐源清单 URL<div class="route-bar"><code>${esc(cfg.manifestURL || '未设置')}</code></div>
              <div class="ssub">${
                cfg.revision >= 0 ? `revision ${cfg.revision} · ` : '尚未拉取 · '
              }${cfg.fetchedAt ? `更新于 ${esc(fmtRelative(cfg.fetchedAt))}` : '从未更新'}</div></span>
            <span class="capsule">${state.sources.length} 条</span></div>
          <div class="sdiv"></div>
          ${srow({ icon: 'checkmark.circle', color: '#1f8a5b', label: '可播', value: `${counts.ok} 条`, chev: false })}
          <div class="sdiv"></div>
          ${srow({ icon: 'questionmark.circle', color: '#5e6b87', label: '未检出', value: `${counts.blind} 条`, chev: false })}
          <div class="sdiv"></div>
          ${srow({ icon: 'exclamationmark.triangle', color: '#c0392b', label: '建议删除', value: `${counts.bad} 条`, chev: false })}`
      )}
      ${
        state.sources.length
          ? group(
              '本机加载',
              `${srow({
                icon: 'play.circle',
                color: 'var(--accent)',
                label: '已加载 · 参与搜索与播放',
                value: `${load.loaded.length} 条`,
                sub: '只有服务端确认可播的线路才进播放路径（需求 1/3）',
                chev: false,
              })}
          <div class="sdiv"></div>
          ${srow({
            icon: 'moon.zzz',
            color: '#5e6b87',
            label: '云端有 · 本机不加载',
            value: `${load.skipped.length} 条`,
            sub: load.reasonText,
            chev: false,
          })}`
            )
          : ''
      }
      ${
        state.sources.length && load.loaded.length === 0
          ? '<div class="err">本机的播放路径里一条线路都没有 —— 云端清单里还没有「可播」的源。搜索会成功返回空、播放会提示无可用线路。请在 CF 后台跑一次「检测全部可用」，或用样本池复测。</div>'
          : ''
      }
      ${sections || '<p class="hint">清单里还没有线路。点"刷新云端清单"从服务端拉一次。</p>'}
      <p class="hint">音乐源的增删改在 CF 后台（<code>cf-sync-server</code>）完成，本机只读 + 刷新 —— 这就是「客户端只保存这个 URL」的意思。
        洛雪 js 音源的脚本跑在服务端的 runner Worker 里，搜索 / 取流 / 歌词都经音乐网关，本机不落地脚本。</p>
      <p class="hint">带「未加载」标记的源只在这一列表里给一个说法，不参与搜索、不取流：不可播的播了也是白播，未检出的是「我们没测成」而不是「它坏了」
        —— 可在 CF 后台「体检样本池」给它所在平台补一个真实歌曲 id 再复测，一旦测出声，清单会把它送进本机的播放路径。</p>
    </div>`
  );
}

function pageServerForm() {
  const editing = state.formServerId ? state.servers.find((s) => s.id === state.formServerId) : null;
  const v = (key, fallback = '') => (editing ? editing[key] ?? fallback : fallback);
  const field = (label, html) => `<label class="field"><span>${label}</span>${html}</label>`;
  return (
    navBar({ title: editing ? '编辑音乐源' : '添加音乐源' }) +
    `<div class="page-body">
      ${state.formError ? `<div class="err">${esc(state.formError)}</div>` : ''}
      ${state.formResult ? `<div class="ok">${esc(state.formResult)}</div>` : ''}
      <form class="form" id="server-form">
        ${field('类型', '<select name="kind"><option value="daoliyu">道理鱼 DaoLiYu</option></select>')}
        ${field('名称', `<input name="name" value="${esc(v('name', '我的道理鱼'))}">`)}
        ${field('地址 host', `<input name="host" value="${esc(v('host'))}" placeholder="例 music.example.com 或 192.168.1.20" required>`)}
        ${field('端口', `<input name="port" value="${esc(v('port') || '')}" placeholder="留空按 http/https 默认">`)}
        ${field('使用 https', `<select name="useSSL"><option value="0"${v('useSSL') ? '' : ' selected'}>否</option><option value="1"${
          v('useSSL') ? ' selected' : ''
        }>是</option></select>`)}
        ${field('子路径 basePath', `<input name="basePath" value="${esc(v('basePath'))}" placeholder="例 /music（留空表示根路径）">`)}
        ${field('用户名', `<input name="username" value="${esc(v('username'))}" required>`)}
        ${field('密码', `<input name="password" type="password" placeholder="${editing && v('hasPassword') ? '已保存，留空表示不修改' : ''}">`)}
        ${field('自签名证书', `<select name="insecureTLS"><option value="0"${v('insecureTLS') ? '' : ' selected'}>校验（默认）</option><option value="1"${
          v('insecureTLS') ? ' selected' : ''
        }>忽略（自签名 https 才需要）</option></select>`)}
        <input type="hidden" name="id" value="${esc(v('id') || '')}">
        <div class="actions-row">
          <button class="pill" type="button" data-test-server="1">${icon('speedometer')}<span>测试连接</span></button>
          <button class="pill prominent" type="submit">保存</button>
          ${editing ? `<button class="pill" type="button" data-remove-server="${esc(editing.id)}">删除</button>` : ''}
        </div>
      </form>
      <p class="hint">地址、账号、密码只保存在本机（密码走 Windows DPAPI / safeStorage 加密），不会发到任何聊天或第三方。iPhone 版同一个道理。</p>
    </div>`
  );
}

function pageServerBrowse(id) {
  const server = state.servers.find((s) => s.id === id);
  if (!server) return navBar({ title: '音乐源' }) + `<div class="page-body"><div class="err">找不到该源，请重新添加。</div></div>`;
  const view = state.serverView;
  const filtered = view.filter
    ? view.items.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(view.filter.toLowerCase()))
    : view.items;

  return (
    navBar({ title: server.name || server.host, trailing: `<button class="bar-btn ghost" data-page="editServer:${esc(server.id)}">编辑</button>` }) +
    `<div class="page-body">
      <div class="searchbar"><div class="search-field">${icon('magnifyingglass')}
        <input id="server-filter" placeholder="在已载入的曲目里过滤" value="${esc(view.filter)}">${
        view.filter ? `<button class="search-clear" data-clear-server-filter="1">${icon('xmark')}</button>` : ''
      }</div></div>
      <div class="actions-row">
        <button class="pill" data-load-more="1" ${view.loading ? 'disabled' : ''}>${view.loading ? '载入中…' : '继续载入下一页'}</button>
        <button class="pill prominent" data-play-all="1">${icon('play.fill')}<span>播放已载入全部</span></button>
        <button class="pill" data-select-mode="serverView">${icon('checkmark.circle')}<span>选择</span></button>
      </div>
      <p class="hint">${view.total ? `服务器共 ${num(view.total)} 首` : '正在读取曲目列表'} · 已载入 ${num(view.items.length)} 首
        · 整库分页由服务端 skip/take（与 iPhone 一致）</p>
      ${view.error ? `<div class="err">${esc(view.error)}</div>` : ''}
      ${songList(filtered, 'serverView', `<p class="hint">${view.loading ? '正在载入…' : '还没有内容，点「继续载入下一页」。'}</p>`)}
    </div>`
  );
}

/* ── 歌单同步（PlaylistSyncSettingsView.swift，文案 1:1）─ */

function pageSync() {
  const cfg = state.sync || {};
  const devices = state.syncDevices || [];
  const copied = state.idCopied ? '✓' : '';
  return (
    navBar({ title: '歌单同步' }) +
    `<div class="page-body">
      ${state.syncBusy ? '<div class="hint">正在与云端通信…</div>' : ''}
      ${state.syncError ? `<div class="err">${esc(state.syncError)}</div>` : ''}
      ${state.syncResult ? `<div class="ok">${esc(state.syncResult)}</div>` : ''}
      ${group(
        '同步服务器',
        [
          srow({ icon: 'globe', label: '服务器端点 (API URL)', value: cfg.serverURL || '未设置', attr: 'data-edit-server-url="1"' }),
          srow({ icon: 'plus', color: '#1f8a5b', label: cfg.serverURL ? '修改服务器地址' : '设置同步服务器', attr: 'data-edit-server-url="1"', chev: false, html: '<span class="svalue">›</span>' }),
        ].join('')
      )}
      <p class="hint">服务部署在 Cloudflare Pages + D1（<code>primuse-sync-server</code>），与 iPhone 版共用同一个端点；不需要你重新部署。</p>
      ${group(
        '设备识别',
        [
          srow({ icon: 'person.2', label: '设备名称', value: cfg.deviceName || '未命名', attr: 'data-edit-device-name="1"' }),
          `<div class="srow"><span class="sico" style="background:#5e6b87">${icon('info.circle')}</span>
            <span class="slabel">本机唯一标识</span>
            <span class="svalue" style="font-family:'Cascadia Mono',Consolas,monospace">${esc(cfg.deviceId || '尚未生成')}</span>
            <button class="bar-btn" data-copy-id="1" title="复制">${copied ? icon('checkmark') : icon('square.and.arrow.up')}</button></div>`,
        ].join('')
      )}
      ${group(
        '音乐源清单（云端管理）',
        (() => {
          const c = state.cloud || {};
          const cfg = c.config || {};
          const s = c.settings || {};
          const fromLabel = { device: '按本机标识', global: '全局默认', default: '内置默认' }[s.homeTitleFrom] || '内置默认';
          return `<div class="srow"><span class="sico" style="background:#7a4fd0">${icon('cloud')}</span>
              <span class="slabel">音乐源清单 URL<div class="route-bar"><code>${esc(cfg.manifestURL || '未设置')}</code></div>
                <div class="ssub">${
                  cfg.revision >= 0 ? `revision ${cfg.revision} · ` : '尚未拉取 · '
                }${cfg.fetchedAt ? `更新于 ${esc(fmtRelative(cfg.fetchedAt))}` : '从未更新'}${
                  cfg.error ? ` · ${esc(cfg.error)}` : ''
                }</div></span>
              <button class="bar-btn" data-edit-cloud-url="1" title="修改清单地址">${icon('pencil.circle')}</button></div>
            <div class="sdiv"></div>
            <div class="srow"><span class="sico" style="background:var(--cover-placeholder)">${icon('textformat')}</span>
              <span class="slabel">首页标题（服务端设置）<div class="ssub">${esc(fromLabel)} · 本机唯一标识 ${esc(String(cfg.deviceId || '').slice(0, 12))}…</div></span>
              <span class="svalue">${esc(homeTitle())}</span></div>
            <div class="sdiv"></div>
            <div class="srow" data-cloud-refresh="1"><span class="sico" style="background:#1f8a5b">${icon('arrow.clockwise')}</span>
              <span class="slabel">立即刷新音乐源</span><span class="chev">${icon('chevron.right')}</span></div>`;
        })()
      )}
      ${group(
        '歌单数据备份与恢复',
        `<div class="srow" data-sync-backup="1"><span class="sico" style="background:var(--accent)">${icon('square.and.arrow.up')}</span>
            <span class="slabel">立即备份到云端（上传歌单）</span><span class="chev">${icon('chevron.right')}</span></div>
          <div class="sdiv"></div>
          <div class="srow" data-sync-restore="1"><span class="sico" style="background:#1f8a5b">${icon('arrow.clockwise')}</span>
            <span class="slabel">从云端恢复歌单（拉取同步）</span><span class="chev">${icon('chevron.right')}</span></div>
          <div class="sdiv"></div>
          <div class="srow"><span class="sico" style="background:#5e6b87">${icon('clock')}</span>
            <span class="slabel">最近备份时间</span><span class="svalue">${esc(cfg.lastBackupAt ? fmtDateTime(cfg.lastBackupAt) : '从未备份')}</span></div>`
      )}
      <p class="hint">备份会将当前设备的所有自建歌单及曲目上传至云端；恢复会从云端拉取已保存的歌单并合并到本地。<br>
        本机用自己的机器码备份，<b>不会</b>覆盖 iPhone 那台设备的数据。同步的是歌单结构，不是歌曲源。</p>
      <div class="actions-row"><button class="pill" data-sync-devices="1">${icon('person.2')}<span>查看云端设备列表 / 跨设备导入</span></button></div>
      ${
        devices.length
          ? group(
              '云端设备',
              devices
                .map(
                  (d) => `<div class="srow" ${d.device_id === cfg.deviceId ? '' : `data-sync-import="${esc(d.device_id)}"`}>
                    <span class="sico" style="background:${d.device_id === cfg.deviceId ? 'var(--cover-placeholder)' : '#0a84ff'}">${icon('moon.zzz')}</span>
                    <span class="slabel">${esc(d.device_name || d.device_id)}
                      <div class="ssub">${esc(d.platform || '')} · ${d.playlist_count} 个歌单 · ${d.song_count} 首 · ${esc(fmtRelative(d.updated_at))}</div></span>
                    ${d.device_id === cfg.deviceId ? '<span class="capsule">本机</span>' : `<span class="svalue">下载它的歌单 ›</span>`}
                  </div>`
                )
                .join('<div class="sdiv"></div>')
            )
          : ''
      }
    </div>`
  );
}

function pageAbout() {
  const m = state.meta || {};
  return (
    navBar({ title: '关于' }) +
    `<div class="page-body">
      <div class="brand-head">
        <img class="brand-logo" src="icon.png" alt="Free-Narci" width="72" height="72" />
        <div class="brand-name">Primuse</div>
        <div class="brand-sub">桌面版 · 标识 Free-Narci</div>
      </div>
      ${group(
        '版本',
        [
          srow({ icon: 'info.circle', color: '#5e6b87', label: '版本', value: m.version || '' , chev: false }),
          srow({ icon: 'info.circle', color: '#5e6b87', label: '构建', value: m.build ? `#${m.build}` : '', chev: false }),
          srow({ icon: 'arrow.clockwise', color: '#1f8a5b', label: '检查更新', attr: 'data-open-releases="1"', chev: false, html: '<span class="svalue">GitHub Releases ›</span>' }),
          srow({ icon: 'globe', color: '#0a84ff', label: 'GitHub 仓库', attr: 'data-open-repo="1"', chev: false, html: '<span class="svalue">›</span>' }),
          srow({ icon: 'exclamationmark.triangle', color: '#e8453c', label: '功能建议与问题反馈', attr: 'data-open-issues="1"', chev: false, html: '<span class="svalue">›</span>' }),
        ].join('')
      )}
      <p class="hint">这个包是未签名的。首次运行 Windows 会弹 SmartScreen「未知发布者」——点「更多信息 → 仍要运行」；Mac 端对应的是 Gatekeeper 右键打开。</p>
      ${group(
        '与 iPhone 版一致的地方',
        `<div class="srow" style="align-items:flex-start"><span class="slabel" style="white-space:normal">
          单列 + 底部四 tab 的外壳、tab 上方胶囊迷你条、全屏播放浮层（不是页面）；
          9 条聚合线路与优先级、四类协议（meting / hyw / nxinxz / openApi）的请求字段、道理鱼的登录与取流方式、无账号体系；
          歌单（新建 / 删除 / 重命名 / 加入 / 移除 / 重新排序）、「我喜欢」系统歌单固定 id、云端歌单备份与恢复的接口契约、
          播放模式（随机 / 顺序 / 列表循环 / 单曲循环）。
        </span></div>`
      )}
      ${group(
        '这一端没有的',
        `<div class="srow" style="align-items:flex-start"><span class="slabel" style="white-space:normal">
          Apple Music / iCloud / CloudKit 同步、AirPlay 与 DLNA 投屏、Apple TV、Siri 与快捷指令、应用图标切换、家庭共享、
          本地文件与 NAS 扫描、CUE、元数据刮削、AI 智能歌单 —— 要么依赖 Apple 体系，要么依赖本地音频文件，Windows 版不适用。
        </span></div>`
      )}
    </div>`
  );
}

/* ── 渲染（外壳 + 屏）─────────────────── */

const TAB_ICON = { home: 'house.fill', library: 'books.vertical', search: 'magnifyingglass', settings: 'gearshape' };

function menuButtons(items) {
  return items
    .map((it) => {
      if (it === '-') return '<div class="sep"></div>';
      if (it.head) return `<div class="head">${esc(it.head)}</div>`;
      return `<button ${it.attr}${it.danger ? ' class="danger"' : ''}>${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${
        it.mark ? `<span class="mark">${esc(it.mark)}</span>` : ''
      }</button>`;
    })
    .join('');
}

function renderScreen() {
  const { name, arg } = parsePage(pageRef());
  if (name === 'root') {
    if (state.tab === 'home') return pageHome();
    if (state.tab === 'library') return pageLibrary();
    if (state.tab === 'search') return pageSearch();
    return pageSettingsRoot();
  }
  switch (name) {
    case 'songs': return pageSongs();
    case 'albums': return pageAlbums();
    case 'artists': return pageArtists();
    case 'album': return pageDetail('album', arg);
    case 'artist': return pageDetail('artist', arg);
    case 'playlists': return pagePlaylists();
    case 'playlist': return pagePlaylist(arg);
    case 'liked': return pagePlaylist(LIKED_PLAYLIST_ID);
    case 'history': return pageHistory();
    case 'stats': return pageStats();
    case 'sources': return pageSources();
    case 'lines': return pageLines();
    case 'server': return pageServerBrowse(arg);
    case 'editServer': return pageServerForm();
    case 'sync': return pageSync();
    case 'appearance': return pageAppearance();
    case 'about': return pageAbout();
    default: return pageHome();
  }
}

const scrollMem = new Map();
let scrollKey = null;

/* ── 中文输入法（IME）组合期保护 ──────────────────────────
 *
 * 症状（用户 2026-10-14 报）：搜索框切到中文输入法后打不出字，拼音"一闪而过"。
 *
 * 病根不在输入法，在重绘：Chromium 在组合期（还没上屏）照样为每个拼音字母发
 * `input`（`event.isComposing === true`），220ms 防抖到点 → `runSearch()` →
 * `render()` → `screen.innerHTML = …` 把 `<input>` 节点整个换掉。节点一被销毁，
 * 输入法编辑器（Windows TSF）与它的连接就断了，正在拼的那串拼音被直接丢弃。
 * 英文不会露馅：`value` 绑的是 `state.keyword`，重建后看起来一模一样；中文丢的是
 * "还没上屏的组合串"，重建救不回来 —— 于是用户看到的是"打了字，闪一下没了"。
 *
 * 上面 `render()` 里那段"记住焦点和光标位置再恢复"的补丁只治了英文，治不了这个：
 * 焦点能恢复，组合串恢复不了。真正的修法是**组合期间不许整屏重绘**，
 * compositionend 之后补一次。
 *
 * 兜底：window blur / 输入框失焦 / 组合期后收到普通按键，都要清标志位。
 * 标志位一旦卡住，整个界面就再也不刷新了 —— 那比这个 bug 严重得多。
 */
let imeComposing = false;
let renderQueuedWhileComposing = false;

function imeBegin() {
  imeComposing = true;
}

function imeEnd() {
  if (!imeComposing) return;
  imeComposing = false;
  if (renderQueuedWhileComposing) {
    renderQueuedWhileComposing = false;
    render();
  }
}

function render() {
  if (imeComposing) {
    renderQueuedWhileComposing = true;
    return;
  }
  const screen = $('screen');
  if (scrollKey) scrollMem.set(scrollKey, screen.scrollTop);

  // 重绘会把正在输入的框弄丢（搜索防抖每 220ms 一次），所以先记下焦点与光标位置
  const active = document.activeElement;
  const keepId = active && active.id && document.body.contains(active) ? active.id : null;
  let caret = null;
  if (keepId && ['search', 'text', 'password', 'url', 'number', ''].includes(active.type)) {
    try {
      caret = active.selectionStart;
    } catch {
      caret = null;
    }
  }

  screen.innerHTML = renderScreen();
  scrollKey = `${state.tab}|${pageRef()}`;
  screen.scrollTop = scrollMem.get(scrollKey) || 0;

  if (keepId) {
    const el = $(keepId);
    if (el && el.focus) {
      el.focus({ preventScroll: true });
      if (caret !== null) {
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          /* number/search 之外的类型没有 selectionRange，忽略 */
        }
      }
    }
  }
  syncNavbarStuck();
  renderTabbar();
  renderMini();
  renderBatch();
  renderPlayer();
  // 弹层里正在输入时（新建/重命名歌单、同步地址）不要跟着屏幕重绘，否则敲进去的字会被冲掉
  if ($('sheet').hidden || $('sheet-body').dataset.kind !== (state.sheet && state.sheet.kind)) renderSheet();
}

function syncNavbarStuck() {
  const nav = $('screen').querySelector('.navbar');
  if (nav) nav.classList.toggle('stuck', $('screen').scrollTop > 6);
}

function renderTabbar() {
  for (const tab of document.querySelectorAll('#tabbar .tab')) {
    tab.classList.toggle('active', tab.dataset.tab === state.tab);
    const ico = tab.querySelector('.ico');
    if (ico && ico.dataset.done !== '1') {
      ico.innerHTML = icon(TAB_ICON[tab.dataset.tab] || 'music.note');
      ico.dataset.done = '1';
    }
  }
}

/** MiniPlayerView.swift:47-92 —— 胶囊：封面 30 + 双行 + 播放/下一曲；批量选择态或浮层展开时隐藏 */
function renderMini() {
  const wrap = $('mini-wrap');
  const track = currentTrack();
  const show = Boolean(track) && !state.playerOpen && !state.selection;
  wrap.hidden = !show;
  if (!show) return;
  const cover = coverOf(track);
  const mini = $('mini-cover');
  mini.style.backgroundImage = cover ? `url('${esc(cover)}')` : '';
  // 没有封面时不再留一块灰：清空图片让 CSS 的占位渐变透出来，色相按歌名定（换歌才变色，刷新不变）
  if (cover) mini.style.removeProperty('--ph-hue');
  else mini.style.setProperty('--ph-hue', hueOf(`track:${track.title}|${track.artist}`));
  $('mini-title').textContent = track.title || '';
  $('mini-artist').textContent = track.artist || '';
  $('mini-play').innerHTML = icon(state.playing ? 'pause.fill' : 'play.fill');
  $('mini-play').classList.toggle('on', state.playing);
  $('mini-next').innerHTML = icon('forward.fill');
}

/** SongBatchActionBar.swift：「已选择 N 首」+ 全选 / 加入歌单 / 下一首播放 / 加入队列 / 移除 / 取消 */
function renderBatch() {
  const bar = $('batch-bar');
  if (!state.selection) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('batch-count').textContent = `已选择 ${state.selection.keys.size} 首`;
  const remove = bar.querySelector('[data-batch="remove"]');
  if (remove) remove.hidden = state.selection.list !== 'currentPlaylist';
}

/* ── 全屏播放浮层（NowPlayingView.swift:2100-2350，覆盖层不是路由）── */

function renderPlayer() {
  const p = $('player');
  p.hidden = !state.playerOpen;
  document.body.classList.toggle('player-open', state.playerOpen);
  if (!state.playerOpen) return;

  const track = currentTrack();
  const cover = track ? coverOf(track) : null;
  const art = $('art');
  art.style.backgroundImage = cover ? `url('${esc(cover)}')` : '';
  if (cover) art.style.removeProperty('--ph-hue');
  else art.style.setProperty('--ph-hue', hueOf(`nowplaying:${track && track.title}|${track && track.artist}`));
  art.innerHTML = cover ? '' : '<span style="font-size:46px;opacity:.62;color:#fff">♪</span>';

  $('np-title').textContent = track ? track.title || '' : '选一首歌开始播放';
  $('np-artist').textContent = track
    ? `${track.artist || '未知艺术家'}${track.album ? ` · ${track.album}` : ''}`
    : '在资料库或搜索里点一行即可播放';

  const fav = $('np-fav');
  fav.innerHTML = icon(track && isFavorite(track) ? 'heart.fill' : 'heart');
  fav.classList.toggle('on', Boolean(track && isFavorite(track)));
  document.querySelector('[data-np-menu]').innerHTML = icon('ellipsis');

  const err = $('player-err');
  err.hidden = !state.playerError;
  if (state.playerError) err.textContent = state.playerError;

  $('c-shuffle').innerHTML = icon('shuffle');
  $('c-shuffle').classList.toggle('on', Boolean(state.shuffle));
  $('c-prev').innerHTML = icon('backward.fill');
  $('c-play').innerHTML = icon(state.playing ? 'pause.circle.fill' : 'play.circle.fill');
  $('c-next').innerHTML = icon('forward.fill');
  // MacBottomBar 同款规则：off 与 all 都用 repeat 图标（点亮态 != off），one 用 repeat.1
  $('c-repeat').innerHTML = icon(state.repeat === 'one' ? 'repeat.1' : 'repeat');
  $('c-repeat').classList.toggle('on', state.repeat !== 'off');
  $('c-repeat').title = state.repeat === 'one' ? '单曲循环' : state.repeat === 'all' ? '列表循环' : '顺序播放';
  $('c-volume').value = String(state.volume);

  $('s-lyrics').innerHTML = icon('quote.bubble');
  $('s-device').innerHTML = icon('network.browser');
  $('s-queue').innerHTML = icon('list.bullet');
  $('s-lyrics').classList.toggle('on', state.playerView === 'lyrics');
  document.querySelector('.vol-ico.lo').innerHTML = icon('speaker.fill');
  document.querySelector('.vol-ico.hi').innerHTML = icon('speaker.wave.2.fill');

  const format = $('np-format');
  if (!track) format.textContent = '';
  else {
    const from = track.kind === 'server' ? track.sourceName || '服务器源' : PLATFORM_LABEL[track.platform] || track.platform;
    const via = state.lastResolve && state.lastResolve.kind === 'server' ? '服务器直链 · 经本地代理' : '聚合线路 · 经本地代理';
    format.textContent = `${from} · ${via}${track.duration ? ` · ${fmtTime(track.duration)}` : ''}`;
  }

  $('np-menu').hidden = !state.npMenu;
  if (state.npMenu) {
    $('np-menu').innerHTML = menuButtons([
      { head: track ? track.title : '未在播放' },
      menuItem('data-np-act="add"', '添加到歌单', { icon: 'text.badge.plus' }),
      menuItem('data-np-act="queue"', '加入播放队列', { icon: 'plus.rectangle.on.folder' }),
      menuItem('data-np-act="force"', '重新解析（换一条线路）', { icon: 'arrow.clockwise' }),
      menuItem('data-np-act="info"', '歌曲信息', { icon: 'info.circle' }),
      '-',
      menuItem('data-np-act="close"', '关闭播放页', { icon: 'xmark' }),
    ]);
  }

  renderLyrics();
  renderQueueSheet();
  renderProgress();
  if (track && state.theme.coverDriven) refreshAccentFromArtwork(cover);
}

function renderProgress() {
  const total = (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (currentTrack() || {}).duration) || 0;
  const real = Math.min(Math.max(0, audio.currentTime || 0), total || 0);
  const shown = state.seekDrag === null ? real : state.seekDrag;
  const ratio = total > 0 ? Math.min(1, Math.max(0, shown / total)) : 0;
  $('fill').style.width = `${ratio * 100}%`;
  $('knob').style.left = `${ratio * 100}%`;
  $('t-cur').textContent = fmtTime(shown);
  $('t-left').textContent = `-${fmtTime(Math.max(0, total - shown))}`;
}

function openPlayer() {
  state.playerOpen = true;
  state.npMenu = false;
  render();
}

function closePlayer() {
  state.playerOpen = false;
  state.npMenu = false;
  state.queueOpen = false;
  render();
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
  if (state.playerOpen) renderLyrics();
  pushTaskbarLyric(true); // 换歌了：先让那条换成新歌名，别拿上一首的词顶着
  const res = await api.playback.lyrics(track);
  if (currentTrack() !== track) return; // 期间已切歌
  state.lyrics = res.ok ? res.lrc : null;
  state.lyricRows = state.lyrics ? parseLrc(state.lyrics) : [];
  if (state.playerOpen) renderLyrics();
  pushTaskbarLyric(true); // 词到位（或确认没有词），那条要跟着换
}

function lyricStyle() {
  const scale = Number(state.theme.lyricScale) || 1;
  // 基准 20px（styles.css .lyric-line 同一个数），档位 0.85/1/1.2/1.5 只是乘这个基准。
  return `font-size:${Math.round(20 * scale)}px`;
}

function renderLyrics() {
  const box = $('lyrics');
  const on = state.playerView === 'lyrics';
  box.hidden = !on;
  // 歌词模式下封面让位：两者抢的是同一档 flex:1 的高度（.lyrics-on 在 CSS 里藏 .art-area）
  $('player').classList.toggle('lyrics-on', on);
  $('s-lyrics').classList.toggle('on', on);
  if (!on) return;
  if (!state.lyricRows.length) {
    box.innerHTML = `<div class="lyric-line" style="${lyricStyle()};opacity:.6">${
      state.lyrics ? '这首歌的歌词没有可解析的时间轴。' : '当前没有歌词（服务器源优先取逐字歌词 lyricsSync）。'
    }</div>`;
    return;
  }
  box.innerHTML = state.lyricRows
    .map(
      (row, i) =>
        `<div class="lyric-line${i === state.lyricIndex ? ' now' : i < state.lyricIndex ? ' past' : ''}" id="ly-${i}" data-ly="${row.at}" style="${lyricStyle()}">${esc(
          row.text
        )}</div>`
    )
    .join('');
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
  const prev = document.getElementById(`ly-${state.lyricIndex}`);
  if (prev) {
    prev.classList.remove('now');
    prev.classList.add('past');
  }
  state.lyricIndex = idx;
  // 任务栏那条（需求 8）：必须在下面那个"没开歌词面板就 return"之前推 ——
  // 用户没在播放页看歌词、却把窗口最小化了，恰恰是这条功能唯一的使用场景。
  pushTaskbarLyric();
  if (state.playerView !== 'lyrics') return;
  const node = document.getElementById(`ly-${idx}`);
  if (node) {
    node.classList.add('now');
    node.classList.remove('past');
    if (state.settings.lyricsFollow !== false) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    renderLyrics();
  }
}

/**
 * 把"现在这一句"推给主进程（需求 8）。
 *
 * 分工要说死：这里只交数据，**显示与否一律由主进程判**（设置开关 + 主窗口是不是真的看不见 +
 * 有没有在播 + 这句有没有字）。渲染层不知道最小化这件事，也不该知道。
 * 带去重：timeupdate 一秒能来四次，同一句反复 send 会把那条窗口刷出残影。
 */
let lastTaskbarPush = '';
function pushTaskbarLyric(force) {
  const track = currentTrack();
  const row = state.lyricIndex >= 0 ? state.lyricRows[state.lyricIndex] : null;
  const payload = {
    text: row ? row.text : '',
    title: track ? track.title || '' : '',
    artist: track ? track.artist || '' : '',
    playing: Boolean(state.playing),
    hasLyrics: state.lyricRows.length > 0,
  };
  const key = `${payload.playing}|${payload.title}|${payload.text}`;
  if (!force && key === lastTaskbarPush) return;
  lastTaskbarPush = key;
  api.taskbarLyric.push(payload);
}

/* ── 播放队列（原版是 sheet，detents medium/large）───── */

function renderQueueSheet() {
  const sheet = $('queue-sheet');
  sheet.hidden = !state.queueOpen;
  $('s-queue').classList.toggle('on', state.queueOpen);
  if (!state.queueOpen) return;
  if (!state.queue.length) {
    $('qs-body').innerHTML = '<p class="hint" style="padding:12px 16px">队列为空。</p>';
    return;
  }
  const order = state.order.length === state.queue.length ? state.order : state.queue.map((_, i) => i);
  const pos = orderPos();
  const groups = [
    ['正在播放', order.slice(pos, pos + 1)],
    ['接下来播放', order.slice(pos + 1)],
    ['已播放', order.slice(0, pos)],
  ];
  $('qs-body').innerHTML = groups
    .filter(([, idxs]) => idxs.length)
    .map(
      ([label, idxs]) =>
        `<div class="q-row" style="padding:0;cursor:default"><span class="g">${esc(label)}</span></div>` +
        idxs.map(queueRow).join('')
    )
    .join('');
}

function queueRow(i) {
  const t = state.queue[i];
  if (!t) return '';
  const on = i === state.index;
  return `<div class="q-row" data-queue-play="${i}">
    <span class="${on ? 'now' : ''}" style="width:20px;min-width:20px;text-align:right;color:${on ? 'var(--accent)' : 'var(--text-3)'};font-size:var(--fs-caption)">${i + 1}</span>
    <div style="flex:1;min-width:0"><div class="song-title">${esc(t.title)}</div><div class="song-sub">${esc(t.artist || '')}</div></div>
    <button class="song-more" data-fav-current="${i}" title="我喜欢">${icon(isFavorite(t) ? 'heart.fill' : 'heart')}</button>
  </div>`;
}

/* ── 弹层（sheet）─────────────────────── */

function closeSheet() {
  state.sheet = null;
  $('sheet').hidden = true;
  $('sheet-title').textContent = '';
  $('sheet-body').innerHTML = '';
}

function openSheet(sheet) {
  state.sheet = sheet;
  renderSheet();
}

const sheetAction = (attr, iconName, label, opts = {}) =>
  `<button class="sheet-item" ${attr}>${icon(iconName)}<span class="nm">${esc(label)}${
    opts.sub ? `<br><span class="muted" style="font-size:var(--fs-caption2)">${esc(opts.sub)}</span>` : ''
  }</span>${opts.mark ? `<span class="check" data-on="1">${icon('checkmark')}</span>` : ''}</button>`;

function renderSheet() {
  const wrap = $('sheet');
  if (!state.sheet) {
    closeSheet();
    return;
  }
  wrap.hidden = false;
  const s = state.sheet;
  $('sheet-body').dataset.kind = s.kind;
  const tracks = s.tracks && s.tracks.length ? s.tracks : s.track ? [s.track] : [];

  if (s.kind === 'add') {
    $('sheet-title').textContent = '添加到歌单';
    // AddToPlaylistSheet（NowPlayingView.swift:4523-4756）：先「新建歌单」，下面每个歌单一行，
    // 勾上=已包含，再点一次取消包含；「我喜欢」不在这里（走心形）。
    $('sheet-body').innerHTML = `${sheetAction('data-sheet-create="1"', 'plus', '新建歌单')}
      ${
        visiblePlaylists().length === 0
          ? '<p class="muted" style="padding:10px 16px">还没有歌单，先新建一个。</p>'
          : visiblePlaylists()
              .map((p) => {
                const has = tracks.length > 0 && tracks.every((t) => inPlaylist(p.id, t));
                return `<button class="sheet-item" data-sheet-toggle="${esc(p.id)}">${coverSpan(p, 'pl-cover')}
                  <span class="nm">${esc(p.name)}<br><span class="muted" style="font-size:var(--fs-caption2)">${
                    p.songs.length
                  } 首歌曲</span></span>
                  <span class="check"${has ? ' data-on="1"' : ''}>${has ? icon('checkmark') : ''}</span></button>`;
              })
              .join('')
      }
      ${s.error ? `<p class="err" style="margin:8px 16px 0">${esc(s.error)}</p>` : ''}`;
    return;
  }

  if (s.kind === 'create' || s.kind === 'rename' || s.kind === 'syncURL' || s.kind === 'syncName') {
    const isName = s.kind === 'create' || s.kind === 'rename';
    $('sheet-title').textContent =
      s.kind === 'rename' ? '重命名歌单' : s.kind === 'create' ? '新建歌单' : s.kind === 'syncURL' ? '同步服务器地址' : '设备名称';
    const placeholder = isName ? '歌单名' : s.kind === 'syncURL' ? 'https://xxx.pages.dev/api/sync-playlists' : '例：客厅的 Windows';
    const value = isName ? (s.kind === 'rename' ? s.name : '') : s.kind === 'syncURL' ? (state.sync || {}).serverURL || '' : (state.sync || {}).deviceName || '';
    $('sheet-body').innerHTML = `<form id="sheet-form">
        <label class="field"><span>${isName ? '名称' : s.kind === 'syncURL' ? '服务器端点 (API URL)' : '设备名称'}</span>
          <input id="sheet-name" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" spellcheck="false" ${
      s.kind === 'syncURL' ? 'type="url"' : ''
    }></label>
        ${s.error ? `<p class="err" style="margin:8px 0 0">${esc(s.error)}</p>` : ''}
        ${s.kind === 'syncURL' ? '<p class="hint">与 iPhone 版共用同一个端点（Cloudflare Pages + D1）。留空并保存 = 清除配置。</p>' : ''}
        <div class="actions-row" style="justify-content:flex-end">
          <button class="ghost" type="button" data-sheet-cancel="1">取消</button>
          <button class="pill prominent" type="submit">${s.kind === 'create' ? '创建' : '保存'}</button>
        </div>
      </form>`;
    const input = $('sheet-name');
    if (input) input.focus();
    return;
  }

  if (s.kind === 'cloudURL') {
    $('sheet-title').textContent = '音乐源清单 URL';
    $('sheet-body').innerHTML = `<form id="sheet-form">
        <label class="field"><span>云端音乐源清单 (API URL)</span>
          <input id="sheet-name" type="url" placeholder="https://xxx.pages.dev/api/music-sources" value="${esc(
            (state.cloud.config || {}).manifestURL || ''
          )}" autocomplete="off" spellcheck="false"></label>
        ${s.error ? `<p class="err" style="margin:8px 0 0">${esc(s.error)}</p>` : ''}
        <p class="hint">CF 同步服务暴露的音乐源管理端点（<code>/api/music-sources</code>），与歌单同步同一个服务。
          换地址会清空本机缓存的清单与云端线路，改从新地址重拉。</p>
        <div class="actions-row" style="justify-content:flex-end">
          <button class="ghost" type="button" data-sheet-cancel="1">取消</button>
          <button class="pill prominent" type="submit">保存</button>
        </div>
      </form>`;
    const input = $('sheet-name');
    if (input) input.focus();
    return;
  }

  if (s.kind === 'reorder') {
    const songs = s.songs || [];
    $('sheet-title').textContent = '调整播放顺序';
    $('sheet-body').innerHTML = `<p class="muted" style="margin:0 16px 10px">使用箭头移动歌曲${s.changed ? ' · 顺序已更改' : ''}</p>
      ${songs
        .map(
          (t, i) => `<div class="reorder-item"><span class="idx">${i + 1}</span>
            <span class="t">${esc(t.title)}<br><span class="muted" style="font-size:var(--fs-caption2)">${esc(t.artist || '')}</span></span>
            <button data-move="${i}:-1" ${i === 0 ? 'disabled' : ''} title="上移">${icon('chevron.down')}</button>
            <button data-move="${i}:1" ${i === songs.length - 1 ? 'disabled' : ''} title="下移">${icon('chevron.down')}</button>
          </div>`
        )
        .join('')}
      <div class="actions-row" style="justify-content:flex-end">
        <button class="ghost" data-sheet-cancel="1">取消</button>
        <button class="pill prominent" data-sheet-done="1">完成</button>
      </div>`;
    // 上移的箭头要朝上：CSS 没有 flip，用 transform 更省事
    [...$('sheet-body').querySelectorAll('[data-move$=":-1"]')].forEach((b) => (b.style.transform = 'rotate(180deg)'));
    return;
  }

  if (s.kind === 'row') {
    const track = trackAt(s.ref);
    if (!track) {
      closeSheet();
      return;
    }
    $('sheet-title').textContent = track.title || '歌曲';
    const inLiked = isFavorite(track);
    const pl = state.playlistView;
    const inThis = pl && pl.songs.some((t) => trackKey(t) === trackKey(track));
    $('sheet-body').innerHTML = [
      sheetAction(`data-row-act="play" data-ref="${esc(s.ref)}"`, 'play.fill', '播放'),
      sheetAction(`data-row-act="next" data-ref="${esc(s.ref)}"`, 'text.line.last.and.arrowtriangle.forward', '下一首播放'),
      sheetAction(`data-row-act="queue" data-ref="${esc(s.ref)}"`, 'text.line.first.and.arrowtriangle.forward', '加入播放队列'),
      sheetAction(`data-row-act="add" data-ref="${esc(s.ref)}"`, 'text.badge.plus', '添加到歌单'),
      sheetAction(`data-row-act="fav" data-ref="${esc(s.ref)}"`, inLiked ? 'heart.fill' : 'heart', '我喜欢', { mark: inLiked }),
      pl && inThis
        ? sheetAction(`data-row-act="remove-from-pl" data-ref="${esc(s.ref)}"`, 'trash', pl.isSystem ? '取消收藏' : '从歌单中移除')
        : '',
      '-',
      sheetAction(`data-row-act="info" data-ref="${esc(s.ref)}"`, 'info.circle', '歌曲信息'),
    ]
      .filter(Boolean)
      .join('<div class="sep"></div>');
    return;
  }

  if (s.kind === 'info') {
    const t = s.track || {};
    $('sheet-title').textContent = '歌曲信息';
    const row = (label, value) => `<div class="srow"><span class="slabel">${esc(label)}</span><span class="svalue">${esc(value)}</span></div>`;
    $('sheet-body').innerHTML = `<div class="group-card" style="margin:0 12px">${[
      row('标题', t.title || ''),
      row('艺术家', t.artist || ''),
      row('专辑', t.album || ''),
      row('时长', t.duration ? fmtTime(t.duration) : ''),
      row('来源', t.kind === 'server' ? `服务器源 · ${t.sourceID || ''}` : `聚合 · ${PLATFORM_LABEL[t.platform] || t.platform}`),
      row('平台 ID', t.rawID || ''),
      row('可播放', t.unresolved ? '否（无对应源）' : '是'),
    ].join('<div class="sdiv"></div>')}</div>`;
    return;
  }

  if (s.kind === 'device') {
    $('sheet-title').textContent = '播放设备';
    $('sheet-body').innerHTML = `<p class="hint" style="padding:10px 16px">
        iPhone 版这一格是 AirPlay / DLNA 投屏。Windows 的声音输出由系统管：设置 → 系统 → 声音 → 输出，
        或在任务栏音量图标上右键选择播放设备，App 内不做二次路由。
      </p>`;
    return;
  }

  $('sheet-title').textContent = '';
  $('sheet-body').innerHTML = '';
  toast('未知弹层', true);
}

/* ── 播放引擎 ─────────────────────────── */

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
  const list = listOf(listRef);
  if (!list.length) return;
  state.queue = list.slice();
  if (options.shuffle !== undefined) state.shuffle = Boolean(options.shuffle);
  const start = options.shuffle ? Math.floor(Math.random() * list.length) : index; // PlaylistDetailView:1106-1121
  await playAt(start, { pushHistory: true });
  persistSoon();
}

async function playAt(index, { pushHistory = true, force = false } = {}) {
  if (index < 0 || index >= state.queue.length) return;
  const track = state.queue[index];
  if (track && track.unresolved) {
    toast('这首歌来自其它设备的音源，本机没有对应线路', true);
    state.playerError = '同步下来的是歌单结构，本机没有这台服务器源，无法播放。';
    render();
    return;
  }
  state.index = index;
  state.order = buildOrder(state.queue.length, index, state.shuffle);
  state.playerError = null;
  const token = ++loadToken;

  setPlayerMeta(track, null);
  toast(`解析：${track.title}`);

  const resolved = await api.playback.resolve(track, force);
  if (token !== loadToken) return;

  if (!resolved.ok || !resolved.url) {
    state.playerError = resolved.error || '未知原因';
    toast(`播放失败：${state.playerError}`, true);
    setPlayerMeta(track, null);
    render();
    return;
  }
  state.lastResolve = { kind: resolved.kind, at: Date.now() };

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
  void url;
  renderMini();
  if (state.playerOpen) renderPlayer();

  if (track && 'mediaSession' in navigator) {
    const cover = coverOf(track);
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
      /* MediaSession 不可用时忽略（系统媒体键自然失效） */
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
    if (state.queue.length) playAt(state.index >= 0 ? state.index : 0);
    return;
  }
  if (audio.paused) audio.play();
  else audio.pause();
}

/** off → 列表循环 → 单曲循环 → off（与 iPhone 的 RepeatMode 顺序一致） */
function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  persistSoon();
  render();
  toast(state.repeat === 'one' ? '单曲循环' : state.repeat === 'all' ? '列表循环' : '顺序播放');
}

function setShuffle(on) {
  state.shuffle = Boolean(on);
  state.order = buildOrder(state.queue.length, Math.max(0, state.index), state.shuffle);
  persistSoon();
  render();
  toast(state.shuffle ? '随机播放：开' : '随机播放：关');
}

function setVolume(value) {
  state.volume = Math.min(1, Math.max(0, Number(value) || 0));
  audio.volume = state.volume;
  const other = state.playerOpen ? $('c-volume') : $('settings-volume');
  if (other && other !== document.activeElement) other.value = String(state.volume);
  persistSoon();
}

function seekTo(seconds) {
  if (!audio.src) return;
  audio.currentTime = Math.max(0, Number(seconds) || 0);
  renderProgress();
}

/* ── 数据动作 ─────────────────────────── */

async function toggleFavorite(track) {
  if (!track) return;
  const res = await api.library.toggleFavorite(track);
  state.favorites = res.favorites;
  await reloadPlaylists();
  render();
}

async function ensurePlaylist(id) {
  if (id === LIKED_PLAYLIST_ID) return;
  if (!playlistById(id)) await reloadPlaylists();
}

async function loadPlaylistView(id) {
  if (id === LIKED_PLAYLIST_ID) {
    state.playlistView = likedAsPlaylist();
    return;
  }
  const res = await api.playlists.get(id);
  if (playlistError(res)) return;
  state.playlistView = res.value;
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
    : {
        ...shared,
        id: `agg_${track.platform}_${track.rawID}`,
        filePath: `/aggregated/${track.platform}/${track.rawID}.mp3`,
        sourceId: 'system-aggregated-music',
      };
}

async function exportPlaylist(p) {
  const wire = { id: p.id, name: p.name, createdAt: p.createdAt || 0, updatedAt: p.updatedAt || 0, songs: (p.songs || []).map(toWireSong) };
  const res = await api.sync.exportPlaylist(wire);
  if (res.ok) toast(`已导出：${res.filePath}`);
  else if (!res.canceled) toast(res.error || '导出失败', true);
  render();
}

async function deletePlaylist(p) {
  if (!p || p.isSystem) return;
  state.menu = null;
  const res = await api.playlists.remove(p.id);
  if (playlistError(res)) return;
  toast(`已删除歌单「${p.name}」`);
  await reloadPlaylists();
  state.playlistView = null;
  const stack = state.stacks[state.tab];
  if (parsePage(stack[stack.length - 1]).name === 'playlist') stack.pop();
  render();
}

function insertTracks(tracks, { next }) {
  if (!tracks.length) return;
  if (next) {
    const at = Math.max(0, state.index) + 1;
    state.queue = state.queue.slice(0, state.index < 0 ? 0 : at).concat(tracks, state.queue.slice(state.index < 0 ? 0 : at));
    if (state.index < 0 && state.queue.length) state.index = 0;
  } else {
    state.queue = state.queue.concat(tracks);
  }
  state.order = buildOrder(state.queue.length, Math.max(0, state.index), state.shuffle);
  persistSoon();
  if (state.queueOpen) renderQueueSheet();
}

/* ── 云端同步 ─────────────────────────── */

/* ── 云端音乐源（需求 1/2/4/5）─────────────
   本机只保存一个清单 URL；线路、可用性结论、首页文案都从那份清单解释出来。 */

async function loadCloudConfig() {
  const payload = await api.cloud.config();
  state.cloud.config = payload.config || null;
  state.cloud.settings = payload.settings || null;
  state.sources = await api.sources.list();
  return payload;
}

/** 拉清单（force=true 跳过 ETag）。拉回来要顺带刷新三样：线路表、首页文案、可用源计数。 */
async function refreshCloudSources({ force = false } = {}) {
  if (state.cloud.busy) return;
  state.cloud.busy = true;
  state.cloud.error = null;
  state.cloud.result = null;
  render();
  const res = await api.cloud.refresh(force);
  state.cloud.busy = false;
  state.cloud.config = res.config || state.cloud.config;
  state.sources = await api.sources.list();
  const loaded = loadSummary(state.sources).loaded.length;
  if (!res.ok) {
    // 拉不到绝不清空本机线路（主进程那边也是这个口径）：这里只把原因写出来。
    state.cloud.error = res.error || '云端清单拉取失败，本机继续使用缓存';
  } else {
    if (res.settings) state.cloud.settings = res.settings;
    // 报数只报本机真的加载进播放路径的那一条口径（需求 1/3）：
    // "服务端说可用 17 条"和用户实际能播的是两回事，界面上别给两个数让人对不上。
    if (res.changed) {
      state.cloud.result = `清单已更新（revision ${res.revision}）· 云端 ${state.sources.length} 条，本机加载 ${loaded} 条可播线路`;
    } else {
      state.cloud.result = `清单没有变化（revision ${res.revision}，服务端回了 304）· 本机加载 ${loaded} 条`;
    }
  }
  render();
}

/**
 * 「检测全部可用」（需求 2）。
 * 进度靠 onVerdict 事件一条条推上来，界面能看着结论往下走 ——
 * 这比"转圈三分钟后给一个总数"有用，因为用户要知道**是哪一条**不出声。
 */
async function checkAllSources() {
  if (state.cloud.checking) return;
  state.cloud.checking = true;
  state.cloud.verdicts = {};
  state.cloud.error = null;
  state.cloud.result = null;
  render();
  const res = await api.sources.checkAll();
  state.cloud.checking = false;
  state.cloud.verdicts = {};
  (res.verdicts || []).forEach((v) => {
    state.cloud.verdicts[v.id] = v;
  });
  if (res.cloud) state.cloud.config = res.cloud;
  state.sources = res.sources || (await api.sources.list());
  const dead = (res.verdicts || []).filter((v) => v.status !== 'ok' && VERDICT_BLIND.indexOf(v.status) < 0);
  state.cloud.result = `本机检完 ${
    (res.verdicts || []).length
  } 条：可播 ${(res.verdicts || []).filter((v) => v.status === 'ok').length} 条 · 不可播 ${
    dead.length
  } 条（服务端已标建议删除）· 当前播放路径里 ${loadSummary(state.sources).loaded.length} 条`;
  render();
}

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
  if (parsePage(pageRef()).name !== 'sync') open('sync');
  else render();
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
  if (parsePage(pageRef()).name !== 'sync') open('sync');
  else render();
}

/* ── 搜索 ─────────────────────────────── */

let searchTimer = null;
let searchSeq = 0;
let partialBound = false;

async function runSearch(keyword) {
  state.keyword = keyword;
  if (parsePage(pageRef()).name !== 'root' || state.tab !== 'search') {
    state.tab = 'search';
    state.stacks.search = ['root'];
  }
  if (!keyword) {
    state.results = [];
    state.searching = false;
    render();
    return;
  }
  state.searching = true;
  state.filter = 'all';
  const requestId = ++searchSeq;
  state.lastQuery = keyword;
  state.results = [];
  render();

  if (!partialBound) {
    partialBound = true;
    api.search.onPartial(({ requestId: id, items, progress }) => {
      if (id !== searchSeq) return;
      state.results = items;
      state.progress = progress;
      if (state.tab === 'search') render();
    });
  }

  const res = await api.search.aggregated(keyword, requestId);
  if (res.requestId !== searchSeq) return;
  state.searching = false;
  if (!res.ok) toast(res.error || '搜索失败', true);
  else if (!res.items.length) toast('未搜索到匹配歌曲', true);
  state.results = res.items;
  if (res.ok && res.items.length) rememberSearch(keyword);
  render();
}

function rememberSearch(keyword) {
  const list = state.searchHistory.filter((k) => k !== keyword);
  state.searchHistory = [keyword, ...list].slice(0, 8);
  saveThemeSoon();
}

/* ── 服务器源 ─────────────────────────── */

async function loadServerPage(skip) {
  const view = state.serverView;
  if (!view.sourceID) return;
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

async function deepHealthScan(id) {
  state.menu = null;
  toast('深度扫描：重新登录并载入整库第一页…');
  state.serverView = { sourceID: id, items: [], total: 0, skip: 0, filter: '', loading: true, error: null };
  open('server:' + id);
  await loadServerPage(0);
}

/* ── 页面跳转（带副作用）──────────────── */

async function goto(page) {
  const { name, arg } = parsePage(page);
  if (name === 'editServer') {
    state.formServerId = arg || null;
    state.formError = null;
    state.formResult = null;
  }
  if (name === 'sync') await loadSyncConfig();
  if (name === 'playlist') await loadPlaylistView(arg);
  if (name === 'liked') state.playlistView = likedAsPlaylist();
  open(page);
  if (name === 'server' && state.serverView.sourceID !== arg) {
    state.serverView = { sourceID: arg, items: [], total: 0, skip: 0, filter: '', loading: false, error: null };
    loadServerPage(0);
  }
}

/* ── 事件：点击委托 ───────────────────── */

let miniSwiped = false;

document.addEventListener('click', async (event) => {
  if (state.menu && !event.target.closest('.menu')) state.menu = null;
  if (state.npMenu && !event.target.closest('.np-menu')) state.npMenu = false;

  const target = event.target.closest(
    [
      '[data-tab]', '[data-back]', '[data-page]', '[data-menu]', '[data-sort]', '[data-select-mode]',
      '[data-play-all-of]', '[data-shuffle-all-of]', '[data-play]', '[data-row-menu]', '[data-row-act]',
      '[data-new-playlist]', '[data-import-file]', '[data-play-playlist]', '[data-shuffle-playlist]',
      '[data-pl-menu]', '[data-reorder]', '[data-rename-playlist]', '[data-remove-playlist]', '[data-pl-export]',
      '[data-queue-playlist]', '[data-next-playlist]', '[data-clear-history]', '[data-toggle-scope]',
      '[data-filter]', '[data-clear-search]', '[data-clear-search-history]', '[data-history-search]',
      '[data-del-search-history]', '[data-cycle-repeat]', '[data-switch-shuffle]', '[data-switch-lyrics-follow]',
      '[data-switch-taskbar-lyric]',
      '[data-cycle-appearance]', '[data-switch-cover]', '[data-switch-tray]', '[data-appearance]',
      '[data-set-accent]', '[data-reset-accent]', '[data-lyric-scale]',
      '[data-sources-check-all]', '[data-cloud-refresh]', '[data-edit-cloud-url]', '[data-toggle-form]', '[data-cancel-form]',
      '[data-edit-server]', '[data-test-server-row]', '[data-server-health]',
      '[data-remove-server]', '[data-load-more]', '[data-play-all]', '[data-clear-server-filter]',
      '[data-test-server]', '[data-sync-backup]', '[data-sync-restore]', '[data-sync-devices]',
      '[data-sync-import]', '[data-edit-server-url]', '[data-edit-device-name]', '[data-copy-id]',
      '[data-open-releases]', '[data-open-repo]', '[data-open-issues]', '[data-library-play]',
      '[data-library-shuffle]', '[data-open-player]', '[data-close-player]', '[data-np-menu]',
      '[data-np-act]', '[data-fav-current]', '[data-queue-play]', '[data-ly]', '[data-toggle-view]',
      '[data-open-device]', '[data-close-queue]', '[data-batch]', '[data-sheet-create]', '[data-sheet-toggle]',
      '[data-sheet-cancel]', '[data-sheet-done]', '[data-move]',
    ].join(', ')
  );

  if (!target) {
    // 遮罩与 × 关闭弹层；弹层与 ⋯ 菜单内部的空白点击不动界面（否则重绘会清掉正在输入的歌单名）
    if (event.target.id === 'sheet' || event.target.closest('#sheet-close')) closeSheet();
    else if (event.target.closest('#mini')) {
      if (!miniSwiped) openPlayer();
      miniSwiped = false;
    } else if (!event.target.closest('.sheet-card') && !event.target.closest('.menu') && !event.target.closest('#player')) render();
    return;
  }

  const d = target.dataset;
  const trackOf = (ref) => (ref === undefined ? currentTrack() : trackAt(ref));

  /* 外壳 */
  if (d.tab) {
    switchTab(d.tab);
    return;
  }
  if (d.back) {
    pop();
    return;
  }
  if (d.page) {
    state.menu = null;
    await goto(d.page);
    return;
  }
  if (d.openPlayer) {
    if (!miniSwiped) openPlayer();
    miniSwiped = false;
    return;
  }
  if (d.closePlayer) {
    closePlayer();
    return;
  }
  if (d.batch) {
    await batchAction(d.batch);
    return;
  }

  /* 播放列表行 */
  if (d.play) {
    const [list, idx] = d.play.split(':');
    if (state.selection && state.selection.list === list) {
      const t = listOf(list)[Number(idx)];
      const key = trackKey(t);
      if (state.selection.keys.has(key)) state.selection.keys.delete(key);
      else state.selection.keys.add(key);
      render();
      return;
    }
    await playFrom(list, Number(idx));
    return;
  }
  if (d.rowMenu) {
    openSheet({ kind: 'row', ref: d.rowMenu });
    return;
  }
  if (d.rowAct) {
    await rowAction(d.rowAct, d.ref, target);
    return;
  }
  if (d.selectMode) {
    state.menu = null;
    state.selection = { list: d.selectMode, keys: new Set() };
    render();
    return;
  }
  if (d.playAllOf || d.shuffleAllOf) {
    const ref = d.playAllOf || d.shuffleAllOf;
    state.menu = null;
    await playFrom(ref, 0, { shuffle: Boolean(d.shuffleAllOf) });
    return;
  }
  if (d.sort) {
    if (state.sort.key === d.sort) state.sort.asc = !state.sort.asc;
    else {
      state.sort.key = d.sort;
      state.sort.asc = d.sort === 'added' || d.sort === 'source' ? false : true;
    }
    state.menu = null;
    render();
    return;
  }

  /* 歌单 */
  if (d.newPlaylist) {
    state.menu = null;
    openSheet({ kind: 'create' });
    return;
  }
  if (d.renamePlaylist !== undefined) {
    state.menu = null;
    const p = state.playlistView;
    if (p && !p.isSystem) openSheet({ kind: 'rename', id: p.id, name: p.name });
    else render();
    return;
  }
  if (d.removePlaylist !== undefined) {
    await deletePlaylist(state.playlistView);
    return;
  }
  if (d.plMenu) {
    state.menu = state.menu === `playlist:${d.plMenu}` ? null : `playlist:${d.plMenu}`;
    render();
    return;
  }
  if (d.plExport !== undefined) {
    state.menu = null;
    if (state.playlistView) await exportPlaylist(state.playlistView);
    return;
  }
  if (d.reorder !== undefined) {
    state.menu = null;
    const p = state.playlistView;
    if (p && p.songs.length >= 2) openSheet({ kind: 'reorder', id: p.id, songs: p.songs.slice(), changed: false });
    else render();
    return;
  }
  if (d.queuePlaylist !== undefined || d.nextPlaylist !== undefined) {
    state.menu = null;
    const p = state.playlistView;
    const next = d.nextPlaylist !== undefined;
    if (p && p.songs.length) {
      insertTracks(p.songs, { next });
      toast(next ? `已把「${p.name}」排在当前曲目之后` : `已把「${p.name}」的 ${p.songs.length} 首加入播放队列`);
    }
    render();
    return;
  }
  if (d.playPlaylist) {
    await playPlaylist(d.playPlaylist, false);
    return;
  }
  if (d.shufflePlaylist) {
    await playPlaylist(d.shufflePlaylist, true);
    return;
  }
  if (d.libraryPlay || d.libraryShuffle) {
    await playFrom('library', 0, { shuffle: Boolean(d.libraryShuffle) });
    return;
  }

  /* 弹层内部 */
  if (d.sheetCreate) {
    const s = state.sheet;
    // AddToPlaylistSheet 的「新建歌单」是从弹层里起的：建完要把刚才那首歌直接放进新歌单，
    // 并且人还留在弹层里 —— 所以 track 必须带过来。
    openSheet({ kind: 'create', backTo: 'add', track: s && s.kind === 'add' ? s.track : null });
    return;
  }
  if (d.sheetToggle) {
    const s = state.sheet;
    if (s && s.kind === 'add' && tracksOfSheet(s).length) {
      for (const t of tracksOfSheet(s)) {
        const res = await api.playlists.toggleSong(d.sheetToggle, t);
        if (playlistError(res)) return;
      }
      await reloadPlaylists();
      renderSheet();
      render();
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
      await reloadPlaylists();
      await loadPlaylistView(s.id).catch(() => {});
      toast('顺序已更新');
    }
    closeSheet();
    render();
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

  /* 播放浮层 */
  if (d.npMenu) {
    state.npMenu = !state.npMenu;
    renderPlayer();
    return;
  }
  if (d.npAct) {
    const t = currentTrack();
    state.npMenu = false;
    if (d.npAct === 'close') closePlayer();
    else if (d.npAct === 'add' && t) openSheet({ kind: 'add', track: t });
    else if (d.npAct === 'info' && t) openSheet({ kind: 'info', track: t });
    else if (d.npAct === 'queue' && t) {
      insertTracks([t], { next: false });
      toast('已在队列末尾');
    } else if (d.npAct === 'force' && t) playAt(state.index, { pushHistory: false, force: true });
    if (d.npAct !== 'close') renderPlayer();
    return;
  }
  if (d.toggleView) {
    state.playerView = state.playerView === d.toggleView ? null : d.toggleView;
    if (d.toggleView === 'queue') state.queueOpen = state.playerView === 'queue';
    renderPlayer();
    return;
  }
  if (d.openDevice) {
    openSheet({ kind: 'device' });
    return;
  }
  if (d.closeQueue) {
    state.queueOpen = false;
    state.playerView = null;
    renderPlayer();
    return;
  }
  if (d.queuePlay !== undefined) {
    await playAt(Number(d.queuePlay));
    renderQueueSheet();
    return;
  }
  if (d.favCurrent !== undefined) {
    await toggleFavorite(state.queue[Number(d.favCurrent)]);
    renderQueueSheet();
    return;
  }
  if (d.ly !== undefined) {
    seekTo(d.ly);
    return;
  }

  /* 搜索 */
  if (d.filter) {
    state.filter = d.filter;
    render();
    return;
  }
  if (d.toggleScope) {
    state.scope = state.scope === 'aggregated' ? 'library' : 'aggregated';
    state.results = [];
    render();
    if (state.scope === 'aggregated' && state.keyword) runSearch(state.keyword);
    return;
  }
  if (d.clearSearch) {
    state.keyword = '';
    state.results = [];
    state.searching = false;
    render();
    $('search-input')?.focus();
    return;
  }
  if (d.clearSearchHistory) {
    state.searchHistory = [];
    saveThemeSoon();
    render();
    return;
  }
  if (d.delSearchHistory) {
    state.searchHistory = state.searchHistory.filter((k) => k !== d.delSearchHistory);
    saveThemeSoon();
    render();
    event.stopPropagation();
    return;
  }
  if (d.historySearch) {
    state.keyword = d.historySearch;
    render();
    await runSearch(d.historySearch);
    return;
  }

  /* 设置：外观与播放 */
  if (d.cycleRepeat) {
    cycleRepeat();
    return;
  }
  if (d.switchShuffle) {
    setShuffle(!state.shuffle);
    return;
  }
  if (d.switchLyricsFollow) {
    state.settings = await api.settings.save({ ...state.settings, lyricsFollow: state.settings.lyricsFollow === false });
    render();
    return;
  }
  if (d.switchTray) {
    state.settings = await api.settings.save({ ...state.settings, minimizeToTray: state.settings.minimizeToTray === false });
    render();
    return;
  }
  // 需求 8：任务栏歌词条的开关。这条只在主窗口看不见时才露脸，所以点下去当场看不到变化，
  // 但必须把当前这句重新推一次 + 清掉上一首的"别露脸"，否则最小化后可能是空的或干脆不出来。
  if (d.switchTaskbarLyric) {
    const on = state.settings.taskbarLyric === false;
    state.settings = await api.settings.save({ ...state.settings, taskbarLyric: on });
    if (on) api.taskbarLyric.reset();
    pushTaskbarLyric(true);
    render();
    return;
  }
  if (d.cycleAppearance) {
    const order = ['automatic', 'light', 'dark'];
    state.theme.mode = order[(order.indexOf(state.theme.mode) + 1) % 3];
    applyAppearance();
    saveThemeSoon();
    render();
    return;
  }
  if (d.appearance) {
    state.theme.mode = d.appearance;
    applyAppearance();
    saveThemeSoon();
    render();
    return;
  }
  if (d.setAccent) {
    state.theme.accent = `#${d.setAccent}`;
    state.theme.resolvedAccent = '';
    state.theme.coverDriven = false;
    applyAccent(state.theme.accent);
    saveThemeSoon();
    render();
    toast(`主题色 #${d.setAccent.toUpperCase()}`);
    return;
  }
  if (d.resetAccent) {
    state.theme.accent = '';
    state.theme.resolvedAccent = '';
    applyAccent('');
    saveThemeSoon();
    render();
    return;
  }
  if (d.switchCover) {
    state.theme.coverDriven = !state.theme.coverDriven;
    if (!state.theme.coverDriven) {
      state.theme.resolvedAccent = '';
      applyAccent(state.theme.accent || '');
    } else if (state.playerOpen) refreshAccentFromArtwork(coverOf(currentTrack() || {}));
    saveThemeSoon();
    render();
    return;
  }
  if (d.lyricScale) {
    state.theme.lyricScale = Number(d.lyricScale);
    saveThemeSoon();
    if (state.playerOpen) renderLyrics();
    render();
    return;
  }

  /* 线路与源 */
  /* 云端音乐源（需求 1/2/4）：增删改在 CF 后台，本机只有"刷新"和"检测全部可用"。 */
  if (d.sourcesCheckAll) {
    await checkAllSources();
    return;
  }
  if (d.cloudRefresh) {
    await refreshCloudSources({ force: true });
    return;
  }
  if (d.editCloudURL) {
    openSheet({ kind: 'cloudURL' });
    return;
  }
  if (d.toggleForm) {
    state.form = state.form === d.toggleForm ? null : d.toggleForm;
    render();
    return;
  }
  if (d.cancelForm) {
    state.form = null;
    render();
    return;
  }
  if (d.editServer) {
    state.menu = null;
    await goto(`editServer:${d.editServer}`);
    return;
  }
  if (d.testServerRow) {
    state.menu = null;
    state.formServerId = d.testServerRow;
    open('editServer');
    await testServerForm();
    return;
  }
  if (d.serverHealth) {
    await deepHealthScan(d.serverHealth);
    return;
  }
  if (d.removeServer) {
    state.menu = null;
    state.servers = await api.server.remove(d.removeServer);
    state.formServerId = null;
    toast('已删除');
    const stack = state.stacks[state.tab];
    if (/^(server|editServer)/.test(parsePage(stack[stack.length - 1]).name)) stack.pop();
    render();
    return;
  }
  if (d.testServer) {
    await testServerForm();
    return;
  }
  if (d.loadMore) {
    loadServerPage(state.serverView.items.length);
    return;
  }
  if (d.playAll) {
    state.queue = state.serverView.items.slice();
    await playAt(0);
    return;
  }
  if (d.clearServerFilter) {
    state.serverView.filter = '';
    render();
    return;
  }
  if (d.clearHistory) {
    await api.library.clearHistory();
    state.history = [];
    render();
    return;
  }

  /* 云端同步 */
  if (d.syncBackup) {
    state.menu = null;
    await runSync('backup');
    return;
  }
  if (d.syncRestore) {
    state.menu = null;
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
    state.menu = null;
    const res = await api.sync.importFile();
    if (res.ok && res.data) {
      toast(`已导入 ${res.data.created} 个歌单、${res.data.songs} 首`);
      await reloadPlaylists();
    } else if (!res.canceled) toast(res.error || '导入失败', true);
    render();
    return;
  }
  if (d.editServerUrl) {
    openSheet({ kind: 'syncURL' });
    return;
  }
  if (d.editDeviceName) {
    openSheet({ kind: 'syncName' });
    return;
  }
  if (d.copyId) {
    try {
      await navigator.clipboard.writeText((state.sync || {}).deviceId || '');
      state.idCopied = true;
      render();
      setTimeout(() => {
        state.idCopied = false;
        if (parsePage(pageRef()).name === 'sync') render();
      }, 1600);
    } catch {
      toast('复制失败，请手动选中', true);
    }
    return;
  }

  /* 关于页外链 */
  if (d.openReleases) {
    await api.openExternal('https://github.com/narci2018/Primuse-halo-plus/releases');
    return;
  }
  if (d.openRepo) {
    await api.openExternal('https://github.com/narci2018/Primuse-halo-plus');
    return;
  }
  if (d.openIssues) {
    await api.openExternal('https://github.com/narci2018/Primuse-halo-plus/issues');
    return;
  }

  render();
});

function tracksOfSheet(s) {
  if (s.tracks && s.tracks.length) return s.tracks;
  return s.track ? [s.track] : [];
}

async function rowAction(act, ref, node) {
  const track = trackAt(ref);
  closeSheet();
  if (!track) return;
  const [list] = String(ref).split(':');
  if (act === 'play') {
    await playFrom(list, Number(String(ref).split(':')[1]));
    return;
  }
  if (act === 'next') {
    insertTracks([track], { next: true });
    toast('已排在当前曲目之后');
    return;
  }
  if (act === 'queue') {
    insertTracks([track], { next: false });
    toast('已加入队列');
    return;
  }
  if (act === 'add') {
    openSheet({ kind: 'add', track });
    return;
  }
  if (act === 'fav') {
    await toggleFavorite(track);
    return;
  }
  if (act === 'info') {
    openSheet({ kind: 'info', track });
    return;
  }
  if (act === 'remove-from-pl') {
    const p = state.playlistView;
    if (!p) return;
    if (p.isSystem) await toggleFavorite(track);
    else {
      const res = await api.playlists.removeSong(p.id, track);
      if (playlistError(res)) return;
      await reloadPlaylists();
      await loadPlaylistView(p.id);
      toast(`已从「${p.name}」移除：${track.title}`);
    }
    render();
    return;
  }
  void node;
}

async function batchAction(kind) {
  const sel = state.selection;
  if (!sel) return;
  const all = listOf(sel.list);
  if (kind === 'cancel') {
    state.selection = null;
    render();
    return;
  }
  if (kind === 'all') {
    sel.keys = new Set(all.map(trackKey));
    render();
    return;
  }
  const picked = all.filter((t) => sel.keys.has(trackKey(t)));
  if (!picked.length) {
    toast('先勾选要处理的歌曲', true);
    return;
  }
  if (kind === 'playlist') {
    openSheet({ kind: 'add', tracks: picked });
    return;
  }
  if (kind === 'next') {
    insertTracks(picked, { next: true });
    toast(`已把 ${picked.length} 首排在当前曲目之后`);
  } else if (kind === 'queue') {
    insertTracks(picked, { next: false });
    toast(`已把 ${picked.length} 首加入播放队列`);
  } else if (kind === 'remove') {
    const p = state.playlistView;
    if (!p) return;
    for (const t of picked) {
      if (p.isSystem) await api.library.toggleFavorite(t);
      else {
        const res = await api.playlists.removeSong(p.id, t);
        if (playlistError(res)) return;
      }
    }
    await reloadPlaylists();
    if (!p.isSystem) await loadPlaylistView(p.id);
    state.selection = { list: 'currentPlaylist', keys: new Set() };
    toast(`已从「${p.name}」移除 ${picked.length} 首`);
  }
  render();
}

/* ── 表单提交 ─────────────────────────── */

document.addEventListener('submit', async (event) => {
  const form = event.target;
  event.preventDefault();

  if (form.id === 'server-form') {
    const config = serverConfigFromForm(true);
    if (!config) return;
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
    toast('已保存到本机（密码走 DPAPI 加密）');
    render();
    return;
  }

  if (form.id === 'sheet-form') {
    const s = state.sheet || {};
    const input = $('sheet-name');
    const value = input ? input.value.trim() : '';
    if (s.kind === 'create') {
      const res = await api.playlists.create(value);
      if (!res.ok) {
        state.sheet = { ...s, error: res.error };
        renderSheet();
        return;
      }
      await reloadPlaylists();
      if (s.backTo === 'add' && s.track) {
        // 新建完立刻把刚才那首加进去（iPhone 的 alert 关掉后仍在 sheet 里）
        const added = await api.playlists.addSong(res.value.id, s.track);
        if (!playlistError(added)) await reloadPlaylists();
        openSheet({ kind: 'add', track: s.track });
      } else {
        closeSheet();
        toast(`已创建歌单「${value}」`);
        await loadPlaylistView(res.value.id);
        open(`playlist:${res.value.id}`);
      }
      render();
      return;
    }
    if (s.kind === 'rename') {
      const res = await api.playlists.rename(s.id, value);
      if (!res.ok) {
        state.sheet = { ...s, error: res.error };
        renderSheet();
        return;
      }
      await reloadPlaylists();
      await loadPlaylistView(s.id);
      closeSheet();
      toast('已重命名');
      render();
      return;
    }
    if (s.kind === 'syncURL') {
      const res = await api.sync.setServerURL(value);
      if (!res.ok) {
        state.sheet = { ...s, error: res.error };
        renderSheet();
        return;
      }
      state.sync = res.config;
      closeSheet();
      state.syncResult = value ? '服务器地址已保存' : '已清除服务器地址';
      render();
      return;
    }
    if (s.kind === 'cloudURL') {
      const res = await api.cloud.setURL(value);
      if (!res.ok) {
        state.sheet = { ...s, error: res.error };
        renderSheet();
        return;
      }
      closeSheet();
      state.cloud.config = res.config;
      state.cloud.result = '清单地址已保存，正在拉取…';
      render();
      await refreshCloudSources({ force: true });
      return;
    }
    if (s.kind === 'syncName') {
      const res = await api.sync.setDeviceName(value);
      state.sync = res.config;
      closeSheet();
      toast('设备名称已保存');
      render();
      return;
    }
    closeSheet();
    return;
  }
});

/* ── 输入：搜索防抖 / 过滤 / 音量 ─────── */

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'search-input') {
    const value = el.value.trim();
    // 组合期（拼音还没上屏）不启动搜索：一半的拼音既查不到东西，又会把
    // 「防抖到点 → render → 输入框被换掉 → 组合串丢失」这条链踩响。
    if (!event.isComposing) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(value), 220); // 与 Swift 侧 200ms 防抖同量级
    }
    if (value !== state.keyword) {
      state.keyword = value;
      const clear = el.parentElement.querySelector('.search-clear');
      if (value && !clear) {
        const btn = document.createElement('button');
        btn.className = 'search-clear';
        btn.dataset.clearSearch = '1';
        btn.innerHTML = icon('xmark');
        el.parentElement.appendChild(btn);
      } else if (!value && clear) clear.remove();
    }
    return;
  }
  if (el.id === 'server-filter') {
    state.serverView.filter = el.value;
    render();
    return;
  }
  if (el.dataset && el.dataset.volume) {
    setVolume(el.value);
    return;
  }
});

/* 输入法组合期的开始/结束。上屏（compositionend）之后 Chromium 才会发最后一次
 * isComposing=false 的 input，所以这里只负责"解除重绘封锁"和补一次搜索调度。 */
document.addEventListener('compositionstart', (event) => {
  const t = event.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) imeBegin();
});
document.addEventListener('compositionend', (event) => {
  imeEnd();
  const el = event.target;
  if (el && el.id === 'search-input') {
    const value = el.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(value), 220);
  }
});
// 组合期被系统打断时不一定有 compositionend，这两个兜底不能省。
window.addEventListener('blur', imeEnd);
document.addEventListener('focusout', (event) => {
  const t = event.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) imeEnd();
});

/* ── 进度条拖动 / 迷你条滑动 / 浮层下拉收起 ── */

function ratioFromPointer(track, clientX) {
  const rect = track.getBoundingClientRect();
  return rect.width ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
}

(function wireSeekTrack() {
  const track = $('track');
  let dragging = false;
  track.addEventListener('pointerdown', (event) => {
    if (!audio.src) return;
    dragging = true;
    track.classList.add('dragging');
    const total = (Number.isFinite(audio.duration) ? audio.duration : 0) || (currentTrack() || {}).duration || 0;
    state.seekDrag = ratioFromPointer(track, event.clientX) * total;
    track.setPointerCapture(event.pointerId);
    renderProgress();
  });
  track.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const total = (Number.isFinite(audio.duration) ? audio.duration : 0) || (currentTrack() || {}).duration || 0;
    state.seekDrag = ratioFromPointer(track, event.clientX) * total;
    renderProgress();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('dragging');
    if (state.seekDrag !== null) audio.currentTime = state.seekDrag;
    state.seekDrag = null;
    renderProgress();
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
})();

(function wireGestures() {
  // 迷你条：左右滑 ≥56pt = 上一曲 / 下一曲（MiniPlayerView 的手势），轻点 = 打开全屏播放
  const mini = $('mini');
  let x0 = null;
  mini.addEventListener('pointerdown', (event) => {
    x0 = event.clientX;
    miniSwiped = false;
  });
  mini.addEventListener('pointerup', (event) => {
    if (x0 === null) return;
    const dx = event.clientX - x0;
    x0 = null;
    if (Math.abs(dx) >= 56) {
      miniSwiped = true;
      step(dx < 0 ? 1 : -1);
      setTimeout(() => {
        miniSwiped = false;
      }, 400);
    }
  });

  // 播放浮层：grabber 下拉 ≥60px 收起（PlayerOverlay 的 dismiss 手势）
  const grab = document.querySelector('.grabber');
  let y0 = null;
  grab.addEventListener('pointerdown', (event) => {
    y0 = event.clientY;
  });
  grab.addEventListener('pointerup', (event) => {
    if (y0 === null) return;
    const dy = event.clientY - y0;
    y0 = null;
    if (dy >= 60) closePlayer();
  });
})();

/* ── audio 事件 ───────────────────────── */

audio.addEventListener('play', () => {
  state.playing = true;
  renderMini();
  if (state.playerOpen) renderPlayer();
  const row = document.querySelector('.song-row.playing .wave');
  if (row) row.hidden = false;
  pushTaskbarLyric(); // 开始播了，那条才有资格露出来（需求 8）
});
audio.addEventListener('pause', () => {
  state.playing = false;
  renderMini();
  if (state.playerOpen) renderPlayer();
  pushTaskbarLyric(); // 暂停 = 收走：定在原地的歌词比没有更碍事
});
audio.addEventListener('timeupdate', () => {
  if (state.playerOpen) renderProgress();
  updateLyricIndex();
  if (audio.currentTime > 5) {
    const track = currentTrack();
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
    renderMini();
    if (state.playerOpen) renderPlayer();
  }
});
audio.addEventListener('error', () => {
  const track = currentTrack();
  if (track && !audio.dataset.retried) {
    audio.dataset.retried = '1';
    playAt(state.index, { pushHistory: false, force: true });
    return;
  }
  state.playerError = '音频取流失败（线路可能被 CDN 拒绝或已过期），可在「聚合音乐源设置」里换线路。';
  toast('音频取流失败，正在改用其它线路', true);
  delete audio.dataset.retried;
  if (state.playerOpen) renderPlayer();
});
audio.addEventListener('loadedmetadata', () => {
  delete audio.dataset.retried;
  state.playerError = null;
  if (state.playerOpen) renderPlayer();
});

$('c-volume').addEventListener('input', (event) => setVolume(event.target.value));
$('c-play').addEventListener('click', togglePlay);
$('c-prev').addEventListener('click', () => step(-1));
$('c-next').addEventListener('click', () => step(1));
$('c-shuffle').addEventListener('click', () => setShuffle(!state.shuffle));
$('c-repeat').addEventListener('click', cycleRepeat);
$('np-fav').addEventListener('click', () => toggleFavorite(currentTrack()));
$('mini-play').addEventListener('click', (event) => {
  event.stopPropagation();
  togglePlay();
});
$('mini-next').addEventListener('click', (event) => {
  event.stopPropagation();
  step(1);
});

/* ── 键盘与系统媒体键 ─────────────────── */

document.addEventListener('keydown', (event) => {
  /* 输入法组合期：按键全部归 TSF（选词、翻页、Escape 取消候选），一个都不许接。
   * 最要命的是 Enter —— 中文输入法按 Enter 是"上屏当前候选词"，而这里原来会把它
   * 当成"提交搜索"，于是拿半个拼音去查、再 render() 把输入框换掉、组合串没了。 */
  if (event.isComposing || event.keyCode === 229) {
    imeBegin(); // compositionstart 万一没到，这里补上，重绘封锁不能漏
    return;
  }
  imeEnd(); // 组合期之后收到的第一个普通按键：说明组合已经结束，把攒下的重绘补掉
  if (event.code === 'Escape') {
    if (state.sheet) closeSheet();
    else if (state.npMenu || state.queueOpen || state.playerView) {
      state.npMenu = false;
      state.queueOpen = false;
      state.playerView = null;
      renderPlayer();
    } else if (state.playerOpen) closePlayer();
    else if (state.menu) {
      state.menu = null;
      render();
    } else if (state.selection) {
      state.selection = null;
      render();
    }
    return;
  }
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (event.key === 'Enter' && event.target.id === 'search-input') {
      clearTimeout(searchTimer);
      runSearch(event.target.value.trim());
    }
    return;
  }
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
  else if (command === 'favorite') toggleFavorite(currentTrack());
  else if (command === 'queue') {
    openPlayer();
    state.queueOpen = true;
    renderPlayer();
  }
});

$('screen').addEventListener('scroll', () => syncNavbarStuck(), { passive: true });

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyAppearance();
  render();
});

document.addEventListener(
  'error',
  (event) => {
    // 封面改成 background-image 后不再触发 img error；这里兜住 <img>（导出预览等）404
    const el = event.target;
    if (!el || el.tagName !== 'IMG') return;
    el.remove();
  },
  true
);

/* ── 冒烟：真实渲染与真实点击 ─────────── */

const smokeErrors = [];
window.addEventListener('unhandledrejection', (event) => {
  const r = event.reason;
  smokeErrors.push(String((r && (r.stack || r.message)) || r).split('\n').slice(0, 3).join(' | '));
});

const SMOKE_PROBE_NAME = /^冒烟(歌单| UI 歌单|点击歌单|点击新建)/;

async function sweepSmokeProbes() {
  await reloadPlaylists();
  const hits = state.playlists.filter((p) => !p.isSystem && SMOKE_PROBE_NAME.test(p.name));
  for (const p of hits) await api.playlists.remove(p.id);
  if (hits.length) await reloadPlaylists();
  return hits.map((p) => p.name);
}

function hasButton(scope, text) {
  return [...document.querySelectorAll(`${scope} button`)].some((b) => b.textContent.trim() === text);
}

/**
 * 「hidden 属性到底有没有真的把它藏起来」。
 * 这些浮层都写了 display:flex，作者样式会盖掉 UA 的 [hidden]{display:none}，
 * 所以只看 .hidden 属性是不够的 —— 必须看渲染结果。styles.css 顶部那条
 * `[hidden]{display:none!important}` 一旦被删，这里立刻非空，CI 就红。
 */
function overlayLeaks() {
  const ids = ['player', 'sheet', 'batch-bar', 'queue-sheet', 'mini-wrap', 'toast'];
  return ids.filter((id) => {
    const el = document.getElementById(id);
    if (!el || !el.hasAttribute('hidden')) return false;
    const d = getComputedStyle(el).display;
    return d !== 'none';
  });
}

/** 一个 id 元素「在屏幕上看得见」= hidden 属性为假 且 计算样式没被 display:none 抹掉。 */
function vis(id) {
  const el = document.getElementById(id);
  return Boolean(el) && !el.hasAttribute('hidden') && getComputedStyle(el).display !== 'none';
}

/**
 * 播放页的几何证据 —— 只断言属性（hidden/class）不够，v1.9.16 那次歌词浮层
 * 「vis() 全绿、屏幕上却把播放按钮和 tab 糊住」就是证据。这里量的是渲染结果：
 * 歌词框必须待在进度条以上，播放按钮和 tab 中心的命中测试不能落到歌词上。
 * 返回的每个布尔项都要为 true；detail 只作诊断，不参与 ok 判定。
 */
function playerGeometry() {
  const box = (id) => document.getElementById(id).getBoundingClientRect();
  const topAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    // SVG 节点的 className 是 SVGAnimatedString，直接拼进诊断字符串只会读出 [object …]；
    // 命中报告按「最近的带 id 祖先」给，读起来才是 #c-play 而不是 svg。
    const named = el && el.closest('[id]');
    const tag = !el ? 'null' : named ? `#${named.id}` : el.tagName.toLowerCase();
    return { el, inLyrics: Boolean(el && el.closest('#lyrics')), tag };
  };
  const measure = () => {
    const lyr = box('lyrics');
    const prog = box('progress');
    const play = box('c-play');
    const tab = box('tabbar');
    const atPlay = topAt(play.x + play.width / 2, play.y + play.height / 2);
    const atTab = topAt(tab.x + tab.width / 2, tab.y + tab.height / 2);
    return {
      // 歌词框的底边不能越过进度条顶边（越过就说明它又在盖控制条）
      lyricsStaysAboveControls: lyr.bottom <= prog.top + 1,
      // 歌词框不能伸到 tab bar 那一带
      lyricsStaysAboveTabbar: lyr.bottom <= tab.top + 1,
      // 播放/暂停按钮的中心要能点到自己
      playButtonClickable: !atPlay.inLyrics && Boolean(atPlay.el && atPlay.el.closest('#c-play')),
      // tab bar 那一行要么被播放页盖住、要么根本没参与绘制 —— 但不能是歌词
      tabbarNotUnderLyrics: !atTab.inLyrics,
      detail: [
        `lyrics=${Math.round(lyr.y)}..${Math.round(lyr.bottom)}`,
        `progress=${Math.round(prog.y)}..${Math.round(prog.bottom)}`,
        `tabbar=${Math.round(tab.y)}..${Math.round(tab.bottom)}`,
        `hitPlay=${atPlay.tag}`,
        `hitTab=${atTab.tag}`,
      ].join(' '),
    };
  };
  // #toast 是 z-index:80 的临时浮条（点击流里上一步「加入播放队列」就会弹一条），
  // 它盖住播放按钮跟歌词没关系。这里问的是「歌词有没有拦住按钮」，所以先把 toast
  // 摘掉再量，量完原样放回去。
  const toast = document.getElementById('toast');
  const wasHidden = toast.hidden;
  toast.hidden = true;
  try {
    return measure();
  } finally {
    toast.hidden = wasHidden;
  }
}

function shellEvidence() {
  const tabs = [...document.querySelectorAll('#tabbar .tab')];
  return {
    tabs: tabs.length,
    tabLabels: tabs.map((t) => t.querySelector('.lab').textContent).join('·'),
    activeTab: (tabs.find((t) => t.classList.contains('active')) || {}).dataset?.tab || '',
    tabIcons: document.querySelectorAll('#tabbar .tab .ico svg').length,
    hasMini: Boolean(document.getElementById('mini')),
    miniHidden: $('mini-wrap').hidden,
    hasBatchBar: Boolean(document.getElementById('batch-bar')),
    batchButtons: document.querySelectorAll('#batch-bar [data-batch]').length,
    hasPlayerOverlay: Boolean(document.getElementById('player')),
    playerControls: document.querySelectorAll('#player .ctrl').length,
    playerSlots: document.querySelectorAll('#player .slot').length,
    rowMenus: document.querySelectorAll('#screen [data-row-menu]').length,
    hasLoginWall: /登录|请先登录|注册/.test(document.body.innerText),
    overlayLeaks: overlayLeaks(),
  };
}

let smokePlaylistProbe = null; // { id, snap } —— 主进程截图后用 phase:'playlist-cleanup' 收走
let smokeQueueRestore = null; // 冒烟跑前用户的真实队列；截图用的内存探针队列必须由 cleanup 换回来
let smokeCloudSnapshot = null; // 注入三种体检结论前的线路列表 —— 截图后由 phase:'cloud-sources-cleanup' 换回来

function snapshotNav() {
  return { tab: state.tab, stacks: JSON.parse(JSON.stringify(state.stacks)) };
}

function snapshotQueue() {
  return { items: state.queue.slice(), index: state.index, order: state.order.slice(), shuffle: state.shuffle, repeat: state.repeat };
}

/** 冒烟会真的往队列里放探针歌曲（批量加入队列那几步走的是 IPC）。跑完必须原样还回去，
 *  否则用户下次打开 App 看到的是「点击探针 A」。 */
async function restoreQueue(snap) {
  state.queue = snap.items;
  state.index = snap.index;
  state.order = snap.order;
  state.shuffle = snap.shuffle;
  state.repeat = snap.repeat;
  audio.pause();
  audio.removeAttribute('src');
  await api.queue.save({ items: snap.items, index: snap.index });
  await api.player.save({ volume: state.volume, repeat: snap.repeat, shuffle: snap.shuffle });
}

function restoreNav(snap) {
  state.tab = snap.tab;
  state.stacks = snap.stacks; // 注意：snapshotNav 返回的是 { tab, stacks }，直接把整个快照塞给 stacks 会让每个 tab 的栈变 undefined
  render();
}

async function smokeShellSearch(keyword) {
  state.tab = 'search';
  state.stacks.search = ['root'];
  render();
  $('search-input').value = keyword;
  await runSearch(keyword);
  // 封面是不是真能显示出来：iPhone 版是满屏专辑封面，这里若全挂了就等于「不像」。
  // 按平台各取一条实测（前 4 条可能全是同一个平台，会把结论带偏）：
  // 酷狗那批 meting 的 type=pic 上游返回空 body，是数据源的缺陷，不是渲染的缺陷。
  const sample = [];
  const seenPlatform = new Set();
  for (const t of state.results) {
    if (seenPlatform.has(t.platform)) continue;
    const u = coverOf(t);
    if (!u) continue;
    seenPlatform.add(t.platform);
    sample.push({ platform: t.platform, url: u });
  }
  const coverLoads = {};
  await Promise.all(
    sample.map(
      ({ platform, url }) =>
        new Promise((resolve) => {
          const im = new Image();
          const timer = setTimeout(() => {
            coverLoads[platform] = 'timeout';
            resolve();
          }, 6000);
          im.onload = () => {
            clearTimeout(timer);
            coverLoads[platform] = `ok:${im.naturalWidth}x${im.naturalHeight}`;
            resolve();
          };
          im.onerror = () => {
            clearTimeout(timer);
            coverLoads[platform] = 'err'; // 上游给了 200 但是空 body，浏览器解不出图片
            resolve();
          };
          im.src = url;
        })
    )
  );
  await settle(900); // 让 <div class="song-cover"> 的 background-image 也解出来，截图才有封面
  // 截图切到「封面真能加载」的那个平台：整页灰方块证明不了封面链路是通的。
  const goodPlatform = sample.find((s) => String(coverLoads[s.platform] || '').startsWith('ok:'));
  if (goodPlatform) {
    state.filter = goodPlatform.platform;
    render();
    await settle(1400);
  }
  const ime = await imeProbe();
  return {
    ready: state.results.length > 0,
    rows: document.querySelectorAll('#screen .song-row').length,
    resultCount: state.results.length,
    platforms: [...new Set(state.results.map((t) => t.platform))],
    chips: document.querySelectorAll('#screen .chip').length,
    coverSamples: sample.map((s) => s.platform),
    coverLoads,
    ime,
    ...shellEvidence(),
  };
}

/**
 * 中文输入法回归探针（v1.9.13 起，用户报"搜索框切中文输入法打不出字，一闪而过"）。
 *
 * 这里刻意不去测"属性"，测的是**节点身份**：组合期一旦 `#search-input` 被换成另一个
 * 节点，输入法与它的连接就断了，正在拼的拼音必然丢 —— 那正是用户看到的现象。
 * 所以断言写成"重绘之后拿到的还是同一个 DOM 节点、值也还在"。
 */
async function imeProbe() {
  const out = {};
  const input = $('search-input');
  if (!input) return { skipped: '搜索框不存在' };
  const before = input.value;
  const composed = before + '周杰';

  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  input.value = composed;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'lun' }));
  out.lockBegins = imeComposing === true;
  out.searchNotScheduledWhileComposing = searchTimer === null || imeComposing === true;

  render(); // 原来就是这一步（防抖到点 → runSearch → render）把输入框换掉的
  out.sameNode = $('search-input') === input;
  out.valueKept = input.value === composed;

  input.value = composed + '伦';
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '周杰伦' }));
  out.lockReleased = imeComposing === false;
  clearTimeout(searchTimer); // 探针不发真搜索，别把后面的断言带偏

  // 解锁的那次重绘已经把节点换过了（这正是设计如此：上屏之后重建是安全的，
  // 组合串已经进 value 了）。所以复位必须重新取节点，拿旧引用写 value 是写给孤儿节点。
  const live = $('search-input') || input;
  live.value = before;
  state.keyword = before;
  render();
  out.restored = Boolean($('search-input')) && $('search-input').value === before;
  await settle(120);
  return out;
}

/**
 * 首页 / 资料库 / 设置三屏的真实 DOM。
 * 之前只截了搜索页和歌单页，剩下三屏「写了没写对」全凭我肉眼读代码 —— 不够。
 * 跑完停在首页，主进程紧接着截 smoke-ui-home.png。
 */
async function smokeShellPages() {
  const screenText = () => document.querySelector('#screen').innerText;
  const titles = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent.trim());
  const out = {};

  state.tab = 'home';
  state.stacks.home = ['root'];
  render();
  await settle(260);
  out.home = {
    title: (document.querySelector('#screen .navbar-large .ttl') || {}).textContent,
    // 服务端可设首页文案（需求 5），所以这里不能再拿写死的「首页」比 —— 把期望值一起报回去。
    titleExpected: homeTitle(),
    sections: titles('#screen .section-head h3'),
    quickActions: titles('#screen .qa-item .nm'),
    heroOrEmpty: Boolean(document.querySelector('#screen .hero-art, #screen .empty-state')),
    aggregatedCTA: /去搜索/.test(screenText()),
  };

  state.tab = 'library';
  state.stacks.library = ['root'];
  render();
  await settle(260);
  out.library = {
    title: (document.querySelector('#screen .navbar-large .ttl') || {}).textContent,
    lead: (document.querySelector('#screen .navbar-large .lead') || {}).textContent,
    rows: titles('#screen .hub-row .hub-name'),
    counts: titles('#screen .hub-row .hub-count'),
    icons: document.querySelectorAll('#screen .hub-row .hub-ico svg').length,
  };

  state.tab = 'settings';
  state.stacks.settings = ['root'];
  render();
  await settle(260);
  out.settings = {
    title: (document.querySelector('#screen .navbar-large .ttl') || {}).textContent,
    groups: titles('#screen .group-title'),
    rows: document.querySelectorAll('#screen .srow').length,
    icons: document.querySelectorAll('#screen .srow .sico svg').length,
    switches: document.querySelectorAll('#screen .switch').length,
    volumeSlider: Boolean(document.querySelector('#screen #settings-volume[type=range]')),
    // 原版设置里没有「退出登录 / 账号」这类东西；出现就是又造了登录墙
    loginWall: /退出登录|账号登录|登录 Primuse/.test(screenText()),
  };

  // 需求 8 的开关：它得在「播放」这一组里、画得出来、点下去真的落盘并通知到主进程。
  // 这里刻意走一次真点击（而不是读 data 属性）：这条开关的全部意义都在"主进程收没收"。
  const stripRowSel = '#screen [data-switch-taskbar-lyric]';
  const stripRow = document.querySelector(stripRowSel);
  const rowRect = stripRow ? stripRow.getBoundingClientRect() : { width: 0, height: 0 };
  const beforeEnabled = (await api.taskbarLyric.status()).enabled;
  if (stripRow) stripRow.click();
  await settle(320);
  const flippedRow = document.querySelector(stripRowSel);
  const afterEnabled = (await api.taskbarLyric.status()).enabled;
  const switchAfter = flippedRow ? flippedRow.querySelector('.switch') : null;
  if (flippedRow) flippedRow.click(); // 复位：冒烟不许把用户的设置留在翻过去的状态
  await settle(320);
  const restoredEnabled = (await api.taskbarLyric.status()).enabled;
  out.settings.taskbarLyric = {
    rowFound: Boolean(stripRow),
    painted: rowRect.width > 60 && rowRect.height > 24,
    inPlaybackGroup: (() => {
      const g = [...document.querySelectorAll('#screen .settings-group')].find(
        (n) => ((n.querySelector('.group-title') || {}).textContent || '').trim() === '播放'
      );
      return /任务栏歌词/.test(g ? g.textContent : '');
    })(),
    labelShown: /任务栏歌词/.test(stripRow ? stripRow.textContent : ''),
    togglesMainProcess: afterEnabled !== beforeEnabled,
    switchMatchesMain: switchAfter ? switchAfter.classList.contains('on') === afterEnabled : false,
    restored: restoredEnabled === beforeEnabled,
  };

  out.overlayLeaks = overlayLeaks();

  // 关于页的品牌块。断言的是"图真的解码出来了、真的画在屏幕上"，不是 img 标签在不在：
  // 素材在打包后要能从 asar 里读出来（§20.3 那条 build/ 不进包、托盘拿到空图的断链，
  // 就是靠"看渲染结果"这一条抓回来的）。
  open('about');
  await settle(460);
  const logo = document.querySelector('.brand-logo');
  const logoBox = logo ? logo.getBoundingClientRect() : { width: 0 };
  out.about = {
    title: (document.querySelector('#screen .navbar .ttl') || {}).textContent,
    logoSrc: logo ? logo.getAttribute('src') : null,
    logoDecoded: Boolean(logo && logo.complete && logo.naturalWidth >= 64),
    logoPainted: Boolean(logo && logoBox.width >= 40),
    buildShown: (screenText().match(/#\s?(\d{2,3})/) || [])[1] || '',
  };
  // 故意停在关于页收尾：主进程接着要截这张图（新加的视觉元素必须有人看过的证据）。
  out.overlayLeaksAfterAbout = overlayLeaks();
  return out;
}

/** 极短的一个 phase：把界面放回首页，好让主进程截首页图。 */
async function smokeHomeView() {
  state.tab = 'home';
  state.stacks.settings = ['root'];
  render();
  await settle(320);
  return {
    title: (document.querySelector('#screen .navbar-large .ttl') || {}).textContent,
    expectedTitle: homeTitle(),
    overlayLeaks: overlayLeaks(),
  };
}

/**
 * 「聚合音乐源」这一屏的真实渲染（需求 2 + 需求 4 的界面侧证据）。
 *
 * 只看 DOM，不读属性：清单 URL 真的写在屏幕上、两个按钮真的画出来了、
 * 三种结论真的分成三组长出来、"未检出"那一组确实没挂「建议删除」。
 *
 * 结论数据这里是**注入的合成值**（渲染层的 state，一次都不碰 store）——
 * 冒烟不该靠第三方站点的脸色，更不能真的把用户的线路停掉。
 * 要证的是"服务端那套口径能在界面上长对形状"，所以三种 tone 各造一条。
 */
async function smokeCloudSources() {
  const out = {};
  const texts = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent.trim());
  const painted = (node, minW = 20, minH = 6) => {
    if (!node || !node.getBoundingClientRect) return false;
    const r = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    return r.width > minW && r.height > minH && cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  // 1) 首页大标题（需求 5）：屏幕上写的必须等于服务端下发的那个词，没下发才是「首页」。
  const fromServer = String((state.cloud.settings || {}).homeTitle || '').trim();
  state.tab = 'home';
  state.stacks.home = ['root'];
  render();
  await settle(260);
  out.homeHeader = {
    shown: texts('#screen .navbar-large .ttl')[0] || '',
    fromServer: fromServer || '(未下发)',
    expected: fromServer || '首页',
    painted: painted(document.querySelector('#screen .navbar-large .ttl')),
  };

  // 2) 云源页本来的样子（清单 URL 一定要有字，那是"客户端只保存这个 URL"的唯一入口）。
  smokeCloudSnapshot = state.sources;
  open('lines');
  await settle(520);
  const pills = [...document.querySelectorAll('#screen .actions-row .pill')];
  const rects = pills.map((n) => {
    const r = n.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)}`;
  });
  out.page = {
    title: texts('#screen .navbar .ttl')[0] || '',
    manifestURL: texts('#screen .route-bar code')[0] || '',
    buttons: pills.map((n) => n.textContent.trim()),
    buttonRects: rects,
    allButtonsPainted: pills.length === 2 && pills.every((n) => painted(n)),
    refreshInNav: Boolean(painted(document.querySelector('#screen [data-cloud-refresh]'))),
    editControls: document.querySelectorAll('#screen input, #screen select, #screen [data-remove-server]').length,
    hintMentionsCF: /CF 后台/.test(document.querySelector('#screen').innerText),
  };

  // 3) 注入三种结论：可播 / 未检出（盲区）/ 不可播 + 建议删除。
  //    `loaded` 一律照主进程真实下发的形状写死（需求 1/3 的 UI 侧唯一真相源是 isLoadable）：
  //    只有服务端确认可播的那条进播放路径，另外两条只在这一列表里给一个说法。
  const mk = (id, name, extra) => ({
    id,
    name,
    platform: 'netease',
    protocolType: 'meting',
    baseURL: `https://example.invalid/${id}`,
    priority: 10,
    isEnabled: true,
    enabledOnServer: true,
    check: {},
    ...extra,
  });
  state.sources = [
    mk('smoke-ok', '〔冒烟〕能出声的线路', { loaded: true, check: { status: 'ok' } }),
    mk('smoke-blind', '〔冒烟〕我们没测成的线路', { loaded: false, check: { status: 'error' } }),
    mk('smoke-bad', '〔冒烟〕真不能播的线路', { loaded: false, suggestDelete: true, check: { status: 'audio_fail' } }),
  ];
  state.cloud.verdicts = {
    'smoke-ok': { id: 'smoke-ok', status: 'ok', detail: '晴天 / 周杰伦 · HTTP 206 audio/mpeg 65536B 命中音频魔数', bytes: 65536, origin: 'local', enabled: true },
    'smoke-blind': { id: 'smoke-blind', status: 'error', detail: 'The operation was aborted', bytes: 0, origin: 'local', enabled: true },
    'smoke-bad': { id: 'smoke-bad', status: 'audio_fail', detail: '直链不可播 200 text/html 0B 实为文本', bytes: 0, origin: 'local', enabled: false },
  };
  render();
  await settle(300);
  const rows = [...document.querySelectorAll('#screen .settings-group .srow')].filter((n) => /〔冒烟〕/.test(n.textContent));
  const rowOf = (needle) => rows.find((n) => n.textContent.includes(needle)) || null;
  const capsulesOf = (node) => (node ? [...node.querySelectorAll('.capsule')].map((c) => c.textContent.trim()) : []);
  const toneOf = (node) => {
    // 音乐源的缩略图现在是"写真封面 + 一圈结论色"（需求 4），所以结论色读边框而不是底色：
    // 底色三档都一样（照片），真正渲染出来不一样的是那圈 inset box-shadow。
    const ico = node && node.querySelector('.sico');
    if (!ico) return '';
    const cs = getComputedStyle(ico);
    return cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : cs.backgroundColor;
  };
  const okRow = rowOf('〔冒烟〕能出声的线路');
  const blindRow = rowOf('〔冒烟〕我们没测成的线路');
  const badRow = rowOf('〔冒烟〕真不能播的线路');
  // 「本机加载」那一组的两个数字也是渲染结果，不是 state 里的计数 —— 用户看得见的就是这一行字。
  const svalueOf = (needle) => {
    const row = [...document.querySelectorAll('#screen .srow')].find((n) => n.textContent.includes(needle));
    if (!row) return { value: '', sub: '' };
    return {
      value: ((row.querySelector('.svalue') || {}).textContent || '').trim(),
      sub: ((row.querySelector('.ssub') || {}).textContent || '').trim(),
    };
  };
  const loadedRow = svalueOf('已加载 · 参与搜索与播放');
  const skippedRow = svalueOf('云端有 · 本机不加载');
  // 需求 4：音乐源的缩略图不许再是灰块 —— 断言它真把那张写真图解出来画上了。
  const photoCover = (node) => {
    const ico = node && node.querySelector('.sico.photo');
    if (!ico) return false;
    return /source-cover\.png/.test(getComputedStyle(ico).backgroundImage);
  };
  out.verdicts = {
    groups: texts('#screen .group-title'),
    rowCount: rows.length,
    ok: { capsules: capsulesOf(okRow), painted: painted(okRow), tone: toneOf(okRow), detail: (okRow || {}).innerText ? okRow.innerText.replace(/\s+/g, ' ').slice(0, 120) : '' },
    blind: { capsules: capsulesOf(blindRow), painted: painted(blindRow), tone: toneOf(blindRow) },
    bad: { capsules: capsulesOf(badRow), painted: painted(badRow), tone: toneOf(badRow) },
    iconsPainted: rows.every((n) => painted(n.querySelector('.sico svg'), 8, 8)),
    photoCovers: rows.every(photoCover),
    photoCoverCount: document.querySelectorAll('#screen .sico.photo').length, // 3 条冒烟线路 + 云端清单 URL 那一行
  };
  out.loadPolicy = {
    groupPresent: texts('#screen .group-title').includes('本机加载'),
    loadedValue: loadedRow.value,
    skippedValue: skippedRow.value,
    skippedReason: skippedRow.sub,
    notLoadedCapsule: {
      ok: capsulesOf(okRow).includes('未加载'),
      blind: capsulesOf(blindRow).includes('未加载'),
      bad: capsulesOf(badRow).includes('未加载'),
    },
  };

  // 故意停在注入后的画面上：主进程紧接着要截 smoke-ui-cloud.png。
  // 断言"三种结论各自长什么样"这种事，光有 DOM 计数不够，得留一张人眼看得懂的图。
  out.overlayLeaks = overlayLeaks();
  return out;
}

/** 把冒烟注入的合成线路/结论收走，界面无残留（合成的东西一条都不许留在屏幕上）。 */
async function smokeCloudSourcesCleanup() {
  const out = {};
  if (smokeCloudSnapshot) {
    state.cloud.verdicts = {};
    state.sources = smokeCloudSnapshot;
    smokeCloudSnapshot = null;
  }
  state.stacks.settings = ['root'];
  state.tab = 'settings';
  render();
  await settle(240);
  const screenText = document.querySelector('#screen').innerText;
  out.leakedSynthetic = /〔冒烟〕/.test(screenText);
  out.cloudPageReachable = Boolean(document.querySelector('#screen .srow'));
  out.overlayLeaks = overlayLeaks();
  return out;
}

/**
 * 需求 8 的取证配合段：把"当前这一句 + 正在播放"交给主进程（playing 这里必须写死 true，
 * 冒烟的 <audio> 未必真在出声，而那条窗口的出场条件之一就是"在播"）。
 * 之后由主进程真的最小化主窗口，看那条自己会不会露出来 —— 判据全在主进程，这里只喂数据。
 */
async function smokeTaskbarStripPush() {
  const payload = { text: '第 7 行冒烟歌词', title: '冒烟 UI 探针 A', artist: '探针', playing: true, hasLyrics: true };
  lastTaskbarPush = ''; // 绕带去重：这一句可能刚刚已经推过一遍
  api.taskbarLyric.push(payload);
  await settle(120);
  const st = await api.taskbarLyric.status();
  return { pushed: payload.text, enabled: st.enabled, received: (st.payload || {}).text === payload.text };
}

async function smokePlaylistUI() {
  // 只看 DOM：证明歌单在新外壳里"点得到、看得见"，而不是"代码里写了"。
  const probeA = { kind: 'aggregated', platform: 'netease', rawID: 'smoke-ui-a', title: '冒烟 UI 探针 A', artist: '探针', duration: 200 };
  const probeB = { kind: 'aggregated', platform: 'qq', rawID: 'smoke-ui-b', title: '冒烟 UI 探针 B', artist: '探针', duration: 180 };
  const snap = snapshotNav();
  const qSnap = snapshotQueue();
  smokeQueueRestore = qSnap;
  await sweepSmokeProbes();
  const created = await api.playlists.create('冒烟 UI 歌单');
  const id = created.ok ? created.value.id : LIKED_PLAYLIST_ID;
  if (created.ok) {
    await api.playlists.addSong(id, probeA);
    await api.playlists.addSong(id, probeB);
  }
  try {
    await reloadPlaylists();

    state.tab = 'library';
    state.stacks.library = ['root', 'playlists'];
    state.menu = 'plAdd';
    render();
    const list = {
      rows: document.querySelectorAll('#screen .pl-row').length,
      navItems: document.querySelectorAll('#tabbar .tab').length,
      upload: Boolean(document.querySelector('#screen [data-sync-backup]')),
      download: Boolean(document.querySelector('#screen [data-sync-restore]')),
      cover: document.querySelectorAll('#screen .pl-cover').length,
      addMenu: [...document.querySelectorAll('#screen .menu-pop button')].map((b) => b.textContent.trim()),
    };

    await loadPlaylistView(id);
    state.stacks.library = ['root', `playlist:${id}`];
    render();
    const detail = {
      name: (document.querySelector('#screen .detail-name') || {}).textContent === '冒烟 UI 歌单',
      caption: /首歌曲/.test((document.querySelector('#screen .detail-sub') || {}).textContent || ''),
      playAll: hasButton('#screen .detail-actions', '全部播放'),
      shufflePlay: hasButton('#screen .detail-actions', '随机播放'),
      menuButton: Boolean(document.querySelector('#screen [data-pl-menu]')),
      songs: document.querySelectorAll('#screen .song-row').length,
      rowMenu: document.querySelectorAll('#screen [data-row-menu]').length,
    };

    state.menu = `playlist:${id}`;
    render();
    const menuItems = [...document.querySelectorAll('#screen .menu-pop button')].map((b) => b.textContent.trim());

    // 行内 ⋯ → 弹层，这是新外壳里「添加到歌单」的入口
    clickDom(document.querySelector('#screen [data-row-menu]'));
    await settle(120);
    const rowSheet = {
      visible: vis('sheet'),
      add: Boolean(document.querySelector('#sheet-body [data-row-act="add"]')),
      fav: Boolean(document.querySelector('#sheet-body [data-row-act="fav"]')),
    };
    clickDom(document.querySelector('#sheet-body [data-row-act="add"]'));
    await settle(120);
    const sheet = {
      visible: vis('sheet'),
      title: $('sheet-title').textContent,
      items: document.querySelectorAll('#sheet-body .sheet-item').length,
      checked: [...document.querySelectorAll('#sheet-body .check[data-on]')].length,
      createRow: Boolean(document.querySelector('#sheet-body [data-sheet-create]')),
    };
    closeSheet();

    state.tab = 'settings';
    state.stacks.settings = ['root', 'sync'];
    await loadSyncConfig();
    render();
    const syncView = {
      form: Boolean(document.querySelector('#screen [data-edit-server-url]')),
      deviceId: /本机唯一标识/.test(document.querySelector('#screen').innerText),
      backup: Boolean(document.querySelector('#screen [data-sync-backup]')),
      restore: Boolean(document.querySelector('#screen [data-sync-restore]')),
      // 原版没有"整库同步"按钮；这里必须明说同步的是歌单结构，不是歌曲源
      honest: /歌单结构/.test(document.querySelector('#screen').innerText),
    };

    // 播放浮层与歌词/队列槽位是否真在页面上（不是只写在代码里）
    state.tab = 'library';
    state.stacks.library = ['root', `playlist:${id}`];
    await loadPlaylistView(id);
    render();
    const shell = shellEvidence();
    clickDom(document.querySelector('[data-open-player]'));
    await settle(120);
    const overlayOpened = vis('player');
    closePlayer();
    // 行内 ⋯ →「播放」这条路径要把队列真的建起来。探针的 rawID 是假的，解析必然失败，
    // 所以这里只验「点下去之后引擎收到的是这首歌单」，不验网络取流（那由前面的线路步骤覆盖）。
    clickDom(document.querySelector('#screen [data-row-menu]'));
    await settle(150);
    clickDom(document.querySelector('#sheet-body [data-row-act="play"]'));
    await settle(800);
    const queueLoaded = state.queue.length === 2 && state.index === 0;

    if (created.ok) smokePlaylistProbe = { id, snap };
    return {
      ok: created.ok,
      list,
      detail,
      menuItems,
      rowSheet,
      sheet,
      syncView,
      shell,
      overlayOpened,
      queueLoaded,
      overlayLeaks: overlayLeaks(),
      error: created.ok ? null : created.error,
    };
  } finally {
    closeSheet();
    state.menu = null;
    state.npMenu = false;
    state.playerOpen = false;
    // 探针歌曲真的进过队列（⋯→播放 那条路径走的是引擎），落盘的队列必须原样还回去
    await restoreQueue(qSnap);
    // 主进程紧接着要截 smoke-ui-playlist.png。胶囊迷你条只在「有当前曲目」时出现，
    // 所以这里临时用内存里的两首探针把它亮出来——不写盘，下一段 cleanup 会清掉。
    state.queue = [probeA, probeB];
    state.index = 0;
    state.order = [0, 1];
    render();
  }
}

/**
 * 全屏播放浮层的实拍证据。iPhone 最有辨识度的就是这个覆盖层（NowPlayingView），
 * 主进程紧接着截 smoke-ui-player.png，两边对照的是同一份 DOM。
 * 依赖上一段留在内存里的两首探针——所以必须在 playlist-cleanup 之前跑。
 */
async function smokePlayerShot() {
  if (!state.queue.length) {
    state.queue = [
      { kind: 'aggregated', platform: 'netease', rawID: 'smoke-ui-a', title: '冒烟 UI 探针 A', artist: '探针', duration: 200 },
    ];
    state.index = 0;
    state.order = [0];
  }
  state.queueOpen = false;
  openPlayer();
  await settle(350);
  const titles = (sel) => [...document.querySelectorAll(`#player ${sel}`)].map((b) => b.title).join('·');
  const formatRow = $('np-format').textContent;
  const clickedMenu = clickDom(document.querySelector('#player [data-np-menu]'));
  await settle(150);
  const menuItems = [...document.querySelectorAll('#np-menu button')].map((b) => b.textContent.trim()).filter(Boolean);
  const menuOpens = clickedMenu && vis('np-menu');
  state.npMenu = false;
  render(); // 截图要拍干净的浮层，菜单关掉
  await settle(120);
  return {
    visible: vis('player'),
    title: $('np-title').textContent,
    hasArtwork: Boolean(document.querySelector('#player .art')),
    grabberCloses: Boolean(document.querySelector('#player [data-close-player]')),
    controls: titles('.ctrl'),
    controlIcons: document.querySelectorAll('#player .ctrl svg').length,
    slots: titles('.slot'),
    hasProgress: Boolean(document.querySelector('#player #track .fill')),
    hasVolume: Boolean(document.querySelector('#player #c-volume[type=range]')),
    formatRow,
    menuOpens,
    menuItems,
    overlayLeaks: overlayLeaks(),
  };
}

async function smokeLyricsShot() {
  // 上一段（player-shot）把浮层开着留给了截图；这里只补歌词模式。
  // 歌词是从服务器取的，冒烟不该等网络 —— 直接塞 16 行带时间轴的假歌词，
  // 量的是渲染结果的几何：歌词框必须待在进度条以上，播放按钮必须点得到。
  if (!state.queue.length) {
    state.queue = [
      { kind: 'aggregated', platform: 'netease', rawID: 'smoke-ui-a', title: '冒烟 UI 探针 A', artist: '探针', duration: 200 },
    ];
    state.index = 0;
    state.order = [0];
  }
  if (!vis('player')) openPlayer();
  state.lyrics = Array.from({ length: 16 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00]第 ${i + 1} 行冒烟歌词`).join('\n');
  state.lyricRows = parseLrc(state.lyrics);
  state.lyricIndex = 6;
  state.playerView = 'lyrics';
  render();
  await settle(420); // 等 player-in 动画（0.32s）过去，量的才是落位之后的几何
  const geo = playerGeometry();
  // 需求 5：歌词的颜色与字号，断言的是屏幕上真的算出来的那三个数，不是 CSS 里写了什么。
  const rgb = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
  const goldish = (c) => c.length === 3 && c[0] >= c[1] && c[1] > c[2] && c[0] - c[2] > 60 && c[0] > c[2] + 24;
  const grayish = (c) => c.length === 3 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) <= 10;
  const nowNode = $('lyrics').querySelector('.lyric-line.now');
  const idleNode = [...$('lyrics').querySelectorAll('.lyric-line')].find((n) => !n.classList.contains('now'));
  const csNow = nowNode ? getComputedStyle(nowNode) : null;
  const csIdle = idleNode ? getComputedStyle(idleNode) : null;
  // 需求 8：把当前这句推给主进程，问它"那条到底在哪、该不该在"。
  pushTaskbarLyric(true);
  const strip = await api.taskbarLyric.status();
  return {
    ...geo,
    lyricsVisible: vis('lyrics'),
    lyricLines: document.querySelectorAll('#lyrics .lyric-line').length,
    nowLine: ($('lyrics').querySelector('.lyric-line.now') || {}).textContent || '',
    artHidden: getComputedStyle(document.querySelector('.art-area')).display === 'none',
    tabbarCovered: getComputedStyle($('app')).visibility === 'hidden',
    lyricLook: {
      nowColor: csNow ? csNow.color : '',
      idleColor: csIdle ? csIdle.color : '',
      nowFontSize: csNow ? Number.parseFloat(csNow.fontSize) : 0,
      scale: Number(state.theme.lyricScale) || 1,
      nowGold: csNow ? goldish(rgb(csNow.color)) : false,
      idleGold: csIdle ? goldish(rgb(csIdle.color)) : false,
      anyGray: [csNow, csIdle].some((cs) => cs && grayish(rgb(cs.color))),
    },
    taskbarStrip: {
      enabled: strip.enabled,
      visibleWhileMainWindowShown: strip.visible, // 主窗口看得见时这条绝不许浮出来
      pushedText: (strip.payload || {}).text || '',
      stripWindowExists: strip.exists, // 同一批：主窗口看得见时这条窗口连创建都不该被创建
    },
    overlayLeaks: overlayLeaks(),
  };
}

async function smokePlaylistCleanup() {
  state.playerView = null;
  state.lyrics = null;
  state.lyricRows = [];
  state.lyricIndex = -1;
  closePlayer();
  // 上一段为了截图在内存里塞了两首探针（胶囊迷你条只在有当前曲目时出现）。
  // 这里必须把用户真实队列换回来 —— 直接清空会把 restoreQueue 刚写回磁盘的队列覆盖成空的。
  if (smokeQueueRestore) {
    const q = smokeQueueRestore;
    smokeQueueRestore = null;
    await restoreQueue(q);
  }
  if (!smokePlaylistProbe) return { removed: false, note: '没有待清理的探针（上一段就没建成功）' };
  const { id, snap } = smokePlaylistProbe;
  const res = await api.playlists.remove(id);
  await reloadPlaylists();
  smokePlaylistProbe = null;
  restoreNav(snap);
  return {
    removed: Boolean(res && res.ok),
    stillThere: state.playlists.some((p) => p.id === id),
    left: visiblePlaylists().length,
  };
}

function clickDom(el) {
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

const settle = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));

async function smokePlaylistClicks() {
  // 真派发 click，而不是直接调内部函数：走的是用户点下去的那条路径
  // （事件委托 → data-* → 分支 → IPC → 重绘）。
  const out = {};
  const probeA = { kind: 'aggregated', platform: 'netease', rawID: 'smoke-click-a', title: '点击探针 A', artist: '探针', duration: 200 };
  const probeB = { kind: 'aggregated', platform: 'qq', rawID: 'smoke-click-b', title: '点击探针 B', artist: '探针', duration: 180 };
  const snap = snapshotNav();
  const qSnap = snapshotQueue();
  await sweepSmokeProbes();
  const created = await api.playlists.create('冒烟点击歌单');
  if (!created.ok) return { ok: false, error: created.error };
  const p1 = created.value.id;
  await api.playlists.addSong(p1, probeA);
  await api.playlists.addSong(p1, probeB);
  await reloadPlaylists();
  let p2 = null;
  try {
    state.tab = 'library';
    await loadPlaylistView(p1);
    state.stacks.library = ['root', `playlist:${p1}`];
    render();

    clickDom(document.querySelector('#screen [data-row-menu]'));
    await settle();
    out.rowSheetOpened = vis('sheet') && document.querySelector('#sheet-body [data-row-act="add"]') !== null;
    clickDom(document.querySelector('#sheet-body [data-row-act="add"]'));
    await settle();
    out.addSheetOpened = vis('sheet') && $('sheet-title').textContent === '添加到歌单';

    clickDom(document.querySelector('#sheet-body [data-sheet-create]'));
    await settle();
    out.createFormShown = Boolean($('sheet-name'));
    const sheetNow = state.sheet || {};
    out.diag = { kindBeforeCreate: sheetNow.kind, backTo: sheetNow.backTo || null, track: sheetNow.track ? sheetNow.track.rawID : null };
    $('sheet-name').value = '冒烟点击新建';
    $('sheet-form').requestSubmit();
    await settle(600);
    const newOne = state.playlists.find((x) => x.name === '冒烟点击新建');
    p2 = newOne ? newOne.id : null;
    out.newPlaylistCreated = Boolean(p2);
    // iPhone 的 alert 关掉后仍在 sheet 里，并且刚才那首已经进去了
    out.newPlaylistHasTrack = Boolean(newOne && newOne.songs.some((t) => t.rawID === probeA.rawID));
    out.addSheetReopened = vis('sheet') && $('sheet-title').textContent === '添加到歌单';

    const checkedCount = () => document.querySelectorAll('#sheet-body .check[data-on]').length;
    const checkedBefore = checkedCount();
    clickDom(document.querySelector(`#sheet-body [data-sheet-toggle="${p2}"]`));
    await settle(600);
    out.retapRemoves = checkedBefore === 2 && checkedCount() === 1;

    clickDom($('sheet')); // 点遮罩关闭
    await settle();
    out.sheetClosed = vis('sheet') === false;

    clickDom(document.querySelector('#screen [data-pl-menu]'));
    await settle();
    clickDom(document.querySelector('#screen [data-remove-playlist]'));
    await settle(600);
    out.deletedFromMenu = true;
    out.playlistDeleted = !state.playlists.some((x) => x.id === p1) && parsePage(pageRef()).name !== 'playlist';

    // 重新排序：⋯ → 重新排序 → ▲/▼ → 完成 → 落盘顺序真的变了
    const created2 = await api.playlists.create('冒烟点击歌单');
    if (created2.ok) {
      const p3 = created2.value.id;
      await api.playlists.addSong(p3, probeA);
      await api.playlists.addSong(p3, probeB);
      await reloadPlaylists();
      await loadPlaylistView(p3);
      state.stacks.library = ['root', `playlist:${p3}`];
      render();
      clickDom(document.querySelector('#screen [data-pl-menu]'));
      await settle();
      out.reorderMenuItem = clickDom(document.querySelector('#screen [data-reorder]'));
      await settle();
      out.reorderSheet = vis('sheet') && $('sheet-title').textContent === '调整播放顺序';
      // 用数组比较，别 join 之后再比 —— 字符串下标取的是字符，before[0] 会变成「点」这种字，断言假失败
      const before = state.playlistView.songs.map((t) => t.title);
      clickDom(document.querySelector('#sheet-body [data-move="1:-1"]'));
      await settle(500);
      const after = state.sheet.songs.map((t) => t.title);
      out.rows = [before.join('|'), after.join('|')];
      out.moved = before.length === 2 && after.length === 2 && before[0] === after[1] && before[1] === after[0];
      clickDom(document.querySelector('#sheet-body [data-sheet-done]'));
      await settle(600);
      const persisted = await api.playlists.get(p3);
      out.orderPersisted = persisted.ok && persisted.value.songs.map((t) => t.title).join('|') === out.rows[1];

      // 从歌单里移除一首（行内 ⋯ → 从歌单中移除）
      await loadPlaylistView(p3);
      render();
      clickDom(document.querySelector('#screen [data-row-menu]'));
      await settle();
      out.removeMenuItem = clickDom(document.querySelector('#sheet-body [data-row-act="remove-from-pl"]'));
      await settle(600);
      const afterRemove = await api.playlists.get(p3);
      out.songRemoved = afterRemove.ok && afterRemove.value.songs.length === 1;
      await api.playlists.remove(p3);
    }

    // 批量选择条：进入选择 → 全选 → 加入队列 → 取消
    const created3 = await api.playlists.create('冒烟点击歌单');
    if (created3.ok) {
      const p4 = created3.value.id;
      await api.playlists.addSong(p4, probeA);
      await api.playlists.addSong(p4, probeB);
      await reloadPlaylists();
      await loadPlaylistView(p4);
      state.stacks.library = ['root', `playlist:${p4}`];
      render();
      clickDom(document.querySelector('#screen [data-pl-menu]'));
      await settle();
      clickDom(document.querySelector('#screen [data-select-mode]'));
      await settle();
      out.batchShown = vis('batch-bar') && /已选择 0 首/.test($('batch-count').textContent);
      clickDom(document.querySelector('#batch-bar [data-batch="all"]'));
      await settle();
      out.batchAllSelected = /已选择 2 首/.test($('batch-count').textContent);
      const queueBefore = state.queue.length;
      clickDom(document.querySelector('#batch-bar [data-batch="queue"]'));
      await settle(400);
      out.batchQueued = state.queue.length === queueBefore + 2;
      clickDom(document.querySelector('#batch-bar [data-batch="cancel"]'));
      await settle();
      out.batchCancelled = vis('batch-bar') === false;
      await api.playlists.remove(p4);
    }

    // 播放浮层：打开 → 歌词槽 → 队列槽 → 收起
    openPlayer();
    await settle();
    out.playerOpens = vis('player');
    clickDom(document.querySelector('[data-toggle-view="lyrics"]'));
    await settle();
    out.lyricsSlot = vis('lyrics') && $('s-lyrics').classList.contains('on');
    // 歌词的几何：不能盖住播放按钮，也不能盖住 tab bar（v1.9.16 实机就是这两处糊了）
    const geo = playerGeometry();
    out.lyricsStaysAboveControls = geo.lyricsStaysAboveControls;
    out.lyricsStaysAboveTabbar = geo.lyricsStaysAboveTabbar;
    out.playButtonClickable = geo.playButtonClickable;
    out.tabbarNotUnderLyrics = geo.tabbarNotUnderLyrics;
    out.lyricsGeometry = geo.detail;
    // 关掉歌词，封面必须回到原来那一档
    clickDom(document.querySelector('[data-toggle-view="lyrics"]'));
    await settle();
    out.artReturnsWhenLyricsOff = vis('lyrics') === false && getComputedStyle(document.querySelector('.art-area')).display !== 'none';
    clickDom(document.querySelector('[data-toggle-view="lyrics"]'));
    await settle();
    clickDom(document.querySelector('[data-toggle-view="queue"]'));
    await settle();
    out.queueSlot = vis('queue-sheet') && state.queue.length > 0 && document.querySelectorAll('#qs-body .q-row').length > 0;
    clickDom(document.querySelector('[data-close-player]'));
    await settle();
    out.playerCloses = vis('player') === false;
    // 收干净之后，所有带 hidden 的浮层都必须真的不可见（CSS 优先级回归的哨兵）
    out.noOverlayLeaks = overlayLeaks().length === 0;
    out.leakedIds = overlayLeaks();

    out.errors = smokeErrors.slice(-6);
    out.ok = Object.keys(out)
      .filter(
        (k) =>
          k !== 'ok' &&
          k !== 'rows' &&
          k !== 'diag' &&
          k !== 'errors' &&
          k !== 'swept' &&
          k !== 'leakedIds' &&
          k !== 'lyricsGeometry'
      )
      .every((k) => out[k] === true);
    return out;
  } finally {
    closeSheet();
    closePlayer();
    state.menu = null;
    state.selection = null;
    await restoreQueue(qSnap);
    if (p2) await api.playlists.remove(p2);
    await api.playlists.remove(p1); // 删除那一步没走通时也要清干净；已删则返回 ok:false，不抛
    restoreNav(snap);
    out.swept = await sweepSmokeProbes();
  }
}

/* ── 启动 ─────────────────────────────── */

api.sources.onVerdict((v) => {
  if (!v || !v.id) return;
  state.cloud.verdicts[v.id] = v;
  if (parsePage(pageRef()).name === 'lines') render();
});

// 服务端改了音源（revision 变）会推这一条：清单、线路表、首页文案一起跟着换。
api.cloud.onUpdated((payload) => {
  state.cloud.config = (payload && payload.config) || state.cloud.config;
  if (payload && payload.settings) state.cloud.settings = payload.settings;
  api.sources.list().then((list) => {
    state.sources = list;
    render();
  });
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
  state.theme = { mode: 'automatic', accent: '', coverDriven: true, lyricScale: 1, resolvedAccent: '', ...(settings.theme || {}) };
  state.searchHistory = settings.searchHistory || [];

  // 云端音源：先用本机缓存那份把界面画出来（首页文案要用它），再去问服务端有没有新版。
  await loadCloudConfig();
  if (!meta.smoke) refreshCloudSources().catch(() => null);
  state.queue = (queue && queue.items) || [];
  state.index = queue && queue.items && queue.items.length ? Math.min(queue.index || 0, queue.items.length - 1) : -1;
  state.order = buildOrder(state.queue.length, Math.max(0, state.index), Boolean(player.shuffle));
  state.volume = player.volume ?? 0.8;
  state.repeat = player.repeat || 'off';
  state.shuffle = Boolean(player.shuffle);
  audio.volume = state.volume;
  $('c-volume').value = String(state.volume);

  applyAppearance();
  if (state.index >= 0) setPlayerMeta(state.queue[state.index], null);
  render();

  if (meta.smoke) {
    // 主进程会发 smoke:run；这里把渲染层真实状态报回去
    api.onSmokeRun(async ({ keyword, phase }) => {
      try {
        if (phase === 'shell-pages') return api.smokeReport(await smokeShellPages());
        if (phase === 'home-view') return api.smokeReport(await smokeHomeView());
        if (phase === 'cloud-sources') return api.smokeReport(await smokeCloudSources());
        if (phase === 'cloud-sources-cleanup') return api.smokeReport(await smokeCloudSourcesCleanup());
        if (phase === 'playlist-ui') return api.smokeReport(await smokePlaylistUI());
        if (phase === 'player-shot') return api.smokeReport(await smokePlayerShot());
        if (phase === 'lyrics-shot') return api.smokeReport(await smokeLyricsShot());
        if (phase === 'taskbar-strip-push') return api.smokeReport(await smokeTaskbarStripPush());
        if (phase === 'playlist-cleanup') return api.smokeReport(await smokePlaylistCleanup());
        if (phase === 'playlist-clicks') return api.smokeReport(await smokePlaylistClicks());
        return api.smokeReport(await smokeShellSearch(keyword));
      } catch (error) {
        return api.smokeReport({ ok: false, note: String((error && error.stack) || error).split('\n').slice(0, 4).join(' | ') });
      }
    });
  }
})();



