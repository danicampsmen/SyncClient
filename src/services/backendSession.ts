import { Capacitor } from '@capacitor/core';

const BACKEND_ORIGIN = Capacitor.isNativePlatform() ? 'http://localhost:3000' : '';
const CLIENT_KIND = Capacitor.isNativePlatform()
  ? 'android'
  : ((window as any).electronBridge?.isElectron ? 'electron' : 'web');

let sessionToken: string | null = null;
let bootstrapPromise: Promise<void> | null = null;

// P11/P12: Circuit breaker
let circuitOpen = false;
let circuitOpenUntil = 0;
let consecutiveFailures = 0;
const CIRCUIT_BREAK_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 30000;

// P13: Health check
let isBackendAvailable = false;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

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

// P11/P12: backendFetch con reintentos y circuit breaker
export const backendFetch = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  retries = 3
): Promise<Response> => {
  if (circuitOpen) {
    if (Date.now() < circuitOpenUntil) {
      throw new Error('Backend no disponible. Reconectando en breve...');
    }
    circuitOpen = false;
    consecutiveFailures = 0;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await ensureBackendSession();
      const headers = new Headers(init.headers);
      if (sessionToken) headers.set('Authorization', `Bearer ${sessionToken}`);
      const res = await fetch(resolveUrl(input), {
        ...init,
        headers,
        credentials: 'include'
      });
      if (res.ok) {
        consecutiveFailures = 0;
        circuitOpen = false;
        return res;
      }
      if (res.status >= 500) {
        lastError = new Error(`Backend error ${res.status}`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, Math.min(8000, 1000 * (2 ** (attempt - 1)))));
          continue;
        }
      }
      return res;
    } catch (e: any) {
      lastError = e;
      consecutiveFailures++;
      if (consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
        circuitOpen = true;
        circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
        console.warn(`[BackendSession] Circuit breaker abierto por ${CIRCUIT_RESET_MS / 1000}s tras ${consecutiveFailures} fallos consecutivos`);
      }
      if (attempt < retries) {
        console.warn(`[BackendSession] Intento ${attempt}/${retries} fallido, reintentando en ${2 ** (attempt - 1)}s...`);
        await new Promise(r => setTimeout(r, 1000 * (2 ** (attempt - 1))));
      }
    }
  }
  throw lastError;
};

// P13: Health check periódico
export function startHealthCheck(onStatusChange?: (available: boolean) => void) {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(async () => {
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/health`);
      const wasAvailable = isBackendAvailable;
      isBackendAvailable = res.ok;
      if (wasAvailable !== isBackendAvailable && onStatusChange) {
        onStatusChange(isBackendAvailable);
      }
    } catch {
      if (isBackendAvailable && onStatusChange) {
        isBackendAvailable = false;
        onStatusChange(false);
      }
    }
  }, 30000);
}

export function getBackendStatus(): boolean {
  return isBackendAvailable;
}