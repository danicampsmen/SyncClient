import express from "express";
import path from "path";
import os from "os";
import fs from "fs/promises";
import fsSync from "fs";
import crypto from "crypto";

// Cargar variables de .env para el proceso del servidor
// (tsx/Node.js no carga .env automáticamente como Vite lo hace para el frontend)
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fsSync.existsSync(envPath)) {
    const envContent = fsSync.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!process.env[key]) process.env[key] = value;
      }
    }
  }
} catch {
  // Ignorar errores de lectura de .env
}

try {
  // Habilitar Persistent HTTP Connections (Keep-Alive) para acelerar ráfagas de fetch
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 30000,     // 30 segundos
    keepAliveMaxTimeout: 60000,  // 1 minuto máximo
    connections: 50              // 50 conexiones concurrentes por host
  }));
} catch (e) {
  // Si undici no está disponible en este entorno, ignorar
}

import { syncEngine } from "./src/backend/syncEngine";
import { Logger } from "./src/backend/logger";

const CONFIG_DIR = path.join(os.homedir(), ".config", "syncclient");
const LOG_DIR = path.join(CONFIG_DIR, "logs");


// --- Utilidades de validación de entrada (Fix 11) ---

/** Directorios base permitidos para operaciones de sistema de archivos local */
const ALLOWED_BASE_DIRS: string[] = [
  path.join(os.homedir(), 'Documentos'),
  path.join(os.homedir(), 'Descargas'),
  path.join(os.homedir(), '.config', 'syncclient'),
  '/media',
  '/run/media'
];

/**
 * Valida que una ruta de archivo esté dentro de los directorios permitidos.
 * Previene path traversal (../../etc/passwd) y acceso a rutas sensibles.
 */
