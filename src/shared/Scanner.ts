/**
 * Scanner — Escaneo incremental con block hashing y Permission Gate.
 * SyncClient v2.
 */

import { FileState } from './schema';
import { IFileSystem } from '../utils/fileSystem';
import { Logger } from '../backend/logger';

const logger = new Logger('Scanner');

const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB

export interface LocalEntry {
    name: string;
    rawName: string; // The exact string returned by fs.readdir (preserves NFD/NFC)
    fullPath: string;
    mtime: number;
    size: number;
    isDirectory: boolean;
    hash?: string;
}

export interface ScanResult {
    changed: Map<string, LocalEntry>;
    created: Map<string, LocalEntry>;
    deleted: string[]; // relPaths que estaban en dbState pero ya no existen
}

/**
 * Calcular MD5 usando streams para que coincida exactamente con Google Drive.
 * Nunca carga el archivo completo en RAM.
 */
export async function computeBlockHashes(
    _filePath: string,
    _isCapacitor: boolean = false
): Promise<string[]> {
    if (_isCapacitor) {
        // Android: se implementa en F6 usando chunks de Capacitor Filesystem
        return [];
    }
    // Desktop: streaming con crypto
    try {
        const fs = await import('fs');
        const crypto = await import('crypto');

        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('md5');
            const stream = fs.createReadStream(_filePath, { highWaterMark: 2 * 1024 * 1024 }); // Chunks de 2MB
            stream.on('data', (chunk) => {
                hash.update(chunk);
            });
            stream.on('end', () => {
                // Devolvemos el array con 1 elemento por compatibilidad con la interfaz existente
                resolve([hash.digest('hex')]);
            });
            stream.on('error', reject);
        });
    } catch (error) {
        throw error;
    }
}

/** Comparar hashes por bloques: ¿cambió el contenido real? */
export function hasContentChanged(oldHashes: string[], newHashes: string[]): boolean {
    if (oldHashes.length !== newHashes.length) return true;
    return oldHashes.some((h, i) => h !== newHashes[i]);
}

/** Normalizar nombre de archivo a NFC (canónica compuesta) */
export function normalizeFilename(name: string): string {
    return name.normalize('NFC');
}

/** Normalizar para índice (case-insensitive). Usado para matching Drive. */
export function normalizeForIndex(name: string): string {
    return name.normalize('NFC').toLowerCase();
}

/** Detectar cambio de mtime con tolerancia DST (1h ±5min) */
export function isMtimeChanged(localMs: number, dbMs: number): boolean {
    const diff = Math.abs(localMs - dbMs);
    // Si la diferencia es exactamente ~1h, probablemente es DST
    const DST_TOLERANCE = 3600 * 1000; // 1 hora en ms
    if (Math.abs(diff - DST_TOLERANCE) < 300_000) {
        return false; // DST, no es cambio real
    }
    return diff > 3000; // tolerancia normal 3s
}

/**
 * Permission Gate: verifica acceso real de lectura/escritura al directorio.
 * Previene que readdir[] vacío por falta de permisos en Android
 * se confunda con "carpeta vacía" y borre todas las entradas de la DB.
 */
export async function verifyReadWriteAccess(dir: string, fs: IFileSystem): Promise<boolean> {
    const testFile = `${dir}/.syncclient_permcheck`;
    try {
        await fs.writeFile(testFile, Date.now().toString());
        await new Promise(r => setTimeout(r, 100));
        const readBack = await fs.readFile(testFile);
        await fs.rm(testFile).catch(error => {
            logger.debug(`[Scanner] Could not delete permission check file ${testFile}:`, error instanceof Error ? error.message : String(error));
        });
        return readBack !== null && readBack !== '';
    } catch {
        return false;
    }
}

/**
 * Escaneo incremental: solo devuelve archivos modificados vs DB.
 *
 * Fases:
 * 1. readdir + Permission Gate
 * 2. Quick check (mtime, size) vs dbState
 * 3. Lazy hashing para archivos con quick check fallido
 */
