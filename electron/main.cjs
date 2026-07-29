const { app, BrowserWindow, Tray, Menu, nativeImage, session, dialog, ipcMain, shell, Notification } = require('electron');
const path = require('path');

const firefoxUserAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint');
app.commandLine.appendSwitch('user-agent', firefoxUserAgent);
if (process.platform === 'linux') {
  // Evitar señales SIGTRAP en compositores Linux Wayland/X11 y al cerrar ventanas secundarias
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Manejador IPC para selector nativo de directorio en Linux/Desktop
ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Seleccionar carpeta local para sincronizar'
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Manejador IPC para OAuth nativo de Google / Google Drive en Electron
ipcMain.handle('open-google-auth', async () => {
  console.log('[Electron] Iniciando ventana nativa de OAuth con Google Drive...');
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123619653091-oodio89frb0ogcm89bc5btpigonl0r1a.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fgen-lang-client-0459053075.firebaseapp.com%2F__%2Fauth%2Fhandler&response_type=token&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive%20profile%20email&prompt=select_account';

  return new Promise((resolve, reject) => {
    let authWindow = new BrowserWindow({
      width: 550,
      height: 700,
      title: 'Iniciar sesión con Google Drive',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        userAgent: firefoxUserAgent,
        preload: path.join(__dirname, 'preload.cjs'),
      }
    });

    authWindow.webContents.setUserAgent(firefoxUserAgent);

    // Eliminar cabeceras Sec-Ch-Ua que revelan a Electron ante Google OAuth
    authWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://accounts.google.com/*', 'https://*.google.com/*', 'https://*.firebaseapp.com/*'] },
      (details, callback) => {
        delete details.requestHeaders['Sec-Ch-Ua'];
        delete details.requestHeaders['Sec-Ch-Ua-Mobile'];
        delete details.requestHeaders['Sec-Ch-Ua-Platform'];
        delete details.requestHeaders['sec-ch-ua'];
        delete details.requestHeaders['sec-ch-ua-mobile'];
        delete details.requestHeaders['sec-ch-ua-platform'];
        details.requestHeaders['User-Agent'] = firefoxUserAgent;
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    const handleUrl = (url) => {
      if (url) {
        console.log('[Electron] authWindow navegando a URL:', url.substring(0, 100));
      }
      if (url && (url.includes('access_token=') || url.includes('#access_token='))) {
        try {
          const raw = url.split('#')[1] || url.split('?')[1] || '';
          const params = new URLSearchParams(raw);
          const token = params.get('access_token');
          if (token) {
            console.log('[Electron] Token de Google OAuth obtenido con éxito!');
            resolve(token);
            setTimeout(() => {
              if (authWindow && !authWindow.isDestroyed()) {
                authWindow.destroy();
              }
            }, 150);
          }
        } catch (e) {
          reject(e);
        }
      }
    };

    authWindow.webContents.on('will-navigate', (_event, url) => handleUrl(url));
    authWindow.webContents.on('did-navigate', (_event, url) => handleUrl(url));
    authWindow.webContents.on('did-redirect-navigation', (_event, url) => handleUrl(url));

    authWindow.on('closed', () => {
      authWindow = null;
    });

    authWindow.loadURL(authUrl);
  });
});

ipcMain.handle('open-external', async (_event, url) => {
  if (url) await shell.openExternal(url);
});

ipcMain.handle('set-auto-start', async (_event, enable) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enable), path: app.getPath('exe') });
    return Boolean(enable);
  } catch (e) {
    console.error('[Electron] Error config auto-start:', e);
    return false;
  }
});

ipcMain.handle('get-auto-start', async () => {
  try {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('show-notification', async (_event, title, body) => {
  try {
    const icon = nativeImage.createFromDataURL(iconDataUrl);
    new Notification({ title: title || 'SyncClient', body: body || '', icon }).show();
    return true;
  } catch (e) {
    console.error('[Electron] Error mostrando notificación:', e);
    return false;
  }
});

// Icono simple de nube azul en base64 (24x24) para la barra de tareas de Ubuntu/Linux
const iconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAACXBIWXMAAAsTAAALEwEAmpwYAAAB8WlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuc3M6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi0yMTQiPgogIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIKICAgICAgICAgICAgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiCiAgICAgICAgICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyI+CiAgICAgIDx4bXBNTTpEZXJpdmVkRnJvbSByZGY6cGFyc2VUeXBlPSJSZXNvdXJjZSIvPgogICAgICA8eG1wOkNyZWF0b3JVbml2ZXJzYWxUb29sPkFkb2JlIFBob3Rvc2hvcC9JbGx1c3RyYXRvcjwveG1wOkNyZWF0b3JVbml2ZXJzYWxUb29sPgogICAgPCxyZGY6RGVzY3JpcHRpb24+CiAgPC9yZGY6UkRGRj4KPC94OnhtcG1ldGE+CjE5OQAAAIBJREFUSMft1EEOgCAMBNC24AF4T/AEvN7YmBAMRoxF1w0mblw187P9w9rZ7gVlKAAKQA3YA17GjP11WbAFUGAW0ALjJ2H0J/gA7JgQeFaw4CqQYh+U4E60oBGsK1gLdEAKUj0PZ18rQzP4e2aJ5a/2X2h913sD3oI8W7yYhV21AcbYVREc11i+AAAAAElFTkSuQmCC';

function startBackend() {
  try {
    require('../dist/server.cjs');
  } catch (err) {
    console.error('Error starting backend:', err);
  }
}

function createTray() {
  const image = nativeImage.createFromDataURL(iconDataUrl);
  tray = new Tray(image);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir Panel SyncClient',
      click: () => {
        if (!mainWindow) {
          createWindow();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Salir de SyncClient',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('SyncClient - Cliente de Google Drive en Ubuntu');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'SyncClient - Google Drive Ubuntu',
    webPreferences: {
      // contextIsolation: true + preload → Firebase ve un navegador normal, no Node.js
      // Esto es la clave para que signInWithPopup funcione
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    }
  });

  // Permitir la apertura de ventanas emergentes para el flujo de autenticación de Google/Firebase
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[Electron] Abriendo ventana emergente:', url);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 550,
        height: 700,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: false,
          webSecurity: false,
          userAgent: firefoxUserAgent,
          preload: path.join(__dirname, 'preload.cjs'),
        }
      }
    };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[Electron] Error cargando página:', errorCode, errorDescription);
    if (errorCode !== -3) { // Ignore ABORTED
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[Electron] Reintentando conexión con http://localhost:3000...');
          mainWindow.loadURL('http://localhost:3000').catch(() => {});
        }
      }, 1000);
    }
  });

  const loadWhenReady = async () => {
    for (let i = 0; i < 30; i++) {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        await mainWindow.loadURL('http://localhost:3000');
        console.log('[Electron] Conexión establecida con el servidor backend.');
        return;
      } catch (e) {
        console.log(`[Electron] Servidor backend iniciando, reintentando (${i + 1}/30)...`);
        await new Promise(res => setTimeout(res, 500));
      }
    }
  };
  loadWhenReady();
}

// Prevenir problemas de renderizado de ventana blanca en entornos Linux Wayland / X11
app.commandLine.appendSwitch('disable-gpu-compositing');

app.whenReady().then(() => {
  // Enmascarar User-Agent como Firefox de Linux para todo el entorno web
  session.defaultSession.setUserAgent(firefoxUserAgent);

  app.on('web-contents-created', (_event, contents) => {
    contents.setUserAgent(firefoxUserAgent);
  });

  startBackend();
  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') {
    app.quit();
  }
});
