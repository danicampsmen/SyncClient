import express from "express";
import path from "path";
import os from "os";
import fs from "fs/promises";
import fsSync from "fs";
import { syncEngine } from "./src/backend/syncEngine";

// --- Utilidades de validación de entrada (Fix 11) ---

/** Directorios base permitidos para operaciones de sistema de archivos local */
const ALLOWED_BASE_DIRS: string[] = [
  path.join(os.homedir(), 'Documentos'),
  path.join(os.homedir(), 'Descargas'),
  path.join(os.homedir(), '.config', 'syncclient'),
  '/media',
  '/run/media',
  '/tmp'
];

/**
 * Valida que una ruta de archivo esté dentro de los directorios permitidos.
 * Previene path traversal (../../etc/passwd) y acceso a rutas sensibles.
 */
function isPathAllowed(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;
  // Rechazar rutas con secuencias de traversal explícitas
  if (targetPath.includes('..')) return false;
  // B10 Fix: Resolver symlinks antes de validar para prevenir bypass
  let resolved: string;
  try {
    resolved = fsSync.realpathSync(targetPath);
  } catch {
    // Si el archivo no existe aún, usar path.resolve como fallback
    resolved = path.resolve(targetPath);
  }
  // Verificar que la ruta comience con alguno de los directorios permitidos
  return ALLOWED_BASE_DIRS.some(base => resolved.startsWith(base));
}

/** Valida que un valor sea un string no vacío y de longitud razonable */
function isValidString(val: any, maxLength = 4096): val is string {
  return typeof val === 'string' && val.length > 0 && val.length <= maxLength;
}

