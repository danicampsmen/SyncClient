import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock firebase config before importing auth
vi.mock('./config/firebaseConfig', () => ({
  getFirebaseClientConfig: () => ({
    apiKey: 'x', authDomain: 'x', projectId: 'x', storageBucket: 'x', messagingSenderId: 'x', appId: 'x', oAuthClientId: 'test-client-from-config.apps.googleusercontent.com'
  })
}));

// Mock SecureStore module; we'll import it dynamically in beforeEach
vi.mock('./utils/secureStore', () => ({
  SecureStore: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  }
}));

let fetchMock: any;

beforeEach(async () => {
  vi.restoreAllMocks();
  // Re-apply mocks
  vi.mock('./config/firebaseConfig', () => ({
    getFirebaseClientConfig: () => ({
      apiKey: 'x', authDomain: 'x', projectId: 'x', storageBucket: 'x', messagingSenderId: 'x', appId: 'x', oAuthClientId: 'test-client-from-config.apps.googleusercontent.com'
    })
  }));

  // Define a minimal global.window to satisfy imports that reference window
  (global as any).window = (global as any).window || { electronBridge: { isElectron: false } };

  // Provide SecureStore mock implementations via dynamic import
  const secureMod = await import('./utils/secureStore');
  secureMod.SecureStore.get = vi.fn(async (key: string) => {
    if (key === 'gdrive_refresh_token') return 'refresh-xyz';
    if (key === 'gdrive_access_token') return null;
    if (key === 'gdrive_token_expiry') return null;
    return null;
  });
  secureMod.SecureStore.set = vi.fn();
  secureMod.SecureStore.remove = vi.fn();

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
