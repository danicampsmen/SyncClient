import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { DEFAULT_LOCAL_DIR_NAME, ANDROID_STARNOTE_BASE, ANDROID_STARNOTE_EXPORT } from '../shared/CoreSyncLogic';
import { backendFetch } from '../services/backendSession';

/**
 * VFSBridge (Virtual File System Bridge)
 * Abstrae el acceso y monitoreo del sistema de archivos entre:
 * 1. Linux Desktop (vía Electron y Express Backend)
 * 2. Android Nativo (Tabletas y Celulares vía @capacitor/filesystem)
 */

export interface VFSFolderInfo {
  path: string;
  name: string;
  deviceType: 'desktop' | 'tablet' | 'mobile';
  deviceLabel: string;
}

export class VFSBridge {
  public static isNative(): boolean {
    return Capacitor.isNativePlatform();
  }

  public static getPlatform(): string {
    return Capacitor.getPlatform(); // 'web', 'ios', o 'android'
  }

  public static getDeviceLabel(): string {
    if (this.isNative()) {
      const isTablet = window.innerWidth >= 768 && window.innerHeight >= 600;
      return isTablet ? 'Tableta-Android' : 'Celular-Android';
    }
    return 'Linux-Workstation';
  }

  /**
   * Devuelve el directorio HOME del usuario actual (Linux/macOS/Windows)
   * Usado como base para rutas de archivo genéricas en lugar de paths hardcodeados
   */
  public static getHomeDir(): string {
    if (typeof process !== 'undefined' && process.env?.HOME) {
      return process.env.HOME;
    }
    if (typeof process !== 'undefined' && process.env?.USERPROFILE) {
      return process.env.USERPROFILE;
    }
    return '/home/user';
  }

  /**
   * Permite seleccionar o sugerir rutas locales en el dispositivo actual
   * Especial para seleccionar la carpeta de apuntes de StarNote en Android o ~/Documentos en Linux
   */
  public static async selectLocalFolder(customPrompt?: string): Promise<string | null> {
    if (this.isNative()) {
      const suggestedAndroidPaths = [
        ANDROID_STARNOTE_EXPORT,
        ANDROID_STARNOTE_BASE,
        '/storage/emulated/0/Download/Respaldos',
        '/storage/emulated/0/DCIM/Camera'
      ];
      console.log('[VFSBridge/Android] Seleccionando ruta de almacenamiento nativa en dispositivo móvil.');
      return suggestedAndroidPaths[0];
    } else {
      if (typeof window !== 'undefined' && (window as any).electronBridge?.selectDirectory) {
        try {
          const res = await (window as any).electronBridge.selectDirectory();
          if (res && res.path) return res.path;
        } catch (e) {
          console.error('[VFSBridge] Error en selector nativo de Linux Desktop:', e);
        }
      }
      return VFSBridge.getHomeDir() + '/Documentos/' + DEFAULT_LOCAL_DIR_NAME;
    }
  }