/** Valida que un valor sea un array */
function isValidArray(val: any): val is any[] {
  return Array.isArray(val);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // Habilitar CORS restringido a orígenes locales de confianza
  // Se permite localhost (Electron, Capacitor via ADB reverse) y el origen configurado vía env
  const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.CORS_ORIGIN || '',
  ].filter(Boolean));

  app.use((req, res, next) => {
    const origin = req.get('Origin') || '';
    if (allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // --- RELAY DE OAUTH PARA MÓVIL (Chrome Custom Tab → PC Backend → App) ---
  let pendingOAuthToken: string | null = null;
  let pendingOAuthTimestamp = 0;

  // Página de captura del token: Chrome Custom Tab la carga cuando Google redirige aquí
  // Soporta tanto implicit flow (access_token) como authorization code flow (code)
  app.get('/api/oauth/callback', (_req, res) => {
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
      // Intentar extraer parámetros del hash (implicit flow) o query string (authorization code flow)
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const queryParams = new URLSearchParams(window.location.search);
      const token = hashParams.get('access_token');
      const code = queryParams.get('code');
      const state = queryParams.get('state');

      if (token) {
        // Implicit flow: enviar token al relay
        try {
          await fetch('http://localhost:3000/api/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          });
        } catch (e) {}
        document.getElementById('icon').textContent = '\u2705';
        document.getElementById('title').textContent = '\u00a1Listo! Sesión iniciada.';
        document.getElementById('msg').textContent = 'Puedes volver a la app SyncClient.';
        setTimeout(() => window.close && window.close(), 1500);
      } else if (code && state) {
        // Authorization code flow: relay el código para que la app lo intercambie
        try {
          await fetch('http://localhost:3000/api/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, state })
          });
        } catch (e) {}
        document.getElementById('icon').textContent = '\u2705';
        document.getElementById('title').textContent = '\u00a1Listo! Sesión iniciada.';
        document.getElementById('msg').textContent = 'Procesando código de autorización...';
        setTimeout(() => window.close && window.close(), 1500);
      } else if (queryParams.get('error')) {
        document.getElementById('icon').textContent = '\u274c';
        document.getElementById('title').textContent = 'Error de autenticación';
        document.getElementById('msg').textContent = queryParams.get('error_description') || queryParams.get('error') || 'Acceso denegado.';
      } else {
        document.getElementById('icon').textContent = '\u274c';
        document.getElementById('title').textContent = 'Error de autenticación';
        document.getElementById('msg').textContent = 'No se encontró el token. Intenta de nuevo.';
      }
    })();
  </script>
</body>
</html>`);
  });

  // Recibe el token o código desde la página de captura o desde Electron
  app.post('/api/oauth/token', async (req, res) => {
    const { token, code, state, codeVerifier } = req.body;

    if (token) {
      // Implicit flow: almacenar token para relay móvil
      pendingOAuthToken = token;
      pendingOAuthTimestamp = Date.now();
      console.log('[OAuth/Relay] Token de Google Drive capturado exitosamente via relay.');
      return res.json({ ok: true });
    }

    if (code) {
      // Authorization Code Flow: intercambiar code por tokens
      // Usa client_secret (del JSON) + code_verifier (recibido de Electron)
      try {
        const configRaw = await fs.readFile(
          path.join(import.meta.dirname, 'firebase-applet-config.json'), 'utf8'
        );
        const config = JSON.parse(configRaw);
        const clientId = config.oAuthClientId;
        const clientSecret = config.oAuthClientSecret;

        if (!clientId) {
          console.error('[OAuth] oAuthClientId no encontrado en firebase-applet-config.json');
          return res.status(500).json({ error: 'Falta oAuthClientId en firebase-applet-config.json. Contacta al desarrollador.' });
        }

        if (!clientSecret) {
          console.error('[OAuth] oAuthClientSecret no encontrado en firebase-applet-config.json');
          return res.status(500).json({ error: 'Falta oAuthClientSecret en firebase-applet-config.json.' });
        }

        const bodyParams: Record<string, string> = {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: 'http://localhost:3000/api/oauth/callback',
          grant_type: 'authorization_code',
        };

        // Incluir code_verifier si se envió (PKCE desde Electron)
        if (codeVerifier && typeof codeVerifier === 'string' && codeVerifier.length > 0) {
          bodyParams.code_verifier = codeVerifier;
          console.log('[OAuth] code_verifier presente, intercambiando con PKCE + client_secret');
        } else {
          console.log('[OAuth] Sin code_verifier, intercambiando solo con client_secret');
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(bodyParams).toString(),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          console.error('[OAuth] Google token exchange failed:', tokenRes.status, errText);
          return res.status(502).json({ error: 'Token exchange failed', detail: errText });
        }

        const tokens = await tokenRes.json();
        console.log('[OAuth] ✅ Tokens obtenidos (access_token + refresh_token)');
        return res.json({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || null,
        });
      } catch (err) {
        console.error('[OAuth] Error in token exchange:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    res.status(400).json({ error: 'No token or code provided' });
  });

  // Permite que la app móvil consulte si ya hay un token disponible
  app.get('/api/oauth/token', (_req, res) => {
    const isValid = pendingOAuthToken && (Date.now() - pendingOAuthTimestamp) < 300_000;
    if (isValid) {
      const data = pendingOAuthToken!;
      pendingOAuthToken = null; // Consumir (un solo uso)
      // Si es un JSON con code, parsearlo y devolver code/state
      try {
        const parsed = JSON.parse(data);
        if (parsed.code && parsed.state) {
          res.json({ code: parsed.code, state: parsed.state });
        } else {
          res.json({ token: data });
        }
      } catch {
        res.json({ token: data });
      }
    } else {
      res.json({ token: null });
    }
  });

  // --- API DE MOTOR DE SINCRONIZACIÓN EN SEGUNDO PLANO ---

  app.get("/api/sync/status", (req, res) => {
    res.json(syncEngine.getStatus());
  });

  app.post("/api/sync/token", (req, res) => {
    const { token } = req.body;
    if (token !== null && !isValidString(token, 8192)) {
      return res.status(400).json({ error: "token inválido" });
    }
    syncEngine.setToken(token as string | null);
    res.json({ success: true });
  });

  app.post("/api/sync/pairs", async (req, res) => {
    try {
      const { pairs } = req.body;
      if (!isValidArray(pairs)) {
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
      await syncEngine.updateSettings(settings);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      const pairId = req.query.id as string;
      if (!isValidString(pairId, 256)) {
        return res.status(400).json({ error: "id inválido" });
      }
      await syncEngine.removePair(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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
      if (!targetPath) return res.status(400).json({ error: "path required" });
      if (!isPathAllowed(targetPath)) return res.status(403).json({ error: "path no permitido" });

      const dataBuffer = base64 ? Buffer.from(content || '', 'base64') : Buffer.from(content || '', 'utf8');
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, dataBuffer);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[Info] El servidor backend ya está activo en el puerto ${PORT}`);
    } else {
      console.error('Error en el servidor express:', err);
    }
  });
}

startServer();
