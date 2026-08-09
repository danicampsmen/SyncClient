const { app, BrowserWindow, Tray, Menu, nativeImage, session, dialog, ipcMain, shell, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Cargar variables de .env para el proceso principal de Electron
// (Vite solo inyecta VITE_* en el bundle del navegador, no en Node.js)
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!process.env[key]) process.env[key] = value;
      }
    }
  }
} catch (e) {
  console.warn('[Electron] No se pudo cargar .env:', e?.message || e);
}

const firefoxUserAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

app.whenReady().then(() => {
  app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint');
  app.commandLine.appendSwitch('user-agent', firefoxUserAgent);
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('disable-dev-shm-usage');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('force-dark-mode');
  }
});

let mainWindow = null;
let tray = null;
let isQuitting = false;
let activeOAuthPromise = null;
let backendProcess = null;
let backendReady = false;
let staticContextMenu = null;
let togglePauseMenuItem = null;
let pauseTimer = null;

function setTimedPause(hours) {
  if (pauseTimer) clearTimeout(pauseTimer);
  sendActionToRenderer('toggle-pause-sync');
  pauseTimer = setTimeout(() => {
    sendActionToRenderer('toggle-pause-sync');
    pauseTimer = null;
  }, hours * 3600 * 1000);
}

const secureStorePath = path.join(app.getPath('userData'), 'syncclient-secure-store.json');
let secureStoreState = {};

function loadSecureStoreState() {
  try {
    if (!fs.existsSync(secureStorePath)) {
      secureStoreState = {};
      return;
    }
    const raw = fs.readFileSync(secureStorePath, 'utf8');
    secureStoreState = raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.warn('[Electron] No se pudo cargar el store seguro local:', error?.message || error);
    secureStoreState = {};
  }
}

async function persistSecureStoreState() {
  try {
    fs.writeFileSync(secureStorePath, JSON.stringify(secureStoreState, null, 2), { mode: 0o600 });
    fs.chmodSync(secureStorePath, 0o600);
  } catch (error) {
    console.error('[Electron] No se pudo persistir el store seguro local:', error?.message || error);
  }
}

ipcMain.handle('secure-store-set', async (_event, key, value) => {
  if (!key || typeof value !== 'string') return false;
  loadSecureStoreState();
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value);
    secureStoreState[key] = {
      version: 1,
      encrypted: encrypted.toString('base64'),
    };
  } else {
    // Fallback: Si Linux no tiene Keyring, guardamos codificado para evitar que falle la app.
    console.warn(`[Electron] Almacenamiento cifrado nativo no disponible en este OS. Guardando codificado en fallback.`);
    secureStoreState[key] = {
      version: 0,
      plain: Buffer.from(value).toString('base64'),
    };
  }
  await persistSecureStoreState();
  return true;
});

ipcMain.handle('secure-store-get', async (_event, key) => {
  loadSecureStoreState();
  const item = secureStoreState[key];
  if (!item) return null;
  if (item.version === 1 && typeof item.encrypted === 'string') {
    try {
      const buffer = Buffer.from(item.encrypted, 'base64');
      return safeStorage.decryptString(buffer);
    } catch (error) {
      console.warn('[Electron] No se pudo descifrar valor seguro:', error?.message || error);
      return null;
    }
  }
  if (item.version === 0 && typeof item.plain === 'string') {
    return Buffer.from(item.plain, 'base64').toString('utf8');
  }
  return null;
});

ipcMain.handle('secure-store-remove', async (_event, key) => {
  if (!key) return false;
  loadSecureStoreState();
  if (secureStoreState[key] !== undefined) {
    delete secureStoreState[key];
    await persistSecureStoreState();
    return true;
  }
  return false;
});

loadSecureStoreState();

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

