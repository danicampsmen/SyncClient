import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

const electronBridge = typeof window !== 'undefined' ? (window as Window & {
  electronBridge?: {
    isElectron?: boolean;
    secureSet?: (key: string, value: string) => Promise<boolean>;
    secureGet?: (key: string) => Promise<string | null>;
    secureRemove?: (key: string) => Promise<void>;
  };
}).electronBridge : undefined;

export const SecureStore = {
    async set(key: string, value: string): Promise<void> {
        if (Capacitor.isNativePlatform()) {
            await SecureStoragePlugin.set({ key, value });
            return;
        }

        if (electronBridge?.isElectron && electronBridge.secureSet) {
            const stored = await electronBridge.secureSet(key, value);
            if (!stored) throw new Error('No se pudo guardar el token en el almacenamiento cifrado del sistema');
            return;
        }

        localStorage.setItem(key, value);
    },

    async get(key: string): Promise<string | null> {
        if (Capacitor.isNativePlatform()) {
            try {
                const { value } = await SecureStoragePlugin.get({ key });
                return value;
            } catch {
                return null;
            }
        }

        if (electronBridge?.isElectron && electronBridge.secureGet) {
            return electronBridge.secureGet(key);
        }

        return localStorage.getItem(key);
    },

    async remove(key: string): Promise<void> {
        if (Capacitor.isNativePlatform()) {
            try {
                await SecureStoragePlugin.remove({ key });
            } catch { }
            return;
        }

        if (electronBridge?.isElectron && electronBridge.secureRemove) {
            await electronBridge.secureRemove(key);
            return;
        }

        localStorage.removeItem(key);
    }
};
