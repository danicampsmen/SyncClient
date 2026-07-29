import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, signInWithCredential, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive');
provider.setCustomParameters({ prompt: 'select_account' });

let cachedAccessToken: string | null = localStorage.getItem('gdrive_access_token');

// Construye la URL de OAuth de Google usando nuestro backend como relay (accesible via ADB tunnel)
// El servidor en localhost:3000 sirve la página de captura y almacena el token para que la app lo recoja
const buildGoogleOAuthUrl = () => {
  const clientId = (firebaseConfig as any).oAuthClientId;
  // http://localhost:3000 en la tablet apunta a nuestro PC via ADB reverse tunnel
  const redirectUri = `http://localhost:3000/api/oauth/callback`;
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive profile email');
  return (
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=token` +
    `&scope=${scope}` +
    `&prompt=select_account`
  );
};

// Consulta al backend si ya capturó un token (polling rápido cada 500ms)
const pollBackendForToken = (): Promise<string | null> =>
  new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 600; // 5 minutos (600 * 500ms)
    const interval = setInterval(async () => {
      try {
        const res = await fetch('http://localhost:3000/api/oauth/token');
        if (!res.ok) {
          console.warn(`[Auth/Mobile] El servidor respondió con estado: ${res.status}`);
          return;
        }
        const data = await res.json();
        if (data.token) {
          clearInterval(interval);
          resolve(data.token);
        }
      } catch (err) {
        console.warn('[Auth/Mobile] Error de conexión/CORS en polling:', err);
      }
      if (++attempts >= maxAttempts) {
        clearInterval(interval);
        console.error('[Auth/Mobile] Timeout: Expiró el tiempo límite esperando el token.');
        resolve(null);
      }
    }, 500); // Polling cada 500ms para capturar el token rápidamente
  });

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      const token = cachedAccessToken || localStorage.getItem('gdrive_access_token');
      if (token) {
        cachedAccessToken = token;
        if (onAuthSuccess) onAuthSuccess(user, token);
      } else {
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      localStorage.removeItem('gdrive_access_token');
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string }> => {
  const electronBridge = (window as any).electronBridge;

  // Ruta Electron: ventana nativa de OAuth (ya funciona perfectamente)
  if (electronBridge?.isElectron && electronBridge?.openGoogleAuth) {
    const token = await electronBridge.openGoogleAuth();
    if (!token) throw new Error('No se pudo obtener el token de acceso de Google Drive');
    const credential = GoogleAuthProvider.credential(null, token);
    const result = await signInWithCredential(auth, credential);
    cachedAccessToken = token;
    localStorage.setItem('gdrive_access_token', token);
    return { user: result.user, accessToken: token };
  }

  // Ruta Móvil (Android/iOS Capacitor): Chrome Custom Tab + Deep Links (Autónomo) / relay a través de ADB
  if (Capacitor.isNativePlatform()) {
    console.log('[Auth/Mobile] Abriendo Chrome Custom Tab para OAuth de Google via Deep Links & relay backend...');
    const authUrl = buildGoogleOAuthUrl();

    // Abrir Chrome Custom Tab — Google lo permite (no es un WebView)
    await Browser.open({ url: authUrl, windowName: '_blank' });

    console.log('[Auth/Mobile] Esperando token (vía enlace profundo nativo syncclient:// o relay ADB local)...');
    const tokenPromise = new Promise<string | null>(async (resolve) => {
      let resolved = false;

      // 1. Escucha por enlace profundo nativo (Autónomo sin ADB exterior: syncclient://oauth)
      const handle = await App.addListener('appUrlOpen', (event) => {
        if (!resolved && (event.url.includes('access_token=') || event.url.includes('token=') || event.url.includes('syncclient://'))) {
          const params = new URLSearchParams(event.url.split('#')[1] || event.url.split('?')[1] || '');
          const t = params.get('access_token') || params.get('token');
          if (t) {
            console.log('[Auth/Mobile] Token capturado autónomamente vía Deep Link nativo.');
            resolved = true;
            handle.remove();
            Browser.close().catch(() => {});
            resolve(t);
          }
        }
      });

      // 2. Escucha en paralelo por el backend de ADB tethering (en casa vía localhost:3000)
      pollBackendForToken().then((t) => {
        if (!resolved) {
          resolved = true;
          handle.remove();
          if (t) {
            console.log('[Auth/Mobile] Token capturado vía servidor relay ADB.');
            Browser.close().catch(() => {});
            resolve(t);
          } else {
            resolve(null);
          }
        }
      });
    });

    const token = await tokenPromise;

    if (!token) {
      throw new Error('[Auth/Mobile] No se recibió token. ¿Completaste el inicio de sesión en el navegador?');
    }

    try {
      const credential = GoogleAuthProvider.credential(null, token);
      const result = await signInWithCredential(auth, credential);
      cachedAccessToken = token;
      localStorage.setItem('gdrive_access_token', token);
      console.log('[Auth/Mobile] ✅ Token de Google Drive y sesión nativa consolidados con éxito.');
      return { user: result.user, accessToken: token };
    } catch (e) {
      throw e;
    }
  }


  // Ruta Web (Desktop sin Electron): popup estándar de Firebase
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) throw new Error('No se pudo obtener el token de acceso de Google Drive');
  cachedAccessToken = credential.accessToken;
  localStorage.setItem('gdrive_access_token', cachedAccessToken);
  return { user: result.user, accessToken: cachedAccessToken };
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken || localStorage.getItem('gdrive_access_token');
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
  localStorage.removeItem('gdrive_access_token');
};

// Tipo re-exportado para uso en SyncApp.tsx
export type { User as UserProfile };
