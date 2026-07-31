const { contextBridge, ipcRenderer } = require('electron');

// CORRECCIÓN CRÍTICA: No sobrescribir navigator.userAgentData ni window.chrome
// ya que Chromium (Electron) los necesita internamente para IndexedDB,
// Firebase Auth, y la detección de capacidades del navegador.
// El User-Agent ya se enmascara como Firefox a nivel de sesión en main.cjs,
// que es suficiente para Google OAuth.

// Exponer funciones seguras hacia el frontend (sin Node.js completo)
contextBridge.exposeInMainWorld('electronBridge', {
  platform: process.platform,
  isElectron: true,
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openGoogleAuth: () => ipcRenderer.invoke('open-google-auth'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setAutoStart: (enable) => ipcRenderer.invoke('set-auto-start', enable),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', title, body)
});
