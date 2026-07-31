const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('openExternal', url)
  // Puedes borrar openGoogleAuth si lo tenías aquí
});