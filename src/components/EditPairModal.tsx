import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { X, Plus, Trash2 } from 'lucide-react';
import { SyncPair, EncryptionMode, TransferSortCriterion, TransferPriority, TransferFileAction } from '../types';
import { syncService } from '../services/syncService';

interface EditPairModalProps {
  pair: SyncPair;
  onSave: (p: SyncPair) => void;
  onClose: () => void;
}

interface Schedule {
  id: number;
  pair_id: string;
  enabled: number;
  trigger_on_boot: number;
  trigger_on_network_change: number;
  wifi_ssids: string | null;
  require_charging: number;
  interval_minutes: number;
  created_at: number;
}

interface Filter {
  id: number;
  pair_id: string;
  type: string;
  pattern: string;
  action: string;
}

export function EditPairModal({ pair, onSave, onClose }: EditPairModalProps) {
  const [encryptionMode, setEncryptionMode] = useState<EncryptionMode>(pair.encryptionMode || 'none');
  const [transferSortCriterion, setTransferSortCriterion] = useState<TransferSortCriterion>(pair.transferSortCriterion || 'default');
  const [transferPriority, setTransferPriority] = useState<TransferPriority>(pair.transferPriority || 'default');
  const [transferFileAction, setTransferFileAction] = useState<TransferFileAction>(pair.transferFileAction || 'copy_rename_if_exists');
  const [backupMode, setBackupMode] = useState<boolean>(pair.backupMode || false);
  const [conditions, setConditions] = useState({
    require_wifi: pair.conditions?.require_wifi ? 1 : 0,
    require_charging: pair.conditions?.require_charging ? 1 : 0,
    min_battery_level: pair.conditions?.min_battery_level || 0,
    allowed_ssids: pair.conditions?.allowed_ssids || '',
    block_on_roaming: pair.conditions?.block_on_roaming ? 1 : 0,
    block_on_metered: pair.conditions?.block_on_metered ? 1 : 0,
    require_vpn: pair.conditions?.require_vpn ? 1 : 0,
  });
  const [saving, setSaving] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [loadingSchedules, setLoadingSchedules] = useState(false);
  const [loadingFilters, setLoadingFilters] = useState(false);
  const [newSchedule, setNewSchedule] = useState({ enabled: 1, trigger_on_boot: 0, trigger_on_network_change: 0, wifi_ssids: '', require_charging: 0, interval_minutes: 60 });
  const [newFilter, setNewFilter] = useState({ type: 'exclude', pattern: '', action: 'exclude' });

  useEffect(() => {
    loadSchedules();
    loadFilters();
  }, []);

  const loadSchedules = async () => {
    setLoadingSchedules(true);
    try {
      const data = await syncService.getPairSchedules(pair.id);
      setSchedules(data);
    } catch (e) {
      console.error('Error loading schedules:', e);
    } finally {
      setLoadingSchedules(false);
    }
  };

  const loadFilters = async () => {
    setLoadingFilters(true);
    try {
      const data = await syncService.getPairFilters(pair.id);
      setFilters(data);
    } catch (e) {
      console.error('Error loading filters:', e);
    } finally {
      setLoadingFilters(false);
    }
  };

  const addSchedule = async () => {
    try {
      const schedule = await syncService.addPairSchedule(pair.id, { ...newSchedule, pair_id: pair.id });
      setSchedules([...schedules, schedule]);
      setNewSchedule({ enabled: 1, trigger_on_boot: 0, trigger_on_network_change: 0, wifi_ssids: '', require_charging: 0, interval_minutes: 60 });
    } catch (e) {
      alert('Error al agregar schedule');
    }
  };

  const deleteSchedule = async (scheduleId: number) => {
    try {
      await syncService.deletePairSchedule(scheduleId);
      setSchedules(schedules.filter(s => s.id !== scheduleId));
    } catch (e) {
      alert('Error al eliminar schedule');
    }
  };

  const addFilter = async () => {
    try {
      const filter = await syncService.addPairFilter(pair.id, { ...newFilter, pair_id: pair.id });
      setFilters([...filters, filter]);
      setNewFilter({ type: 'exclude', pattern: '', action: 'exclude' });
    } catch (e) {
      alert('Error al agregar filtro');
    }
  };

  const deleteFilter = async (filterId: number) => {
    try {
      await syncService.deletePairFilter(filterId);
      setFilters(filters.filter(f => f.id !== filterId));
    } catch (e) {
      alert('Error al eliminar filtro');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated: SyncPair = {
        ...pair,
        encryptionMode,
        transferSortCriterion,
        transferPriority,
        transferFileAction,
        backupMode,
        conditions: {
          require_wifi: conditions.require_wifi,
          require_charging: conditions.require_charging,
          min_battery_level: conditions.min_battery_level,
          allowed_ssids: conditions.allowed_ssids || undefined,
          block_on_roaming: conditions.block_on_roaming,
          block_on_metered: conditions.block_on_metered,
          require_vpn: conditions.require_vpn,
        } as any,
      };

      await syncService.setPairConditions(pair.id, updated.conditions);
      await syncService.updatePair(pair.id, {
        encryptionMode: updated.encryptionMode,
        transferSortCriterion: updated.transferSortCriterion,
        transferPriority: updated.transferPriority,
        transferFileAction: updated.transferFileAction,
        backupMode: updated.backupMode,
      });
      await onSave(updated);
      onClose();
    } catch (e) {
      alert('Error al guardar cambios: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-neutral-900 border border-neutral-700 rounded-2xl p-6 shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-bold text-white">Editar Par: {pair.localPath}</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Encriptación */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Encriptación Cliente-Side</h4>
            <select
              value={encryptionMode}
              onChange={e => setEncryptionMode(e.target.value as EncryptionMode)}
              className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="none">Sin encriptación (estándar)</option>
              <option value="encrypted">Encriptado (AES-256-GCM)</option>
            </select>
            <p className="text-[10px] text-neutral-500 mt-1">Los archivos se encriptan antes de subir y se desencriptan al descargar.</p>
          </div>

          {/* Orden de Transferencia */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Orden de Transferencia</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Criterio de Orden</label>
                <select
                  value={transferSortCriterion}
                  onChange={e => setTransferSortCriterion(e.target.value as TransferSortCriterion)}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="default">Por defecto (profundidad)</option>
                  <option value="size_smallest">Archivos más pequeños primero</option>
                  <option value="size_largest">Archivos más grandes primero</option>
                  <option value="modified_oldest">Modificados hace más tiempo</option>
                  <option value="modified_newest">Modificados recientemente</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Prioridad</label>
                <select
                  value={transferPriority}
                  onChange={e => setTransferPriority(e.target.value as TransferPriority)}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="default">Normal</option>
                  <option value="size_smallest">Priorizar pequeños</option>
                  <option value="size_largest">Priorizar grandes</option>
                  <option value="modified_oldest">Priorizar antiguos</option>
                  <option value="modified_newest">Priorizar nuevos</option>
                </select>
              </div>
            </div>
          </div>

          {/* Acción ante conflictos de nombre */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Acción ante Conflictos de Nombre</h4>
            <select
              value={transferFileAction}
              onChange={e => setTransferFileAction(e.target.value as TransferFileAction)}
              className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="copy_rename_if_exists">Copiar y renombrar si existe</option>
              <option value="move_rename_if_exists">Mover y renombrar si existe</option>
            </select>
          </div>

          {/* Modo Backup */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Modo Backup</h4>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-neutral-300">Mantener copias de seguridad en .syncclient-backups</span>
              <input
                type="checkbox"
                checked={backupMode}
                onChange={e => setBackupMode(e.target.checked)}
                className="w-4 h-4 accent-blue-500 rounded"
              />
            </label>
          </div>

          {/* Condiciones de Red y Sistema */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Condiciones de Red y Sistema</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-neutral-300">Requiere Wi-Fi</span>
                <input type="checkbox" checked={!!conditions.require_wifi} onChange={e => setConditions({...conditions, require_wifi: e.target.checked ? 1 : 0})} className="w-4 h-4 accent-blue-500 rounded" />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-neutral-300">Requiere Cargador</span>
                <input type="checkbox" checked={!!conditions.require_charging} onChange={e => setConditions({...conditions, require_charging: e.target.checked ? 1 : 0})} className="w-4 h-4 accent-blue-500 rounded" />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-neutral-300">Bloquear en Roaming</span>
                <input type="checkbox" checked={!!conditions.block_on_roaming} onChange={e => setConditions({...conditions, block_on_roaming: e.target.checked ? 1 : 0})} className="w-4 h-4 accent-blue-500 rounded" />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-neutral-300">Bloquear en Medida</span>
                <input type="checkbox" checked={!!conditions.block_on_metered} onChange={e => setConditions({...conditions, block_on_metered: e.target.checked ? 1 : 0})} className="w-4 h-4 accent-blue-500 rounded" />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-neutral-300">Requiere VPN</span>
                <input type="checkbox" checked={!!conditions.require_vpn} onChange={e => setConditions({...conditions, require_vpn: e.target.checked ? 1 : 0})} className="w-4 h-4 accent-blue-500 rounded" />
              </label>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Batería mínima (%)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={conditions.min_battery_level}
                  onChange={e => setConditions({...conditions, min_battery_level: parseInt(e.target.value) || 0})}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-white"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-neutral-400 mb-1">SSIDs Permitidos (separados por coma)</label>
                <input
                  type="text"
                  value={conditions.allowed_ssids}
                  onChange={e => setConditions({...conditions, allowed_ssids: e.target.value})}
                  placeholder="RedCasa, RedOficina"
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
                />
              </div>
            </div>
          </div>

          {/* Schedules */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Schedules</h4>
            <div className="space-y-2 mb-3">
              {schedules.map(s => (
                <div key={s.id} className="flex items-center justify-between bg-neutral-900/60 border border-neutral-800 rounded-lg px-3 py-2">
                  <div>
                    <span className="text-xs text-white">Cada {s.interval_minutes} min</span>
                    <span className="text-[10px] text-neutral-500 ml-2">{s.enabled ? 'Activo' : 'Pausado'}</span>
                  </div>
                  <button onClick={() => deleteSchedule(s.id)} className="text-neutral-400 hover:text-red-400">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {schedules.length === 0 && <p className="text-xs text-neutral-500">No hay schedules configurados.</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
              <input
                type="number"
                value={newSchedule.interval_minutes}
                onChange={e => setNewSchedule({ ...newSchedule, interval_minutes: parseInt(e.target.value) || 0 })}
                placeholder="Intervalo (min)"
                className="bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-white"
              />
              <label className="flex items-center space-x-2 text-xs text-neutral-300">
                <input type="checkbox" checked={!!newSchedule.enabled} onChange={e => setNewSchedule({ ...newSchedule, enabled: e.target.checked ? 1 : 0 })} />
                <span>Activo</span>
              </label>
              <label className="flex items-center space-x-2 text-xs text-neutral-300">
                <input type="checkbox" checked={!!newSchedule.require_charging} onChange={e => setNewSchedule({ ...newSchedule, require_charging: e.target.checked ? 1 : 0 })} />
                <span>Requiere cargador</span>
              </label>
            </div>
            <button onClick={addSchedule} className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-white text-xs rounded-lg border border-neutral-700 flex items-center space-x-1">
              <Plus size={14} />
              <span>Agregar Schedule</span>
            </button>
          </div>

          {/* Filters */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Filtros</h4>
            <div className="space-y-2 mb-3">
              {filters.map(f => (
                <div key={f.id} className="flex items-center justify-between bg-neutral-900/60 border border-neutral-800 rounded-lg px-3 py-2">
                  <div>
                    <span className="text-xs text-white font-mono">{f.pattern}</span>
                    <span className="text-[10px] text-neutral-500 ml-2">{f.type} / {f.action}</span>
                  </div>
                  <button onClick={() => deleteFilter(f.id)} className="text-neutral-400 hover:text-red-400">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {filters.length === 0 && <p className="text-xs text-neutral-500">No hay filtros configurados.</p>}
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mb-2">
              <input
                type="text"
                value={newFilter.pattern}
                onChange={e => setNewFilter({ ...newFilter, pattern: e.target.value })}
                placeholder="Patrón (ej: *.tmp)"
                className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
              />
              <select
                value={newFilter.type}
                onChange={e => setNewFilter({ ...newFilter, type: e.target.value, action: e.target.value })}
                className="bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-white"
              >
                <option value="exclude">Excluir</option>
                <option value="include">Incluir</option>
              </select>
            </div>
            <button onClick={addFilter} className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-white text-xs rounded-lg border border-neutral-700 flex items-center space-x-1">
              <Plus size={14} />
              <span>Agregar Filtro</span>
            </button>
          </div>

          {/* Acciones */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-neutral-800">
            <button type="button" onClick={onClose} className="px-5 py-2.5 text-sm font-bold text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-xl transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-50">
              {saving ? 'Guardando...' : 'Guardar Cambios'}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
