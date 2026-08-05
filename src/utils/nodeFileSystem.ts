import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { IFileSystem, FileEntry } from './fileSystem';

export class NodeFileSystem implements IFileSystem {
  async mkdir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  async readFile(p: string, base64 = false): Promise<string> {
    const encoding = base64 ? undefined : 'utf8';
    return await fs.readFile(p, encoding);
  }

  async writeFile(p: string, data: string | Uint8Array, base64 = false): Promise<void> {
    if (base64) {
      await fs.writeFile(p, data, 'base64');
    } else if (data instanceof Uint8Array) {
      await fs.writeFile(p, Buffer.from(data));
    } else {
      await fs.writeFile(p, data, 'utf8');
    }
  }

  async appendFile(p: string, data: string | Uint8Array, base64 = false): Promise<void> {
    if (base64) {
      await fs.appendFile(p, data, 'base64');
    } else if (data instanceof Uint8Array) {
      await fs.appendFile(p, Buffer.from(data));
    } else {
      await fs.appendFile(p, data, 'utf8');
    }
  }

  async readFileChunk(p: string, offset: number, length: number): Promise<{ data: string; bytesRead: number }> {
    const fd = await fs.open(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fd.read(buf, 0, length, offset);
      return { data: buf.toString('base64', 0, bytesRead), bytesRead };
    } finally {
      await fd.close();
    }
  }

  async stat(p: string): Promise<FileEntry | null> {
    try {
      const s = await fs.stat(p);
      return {
        name: path.basename(p),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtime: s.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  async readdir(p: string): Promise<FileEntry[]> {
    try {
      const dirents = await fs.readdir(p, { withFileTypes: true });
      const results = await Promise.all(dirents.map(async d => {
        try {
          const st = await fs.stat(path.join(p, d.name));
          return {
            name: d.name,
            isDirectory: d.isDirectory(),
            size: st.size,
            mtime: st.mtimeMs,
          };
        } catch {
          return null;
        }
      }));
      return results.filter(r => r !== null) as FileEntry[];
    } catch {
      return [];
    }
  }

  async rm(p: string): Promise<void> {
    await fs.rm(p, { force: true, recursive: true });
  }

  async rename(oldP: string, newP: string): Promise<void> {
    await fs.rename(oldP, newP);
  }

  async utimes(p: string, mtime: number): Promise<void> {
    await fs.utimes(p, mtime, mtime);
  }

  join(...parts: string[]): string {
    return path.join(...parts);
  }

  basename(p: string): string {
    return path.basename(p);
  }

  dirname(p: string): string {
    return path.dirname(p);
  }

  getHomeDir(): string {
    return os.homedir();
  }

  getTempDir(): string {
    return os.tmpdir();
  }
}
