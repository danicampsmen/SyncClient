import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

export const SecureStore = {
    async set(key: string, value: string): Promise<void> {
        if (Capacitor.isNativePlatform()) {
            await SecureStoragePlugin.set({ key, value });
        } else {
            // TODO futuro: Conectar con electronBridge.safeStorageSet(key, value)
            localStorage.setItem(key, value);
        }
    },

    async get(key: string): Promise<string | null> {
        if (Capacitor.isNativePlatform()) {
            try {
                const { value } = await SecureStoragePlugin.get({ key });
                return value;
            } catch {
                return null; // El plugin lanza error si la clave no existe
            }
        } else {
            return localStorage.getItem(key);
        }
    },

    async remove(key: string): Promise<void> {
        if (Capacitor.isNativePlatform()) {
            try {
                await SecureStoragePlugin.remove({ key });
            } catch { }
        } else {
            localStorage.removeItem(key);
        }
    }
};