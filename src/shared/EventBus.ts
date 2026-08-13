/**
 * EventBus — Bus de eventos fuertemente tipado para desvincular los motores de sincronización
 * de los servicios de notificación, Express SSE y bridges de Electron/Capacitor.
 */

import { EventEmitter } from 'events';
import { SyncPair, SyncEvent, SyncProgress } from '../types';

export interface SyncEngineEvents {
  'sync:start': (pair: SyncPair) => void;
  'sync:progress': (pairId: string, progress: SyncProgress) => void;
  'sync:complete': (pairId: string) => void;
  'sync:error': (pairId: string, error: Error) => void;
  'event:added': (event: SyncEvent) => void;
  'token:refreshed': (accessToken: string) => void;
  'token:expired': () => void;
}

export class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  public on<K extends keyof SyncEngineEvents>(event: K, listener: SyncEngineEvents[K]): this {
    this.emitter.on(event, listener as (...args: any[]) => void);
    return this;
  }

  public off<K extends keyof SyncEngineEvents>(event: K, listener: SyncEngineEvents[K]): this {
    this.emitter.off(event, listener as (...args: any[]) => void);
    return this;
  }

  public emit<K extends keyof SyncEngineEvents>(event: K, ...args: Parameters<SyncEngineEvents[K]>): boolean {
    return this.emitter.emit(event, ...args);
  }
}

export const globalEventBus = new TypedEventBus();
