import { Capacitor } from '@capacitor/core';

const BACKEND_ORIGIN = Capacitor.isNativePlatform() ? 'http://localhost:3000' : '';
const CLIENT_KIND = Capacitor.isNativePlatform()
  ? 'android'
  : ((window as any).electronBridge?.isElectron ? 'electron' : 'web');

let sessionToken: string | null = null;
let bootstrapPromise: Promise<void> | null = null;

const resolveUrl = (input: RequestInfo | URL): RequestInfo | URL => {
  if (typeof input === 'string' && input.startsWith('/api/')) return `${BACKEND_ORIGIN}${input}`;
  return input;
};

export const ensureBackendSession = async (): Promise<void> => {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const response = await fetch(resolveUrl('/api/session/bootstrap'), {
      credentials: 'include',
      headers: { 'X-SyncClient-Client': CLIENT_KIND }
    });
    if (!response.ok) throw new Error(`No se pudo iniciar la sesión local (${response.status})`);
    const data = await response.json() as { sessionToken?: string };
    sessionToken = data.sessionToken || null;
  })().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
};

export const backendFetch = async (
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> => {
  await ensureBackendSession();
  const headers = new Headers(init.headers);
  if (sessionToken) headers.set('Authorization', `Bearer ${sessionToken}`);
  return fetch(resolveUrl(input), {
    ...init,
    headers,
    credentials: 'include'
  });
};
