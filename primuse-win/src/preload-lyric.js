'use strict';
/**
 * 任务栏歌词条专用的 preload。
 *
 * 它故意不复用 src/preload.js：那条桥把整套 App 的能力（文件、网络、store）都暴露给了
 * 一个浮在别人窗口上的透明条，而这条窗口只需要三件事 —— 收一句歌词、点一下唤回主窗口、
 * 点 ✕ 让这一首别再露脸。能力越少，越不用担心它被当成入口。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricStrip', {
  onSet: (handler) => {
    ipcRenderer.on('lyric:set', (_event, payload) => handler(payload));
  },
  restore: () => ipcRenderer.send('taskbar-lyric:restore'),
  dismiss: () => ipcRenderer.send('taskbar-lyric:dismiss'),
});
