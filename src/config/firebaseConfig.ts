export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  oAuthClientId: string;
}

const PLACEHOLDER_CONFIG: FirebaseClientConfig = {
  apiKey: 'AIzaSyAobuWG8WiWU4kFHwDCmwoyHb9Hx9NGvPQ',
  authDomain: 'gen-lang-client-0459053075.firebaseapp.com',
  projectId: 'gen-lang-client-0459053075',
  storageBucket: 'gen-lang-client-0459053075.firebasestorage.app',
  messagingSenderId: '123619653091',
  appId: '1:123619653091:web:88153bec247c74379e1cd6',
  oAuthClientId: '123619653091-7htd1ubnbdoi3vchlo99mcv2mq6gmkmq.apps.googleusercontent.com',
};

function readEnv(name: string): string | undefined {
  const importMetaWithEnv = import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  };
  const value = typeof import.meta !== 'undefined' && importMetaWithEnv.env ? importMetaWithEnv.env[name] : undefined;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function getFirebaseClientConfig(): FirebaseClientConfig {
  const config: FirebaseClientConfig = {
    apiKey: readEnv('VITE_FIREBASE_API_KEY') || PLACEHOLDER_CONFIG.apiKey,
    authDomain: readEnv('VITE_FIREBASE_AUTH_DOMAIN') || PLACEHOLDER_CONFIG.authDomain,
    projectId: readEnv('VITE_FIREBASE_PROJECT_ID') || PLACEHOLDER_CONFIG.projectId,
    storageBucket: readEnv('VITE_FIREBASE_STORAGE_BUCKET') || PLACEHOLDER_CONFIG.storageBucket,
    messagingSenderId: readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID') || PLACEHOLDER_CONFIG.messagingSenderId,
    appId: readEnv('VITE_FIREBASE_APP_ID') || PLACEHOLDER_CONFIG.appId,
    oAuthClientId: readEnv('VITE_FIREBASE_OAUTH_CLIENT_ID') || readEnv('VITE_GOOGLE_CLIENT_ID') || PLACEHOLDER_CONFIG.oAuthClientId,
  };

  const hasRealValues = Boolean(
    config.apiKey && !config.apiKey.includes('REPLACE_WITH')
    && config.authDomain && !config.authDomain.includes('REPLACE_WITH')
    && config.projectId && !config.projectId.includes('REPLACE_WITH')
    && config.appId && !config.appId.includes('REPLACE_WITH')
    && config.oAuthClientId && !config.oAuthClientId.includes('REPLACE_WITH'),
  );

  if (!hasRealValues) {
    console.warn('[Auth] Firebase client config is using placeholder values. Replace VITE_FIREBASE_* env vars for real Google Drive OAuth.');
  }

  return config;
}