'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mate', {
  // Move the whole OS window by a delta (used while dragging the pigeon).
  drag: (dx, dy) => ipcRenderer.send('mate:drag', { dx, dy }),
  quit: () => ipcRenderer.send('mate:quit'),
  // Actions pushed from the tray / context menu.
  onTalk: (cb) => ipcRenderer.on('mate:talk', cb),
  onFocus: (cb) => ipcRenderer.on('mate:focus', cb),
  onStatus: (cb) => ipcRenderer.on('mate:status', cb)
});
