import fs from 'node:fs/promises';
import path from 'node:path';
import { Logger } from './logger';

const DEFAULT_MAX_BACKUP_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5GB

export interface BackupEntry {
  path: string;
  relativePath: string;
  size: number;
  mtime: number;
  pairId?: string;
}

export class RecycleBinManager {
  private logger: Logger;
  private maxSizeBytes: number;

  constructor(logger: Logger, maxSizeBytes = DEFAULT_MAX_BACKUP_SIZE_BYTES) {
    this.logger = logger;
    this.maxSizeBytes = maxSizeBytes;
  }

  async scanPair(pairLocalPath: string, pairId?: string): Promise<BackupEntry[]> {
    const backupRoot = path.join(pairLocalPath, '.syncclient-backups');
    try {
      await fs.access(backupRoot);
    } catch {
      return [];
    }

    const entries: BackupEntry[] = [];
    const walk = async (dir: string, relPrefix = '') => {
      let entries_: any[];
      try {
        entries_ = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries_) {
        const fullPath = path.join(dir, entry.name);
        const relPath = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
        } else {
          try {
            const stat = await fs.stat(fullPath);
            entries.push({
              path: fullPath,
              relativePath: relPath,
              size: stat.size,
              mtime: stat.mtimeMs,
              pairId,
            });
          } catch {
            // ignore
          }
        }
      }
    };

    await walk(backupRoot);
    return entries;
  }

  async getTotalSize(entries: BackupEntry[]): Promise<number> {
    return entries.reduce((sum, e) => sum + e.size, 0);
  }

  async rotate(entries: BackupEntry[]): Promise<BackupEntry[]> {
    const totalSize = await this.getTotalSize(entries);
    if (totalSize <= this.maxSizeBytes) {
      return entries;
    }

    const sorted = [...entries].sort((a, b) => a.mtime - b.mtime);
    let currentSize = totalSize;
    const toDelete: BackupEntry[] = [];

    for (const entry of sorted) {
      if (currentSize <= this.maxSizeBytes * 0.8) break;
      toDelete.push(entry);
      currentSize -= entry.size;
    }

    for (const entry of toDelete) {
      try {
        await fs.unlink(entry.path);
        this.logger.info(`[RecycleBin] Rotado backup antiguo: ${entry.relativePath}`);
      } catch (e) {
        this.logger.warn(`[RecycleBin] No se pudo eliminar backup ${entry.relativePath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return entries.filter(e => !toDelete.includes(e));
  }

  async restore(entry: BackupEntry, targetPath: string): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(entry.path, targetPath);
    this.logger.info(`[RecycleBin] Restaurado: ${entry.relativePath} -> ${targetPath}`);
  }

  async delete(entry: BackupEntry): Promise<void> {
    await fs.unlink(entry.path);
    this.logger.info(`[RecycleBin] Eliminado permanentemente: ${entry.relativePath}`);
  }

  async empty(pairLocalPath: string): Promise<number> {
    const backupRoot = path.join(pairLocalPath, '.syncclient-backups');
    let count = 0;
    const walk = async (dir: string) => {
      let entries_: any[];
      try {
        entries_ = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries_) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          try {
            await fs.rmdir(fullPath);
          } catch {
            // ignore
          }
        } else {
          try {
            await fs.unlink(fullPath);
            count++;
          } catch {
            // ignore
          }
        }
      }
    };

    await walk(backupRoot);
    try {
      await fs.rmdir(backupRoot);
    } catch {
      // ignore
    }

    this.logger.info(`[RecycleBin] Vaciado: ${count} archivos eliminados de ${pairLocalPath}`);
    return count;
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
