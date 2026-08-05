import { Logger } from '../shared/browserLogger';

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
  apiKey: 'AIzaSyC0GBNNbA1ALUv9IK2j8GBZP9cIGYSD3as',
  authDomain: 'syncclient-ac0a8.firebaseapp.com',
  projectId: 'syncclient-ac0a8',
  storageBucket: 'syncclient-ac0a8.firebasestorage.app',
  messagingSenderId: '608230005218',
  appId: '1:608230005218:web:101c2baaeabf8d687e41bb',
  oAuthClientId: '608230005218-7piiftmb6pi6gbpg12b22d7srv623oee.apps.googleusercontent.com',
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
    new Logger('Auth').warn('Firebase client config is using placeholder values. Replace VITE_FIREBASE_* env vars for real Google Drive OAuth.');
  }

  return config;
}