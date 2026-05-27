const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('todoAPI', {
  getData: () => ipcRenderer.invoke('get-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  resizeWindow: (collapsed) => ipcRenderer.invoke('resize-window', collapsed),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
});