async function exchangeCodeForTokens(code, codeVerifier, clientId, redirectUri, clientSecret) {
  const params = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  if (clientSecret) params.append('client_secret', clientSecret);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    // Si falla con client_secret, reintentar sin él (compatibilidad Desktop/PKCE)
    if (clientSecret && errBody.error === 'invalid_client') {
      console.warn('[Electron] Token exchange con client_secret falló (invalid_client), reintentando sin secret...');
      return exchangeCodeForTokens(code, codeVerifier, clientId, redirectUri, null);
    }
    throw new Error(`Google rechazó el intercambio OAuth (${response.status}): ${errBody.error_description || errBody.error || 'unknown'}`);
  }
  const tokens = await response.json();
  if (!tokens.access_token) throw new Error('Google no devolvió access_token');
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || null };
}

// Manejador IPC para OAuth nativo de Google / Google Drive en Electron
// Usa Authorization Code Flow con PKCE para obtener refresh_token
async function openGoogleAuth() {
  console.log('[Electron] Iniciando ventana nativa de OAuth (PKCE Authorization Code Flow)...');

  const clientId = process.env.VITE_FIREBASE_OAUTH_CLIENT_ID
    || (function readFallback() {
      try {
        const firebaseConfig = require(path.join(__dirname, '..', 'firebase-applet-config.json'));
        return firebaseConfig.oAuthClientId || '';
      } catch {
        return '';
      }
    })();
  if (!clientId) {
    const msg = 'Falta VITE_FIREBASE_OAUTH_CLIENT_ID en .env o firebase-applet-config.json. Añade VITE_FIREBASE_OAUTH_CLIENT_ID=<tu-client-id> al archivo .env o crea firebase-applet-config.json con { "oAuthClientId": "<tu-client-id>" } y reinicia.';
    console.error('[Electron] ' + msg);
    throw new Error(msg);
  }
  const clientSecret = process.env.VITE_GOOGLE_CLIENT_SECRET || '';
  const redirectUri = 'http://127.0.0.1:3000/api/oauth/callback';
  const scope = 'https://www.googleapis.com/auth/drive profile email';

  // Generar PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = base64URLEncode(require('crypto').randomBytes(24));

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
    const authSession = session.fromPartition(`auth-popup-session-${Date.now()}`, { cache: true });
    let authWindow = new BrowserWindow({
      width: 550,
      height: 700,
      title: 'Iniciar sesión con Google Drive',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        userAgent: firefoxUserAgent,
        session: authSession,
        preload: path.join(__dirname, 'preload.cjs'),
      }
    });

    authWindow.webContents.setUserAgent(firefoxUserAgent);

    authWindow.webContents.setUserAgent(firefoxUserAgent);

    authWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://accounts.google.com/*', 'https://*.google.com/*', 'http://127.0.0.1:3000/*'] },
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

    const handleUrl = async (url, navigationEvent) => {
      if (!url || codeReceived) return;
      let parsed;
      try { parsed = new URL(url); } catch { return; }
      const callbackOrigin = new URL(redirectUri);
      if (parsed.origin !== callbackOrigin.origin || parsed.pathname !== callbackOrigin.pathname) return;
      if (parsed.searchParams.get('state') !== state) {
        navigationEvent?.preventDefault();
        reject(new Error('OAuth state inválido'));
        authWindow?.destroy();
        return;
      }

      const code = parsed.searchParams.get('code');
      if (!code) {
        navigationEvent?.preventDefault();
        reject(new Error('Google no devolvió un código OAuth'));
        authWindow?.destroy();
        return;
      }

      navigationEvent?.preventDefault();
      codeReceived = true;
      console.log('[Electron] Authorization code recibido; intercambiando directamente con Google...');

      try {
        // En Electron, intercambiamos el code directamente con Google (PKCE).
        // NO usamos el relay del servidor (/api/oauth/token) porque la página
        // de callback compite con nosotros y consume la transacción primero → 400.
        const tokens = await exchangeCodeForTokens(code, codeVerifier, clientId, redirectUri, clientSecret);
        if (!tokens?.accessToken) throw new Error('Google no devolvió un token válido');
        const driveResponse = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
          headers: { Authorization: `Bearer ${tokens.accessToken}` }
        });
        if (!driveResponse.ok) {
          throw new Error(`Google Drive rechazó el token (${driveResponse.status})`);
        }
        resolve(tokens);
        setTimeout(() => {
          if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
        }, 150);
      } catch (e) {
        console.error('[Electron] Error en OAuth:', e?.message || e);
        reject(e);
        authWindow?.destroy();
      }
    };

    authWindow.webContents.on('will-navigate', (event, url) => handleUrl(url, event));
    authWindow.webContents.on('did-navigate', (_event, url) => handleUrl(url));
    authWindow.webContents.on('did-redirect-navigation', (event, url) => handleUrl(url, event));

    // Crear la sesión/cookie y registrar el state antes de abrir Google.
    void (async () => {
      try {
        await authWindow.loadURL('http://127.0.0.1:3000/api/session/bootstrap');
        const prepared = await authWindow.webContents.executeJavaScript(`fetch('/api/oauth/prepare', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: ${JSON.stringify(state)} })
        }).then(async response => ({ ok: response.ok, data: await response.json() }))`, true);
        if (!prepared?.ok) throw new Error('No se pudo preparar la sesión OAuth');
        await authWindow.loadURL(authUrl);
      } catch (error) {
        if (!codeReceived) reject(error);
        authWindow?.destroy();
      }
    })();

    authWindow.on('closed', () => {
      if (!codeReceived) {
        reject(new Error('User closed the auth window'));
      }
      authWindow = null;
    });

  });
}

