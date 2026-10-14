'use strict';
/**
 * Primuse Windows 版主进程。
 *
 * 这不是 HALO 网页的壳：默认不加载任何远程页面（`loadFile` 本地渲染层），
 * App 内也没有账号体系 —— 与 iPhone/macOS 版一致，登录只发生在"添加需要鉴权的
 * 音源"这一步（道理鱼的 /api/auth/login），由用户在"来源"页自己填。
 *
 * 界面结构照的是 **iPhone 版**：单列内容 + 底部四个 tab（首页/资料库/搜索/设置）
 * + tab 上方一条胶囊迷你播放器 + 全屏播放浮层（覆盖层，不是路由），来源与同步都在
 * 设置里。对应 Swift 侧 `ContentView.swift:579-617`、`MiniPlayerView.swift`、
 * `NowPlayingView.swift`。以前那套 macOS 三栏（侧栏 + 详情 + 常驻播放条）已整块废弃。
 */

const path = require('path');
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, globalShortcut, dialog } = require('electron');

const aggregated = require('./aggregated');
const cloudSources = require('./cloud-sources');
const { DaoLiYuClient, originOf } = require('./daoliyu');
const store = require('./store');
const sync = require('./sync');
const { startProxy } = require('./proxy');

const SMOKE = process.argv.includes('--primuse-smoke');
const packageJson = require('../../package.json');
// 打包版里 __dirname 在 app.asar 内不可写，所以报告与截图一律写到系统临时目录
const OUT_DIR = process.env.PRIMUSE_SMOKE_OUT || path.join(app.getPath('temp'), 'primuse-smoke');

let mainWindow = null;
let tray = null;
let proxy = null;
let isQuitting = false;
let smokeUIState = null;

const dlyClients = new Map();

