import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithCredential, GoogleAuthProvider, onAuthStateChanged, User, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Fix B: Persistencia de Firebase Auth para Capacitor — sobrevive reinicios de app en móvil
try {
  setPersistence(auth, browserLocalPersistence).catch((err) => {
    console.warn('[Auth] No se pudo configurar persistencia de Firebase:', err);
  });
} catch (err) {
  console.warn('[Auth] Error configurando persistencia:', err);
}

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive');
// B2 Fix: Solicitar access_type=offline + prompt=consent para obtener refresh_token
// Sin access_type=offline, Google no devuelve refresh_token y el token expira en 1 hora
provider.setCustomParameters({ access_type: 'offline', prompt: 'consent select_account' });

let cachedAccessToken: string | null = localStorage.getItem('gdrive_access_token');
// Fix A: Tracking de expiración del token para renovación automática
let tokenExpiry: number = parseInt(localStorage.getItem('gdrive_token_expiry') || '0', 10);
// B2 Fix: Almacenar refresh_token para renovación real de Google OAuth2
let cachedRefreshToken: string | null = localStorage.getItem('gdrive_refresh_token');
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // Renovar si faltan menos de 5 minutos
// Google OAuth2 client ID (de la config de Firebase)
const GOOGLE_CLIENT_ID = (firebaseConfig as any).oAuthClientId as string;
// Guarda síncrona: previene ventanas OAuth duplicadas en Electron
let isElectronOAuthInProgress = false;

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

// Guarda estado PKCE en sessionStorage (se borra al cerrar la app)
function savePKCEState(state: string, verifier: string): void {
  sessionStorage.setItem('pkce_state', state);
  sessionStorage.setItem('pkce_verifier', verifier);
}

function getPKCEVerifier(state: string): string | null {
  const savedState = sessionStorage.getItem('pkce_state');
  const savedVerifier = sessionStorage.getItem('pkce_verifier');
  sessionStorage.removeItem('pkce_state');
  sessionStorage.removeItem('pkce_verifier');
  if (savedState !== state) return null; // CSRF protection
  return savedVerifier;
}

// Intercambia un authorization code por tokens (access_token + refresh_token)
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
 * Si no hay refresh_token, intenta re-autenticar silenciosamente.
 */
