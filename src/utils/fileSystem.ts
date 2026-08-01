import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

export interface IFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string, base64?: boolean): Promise<string>;
  writeFile(path: string, data: string | Uint8Array, base64?: boolean): Promise<void>;
  appendFile(path: string, data: string | Uint8Array, base64?: boolean): Promise<void>;
  readFileChunk?(path: string, offset: number, length: number): Promise<{ data: string; bytesRead: number }>;
  stat(path: string): Promise<FileEntry | null>;
  readdir(path: string): Promise<FileEntry[]>;
  rm(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  utimes(path: string, mtime: number): Promise<void>;
  join(...parts: string[]): string;
  basename(path: string): string;
  dirname(path: string): string;
  getHomeDir(): string;
  getTempDir(): string;
}

// Prefijo especial para indicar rutas que van al almacenamiento interno de la app
const INTERNAL_PREFIX = '__INTERNAL__/';

/**
 * Implementación para Android/iOS usando Capacitor Filesystem.
 * - Archivos de configuración (sync_data.json): Directory.Data (privado de la app, no necesita permisos)
 * - Archivos de usuario (Documents, StarNote, etc.): Directory.ExternalStorage
 */
export class CapacitorFS implements IFileSystem {

  private isInternal(path: string): boolean {
    return path.startsWith(INTERNAL_PREFIX) || path.startsWith('/.config/') || path.startsWith('.config/');
  }

