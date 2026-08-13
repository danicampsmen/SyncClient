export type { SyncPairConditions, SyncWebhook, SyncPairFilter } from './shared/schema';
export type SyncDirection = 'bidirectional' | 'upload' | 'download';
import type { SyncPairConditions } from './shared/schema';
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'paused' | 'unauthenticated'
  | 'sync_failed_illegal_network_state' | 'sync_failed_not_enough_space' | 'sync_failed_missing_write_permission'
  | 'sync_failed_missing_manage_files_permission' | 'sync_failed_no_account_configured' | 'sync_failed_analysis_error'
  | 'sync_failed_no_file_path_configured' | 'sync_failed_is_roaming' | 'sync_failed_ssid_not_allowed'
  | 'sync_failed_not_charging' | 'sync_failed_vpn_not_connected' | 'sync_ok_do_not_record'
  | 'sync_failed_metered_connection' | 'sync_failed_timeout' | 'sync_failed_generic';
export type ConflictResolution = 'prompt' | 'local' | 'remote' | 'rename' | 'overwrite_oldest' | 'overwrite_newest' | 'use_left' | 'use_right' | 'delete' | 'consider_equal';
export type SyncMode = 'mirror' | 'streaming'; // mirror = Clonación Total 1:1 Offline; streaming = Unidad Virtual On-Demand
export type CloudCategory = 'computers' | 'shared'; // computers = 'Ordenadores' de Google Drive; shared = 'Mi Unidad' Colaborativa multi-dispositivo
export type EngineType = 'native' | 'rclone'; // <-- NUEVO: Selector de Motor Nativo V2 o Rclone
export type RcloneOp = 'bisync' | 'sync' | 'copy' | 'check'; // <-- NUEVO: Operación Rclone CLI
export type TransferPriority = 'default' | 'size_smallest' | 'size_largest' | 'modified_oldest' | 'modified_newest';
export type TransferSortCriterion = 'default' | 'size_smallest' | 'size_largest' | 'modified_oldest' | 'modified_newest';
export type EncryptionMode = 'none' | 'encrypted';
export type TransferFileAction = 'copy_rename_if_exists' | 'move_rename_if_exists';
export type AppSyncStartSource = 'unknown' | 'scheduled' | 'instant' | 'automation' | 'user' | 'deeplink' | 'tasker' | 'shortcut' | 'cli';
export type NetworkCondition = 'roaming' | 'metered' | 'ssid_mismatch' | 'vpn_required' | 'not_charging';

export interface SyncSettings {
  maxDownloadSpeed: number; // KB/s, 0 for unlimited
  maxUploadSpeed: number; // KB/s, 0 for unlimited
  conflictResolution: ConflictResolution;
  ignoredPatterns: string[];
  autoStart?: boolean;
  desktopNotifications?: boolean;
  encryptionMode?: EncryptionMode;
  transferPriority?: TransferPriority;
  transferSortCriterion?: TransferSortCriterion;
  transferFileAction?: TransferFileAction;
  requireWifi?: boolean;
  requireCharging?: boolean;
  blockOnRoaming?: boolean;
  blockOnMetered?: boolean;
  requireVpn?: boolean;
  allowedSsids?: string[];
  minBatteryLevel?: number;
  webhookUrl?: string;
  webhookEventTrigger?: 'all' | 'success' | 'error';
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
  engineType?: EngineType; // <-- 'native' (Drive API + SQLite) o 'rclone' (CLI Autónomo)
  rcloneOperation?: RcloneOp; // <-- 'bisync', 'sync' o 'copy'
  rcloneConfigPath?: string;
  deviceName?: string; // e.g., 'fayfer-pc' o 'Tableta Android StarNote'
  stubsCount?: number;
  hydratedSize?: number;
  progress?: SyncProgress | null;
  encryptionMode?: EncryptionMode;
  transferPriority?: TransferPriority;
  transferSortCriterion?: TransferSortCriterion;
  transferFileAction?: TransferFileAction;
  backupMode?: boolean;
  lastBackupTimestamp?: number;
  accountProperties?: Record<string, string>;
  conditions?: SyncPairConditions;
}

export interface SyncEvent {
  id: string;
  pairId: string;
  filename: string;
  action: 'uploaded' | 'downloaded' | 'deleted' | 'conflict' | 'info' | 'cleaned' | 'sync_start' | 'sync_end';
  timestamp: number;
  webViewLink?: string;
  details?: string;
  size?: number; // Tamaño del archivo en bytes
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
