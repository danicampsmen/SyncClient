/**
 * ExifDateExtractor - Extracción de fecha EXIF para archivos multimedia.
 * Inspirado en FolderSync (`DefaultExifDateExtractor`).
 */

import fs from 'fs/promises';
import { FileState } from './schema';

export interface ExifDateResult {
  date: Date | null;
  source: 'exif' | 'mtime' | 'none';
}

export class ExifDateExtractor {
  public async extract(filePath: string, fallbackMtime?: number | null): Promise<ExifDateResult> {
    try {
      const buffer = await fs.readFile(filePath);
      const date = this.parseExifDate(buffer);
      if (date) {
        return { date, source: 'exif' };
      }
    } catch {
      // ignore read errors
    }

    if (typeof fallbackMtime === 'number' && Number.isFinite(fallbackMtime) && fallbackMtime > 0) {
      return { date: new Date(fallbackMtime), source: 'mtime' };
    }

    return { date: null, source: 'none' };
  }

  private parseExifDate(buffer: Buffer): Date | null {
    try {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      if (view.getUint16(0, false) !== 0xFFD8) return null;

      let offset = 2;
      while (offset < buffer.byteLength - 4) {
        const marker = view.getUint16(offset, false);
        if (marker === 0xFFE1) {
          const exifStart = offset + 4;
          if (exifStart + 6 < buffer.byteLength &&
              buffer[exifStart] === 0x45 &&
              buffer[exifStart + 1] === 0x78 &&
              buffer[exifStart + 2] === 0x69 &&
              buffer[exifStart + 3] === 0x66) {
            const tiffStart = exifStart + 6;
            if (tiffStart + 8 < buffer.byteLength) {
              const dateStr = this.readExifDateTime(buffer, tiffStart);
              if (dateStr) {
                const parsed = new Date(dateStr.replace(/(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
                if (!Number.isNaN(parsed.getTime())) {
                  return parsed;
                }
              }
            }
          }
          break;
        }
        if ((marker & 0xFF00) !== 0xFF00) break;
        offset += 2 + view.getUint16(offset + 2, false);
      }
    } catch {
      // ignore parse errors
    }
    return null;
  }

  private readExifDateTime(buffer: Buffer, tiffStart: number): string | null {
    try {
      const littleEndian = buffer[tiffStart] === 0x49;
      const ifdOffset = this.readUint32(buffer, tiffStart + 4, littleEndian);
      const entriesStart = tiffStart + ifdOffset;
      if (entriesStart + 2 > buffer.byteLength) return null;
      const entriesCount = this.readUint16(buffer, entriesStart, littleEndian);
      const dateTimeTag = 0x0132;
      const dateTimeOriginalTag = 0x9003;

      for (let i = 0; i < entriesCount; i++) {
        const entryOffset = entriesStart + 2 + i * 12;
        if (entryOffset + 12 > buffer.byteLength) break;
        const tag = this.readUint16(buffer, entryOffset, littleEndian);
        const type = this.readUint16(buffer, entryOffset + 2, littleEndian);
        const count = this.readUint32(buffer, entryOffset + 4, littleEndian);
        const valueOffset = type === 2
          ? this.readUint32(buffer, entryOffset + 8, littleEndian)
          : entryOffset + 8;

        if ((tag === dateTimeTag || tag === dateTimeOriginalTag) && type === 2 && count > 0) {
          const str = buffer.toString('ascii', tiffStart + valueOffset, tiffStart + valueOffset + count - 1);
          return str.trim() || null;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private readUint16(buffer: Buffer, offset: number, littleEndian: boolean): number {
    return buffer.readUInt16LE(offset) || buffer.readUInt16BE(offset);
  }

  private readUint32(buffer: Buffer, offset: number, littleEndian: boolean): number {
    return buffer.readUInt32LE(offset) || buffer.readUInt32BE(offset);
  }
}