// Abrir únicamente URLs HTTPS en el navegador nativo. Los esquemas locales o
// personalizados no deben poder ser invocados desde el renderer.
function openTrustedExternal(url) {
  if (typeof url !== 'string') throw new Error('URL externa inválida');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Sólo se permiten URLs HTTPS externas');

  // Hardening: Restringir qué dominios puede abrir Electron en el navegador del SO
  const allowedDomains = ['accounts.google.com', 'drive.google.com', 'www.googleapis.com'];
  if (!allowedDomains.includes(parsed.hostname)) {
    throw new Error(`Seguridad: Dominio no permitido para abrir externamente (${parsed.hostname})`);
  }

  return shell.openExternal(parsed.toString());
}

ipcMain.handle('openExternal', async (_event, url) => openTrustedExternal(url));
ipcMain.handle('open-external', async (_event, url) => openTrustedExternal(url));

// Conectar la implementación de OAuth nativo de Electron al renderer
ipcMain.handle('google-auth', async () => {
  if (activeOAuthPromise) {
    console.log('[Electron] OAuth ya en progreso, reutilizando promesa existente.');
    return activeOAuthPromise;
  }
  try {
    activeOAuthPromise = openGoogleAuth();
    const result = await activeOAuthPromise;
    return result;
  } finally {
    activeOAuthPromise = null;
  }
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

function waitForBackend(maxAttempts = 120) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      fetch('http://127.0.0.1:3000/api/health')
        .then(res => { if (res.ok) { backendReady = true; resolve(true); } else throw new Error('not ready'); })
        .catch(() => {
          attempts++;
          if (attempts >= maxAttempts) { resolve(false); } else { setTimeout(check, 500); }
        });
    };
    check();
  });
}

function startBackendAsChild() {
  const serverPath = path.join(__dirname, '..', 'dist', 'server.mjs');
  
  const tryShutdownExisting = async () => {
    try {
      await fetch('http://127.0.0.1:3000/api/daemon/shutdown', { method: 'POST', signal: AbortSignal.timeout(2000) });
    } catch (e) {
      // ignore
    }
  };

  const doStart = () => {
    backendProcess = spawn(process.execPath, [serverPath], {
      cwd: app.getPath('userData'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SYNCCLIENT_V2: 'true' }
    });

    backendProcess.stdout.on('data', (data) => {
      console.log(`[Backend] ${data}`);
    });

    backendProcess.stderr.on('data', (data) => {
      console.error(`[Backend] ${data}`);
    });

    backendProcess.on('exit', (code) => {
      backendReady = false;
      if (!isQuitting) {
        console.warn(`[Electron] Backend exited unexpectedly with code ${code}`);
      }
    });
  };

  tryShutdownExisting().then(doStart).catch(doStart);

  setTimeout(() => {
    if (!backendProcess) {
      doStart();
    }
  }, 3000);
}

