import { initializeApp } from 'firebase/app';
import {
  getAuth, signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithCredential, GoogleAuthProvider, onAuthStateChanged, User,
  setPersistence, browserLocalPersistence
} from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';
import firebaseConfig from '../firebase-applet-config.json';
import { backendFetch, ensureBackendSession } from './services/backendSession';
import { SecureStore } from './utils/secureStore';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Persistencia de Firebase Auth (sobrevive reinicios de app)
try {
  setPersistence(auth, browserLocalPersistence).catch((err) => {
    console.warn('[Auth] No se pudo configurar persistencia de Firebase:', err);
  });
} catch (err) {
  console.warn('[Auth] Error configurando persistencia:', err);
}

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive');
// Solicitar access_type=offline + prompt=consent para obtener refresh_token
provider.setCustomParameters({ access_type: 'offline', prompt: 'consent select_account' });

// Estado de tokens en memoria (se carga al inicio con loadTokensToMemory)
let cachedAccessToken: string | null = null;
let tokenExpiry: number = 0;
let cachedRefreshToken: string | null = null;
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // Renovar si faltan menos de 5 minutos

const GOOGLE_CLIENT_ID = (firebaseConfig as any).oAuthClientId as string;
let isElectronOAuthInProgress = false;

// --- Funciones de Almacenamiento Seguro (Asíncronas) ---

export async function loadTokensToMemory(): Promise<void> {
  cachedAccessToken = await SecureStore.get('gdrive_access_token');
  cachedRefreshToken = await SecureStore.get('gdrive_refresh_token');
  const expiryStr = await SecureStore.get('gdrive_token_expiry');
  tokenExpiry = expiryStr ? parseInt(expiryStr, 10) : 0;
}

async function saveTokens(accessToken: string, refreshToken: string | null, expiresIn: number): Promise<void> {
  cachedAccessToken = accessToken;
  await SecureStore.set('gdrive_access_token', accessToken);

  if (refreshToken) {
    cachedRefreshToken = refreshToken;
    await SecureStore.set('gdrive_refresh_token', refreshToken);
  }

  const expiry = Date.now() + (expiresIn - 300) * 1000; // 5 min de margen
  tokenExpiry = expiry;
  await SecureStore.set('gdrive_token_expiry', expiry.toString());
}

async function clearTokens(): Promise<void> {
  cachedAccessToken = null;
  cachedRefreshToken = null;
  tokenExpiry = 0;
  await SecureStore.remove('gdrive_access_token');
  await SecureStore.remove('gdrive_token_expiry');
  await SecureStore.remove('gdrive_refresh_token');
}

// --- PKCE Helpers para Authorization Code Flow ---

function base64URLEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64URLEncode(new Uint8Array(hash));
}

function savePKCEState(state: string, verifier: string): void {
  sessionStorage.setItem('pkce_state', state);
  sessionStorage.setItem('pkce_verifier', verifier);
}

function getPKCEVerifier(state: string): string | null {
  const savedState = sessionStorage.getItem('pkce_state');
  const savedVerifier = sessionStorage.getItem('pkce_verifier');
  sessionStorage.removeItem('pkce_state');
  sessionStorage.removeItem('pkce_verifier');
  if (savedState !== state) return null; // Prevención CSRF
  return savedVerifier;
}

async function exchangeCodeForTokens(code: string, verifier: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string | null } | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error('[Auth] Error exchanging code for tokens:', errData);
      return null;
    }
    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
    };
  } catch (err: any) {
    console.error('[Auth] Network error exchanging code:', err?.message || err);
    return null;
  }
}

/**
 * Renovación del Google Access Token usando refresh_token de Google OAuth2.
 */
export const refreshAccessToken = async (): Promise<string | null> => {
  if (cachedRefreshToken === null) await loadTokensToMemory();

  // 1. Intentar con refresh_token guardado
  if (cachedRefreshToken) {
    try {
      console.log('[Auth] Renovando Google Access Token vía refresh_token...');
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          refresh_token: cachedRefreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.access_token) {
          await saveTokens(data.access_token, data.refresh_token || cachedRefreshToken, data.expires_in || 3600);
          console.log('[Auth] ✅ Token renovado exitosamente vía refresh_token.');
          return data.access_token;
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        console.error('[Auth] Error renovando token vía OAuth2:', errData);
        if (errData.error === 'invalid_grant') {
          console.error('[Auth] Refresh token revocado o expirado. Se requiere re-autenticación completa.');
          await clearTokens();
          return null;
        }
      }
    } catch (err: any) {
      console.error('[Auth] Error de red renovando token:', err?.message || err);
    }
  }

  // Fallback: re-autenticar silenciosamente según plataforma
  try {
    const electronBridge = (window as any).electronBridge;

    // Electron: re-autenticar vía navegador externo
    if (electronBridge?.isElectron && electronBridge?.openExternal) {
      console.log('[Auth] Re-autenticando vía navegador externo...');
      const authUrl = await buildMobileOAuthUrl();
      await electronBridge.openExternal(authUrl);

      const token = await pollBackendForToken();
      if (token) {
        await saveTokens(token, cachedRefreshToken, 3600);
        return token;
      }
    }

    // Web: usar signInWithPopup para re-autenticar
    if (!Capacitor.isNativePlatform()) {
      console.log('[Auth] Re-autenticando vía Firebase signInWithPopup...');
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        await saveTokens(credential.accessToken, null, 3600);
        return credential.accessToken;
      }
    }

    console.warn('[Auth] No hay refresh_token ni método de re-autenticación disponible.');
    return null;
  } catch (err: any) {
    console.error('[Auth] Error en fallback de renovación:', err?.message || err);
  }
  return null;
};

