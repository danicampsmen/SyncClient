/**
 * VectorClock — Resolución determinística de conflictos para SyncClient v2.
 *
 * Inspirado en DynamoDB, Cassandra y Syncthing.
 * Un Vector Clock es un mapa { deviceId: counter } que permite determinar
 * sin ambigüedad si una versión es más nueva que otra, o si son concurrentes.
 */

export interface VectorClock {
    [deviceId: string]: number;
}

export class VectorClockManager {
    private static isClock(value: unknown): value is VectorClock {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        return Object.entries(value as Record<string, unknown>).every(([deviceId, count]) =>
            deviceId.length > 0 && typeof count === 'number' && Number.isFinite(count) && count >= 0
        );
    }

    /**
     * Compara dos vector clocks.
     * @returns 'a_newer' si A es estrictamente más nuevo,
     *          'b_newer' si B es estrictamente más nuevo,
     *          'concurrent' si son concurrentes (conflicto real),
     *          'equal' si son idénticos.
     */
    static compare(a: VectorClock, b: VectorClock): 'a_newer' | 'b_newer' | 'concurrent' | 'equal' {
        let aGreater = false;
        let bGreater = false;

        const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of allKeys) {
            const av = a[key] || 0;
            const bv = b[key] || 0;
            if (av > bv) aGreater = true;
            if (bv > av) bGreater = true;
            // Si ambos son mayores en alguna dimensión, son concurrentes
            if (aGreater && bGreater) return 'concurrent';
        }

        if (aGreater && !bGreater) return 'a_newer';
        if (bGreater && !aGreater) return 'b_newer';
        return 'equal';
    }

    /**
     * Incrementa el contador del dispositivo actual en 1.
     * Crea una copia (inmutable).
     */
    static increment(clock: VectorClock, deviceId: string): VectorClock {
        return { ...clock, [deviceId]: (clock[deviceId] || 0) + 1 };
    }

    /**
     * Merge de clocks para deduplicación.
     * Toma el MAX por cada dimensión de todos los clocks (ganador + perdedores),
     * luego incrementa el contador del dispositivo actual
     * (porque ESTE dispositivo hizo el merge).
     */
    static mergeForDedup(
        winner: VectorClock,
        losers: VectorClock[],
        deviceId: string
    ): VectorClock {
        const merged: VectorClock = { ...winner };

        for (const loser of losers) {
            for (const [id, count] of Object.entries(loser)) {
                merged[id] = Math.max(merged[id] || 0, count);
            }
        }

        // Incrementar nuestro contador porque hicimos el merge
        merged[deviceId] = (merged[deviceId] || 0) + 1;

        return merged;
    }

    /**
     * Serializa el vector clock a appProperties de Google Drive.
     * Drive appProperties tiene límite de 124 bytes por clave y 1024 bytes totales.
     * Un clock con 10 dispositivos ocupa ~200 bytes, así que usamos 2 claves.
     */
    static toAppProperties(clock: VectorClock): Record<string, string> {
        const json = JSON.stringify(clock);
        // Si el JSON es pequeño, una sola clave
        if (json.length <= 120) {
            return { syncclient_vc: json };
        }
        // Si es grande, partirlo en chunks
        const result: Record<string, string> = {};
        const chunkSize = 100;
        for (let i = 0; i < json.length; i += chunkSize) {
            result[`syncclient_vc${i / chunkSize}`] = json.slice(i, i + chunkSize);
        }
        return result;
    }

    /**
     * Deserializa el vector clock desde appProperties de Google Drive.
     */
    static fromAppProperties(props: Record<string, string>): VectorClock | null {
        // Intentar clave simple
        if (props.syncclient_vc) {
            try {
                const parsed = JSON.parse(props.syncclient_vc);
                if (VectorClockManager.isClock(parsed)) return parsed;
            } catch { /* corrupto, intentar chunks */ }
        }

        // Intentar reconstruir desde chunks
        const chunks: string[] = [];
        for (let i = 0; ; i++) {
            const chunk = props[`syncclient_vc${i}`];
            if (!chunk) break;
            chunks.push(chunk);
        }
        if (chunks.length > 0) {
            try {
                const parsed = JSON.parse(chunks.join(''));
                if (VectorClockManager.isClock(parsed)) return parsed;
            } catch { /* corrupto */ }
        }

        return null;
    }

    /**
     * Dual-Source: recuperar vector clock desde Drive appProperties (canónico)
     * o desde SQLite local (respaldo).
     *
     * Si appProperties está vacío (borrado por cliente externo como rclone),
     * se recupera de dbState y se marca para re-escribir en Drive.
     */
    static resolveFromSources(
        driveProps: Record<string, string> | null | undefined,
        dbVectorClock: string | null | undefined,
        currentDeviceId: string
    ): { clock: VectorClock; needsDriveSync: boolean } {
        // 1. Intentar fuente canónica (Drive)
        if (driveProps) {
            const clock = VectorClockManager.fromAppProperties(driveProps);
            if (clock) return { clock, needsDriveSync: false };
        }

        // 2. Recuperar de DB local
        if (dbVectorClock) {
            try {
                const clock = JSON.parse(dbVectorClock);
                if (VectorClockManager.isClock(clock)) {
                    return { clock, needsDriveSync: true }; // re-escribir en Drive
                }
            } catch { /* corrupto */ }
        }

        // 3. Inicializar (primer sync o recuperación total)
        return {
            clock: { [currentDeviceId]: 1 },
            needsDriveSync: true
        };
    }

    /**
     * Convierte un VectorClock a string para almacenar en la DB.
     */
    static toString(clock: VectorClock): string {
        return JSON.stringify(clock);
    }

    /**
     * Convierte un string de la DB a VectorClock.
     */
    static fromString(str: string): VectorClock {
        try {
            const clock = JSON.parse(str);
            return VectorClockManager.isClock(clock) ? clock : {};
        } catch {
            return {};
        }
    }
}