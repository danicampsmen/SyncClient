import { Capacitor } from '@capacitor/core';
import { SyncPair, SyncSettings } from '../types';
import { backendFetch } from './backendSession';
import { Logger } from '../shared/browserLogger';

// FINDING-27 fix: usar browserLogger en lugar de console.* directo (R16)
const logger = new Logger('SyncService');

let SyncEngine: any = null;
let CapacitorFS: any = null;

async function loadNativeEngine() {
  if (!SyncEngine && Capacitor.isNativePlatform()) {
    const mod = await import('./SyncEngine');
    SyncEngine = mod.SyncEngine;
    const fsMod = await import('../utils/fileSystem');
    CapacitorFS = fsMod.CapacitorFS;
  }
  return SyncEngine;
}

class SyncService {
  private localEngine: any = null;
  private isNative = Capacitor.isNativePlatform();

  constructor() {
    if (this.isNative) {
      logger.info('Native engine requested; will be loaded lazily on first use.');
    }
  }

  private async ensureNativeEngine() {
    if (!this.isNative) return;
    if (!this.localEngine) {
      const Engine = await loadNativeEngine();
      if (!this.localEngine) {
        this.localEngine = new Engine(new CapacitorFS());
      }
    }
  }

  public async setToken(token: string | null, refreshToken?: string | null) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      this.localEngine?.setToken(token, refreshToken);
    } else {
      await backendFetch('/api/sync/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, refreshToken })
      }).catch(err => logger.error(`Error syncing token to backend: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  public async getStatus() {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.getStatus();
    } else {
      const res = await backendFetch('/api/sync/status');
      if (res.ok) return await res.json();
      throw new Error('Failed to fetch status from backend');
    }
  }

  public async setPairs(pairs: SyncPair[]) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      await this.localEngine?.setPairs(pairs);
    } else {
      await backendFetch('/api/sync/pairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs })
      });
    }
  }

  public async getLocalTree(pairId: string, relPath = ''): Promise<any> {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.getLocalTree(pairId, relPath);
    } else {
      return backendFetch(`/api/local/dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId, relPath })
      }).then(r => r.json());
    }
  }

  public async resetDatabase(): Promise<void> {
    if (this.isNative) {
      await this.ensureNativeEngine();
      await this.localEngine?.resetDatabase();
    } else {
      await backendFetch('/api/sync/reset-db', {
        method: 'POST'
      });
    }
  }

  public async toggleSync(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      await this.localEngine?.togglePairSync(pairId);
    } else {
      await backendFetch('/api/sync/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }

  public async forceSync(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      await this.localEngine?.forceSync(pairId);
    } else {
      await backendFetch('/api/sync/force', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }

  public async cleanDuplicates(pairId: string): Promise<{ localDeleted: number; localRenamed: number; remoteDeleted: number; remoteRenamed: number } | null> {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return (await this.localEngine?.cleanDuplicates(pairId)) || null;
    } else {
      try {
        const res = await backendFetch('/api/sync/clean-duplicates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairId })
        });
        if (res.ok) {
          const data = await res.json();
          return data.result;
        }
      } catch (err) {
        logger.error(`Error al solicitar limpieza de duplicados al backend: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }

  public async pauseSync(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      await this.localEngine?.pausePair(pairId);
    } else {
      await backendFetch('/api/sync/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }

  public async removePair(id: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      await this.localEngine?.removePair(id);
    } else {
      await backendFetch(`/api/sync/pair?id=${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
    }
  }

  public async updateSettings(settings: SyncSettings) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      await this.localEngine?.updateSettings(settings);
    } else {
      await backendFetch('/api/sync/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings })
      });
    }
  }

  public async dismissAlert(drivePath: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      logger.warn('dismissAlert no implementado en nativo');
    } else {
      await backendFetch('/api/sync/dismiss-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drivePath })
      });
    }
  }

  public async resolveConflict(conflictId: string, resolution: 'local' | 'remote' | 'rename') {
    if (this.isNative) {
      await this.ensureNativeEngine();
      // Fix #5: Implementar resolución de conflictos en nativo
      const conflict = this.localEngine?.getStatus().pendingConflicts?.find((c: any) => c.id === conflictId);
      if (!conflict) {
        logger.warn(`Conflicto no encontrado: ${conflictId}`);
        return null;
      }
      // Usar el backend HTTP como proxy para resolver el conflicto (el PC tiene acceso a Drive)
      return await backendFetch('/api/sync/resolve-conflict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conflictId, resolution })
      }).then(r => r.json()).catch(err => {
        logger.error(`Error resolviendo conflicto en PC: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    } else {
      await backendFetch('/api/sync/resolve-conflict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conflictId, resolution })
      });
    }
  }

  public async dehydrate(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      // Fix #5: Delegar al backend del PC para deshidratar (liberar espacio)
      logger.info('Delegando dehydrate al PC...');
      return await backendFetch('/api/sync/dehydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      }).then(r => r.json()).catch(err => {
        logger.error(`Error delegando dehydrate: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    } else {
      await backendFetch('/api/sync/dehydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }

  public async hydrate(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      // Fix #5: Delegar al backend del PC para hidratar (descargar offline)
      logger.info('Delegando hydrate al PC...');
      return await backendFetch('/api/sync/hydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      }).then(r => r.json()).catch(err => {
        logger.error(`Error delegando hydrate: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    } else {
      await backendFetch('/api/sync/hydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }
}

export const syncService = new SyncService();