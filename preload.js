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

  // fired when the corresponding tray-menu item is clicked, since the
  // import/export button was removed from the sidebar window itself.
  // Import's file picker runs natively in the main process (see main.js
  // for why), so this arrives with the file content already read — the
  // renderer only has to parse and apply it, no <input type="file"> needed.
  onExportRequested: (cb) => ipcRenderer.on('data:export', () => cb()),
  onImportFile: (cb) => ipcRenderer.on('data:import-file', (_e, payload) => cb(payload)),
});
