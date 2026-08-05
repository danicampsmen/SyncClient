import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { refreshAccessToken } from './auth';
import { SecureStore } from './utils/secureStore';

describe('auth.refreshAccessToken', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renueva el token usando refresh_token almacenado', async () => {
    // Mock SecureStore.get para devolver un refresh token
    vi.spyOn(SecureStore, 'get').mockImplementation(async (key: string) => {
      if (key === 'gdrive_refresh_token') return 'stored-refresh-1';
      return null;
    });

    const setSpy = vi.spyOn(SecureStore, 'set').mockResolvedValue();

    // Mock fetch para simular respuesta de OAuth2
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    }));

    const token = await refreshAccessToken();
    expect(token).toBe('new-access');
    expect(setSpy).toHaveBeenCalled();
  });

  it('retorna null si no hay refresh_token y no hay fallback disponible', async () => {
    vi.spyOn(SecureStore, 'get').mockResolvedValue(null);

    // Simular fetch para cualquier intento (no debería llamarse en este escenario)
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }));

    const token = await refreshAccessToken();
    expect(token).toBeNull();
  });
});
