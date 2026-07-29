const { contextBridge, ipcRenderer } = require('electron');

// Ocultar marcas de Electron a los scripts JS de Google OAuth en el DOM
try {
  if (typeof window !== 'undefined') {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgentData', {
      get: () => undefined,
      configurable: true
    });
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => undefined,
      configurable: true
    });
    Object.defineProperty(window, 'chrome', {
      value: { runtime: {} },
      configurable: true,
      writable: true
    });
  }
} catch (e) {
  // Ignorar si no se puede sobrescribir
}

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
