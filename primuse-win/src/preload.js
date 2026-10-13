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

  playlists: {
    list: () => ipcRenderer.invoke('playlist:list'),
    get: (id) => ipcRenderer.invoke('playlist:get', id),
    create: (name) => ipcRenderer.invoke('playlist:create', name),
    rename: (id, name) => ipcRenderer.invoke('playlist:rename', { id, name }),
    remove: (id) => ipcRenderer.invoke('playlist:remove', id),
    addSong: (id, track) => ipcRenderer.invoke('playlist:addSong', { id, track }),
    toggleSong: (id, track) => ipcRenderer.invoke('playlist:toggleSong', { id, track }),
    removeSong: (id, track) => ipcRenderer.invoke('playlist:removeSong', { id, track }),
    move: (id, from, to) => ipcRenderer.invoke('playlist:move', { id, from, to }),
    belongsTo: (track) => ipcRenderer.invoke('playlist:belongsTo', track),
  },

  sync: {
    config: () => ipcRenderer.invoke('sync:config'),
    setServerURL: (url) => ipcRenderer.invoke('sync:setServerURL', url),
    setDeviceName: (name) => ipcRenderer.invoke('sync:setDeviceName', name),
    backup: () => ipcRenderer.invoke('sync:backup'),
    restore: () => ipcRenderer.invoke('sync:restore'),
    devices: () => ipcRenderer.invoke('sync:devices'),
    importFromDevice: (deviceId) => ipcRenderer.invoke('sync:import', deviceId),
    exportPlaylist: (playlist) => ipcRenderer.invoke('sync:export', playlist),
    importFile: () => ipcRenderer.invoke('sync:importFile'),
  },

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // 主进程菜单 / 系统媒体键 → 渲染层
  onPlayerCommand: on('player:command'),
  onSmokeRun: on('smoke:run'),
  smokeReport: (state) => ipcRenderer.send('smoke:ui', state),
});
