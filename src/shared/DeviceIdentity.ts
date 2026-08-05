/**
 * DeviceIdentity — Identidad persistente del dispositivo para SyncClient v2.
 *
 * El device_id DEBE sobrevivir a reinstalaciones de la app.
 * Si se pierde, todos los vector clocks anteriores quedan huérfanos
 * y la primera sync post-reinstalación trataría todos los archivos como concurrentes.
 *
 * Estrategia: persistir en Drive (archivo oculto .syncclient_device_id)
 * + DB local (respaldo). Si ambos fallan, generar nuevo y guardar en ambos.
 */

import { IStorageBackend } from './StorageBackend';
import { DeviceInfo } from './schema';
import { Logger } from './browserLogger';

const logger = new Logger('DeviceIdentity');

/**
 * Genera un UUID v4 sin depender de crypto.randomUUID()
 * (compatible con entornos que no tienen crypto).
 */
function generateUUID(): string {
    // crypto.randomUUID está disponible en Node 19+ y navegadores modernos
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback manual
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function getDeviceName(): string {
    try {
        if (typeof navigator !== 'undefined') {
            return navigator.userAgent?.slice(0, 50) || 'Dispositivo';
        }
    } catch { }
    try {
        const os = require('os');
        return os.hostname() || 'Desktop';
    } catch { }
    return 'Dispositivo';
}

function getPlatform(): 'linux' | 'android' | 'unknown' {
    if (typeof (globalThis as any).Capacitor !== 'undefined') return 'android';
    if (typeof process !== 'undefined' && process.platform === 'linux') return 'linux';
    return 'unknown';
}

const SENTINEL_FILENAME = '.syncclient_device_id';

export interface DeviceIdentityResult {
    deviceId: string;
    deviceInfo: DeviceInfo;
    isNew: boolean;
}

/**
 * Obtiene o crea la identidad del dispositivo.
 *
 * Orden de búsqueda:
 * 1. DB local (sobrevive a reinicios de app)
 * 2. Drive (.syncclient_device_id) — sobrevive a reinstalaciones
 * 3. Nuevo UUID — primera ejecución
 *
 * @param db Backend de almacenamiento local
 * @param driveClient Cliente de Google Drive (debe tener métodos findFile, downloadText, uploadText)
 */
export async function getOrCreateDeviceId(
    db: IStorageBackend,
    driveClient?: {
        findFile: (name: string) => Promise<{ id: string } | null>;
        downloadText: (fileId: string) => Promise<string>;
        uploadText: (name: string, content: string) => Promise<{ id: string }>;
    }
): Promise<DeviceIdentityResult> {
    const now = Date.now();

    // 1. Intentar DB local
    const localInfo = db.getDeviceInfo('self');
    if (localInfo) {
        // Actualizar last_seen
        db.setDeviceInfo('self', { ...localInfo, last_seen: now });
        return {
            deviceId: localInfo.device_id,
            deviceInfo: localInfo,
            isNew: false
        };
    }

    // 2. Intentar recuperar de Drive (.syncclient_device_id)
    let deviceId: string | null = null;
    let deviceName = getDeviceName();
    let platform = getPlatform();

    if (driveClient) {
        try {
            const sentinel = await driveClient.findFile(SENTINEL_FILENAME);
            if (sentinel) {
                const content = await driveClient.downloadText(sentinel.id);
                const parsed = JSON.parse(content);
                deviceId = parsed.deviceId;
                if (parsed.name) deviceName = parsed.name;
                if (parsed.platform) platform = parsed.platform;
                logger.info('Recovered from Drive:', deviceId);
            }
        } catch { /* no existe aún o sin conexión */ }
    }

    // 3. Si no existe en ningún lado, crear nuevo
    const isNew = !deviceId;
    if (isNew) {
        deviceId = generateUUID();
        logger.info('New device ID created:', deviceId);

        // Persistir en Drive para futuras reinstalaciones
        if (driveClient) {
            try {
                await driveClient.uploadText(
                    SENTINEL_FILENAME,
                    JSON.stringify({
                        deviceId,
                        name: deviceName,
                        platform,
                        createdAt: new Date().toISOString()
                    })
                );
                logger.info('Sentinel saved to Drive');
            } catch {
                logger.warn('Could not save sentinel to Drive (offline?)');
            }
        }
    }

    // 4. Guardar en DB local  
    const finalDeviceId = deviceId!;
    const deviceInfo: DeviceInfo = {
        device_id: finalDeviceId,
        name: deviceName,
        platform,
        last_seen: now
    };
    db.setDeviceInfo('self', deviceInfo);

    return { deviceId: finalDeviceId, deviceInfo, isNew };
}