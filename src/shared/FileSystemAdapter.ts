/**
 * FileSystemAdapter — Abstracción unificada de acceso al sistema de archivos para SyncClient.
 * Proporciona contratos homogéneos para Node.js (Ubuntu Desktop) y Capacitor (Android).
 */

export interface FileStat {
  name: string;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
}

export interface IFileSystemAdapter {
  stat(filePath: string): Promise<FileStat | null>;
  readdir(dirPath: string): Promise<string[]>;
  mkdir(dirPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  rmdir(dirPath: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
}

import * as fs from 'fs/promises';
import * as path from 'path';

export class NodeFileSystemAdapter implements IFileSystemAdapter {
  async stat(filePath: string): Promise<FileStat | null> {
    try {
      const st = await fs.stat(filePath);
      return {
        name: path.basename(filePath),
        size: st.size,
        mtimeMs: st.mtimeMs,
        isDirectory: st.isDirectory(),
        isFile: st.isFile(),
      };
    } catch {
      return null;
    }
  }

  async readdir(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch {
      return [];
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async unlink(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  async rmdir(dirPath: string): Promise<void> {
    await fs.rm(dirPath, { recursive: true, force: true });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
