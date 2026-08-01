import type { IStorageBackend } from '../shared/StorageBackend';
import type { DriveCursor } from '../shared/schema';

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: Record<string, unknown>;
  changeType?: string;
}

export interface DriveChangesOptions {
  pairId: string;
  accountId: string;
  corpusId: string;
  driveId?: string;
  corpus?: string;
  includeItemsFromAllDrives?: boolean;
  supportsAllDrives?: boolean;
  pageSize?: number;
  fields?: string;
}

export interface DriveChangesResult {
  appliedChanges: number;
  pageCount: number;
  pageToken: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ApplyDriveChange = (change: DriveChange) => Promise<void> | void;

export class DriveCursorRescanRequiredError extends Error {
  readonly rescanRequired = true;
  constructor(message = 'Drive changes cursor is invalid or expired') {
    super(message);
    this.name = 'DriveCursorRescanRequiredError';
  }
}

interface StartPageTokenResponse {
  startPageToken?: string;
}

interface ChangesListResponse {
  changes?: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 32_000;

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function transient(status: number): boolean {
  return status === 429 || status >= 500;
}

function invalidCursor(status: number, body: unknown): boolean {
  if (status === 400 || status === 410) return true;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return /invalid(page)?token|page token is invalid|start page token/i.test(text);
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

export class DriveChangesIngestor {
  constructor(
    private readonly storage: IStorageBackend,
    private readonly fetcher: FetchLike = fetch,
    private readonly accessToken: string,
    private readonly sleepFn: (ms: number) => Promise<void> = sleep,
  ) {}

  async ingest(options: DriveChangesOptions, applyChange: ApplyDriveChange): Promise<DriveChangesResult> {
    const key = {
      pair_id: options.pairId,
      account_id: options.accountId,
      corpus_id: options.corpusId,
      drive_id: options.driveId ?? 'my-drive',
    } as const;
    const existing = this.storage.getDriveCursor(key);
    const pageToken = existing?.page_token ?? await this.getStartPageToken(options);
    let nextToken: string | undefined = pageToken;
    let finalToken: string | undefined;
    let pageCount = 0;
    let appliedChanges = 0;

    while (nextToken) {
      const data = await this.listChanges(options, nextToken);
      pageCount++;
      for (const change of data.changes ?? []) {
        await applyChange(change);
        appliedChanges++;
      }
      finalToken = data.newStartPageToken ?? finalToken;
      nextToken = data.nextPageToken;
    }

    if (!finalToken) {
      throw new Error('Drive changes response did not include newStartPageToken');
    }

    const cursor: DriveCursor = {
      ...key,
      page_token: finalToken,
      last_success_at: Date.now(),
      status: 'active',
    };
    this.storage.setDriveCursor(cursor);
    return { appliedChanges, pageCount, pageToken: finalToken };
  }

  private async getStartPageToken(options: DriveChangesOptions): Promise<string> {
    const params = this.sharedParams(options);
    const data = await this.requestJson<StartPageTokenResponse>(
      `${DRIVE_API}/changes/startPageToken?${params.toString()}`,
    );
    if (!data.startPageToken) throw new Error('Drive startPageToken response was missing a token');
    return data.startPageToken;
  }

  private async listChanges(options: DriveChangesOptions, pageToken: string): Promise<ChangesListResponse> {
    const params = this.sharedParams(options);
    params.set('pageToken', pageToken);
    params.set('fields', options.fields ?? 'nextPageToken,newStartPageToken,changes(fileId,removed,file,changeType)');
    return this.requestJson<ChangesListResponse>(`${DRIVE_API}/changes?${params.toString()}`);
  }

  private sharedParams(options: DriveChangesOptions): URLSearchParams {
    const params = new URLSearchParams({
      pageSize: String(options.pageSize ?? 1000),
      supportsAllDrives: String(options.supportsAllDrives ?? Boolean(options.driveId)),
      includeItemsFromAllDrives: String(options.includeItemsFromAllDrives ?? Boolean(options.driveId)),
    });
    if (options.corpus) params.set('corpora', options.corpus);
    if (options.driveId) params.set('driveId', options.driveId);
    return params;
  }

  private async requestJson<T>(url: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS) throw error;
        await this.sleepFn(Math.min(MAX_BACKOFF_MS, 1000 * (2 ** (attempt - 1))));
        continue;
      }

      const body = await response.text();
      let parsed: unknown;
      try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
      if (response.ok) return parsed as T;
      if (invalidCursor(response.status, parsed)) throw new DriveCursorRescanRequiredError();
      if (!transient(response.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(`Drive changes request failed (${response.status})`);
      }
      const delay = retryAfterMs(response.headers.get('retry-after'))
        ?? Math.min(MAX_BACKOFF_MS, 1000 * (2 ** (attempt - 1)));
      await this.sleepFn(delay);
    }
    throw lastError instanceof Error ? lastError : new Error('Drive changes request failed');
  }
}
