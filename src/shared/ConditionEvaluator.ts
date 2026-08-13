/**
 * ConditionEvaluator - Evaluador de condiciones de entorno (Wi-Fi, Batería, Carga).
 * Permite omitir la sincronización automática si las condiciones de la tablet o PC no se cumplen.
 */

import { SyncPairConditions } from './schema';

export type ConditionStatus = 'sync_failed_illegal_network_state' | 'sync_failed_not_enough_space' | 'sync_failed_missing_write_permission'
  | 'sync_failed_missing_manage_files_permission' | 'sync_failed_no_account_configured' | 'sync_failed_analysis_error'
  | 'sync_failed_no_file_path_configured' | 'sync_failed_is_roaming' | 'sync_failed_ssid_not_allowed'
  | 'sync_failed_not_charging' | 'sync_failed_vpn_not_connected' | 'sync_ok_do_not_record'
  | 'sync_failed_metered_connection' | 'sync_failed_timeout' | 'sync_failed_generic';

export interface SystemStatus {
  isCharging?: boolean;
  batteryLevel?: number; // 0..100
  isWifiConnected?: boolean;
  currentSsid?: string;
  isRoaming?: boolean;
  isMetered?: boolean;
  isVpnConnected?: boolean;
}

export class ConditionEvaluator {
  public static evaluate(
    conditions: SyncPairConditions | null | undefined,
    status: SystemStatus,
    isManualTrigger = false
  ): { canSync: boolean; reason?: string; statusCode?: ConditionStatus } {
    if (!conditions) {
      return { canSync: true };
    }

    if (isManualTrigger) {
      return { canSync: true };
    }

    if (conditions.block_on_roaming === 1 && status.isRoaming) {
      return { canSync: false, reason: 'Red en roaming', statusCode: 'sync_failed_is_roaming' };
    }

    if (conditions.block_on_metered === 1 && status.isMetered) {
      return { canSync: false, reason: 'Conexión medida detectada', statusCode: 'sync_failed_metered_connection' };
    }

    if (conditions.require_vpn === 1 && !status.isVpnConnected) {
      return { canSync: false, reason: 'Se requiere VPN conectada', statusCode: 'sync_failed_vpn_not_connected' };
    }

    if (conditions.require_charging === 1 && !status.isCharging) {
      return { canSync: false, reason: 'El dispositivo no está conectado al cargador', statusCode: 'sync_failed_not_charging' };
    }

    if (conditions.min_battery_level > 0 && typeof status.batteryLevel === 'number') {
      if (status.batteryLevel < conditions.min_battery_level && !status.isCharging) {
        return {
          canSync: false,
          reason: `Nivel de batería (${status.batteryLevel}%) inferior al mínimo configurado (${conditions.min_battery_level}%)`,
          statusCode: 'sync_failed_not_charging'
        };
      }
    }

    if (conditions.require_wifi === 1 && status.isWifiConnected === false) {
      return { canSync: false, reason: 'No hay conexión Wi-Fi activa', statusCode: 'sync_failed_illegal_network_state' };
    }

    if (conditions.allowed_ssids && conditions.allowed_ssids.trim().length > 0) {
      const allowedList = conditions.allowed_ssids.split(',').map((s) => s.trim().toLowerCase());
      const currentSsid = (status.currentSsid || '').trim().toLowerCase();
      if (currentSsid && !allowedList.includes(currentSsid)) {
        return { canSync: false, reason: `La red Wi-Fi actual (${status.currentSsid}) no está en la lista de redes permitidas`, statusCode: 'sync_failed_ssid_not_allowed' };
      }
    }

    return { canSync: true };
  }
}
