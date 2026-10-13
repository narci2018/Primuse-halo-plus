'use strict';
/**
 * Primuse Windows 版主进程。
 *
 * 这不是 HALO 网页的壳：默认不加载任何远程页面（`loadFile` 本地渲染层），
 * App 内也没有账号体系 —— 与 iPhone/macOS 版一致，登录只发生在"添加需要鉴权的
 * 音源"这一步（道理鱼的 /api/auth/login），由用户在"来源"页自己填。
 *
 * 界面结构照 `primuse/Primuse/Views/Mac/`：侧栏（MacSidebar）+ 主详情
 * （MacDetailContainer）+ 常驻底部播放条（MacBottomBar）+ 队列（MacQueuePanel），
 * 路由集合与 MacRoute.swift:6-19 对齐。
 */

const path = require('path');
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, globalShortcut } = require('electron');

const aggregated = require('./aggregated');
const { DaoLiYuClient, originOf } = require('./daoliyu');
const store = require('./store');
const { startProxy } = require('./proxy');

const SMOKE = process.argv.includes('--primuse-smoke');
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
  if (track.kind === 'server') {
    const client = clientFor(track.sourceID);
    return {
      kind: 'server',
      url: `${proxy.baseUrl}/stream/dly/${encodeURIComponent(track.sourceID)}/${encodeURIComponent(track.rawID)}`,
      client,
    };
  }
  const url = await aggregated.resolveStreamURL(store.aggregated.list(), track.platform, track.rawID, force);
  return { kind: 'aggregated', url, proxied: `${proxy.baseUrl}/stream/agg/${track.platform}/${encodeURIComponent(track.rawID)}${force ? '?force=1' : ''}` };
}

async function trackLyrics(track) {
  if (!track) return null;
  if (track.kind === 'server') {
    const detail = await clientFor(track.sourceID).trackDetail(track.rawID);
    if (!detail) return null;
    // preferredLyrics：逐字优先（DaoLiYuSource.swift:362-368）
    return detail.syncedLyrics || detail.plainLyrics || null;
  }
  return aggregated.resolveLyrics(store.aggregated.list(), track.platform, track.rawID);
}

// MARK: - IPC

function registerIpc() {
  ipcMain.handle('meta:get', () => ({
    version: app.getVersion(),
    platform: 'win32',
    proxyBaseUrl: proxy ? proxy.baseUrl : null,
    credentialsEncrypted: store.credentialsAvailable(),
    smoke: SMOKE,
  }));

  // 在线聚合线路
  ipcMain.handle('sources:list', () => store.aggregated.list());
  ipcMain.handle('sources:toggle', (_e, id) => store.aggregated.toggle(id));
  ipcMain.handle('sources:upsert', (_e, source) => store.aggregated.upsert(source));
  ipcMain.handle('sources:remove', (_e, id) => store.aggregated.remove(id));
  ipcMain.handle('sources:reset', () => store.aggregated.reset());
  ipcMain.handle('sources:pingAll', async () => {
    const list = store.aggregated.list();
    for (const source of list) {
      const latency = await aggregated.pingSource(source);
      store.aggregated.setLatency(source.id, latency);
      send('sources:latency', { id: source.id, latencyMs: latency });
    }
    return store.aggregated.list();
  });

  // 搜索：主进程并发打线路，渐进推给渲染层（对应 Swift 的流式上屏）
  ipcMain.handle('search:aggregated', async (_e, { keyword, requestId }) => {
    try {
      const items = await aggregated.searchAll(store.aggregated.list(), keyword, (partial, progress) => {
        send('search:partial', { requestId, items: partial, progress });
      });
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

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
  });

  ipcMain.on('smoke:ui', (_e, state) => {
    smokeUIState = state;
  });
}

// MARK: - 窗口

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    title: 'Primuse',
    backgroundColor: '#0f1013',
    show: false,
    icon: path.join(__dirname, '../../build/icon.png'),
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

function createTray() {
  try {
    const image = nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png')).resize({ width: 16, height: 16 });
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
    step('渲染层自检', Boolean(report.ui && report.ui.ready), JSON.stringify(report.ui));

    const image = await mainWindow.webContents.capturePage();
    require('fs').mkdirSync(OUT_DIR, { recursive: true });
    const shotPath = path.join(OUT_DIR, 'smoke-ui.png');
    require('fs').writeFileSync(shotPath, image.toPNG());
    step('界面截图', true, shotPath);
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
        return aggregated.resolveStreamURL(store.aggregated.list(), platform, rawID, force);
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