function clientFor(sourceID) {
  const config = store.servers.full(sourceID);
  if (!config) throw new Error('找不到该服务器源，请重新添加');
  const signature = `${config.host}|${config.port || ''}|${config.useSSL ? 1 : 0}|${config.basePath || ''}|${config.username}|${config.insecureTLS ? 1 : 0}`;
  const existing = dlyClients.get(sourceID);
  if (existing && existing.signature === signature) return existing.client;
  const client = new DaoLiYuClient(config);
  client.signature = signature;
  dlyClients.set(sourceID, client);
  return client;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// MARK: - 数据层能力（IPC 与本地代理共用）

async function resolveStreamURL(track, force = false) {
  if (!track) throw new Error('缺少曲目信息');
  // 从别的设备同步下来的歌单里可能有"本机没有那台服务器源"的曲目。
  // 同步的是歌单结构不是歌曲源，所以这里必须给可读原因，不能让它变成一句 "播放失败"。
  if (track.unresolved) {
    throw new Error(`这首歌来自其它设备的音源${track.sourceName ? `（${track.sourceName}）` : ''}，本机没有对应线路，无法播放`);
  }
  if (track.kind === 'server') {
    const client = clientFor(track.sourceID);
    return {
      kind: 'server',
      url: `${proxy.baseUrl}/stream/dly/${encodeURIComponent(track.sourceID)}/${encodeURIComponent(track.rawID)}`,
      client,
    };
  }
  const url = await aggregated.resolveStreamURL(store.aggregated.list(), track.platform, track.rawID, force, hooksFor(track));
  return { kind: 'aggregated', url, proxied: `${proxy.baseUrl}/stream/agg/${track.platform}/${encodeURIComponent(track.rawID)}${force ? '?force=1' : ''}` };
}

/**
 * 云端清单里的洛雪 js 源（protocolType==='lxjs'）本机跑不了脚本，搜索/取流/歌词都得经
 * /api/music-gateway；hooksFor 就是这个开关 —— 没有云端 lxjs 源时返回空对象，
 * 行为和以前一字不差（内置 9 条线路全部本机直连）。
 * prefer：这首歌是哪条线搜到的就先问哪条线要直链。
 */
function hooksFor(track) {
  const hooks = cloudSources.hooks();
  if (track && track.sourceId) hooks.prefer = track.sourceId;
  return hooks;
}

/**
 * 给渲染层的云端音源快照：清单状态 + 服务端设置（首页文案，需求 5）+ 可用源。
 * 渲染层拿不到清单正文，也不该拿 —— 它只要这几样就能把界面画对。
 */
function cloudPayload() {
  const man = cloudSources.manifest() || {};
  return {
    config: cloudSources.config(),
    settings: man.settings || null,
    usable: man.usable || [],
    contract: man.contract || null,
  };
}

/* 需求 4「支持实时更新音乐源」：开机拉一次，之后每 15 分钟拿 ETag 问一次 ——
   没变化服务端回 304，几百字节，不打扰第三方站点；有变化就把新清单推给渲染层。
   拉不到（断网 / CF 抖）不动本机那份：上一次检到能出声的线路照样能播。 */
const CLOUD_POLL_MS = 15 * 60 * 1000;
function startCloudSourceSync() {
  const tick = async () => {
    const out = await cloudSources.refresh({ force: false }).catch(() => null);
    if (out && out.ok && out.changed) send('cloud:updated', cloudPayload());
  };
  tick();
  setInterval(tick, CLOUD_POLL_MS);
}

async function trackLyrics(track) {
  if (!track) return null;
  if (track.kind === 'server') {
    const detail = await clientFor(track.sourceID).trackDetail(track.rawID);
    if (!detail) return null;
    // preferredLyrics：逐字优先（DaoLiYuSource.swift:362-368）
    return detail.syncedLyrics || detail.plainLyrics || null;
  }
  return aggregated.resolveLyrics(store.aggregated.list(), track.platform, track.rawID, hooksFor(track));
}

// MARK: - IPC

function registerIpc() {
  ipcMain.handle('meta:get', () => ({
    version: app.getVersion(),
    build: packageJson.buildNumber || packageJson.version,
    platform: 'win32',
    proxyBaseUrl: proxy ? proxy.baseUrl : null,
    credentialsEncrypted: store.credentialsAvailable(),
    smoke: SMOKE,
  }));

  // 在线聚合线路。增删改在 cf-sync-server 后台（清单里没下发编辑接口），本机只读 + 刷新。
  ipcMain.handle('sources:list', () => store.aggregated.list());
  ipcMain.handle('sources:toggle', (_e, id) => store.aggregated.toggle(id));
  ipcMain.handle('sources:upsert', (_e, source) => store.aggregated.upsert(source));
  ipcMain.handle('sources:remove', (_e, id) => store.aggregated.remove(id));
  ipcMain.handle('sources:reset', () => store.aggregated.reset());

  // 「检测全部可用」（需求 2）。以前这条叫"检测全部延迟"，HEAD 通了就绿灯 ——
  // 能访问不等于能播放，一定要能播放的源才有价值。现在的判据和服务端一致：
  // 搜索 → 解析直链 → Range 真取 64KB 字节看魔数；洛雪 js 源本机跑不了脚本，
  // 就用服务端体检下发的结论，并如实标 origin:'server'。
  ipcMain.handle('sources:checkAll', async () => {
    await cloudSources.refresh({ force: true }).catch(() => null); // 先把服务端的最新结论拉下来
    const verdicts = await cloudSources.checkAll(store.aggregated.list(), (v) => send('sources:verdict', v));
    return { verdicts, sources: store.aggregated.list(), ...cloudPayload() };
  });

  // 云端音乐源：客户端只需要保存这一个 URL（需求 4）。
  // 载荷带上 settings（首页文案，需求 5）与 usable（可用源），渲染层不用再去解清单正文。
  ipcMain.handle('cloud:config', () => cloudPayload());
  ipcMain.handle('cloud:refresh', async (_e, { force } = {}) => {
    const out = await cloudSources.refresh({ force: Boolean(force) });
    if (out.ok && out.changed) send('cloud:updated', cloudPayload());
    return { ...out, ...cloudPayload() };
  });
  ipcMain.handle('cloud:setURL', (_e, url) => {
    try {
      const config = cloudSources.setManifestURL(url);
      return { ok: true, config };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // 搜索：主进程并发打线路，渐进推给渲染层（对应 Swift 的流式上屏）
  ipcMain.handle('search:aggregated', async (_e, { keyword, requestId }) => {
    try {
      const items = await aggregated.searchAll(store.aggregated.list(), keyword, (partial, progress) => {
        send('search:partial', { requestId, items: partial, progress });
      }, cloudSources.hooks());
      return { ok: true, requestId, items };
    } catch (error) {
      return { ok: false, requestId, error: error.message, items: [] };
    }
  });

  ipcMain.handle('playback:resolve', async (_e, { track, force }) => {
    try {
      const resolved = await resolveStreamURL(track, force);
      // 服务器源与需要自定义头的线路一律走本地代理；聚合裸链同样走代理，
      // 这样 Range、UA、Referer 与失败重试都只有一条路径，行为可预期。
      const url = resolved.kind === 'server' ? resolved.url : resolved.proxied;
      return { ok: true, url, upstream: resolved.url, kind: resolved.kind };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('playback:lyrics', async (_e, { track }) => {
    try {
      return { ok: true, lrc: await trackLyrics(track) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // 服务器型源（道理鱼）
  ipcMain.handle('server:list', () => store.servers.list());
  ipcMain.handle('server:upsert', (_e, config) => store.servers.upsert(config));
  ipcMain.handle('server:remove', (_e, id) => {
    dlyClients.delete(id);
    return store.servers.remove(id);
  });
  ipcMain.handle('server:test', async (_e, { config }) => {
    // 表单里未保存的连线：用一次性客户端试；已保存的：复用（但强制重登一次拿真实结论）
    try {
      const probe = config.unsaved
        ? new DaoLiYuClient({ ...config, id: config.id || 'probe' })
        : clientFor(config.id);
      return { ok: true, ...(await probe.test()) };
    } catch (error) {
      if (config.id) dlyClients.delete(config.id);
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('server:tracks', async (_e, { sourceID, skip, take }) => {
    try {
      const page = await clientFor(sourceID).listTracks(skip, take);
      return { ok: true, ...page };
    } catch (error) {
      return { ok: false, error: error.message, items: [], total: 0 };
    }
  });

  // 本地资料库（收藏 / 历史 / 队列 / 播放器状态）
  ipcMain.handle('library:favorites', () => store.library.favorites());
  ipcMain.handle('library:toggleFavorite', (_e, track) => ({
    favorites: store.library.toggleFavorite(track),
    isFavorite: store.library.isFavorite(track),
  }));
  ipcMain.handle('library:history', () => store.library.history());
  ipcMain.handle('library:pushHistory', (_e, { track, playedSeconds }) => store.library.pushHistory(track, playedSeconds));
  ipcMain.handle('library:clearHistory', () => store.library.clearHistory());
  ipcMain.handle('queue:save', (_e, queue) => store.library.saveQueue(queue));
  ipcMain.handle('queue:load', () => store.library.queue());
  ipcMain.handle('player:save', (_e, patch) => store.library.setPlayer(patch));
  ipcMain.handle('player:load', () => store.library.player());
  ipcMain.handle('settings:save', (_e, patch) => store.library.setSettings(patch));
  ipcMain.handle('settings:load', () => store.library.settings());

  // 歌单（含系统歌单「我喜欢」= primuse.system.liked）
  const guard = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  ipcMain.handle('playlist:list', () => guard(() => store.playlists.list()));
  ipcMain.handle('playlist:get', (_e, id) => guard(() => store.playlists.get(id)));
  ipcMain.handle('playlist:create', (_e, name) => guard(() => store.playlists.create(name)));
  ipcMain.handle('playlist:rename', (_e, { id, name }) => guard(() => store.playlists.rename(id, name)));
  ipcMain.handle('playlist:remove', (_e, id) => guard(() => store.playlists.remove(id)));
  ipcMain.handle('playlist:addSong', (_e, { id, track }) => guard(() => store.playlists.add(id, track)));
  ipcMain.handle('playlist:toggleSong', (_e, { id, track }) => guard(() => store.playlists.toggle(id, track)));
  ipcMain.handle('playlist:removeSong', (_e, { id, track }) => guard(() => store.playlists.removeSong(id, track)));
  ipcMain.handle('playlist:move', (_e, { id, from, to }) => guard(() => store.playlists.move(id, from, to)));
  ipcMain.handle('playlist:belongsTo', (_e, track) =>
    guard(() => store.playlists.list().filter((p) => store.playlists.contains(p.id, track)).map((p) => p.id))
  );

  // 云端同步：备份 / 恢复 / 设备列表 / 跨设备导入（契约见 src/main/sync.js 顶部注释）
  ipcMain.handle('sync:config', () => store.sync.config());
  ipcMain.handle('sync:setServerURL', (_e, url) => {
    try {
      return { ok: true, config: store.sync.setServerURL(url) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('sync:setDeviceName', (_e, name) => ({ ok: true, config: store.sync.setDeviceName(name) }));
  ipcMain.handle('sync:backup', async () => {
    try {
      return { ok: true, data: await sync.backup() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('sync:restore', async () => {
    try {
      return { ok: true, data: await sync.restore() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('sync:devices', async () => {
    try {
      return { ok: true, devices: await sync.devices() };
    } catch (error) {
      return { ok: false, error: error.message, devices: [] };
    }
  });
  ipcMain.handle('sync:import', async (_e, deviceId) => {
    try {
      return { ok: true, data: await sync.importFromDevice(deviceId) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('sync:export', async (_e, playlist) => {
    // 「导出」：把歌单存成本机 JSON（结构走云端同一套字段，方便和 iPhone 的备份互换）
    const safeName = String(playlist?.name || 'playlist').replace(/[\\/:*?"<>|]/g, '_');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出歌单',
      defaultPath: `${safeName}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      require('fs').writeFileSync(filePath, JSON.stringify({ playlists: [playlist] }, null, 2), 'utf8');
      return { ok: true, filePath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('sync:importFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '从文件导入歌单',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const raw = JSON.parse(require('fs').readFileSync(filePaths[0], 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.playlists || [];
      const incoming = list.map(sync.fromWirePlaylist).filter((p) => p.name);
      return { ok: true, data: store.playlists.mergeIncoming(incoming) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
  });

  ipcMain.on('smoke:ui', (_e, state) => {
    smokeUIState = state;
  });
}

// MARK: - 窗口

function createWindow() {
  // 纵向单列、宽度贴着 iPhone 的内容列（styles.css 的 --col:620px）。
  // 以前默认 1360×860 是把 iPhone 版面塞进横屏桌面壳，左右大片留白，观感完全不是原版。
  mainWindow = new BrowserWindow({
    width: 560,
    height: 920,
    minWidth: 400,
    minHeight: 620,
    title: 'Primuse',
    backgroundColor: '#0f1013',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../renderer/icon.png'), // 不能用 build/icon.png：build/ 不进 asar
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { noCached: true });

  mainWindow.on('close', (event) => {
    const settings = store.library.settings();
    if (!isQuitting && settings.minimizeToTray !== false && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!SMOKE) {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log('[renderer]', message);
    });
  }
}

function buildMenu() {
  const template = [
    {
      label: '播放',
      submenu: [
        { label: '播放 / 暂停', accelerator: 'Space', click: () => send('player:command', 'toggle') },
        { label: '上一曲', accelerator: 'Ctrl+Left', click: () => send('player:command', 'previous') },
        { label: '下一曲', accelerator: 'Ctrl+Right', click: () => send('player:command', 'next') },
        { type: 'separator' },
        { label: '加入收藏', accelerator: 'Ctrl+L', click: () => send('player:command', 'favorite') },
        { label: '队列', accelerator: 'Ctrl+Q', click: () => send('player:command', 'queue') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '未签名包说明',
          click: () => shell.openExternal('https://github.com/narci2018/Primuse-halo-plus'),
        },
        { label: '关于 Primuse', click: () => mainWindow?.showMessageBox({
          type: 'info',
          title: 'Primuse',
          message: `Primuse 桌面版 ${app.getVersion()}`,
          detail: '与 iPhone / macOS 版同一套音源契约：内置聚合线路开箱可搜可播，服务器型源在"来源"页自填。\n本 App 没有账号体系，也没有登录墙。',
        }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* 运行时图标（src/renderer/icon.png，由 scripts/make-icon.js 生成）。
 * asar 里 nativeImage.createFromPath 偶尔解不出来，退回 createFromBuffer 再读一次。 */
function appIconImage() {
  const p = path.join(__dirname, '../renderer/icon.png');
  let image = nativeImage.createFromPath(p);
  if (image.isEmpty()) {
    try {
      image = nativeImage.createFromBuffer(require('fs').readFileSync(p));
    } catch (error) {
      console.warn('[icon] 读不到 src/renderer/icon.png：', error.message);
    }
  }
  return image;
}

function createTray() {
  try {
    const image = appIconImage().resize({ width: 16, height: 16 });
    if (image.isEmpty()) console.warn('[tray] 图标是空的，托盘将不可见 —— 跑一次 scripts/make-icon.js');
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip('Primuse');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 Primuse', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { label: '播放 / 暂停', click: () => send('player:command', 'toggle') },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ])
    );
    tray.on('click', () => (mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show()));
  } catch (error) {
    console.warn('[tray] 不可用', error.message);
  }
}

function registerMediaKeys() {
  const map = {
    MediaPlayPause: 'toggle',
    MediaNextTrack: 'next',
    MediaPreviousTrack: 'previous',
  };
  for (const [accelerator, command] of Object.entries(map)) {
    try {
      globalShortcut.register(accelerator, () => send('player:command', command));
    } catch {
      /* 某些环境没有媒体键，忽略 */
    }
  }
}

// MARK: - 冒烟自检（CI / 本机验收用，不进正式包的行为路径）

async function runSmoke() {
  const report = { startedAt: new Date().toISOString(), steps: [], ui: null, errors: [] };
  const step = (name, ok, detail) => report.steps.push({ name, ok, detail });

  try {
    // 图标：用户报"最小化到任务栏后是白色图片，看不到任何东西"。病根不是没设图标，
    // 是素材用错了来源 —— build/icon.png 直接拿的 iPhone 主图标，而 iOS 规范要求
    // 1024 full-bleed **不透明** RGB（白底黑音符）；深色任务栏上那就是一块白板。
    // 断言只看真正渲染出来的像素：四角必须真透明、不透明像素的平均亮度必须低
    //（旧的白底图这一步是 250 左右，一眼就能区分）。
    const iconImage = appIconImage();
    const iconSize = iconImage.getSize();
    const bmp = iconImage.toBitmap(); // BGRA，行优先、自上而下
    const px = (x, y) => {
      const i = (y * iconSize.width + x) * 4;
      return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i], a: bmp[i + 3] };
    };
    const corners = [
      px(1, 1),
      px(iconSize.width - 2, 1),
      px(1, iconSize.height - 2),
      px(iconSize.width - 2, iconSize.height - 2),
    ];
    let lumaSum = 0;
    let lumaCount = 0;
    for (let i = 0; i + 3 < bmp.length; i += 4) {
      if (bmp[i + 3] < 200) continue;
      lumaSum += 0.299 * bmp[i + 2] + 0.587 * bmp[i + 1] + 0.114 * bmp[i];
      lumaCount += 1;
    }
    const meanLuma = lumaCount ? lumaSum / lumaCount : 0;
    const icoPath = path.join(__dirname, '../../build/icon.ico');
    let icoNote = 'build/icon.ico 不在本机（CI 里正常，exe 图标由打包阶段写入）';
    if (require('fs').existsSync(icoPath)) {
      const ico = require('fs').readFileSync(icoPath);
      const frames = ico.readUInt16LE(4);
      const sizes = [];
      for (let f = 0; f < frames; f += 1) {
        const w = ico.readUInt8(6 + f * 16) || 256;
        sizes.push(w);
      }
      icoNote = `icon.ico ${frames} 帧 ${sizes.join('/')} · ${(ico.length / 1024).toFixed(0)}KB`;
      step(
        '桌面图标：深色底 + 四角透明 + ICO 含 256 帧（不再是 iOS 那张白底图）',
        iconSize.width >= 256 && corners.every((c) => c.a === 0) && meanLuma < 120 && sizes.includes(256),
        `src/renderer/icon.png ${iconSize.width}x${iconSize.height} · 四角 alpha ${corners
          .map((c) => c.a)
          .join('/')} · 不透明像素平均亮度 ${meanLuma.toFixed(0)}（旧白底图 ≈250）· ${icoNote}`
      );
    } else {
      step(
        '桌面图标：深色底 + 四角透明（不再是 iOS 那张白底图）',
        iconSize.width >= 256 && corners.every((c) => c.a === 0) && meanLuma < 120,
        `src/renderer/icon.png ${iconSize.width}x${iconSize.height} · 四角 alpha ${corners
          .map((c) => c.a)
          .join('/')} · 不透明像素平均亮度 ${meanLuma.toFixed(0)}（旧白底图 ≈250）· ${icoNote}`
      );
    }

    const sources = store.aggregated.list();
    step('默认线路数量', sources.length === 9, `实际 ${sources.length} 条（Swift 侧应为 9）`);

    const keyword = '晴天';
    const items = await aggregated.searchAll(sources, keyword);
    const byPlatform = {};
    for (const item of items) byPlatform[item.platform] = (byPlatform[item.platform] || 0) + 1;
    step('聚合搜索有结果', items.length > 0, `共 ${items.length} 条，平台分布 ${JSON.stringify(byPlatform)}`);
    report.search = { keyword, total: items.length, byPlatform, sample: items.slice(0, 5) };

    // 逐个平台验证"能不能拿到音频字节"——用户最在意的事，光有搜索结果不算能播
    const playback = [];
    for (const platform of ['netease', 'qq', 'kugou', 'kuwo']) {
      const candidate = items.find((i) => i.platform === platform);
      if (!candidate) {
        playback.push({ platform, ok: false, error: '该平台本次无搜索结果（线路本身没返回结果，与 iPhone 现状一致）' });
        continue;
      }
      try {
        const url = await aggregated.resolveStreamURL(sources, platform, candidate.rawID);
        const { openStream } = require('./httpx');
        const upstream = await openStream(url, { range: 'bytes=0-65535' });
        const head = upstream.headers;
        let bytes = 0;
        await new Promise((resolve) => {
          upstream.stream.on('data', (c) => (bytes += c.length));
          upstream.stream.on('end', resolve);
          upstream.stream.on('error', resolve);
          setTimeout(() => {
            upstream.stream.destroy();
            resolve();
          }, 6000);
        });
        playback.push({
          platform,
          ok: bytes > 1024,
          title: candidate.title,
          status: upstream.statusCode,
          contentType: head['content-type'],
          bytes,
          host: new URL(url).host,
        });
      } catch (error) {
        playback.push({ platform, ok: false, error: error.message });
      }
    }
    report.playback = playback;
    const playable = playback.filter((p) => p.ok).map((p) => p.platform);
    step('至少一条线路真能出声', playable.length > 0, `可播平台 ${playable.join(',') || '无'}；明细 ${JSON.stringify(playback.map((p) => `${p.platform}:${p.ok ? `${p.bytes}B` : '失败'}`))}`);

    // 本地代理链路（渲染层的 <audio> 实际打的是这个地址，不是上游直链）
    const neteaseItem = items.find((i) => i.platform === 'netease');
    if (neteaseItem) {
      try {
        const proxied = `${proxy.baseUrl}/stream/agg/${neteaseItem.platform}/${encodeURIComponent(neteaseItem.rawID)}`;
        const { openStream } = require('./httpx');
        const upstream = await openStream(proxied, { range: 'bytes=0-4095' });
        let bytes = 0;
        await new Promise((resolve) => {
          upstream.stream.on('data', (c) => (bytes += c.length));
          upstream.stream.on('end', resolve);
          upstream.stream.on('error', resolve);
          setTimeout(() => {
            upstream.stream.destroy();
            resolve();
          }, 8000);
        });
        step('本地代理 Range 透传', bytes > 1024, `${upstream.statusCode} ${upstream.headers['content-type']} ${bytes}B via ${new URL(proxied).host}`);
        report.proxy = { url: proxied, status: upstream.statusCode, bytes };
      } catch (error) {
        step('本地代理 Range 透传', false, error.message);
      }
    }

    const lyrics = await aggregated.resolveLyrics(sources, 'netease', (items.find((i) => i.platform === 'netease') || {}).rawID || '');
    step('网易歌词', Boolean(lyrics && lyrics.includes('[')), lyrics ? `LRC ${lyrics.length} 字符` : '无');

    // 本地库持久化：iPhone 侧靠 GRDB，Windows 首版靠 userData 下的 JSON。
    // "关掉再打开还记不记得住"必须在发版前有机器证据，而不是等用户重启发现队列空了。
    try {
      const fs = require('fs');
      const dataFile = path.join(app.getPath('userData'), 'primuse.json');
      const credsFile = path.join(app.getPath('userData'), 'credentials.json');
      const probe = { kind: 'aggregated', platform: 'netease', rawID: 'smoke-probe-0', title: '冒烟探针' };
      const serverID = `dly-smoke-${Date.now().toString(36)}`;
      store.library.toggleFavorite(probe);
      store.library.pushHistory(probe, 42);
      store.library.saveQueue({ items: [probe], index: 0, position: 12.5 });
      store.library.setPlayer({ volume: 0.42, repeat: 'one' });
      store.servers.upsert({
        id: serverID, kind: 'daoliyu', name: '冒烟道理鱼', host: '127.0.0.1', port: 8080,
        useSSL: false, basePath: '/', username: 'smoke@example.com', password: 'smoke-secret-1',
      });
      store.save(true); // 立刻落盘，不等 250ms 防抖

      const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      const credsRaw = fs.existsSync(credsFile) ? JSON.parse(fs.readFileSync(credsFile, 'utf8')) : {};
      const libOk = {
        收藏: onDisk.favorites.some((t) => t.rawID === probe.rawID),
        历史: onDisk.history.some((t) => t.rawID === probe.rawID && t.playedSeconds === 42),
        队列: onDisk.queue.items.some((t) => t.rawID === probe.rawID) && onDisk.queue.position === 12.5,
        播放器: onDisk.player.volume === 0.42 && onDisk.player.repeat === 'one',
      };
      const srvPersisted = onDisk.serverSources.some((s) => s.id === serverID);
      const canDecrypt = (store.servers.full(serverID) || {}).password === 'smoke-secret-1';
      const noPlainInMain = !JSON.stringify(onDisk).includes('smoke-secret-1');
      const cipherOnly = Boolean(credsRaw[serverID] && credsRaw[serverID].encrypted) && !JSON.stringify(credsRaw).includes('smoke-secret-1');
      step('本地库持久化', Object.values(libOk).every(Boolean), JSON.stringify(libOk));
      step(
        '道理鱼凭据只进 DPAPI（safeStorage）',
        srvPersisted && canDecrypt && noPlainInMain && cipherOnly,
        `源已存 ${srvPersisted}；密码可解密回读 ${canDecrypt}；主 JSON 无明文 ${noPlainInMain}；凭据文件为密文 ${cipherOnly}；safeStorage 可用 ${store.credentialsAvailable()}`
      );

      // 探针数据不许留在用户的库里
      store.library.toggleFavorite(probe);
      const state = store.load();
      state.history = state.history.filter((t) => t.rawID !== probe.rawID);
      state.queue = { items: [], index: 0, position: 0 };
      store.servers.remove(serverID);
      store.save(true);
      const after = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      step('冒烟探针已清理', !after.favorites.some((t) => t.rawID === probe.rawID) && !after.serverSources.some((s) => s.id === serverID),
        `收藏 ${after.favorites.length} 服务器源 ${after.serverSources.length}`);
    } catch (error) {
      step('本地库持久化', false, error.message);
    }

    // 歌单：CRUD、系统歌单「我喜欢」、以及云端映射（同步的是歌单结构，不是歌曲源）
    try {
      const fs = require('fs');
      const dataFile = path.join(app.getPath('userData'), 'primuse.json');
      const trackA = { kind: 'aggregated', platform: 'netease', rawID: '31477687', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269 };
      const trackB = { kind: 'aggregated', platform: 'qq', rawID: '004TXgZ41ST7lB', title: '黄昏', artist: '落日微醺', duration: 245.28 };

      const created = store.playlists.create('冒烟歌单');
      store.playlists.add(created.id, trackA);
      store.playlists.add(created.id, trackB);
      store.playlists.add(created.id, trackB); // 重复加入应被 trackKey 去掉
      store.playlists.rename(created.id, '冒烟歌单改名');
      store.playlists.move(created.id, 1, 0);

      const likedBefore = store.library.favorites().length;
      store.library.toggleFavorite(trackA); // 收藏 = 写进 primuse.system.liked
      const liked = store.playlists.get(store.LIKED_PLAYLIST_ID);

      const wire = sync.localPlaylistSnapshot();
      const likedWire = wire.find((p) => p.id === store.LIKED_PLAYLIST_ID);
      const songWire = likedWire && likedWire.songs[0];
      const roundTrip = songWire ? sync.fromWireSong(songWire) : null;

      store.save(true);
      const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      const persisted = (onDisk.playlists || []).find((p) => p.name === '冒烟歌单改名');

      step(
        '歌单 CRUD + 落盘',
        Boolean(persisted) && persisted.songs.length === 2 && persisted.songs[0].rawID === trackB.rawID,
        `成员 ${persisted ? persisted.songs.length : '未落盘'} 首，重排后第一首 ${persisted ? persisted.songs[0].title : '-'}`
      );
      step(
        '「我喜欢」= 系统歌单 primuse.system.liked',
        Boolean(liked) && liked.id === 'primuse.system.liked' && liked.songs.length === likedBefore + 1 && store.library.isFavorite(trackA),
        `收藏数 ${liked ? liked.songs.length : '-'}（原有 ${likedBefore}）`
      );
      step(
        '云端映射：agg_{platform}_{id} 与 /aggregated/… 可往返',
        Boolean(songWire) && songWire.id === `agg_${trackA.platform}_${trackA.rawID}` && songWire.filePath === `/aggregated/${trackA.platform}/${trackA.rawID}.mp3` && songWire.sourceId === 'system-aggregated-music' && roundTrip && roundTrip.rawID === trackA.rawID && roundTrip.unresolved === false,
        `上报 id=${songWire ? songWire.id : '-'} filePath=${songWire ? songWire.filePath : '-'}（与 iPhone 实测字段一致）`
      );
      step('同步上报包含自建歌单与我喜欢', wire.some((p) => p.id === created.id) && Boolean(likedWire), `${wire.map((p) => `${p.name}(${p.songs.length})`).join('、')}`);

      // 探针数据不许留在用户库里（含刚收藏的那首）
      store.library.toggleFavorite(trackA);
      store.playlists.remove(created.id);
      store.save(true);
      const after = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      step(
        '歌单冒烟探针已清理',
        !after.playlists.some((p) => p.id === created.id) && store.library.favorites().length === likedBefore,
        `剩余歌单 ${after.playlists.length} 个，收藏 ${store.library.favorites().length} 首`
      );
      // 真网络路径不在冒烟里跑：CI 不许往用户的云端备份里写东西，契约由
      // scripts/playlist-sync-contract-test.js 用本地假服务器覆盖（11 项断言）。
    } catch (error) {
      step('歌单 CRUD + 落盘', false, error.message);
    }

    report.ui = await new Promise((resolve) => {
      // 让渲染层跑一次真实搜索，把它自己看到的 DOM 状态报回来
      send('smoke:run', { keyword: '晴天' });
      const waitStart = Date.now();
      const tick = () => {
        if (smokeUIState) {
          resolve(smokeUIState);
          return;
        }
        if (Date.now() - waitStart > 25000) {
          resolve({ ready: false, note: '渲染层 25s 内未回报状态' });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    });
    const coverOk = Object.values((report.ui && report.ui.coverLoads) || {}).some((v) => String(v).startsWith('ok:'));
    step(
      '渲染层自检',
      Boolean(report.ui && report.ui.ready && report.ui.coverSamples && report.ui.coverSamples.length > 0 && coverOk),
      `${JSON.stringify(report.ui)} —— 封面按平台实测（酷狗那批 meting type=pic 上游返回空 body，属数据源缺陷，与渲染无关）`
    );
    const ui = report.ui || {};
    step(
      'iPhone 外壳已接线（底部四 tab / 胶囊迷你条 / 全屏播放浮层 / 批量条 / 行内 ⋯）',
      Boolean(
        ui.tabs === 4 &&
          ui.tabLabels === '首页·资料库·搜索·设置' &&
          ui.tabIcons === 4 &&
          ui.hasMini &&
          ui.hasPlayerOverlay &&
          ui.playerControls === 5 &&
          ui.playerSlots === 3 &&
          ui.batchButtons === 6 &&
          ui.rowMenus > 0 &&
          ui.hasLoginWall === false &&
          Array.isArray(ui.overlayLeaks) && ui.overlayLeaks.length === 0
      ),
      `tab ${ui.tabs} 个（${ui.tabLabels}，图标 ${ui.tabIcons}）、当前 ${ui.activeTab}、迷你条 ${ui.hasMini}（未播放时隐藏 ${ui.miniHidden}）、` +
        `浮层控件 ${ui.playerControls} + 槽位 ${ui.playerSlots}、批量条按钮 ${ui.batchButtons}、行内「⋯」${ui.rowMenus} 个、登录墙 ${ui.hasLoginWall}、` +
        `该隐藏却糊在页面上的浮层 ${JSON.stringify(ui.overlayLeaks || [])}`
    );

    // 中文输入法：用户报"搜索框切中文输入法打不出字，一闪而过"。病根是组合期
    // （拼音还没上屏）防抖到点触发整屏重绘，把 <input> 节点换掉、TSF 的连接断了。
    // 所以断言看的是**节点身份**：组合期内发生一次 render() 之后，搜索框还得是同一个
    // DOM 节点、值还得在，并且上屏后封锁要自动解除（否则界面永久不再刷新，更糟）。
    const ime = ui.ime || {};
    step(
      '中文输入法组合期不销毁搜索框（拼音不再一闪而过）',
      Boolean(ime.lockBegins && ime.sameNode && ime.valueKept && ime.lockReleased && ime.restored),
      `封锁 ${ime.lockBegins} · 重绘后同一个节点 ${ime.sameNode} · 组合串还在 ${ime.valueKept} · ` +
        `上屏后解除封锁 ${ime.lockReleased} · 探针已复位 ${ime.restored}`
    );

    const image = await mainWindow.webContents.capturePage();
    require('fs').mkdirSync(OUT_DIR, { recursive: true });
    const shotPath = path.join(OUT_DIR, 'smoke-ui.png');
    require('fs').writeFileSync(shotPath, image.toPNG());
    step('搜索页截图', true, shotPath);

    const waitUI = (timeoutMs) =>
      new Promise((resolve) => {
        smokeUIState = null;
        const waitStart = Date.now();
        const tick = () => {
          if (smokeUIState) return resolve(smokeUIState);
          if (Date.now() - waitStart > timeoutMs) return resolve(null);
          setTimeout(tick, 250);
        };
        tick();
      });

    // 首页 / 资料库 / 设置三屏的真实 DOM + 首页实拍。
    send('smoke:run', { keyword: '', phase: 'shell-pages' });
    const pages = (await waitUI(30000)) || { note: '渲染层 30s 内未回报三屏状态' };
    const h = pages.home || {};
    const l = pages.library || {};
    const s = pages.settings || {};
    // 资料库为空时首页是「欢迎 + 去搜索」空壳；有歌时是四个真实分区。两种都算对，
    // 但必须二选一命中 —— 什么都不渲染才算失败。
    const homeHasContent = Boolean(
      (h.sections || []).length >= 4 && (h.sections || []).includes('我的歌单') && (h.sections || []).includes('快捷收藏')
    );
    const pagesOk = Boolean(
      h.title === (h.titleExpected || '首页') &&
        (h.aggregatedCTA || homeHasContent) &&
        l.title === '资料库' &&
        JSON.stringify(l.rows) === JSON.stringify(['歌曲', '专辑', '艺术家', '歌单', '我喜欢', '最近播放', '听歌统计']) &&
        l.icons === 7 &&
        /首歌曲/.test((l.counts || [])[0] || '') &&
        /个歌单/.test((l.counts || [])[3] || '') &&
        s.title === '设置' &&
        ['资料库', '播放', '外观', '同步', '关于'].every((g) => (s.groups || []).includes(g)) &&
        s.rows >= 12 &&
        s.icons === s.rows &&
        s.switches >= 3 &&
        s.volumeSlider &&
        s.loginWall === false &&
        Array.isArray(pages.overlayLeaks) &&
        pages.overlayLeaks.length === 0 &&
        // 关于页的品牌标识：图必须真的解码 + 真的画出来（素材要能从 asar 里读到）
        Boolean(pages.about) &&
        pages.about.logoDecoded === true &&
        pages.about.logoPainted === true &&
        pages.about.title === '关于' &&
        /^\d+$/.test(String(pages.about.buildShown))
    );
    step(
      '首页 / 资料库 / 设置 / 关于四屏渲染（分节、入口、计数、开关、音量、品牌标识）',
      pagesOk,
      JSON.stringify(pages)
    );

    // 关于页此刻就在屏幕上（那个 phase 故意停在关于页收尾）：新加的品牌标识必须
    // 有"人眼看过"的证据，光有 naturalWidth 断言不算数。
    const aboutShot = path.join(OUT_DIR, 'smoke-ui-about.png');
    require('fs').writeFileSync(aboutShot, (await mainWindow.webContents.capturePage()).toPNG());
    step('关于页截图（Free-Narci 标识）', true, aboutShot);

    send('smoke:run', { keyword: '', phase: 'home-view' });
    const hv = (await waitUI(15000)) || { note: '渲染层未回报首页状态' };
    step(
      '放回首页（首页 tab 栈复位、无浮层残留）',
      Boolean(hv.title && hv.title === (hv.expectedTitle || '首页') && Array.isArray(hv.overlayLeaks) && hv.overlayLeaks.length === 0),
      JSON.stringify(hv)
    );

    const homeShot = path.join(OUT_DIR, 'smoke-ui-home.png');
    require('fs').writeFileSync(homeShot, (await mainWindow.webContents.capturePage()).toPNG());
    step('首页截图', true, homeShot);

    // 「聚合音乐源」这一屏（需求 2/4/5 的界面侧证据）。断言只看渲染结果：
    // 清单 URL 真的写在屏幕上、按钮真的画出来了、三种体检结论真的分了三组、
    // "未检出"那一组确实没挂「建议删除」。合成的结论只活在渲染层 state 里，
    // 一条都不许落进 store —— 停线与删除是 CF 后台的权力。
    send('smoke:run', { keyword: '', phase: 'cloud-sources' });
    let cs = (await waitUI(20000)) || {};
    // 等画面真的换成云源页再截图。上一张图里还写着「首页」时，DOM 那边已经断言通过了 ——
    // 组合器提交一帧比 IPC 回一句慢，"截了张旧图"这种证据不如不留。
    for (let i = 0; i < 20; i += 1) {
      const shot = (await mainWindow.webContents.capturePage()).toPNG();
      const png = `data:image/png;base64,${shot.toString('base64')}`;
      const data = await mainWindow.webContents.executeJavaScript(
        `new Promise((r)=>{const im=new Image();im.onload=()=>{const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const x=c.getContext('2d');x.drawImage(im,0,0);r(c.toDataURL('image/png'))};im.onerror=()=>r('');im.src=${JSON.stringify(png)}})`
      );
      const text = await mainWindow.webContents.executeJavaScript(`document.querySelector('#screen') ? document.querySelector('#screen').innerText.slice(0,2000) : ''`);
      cs = { ...cs, _shot: data, _text: text };
      if (String(data).length > 1000 && /聚合音乐源/.test(text) && /〔冒烟〕/.test(text)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const csShotPng = String(cs._shot || '');
    const csShotPage = /聚合音乐源/.test(String(cs._text || ''));
    delete cs._shot;
    delete cs._text;
    const csPage = cs.page || {};
    const csVer = cs.verdicts || {};
    const csHome = cs.homeHeader || {};
    const csOk = Boolean(
      csHome.painted &&
        csHome.shown === csHome.expected &&
        csPage.title === '聚合音乐源' &&
        /^https?:\/\/\S+\/api\/music-sources/.test(csPage.manifestURL || '') &&
        JSON.stringify(csPage.buttons) === JSON.stringify(['检测全部可用', '刷新云端清单']) &&
        csPage.allButtonsPainted === true &&
        csPage.refreshInNav === true &&
        csPage.editControls === 0 && // 需求 3：增删改只在 CF 后台，本机一个编辑控件都不许长出来
        csPage.hintMentionsCF === true &&
        csVer.rowCount === 3 &&
        csVer.iconsPainted === true &&
        JSON.stringify((csVer.ok || {}).capsules) === JSON.stringify(['可播']) &&
        (csVer.ok || {}).painted === true &&
        JSON.stringify((csVer.blind || {}).capsules) === JSON.stringify(['未检出']) && // 盲区不许挂「建议删除」
        (csVer.blind || {}).painted === true &&
        JSON.stringify((csVer.bad || {}).capsules) === JSON.stringify(['建议删除', '不可播']) &&
        (csVer.bad || {}).painted === true &&
        csVer.ok.tone !== csVer.bad.tone &&
        csVer.blind.tone !== csVer.ok.tone &&
        Array.isArray(cs.overlayLeaks) &&
        cs.overlayLeaks.length === 0
    );
    step(
      '聚合音乐源屏渲染：清单 URL / 两个按钮 / 三种结论分组（App 侧只读）',
      csOk,
      JSON.stringify(cs)
    );

    const cloudShot = path.join(OUT_DIR, 'smoke-ui-cloud.png');
    require('fs').writeFileSync(cloudShot, Buffer.from(csShotPng.split(',')[1] || '', 'base64'));
    step(
      '聚合音乐源页截图（画面真的停在云源页，可播 / 未检出 / 建议删除 三种样子都在图上）',
      csShotPage && csShotPng.length > 1000,
      `${cloudShot} · 画面文本命中云源页 ${csShotPage} · PNG ${(csShotPng.length / 1024).toFixed(0)}KB`
    );

    send('smoke:run', { keyword: '', phase: 'cloud-sources-cleanup' });
    const csc = (await waitUI(15000)) || { note: '渲染层未回报云源页清理结果' };
    step(
      '冒烟注入的合成线路收干净（屏幕上一条〔冒烟〕都不留，且无浮层残留）',
      Boolean(csc.leakedSynthetic === false && Array.isArray(csc.overlayLeaks) && csc.overlayLeaks.length === 0),
      JSON.stringify(csc)
    );

    // 第三段：歌单页 / 详情 / ⋯菜单 / 加入弹层 / 同步页的真实 DOM。
    // 前面两张截图是搜索页和首页，证明不了这次新加的主体功能"看得见、点得到"。
    send('smoke:run', { keyword: '', phase: 'playlist-ui' });
    const pui = (await waitUI(45000)) || { ok: false, note: '渲染层 45s 内未回报歌单状态' };
    const puiOk = Boolean(
      pui.ok &&
        pui.list && pui.list.rows >= 1 && pui.list.navItems === 4 && pui.list.upload && pui.list.download &&
        pui.detail && pui.detail.name && pui.detail.caption && pui.detail.playAll && pui.detail.shufflePlay &&
        pui.detail.menuButton && pui.detail.songs === 2 && pui.detail.rowMenu === 2 &&
        pui.menuItems && pui.menuItems.includes('重新排序') && pui.menuItems.includes('删除歌单') &&
        pui.rowSheet && pui.rowSheet.visible && pui.rowSheet.add && pui.rowSheet.fav &&
        pui.sheet && pui.sheet.visible && pui.sheet.title === '添加到歌单' && pui.sheet.createRow && pui.sheet.checked === 1 &&
        pui.syncView && pui.syncView.form && pui.syncView.deviceId && pui.syncView.backup && pui.syncView.restore && pui.syncView.honest &&
        pui.shell && pui.shell.tabs === 4 && pui.shell.playerControls === 5 && pui.overlayOpened && pui.queueLoaded &&
        Array.isArray(pui.overlayLeaks) && pui.overlayLeaks.length === 0
    );
    step('歌单页渲染（列表 / 详情 / ⋯菜单 / 行内弹层 / 加入弹层 / 同步页 / 播放浮层）', puiOk, JSON.stringify(pui));

    const playlistShot = path.join(OUT_DIR, 'smoke-ui-playlist.png');
    require('fs').writeFileSync(playlistShot, (await mainWindow.webContents.capturePage()).toPNG());
    step('歌单页截图（含胶囊迷你条）', true, playlistShot);

    // 第四段专拍全屏播放浮层：iPhone 最有辨识度的一屏，必须有实拍证据。
    send('smoke:run', { keyword: '', phase: 'player-shot' });
    const ply = (await waitUI(25000)) || { visible: false, note: '渲染层 25s 内未回报浮层状态' };
    const plyOk = Boolean(
      ply.visible &&
        ply.title === '冒烟 UI 探针 A' &&
        ply.hasArtwork && ply.grabberCloses &&
        ply.controls.startsWith('随机播放·上一曲·播放 / 暂停·下一曲·') && ply.controls.split('·').length === 5 &&
        ply.controlIcons === 5 &&
        ply.slots === '歌词·播放设备·播放队列' &&
        ply.hasProgress && ply.hasVolume && ply.menuOpens &&
        ply.menuItems && ply.menuItems.includes('添加到歌单') && ply.menuItems.includes('关闭播放页') &&
        Array.isArray(ply.overlayLeaks) && ply.overlayLeaks.length === 0
    );
    step('全屏播放浮层（5 控件 / 3 槽位 / 进度条 / 音量 / ⋯菜单）', plyOk, JSON.stringify(ply));

    const playerShot = path.join(OUT_DIR, 'smoke-ui-player.png');
    require('fs').writeFileSync(playerShot, (await mainWindow.webContents.capturePage()).toPNG());
    step('播放浮层截图', true, playerShot);

    send('smoke:run', { keyword: '', phase: 'playlist-cleanup' });
    const cleaned = (await waitUI(10000)) || { removed: false, note: '渲染层未回报' };
    const fs2 = require('fs');
    store.save(true); // 渲染层的删除只走了 IPC，落盘还有 250ms 防抖
    const onDisk = JSON.parse(fs2.readFileSync(path.join(app.getPath('userData'), 'primuse.json'), 'utf8'));
    const stillOnDisk = (onDisk.playlists || []).some((p) => p.name === '冒烟 UI 歌单');
    // 截图时在内存里塞过两首探针用来点亮胶囊迷你条；它们绝不能落盘
    const queueLeak = ((onDisk.queue && onDisk.queue.items) || []).filter((t) => /^冒烟/.test(t.title || '')).map((t) => t.title);
    step('歌单 UI 探针已清理', Boolean(cleaned.removed) && cleaned.stillThere === false && !stillOnDisk && queueLeak.length === 0,
      `${JSON.stringify(cleaned)}；落盘歌单残留 ${stillOnDisk}，队列残留 ${queueLeak.length}`);

    // 最后一段：真派发 click 走一遍用户路径（弹层、新建并立即加入、再点取消、手动调序、移除、删除、批量、浮层）。
    // 前面几段只看 DOM；这一段验的是"点下去到底发生了什么"。
    send('smoke:run', { keyword: '', phase: 'playlist-clicks' });
    const clicks = (await waitUI(90000)) || { ok: false, note: '渲染层 90s 内未回报点击结果' };
    store.save(true);
    const leftovers = JSON.parse(fs2.readFileSync(path.join(app.getPath('userData'), 'primuse.json'), 'utf8'))
      .playlists.filter((p) => /^冒烟(歌单| UI 歌单|点击歌单|点击新建)/.test(p.name || ''));
    step(
      '歌单点击流（＋歌单 / 新建 / 取消包含 / 调序 / 移除 / 删除 / 批量 / 浮层）',
      clicks.ok === true && leftovers.length === 0,
      JSON.stringify(leftovers.length ? { ...clicks, 落盘残留: leftovers.map((p) => p.name) } : clicks)
    );
  } catch (error) {
    report.errors.push(String(error && error.stack ? error.stack : error));
  }

  require('fs').mkdirSync(OUT_DIR, { recursive: true });
  require('fs').writeFileSync(path.join(OUT_DIR, 'smoke-report.json'), JSON.stringify(report, null, 2), 'utf8');
  for (const s of report.steps) console.log(`[smoke] ${s.ok ? 'PASS' : 'FAIL'} ${s.name} — ${s.detail || ''}`);
  console.log('[smoke] ' + (report.steps.every((s) => s.ok) ? 'RESULT ok' : 'RESULT failed'));
  app.exit(report.steps.every((s) => s.ok) ? 0 : 1);
}

// MARK: - 生命周期

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !SMOKE) {
  app.quit();
} else {
  app.on('second-instance', () => mainWindow?.show());

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.welape.primuse.desktop');

    store.load();
    registerIpc();

    proxy = await startProxy({
      resolveAggregated: async (platform, rawID, force) => {
        if (force) aggregated.streamCache.delete(`${platform}:${rawID}`);
        // 这里必须带上云端钩子：本地代理只给得出 platform+rawID，若这首歌来自云端清单里的
        // 洛雪 js 源，不带钩子就解析不了（那条线本机没有脚本），音频代理会直接 404。
        return aggregated.resolveStreamURL(store.aggregated.list(), platform, rawID, force, cloudSources.hooks());
      },
      daoliyuStream: (sourceID, rawID, range) => clientFor(sourceID).openDownload(rawID, range),
      coverFetch: async (url) => {
        const { openStream } = require('./httpx');
        // 服务器源的 /api/cover 同样要带 Bearer（地址由 DaoLiYuAPIProtocol.coverURL 拼装）
        for (const server of store.servers.list()) {
          const origin = originOf(server);
          if (origin && String(url).startsWith(origin)) {
            const client = clientFor(server.id);
            return client.authorized((headers) => openStream(url, { headers, insecureTLS: client.insecureTLS }));
          }
        }
        return openStream(url, {});
      },
    });

    buildMenu();
    createWindow();
    if (!SMOKE) createTray();
    registerMediaKeys();
    // 冒烟模式不去碰网络：结果要可复现，而且现网清单随时在变。
    if (!SMOKE) startCloudSourceSync();

    if (SMOKE) setTimeout(runSmoke, 1500);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    store.save(true);
    try {
      globalShortcut.unregisterAll();
    } catch {
      /* noop */
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
