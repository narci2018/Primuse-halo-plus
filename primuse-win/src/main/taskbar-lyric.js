'use strict';
/**
 * 任务栏歌词条（需求 8）：App 最小化后，贴着 Windows 任务栏的上沿挂一条单行歌词，
 * 显示当前这一句；用户可以在"设置 → 播放"里关掉，也可以点右上角 ✕ 让它这一首都别露脸。
 *
 * 为什么是一条独立的窗口：主窗口最小化之后就不绘制了，任何"最小化后还要看得见"的东西
 * 都必须活在自己的窗口里。iPhone 那边对应的是实时活动（灵动岛），macOS 那边是桌面歌词面板。
 *
 * 三条边界：
 *   1. **显示与否只由主进程判**（开关 + 主窗口是否真的看不见 + 有没有在播 + 有没有词），
 *      渲染层只推"现在这一句是什么"。两边各管一半，切歌/暂停时就不会闪。
 *   2. 窗口 `focusable: false`：一条歌词不许抢走用户正在打的字；
 *      它照样收得到点击（WS_EX_NOACTIVATE 不影响鼠标），点一下唤回主窗口。
 *   3. 只贴工作区下沿，不覆盖任务栏本身 —— 盖住开始菜单是找骂。
 */

const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const STRIP_WIDTH = 560;
const STRIP_HEIGHT = 44;
const BOTTOM_GAP = 6; // 离任务栏留一条缝

let win = null;
let lastPayload = null;
let dismissed = false; // 用户点了 ✕：这一首之内不再露出
let lastSongKey = ''; // 用于识别"换歌了"，见 init 的 set 分支
let ready = false;
let deps = {
  isEnabled: () => false,
  mainWindowHidden: () => false,
  onRestore: () => {},
};

function stripBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(STRIP_WIDTH, Math.max(280, area.width - 80));
  return {
    width,
    height: STRIP_HEIGHT,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - STRIP_HEIGHT - BOTTOM_GAP),
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...stripBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    title: 'Primuse 歌词',
    webPreferences: {
      preload: path.join(__dirname, '../preload-lyric.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // 主窗口最小化了，这条还得照常收 IPC
    },
  });
  // 'floating'：盖住普通窗口，但不去压全屏应用和系统弹窗。
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.loadFile(path.join(__dirname, '../renderer/taskbar-lyric.html'));
  win.webContents.on('did-finish-load', () => {
    ready = true;
    if (lastPayload) win.webContents.send('lyric:set', lastPayload);
  });
  win.on('closed', () => {
    win = null;
    ready = false;
  });
}

/** 该不该露出来：四个条件少一个都不画（空壳浮在任务栏上比没有更烦人）。 */
function shouldShow() {
  return Boolean(
    deps.isEnabled() &&
      deps.mainWindowHidden() &&
      !dismissed &&
      lastPayload &&
      lastPayload.playing &&
      String(lastPayload.text || '').trim()
  );
}

/** 主进程唯一的出口：任何状态变化（新词 / 暂停 / 最小化 / 开关）都走这一次判定。 */
function apply() {
  if (!shouldShow()) {
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    return false;
  }
  if (!win || win.isDestroyed()) createWindow();
  win.setBounds(stripBounds()); // 换分辨率 / 插外接屏后重新贴一次
  if (ready) win.webContents.send('lyric:set', lastPayload);
  if (!win.isVisible()) win.showInactive();
  return true;
}

function sanitize(payload) {
  const p = payload || {};
  return {
    text: String(p.text || '').slice(0, 240),
    title: String(p.title || '').slice(0, 120),
    artist: String(p.artist || '').slice(0, 120),
    playing: Boolean(p.playing),
    hasLyrics: Boolean(p.hasLyrics),
  };
}

module.exports = {
  /**
   * @param {{isEnabled:()=>boolean, mainWindowHidden:()=>boolean, onRestore:()=>void}} hooks
   */
  init(hooks) {
    deps = { ...deps, ...hooks };
    ipcMain.on('taskbar-lyric:set', (_e, payload) => {
      const next = sanitize(payload);
      // 换歌 = 新的一首，把上一首的"别露脸"清掉；同一首内 ✕ 过就一直收着。
      // 歌曲身份在这里就地算（标题+歌手），不要求渲染层多传一个字段 —— 它一旦漏传，
      // 后果是"点过一次 ✕ 之后这轮 App 再也不出现"，那种 bug 只在真机上看得见。
      const key = `${next.title}|${next.artist}`;
      if (key !== lastSongKey) {
        lastSongKey = key;
        dismissed = false;
      }
      lastPayload = next;
      apply();
    });
    ipcMain.on('taskbar-lyric:restore', () => deps.onRestore());
    ipcMain.on('taskbar-lyric:dismiss', () => {
      dismissed = true;
      apply();
    });
    // 设置里把开关重新打开 = 用户改主意了，上一首点的 ✕ 不该继续生效。
    ipcMain.on('taskbar-lyric:reset', () => {
      dismissed = false;
      apply();
    });
    screen.on('display-metrics-changed', () => apply());
    return module.exports;
  },
  /** 主窗口的 show / hide / minimize / restore 之后都要喊一声。 */
  sync: apply,
  /** 关掉开关时顺手收走；换清单/退出也用得上。 */
  hide() {
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  },
  dispose() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    ready = false;
  },
  /**
   * 冒烟取证：这条是独立窗口，主窗口的 capturePage 拍不到它（它浮在主窗口之外），
   * 只能自己拍自己。没露出来时返回 null —— 拿不到图就算断言失败，不糊弄。
   */
  async capture() {
    if (!win || win.isDestroyed() || !win.isVisible()) return null;
    const image = await win.webContents.capturePage();
    return image.toPNG();
  },
  // 冒烟 / 调试用：这条窗口在不在、上面写的是什么、为什么在或为什么不在。
  status: () => ({
    exists: Boolean(win && !win.isDestroyed()),
    visible: Boolean(win && !win.isDestroyed() && win.isVisible()),
    enabled: deps.isEnabled(),
    hidden: deps.mainWindowHidden(),
    dismissed,
    payload: lastPayload,
    bounds: win && !win.isDestroyed() ? win.getBounds() : null,
  }),
};
