import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // FASE 5: Evitar que Vite intente empaquetar librerías nativas de Node.js en el Frontend
      rollupOptions: {
        external: [
          'fs', 'fs/promises', 'path', 'crypto', 'os', 'child_process', 'stream',
          'node:fs', 'node:fs/promises', 'node:path', 'node:crypto', 'node:os', 'node:child_process', 'node:stream',
          'node:module', 'node:perf_hooks', 'better-sqlite3', '@parcel/watcher'
        ]
      },
      chunkSizeWarningLimit: 1000,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});