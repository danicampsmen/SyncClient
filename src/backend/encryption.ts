import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
export const KEY_LENGTH = 32;
export const IV_LENGTH = 12;
export const SALT_LENGTH = 16;
export const TAG_LENGTH = 16;
export const AAD = Buffer.from('syncclient-enc-v1');
export const PBKDF2_ITERATIONS = 100_000;

export interface EncryptedPayload {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

export function encryptFile(inputPath: string, outputPath: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(password, salt);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    cipher.setAAD(AAD);

    const input = fsSync.createReadStream(inputPath);
    const output = fsSync.createWriteStream(outputPath);

    output.write(salt);
    output.write(iv);

    let error: Error | null = null;

    cipher.on('finish', () => {
      const tag = cipher.getAuthTag();
      if (tag) output.write(tag);
      output.end(() => !error && resolve());
    });
    cipher.on('error', (e) => {
      error = e;
      output.destroy();
      reject(e);
    });

    input.on('error', reject);
    output.on('error', reject);

    input.pipe(cipher);
  });
}

export function decryptFile(inputPath: string, outputPath: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = fsSync.openSync(inputPath, 'r');
    const headerLength = SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
    const header = Buffer.alloc(headerLength);

    let read = 0;
    while (read < headerLength) {
      const result = fsSync.readSync(fd, header, read, headerLength - read, read);
      if (result === 0) {
        fsSync.closeSync(fd);
        return reject(new EncryptionError('Unexpected end of file while reading header'));
      }
      read += result;
    }
    fsSync.closeSync(fd);

    const salt = header.subarray(0, SALT_LENGTH);
    const iv = header.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = header.subarray(SALT_LENGTH + IV_LENGTH);
    const key = deriveKey(password, salt);

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);

    const input = fsSync.createReadStream(inputPath, { start: headerLength });
    const output = fsSync.createWriteStream(outputPath);

    let error: Error | null = null;

    decipher.on('finish', () => {
      output.end(() => !error && resolve());
    });
    decipher.on('error', (e) => {
      error = e;
      output.destroy();
      reject(e);
    });

    input.on('error', reject);
    output.on('error', reject);

    input.pipe(decipher);
  });
}

export function encryptedSize(originalSize: number): number {
  return originalSize + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
}

export function isEncryptedFile(filePath: string): boolean {
  try {
    const fd = fsSync.openSync(filePath, 'r');
    const header = Buffer.alloc(SALT_LENGTH + IV_LENGTH);
    fsSync.readSync(fd, header, 0, header.length, 0);
    fsSync.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
