const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  selectDirectory: async () => {
    const selectedPath = await ipcRenderer.invoke('select-directory');
    return selectedPath ? { path: selectedPath } : null;
  },
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', Boolean(enabled)),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  secureSet: (key, value) => ipcRenderer.invoke('secure-store-set', key, value),
  secureGet: (key) => ipcRenderer.invoke('secure-store-get', key),
  secureRemove: (key) => ipcRenderer.invoke('secure-store-remove', key)
});
