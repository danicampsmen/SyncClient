import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { syncService } from '../services/syncService';
import { Logger } from '../shared/browserLogger';

const logger = new Logger('PairConfigModal');

export function PairConfigModal({ pairId, isOpen, onClose, onUpdated }: { pairId: string; isOpen: boolean; onClose: () => void; onUpdated: () => void }) {
  const [conditions, setConditions] = useState<any>(null);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [filters, setFilters] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [newSchedule, setNewSchedule] = useState({ name: 'Schedule', interval_minutes: 60, enabled: true });
  const [newFilter, setNewFilter] = useState({ ruleType: 'glob', stringValue: '', isInclude: true });

  const load = async () => {
    setLoading(true);
    try {
      const [conds, scheds, filts] = await Promise.all([
        syncService.getPairConditions(pairId),
        syncService.getPairSchedules(pairId),
        syncService.getPairFilters(pairId),
      ]);
      setConditions(conds || { require_charging: 0, require_wifi: 0, min_battery_level: 0, block_on_roaming: 0, block_on_metered: 0, require_vpn: 0, allowed_ssids: '' });
      setSchedules(scheds || []);
      setFilters(filts || []);
    } catch (e) {
      logger.error('Error loading pair config:', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen]);

  const saveConditions = async () => {
    try {
      await syncService.setPairConditions(pairId, conditions);
      alert('Condiciones actualizadas');
      onUpdated();
    } catch (e) {
      alert('Error guardando condiciones');
    }
  };

  const addSchedule = async () => {
    try {
      await syncService.addPairSchedule(pairId, newSchedule);
      setNewSchedule({ name: 'Schedule', interval_minutes: 60, enabled: true });
      load();
      onUpdated();
    } catch (e) {
      alert('Error agregando schedule');
    }
  };

  const updateSchedule = async (schedule: any) => {
    try {
      await syncService.updatePairSchedule(pairId, schedule);
      load();
      onUpdated();
    } catch (e) {
      alert('Error actualizando schedule');
    }
  };

  const deleteSchedule = async (id: number) => {
    try {
      await syncService.deletePairSchedule(id);
      load();
      onUpdated();
    } catch (e) {
      alert('Error eliminando schedule');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">Configurar Par</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-white"><X size={20} /></button>
        </div>

        {loading ? (
          <p className="text-neutral-400 text-sm">Cargando...</p>
        ) : (
          <>
            <div className="space-y-4">
              <h4 className="text-sm font-bold text-white uppercase tracking-wider">Condiciones de Entorno</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex items-center justify-between p-3 bg-neutral-950/60 rounded-lg border border-neutral-800 cursor-pointer">
                  <span className="text-sm text-neutral-300">No sincronizar en roaming</span>
                  <input type="checkbox" checked={!!conditions?.block_on_roaming} onChange={e => setConditions({ ...conditions, block_on_roaming: e.target.checked ? 1 : 0 })} className="w-4 h-4 accent-purple-500 rounded" />
                </label>
                <label className="flex items-center justify-between p-3 bg-neutral-950/60 rounded-lg border border-neutral-800 cursor-pointer">
                  <span className="text-sm text-neutral-300">No sincronizar en medidos</span>
                  <input type="checkbox" checked={!!conditions?.block_on_metered} onChange={e => setConditions({ ...conditions, block_on_metered: e.target.checked ? 1 : 0 })} className="w-4 h-4 accent-purple-500 rounded" />
                </label>
                <label className="flex items-center justify-between p-3 bg-neutral-950/60 rounded-lg border border-neutral-800 cursor-pointer">
                  <span className="text-sm text-neutral-300">Requiere VPN</span>
                  <input type="checkbox" checked={!!conditions?.require_vpn} onChange={e => setConditions({ ...conditions, require_vpn: e.target.checked ? 1 : 0 })} className="w-4 h-4 accent-purple-500 rounded" />
                </label>
                <label className="flex items-center justify-between p-3 bg-neutral-950/60 rounded-lg border border-neutral-800 cursor-pointer">
                  <span className="text-sm text-neutral-300">Requiere Wi-Fi</span>
                  <input type="checkbox" checked={!!conditions?.require_wifi} onChange={e => setConditions({ ...conditions, require_wifi: e.target.checked ? 1 : 0 })} className="w-4 h-4 accent-purple-500 rounded" />
                </label>
                <label className="flex items-center justify-between p-3 bg-neutral-950/60 rounded-lg border border-neutral-800 cursor-pointer">
                  <span className="text-sm text-neutral-300">Requiere Cargador</span>
                  <input type="checkbox" checked={!!conditions?.require_charging} onChange={e => setConditions({ ...conditions, require_charging: e.target.checked ? 1 : 0 })} className="w-4 h-4 accent-purple-500 rounded" />
                </label>
                <div className="p-3 bg-neutral-950/60 rounded-lg border border-neutral-800">
                  <label className="block text-xs text-neutral-400 mb-1">Batería mínima (%)</label>
                  <input type="number" value={conditions?.min_battery_level || 0} onChange={e => setConditions({ ...conditions, min_battery_level: parseInt(e.target.value) || 0 })} className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-sm text-white" />
                </div>
                <div className="p-3 bg-neutral-950/60 rounded-lg border border-neutral-800 sm:col-span-2">
                  <label className="block text-xs text-neutral-400 mb-1">SSID permitidas (separadas por coma)</label>
                  <input type="text" value={conditions?.allowed_ssids || ''} onChange={e => setConditions({ ...conditions, allowed_ssids: e.target.value })} placeholder="Home_WiFi, Office_5G" className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-sm text-white" />
                </div>
              </div>
              <button onClick={saveConditions} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition-colors">Guardar Condiciones</button>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-bold text-white uppercase tracking-wider">Schedules</h4>
              <div className="space-y-2">
                {schedules.map(s => (
                  <div key={s.id} className="flex items-center justify-between p-3 bg-neutral-950/60 rounded-lg border border-neutral-800">
                    <div>
                      <div className="text-sm text-white font-medium">{s.name}</div>
                      <div className="text-xs text-neutral-400">Cada {s.interval_minutes} min | {s.enabled ? 'Activado' : 'Desactivado'}</div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <button onClick={() => updateSchedule({ ...s, enabled: s.enabled ? 0 : 1 })} className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs">{s.enabled ? 'Desactivar' : 'Activar'}</button>
                      <button onClick={() => deleteSchedule(s.id)} className="px-2 py-1 bg-red-600/20 hover:bg-red-600/35 text-red-300 rounded text-xs">Eliminar</button>
                    </div>
                  </div>
                ))}
                {schedules.length === 0 && <p className="text-xs text-neutral-500">No hay schedules configurados.</p>}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">Nombre</label>
                  <input type="text" value={newSchedule.name} onChange={e => setNewSchedule({ ...newSchedule, name: e.target.value })} className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-sm text-white w-40" />
                </div>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">Intervalo (min)</label>
                  <input type="number" value={newSchedule.interval_minutes} onChange={e => setNewSchedule({ ...newSchedule, interval_minutes: parseInt(e.target.value) || 60 })} className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-sm text-white w-24" />
                </div>
                <button onClick={addSchedule} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold">Agregar Schedule</button>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-bold text-white uppercase tracking-wider">Filtros</h4>
              <div className="space-y-2">
                {filters.map(f => (
                  <div key={f.id} className="flex items-center justify-between p-3 bg-neutral-950/60 rounded-lg border border-neutral-800">
                    <div>
                      <div className="text-sm text-white font-medium">{f.rule_type}: {f.string_value || f.numeric_value}</div>
                      <div className="text-xs text-neutral-400">{f.is_include ? 'Incluir' : 'Excluir'}</div>
                    </div>
                    <button onClick={async () => { await syncService.deletePairFilter(f.id); load(); onUpdated(); }} className="px-2 py-1 bg-red-600/20 hover:bg-red-600/35 text-red-300 rounded text-xs">Eliminar</button>
                  </div>
                ))}
                {filters.length === 0 && <p className="text-xs text-neutral-500">No hay filtros configurados.</p>}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <select value={newFilter.ruleType} onChange={e => setNewFilter({ ...newFilter, ruleType: e.target.value })} className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-sm text-white">
                  <option value="glob">Glob</option>
                  <option value="size">Tamaño</option>
                  <option value="mtime">Modificación</option>
                </select>
                <input type="text" value={newFilter.stringValue} onChange={e => setNewFilter({ ...newFilter, stringValue: e.target.value })} placeholder="Valor" className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-sm text-white" />
                <label className="flex items-center space-x-2 text-xs text-neutral-300">
                  <input type="checkbox" checked={newFilter.isInclude} onChange={e => setNewFilter({ ...newFilter, isInclude: e.target.checked })} className="w-4 h-4 accent-emerald-500 rounded" />
                  <span>Incluir</span>
                </label>
                <button onClick={async () => { await syncService.addPairFilter(pairId, { ...newFilter, pair_id: pairId, numeric_value: 0, created_at: Date.now() }); setNewFilter({ ruleType: 'glob', stringValue: '', isInclude: true }); load(); onUpdated(); }} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold">Agregar Filtro</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
