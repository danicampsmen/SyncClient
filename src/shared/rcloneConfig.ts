import fs from 'node:fs/promises';
import path from 'node:path';

export type RcloneOperation = 'bisync' | 'copy' | 'sync' | 'check';
export type RcloneResyncMode = 'newer' | 'path1' | 'path2';

export interface RclonePairConfig {
  pairId: string;
  localPath: string;
  remotePath: string;
  operation: RcloneOperation;
  configPath: string;
  lockDirectory: string;
  dryRun: boolean;
  confirmDestructive: boolean;
  resync?: boolean; // Forzar reconstrucción de base de datos .bisync
  resyncMode?: RcloneResyncMode; // 'newer' por defecto
}

export const DESTRUCTIVE_RCLONE_OPERATIONS: ReadonlySet<RcloneOperation> = new Set([
  'bisync',
  'sync',
]);

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty string without control characters`);
  }
}

export function validateRclonePairConfig(config: RclonePairConfig): void {
  requireNonEmpty(config.pairId, 'pairId');
  if (!/^[A-Za-z0-9._-]+$/.test(config.pairId)) {
    throw new Error('pairId contains unsupported characters');
  }
  requireNonEmpty(config.localPath, 'localPath');
  if (!path.isAbsolute(config.localPath)) {
    throw new Error('localPath must be absolute');
  }
  requireNonEmpty(config.remotePath, 'remotePath');
  if (!/^[A-Za-z0-9][A-Za-z0-9+_.-]*:[^\u0000\r\n]+$/.test(config.remotePath)) {
    throw new Error('remotePath must be an rclone remote path');
  }
  if (!DESTRUCTIVE_RCLONE_OPERATIONS.has(config.operation) && config.operation !== 'copy' && config.operation !== 'check') {
    throw new Error(`Unsupported rclone operation: ${String(config.operation)}`);
  }
  if (!path.isAbsolute(config.configPath)) {
    throw new Error('configPath must be absolute');
  }
  if (!path.isAbsolute(config.lockDirectory)) {
    throw new Error('lockDirectory must be absolute');
  }
  if (DESTRUCTIVE_RCLONE_OPERATIONS.has(config.operation) && !config.dryRun && !config.confirmDestructive) {
    throw new Error('Destructive rclone operations require --dry-run or explicit confirmation');
  }
}

/**
 * Lee las secciones de remotos configuradas en rclone.conf (ej: [GoogleDrive-Documentos_Ubuntu_Fayfer])
 */
export async function getRcloneRemoteSections(configPath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const matches = content.match(/^\[([^\]]+)\]/gm);
    if (!matches) return [];
    return matches.map(m => m.slice(1, -1).trim());
  } catch {
    return [];
  }
}

/**
 * Valida que rclone.conf pertenezca al usuario actual y sea privado
 */
export async function validateRcloneConfigPath(configPath: string): Promise<void> {
  if (!path.isAbsolute(configPath)) {
    throw new Error('configPath must be absolute');
  }

  const parent = path.dirname(configPath);
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory() || (parentStat.mode & 0o022) !== 0) {
    throw new Error('rclone config directory must be a private directory');
  }

  try {
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('rclone config must be a private regular file owned by the current user');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function validateRcloneLockDirectory(lockDirectory: string): Promise<void> {
  if (!path.isAbsolute(lockDirectory)) {
    throw new Error('lockDirectory must be absolute');
  }
  const stat = await fs.stat(lockDirectory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('rclone lock directory must be a private directory owned by the current user');
  }
}

export async function ensureRcloneLockDirectory(lockDirectory: string): Promise<void> {
  if (!path.isAbsolute(lockDirectory)) {
    throw new Error('lockDirectory must be absolute');
  }
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await validateRcloneLockDirectory(lockDirectory);
}
