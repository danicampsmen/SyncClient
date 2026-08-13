/**
 * SyncAuditLog - Gestor de logs de auditoría a nivel de archivo individual (item-level).
 * Permite registrar y consultar descargas, subidas, exclusiones y errores por archivo.
 */

import { SyncItemLog } from './schema';

export interface DatabaseAdapter {
  exec(sql: string, params?: any[]): void;
  query<T = any>(sql: string, params?: any[]): T[];
}

export class SyncAuditLog {
  /**
   * Registra un evento de archivo en la tabla `sync_item_logs`.
   */
  public static logItemEvent(db: DatabaseAdapter, entry: Omit<SyncItemLog, 'id' | 'timestamp'> & { timestamp?: number }): void {
    const timestamp = entry.timestamp || Date.now();
    const sql = `
      INSERT INTO sync_item_logs (session_id, pair_id, rel_path, action, status, file_size, md5_hash, error_message, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;
    db.exec(sql, [
      entry.session_id,
      entry.pair_id,
      entry.rel_path,
      entry.action,
      entry.status,
      entry.file_size ?? null,
      entry.md5_hash ?? null,
      entry.error_message ?? null,
      timestamp,
    ]);
  }

  /**
   * Obtiene los logs de auditoría paginados para una pareja de carpetas.
   */
  public static getItemLogs(
    db: DatabaseAdapter,
    pairId: string,
    limit = 50,
    offset = 0
  ): SyncItemLog[] {
    const sql = `
      SELECT id, session_id, pair_id, rel_path, action, status, file_size, md5_hash, error_message, timestamp
      FROM sync_item_logs
      WHERE pair_id = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?;
    `;
    return db.query<SyncItemLog>(sql, [pairId, limit, offset]);
  }
}