  private toInternalPath(path: string): string {
    return path
      .replace(INTERNAL_PREFIX, '')
      .replace(/^\//, '')
      .replace(/\/+/g, '/') || 'syncclient';
  }

  private toExternalPath(p: string): string {
    // Paths para ExternalStorage deben ser relativas a /storage/emulated/0/
    return p.replace(/^\/storage\/emulated\/0\/?/, '').replace(/^\//, '') || '';
  }

  async mkdir(path: string): Promise<void> {
    if (this.isInternal(path)) {
      await Filesystem.mkdir({
        path: this.toInternalPath(path),
        directory: Directory.Data,
        recursive: true
      }).catch(() => {});
    } else {
      await Filesystem.mkdir({
        path: this.toExternalPath(path),
        directory: Directory.ExternalStorage,
        recursive: true
      }).catch(() => {});
    }
  }

  async readFile(path: string, base64 = false): Promise<string> {
    if (this.isInternal(path)) {
      const result = await Filesystem.readFile({
        path: this.toInternalPath(path),
        directory: Directory.Data,
        encoding: base64 ? undefined : Encoding.UTF8
      });
      return result.data as string;
    } else {
      const result = await Filesystem.readFile({
        path: this.toExternalPath(path),
        directory: Directory.ExternalStorage,
        encoding: base64 ? undefined : Encoding.UTF8
      });
      return result.data as string;
    }
  }

  async writeFile(path: string, data: string | Uint8Array, base64 = false): Promise<void> {
    let content: string;
    if (data instanceof Uint8Array) {
      content = btoa(String.fromCharCode.apply(null, Array.from(data)));
    } else {
      content = data;
    }

    if (this.isInternal(path)) {
      await Filesystem.writeFile({
        path: this.toInternalPath(path),
        data: content,
        directory: Directory.Data,
        encoding: base64 || data instanceof Uint8Array ? undefined : Encoding.UTF8,
        recursive: true
      });
    } else {
      await Filesystem.writeFile({
        path: this.toExternalPath(path),
        data: content,
        directory: Directory.ExternalStorage,
        encoding: base64 || data instanceof Uint8Array ? undefined : Encoding.UTF8,
        recursive: true
      });
    }
  }

  async appendFile(path: string, data: string | Uint8Array, base64 = false): Promise<void> {
    const content = data instanceof Uint8Array
      ? btoa(Array.from(data, byte => String.fromCharCode(byte)).join(''))
      : data;
    const options: any = {
      path: this.isInternal(path) ? this.toInternalPath(path) : this.toExternalPath(path),
      data: content,
      directory: this.isInternal(path) ? Directory.Data : Directory.ExternalStorage,
      encoding: base64 || data instanceof Uint8Array ? undefined : Encoding.UTF8
    };
    await Filesystem.appendFile(options);
  }

  async readFileChunk(path: string, offset: number, length: number): Promise<{ data: string; bytesRead: number }> {
    const { StreamedFilesystem } = await import('./streamedFilesystem');
    return StreamedFilesystem.readChunk({ path, offset, length });
  }

  async stat(path: string): Promise<FileEntry | null> {
    try {
      if (this.isInternal(path)) {
        const result = await Filesystem.stat({
          path: this.toInternalPath(path),
          directory: Directory.Data
        });
        return {
          name: this.basename(path),
          isDirectory: result.type === 'directory',
          size: result.size,
          mtime: result.mtime
        };
      } else {
        const result = await Filesystem.stat({
          path: this.toExternalPath(path),
          directory: Directory.ExternalStorage
        });
        return {
          name: this.basename(path),
          isDirectory: result.type === 'directory',
          size: result.size,
          mtime: result.mtime
        };
      }
    } catch {
      return null;
    }
  }

  async readdir(path: string): Promise<FileEntry[]> {
    try {
      if (this.isInternal(path)) {
        const result = await Filesystem.readdir({
          path: this.toInternalPath(path),
          directory: Directory.Data
        });
        return result.files.map(f => ({
          name: f.name,
          isDirectory: f.type === 'directory',
          size: f.size,
          mtime: f.mtime
        }));
      } else {
        const result = await Filesystem.readdir({
          path: this.toExternalPath(path),
          directory: Directory.ExternalStorage
        });
        return result.files.map(f => ({
          name: f.name,
          isDirectory: f.type === 'directory',
          size: f.size,
          mtime: f.mtime
        }));
      }
    } catch {
      return [];
    }
  }

  async rm(path: string): Promise<void> {
    const s = await this.stat(path);
    if (!s) return;
    if (this.isInternal(path)) {
      if (s.isDirectory) {
        await Filesystem.rmdir({ path: this.toInternalPath(path), directory: Directory.Data, recursive: true });
      } else {
        await Filesystem.deleteFile({ path: this.toInternalPath(path), directory: Directory.Data });
      }
    } else {
      if (s.isDirectory) {
        await Filesystem.rmdir({ path: this.toExternalPath(path), directory: Directory.ExternalStorage, recursive: true });
      } else {
        await Filesystem.deleteFile({ path: this.toExternalPath(path), directory: Directory.ExternalStorage });
      }
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    try {
      if (this.isInternal(oldPath)) {
        await Filesystem.rename({
          from: this.toInternalPath(oldPath),
          to: this.toInternalPath(newPath),
          directory: Directory.Data
        });
      } else {
        await Filesystem.rename({
          from: this.toExternalPath(oldPath),
          to: this.toExternalPath(newPath),
          directory: Directory.ExternalStorage
        });
      }
    } catch (err) {
      console.error(`[CapacitorFS] Error renombrando ${oldPath} -> ${newPath}:`, err);
      throw err;
    }
  }

  async utimes(_path: string, _mtime: number): Promise<void> {
    // Capacitor Filesystem no soporta cambiar mtime directamente.
  }

  join(...parts: string[]): string {
    // Preservar prefijo interno si está presente
    const hasInternal = parts[0]?.startsWith(INTERNAL_PREFIX) || parts[0] === INTERNAL_PREFIX;
    const cleaned = parts
      .map((p, i) => i === 0 ? p.replace(INTERNAL_PREFIX, '') : p)
      .filter(p => p !== '')
      .join('/')
      .replace(/\/+/g, '/');
    return hasInternal ? INTERNAL_PREFIX + cleaned.replace(/^\//, '') : cleaned;
  }

  basename(path: string): string {
    return path.replace(INTERNAL_PREFIX, '').split('/').pop() || '';
  }

  dirname(path: string): string {
    const clean = path.replace(INTERNAL_PREFIX, '');
    const parts = clean.split('/');
    parts.pop();
    const result = parts.join('/') || '.';
    return path.startsWith(INTERNAL_PREFIX) ? INTERNAL_PREFIX + result : result;
  }

  getHomeDir(): string {
    // Retorna el prefijo especial para que configDir se enrute a Directory.Data
    return INTERNAL_PREFIX;
  }

  getTempDir(): string {
    return INTERNAL_PREFIX + 'cache';
  }
}
