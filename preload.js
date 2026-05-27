const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('todoAPI', {
  getData: () => ipcRenderer.invoke('get-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  resizeWindow: (collapsed) => ipcRenderer.invoke('resize-window', collapsed),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  onSnapChanged: (callback) => {
    ipcRenderer.on('snap-changed', (_event, snapped) => callback(snapped));
  },
  unsnapWindow: () => ipcRenderer.invoke('unsnap-window'),
  getSnapState: () => ipcRenderer.invoke('get-snap-state'),
  hoverExpand: () => ipcRenderer.invoke('hover-expand'),
  hoverCollapse: () => ipcRenderer.invoke('hover-collapse'),
  onHoverState: (callback) => {
    ipcRenderer.on('hover-state', (_event, state) => callback(state));
  },
});
