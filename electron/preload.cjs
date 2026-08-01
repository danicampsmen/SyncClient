const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  secureSet: (key, value) => ipcRenderer.invoke('secure-store-set', key, value),
  secureGet: (key) => ipcRenderer.invoke('secure-store-get', key),
  secureRemove: (key) => ipcRenderer.invoke('secure-store-remove', key)
});