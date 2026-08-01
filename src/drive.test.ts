import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the auth module to avoid real network calls and window dependencies
const mockAccessToken = vi.fn();
const mockRefreshToken = vi.fn().mockResolvedValue(true);
const mockLogout = vi.fn().mockResolvedValue(undefined);

vi.mock('./auth', () => ({
  getAccessToken: (...args: any[]) => mockAccessToken(...args),
  refreshAccessToken: (...args: any[]) => mockRefreshToken(...args),
  logout: (...args: any[]) => mockLogout(...args),
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('drive.ts - handleResponse', () => {
  let drive: typeof import('./drive');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    drive = await import('./drive');
  });

  it('returns successfully for 200 responses', async () => {
    const mockRes = {
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ nextPageToken: null, files: [] }),
    } as any;

    mockAccessToken.mockResolvedValue('fake-token');
    mockFetch.mockResolvedValue(mockRes);

    const result = await drive.listFiles('root');
    expect(result).toEqual([]);
  });

  it('throws immediate error for non-retryable status codes', async () => {
    const mockRes = {
      ok: false,
      status: 404,
      text: () => Promise.resolve('File not found'),
    } as any;

    mockFetch.mockResolvedValue(mockRes);

    await expect(drive.listFiles('root')).rejects.toThrow('Drive API error (404)');
  });

  it('handles 401 by refreshing token via Promise mutex', async () => {
    const mock401Res = {
      ok: false,
      status: 401,
      body: { cancel: () => Promise.resolve() },
      text: () => Promise.resolve('Unauthorized'),
    } as any;

    const mockOkRes = {
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ nextPageToken: null, files: [] }),
    } as any;

    mockAccessToken.mockResolvedValue('new-token');
    mockRefreshToken.mockResolvedValue(true);
    mockFetch.mockResolvedValueOnce(mock401Res).mockResolvedValueOnce(mockOkRes);

    const result = await drive.listFiles('root');
    expect(result).toEqual([]);
    expect(mockRefreshToken).toHaveBeenCalled();
  });

  it('calls logout after failed token refresh on persistent 401', async () => {
    const mock401Res = {
      ok: false,
      status: 401,
      body: { cancel: () => Promise.resolve() },
      text: () => Promise.resolve('Unauthorized'),
    } as any;

    mockAccessToken.mockResolvedValue('fake-token');
    mockRefreshToken.mockResolvedValue(false); // Refresh fails
    
    const doFetch = vi.fn().mockResolvedValue(mock401Res);
    mockFetch.mockImplementation(doFetch);

    await expect(drive.listFiles('root')).rejects.toThrow('Sesión de Google Drive expirada');
    expect(mockLogout).toHaveBeenCalled();
  });
});
