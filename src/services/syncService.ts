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
      const res = await backendFetch('/api/sync/pairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs })
      });
      if (!res.ok) {
        // Try to extract error details from response
        try {
          const json = await res.json();
          const msg = json?.error || JSON.stringify(json) || `HTTP ${res.status}`;
          throw new Error(msg);
        } catch (e) {
          throw new Error(`Failed to set pairs: HTTP ${res.status}`);
        }
      }
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

  public async cleanCloudTrash(): Promise<{ excludedFilesCleaned: number; patternsChecked: number } | null> {
    try {
      const res = await backendFetch('/api/sync/clean-cloud-trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        return data.result;
      }
    } catch (err) {
      logger.error(`Error al solicitar limpieza de exclusiones en nube: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  public async cancelCleanCloudTrash(): Promise<void> {
    if (this.isNative) {
      await this.ensureNativeEngine();
      this.localEngine?.cancelCleanCloudExcludedFiles();
    } else {
      await backendFetch('/api/sync/clean-cloud-trash/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch(err => logger.error(`Error al solicitar cancelación de exclusiones: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  public async cancelCleanDuplicates(pairId: string): Promise<void> {
    if (this.isNative) {
      await this.ensureNativeEngine();
      this.localEngine?.cancelCleanDuplicates(pairId);
    } else {
      await backendFetch('/api/sync/clean-duplicates/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      }).catch(err => logger.error(`Error al solicitar cancelación de dedup al backend: ${err instanceof Error ? err.message : String(err)}`));
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
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
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

  public async resolveConflict(conflictId: string, resolution: 'local' | 'remote' | 'rename' | 'overwrite_oldest' | 'overwrite_newest' | 'use_left' | 'use_right' | 'delete' | 'consider_equal') {
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

  public async getPairFilters(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.getPairFilters?.(pairId) || [];
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/filters`);
    if (!res.ok) throw new Error('Failed to fetch filters');
    const data = await res.json();
    return data.filters || [];
  }

  public async addPairFilter(pairId: string, filter: any) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.addPairFilter?.(pairId, filter);
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/filters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filter)
    });
    if (!res.ok) throw new Error('Failed to add filter');
    return await res.json();
  }

  public async deletePairFilter(filterId: number) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.deletePairFilter?.(filterId);
    }
    const res = await backendFetch(`/api/filters/${encodeURIComponent(filterId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete filter');
    return await res.json();
  }

  public async getPairConditions(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.getPairConditions?.(pairId) || null;
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/conditions`);
    if (!res.ok) throw new Error('Failed to fetch conditions');
    const data = await res.json();
    return data.conditions || null;
  }

  public async setPairConditions(pairId: string, conditions: any) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.setPairConditions?.({ pair_id: pairId, ...conditions });
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/conditions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairId, ...conditions })
    });
    if (!res.ok) throw new Error('Failed to update conditions');
    const data = await res.json();
    return data.conditions;
  }

  public async updatePair(pairId: string, data: Partial<SyncPair>) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.updatePair?.(pairId, data);
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to update pair');
    return await res.json();
  }

  public async getRecycleBinEntries(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.getRecycleBinEntries?.(pairId) || [];
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/recycle-bin`);
    if (!res.ok) throw new Error('Failed to fetch recycle bin');
    const data = await res.json();
    return data.entries || [];
  }

  public async restoreFromRecycleBin(pairId: string, relativePath: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.restoreFromRecycleBin?.(pairId, relativePath);
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/recycle-bin/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairId, relativePath })
    });
    if (!res.ok) throw new Error('Failed to restore from recycle bin');
    return await res.json();
  }

  public async emptyRecycleBin(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.emptyRecycleBin?.(pairId) || 0;
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/recycle-bin/empty`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to empty recycle bin');
    const data = await res.json();
    return data.count || 0;
  }

  public async getWebhooks(pairId?: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.getWebhooks?.(pairId) || [];
    }
    const url = pairId ? `/api/webhooks?pairId=${encodeURIComponent(pairId)}` : '/api/webhooks';
    const res = await backendFetch(url);
    if (!res.ok) throw new Error('Failed to fetch webhooks');
    const data = await res.json();
    return data.webhooks || [];
  }

  public async addWebhook(pairId: string, targetUrl: string, eventTrigger: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.addWebhook?.({ pair_id: pairId, target_url: targetUrl, event_trigger: eventTrigger || 'all' });
    }
    const res = await backendFetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairId, targetUrl, eventTrigger: eventTrigger || 'all' })
    });
    if (!res.ok) throw new Error('Failed to add webhook');
    return await res.json();
  }

  public async deleteWebhook(id: number) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.deleteWebhook?.(id);
    }
    const res = await backendFetch(`/api/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete webhook');
    return await res.json();
  }

  public async getPairSchedules(pairId: string) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.getPairSchedules?.(pairId) || [];
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/schedules`);
    if (!res.ok) throw new Error('Failed to fetch schedules');
    const data = await res.json();
    return data.schedules || [];
  }

  public async addPairSchedule(pairId: string, schedule: any) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.addPairSchedule?.(pairId, schedule);
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schedule)
    });
    if (!res.ok) throw new Error('Failed to add schedule');
    return await res.json();
  }

  public async updatePairSchedule(pairId: string, schedule: any) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.updatePairSchedule?.({ ...schedule, pair_id: pairId });
    }
    const res = await backendFetch(`/api/pairs/${encodeURIComponent(pairId)}/schedules/${encodeURIComponent(schedule.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schedule)
    });
    if (!res.ok) throw new Error('Failed to update schedule');
    const data = await res.json();
    return data.schedule;
  }

  public async deletePairSchedule(scheduleId: number) {
    if (this.isNative) {
      await this.ensureNativeEngine();
      return this.localEngine?.deletePairSchedule?.(scheduleId);
    }
    const res = await backendFetch(`/api/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete schedule');
    return await res.json();
  }

}

export const syncService = new SyncService();