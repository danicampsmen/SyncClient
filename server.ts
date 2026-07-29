import express from "express";
import path from "path";
import fs from "fs/promises";
import { syncEngine } from "./src/backend/syncEngine";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // Habilitar CORS para que Capacitor y la app móvil (https://localhost) puedan comunicarse con el servidor local
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // --- RELAY DE OAUTH PARA MÓVIL (Chrome Custom Tab → PC Backend → App) ---
  // Almacenamiento temporal del token capturado (expira en 5 min)
  let pendingOAuthToken: string | null = null;
  let pendingOAuthTimestamp = 0;

  // Página de captura del token: Chrome Custom Tab la carga cuando Google redirige aquí
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
    const hash = window.location.hash.substring(1) || window.location.search.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    if (token) {
      fetch('http://localhost:3000/api/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      }).then(() => {
        document.getElementById('icon').textContent = '✅';
        document.getElementById('title').textContent = '¡Listo! Sesión iniciada.';
        document.getElementById('msg').textContent = 'Puedes volver a la app SyncClient.';
        setTimeout(() => window.close && window.close(), 1500);
      }).catch(() => {
        document.getElementById('icon').textContent = '✅';
        document.getElementById('title').textContent = '¡Listo! Sesión iniciada.';
        document.getElementById('msg').textContent = 'Vuelve a la app SyncClient.';
      });
    } else {
      document.getElementById('icon').textContent = '❌';
      document.getElementById('title').textContent = 'Error de autenticación';
      document.getElementById('msg').textContent = 'No se encontró el token. Intenta de nuevo.';
    }
  </script>
</body>
</html>`);
  });

  // Recibe el token desde la página de captura
  app.post('/api/oauth/token', (req, res) => {
    const { token } = req.body;
    if (token) {
      pendingOAuthToken = token;
      pendingOAuthTimestamp = Date.now();
      console.log('[OAuth/Relay] Token de Google Drive capturado exitosamente via relay.');
    }
    res.json({ ok: true });
  });

  // Permite que la app móvil consulte si ya hay un token disponible
  app.get('/api/oauth/token', (_req, res) => {
    const isValid = pendingOAuthToken && (Date.now() - pendingOAuthTimestamp) < 300_000;
    if (isValid) {
      const token = pendingOAuthToken;
      pendingOAuthToken = null; // Consumir el token (un solo uso)
      res.json({ token });
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
    syncEngine.setToken(token || null);
    res.json({ success: true });
  });

  app.post("/api/sync/pairs", async (req, res) => {
    try {
      const { pairs } = req.body;
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
      await syncEngine.togglePairSync(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/force", async (req, res) => {
    try {
      const { pairId } = req.body;
      await syncEngine.forceSync(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/clean-duplicates", async (req, res) => {
    try {
      const { pairId } = req.body;
      const result = await syncEngine.cleanDuplicates(pairId);
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/pause", async (req, res) => {
    try {
      const { pairId } = req.body;
      await syncEngine.pausePair(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/sync/pair", async (req, res) => {
    try {
      const pairId = req.query.id as string;
      await syncEngine.removePair(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/resolve-conflict", async (req, res) => {
    try {
      const { conflictId, resolution } = req.body;
      await syncEngine.resolveConflict(conflictId, resolution);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/dismiss-alert", (req, res) => {
    try {
      const { drivePath } = req.body;
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
      await syncEngine.dehydratePair(pairId);
      res.json({ success: true, status: syncEngine.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sync/hydrate", async (req, res) => {
    try {
      const { pairId } = req.body;
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
          await fs.unlink(path.join(targetPath, loser.name)).catch(() => {});
          deleted++;
        }
        if (winner.name !== baseName) {
          await fs.rename(path.join(targetPath, winner.name), path.join(targetPath, baseName)).catch(() => {});
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
