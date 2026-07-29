import { Capacitor } from '@capacitor/core';
import { SyncEngine } from './SyncEngine';
import { CapacitorFS } from '../utils/fileSystem';
import { SyncPair, SyncSettings } from '../types';

class SyncService {
  private localEngine: SyncEngine | null = null;
  private isNative = Capacitor.isNativePlatform();

  constructor() {
    if (this.isNative) {
      console.log('[SyncService] Initializing Native Engine for Android');
      this.localEngine = new SyncEngine(new CapacitorFS());
    }
  }

  public async setToken(token: string | null) {
    if (this.isNative) {
      this.localEngine?.setToken(token);
    } else {
      await fetch('/api/sync/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      }).catch(err => console.error('Error syncing token to backend:', err));
    }
  }

  public async getStatus() {
    if (this.isNative) {
      return this.localEngine?.getStatus();
    } else {
      const res = await fetch('/api/sync/status');
      if (res.ok) return await res.json();
      throw new Error('Failed to fetch status from backend');
    }
  }

  public async setPairs(pairs: SyncPair[]) {
    if (this.isNative) {
      await this.localEngine?.setPairs(pairs);
    } else {
      await fetch('/api/sync/pairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs })
      });
    }
  }

  public async toggleSync(pairId: string) {
    if (this.isNative) {
      await this.localEngine?.togglePairSync(pairId);
    } else {
      await fetch('/api/sync/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }

  public async forceSync(pairId: string) {
    if (this.isNative) {
      await this.localEngine?.forceSync(pairId);
    } else {
      await fetch('/api/sync/force', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }

  public async cleanDuplicates(pairId: string): Promise<{ localDeleted: number; localRenamed: number; remoteDeleted: number; remoteRenamed: number } | null> {
    if (this.isNative) {
      return (await this.localEngine?.cleanDuplicates(pairId)) || null;
    } else {
      try {
        const res = await fetch('/api/sync/clean-duplicates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairId })
        });
        if (res.ok) {
          const data = await res.json();
          return data.result;
        }
      } catch (err) {
        console.error('Error al solicitar limpieza de duplicados al backend:', err);
      }
      return null;
    }
  }

  public async pauseSync(pairId: string) {
    if (this.isNative) {
      await this.localEngine?.pausePair(pairId);
    } else {
      await fetch('/api/sync/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }

  public async removePair(id: string) {
    if (this.isNative) {
      await this.localEngine?.removePair(id);
    } else {
      await fetch(`/api/sync/pair?id=${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
    }
  }

  public async updateSettings(settings: SyncSettings) {
    if (this.isNative) {
      await this.localEngine?.updateSettings(settings);
    } else {
      await fetch('/api/sync/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings })
      });
    }
  }

  public async dismissAlert(drivePath: string) {
    if (this.isNative) {
      // Not implemented for native yet
    } else {
      await fetch('/api/sync/dismiss-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drivePath })
      });
    }
  }

  public async resolveConflict(conflictId: string, resolution: 'local' | 'remote' | 'rename') {
     if (this.isNative) {
         // Not implemented for native yet
     } else {
         await fetch('/api/sync/resolve-conflict', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ conflictId, resolution })
         });
     }
  }

  public async dehydrate(pairId: string) {
    if (this.isNative) {
      // Not implemented for native yet
    } else {
      await fetch('/api/sync/dehydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }

  public async hydrate(pairId: string) {
    if (this.isNative) {
      // Not implemented for native yet
    } else {
      await fetch('/api/sync/hydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId })
      });
    }
  }
}

export const syncService = new SyncService();
