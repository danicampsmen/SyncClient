import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const RESUMABLE_UPLOAD_THRESHOLD = 5 * 1024 * 1024;
export const RESUMABLE_UPLOAD_CHUNK_SIZE = 8 * 256 * 1024;
export const TRANSFER_MAX_ATTEMPTS = 3;

export interface TransferHttpClient {
  request(url: string, init: RequestInit & { duplex?: 'half' }): Promise<Response>;
  getAccessToken(): string | null;
  refreshAccessToken(): Promise<boolean>;
}

export interface PersistedUploadSession {
  operation_id: string;
  remote_id: string | null;
  session_uri: string;
  file_size: number;
  confirmed_offset: number;
  chunk_size: number;
  source_hash: string | null;
  updated_at: number;
}

export interface ResumableUploadOptions {
  filePath: string;
  fileSize: number;
  operationId: string;
  remoteId: string | null;
  session: PersistedUploadSession | null;
  createSession: () => Promise<Response>;
  client: TransferHttpClient;
  persistSession: (session: PersistedUploadSession) => void;
  deleteSession: () => void;
  chunkSize?: number;
  sourceHash?: string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DownloadOptions {
  sourceUrl: string;
  destinationPath: string;
  modifiedTime?: string;
  expectedMd5?: string;
  expectedSize?: number;
  client: TransferHttpClient;
  markSelfWritten: (filePath: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class TransferHttpError extends Error {
  constructor(readonly status: number, message = `Transfer request failed (${status})`) {
    super(message);
    this.name = 'TransferHttpError';
  }
}

const sleep = async (milliseconds: number): Promise<void> => {
  if (milliseconds > 0) await new Promise(resolve => setTimeout(resolve, milliseconds));
};

function retryDelay(attempt: number): number {
  const base = Math.min(32_000, 1_000 * (2 ** (attempt - 1)));
  return Math.min(32_000, base + Math.floor(Math.random() * Math.max(1, base / 2)));
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function transientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function withAuthorization(
  init: RequestInit & { duplex?: 'half' },
  accessToken: string | null,
): RequestInit & { duplex?: 'half' } {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  return { ...init, headers };
}

export async function requestTransfer(
  client: TransferHttpClient,
  url: string,
  initFactory: () => RequestInit & { duplex?: 'half' },
  maxAttempts = TRANSFER_MAX_ATTEMPTS,
  sleepFn: (milliseconds: number) => Promise<void> = sleep,
): Promise<Response> {
  let refreshed = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.request(url, withAuthorization(initFactory(), client.getAccessToken()));
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        if (await client.refreshAccessToken()) {
          attempt--;
          continue;
        }
        throw new Error('UNAUTHORIZED_EXPIRED_TOKEN');
      }
      if (!transientStatus(response.status) || attempt === maxAttempts) return response;
      await response.body?.cancel();
      await sleepFn(retryAfterMs(response.headers.get('retry-after')) ?? retryDelay(attempt));
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message === 'UNAUTHORIZED_EXPIRED_TOKEN') throw error;
      if (attempt === maxAttempts) throw error;
      await sleepFn(retryDelay(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Transfer request failed');
}

export function confirmedOffsetFromRange(headers: Headers): number | null {
  const range = headers.get('Range') ?? headers.get('range');
  const match = range?.match(/^bytes=0-(\d+)$/);
  return match ? Number(match[1]) + 1 : null;
}

export function validateChunkSize(chunkSize: number): number {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize % (256 * 1024) !== 0) {
    throw new Error('Resumable upload chunk size must be a positive multiple of 256 KiB');
  }
  return chunkSize;
}

function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function sessionFromResponse(
  response: Response,
  options: ResumableUploadOptions,
  chunkSize: number,
  sourceHash: string,
): PersistedUploadSession {
  const sessionUri = response.headers.get('Location');
  if (!sessionUri) throw new Error('Drive resumable upload response was missing Location');
  return {
    operation_id: options.operationId,
    remote_id: options.remoteId,
    session_uri: sessionUri,
    file_size: options.fileSize,
    confirmed_offset: 0,
    chunk_size: chunkSize,
    source_hash: sourceHash,
    updated_at: Date.now(),
  };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fsSync.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function queryUploadState(
  options: ResumableUploadOptions,
  session: PersistedUploadSession,
  sleepFn: (milliseconds: number) => Promise<void>,
): Promise<{ offset: number; completed?: Record<string, unknown> }> {
  const response = await requestTransfer(
    options.client,
    session.session_uri,
    () => ({
      method: 'PUT',
      headers: {
        'Content-Length': '0',
        'Content-Range': `bytes */${session.file_size}`,
      },
      body: undefined,
    }),
    TRANSFER_MAX_ATTEMPTS,
    sleepFn,
  );
  if (response.ok) {
    return { offset: session.file_size, completed: await responseJson(response) };
  }
  if (response.status === 308) {
    return { offset: confirmedOffsetFromRange(response.headers) ?? session.confirmed_offset };
  }
  throw new TransferHttpError(response.status);
}

async function cleanupTemporaryFile(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function uploadResumableFile(options: ResumableUploadOptions): Promise<Record<string, unknown>> {
  const chunkSize = validateChunkSize(options.chunkSize ?? RESUMABLE_UPLOAD_CHUNK_SIZE);
  const sleepFn = options.sleep ?? sleep;
  const sourceHash = options.sourceHash ?? await hashFile(options.filePath);
  let session = options.session;
  if (session && (
    session.file_size !== options.fileSize
    || session.chunk_size !== chunkSize
    || session.remote_id !== options.remoteId
    || session.source_hash !== sourceHash
  )) {
    options.deleteSession();
    session = null;
  }

  const createSession = async (): Promise<void> => {
    const initResponse = await options.createSession();
    session = sessionFromResponse(initResponse, options, chunkSize, sourceHash);
    options.persistSession(session);
  };

  if (session) {
    try {
      const state = await queryUploadState(options, session, sleepFn);
      session = { ...session, confirmed_offset: state.offset, updated_at: Date.now() };
      options.persistSession(session);
      if (state.completed) {
        options.deleteSession();
        return state.completed;
      }
    } catch (error) {
      if (error instanceof TransferHttpError && (error.status === 404 || error.status === 410)) {
        options.deleteSession();
        session = null;
      } else {
        throw error;
      }
    }
  }
  if (!session) await createSession();

  const file = await fs.open(options.filePath, 'r');
  try {
    while (session.confirmed_offset < options.fileSize) {
      const offset = session.confirmed_offset;
      const length = Math.min(chunkSize, options.fileSize - offset);
      const chunk = Buffer.allocUnsafe(length);
      const read = await file.read(chunk, 0, length, offset);
      if (read.bytesRead !== length) throw new Error(`Local file changed while uploading at offset ${offset}`);
      let chunkAttempt = 0;
      let advanced = false;

      while (!advanced) {
        chunkAttempt++;
        session = { ...session, confirmed_offset: offset, updated_at: Date.now() };
        options.persistSession(session);
        let response: Response;
        try {
          response = await requestTransfer(
            options.client,
            session.session_uri,
            () => ({
              method: 'PUT',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(length),
                'Content-Range': `bytes ${offset}-${offset + length - 1}/${options.fileSize}`,
              },
              body: chunk,
              duplex: 'half',
            }),
            1,
            sleepFn,
          );
        } catch (error) {
          if (error instanceof TransferHttpError && !transientStatus(error.status)) throw error;
          if (chunkAttempt >= TRANSFER_MAX_ATTEMPTS) throw error;
          const state = await queryUploadState(options, session, sleepFn);
          session = { ...session, confirmed_offset: state.offset, updated_at: Date.now() };
          options.persistSession(session);
          if (state.completed) {
            options.deleteSession();
            return state.completed;
          }
          if (state.offset > offset) advanced = true;
          await sleepFn(retryDelay(chunkAttempt));
          continue;
        }
        if (response.ok) {
          session = { ...session, confirmed_offset: options.fileSize, updated_at: Date.now() };
          options.persistSession(session);
          options.deleteSession();
          return await responseJson(response);
        }
        if (response.status !== 308 && !transientStatus(response.status)) {
          throw new TransferHttpError(response.status);
        }
        const serverOffset = response.status === 308 ? confirmedOffsetFromRange(response.headers) : null;
        if (serverOffset !== null && serverOffset > offset) {
          session = { ...session, confirmed_offset: serverOffset, updated_at: Date.now() };
          options.persistSession(session);
          advanced = true;
        } else if (chunkAttempt >= TRANSFER_MAX_ATTEMPTS) {
          throw new Error(`Resumable upload did not advance after ${chunkAttempt} attempts`);
        } else {
          const state = await queryUploadState(options, session, sleepFn);
          session = { ...session, confirmed_offset: state.offset, updated_at: Date.now() };
          options.persistSession(session);
          if (state.completed) {
            options.deleteSession();
            return state.completed;
          }
          if (state.offset > offset) advanced = true;
          await sleepFn(retryDelay(chunkAttempt));
        }
      }
    }
  } finally {
    await file.close();
  }
  throw new Error('Resumable upload completed without a final response');
}

export async function downloadToAtomicFile(options: DownloadOptions): Promise<void> {
  await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
  let lastError: unknown;
  const sleepFn = options.sleep ?? sleep;
  for (let attempt = 1; attempt <= TRANSFER_MAX_ATTEMPTS; attempt++) {
    const temporaryPath = `${options.destinationPath}.syncclient-download-${Date.now()}-${randomUUID()}`;
    try {
      const response = await requestTransfer(
        options.client,
        options.sourceUrl,
        () => ({ headers: {} }),
        1,
        sleepFn,
      );
      if (!response.ok || !response.body) throw new TransferHttpError(response.status);
      const checksum = options.expectedMd5 ? createHash('md5') : null;
      const hasher = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (checksum) checksum.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as any), hasher, fsSync.createWriteStream(temporaryPath, { flags: 'wx' }));
      const stats = await fs.stat(temporaryPath);
      if (options.expectedSize !== undefined && stats.size !== options.expectedSize) {
        throw new Error(`Downloaded size mismatch: expected ${options.expectedSize}, got ${stats.size}`);
      }
      if (checksum && checksum.digest('hex') !== options.expectedMd5!.toLowerCase()) {
        throw new Error('Downloaded MD5 checksum mismatch');
      }
      options.markSelfWritten(temporaryPath);
      await fs.rename(temporaryPath, options.destinationPath);
      if (options.modifiedTime) {
        const mtime = new Date(options.modifiedTime);
        await fs.utimes(options.destinationPath, mtime, mtime);
      }
      options.markSelfWritten(options.destinationPath);
      return;
    } catch (error) {
      lastError = error;
      await cleanupTemporaryFile(temporaryPath);
      if (attempt < TRANSFER_MAX_ATTEMPTS) await sleepFn(retryDelay(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Drive download failed');
}