function isPathAllowed(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (targetPath.includes('\0') || targetPath.includes('\\')) return false;
  // Rechazar únicamente segmentos de traversal; nombres como "notes..pdf" son válidos.
  if (targetPath.split(path.sep).includes('..')) return false;

  const absolute = path.resolve(targetPath);
  const isWithin = (child: string, base: string): boolean => {
    const relative = path.relative(base, child);
    return relative === '' || (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  // FINDING-17 fix: incluir rutas locales de pares configurados activamente
  const activePairPaths = syncEngine.getStatus().pairs.map((p: any) => path.resolve(p.localPath)).filter(Boolean);
  const dynamicAllowedBases = [...ALLOWED_BASE_DIRS, ...activePairPaths];

  const allowedBases = dynamicAllowedBases.flatMap((base) => {
    let candidate = path.resolve(base);
    const missingSegments: string[] = [];
    try {
      return [fsSync.realpathSync.native(candidate)];
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return [];
      while (candidate !== path.dirname(candidate)) {
        missingSegments.unshift(path.basename(candidate));
        candidate = path.dirname(candidate);
        try {
          const parent = fsSync.realpathSync.native(candidate);
          return [path.join(parent, ...missingSegments)];
        } catch (ancestorError: any) {
          if (ancestorError?.code !== 'ENOENT' && ancestorError?.code !== 'ENOTDIR') return [];
        }
      }
      return [];
    }
  });

  let resolved: string;
  try {
    resolved = fsSync.realpathSync.native(absolute);
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return false;
    // Para una escritura nueva, canonicalizar el ancestro existente más cercano.
    let parent = absolute;
    while (parent !== path.dirname(parent)) {
      try {
        resolved = fsSync.realpathSync.native(parent);
        return allowedBases.some((base) => isWithin(resolved, base));
      } catch (ancestorError: any) {
        if (ancestorError?.code !== 'ENOENT' && ancestorError?.code !== 'ENOTDIR') return false;
        parent = path.dirname(parent);
      }
    }
    return false;
  }

  return allowedBases.some((base) => isWithin(resolved, base));
}


/** Valida que un valor sea un string no vacío y de longitud razonable */
function isValidString(val: any, maxLength = 4096): val is string {
  return typeof val === 'string' && val.length > 0 && val.length <= maxLength;
}

/** Valida que un valor sea un array */
function isValidArray(val: any): val is any[] {
  return Array.isArray(val);
}

function isValidSyncPair(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const pair = value as Record<string, unknown>;
  const localPath = typeof pair.localPath === 'string' && pair.localPath.startsWith('~/')
    ? path.join(os.homedir(), pair.localPath.slice(2))
    : pair.localPath;
  return isValidString(pair.id, 256) &&
    isValidString(localPath, 4096) && isPathAllowed(localPath) &&
    isValidString(pair.remotePath, 2048) &&
    ['bidirectional', 'upload', 'download'].includes(pair.direction as string) &&
    ['idle', 'syncing', 'error', 'paused', 'unauthenticated'].includes(pair.status as string) &&
    (pair.lastSynced === null || (typeof pair.lastSynced === 'number' && Number.isFinite(pair.lastSynced))) &&
    (pair.accountId === undefined || isValidString(pair.accountId, 256)) &&
    (pair.driveId === undefined || isValidString(pair.driveId, 256)) &&
    (pair.syncMode === undefined || ['mirror', 'streaming'].includes(pair.syncMode as string)) &&
    (pair.cloudCategory === undefined || ['computers', 'shared'].includes(pair.cloudCategory as string));
}

function isValidSyncSettings(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Record<string, unknown>;
  const validSpeed = (speed: unknown) => typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 && speed <= 1_000_000_000;
  return validSpeed(settings.maxDownloadSpeed) && validSpeed(settings.maxUploadSpeed) &&
    ['prompt', 'local', 'remote', 'rename'].includes(settings.conflictResolution as string) &&
    isValidArray(settings.ignoredPatterns) && settings.ignoredPatterns.length <= 100 &&
    settings.ignoredPatterns.every(pattern => isValidString(pattern, 256)) &&
    (settings.autoStart === undefined || typeof settings.autoStart === 'boolean') &&
    (settings.desktopNotifications === undefined || typeof settings.desktopNotifications === 'boolean');
}

async function startServer() {
  Logger.initialize(LOG_DIR);

  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // Habilitar CORS restringido a orígenes locales de confianza
  // Se permite localhost (Electron, Capacitor via ADB reverse) y el origen configurado vía env
  const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost',
    'capacitor://localhost',
    'ionic://localhost',
    process.env.CORS_ORIGIN || '',
  ].filter(Boolean));

  app.use((req, res, next) => {
    const origin = req.get('Origin') || '';
    if (allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Vary', 'Origin');
    // Permitir que la ventana emergente de OAuth se comunique con la app principal
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SyncClient-Client');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  type Session = { createdAt: number; lastSeenAt: number };
  const sessions = new Map<string, Session>();
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
  const sessionCookieName = 'syncclient_session';
  const newSessionId = () => crypto.randomBytes(32).toString('base64url');

  const getCookie = (req: express.Request, name: string): string | null => {
    const cookies = req.get('Cookie')?.split(';') || [];
    const cookie = cookies.find((value) => value.trim().startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.trim().slice(name.length + 1)) : null;
  };

  const getSessionId = (req: express.Request): string | null => {
    const bearer = req.get('Authorization');
    if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length).trim() || null;
    return getCookie(req, sessionCookieName);
  };

  const setSessionCookie = (res: express.Response, sessionId: string): void => {
    res.setHeader(
      'Set-Cookie',
      `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
    );
  };

  const createSession = (): string => {
    const now = Date.now();
    const sessionId = newSessionId();
    sessions.set(sessionId, { createdAt: now, lastSeenAt: now });
    return sessionId;
  };

  const cleanupSessions = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeenAt < cutoff) sessions.delete(sessionId);
    }
  }, 15 * 60 * 1000);
  cleanupSessions.unref();

  // Bootstrap anónimo sólo crea una sesión local; no entrega tokens de Google.
  // Android recibe un bearer efímero porque algunos WebView no conservan cookies.
  app.get('/api/session/bootstrap', (req, res) => {
    let sessionId = getSessionId(req);
    const current = sessionId ? sessions.get(sessionId) : undefined;
    if (!current || Date.now() - current.lastSeenAt > SESSION_TTL_MS) {
      sessionId = createSession();
      setSessionCookie(res, sessionId);
    } else {
      current.lastSeenAt = Date.now();
    }
    res.setHeader('Cache-Control', 'no-store');
    const response: { authenticated: boolean; sessionToken?: string } = { authenticated: true };
    if (req.get('X-SyncClient-Client') === 'android') response.sessionToken = sessionId || undefined;
    res.json(response);
  });

  const oauthTransactions = new Map<string, {
    sessionId: string;
    createdAt: number;
    code?: string;
  }>();
  const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

  // Todas las APIs, incluido el relay OAuth, requieren la sesión local.
  app.use('/api', (req, res, next) => {
    // El navegador de Android no comparte cookies con el WebView de la app.
    // El state de alta entropía es el único permiso para entregar el code al relay;
    // la lectura posterior sigue exigiendo la sesión local de la app.
    if (req.path === '/health' || req.path === '/session/bootstrap' || req.path === '/oauth/callback' ||
      (req.path === '/oauth/token' && req.method === 'POST')) return next();
    const sessionId = getSessionId(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
      return res.status(401).json({ error: 'Sesión local requerida' });
    }
    const origin = req.get('Origin');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: 'Origen no permitido' });
    }
    session.lastSeenAt = Date.now();
    (req as express.Request & { sessionId?: string }).sessionId = sessionId!;
    next();
  });

  // --- RELAY DE OAUTH PARA MÓVIL (Chrome Custom Tab → PC Backend → App) ---

  // La página de callback nunca contiene tokens; sólo reenvía el código una vez.
  app.get('/api/oauth/callback', (req, res) => {
    if (!req.query.state || !req.query.code) {
      return res.status(400).send('Solicitud OAuth inválida.');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SyncClient – Autenticando...</title>
  <style>
    body { font-family: sans-serif; display:flex; align-items:center; justify-content:center;
           min-height:100vh; margin:0; background:#0f172a; color:#e2e8f0; text-align:center; }
    .card { background:#1e293b; padding:2rem; border-radius:1rem; max-width:340px; }
    .icon { font-size:3rem; margin-bottom:1rem; }
    h2 { margin:0 0 .5rem; }
    p { color:#94a3b8; margin:0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon" id="icon">⏳</div>
    <h2 id="title">Procesando autenticación...</h2>
    <p id="msg">Un momento por favor.</p>
  </div>
  <script>
    (async function() {
      const queryParams = new URLSearchParams(window.location.search);
      const code = queryParams.get('code');
      const state = queryParams.get('state');

      if (code && state) {
        try {
          const response = await fetch('/api/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, state })
          });
          if (!response.ok) throw new Error('relay rejected');
          document.getElementById('icon').textContent = '\u2705';
          document.getElementById('title').textContent = '\u00a1Listo! Sesión iniciada.';
          document.getElementById('msg').textContent = 'Procesando código de autorización...';
          setTimeout(() => window.close && window.close(), 1500);
        } catch (e) {}
      } else {
        document.getElementById('icon').textContent = '\u274c';
        document.getElementById('title').textContent = 'Error de autenticación';
        document.getElementById('msg').textContent = 'No se recibió un código válido.';
      }
    })();
  </script>
</body>
</html>`);
  });

  app.post('/api/oauth/prepare', (req, res) => {
    const { state } = req.body;
    const sessionId = (req as express.Request & { sessionId?: string }).sessionId;
    if (!sessionId || !isValidString(state, 256) || !/^[A-Za-z0-9_-]{16,256}$/.test(state)) {
      return res.status(400).json({ error: 'Estado OAuth inválido' });
    }
    const now = Date.now();
    for (const [key, transaction] of oauthTransactions) {
      if (now - transaction.createdAt > OAUTH_TRANSACTION_TTL_MS) oauthTransactions.delete(key);
    }
    oauthTransactions.set(state, { sessionId, createdAt: now });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  // Recibe sólo authorization codes. El intercambio PKCE ocurre en el cliente;
  // nunca se aceptan access tokens ni se almacenan secretos en este relay.
  app.post('/api/oauth/token', (req, res) => {
    const { code, state, codeVerifier } = req.body;
    const transaction = typeof state === 'string' ? oauthTransactions.get(state) : undefined;
    const requestSessionId = getSessionId(req);
    if (!isValidString(code, 4096) || !isValidString(state, 256) ||
      !transaction ||
      Date.now() - transaction.createdAt > OAUTH_TRANSACTION_TTL_MS ||
      transaction.code) {
      return res.status(400).json({ error: 'Estado OAuth inválido o sesión expirada' });
    }
    if (codeVerifier !== undefined && !isValidString(codeVerifier, 256)) {
      return res.status(400).json({ error: 'PKCE inválido' });
    }
    if (codeVerifier && requestSessionId !== transaction.sessionId) {
      return res.status(401).json({ error: 'Sesión OAuth inválida' });
    }
    if (codeVerifier) {
      oauthTransactions.delete(state);
    } else {
      transaction.code = code;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  // La consulta también está vinculada a la sesión y consume el código una sola vez.
  app.get('/api/oauth/token', (req, res) => {
    const sessionId = (req as express.Request & { sessionId?: string }).sessionId;
    const transaction = [...oauthTransactions.entries()]
      .filter(([, value]) => value.sessionId === sessionId && value.code &&
        Date.now() - value.createdAt <= OAUTH_TRANSACTION_TTL_MS)
      .sort(([, a], [, b]) => b.createdAt - a.createdAt)[0];
    res.setHeader('Cache-Control', 'no-store');
    if (!transaction) return res.json({ code: null });
    const [state, value] = transaction;
    oauthTransactions.delete(state);
    res.json({ code: value.code, state });
  });

  // --- API DE MOTOR DE SINCRONIZACIÓN EN SEGUNDO PLANO ---

  // P13: Health check endpoint para monitoreo de disponibilidad del backend
  app.get("/api/health", (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  app.get("/api/sync/status", (req, res) => {
    res.json(syncEngine.getStatus());
  });

  app.post("/api/sync/token", (req, res) => {
    const { token, refreshToken } = req.body;
    if (token !== null && !isValidString(token, 8192)) {
      return res.status(400).json({ error: "token inválido" });
    }
    if (refreshToken !== undefined && refreshToken !== null && !isValidString(refreshToken, 8192)) {
      return res.status(400).json({ error: "refresh token inválido" });
    }
    syncEngine.setToken(token as string | null, (refreshToken || undefined) as string | undefined);
    res.json({ success: true });
  });

  app.post("/api/sync/pairs", async (req, res) => {
    try {
      const { pairs } = req.body;
      if (!isValidArray(pairs) || pairs.length > 100 || !pairs.every(isValidSyncPair)) {
        return res.status(400).json({ error: "pairs debe ser un array" });
      }
      await syncEngine.setPairs(pairs);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/settings", async (req, res) => {
    try {
      const { settings } = req.body;
      if (!isValidSyncSettings(settings)) {
        return res.status(400).json({ error: "settings inválidos" });
      }
      await syncEngine.updateSettings(settings);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/reset-db", async (req, res) => {
    if (!syncEngine) return res.status(500).json({ error: "No sync engine" });
    try {
      await syncEngine.resetDatabase();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/sync/toggle", async (req, res) => {
    try {
      const { pairId } = req.body;
      if (!isValidString(pairId, 256)) {
        return res.status(400).json({ error: "pairId inválido" });
      }
      await syncEngine.togglePairSync(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/force", async (req, res) => {
    try {
      const { pairId } = req.body;
      if (!isValidString(pairId, 256)) {
        return res.status(400).json({ error: "pairId inválido" });
      }
      await syncEngine.forceSync(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/clean-duplicates", async (req, res) => {
    try {
      const { pairId } = req.body;
      if (!isValidString(pairId, 256)) {
        return res.status(400).json({ error: "pairId inválido" });
      }
      const result = await syncEngine.cleanDuplicates(pairId);
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/pause", async (req, res) => {
    try {
      const { pairId } = req.body;
      if (!isValidString(pairId, 256)) {
        return res.status(400).json({ error: "pairId inválido" });
      }
      await syncEngine.pausePair(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/sync/pair", async (req, res) => {
    try {
      const { id } = req.body;
      if (!isValidString(id, 256)) {
        return res.status(400).json({ error: "id inválido" });
      }
      await syncEngine.removePair(id);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/diag/colors", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "color-diagnostic.html"));
  });

  app.post("/api/sync/resolve-conflict", async (req, res) => {
    try {
      const { conflictId, resolution } = req.body;
      if (!isValidString(conflictId, 256)) {
        return res.status(400).json({ error: "conflictId inválido" });
      }
      if (!['local', 'remote', 'rename'].includes(resolution)) {
        return res.status(400).json({ error: "resolution debe ser local, remote o rename" });
      }
      await syncEngine.resolveConflict(conflictId, resolution);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/dismiss-alert", (req, res) => {
    try {
      const { drivePath } = req.body;
      if (!isValidString(drivePath, 1024)) {
        return res.status(400).json({ error: "drivePath inválido" });
      }
      syncEngine.dismissExternalDriveAlert(drivePath);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/mode", async (req, res) => {
    try {
      const { pairId, syncMode, cloudCategory } = req.body;
      if (!isValidString(pairId, 256) || !['mirror', 'streaming'].includes(syncMode) ||
        (cloudCategory !== undefined && !['computers', 'shared'].includes(cloudCategory))) {
        return res.status(400).json({ error: "modo de sincronización inválido" });
      }
      await syncEngine.setPairMode(pairId, syncMode, cloudCategory);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/dehydrate", async (req, res) => {
    try {
      const { pairId } = req.body;
      if (!isValidString(pairId, 256)) {
        return res.status(400).json({ error: "pairId inválido" });
      }
      await syncEngine.dehydratePair(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/hydrate", async (req, res) => {
    try {
      const { pairId } = req.body;
      if (!isValidString(pairId, 256)) {
        return res.status(400).json({ error: "pairId inválido" });
      }
      await syncEngine.hydratePair(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- API DE SISTEMA DE ARCHIVOS LOCAL (Con soporte binario y Base64) ---
  app.get("/api/local/files", async (req, res) => {
    try {
      const targetPath = req.query.path as string;
      if (!targetPath) return res.status(400).json({ error: "path required" });
      if (!isPathAllowed(targetPath)) return res.status(403).json({ error: "path no permitido" });

      const stats = await fs.stat(targetPath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: "not a directory" });
      }

      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const files = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(targetPath, entry.name);
        try {
          const fileStats = await fs.stat(fullPath);
          return {
            id: fullPath,
            name: entry.name,
            mimeType: entry.isDirectory() ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
            modifiedTime: fileStats.mtime.toISOString(),
            size: fileStats.size
          };
        } catch (e) {
          return null;
        }
      }));

      res.json({ files: files.filter(Boolean) });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.json({ files: [] });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // API to get local file content (Soporta base64 para datos binarios)
  app.get("/api/local/content", async (req, res) => {
    try {
      const targetPath = req.query.path as string;
      const base64 = req.query.base64 === 'true';
      if (!targetPath) return res.status(400).json({ error: "path required" });
      if (!isPathAllowed(targetPath)) return res.status(403).json({ error: "path no permitido" });

      if (base64) {
        const content = await fs.readFile(targetPath, 'base64');
        res.json({ content, base64: true });
      } else {
        const content = await fs.readFile(targetPath, 'utf8');
        res.send(content);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API to write local file (Soporta escritura de binarios vía base64 o utf8)
  app.post("/api/local/content", async (req, res) => {
    try {
      const targetPath = req.query.path as string;
      const { content, base64 } = req.body;
      if (!isValidString(targetPath, 4096)) return res.status(400).json({ error: "path required" });
      if (!isPathAllowed(targetPath)) return res.status(403).json({ error: "path no permitido" });
      if (typeof content !== 'string') return res.status(400).json({ error: "content debe ser un string" });
      if (typeof base64 !== 'undefined' && typeof base64 !== 'boolean') {
        return res.status(400).json({ error: "base64 inválido" });
      }

      const dataBuffer = base64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const temporaryPath = `${targetPath}.syncclient-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fs.writeFile(temporaryPath, dataBuffer, { flag: 'wx' });
        await fs.rename(temporaryPath, targetPath);
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => { });
      }
      res.json({ success: true });
    } catch (err: any) {
      const status = err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // API to create directory
  app.post("/api/local/dir", async (req, res) => {
    try {
      const targetPath = req.query.path as string;
      if (!targetPath) return res.status(400).json({ error: "path required" });
      if (!isPathAllowed(targetPath)) return res.status(403).json({ error: "path no permitido" });

      await fs.mkdir(targetPath, { recursive: true });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API to delete file/dir
  app.delete("/api/local/files", async (req, res) => {
    try {
      const targetPath = req.query.path as string;
      if (!targetPath) return res.status(400).json({ error: "path required" });
      if (!isPathAllowed(targetPath)) return res.status(403).json({ error: "path no permitido" });

      await fs.rm(targetPath, { recursive: true, force: true });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API to deduplicate StarNote export files (remove (1), (2) copies and keep latest)
  app.post("/api/local/deduplicate", async (req, res) => {
    try {
      const targetPath = (req.query.path || req.body?.path) as string;
      if (!targetPath) return res.status(400).json({ error: "path required" });
      if (!isPathAllowed(targetPath)) return res.status(403).json({ error: "path no permitido" });

      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const files = entries.filter(e => !e.isDirectory());
      const groups = new Map<string, Array<{ name: string; mtime: number; version: number }>>();

      for (const file of files) {
        const fullPath = path.join(targetPath, file.name);
        let mtime = 0;
        try { mtime = (await fs.stat(fullPath)).mtimeMs; } catch { continue; }
        const match = file.name.match(/^(.+?)(?:\s*\(\s*(\d+)\s*\))+\.([a-zA-Z0-9]+)$/);
        if (match) {
          const baseName = `${match[1].trim()}.${match[3]}`;
          const ver = parseInt(match[2], 10);
          if (!groups.has(baseName)) groups.set(baseName, []);
          groups.get(baseName)!.push({ name: file.name, mtime, version: ver });
        } else {
          if (!groups.has(file.name)) groups.set(file.name, []);
          groups.get(file.name)!.push({ name: file.name, mtime, version: 0 });
        }
      }

      let deleted = 0;
      let renamed = 0;

      for (const [baseName, versions] of groups.entries()) {
        versions.sort((a, b) => {
          const diff = b.mtime - a.mtime;
          return Math.abs(diff) > 2000 ? diff : b.version - a.version;
        });
        const winner = versions[0];
        const losers = versions.slice(1);
        for (const loser of losers) {
          await fs.unlink(path.join(targetPath, loser.name)).catch(() => { });
          deleted++;
        }
        if (winner.name !== baseName) {
          await fs.rename(path.join(targetPath, winner.name), path.join(targetPath, baseName)).catch(() => { });
          renamed++;
        }
      }
      res.json({ success: true, deleted, renamed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Detectar modo producción de forma segura tanto en ESM (tsx) como en CJS (dist/server.cjs o app.asar)
  const isCjs = typeof __filename !== 'undefined';
  const isProduction = process.env.NODE_ENV === "production" || (isCjs && (__filename.endsWith(".cjs") || __dirname.includes("dist") || __dirname.includes("app.asar")));

  if (!isProduction) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = typeof __dirname !== 'undefined' && (__dirname.includes("dist") || __dirname.includes("app.asar")) ? __dirname : path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, "127.0.0.1", () => {
    console.log(`[Info] Servidor backend activo en http://127.0.0.1:${PORT}`);
  }).on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[Info] El servidor backend ya está activo en el puerto ${PORT}`);
    } else {
      console.error('[Error] Error al iniciar el servidor:', err);
    }
  });

  // --- Lógica de Cierre Controlado (Graceful Shutdown) ---
  const gracefulShutdown = (signal: string) => {
    console.log(`[Info] Recibida señal ${signal}. Cerrando el servidor de forma controlada...`);
    httpServer.close(async () => {
      console.log('[Info] Servidor HTTP cerrado.');
      try {
        await syncEngine.shutdown();
        console.log('[Info] Motor de sincronización detenido.');
      } catch (error) {
        console.error('[Error] Error al detener el motor de sincronización:', error);
      }
      Logger.close();
      process.exit(0);
    });
  };

  // Escuchar señales de terminación
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

startServer();