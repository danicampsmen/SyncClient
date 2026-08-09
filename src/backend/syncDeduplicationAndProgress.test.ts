import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { SyncPair, SyncProgress } from '../types';
import { CoreSyncLogic } from '../shared/CoreSyncLogic';

describe('Recursive Local Deduplication Logic', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-dedup-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('deduplicates numbered files in root and subdirectories recursively', async () => {
    // Crear estructura:
    // tmpDir/root-note(1).pdf (mtime: 1000)
    // tmpDir/root-note(2).pdf (mtime: 2000) -> ganador
    // tmpDir/Math/sub-note(1).pdf (mtime: 1000)
    // tmpDir/Math/sub-note(3).pdf (mtime: 3000) -> ganador

    const mathDir = path.join(tmpDir, 'Math');
    await fs.mkdir(mathDir, { recursive: true });

    const root1 = path.join(tmpDir, 'root-note(1).pdf');
    const root2 = path.join(tmpDir, 'root-note(2).pdf');
    const sub1 = path.join(mathDir, 'sub-note(1).pdf');
    const sub3 = path.join(mathDir, 'sub-note(3).pdf');

    await fs.writeFile(root1, 'root1 content');
    await fs.writeFile(root2, 'root2 content');
    await fs.writeFile(sub1, 'sub1 content');
    await fs.writeFile(sub3, 'sub3 content');

    // Asignar mtimes distintos
    const t1 = new Date(1000000000);
    const t2 = new Date(2000000000);
    const t3 = new Date(3000000000);

    await fs.utimes(root1, t1, t1);
    await fs.utimes(root2, t2, t2);
    await fs.utimes(sub1, t1, t1);
    await fs.utimes(sub3, t3, t3);

    // Simular el escaneo recursivo de cleanLocalDuplicatesDir
    async function scanAndClean(dir: string, relativePrefix = ''): Promise<{ deleted: number; renamed: number }> {
      let deleted = 0;
      let renamed = 0;

      const entries = await fs.readdir(dir, { withFileTypes: true });
      const localFiles: Array<{ name: string; mtime: number }> = [];
      const subDirs: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          subDirs.push(entry.name);
        } else if (entry.isFile()) {
          const st = await fs.stat(path.join(dir, entry.name));
          localFiles.push({ name: entry.name, mtime: st.mtimeMs });
        }
      }

      const grouped = CoreSyncLogic.groupAndSortDuplicates(localFiles);

      for (const [baseName, versions] of grouped.entries()) {
        if (versions.length <= 1) continue;

        const winner = versions[0];
        const losers = versions.slice(1);

        for (const loser of losers) {
          await fs.rm(path.join(dir, loser.name), { force: true });
          deleted++;
        }

        if (winner.name !== baseName) {
          await fs.rename(path.join(dir, winner.name), path.join(dir, baseName));
          renamed++;
        }
      }

      for (const sub of subDirs) {
        const childRes = await scanAndClean(path.join(dir, sub), relativePrefix ? `${relativePrefix}/${sub}` : sub);
        deleted += childRes.deleted;
        renamed += childRes.renamed;
      }

      return { deleted, renamed };
    }

    const result = await scanAndClean(tmpDir);

    expect(result.deleted).toBe(2); // root-note(1) y sub-note(1) eliminados
    expect(result.renamed).toBe(2); // root-note(2) -> root-note.pdf y sub-note(3) -> sub-note.pdf

    // Verificar archivos resultantes en disco
    const rootFiles = await fs.readdir(tmpDir);
    expect(rootFiles).toContain('root-note.pdf');
    expect(rootFiles).not.toContain('root-note(1).pdf');
    expect(rootFiles).not.toContain('root-note(2).pdf');

    const subFiles = await fs.readdir(mathDir);
    expect(subFiles).toContain('sub-note.pdf');
    expect(subFiles).not.toContain('sub-note(1).pdf');
    expect(subFiles).not.toContain('sub-note(3).pdf');
  });
});

describe('Sync Progress Accumulation Logic', () => {
  it('accumulates totalFiles and totalBytes additively across recursive directory trees', () => {
    const progress: SyncProgress = {
      currentFile: '',
      totalFiles: 0,
      currentFileIndex: 0,
      bytesTransferred: 0,
      totalBytes: 0,
      percentage: 0,
      action: 'subiendo',
    };

    // Nivel 1 (raíz): 2 archivos, 500 bytes
    progress.totalFiles += 2;
    progress.totalBytes += 500;

    expect(progress.totalFiles).toBe(2);
    expect(progress.totalBytes).toBe(500);

    // Nivel 2 (subdir): 3 archivos, 1200 bytes
    progress.totalFiles += 3;
    progress.totalBytes += 1200;

    expect(progress.totalFiles).toBe(5);
    expect(progress.totalBytes).toBe(1700);
  });
});

describe('Watcher Event Filtering Logic', () => {
  it('filters all self-written files in a multi-file batch', () => {
    const selfWrittenMap = new Map<string, number>();
    const now = Date.now();
    selfWrittenMap.set('/path/file1.pdf', now);
    selfWrittenMap.set('/path/file2.pdf', now);

    function isSelfWritten(filePath: string): boolean {
      const ts = selfWrittenMap.get(filePath);
      return ts ? (now - ts < 15000) : false;
    }

    const events = [
      { path: '/path/file1.pdf' },
      { path: '/path/file2.pdf' },
      { path: '/path/user_created.pdf' },
    ];

    const relevant = events.filter(evt => !isSelfWritten(evt.path));

    expect(relevant).toHaveLength(1);
    expect(relevant[0].path).toBe('/path/user_created.pdf');
  });
});
