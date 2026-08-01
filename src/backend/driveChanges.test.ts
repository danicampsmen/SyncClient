import { describe, expect, it, vi } from 'vitest';
import type { DriveCursor } from '../shared/schema';
import { DriveChangesIngestor, DriveCursorRescanRequiredError } from './driveChanges';

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function storage(initial?: DriveCursor) {
  let cursor = initial ?? null;
  return {
    getDriveCursor: vi.fn(() => cursor),
    setDriveCursor: vi.fn((next: DriveCursor) => { cursor = next; }),
  };
}

describe('DriveChangesIngestor', () => {
  it('paginates and commits only the final token after all changes', async () => {
    const db = storage();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ startPageToken: 'start' }))
      .mockResolvedValueOnce(response({ changes: [{ fileId: 'a' }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(response({ changes: [{ fileId: 'b' }], newStartPageToken: 'final' }));
    const applied: string[] = [];
    const result = await new DriveChangesIngestor(db as never, fetcher, 'secret').ingest(
      { pairId: 'p', accountId: 'a', corpusId: 'user' },
      change => { applied.push(change.fileId); },
    );
    expect(applied).toEqual(['a', 'b']);
    expect(result.pageCount).toBe(2);
    expect(db.setDriveCursor).toHaveBeenCalledWith(expect.objectContaining({ page_token: 'final' }));
  });

  it('does not advance the cursor when applying a change fails', async () => {
    const db = storage({ pair_id: 'p', account_id: 'a', corpus_id: 'user', drive_id: 'my-drive', page_token: 'old', last_success_at: null, status: 'active' });
    const fetcher = vi.fn().mockResolvedValue(response({ changes: [{ fileId: 'a' }], newStartPageToken: 'new' }));
    await expect(new DriveChangesIngestor(db as never, fetcher, 'secret').ingest(
      { pairId: 'p', accountId: 'a', corpusId: 'user' }, () => { throw new Error('apply failed'); },
    )).rejects.toThrow('apply failed');
    expect(db.setDriveCursor).not.toHaveBeenCalled();
  });

  it('signals a controlled rescan for invalid or expired cursors', async () => {
    const db = storage({ pair_id: 'p', account_id: 'a', corpus_id: 'user', drive_id: 'my-drive', page_token: 'expired', last_success_at: null, status: 'active' });
    const fetcher = vi.fn().mockResolvedValue(response({ error: { reason: 'invalidPageToken' } }, 400));
    await expect(new DriveChangesIngestor(db as never, fetcher, 'secret').ingest(
      { pairId: 'p', accountId: 'a', corpusId: 'user' }, vi.fn(),
    )).rejects.toBeInstanceOf(DriveCursorRescanRequiredError);
    expect(db.setDriveCursor).not.toHaveBeenCalled();
  });

  it('retries transient errors and honors Retry-After', async () => {
    const db = storage();
    const delays: number[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({}, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(response({ startPageToken: 'start' }))
      .mockResolvedValueOnce(response({ newStartPageToken: 'final', changes: [] }));
    await new DriveChangesIngestor(db as never, fetcher, 'secret', async ms => { delays.push(ms); }).ingest(
      { pairId: 'p', accountId: 'a', corpusId: 'user' }, vi.fn(),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(delays).toContain(2000);
  });

  it('adds shared-drive query parameters', async () => {
    const db = storage();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ startPageToken: 'start' }))
      .mockResolvedValueOnce(response({ newStartPageToken: 'final', changes: [] }));
    await new DriveChangesIngestor(db as never, fetcher, 'secret').ingest(
      { pairId: 'p', accountId: 'a', corpusId: 'drive', driveId: 'drive-1', corpus: 'drive', includeItemsFromAllDrives: true, supportsAllDrives: true },
      vi.fn(),
    );
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.searchParams.get('driveId')).toBe('drive-1');
    expect(url.searchParams.get('corpora')).toBe('drive');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
  });
});