async function stopBackend() {
  if (!backendProcess) return;
  
  const processRef = backendProcess;
  backendProcess = null;
  backendReady = false;

  try {
    processRef.kill('SIGTERM');
    await new Promise((resolve) => {
      processRef.on('exit', resolve);
      setTimeout(resolve, 5000);
    });
  } catch (e) {
    // ignore
  }

  if (!processRef.killed) {
    try { processRef.kill('SIGKILL'); } catch (e) { }
  }
}

async function callBackend(path, options = {}) {
  const res = await fetch(`http://127.0.0.1:3000${path}`, options);
  if (!res.ok) throw new Error(`Backend request failed: ${res.status}`);
  return res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`));
}

let currentTrayStatus = {
  isSyncing: false,
  percentage: 100,
  uploadSpeed: 0,
  downloadSpeed: 0,
  isOnline: true,
  pingMs: null,
  activePairsCount: 0,
  conflictsCount: 0,
  isPaused: false,
  currentFile: '',
  pairs: []
};

function formatTraySize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function sendActionToRenderer(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tray-action', action);
  }
}

function updateTrayStatus(statusData) {
  if (statusData) {
    currentTrayStatus = { ...currentTrayStatus, ...statusData };
  }
  if (!tray) return;

  const {
    isSyncing, percentage, uploadSpeed, downloadSpeed, isOnline, pingMs,
    isPaused, currentFile
  } = currentTrayStatus;

  const formattedUpload = formatTraySize(uploadSpeed);
  const formattedDownload = formatTraySize(downloadSpeed);

  const tooltipLines = [
    `SyncClient - ${isOnline ? '🟢 Red Online' : '🔴 Sin Conexión'}`,
    isSyncing
      ? `🚀 Sincronizando (${percentage}%) | ⬆️ ${formattedUpload}/s • ⬇️ ${formattedDownload}/s`
      : isPaused
        ? '⏸️ Sincronización Pausada'
        : '✅ Todo al día (100%)'
  ];
  if (isSyncing && currentFile) {
    tooltipLines.push(`📄 ${currentFile.length > 32 ? currentFile.slice(0, 29) + '...' : currentFile}`);
  }

  try {
    tray.setToolTip(tooltipLines.join('\n'));
  } catch (e) { }

  if (togglePauseMenuItem) {
    const targetLabel = isPaused ? '▶️ Reanudar Sincronización' : '⏸️ Pausar indefinidamente';
    if (togglePauseMenuItem.label !== targetLabel) {
      togglePauseMenuItem.label = targetLabel;
    }
  }
}

function createTray() {
  const image = nativeImage.createFromDataURL(iconDataUrl);
  tray = new Tray(image);

  togglePauseMenuItem = new MenuItem({
    label: '⏸️ Pausar indefinidamente',
    click: () => sendActionToRenderer('toggle-pause-sync')
  });

  staticContextMenu = Menu.buildFromTemplate([
    {
      label: '⚡ SyncClient - Google Drive',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '🖥️ Abrir Panel de Control (GUI)',
      click: () => {
        if (!mainWindow) {
          createWindow();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '⚡ Sincronizar Todo Ahora',
      click: () => sendActionToRenderer('force-sync-all')
    },
    {
      label: '⏸️ Pausar Sincronización por...',
      submenu: [
        {
          label: '⏱️ Pausar por 1 hora',
          click: () => setTimedPause(1)
        },
        {
          label: '⏱️ Pausar por 2 horas',
          click: () => setTimedPause(2)
        },
        togglePauseMenuItem,
      ]
    },
    {
      label: '✨ Limpiar Duplicados en Carpetas',
      click: () => sendActionToRenderer('clean-duplicates-all')
    },
    {
      label: '🧹 Limpiar Exclusiones en Nube',
      click: () => sendActionToRenderer('clean-cloud-trash')
    },
    { type: 'separator' },
    {
      label: '📝 Abrir Directorio de Logs',
      click: () => {
        const logDir = path.join(app.getPath('home'), '.config', 'syncclient', 'logs');
        shell.openPath(logDir);
      }
    },
    {
      label: '🌐 Abrir Google Drive en Navegador',
      click: () => shell.openExternal('https://drive.google.com')
    },
    { type: 'separator' },
    {
      label: '🛑 Apagar Demonio Backend y Salir',
      click: async () => {
        isQuitting = true;
        stopBackend();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(staticContextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    } else {
      createWindow();
    }
  });

  updateTrayStatus();
}

try {
  ipcMain.removeHandler('update-tray');
} catch (e) {}
ipcMain.handle('update-tray', async (_event, statusData) => {
  updateTrayStatus(statusData);
  return true;
});

function createWindow() {
  const mainSession = session.fromPartition('main', { cache: true });
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false, // FASE 5: Ocultar hasta que el renderizado esté listo
    backgroundColor: '#0a0a0a', // Mismo fondo oscuro de Tailwind (neutral-950)
    title: 'SyncClient - Google Drive Ubuntu',
    webPreferences: {
      // contextIsolation: true + preload → Firebase ve un navegador normal, no Node.js
      // Esto es la clave para que signInWithPopup funcione
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      session: mainSession,
    }
  });

  // Mostrar suavemente cuando el HTML esté listo (si no se solicitó inicio oculto)
  mainWindow.once('ready-to-show', () => {
    const isHidden = process.argv.includes('--hidden') || process.env.SYNCCLIENT_MINIMIZED === 'true';
    if (!isHidden) {
      mainWindow.show();
    } else {
      console.log('[Electron] Iniciando en modo bandeja del sistema (System Tray únicamente).');
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
      callBackend('/api/sync/app-visible', { method: 'POST', body: JSON.stringify({ visible: false }) }).catch(() => {});
      return false;
    }
  });

  mainWindow.on('hide', () => {
    callBackend('/api/sync/app-visible', { method: 'POST', body: JSON.stringify({ visible: false }) }).catch(() => {});
  });

  mainWindow.on('show', () => {
    callBackend('/api/sync/app-visible', { method: 'POST', body: JSON.stringify({ visible: true }) }).catch(() => {});
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[Electron] Error cargando página:', errorCode, errorDescription);
    if (errorCode !== -3) { // Ignore ABORTED
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[Electron] Reintentando conexión con http://127.0.0.1:3000...');
          mainWindow.loadURL('http://127.0.0.1:3000').catch(() => { });
        }
      }, 1000);
    }
  });

  const checkBackendHealth = (healthUrl) => {
    return new Promise((resolve) => {
      const req = require('http').get(healthUrl, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  };

  const loadWhenReady = async () => {
    let attempts = 0;
    while (mainWindow && !mainWindow.isDestroyed()) {
      attempts++;
      const isHealthy = await checkBackendHealth('http://127.0.0.1:3000/api/health');
      if (isHealthy) {
        await mainWindow.loadURL('http://127.0.0.1:3000');
        console.log('[Electron] Conexión establecida con el servidor backend.');

        if (!app.isPackaged) {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
        }

        mainWindow.webContents.on('did-finish-load', () => {
          console.log('[Electron] Frontend cargado correctamente.');
        });
        return;
      }
      if (attempts % 5 === 0 || attempts === 1) {
        console.log(`[Electron] Servidor backend iniciando, reintentando (${attempts})...`);
      }
      await new Promise(res => setTimeout(res, 500));
    }
  };
  loadWhenReady();
}

app.whenReady().then(async () => {
  app.commandLine.appendSwitch('disable-gpu-compositing');

  session.defaultSession.setUserAgent(firefoxUserAgent);

  app.on('web-contents-created', (_event, contents) => {
    contents.setUserAgent(firefoxUserAgent);
  });

  if (app.isPackaged) {
    startBackendAsChild();
    const ready = await waitForBackend();
    if (!ready) {
      console.error('[Electron] Backend did not start in time');
    }
  }

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
  stopBackend();
});

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') {
    app.quit();
  }
});