/**
 * Verifica si el token está próximo a expirar y lo renueva proactivamente.
 */
export const ensureValidToken = async (): Promise<string | null> => {
  if (cachedAccessToken === null) await loadTokensToMemory();
  const now = Date.now();

  if (!cachedAccessToken) return null;

  if (tokenExpiry === 0 || now > tokenExpiry - TOKEN_REFRESH_THRESHOLD_MS) {
    console.log('[Auth] Token próximo a expirar, renovando...');
    const refreshed = await refreshAccessToken();
    if (refreshed) return refreshed;
    return cachedAccessToken; // Devolver el actual aunque esté expirado (fallback final)
  }

  return cachedAccessToken;
};

// Construye la URL de OAuth de Google con PKCE
const buildMobileOAuthUrl = async (): Promise<string> => {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = base64URLEncode(crypto.getRandomValues(new Uint8Array(24)));
  savePKCEState(state, verifier);

  await ensureBackendSession();
  const prepared = await backendFetch('/api/oauth/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state })
  });
  if (!prepared.ok) throw new Error('No se pudo preparar la sesión OAuth');

  const redirectUri = 'http://localhost:3000/api/oauth/callback';
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive profile email');
  const promptValue = cachedRefreshToken ? 'select_account%20consent' : 'consent';

  return (
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&prompt=${promptValue}` +
    `&state=${state}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256`
  );
};

// Consulta al backend si ya capturó un token (polling)
const pollBackendForToken = (): Promise<string | null> =>
  new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 120; // 1 minuto (500ms * 120)
    const interval = setInterval(async () => {
      try {
        const res = await backendFetch('/api/oauth/token');
        if (!res.ok) return;
        const data = await res.json();

        if (data.code && data.state) {
          clearInterval(interval);
          const verifier = getPKCEVerifier(data.state);
          if (verifier) {
            const tokens = await exchangeCodeForTokens(data.code, verifier, 'http://localhost:3000/api/oauth/callback');
            if (tokens) {
              if (tokens.refreshToken) {
                cachedRefreshToken = tokens.refreshToken;
                await SecureStore.set('gdrive_refresh_token', tokens.refreshToken);
              }
              resolve(tokens.accessToken);
            } else {
              resolve(null);
            }
          } else {
            console.error('[Auth] PKCE state mismatch o expirado');
            resolve(null);
          }
        }
      } catch (err) {
        console.warn('[Auth] Error de conexión en polling:', err);
      }

      if (++attempts >= maxAttempts) {
        clearInterval(interval);
        console.error('[Auth] Timeout esperando token.');
        resolve(null);
      }
    }, 500);
  });

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: (error?: string) => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    await loadTokensToMemory();

    if (user) {
      if (cachedAccessToken) {
        const validToken = await ensureValidToken();
        if (validToken) {
          if (onAuthSuccess) onAuthSuccess(user, validToken);
        } else {
          if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
        }
      } else {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          if (onAuthSuccess) onAuthSuccess(user, refreshed);
        } else {
          if (onAuthFailure) onAuthFailure('No se pudo renovar el token de acceso');
        }
      }
    } else {
      if (!cachedAccessToken) {
        try {
          const redirectResult = await getRedirectResult(auth);
          if (redirectResult) {
            const credential = GoogleAuthProvider.credentialFromResult(redirectResult);
            if (credential?.accessToken) {
              await saveTokens(credential.accessToken, null, 3600);
              if (onAuthSuccess) onAuthSuccess(redirectResult.user, credential.accessToken);
              return;
            }
          }
        } catch (err: any) {
          console.warn('[Auth] No hay resultado de redirect:', err?.message || err);
        }
        if (onAuthFailure) onAuthFailure('No hay sesión activa');
      } else {
        console.log('[Auth] Token existe pero Firebase no tiene usuario. Intentando restaurar sesión...');
        try {
          const validToken = await ensureValidToken();
          if (!validToken) throw new Error('No se pudo renovar el token de acceso');

          const credential = GoogleAuthProvider.credential(null, validToken);
          const result = await signInWithCredential(auth, credential);
          console.log('[Auth] ✅ Sesión restaurada con token almacenado.');

          if (onAuthSuccess) onAuthSuccess(result.user, validToken);
        } catch (err: any) {
          console.warn('[Auth] No se pudo restaurar sesión con token almacenado:', err?.message || err);
          await clearTokens();
          if (onAuthFailure) onAuthFailure('Sesión expirada. Inicia sesión de nuevo.');
        }
      }
    }
  });
};

/**
 * Inicia sesión con Google usando PKCE en nativo/Electron y Popups en Web
 */
export const googleSignIn = async (): Promise<{ user: User; accessToken: string }> => {
  await loadTokensToMemory();
  const electronBridge = (window as any).electronBridge;

  // === RUTA ELECTRON (PKCE vía Navegador Externo) ===
  if (electronBridge?.isElectron && electronBridge?.openExternal) {
    if (isElectronOAuthInProgress) {
      console.log('[Auth/Electron] OAuth ya en progreso.');
      throw new Error('OAuth en progreso. Completa el inicio de sesión en tu navegador.');
    }
    isElectronOAuthInProgress = true;
    try {
      console.log('[Auth/Electron] Iniciando flujo OAuth con navegador externo (PKCE)...');

      const authUrl = await buildMobileOAuthUrl();
      await electronBridge.openExternal(authUrl);

      const tokenOrCode = await pollBackendForToken();
      if (!tokenOrCode) {
        throw new Error('No se recibió token. ¿Cancelaste el inicio de sesión en el navegador?');
      }

      const credential = GoogleAuthProvider.credential(null, tokenOrCode);
      const firebaseResult = await signInWithCredential(auth, credential);

      await saveTokens(tokenOrCode, cachedRefreshToken, 3600);
      console.log('[Auth/Electron] Sesión iniciada con éxito.');
      return { user: firebaseResult.user, accessToken: tokenOrCode };
    } finally {
      isElectronOAuthInProgress = false;
    }
  }

  // === RUTA MÓVIL CAPACITOR (Chrome Custom Tab + PKCE) ===
  if (Capacitor.isNativePlatform()) {
    console.log('[Auth/Mobile] Iniciando flujo OAuth con PKCE...');

    try {
      await signInWithRedirect(auth, provider);
      throw new Error('REDIRECT_INITIATED');
    } catch (e: any) {
      if (e.message === 'REDIRECT_INITIATED') {
        throw new Error('Redirigiendo al navegador para autenticación...');
      }
    }

    const authUrl = await buildMobileOAuthUrl();
    await Browser.open({ url: authUrl, windowName: '_blank' });

    const tokenOrCode = await new Promise<string | null>((resolve) => {
      let resolved = false;

      const handlePromise = App.addListener('appUrlOpen', async (event) => {
        if (resolved) return;
        const url = event.url;
        if (url.includes('code=')) {
          const params = new URLSearchParams(url.split('?')[1] || '');
          const code = params.get('code');
          const state = params.get('state');
          if (code && state) {
            resolved = true;
            handlePromise.then(h => h.remove());
            Browser.close().catch(() => { });
            const verifier = getPKCEVerifier(state);
            if (verifier) {
              const tokens = await exchangeCodeForTokens(code, verifier, 'http://localhost:3000/api/oauth/callback');
              if (tokens?.refreshToken) {
                cachedRefreshToken = tokens.refreshToken;
                await SecureStore.set('gdrive_refresh_token', tokens.refreshToken);
              }
              resolve(tokens?.accessToken || null);
            } else {
              resolve(null);
            }
          }
        }
      });

      pollBackendForToken().then((t) => {
        if (!resolved) {
          resolved = true;
          if (t) resolve(t);
        }
      });
    });

    if (!tokenOrCode) {
      throw new Error('No se recibió token. ¿Completaste el inicio de sesión en el navegador?');
    }

    const credential = GoogleAuthProvider.credential(null, tokenOrCode);
    const result = await signInWithCredential(auth, credential);
    await saveTokens(tokenOrCode, cachedRefreshToken, 3600);
    console.log('[Auth/Mobile] Sesión iniciada con éxito.');
    return { user: result.user, accessToken: tokenOrCode };
  }

  // === RUTA WEB BÁSICA ===
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) throw new Error('No se pudo obtener el token de acceso de Google Drive');

  await saveTokens(credential.accessToken, null, 3600);
  return { user: result.user, accessToken: credential.accessToken };
};

export const getAccessToken = async (): Promise<string | null> => {
  return ensureValidToken();
};

export const logout = async () => {
  await auth.signOut();
  await clearTokens();
};

export type { User as UserProfile };