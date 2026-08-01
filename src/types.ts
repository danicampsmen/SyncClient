export type SyncDirection = 'bidirectional' | 'upload' | 'download';
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'paused' | 'unauthenticated';
export type ConflictResolution = 'prompt' | 'local' | 'remote' | 'rename';
export type SyncMode = 'mirror' | 'streaming'; // mirror = Clonación Total 1:1 Offline; streaming = Unidad Virtual On-Demand
export type CloudCategory = 'computers' | 'shared'; // computers = 'Ordenadores' de Google Drive; shared = 'Mi Unidad' Colaborativa multi-dispositivo

export interface SyncSettings {
  maxDownloadSpeed: number; // KB/s, 0 for unlimited
  maxUploadSpeed: number; // KB/s, 0 for unlimited
  conflictResolution: ConflictResolution;
  ignoredPatterns: string[];
  autoStart?: boolean;
  desktopNotifications?: boolean;
}

export interface ExternalDriveAlert {
  path: string;
  name: string;
  detectedAt: number;
}

export interface GoogleAccountProfile {
  accountId: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  active: boolean;
}

export interface VirtualStub {
  id: string; // ID en Google Drive
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: number;
  webViewLink?: string;
  streamUrl?: string;
  isStub: true;
}

export interface SyncProgress {
  currentFile: string;
  totalFiles: number;
  currentFileIndex: number;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number; // 0 - 100
  action: 'subiendo' | 'descargando' | 'comprobando' | 'deduplicando' | 'completado' | 'espera';
}

export interface SyncPair {
  id: string;
  localPath: string;
  remotePath: string;
  direction: SyncDirection;
  status: SyncStatus;
  lastSynced: number | null;
  accountId?: string;
  driveId?: string;
  syncMode?: SyncMode; // Por defecto 'mirror' (Duplicado) para máxima velocidad offline
  cloudCategory?: CloudCategory; // 'computers' para ordenar en Ordenadores/[equipo], 'shared' para carpetas colaborativos
  deviceName?: string; // e.g., 'fayfer-pc' o 'Tableta Android StarNote'
  stubsCount?: number;
  hydratedSize?: number;
  progress?: SyncProgress | null;
}

export interface SyncEvent {
  id: string;
  pairId: string;
  filename: string;
  action: 'uploaded' | 'downloaded' | 'deleted' | 'conflict' | 'info' | 'cleaned' | 'sync_start' | 'sync_end';
  timestamp: number;
  webViewLink?: string;
  details?: string;
}

export interface PendingConflict {
  id: string;
  pairId: string;
  localPath: string;
  relativePath: string;
  remoteFileId: string;
  remoteFileName: string;
  reason: string | null;
  baseHash: string | null;
  localHash: string | null;
  remoteHash: string | null;
  localSize: number | null;
  localMtime: number;
  remoteSize: number | null;
  remoteMtime: number;
  resolved: boolean;
  timestamp: number;
}
