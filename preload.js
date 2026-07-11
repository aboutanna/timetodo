'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sidebarAPI', {
  // called by the edge-strip window when the cursor touches the screen edge
  edgeEnter: () => ipcRenderer.send('edge:enter'),

  // called by the sidebar content window itself
  enter: () => ipcRenderer.send('sidebar:enter'),
  leave: () => ipcRenderer.send('sidebar:leave'),
  togglePin: () => ipcRenderer.send('sidebar:toggle-pin'),
  getPinned: () => ipcRenderer.invoke('sidebar:get-pinned'),
  onPinnedChanged: (cb) => ipcRenderer.on('sidebar:pinned-changed', (_e, val) => cb(val)),
});
