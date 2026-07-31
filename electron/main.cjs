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

// --- PKCE Helpers (Node.js crypto) ---
function base64URLEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier() {
  const array = require('crypto').randomBytes(32);
  return base64URLEncode(array);
}

function generateCodeChallenge(verifier) {
  const hash = require('crypto').createHash('sha256').update(verifier).digest();
  return base64URLEncode(hash);
}

// Manejador IPC para OAuth nativo de Google / Google Drive en Electron
// Usa Authorization Code Flow con PKCE para obtener refresh_token
ipcMain.handle('open-google-auth', async () => {
  console.log('[Electron] Iniciando ventana nativa de OAuth (PKCE Authorization Code Flow)...');

  const firebaseConfig = require(path.join(__dirname, '..', 'firebase-applet-config.json'));
  const clientId = firebaseConfig.oAuthClientId || '123619653091-oodio89frb0ogcm89bc5btpigonl0r1a.apps.googleusercontent.com';
  const redirectUri = 'http://localhost:3000/api/oauth/callback';
  const scope = 'https://www.googleapis.com/auth/drive profile email';

  // Generar PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = codeVerifier.substring(0, 16);

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256` +
    `&state=${encodeURIComponent(state)}`;

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

    const authSession = session.fromPartition('auth-popup-session', { cache: true });
    authWindow.webContents.session = authSession;
    authWindow.webContents.setUserAgent(firefoxUserAgent);

    authWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://accounts.google.com/*', 'https://*.google.com/*', 'http://localhost:3000/*'] },
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

    let codeReceived = false;

    const handleUrl = async (url) => {
      if (!url || codeReceived) return;
      console.log('[Electron] authWindow navegando a URL:', url.substring(0, 120));

      // Buscar ?code= o &code= en la URL de callback
      const codeMatch = url.match(/[?&]code=([^&]+)/);
      if (!codeMatch) {
        // También detectar error de OAuth
        if (url.includes('error=')) {
          const errMatch = url.match(/[?&]error=([^&]+)/);
          reject(new Error(`OAuth error: ${errMatch ? errMatch[1] : 'unknown'}`));
          authWindow?.destroy();
        }
        return;
      }

      codeReceived = true;
      const code = decodeURIComponent(codeMatch[1]);
      console.log('[Electron] Authorization code recibido. Delegando intercambio al backend (client_secret + code_verifier)...');

      // Delegar siempre al backend, que tiene client_secret y recibe code_verifier
      try {
        const backendRes = await fetch('http://localhost:3000/api/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, codeVerifier })
        });

        if (!backendRes.ok) {
          const errText = await backendRes.text();
          console.error('[Electron] Backend token exchange failed:', backendRes.status, errText);
          reject(new Error(`Error del servidor: ${backendRes.status} - ${errText}`));
          authWindow?.destroy();
          return;
        }

        const data = await backendRes.json();

        if (data.error) {
          console.error('[Electron] Error del backend:', data.error, data.detail || '');
          reject(new Error(data.error + (data.detail ? ': ' + data.detail : '')));
          authWindow?.destroy();
          return;
        }

        if (!data.accessToken) {
          console.error('[Electron] Backend no devolvió accessToken');
          reject(new Error('El backend no devolvió accessToken.'));
          authWindow?.destroy();
          return;
        }

        console.log('[Electron] ✅ Tokens obtenidos con éxito! access_token + refresh_token');
        resolve({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken || null
        });

        setTimeout(() => {
          if (authWindow && !authWindow.isDestroyed()) {
            authWindow.destroy();
          }
        }, 150);
      } catch (e) {
        console.error('[Electron] Error en token exchange:', e);
        reject(e);
        authWindow?.destroy();
      }
    };

    authWindow.webContents.on('will-navigate', (_event, url) => handleUrl(url));
    authWindow.webContents.on('did-navigate', (_event, url) => handleUrl(url));
    authWindow.webContents.on('did-redirect-navigation', (_event, url) => handleUrl(url));

    authWindow.on('closed', () => {
      if (!codeReceived) {
        reject(new Error('User closed the auth window'));
      }
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
  // CORRECCIÓN CRÍTICA: contextIsolation=false + webSecurity=false causa colapso de IndexedDB
  // porque ambas ventanas (main + popup) compiten por el mismo almacenamiento IndexedDB de Firebase Auth.
  // Solución: contextIsolation=true + sesión aislada para el popup.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[Electron] Abriendo ventana emergente:', url);
    const popupSession = session.fromPartition(`popup-${Date.now()}`, { cache: true });
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 550,
        height: 700,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true,
          session: popupSession,
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
          mainWindow.loadURL('http://localhost:3000').catch(() => { });
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

  // El backend ya es lanzado por concurrently (tsx server.ts). No es necesario cargarlo desde Electron.
  // startBackend();
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
