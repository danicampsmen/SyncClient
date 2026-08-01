import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmedOffsetFromRange,
  downloadToAtomicFile,
  requestTransfer,
  RESUMABLE_UPLOAD_CHUNK_SIZE,
  uploadResumableFile,
  validateChunkSize,
  type PersistedUploadSession,
  type TransferHttpClient,
} from './transfer';

const temporaryDirectories: string[] = [];

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  const payload = body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, { status, headers });
}

function client(request: TransferHttpClient['request'], refreshAccessToken = vi.fn(async () => false)): TransferHttpClient {
  return { request, refreshAccessToken, getAccessToken: () => 'access-token' };
}

async function tempFile(size: number): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'syncclient-transfer-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'large.bin');
  await writeFile(filePath, Buffer.alloc(size, 7));
  return { directory, filePath };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('resumable transfer helpers', () => {
  it('requires 256 KiB chunk alignment and uses the configured multiple', () => {
    expect(RESUMABLE_UPLOAD_CHUNK_SIZE % (256 * 1024)).toBe(0);
    expect(validateChunkSize(256 * 1024)).toBe(256 * 1024);
    expect(() => validateChunkSize(256 * 1024 + 1)).toThrow('256 KiB');
    expect(confirmedOffsetFromRange(new Headers({ Range: 'bytes=0-262143' }))).toBe(262144);
  });

  it('bounds transient 429/5xx retries with the supplied backoff', async () => {
    const request = vi.fn<TransferHttpClient['request']>()
      .mockResolvedValueOnce(response({}, 429))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({ ok: true }));
    const delays: number[] = [];
    await expect(requestTransfer(
      client(request),
      'https://upload.test/session',
      () => ({ method: 'PUT' }),
      3,
      async milliseconds => { delays.push(milliseconds); },
    )).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThan(1500);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[1]).toBeLessThan(3000);
  });

  it('persists the resumable URI and confirmed offsets around each chunk', async () => {
    const { filePath } = await tempFile(600 * 1024);
    const persisted: PersistedUploadSession[] = [];
    const requests: RequestInit[] = [];
    const request = vi.fn<TransferHttpClient['request']>()
      .mockImplementation(async (_url, init) => {
        requests.push(init);
        const range = new Headers(init.headers).get('Content-Range');
        if (range?.startsWith('bytes 0-')) return response({}, 308, { Range: 'bytes=0-262143' });
        if (range?.startsWith('bytes 262144-')) return response({}, 308, { Range: 'bytes=0-524287' });
        return response({ id: 'drive-file', name: 'large.bin', mimeType: 'application/octet-stream', modifiedTime: new Date().toISOString() });
      });
    const result = await uploadResumableFile({
      filePath,
      fileSize: 600 * 1024,
      operationId: 'op-1',
      remoteId: null,
      session: null,
      createSession: async () => response(null, 200, { Location: 'https://upload.test/session-1' }),
      client: client(request),
      persistSession: session => persisted.push({ ...session }),
      deleteSession: vi.fn(),
      chunkSize: 256 * 1024,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ id: 'drive-file' });
    expect(persisted.map(session => session.confirmed_offset)).toEqual([0, 0, 262144, 262144, 524288, 524288, 614400]);
    expect(new Headers(requests[0].headers).get('Content-Range')).toBe('bytes 0-262143/614400');
    expect(new Headers(requests[1].headers).get('Content-Range')).toBe('bytes 262144-524287/614400');
    expect(new Headers(requests[2].headers).get('Content-Range')).toBe('bytes 524288-614399/614400');
  });

  it('queries the server range after an interrupted chunk before continuing', async () => {
    const { filePath } = await tempFile(512 * 1024);
    const requests: Array<{ init: RequestInit; url: string }> = [];
    let chunkRequests = 0;
    const request = vi.fn<TransferHttpClient['request']>().mockImplementation(async (url, init) => {
      requests.push({ init, url });
      const headers = new Headers(init.headers);
      if (headers.get('Content-Range') === 'bytes 0-262143/524288') {
        chunkRequests++;
        if (chunkRequests === 1) throw new Error('connection reset');
        return response({}, 308, { Range: 'bytes=0-262143' });
      }
      if (headers.get('Content-Range') === 'bytes */524288') return response({}, 308, { Range: 'bytes=0-262143' });
      return response({ id: 'drive-file' });
    });
    await uploadResumableFile({
      filePath,
      fileSize: 512 * 1024,
      operationId: 'op-2',
      remoteId: null,
      session: null,
      createSession: async () => response(null, 200, { Location: 'https://upload.test/session-2' }),
      client: client(request),
      persistSession: vi.fn(),
      deleteSession: vi.fn(),
      chunkSize: 256 * 1024,
      sleep: async () => undefined,
    });

    expect(requests.some(({ init }) => new Headers(init.headers).get('Content-Range') === 'bytes */524288')).toBe(true);
    expect(requests.filter(({ init }) => new Headers(init.headers).get('Content-Range')?.startsWith('bytes 262144-')).length).toBe(1);
  });

  it('discards a persisted session when the source fingerprint changes', async () => {
    const { filePath } = await tempFile(256 * 1024);
    const request = vi.fn<TransferHttpClient['request']>().mockResolvedValue(response({ id: 'drive-file' }));
    const deleteSession = vi.fn();
    await uploadResumableFile({
      filePath,
      fileSize: 256 * 1024,
      operationId: 'op-fingerprint',
      remoteId: null,
      session: {
        operation_id: 'op-fingerprint',
        remote_id: null,
        session_uri: 'https://upload.test/expired',
        file_size: 256 * 1024,
        confirmed_offset: 0,
        chunk_size: 256 * 1024,
        source_hash: 'stale',
        updated_at: Date.now(),
      },
      createSession: async () => response(null, 200, { Location: 'https://upload.test/new' }),
      client: client(request),
      persistSession: vi.fn(),
      deleteSession,
      chunkSize: 256 * 1024,
      sleep: async () => undefined,
    });
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refreshes once at the 401 boundary and retries with the new token', async () => {
    const { filePath } = await tempFile(256 * 1024);
    const refresh = vi.fn(async () => true);
    const request = vi.fn<TransferHttpClient['request']>()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ id: 'drive-file' }));
    await uploadResumableFile({
      filePath,
      fileSize: 256 * 1024,
      operationId: 'op-3',
      remoteId: null,
      session: null,
      createSession: async () => response(null, 200, { Location: 'https://upload.test/session-3' }),
      client: client(request, refresh),
      persistSession: vi.fn(),
      deleteSession: vi.fn(),
      chunkSize: 256 * 1024,
      sleep: async () => undefined,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('downloadToAtomicFile', () => {
  it('streams, verifies checksum, and atomically renames a unique temporary file', async () => {
    const { directory } = await tempFile(0);
    const destinationPath = path.join(directory, 'download.bin');
    const content = Buffer.from('download content');
    const md5 = createHash('md5').update(content).digest('hex');
    const marked: string[] = [];
    await downloadToAtomicFile({
      sourceUrl: 'https://drive.test/file',
      destinationPath,
      expectedMd5: md5,
      expectedSize: content.length,
      client: client(async () => response(content)),
      markSelfWritten: filePath => marked.push(filePath),
      sleep: async () => undefined,
    });

    expect(await readFile(destinationPath)).toEqual(content);
    expect(marked).toHaveLength(2);
    expect(marked[1]).toBe(destinationPath);
    expect(await readdir(directory)).toEqual(['download.bin', 'large.bin']);
  });

  it('rejects a checksum mismatch and leaves no partial destination or temp file', async () => {
    const { directory } = await tempFile(0);
    const destinationPath = path.join(directory, 'download.bin');
    await expect(downloadToAtomicFile({
      sourceUrl: 'https://drive.test/file',
      destinationPath,
      expectedMd5: '00000000000000000000000000000000',
      client: client(async () => response(Buffer.from('corrupt'))),
      markSelfWritten: vi.fn(),
      sleep: async () => undefined,
    })).rejects.toThrow('checksum mismatch');
    expect(await readdir(directory)).toEqual(['large.bin']);
  });
});