export const refreshAccessToken = async (): Promise<string | null> => {
  // Intentar con refresh_token guardado
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
          saveTokens(data.access_token, data.refresh_token || cachedRefreshToken, data.expires_in || 3600);
          console.log('[Auth] ✅ Token renovado exitosamente vía refresh_token.');
          return data.access_token;
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        console.error('[Auth] Error renovando token vía OAuth2:', errData);
        cachedRefreshToken = null;
        localStorage.removeItem('gdrive_refresh_token');
      }
    } catch (err: any) {
      console.error('[Auth] Error de red renovando token:', err?.message || err);
    }
  }

  // Fallback: re-autenticar silenciosamente según plataforma
  try {
    // Electron: usar bridge para re-autenticar
    const electronBridge = (window as any).electronBridge;
    if (electronBridge?.isElectron && electronBridge?.openGoogleAuth) {
      console.log('[Auth] Re-autenticando vía Electron bridge...');
      const result = await electronBridge.openGoogleAuth();
      if (result) {
        const accessToken = typeof result === 'string' ? result : result.accessToken;
        const refreshToken = typeof result === 'object' ? result.refreshToken : null;
        if (accessToken) {
          saveTokens(accessToken, refreshToken, 3600);
          return accessToken;
        }
      }
    }

    // Web: usar signInWithPopup para re-autenticar
    if (!Capacitor.isNativePlatform()) {
      console.log('[Auth] Re-autenticando vía Firebase signInWithPopup...');
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        saveTokens(credential.accessToken, null, 3600);
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
 * Guarda los tokens en localStorage
 */
function saveTokens(accessToken: string, refreshToken: string | null, expiresIn: number): void {
  cachedAccessToken = accessToken;
  localStorage.setItem('gdrive_access_token', accessToken);
  if (refreshToken) {
    cachedRefreshToken = refreshToken;
    localStorage.setItem('gdrive_refresh_token', refreshToken);
  }
  const expiry = Date.now() + (expiresIn - 300) * 1000; // 5 min de margen
  tokenExpiry = expiry;
  localStorage.setItem('gdrive_token_expiry', expiry.toString());
}

function clearTokens(): void {
  cachedAccessToken = null;
  cachedRefreshToken = null;
  tokenExpiry = 0;
  localStorage.removeItem('gdrive_access_token');
  localStorage.removeItem('gdrive_token_expiry');
  localStorage.removeItem('gdrive_refresh_token');
}

/**
 * Verifica si el token está próximo a expirar y lo renueva proactivamente.
 */
export const ensureValidToken = async (): Promise<string | null> => {
  const now = Date.now();
  const token = cachedAccessToken || localStorage.getItem('gdrive_access_token');
  const expiry = tokenExpiry || parseInt(localStorage.getItem('gdrive_token_expiry') || '0', 10);

  if (!token) {
    return null;
  }

  if (expiry === 0 || now > expiry - TOKEN_REFRESH_THRESHOLD_MS) {
    console.log('[Auth] Token próximo a expirar, renovando...');
    const refreshed = await refreshAccessToken();
    if (refreshed) return refreshed;
    return token; // devolver el actual aunque esté expirado, mejor que nada
  }

  return token;
};

// Construye la URL de OAuth de Google con PKCE para móvil
const buildMobileOAuthUrl = async (): Promise<string> => {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = verifier.substring(0, 16);
  savePKCEState(state, verifier);

  const redirectUri = 'http://localhost:3000/api/oauth/callback';
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive profile email');
  return (
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&prompt=select_account%20consent` +
    `&state=${state}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256`
  );
};

// Consulta al backend si ya capturó un token (polling cada 500ms)
const pollBackendForToken = (): Promise<string | null> =>
  new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 120; // 1 minuto
    const interval = setInterval(async () => {
      try {
        const res = await fetch('http://localhost:3000/api/oauth/token');
        if (!res.ok) {
          console.warn(`[Auth/Mobile] Servidor respondió con: ${res.status}`);
          return;
        }
        const data = await res.json();
        if (data.token) {
          clearInterval(interval);
          resolve(data.token);
        } else if (data.code && data.state) {
          clearInterval(interval);
          const verifier = getPKCEVerifier(data.state);
          if (verifier) {
            const tokens = await exchangeCodeForTokens(data.code, verifier, 'http://localhost:3000/api/oauth/callback');
            if (tokens) {
              resolve(tokens.accessToken);
              if (tokens.refreshToken) {
                cachedRefreshToken = tokens.refreshToken;
                localStorage.setItem('gdrive_refresh_token', tokens.refreshToken);
              }
            } else {
              resolve(null);
            }
          } else {
            console.error('[Auth/Mobile] PKCE state mismatch o expirado');
            resolve(null);
          }
        }
      } catch (err) {
        console.warn('[Auth/Mobile] Error de conexión en polling:', err);
      }
      if (++attempts >= maxAttempts) {
        clearInterval(interval);
        console.error('[Auth/Mobile] Timeout esperando token.');
        resolve(null);
      }
    }, 500);
  });

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: (error?: string) => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      const token = cachedAccessToken || localStorage.getItem('gdrive_access_token');
      if (token) {
        cachedAccessToken = token;
        const validToken = await ensureValidToken();
        if (validToken) {
          cachedAccessToken = validToken;
          if (onAuthSuccess) onAuthSuccess(user, validToken);
        } else {
          if (onAuthSuccess) onAuthSuccess(user, token);
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
      const storedToken = localStorage.getItem('gdrive_access_token');
      if (!storedToken) {
        cachedAccessToken = null;
        try {
          const redirectResult = await getRedirectResult(auth);
          if (redirectResult) {
            const credential = GoogleAuthProvider.credentialFromResult(redirectResult);
            if (credential?.accessToken) {
              saveTokens(credential.accessToken, null, 3600);
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
          const credential = GoogleAuthProvider.credential(null, storedToken);
          const result = await signInWithCredential(auth, credential);
          console.log('[Auth] ✅ Sesión restaurada con token almacenado.');
          cachedAccessToken = storedToken;
          if (onAuthSuccess) onAuthSuccess(result.user, storedToken);
        } catch (err: any) {
          console.warn('[Auth] No se pudo restaurar sesión con token almacenado:', err?.message || err);
          clearTokens();
          if (onAuthFailure) onAuthFailure('Sesión expirada. Inicia sesión de nuevo.');
        }
      }
    }
  });
};

/**
 * Inicia sesión con Google. Usa el mejor método según la plataforma.
 */
export const googleSignIn = async (): Promise<{ user: User; accessToken: string }> => {
  const electronBridge = (window as any).electronBridge;

  // === RUTA ELECTRON ===
  if (electronBridge?.isElectron && electronBridge?.openGoogleAuth) {
    if (isElectronOAuthInProgress) {
      console.log('[Auth/Electron] OAuth ya en progreso. Ignorando llamada duplicada.');
      throw new Error('OAuth ya en progreso. Espera a que se complete.');
    }
    isElectronOAuthInProgress = true;
    try {
      const result = await electronBridge.openGoogleAuth();
      if (!result) throw new Error('No se obtuvo respuesta del flujo OAuth');

      const accessToken = typeof result === 'string' ? result : result.accessToken;
      const refreshToken = typeof result === 'object' ? result.refreshToken : null;

      if (!accessToken) throw new Error('No se pudo obtener el token de acceso de Google Drive');

      const credential = GoogleAuthProvider.credential(null, accessToken);
      const firebaseResult = await signInWithCredential(auth, credential);
      saveTokens(accessToken, refreshToken, 3600);
      console.log('[Auth/Electron] Sesión iniciada con éxito.' + (refreshToken ? ' Refresh token disponible.' : ''));
      return { user: firebaseResult.user, accessToken };
    } finally {
      isElectronOAuthInProgress = false;
    }
  }

  // === RUTA MÓVIL (Capacitor) ===
  if (Capacitor.isNativePlatform()) {
    console.log('[Auth/Mobile] Iniciando flujo OAuth con PKCE + Authorization Code...');

    try {
      await signInWithRedirect(auth, provider);
      throw new Error('REDIRECT_INITIATED');
    } catch (e: any) {
      if (e.message === 'REDIRECT_INITIATED') {
        throw new Error('Redirigiendo al navegador para autenticación...');
      }
      console.log('[Auth/Mobile] signInWithRedirect no disponible, usando Chrome Custom Tab + relay...');
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
                localStorage.setItem('gdrive_refresh_token', tokens.refreshToken);
              }
              resolve(tokens?.accessToken || null);
            } else {
              resolve(null);
            }
          }
        } else if (url.includes('access_token=') || url.includes('token=')) {
          const params = new URLSearchParams(url.split('#')[1] || url.split('?')[1] || '');
          const t = params.get('access_token') || params.get('token');
          if (t) {
            resolved = true;
            handlePromise.then(h => h.remove());
            Browser.close().catch(() => { });
            resolve(t);
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

    try {
      const credential = GoogleAuthProvider.credential(null, tokenOrCode);
      const result = await signInWithCredential(auth, credential);
      if (!tokenExpiry) {
        const expiry = Date.now() + 55 * 60 * 1000;
        tokenExpiry = expiry;
        localStorage.setItem('gdrive_token_expiry', expiry.toString());
      }
      console.log('[Auth/Mobile] Sesión iniciada con éxito.');
      return { user: result.user, accessToken: tokenOrCode };
    } catch (e) {
      throw e;
    }
  }

  // === RUTA WEB (Desktop sin Electron) ===
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) throw new Error('No se pudo obtener el token de acceso de Google Drive');
  saveTokens(credential.accessToken, null, 3600);
  return { user: result.user, accessToken: credential.accessToken };
};

export const getAccessToken = async (): Promise<string | null> => {
  return ensureValidToken();
};

export const logout = async () => {
  await auth.signOut();
  clearTokens();
};

// Tipo re-exportado para uso en SyncApp.tsx
export type { User as UserProfile };