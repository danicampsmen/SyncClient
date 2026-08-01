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
  apiKey: 'REPLACE_WITH_REAL_API_KEY',
  authDomain: 'REPLACE_WITH_REAL_AUTH_DOMAIN',
  projectId: 'REPLACE_WITH_REAL_PROJECT_ID',
  storageBucket: 'REPLACE_WITH_REAL_STORAGE_BUCKET',
  messagingSenderId: '000000000000',
  appId: 'REPLACE_WITH_REAL_APP_ID',
  oAuthClientId: 'REPLACE_WITH_REAL_OAUTH_CLIENT_ID',
};

function readEnv(name: string): string | undefined {
  const importMetaWithEnv = import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  };
  const value = typeof import.meta !== 'undefined' && importMetaWithEnv.env ? importMetaWithEnv.env[name] : undefined;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function getFirebaseClientConfig(): FirebaseClientConfig {
  const envConfig = {
    apiKey: readEnv('VITE_FIREBASE_API_KEY'),
    authDomain: readEnv('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: readEnv('VITE_FIREBASE_PROJECT_ID'),
    storageBucket: readEnv('VITE_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
    appId: readEnv('VITE_FIREBASE_APP_ID'),
    oAuthClientId: readEnv('VITE_FIREBASE_OAUTH_CLIENT_ID'),
  };

  const config = { ...PLACEHOLDER_CONFIG, ...envConfig };
  const hasRealValues = Boolean(
    config.apiKey && config.apiKey !== PLACEHOLDER_CONFIG.apiKey
    && config.authDomain && config.authDomain !== PLACEHOLDER_CONFIG.authDomain
    && config.projectId && config.projectId !== PLACEHOLDER_CONFIG.projectId
    && config.appId && config.appId !== PLACEHOLDER_CONFIG.appId
    && config.oAuthClientId && config.oAuthClientId !== PLACEHOLDER_CONFIG.oAuthClientId,
  );

  if (!hasRealValues) {
    console.warn('[Auth] Firebase client config is using placeholder values. Replace VITE_FIREBASE_* env vars for real Google Drive OAuth.');
  }

  return config;
}
