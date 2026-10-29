'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('breeze', {
  // 主进程 -> 渲染进程
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onReady: (cb) => ipcRenderer.on('ready', (_e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on('error', (_e, err) => cb(err)),
  onWindowState: (cb) => ipcRenderer.on('window-state', (_e, s) => cb(s)),

  // 渲染进程 -> 主进程
  retry: () => ipcRenderer.invoke('retry'),
  quit: () => ipcRenderer.invoke('quit'),

  // 无边框窗口控制
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    getState: () => ipcRenderer.invoke('win:state')
  }
});
