'use strict';
/**
 * 渲染层与主进程之间唯一的桥。contextIsolation + sandbox 都开着，
 * 页面里拿不到 Node，只能调用下面这些具名方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('primuse', {
  meta: () => ipcRenderer.invoke('meta:get'),

  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    toggle: (id) => ipcRenderer.invoke('sources:toggle', id),
    upsert: (source) => ipcRenderer.invoke('sources:upsert', source),
    remove: (id) => ipcRenderer.invoke('sources:remove', id),
    reset: () => ipcRenderer.invoke('sources:reset'),
    pingAll: () => ipcRenderer.invoke('sources:pingAll'),
    onLatency: on('sources:latency'),
  },

  search: {
    aggregated: (keyword, requestId) => ipcRenderer.invoke('search:aggregated', { keyword, requestId }),
    onPartial: on('search:partial'),
  },

  playback: {
    resolve: (track, force) => ipcRenderer.invoke('playback:resolve', { track, force: Boolean(force) }),
    lyrics: (track) => ipcRenderer.invoke('playback:lyrics', { track }),
  },

  server: {
    list: () => ipcRenderer.invoke('server:list'),
    upsert: (config) => ipcRenderer.invoke('server:upsert', config),
    remove: (id) => ipcRenderer.invoke('server:remove', id),
    test: (config) => ipcRenderer.invoke('server:test', { config }),
    tracks: (sourceID, skip, take) => ipcRenderer.invoke('server:tracks', { sourceID, skip, take }),
  },

  library: {
    favorites: () => ipcRenderer.invoke('library:favorites'),
    toggleFavorite: (track) => ipcRenderer.invoke('library:toggleFavorite', track),
    history: () => ipcRenderer.invoke('library:history'),
    pushHistory: (track, playedSeconds) => ipcRenderer.invoke('library:pushHistory', { track, playedSeconds }),
    clearHistory: () => ipcRenderer.invoke('library:clearHistory'),
  },

  queue: {
    save: (value) => ipcRenderer.invoke('queue:save', value),
    load: () => ipcRenderer.invoke('queue:load'),
  },

  player: {
    save: (patch) => ipcRenderer.invoke('player:save', patch),
    load: () => ipcRenderer.invoke('player:load'),
  },

  settings: {
    save: (patch) => ipcRenderer.invoke('settings:save', patch),
    load: () => ipcRenderer.invoke('settings:load'),
  },

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // 主进程菜单 / 系统媒体键 → 渲染层
  onPlayerCommand: on('player:command'),
  onSmokeRun: on('smoke:run'),
  smokeReport: (state) => ipcRenderer.send('smoke:ui', state),
});
