import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.syncclient.app',
  appName: 'SyncClient',
  webDir: 'dist',
  loggingBehavior: 'none',
  server: {
    // Cuando estemos en Android, podemos apuntar a la URL de dev en vivo o compilar los estáticos
    androidScheme: 'https'
  }
};

export default config;
