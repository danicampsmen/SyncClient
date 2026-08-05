import { beforeEach, describe, expect, it, vi } from 'vitest';

// Set up environment and mocks before importing auth module
vi.mock('./config/firebaseConfig', () => ({
  getFirebaseClientConfig: () => ({
    apiKey: 'x', authDomain: 'x', projectId: 'x', storageBucket: 'x', messagingSenderId: 'x', appId: 'x', oAuthClientId: 'test-client-from-config.apps.googleusercontent.com'
  })
}));

// Mock SecureStore
vi.mock('./utils/secureStore', () => ({
  SecureStore: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  }
}));

let fetchMock: any;

beforeEach(() => {
  vi.restoreAllMocks();
  // Provide SecureStore mock implementations
  const secure = require('./utils/secureStore').SecureStore;
  secure.get.mockImplementation(async (key: string) => {
    if (key === 'gdrive_refresh_token') return 'refresh-xyz';
    if (key === 'gdrive_access_token') return null;
    if (key === 'gdrive_token_expiry') return null;
    return null;
  });

  // Mock global fetch to capture the request body
  fetchMock = vi.fn(async (url: string, init: any) => {
    // respond with success and a new access token
    return {
      ok: true,
      json: async () => ({ access_token: 'new-access', refresh_token: 'refresh-xyz', expires_in: 3600 }),
    };
  });
  (global as any).fetch = fetchMock;
});

describe('refreshAccessToken uses client_id from firebaseConfig oAuthClientId', () => {
  it('sends the configured client id in the request body', async () => {
    // Import the module dynamically so our mocks take effect
    const mod = await import('./auth');
    const refreshAccessToken = mod.refreshAccessToken as () => Promise<string | null>;

    const token = await refreshAccessToken();
    expect(token).toBe('new-access');

    // Inspect the call to fetch and the body sent
    expect(fetchMock).toHaveBeenCalled();
    const callArgs = fetchMock.mock.calls[0];
    const body = callArgs[1].body as string;
    expect(body).toContain('client_id=test-client-from-config.apps.googleusercontent.com');
  });
});