  /**
   * Lista directorios locales de manera interactiva (para modal en Android/Linux)
   */
  public static async listLocalDirectories(dirPath: string): Promise<Array<{ name: string; path: string }>> {
    if (this.isNative()) {
      try {
        try { await Filesystem.requestPermissions(); } catch (_) { }

        let relativePath = dirPath.replace(/^\/storage\/emulated\/0\/?/, '');
        const res = await Filesystem.readdir({
          path: relativePath,
          directory: Directory.ExternalStorage
        });
        return (res.files || [])
          .filter(f => f.type === 'directory' || (!f.type && f.name && !f.name.includes('.')))
          .map(f => ({
            name: f.name,
            path: (dirPath === '/storage/emulated/0' ? '/storage/emulated/0/' : dirPath.replace(/\/$/, '') + '/') + f.name
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err: any) {
        console.warn(`[VFSBridge/Android] Error al listar ${dirPath}:`, err);
        return [];
      }
    } else {
      try {
        const res = await backendFetch(`/api/local/files?path=${encodeURIComponent(dirPath)}`);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.files || [])
          .filter((f: any) => f.mimeType === 'application/vnd.google-apps.folder')
          .map((f: any) => ({
            name: f.name,
            path: f.id
          }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name));
      } catch (e) {
        console.error('[VFSBridge/Linux] Error listando en servidor local:', e);
        return [];
      }
    }
  }

  /**
   * Crea una nueva carpeta en el sistema de archivos local del dispositivo actual
   */
  public static async createLocalDirectory(dirPath: string): Promise<boolean> {
    if (this.isNative()) {
      try {
        let relativePath = dirPath.replace(/^\/storage\/emulated\/0\/?/, '');
        await Filesystem.mkdir({
          path: relativePath,
          directory: Directory.ExternalStorage,
          recursive: true
        });
        return true;
      } catch (e) {
        console.error('[VFSBridge/Android] Error creando carpeta local:', e);
        return false;
      }
    } else {
      try {
        const res = await backendFetch(`/api/local/dir?path=${encodeURIComponent(dirPath)}`, {
          method: 'POST',
        });
        if (!res.ok) {
          console.warn(`[VFSBridge/Linux] Error creando carpeta (${res.status})`);
        }
        return res.ok;
      } catch (e) {
        console.error('[VFSBridge/Linux] Error creando carpeta en servidor local:', e);
        return false;
      }
    }
  }

  /**
   * Lee un archivo como texto o base64
   */
  public static async readFile(filePath: string): Promise<string> {
    if (this.isNative()) {
      const result = await Filesystem.readFile({
        path: filePath,
        directory: Directory.External,
        encoding: Encoding.UTF8
      });
      return typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    } else {
      const res = await backendFetch(`/api/local/content?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error('Error al leer archivo en servidor de Linux');
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        return data.content || '';
      }
      return await res.text();
    }
  }

  /**
   * Escribe contenido a un archivo en el dispositivo
   */
  public static async writeFile(filePath: string, data: string): Promise<void> {
    if (this.isNative()) {
      await Filesystem.writeFile({
        path: filePath,
        data: data,
        directory: Directory.External,
        encoding: Encoding.UTF8
      });
      console.log(`[VFSBridge/Android] Guardado exitoso con Capacitor Filesystem: ${filePath}`);
    } else {
      const res = await backendFetch(`/api/local/content?path=${encodeURIComponent(filePath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: data })
      });
      if (!res.ok) throw new Error('Error al guardar en disco Linux');
    }
  }

  /**
   * Verifica si una carpeta es candidata para la suite 'Ordenadores' de Google Drive
   */
  public static getDefaultCloudCategory(localPath: string): 'computers' | 'shared' {
    const lowered = localPath.toLowerCase();
    if (lowered.includes('apuntes') || lowered.includes('compartid') || lowered.includes('shared')) {
      return 'shared';
    }
    return 'computers';
  }

  /**
   * Limpia archivos duplicados creados por StarNote (ej: Archivo(1).pdf, Archivo(2).pdf),
   * manteniendo la última versión exportada y renombrándola a su nombre base (Archivo.pdf).
   */
  public static async deduplicateFolder(dirPath: string): Promise<{ deleted: number; renamed: number }> {
    let deleted = 0;
    let renamed = 0;
    if (this.isNative()) {
      try {
        const cleanDir = dirPath.replace(/^\/storage\/emulated\/0\/?/, '') || '';
        const res = await Filesystem.readdir({ path: cleanDir, directory: Directory.ExternalStorage });
        const files = (res.files || []).filter(f => f.type === 'file' || (!f.type && f.name && f.name.includes('.')));
        if (files.length === 0) return { deleted: 0, renamed: 0 };

        const groups = new Map<string, Array<{ name: string; mtime: number; version: number }>>();
        for (const f of files) {
          let mtime = f.mtime || 0;
          if (!mtime) {
            try {
              const st = await Filesystem.stat({ path: (cleanDir ? cleanDir + '/' : '') + f.name, directory: Directory.ExternalStorage });
              mtime = st.mtime;
            } catch { }
          }
          const match = f.name.match(/^(.+?)(?:\s*\(\s*(\d+)\s*\))+\.([a-zA-Z0-9]+)$/);
          if (match) {
            const baseName = `${match[1].trim()}.${match[3]}`;
            const ver = parseInt(match[2], 10);
            if (!groups.has(baseName)) groups.set(baseName, []);
            groups.get(baseName)!.push({ name: f.name, mtime, version: ver });
          } else {
            if (!groups.has(f.name)) groups.set(f.name, []);
            groups.get(f.name)!.push({ name: f.name, mtime, version: 0 });
          }
        }

        for (const [baseName, versions] of groups.entries()) {
          versions.sort((a, b) => {
            const diff = b.mtime - a.mtime;
            return Math.abs(diff) > 2000 ? diff : b.version - a.version;
          });
          const winner = versions[0];
          const losers = versions.slice(1);

          for (const loser of losers) {
            const target = (cleanDir ? cleanDir + '/' : '') + loser.name;
            await Filesystem.deleteFile({ path: target, directory: Directory.ExternalStorage }).catch(() => { });
            deleted++;
          }
          if (winner.name !== baseName) {
            const oldPath = (cleanDir ? cleanDir + '/' : '') + winner.name;
            const newPath = (cleanDir ? cleanDir + '/' : '') + baseName;
            await Filesystem.rename({ from: oldPath, to: newPath, directory: Directory.ExternalStorage }).catch(() => { });
            renamed++;
          }
        }
      } catch (e) {
        console.error('[VFSBridge/Android] Error en deduplicateFolder:', e);
      }
    } else {
      try {
        const res = await backendFetch(`/api/local/deduplicate?path=${encodeURIComponent(dirPath)}`, {
          method: 'POST'
        });
        if (!res.ok) return { deleted: 0, renamed: 0 };
        const data = await res.json();
        if (data.success) {
          deleted = data.deleted || 0;
          renamed = data.renamed || 0;
        }
      } catch (e) {
        console.error('[VFSBridge/Linux] Error en deduplicateFolder server:', e);
      }
    }
    return { deleted, renamed };
  }
}