export async function scanChanges(
    dir: string,
    dbState: ReadonlyMap<string, FileState>,
    fs: IFileSystem,
    pairId: string
): Promise<ScanResult | 'PERMISSION_DENIED'> {
    // Recopilar entradas del filesystem de forma compatible con Node.js y Capacitor
    interface ScanEntry {
        name: string;
        isDirectory: boolean;
        size: number;
        mtime: number;
    }

    let entries: ScanEntry[] = [];

    try {
        const raw = await fs.readdir(dir);

        if (!Array.isArray(raw)) {
            entries = [];
        } else {
            for (const item of raw) {
                if (!item.name) continue;
                entries.push({
                    name: item.name,
                    isDirectory: item.isDirectory,
                    size: item.size || 0,
                    mtime: item.mtime || 0,
                });
            }
        }
    } catch {
        entries = [];
    }

    // Permission Gate: si no hay entradas pero la DB tenía archivos, verificar acceso real
    // Solo se considera PERMISSION_DENIED si el directorio no es accesible, no si simplemente está vacío.
    if (entries.length === 0 && dbState.size > 0) {
        const hasAccess = await verifyReadWriteAccess(dir, fs);
        if (!hasAccess) {
            logger.error(`[Scanner] PERMISSION_DENIED in ${dir}`);
            return 'PERMISSION_DENIED';
        }
    }

    const changed = new Map<string, LocalEntry>();
    const created = new Map<string, LocalEntry>();
    const currentPaths = new Set<string>();

    // Procesar entradas del filesystem
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const normName = normalizeFilename(entry.name);
        currentPaths.add(normName);

        const localEntry: LocalEntry = {
            name: normName,
            rawName: entry.name,
            fullPath: `${dir}/${entry.name}`,
            mtime: entry.mtime || 0,
            size: entry.size || 0,
            isDirectory: false
        };

        const dbEntry = dbState.get(normName);

        if (!dbEntry) {
            // Archivo nuevo — no estaba en la DB
            created.set(normName, localEntry);
            continue;
        }

        // Quick check: mtime y size
        const mtimeChanged = isMtimeChanged(localEntry.mtime, dbEntry.local_mtime || 0);
        const sizeChanged = dbEntry.file_size !== null && localEntry.size !== dbEntry.file_size;

        if (!mtimeChanged && !sizeChanged) {
            // Sin cambios aparentes — skip
            continue;
        }

        // Potencialmente modificado — marcar para block hashing (lazy)
        changed.set(normName, localEntry);
    }

    // Calcular hashes de bloques para archivos potencialmente modificados
    if (changed.size > 0) {
        const hashes = await lazyHashBatch(changed, 2, 5);
        for (const [relPath, hash] of hashes) {
            const entry = changed.get(relPath);
            if (entry) {
                entry.hash = hash.length > 0 ? hash[0] : undefined;
            }
        }
    }

    // Detectar archivos borrados (en DB pero no en filesystem)
    const deleted: string[] = [];
    for (const [relPath] of dbState) {
        if (!currentPaths.has(relPath)) {
            deleted.push(relPath);
        }
    }

    return { changed, created, deleted };
}

/**
 * Lazy hashing: calcular block hashes solo para archivos que pasaron el quick check.
 * Procesa en lotes de BATCH_SIZE con concurrencia limitada.
 * Progreso guardable vía callback.
 */
export async function lazyHashBatch(
    entries: Map<string, LocalEntry>,
    concurrency: number = 2,
    batchSize: number = 5,
    onProgress?: (done: number, total: number) => void
): Promise<Map<string, string[]>> {
    const results = new Map<string, string[]>();
    const entryArray = Array.from(entries.values());
    const total = entryArray.length;

    for (let i = 0; i < entryArray.length; i += batchSize) {
        const batch = entryArray.slice(i, i + batchSize);
        const batchResults = await runWithConcurrency(
            batch.map(entry => async () => {
                const hashes = await computeBlockHashes(entry.fullPath);
                return { name: entry.name, hashes };
            }),
            concurrency
        );

        for (const { name, hashes } of batchResults) {
            if (hashes.length > 0) results.set(name, hashes);
        }

        onProgress?.(Math.min(i + batchSize, total), total);
    }

    return results;
}

async function runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    const errors: unknown[] = [];
    let index = 0;

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (index < tasks.length) {
            const i = index++;
            try {
                results[i] = await tasks[i]();
            } catch (e: any) {
                errors.push(e);
                logger.error(`[Scanner/LazyHash] Error in worker:`, e?.message || e);
            }
        }
    });

    await Promise.all(workers);
    if (errors.length > 0) {
        const firstError = errors[0];
        throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
    return results.filter((value): value is T => value !== undefined);
}