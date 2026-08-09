import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  FolderSync, Cloud, HardDrive, Activity, Settings,
  ArrowLeftRight, Upload, Download, RefreshCw, Plus,
  Play, Pause, Trash2, CheckCircle2, AlertCircle, Clock,
  LogOut, LogIn, Folder, ShieldAlert, X, Search, Link, Copy,
  Check, Usb, BatteryWarning, WifiOff, Bell, Power, Filter, Tag, Layers, Users
} from 'lucide-react';
import { SyncPair, SyncEvent, SyncDirection, SyncSettings, PendingConflict, ExternalDriveAlert, SyncMode, CloudCategory, SyncProgress, SyncStatus, EngineType, RcloneOp } from '../types';
import { VFSBridge } from '../utils/vfsBridge';
import { initAuth, googleSignIn, logout } from '../auth';
import { listFolders, createFolder, DriveFile } from '../drive';
import { User } from 'firebase/auth';
type UserProfile = User;

type Tab = 'overview' | 'folders' | 'activity' | 'settings';

import { syncService } from '../services/syncService';
import { Logger } from '../shared/browserLogger';

const logger = new Logger('SyncApp');

export default function SyncApp() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [pairs, setPairs] = useState<SyncPair[]>([]);
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [pendingConflicts, setPendingConflicts] = useState<PendingConflict[]>([]);
  const [backendAuthenticated, setBackendAuthenticated] = useState<boolean>(true);
  const [settings, setSettings] = useState<SyncSettings>({
    maxDownloadSpeed: 0,
    maxUploadSpeed: 0,
    conflictResolution: 'prompt',
    ignoredPatterns: [],
  });
  const [needsAuth, setNeedsAuth] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const isLoggingInRef = useRef(false); // Guarda síncrona para prevenir doble submit
  const [loginError, setLoginError] = useState<string | null>(null);
  const [externalDrives, setExternalDrives] = useState<ExternalDriveAlert[]>([]);
  const [powerSavingMode, setPowerSavingMode] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string>('default');
  const [isCleaningCloudJunk, setIsCleaningCloudJunk] = useState(false);

  const pendingConflictsRef = useRef(pendingConflicts);
  pendingConflictsRef.current = pendingConflicts;
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [uploadSpeed, setUploadSpeed] = useState<number>(0);
  const [downloadSpeed, setDownloadSpeed] = useState<number>(0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);

  const lastProgressRef = useRef<{ bytes: number; time: number; uploadBytes?: number; downloadBytes?: number }>({ bytes: 0, time: Date.now() });
  const speedHistoryRef = useRef<{ time: number; bytes: number }[]>([]);

  const fetchBackendStatus = async () => {
    try {
      const data = await syncService.getStatus();
      if (data) {
        // FASE 4: Disparador de Notificaciones Nativas
        if (data.settings?.desktopNotifications !== false) {
          const electronBridge = (window as any).electronBridge;
          if (electronBridge?.showNotification) {
            // Notificar si una sincronización pesada acaba de terminar
            data.pairs.forEach((newPair: SyncPair) => {
              const oldPair = pairsRef.current.find(p => p.id === newPair.id);
              if (oldPair && oldPair.status === 'syncing' && newPair.status === 'idle') {
                electronBridge.showNotification('Sincronización Completada', `La carpeta ${newPair.localPath.split('/').pop()} está al día.`);
              }
            });

            // Notificar si ha aparecido un conflicto nuevo
            if (data.pendingConflicts && data.pendingConflicts.length > pendingConflictsRef.current.length) {
              electronBridge.showNotification('⚠️ Conflicto Detectado', 'Archivos modificados simultáneamente. Se requiere tu revisión.');
            }
          }
        }

        const fetchedPairs: SyncPair[] = data.pairs || [];
        setPairs(fetchedPairs);
        setEvents(data.events || []);
        if (data.settings) setSettings(data.settings);
        if (data.pendingConflicts) setPendingConflicts(data.pendingConflicts);
        if (typeof data.authenticated === 'boolean') setBackendAuthenticated(data.authenticated);
        if (data.detectedExternalDrives) setExternalDrives(data.detectedExternalDrives);

        // Calcular velocidad de subida / bajada en tiempo real
        const now = Date.now();
        const syncingPairs = fetchedPairs.filter(p => p.status === 'syncing' || p.progress);
        // Muestreo de velocidad en ventana flotante suave (rolling window)
        if (syncingPairs.length > 0) {
          const uploadingPairs = syncingPairs.filter(p => p.progress?.action === 'subiendo');
          const downloadingPairs = syncingPairs.filter(p => p.progress?.action === 'descargando');

          const uploadBytes = uploadingPairs.reduce((s, p) => s + (p.progress?.bytesTransferred || 0), 0);
          const downloadBytes = downloadingPairs.reduce((s, p) => s + (p.progress?.bytesTransferred || 0), 0);

          if (!lastProgressRef.current.time) {
            lastProgressRef.current = { bytes: 0, time: now, uploadBytes, downloadBytes };
          } else {
            const dtWindow = (now - lastProgressRef.current.time) / 1000;
            if (dtWindow >= 0.8) {
              const uDelta = Math.max(0, uploadBytes - (lastProgressRef.current.uploadBytes || 0));
              const dDelta = Math.max(0, downloadBytes - (lastProgressRef.current.downloadBytes || 0));

              setUploadSpeed(Math.round(uDelta / dtWindow));
              setDownloadSpeed(Math.round(dDelta / dtWindow));

              lastProgressRef.current = { bytes: uploadBytes + downloadBytes, time: now, uploadBytes, downloadBytes };
            }
          }
        } else {
          setUploadSpeed(0);
          setDownloadSpeed(0);
          lastProgressRef.current = { bytes: 0, time: now, uploadBytes: 0, downloadBytes: 0 };
        }

        // Calcular ETA (Tiempo estimado) con ventana de 60 segundos
        const totalTransferred = syncingPairs.reduce((sum, p) => sum + (p.progress?.bytesTransferred || 0), 0);
        const totalBytes = syncingPairs.reduce((sum, p) => sum + (p.progress?.totalBytes || 0), 0);

        if (syncingPairs.length > 0 && totalBytes > 0) {
          speedHistoryRef.current.push({ time: now, bytes: totalTransferred });
          // Filtrar muestras más antiguas de 60 segundos
          speedHistoryRef.current = speedHistoryRef.current.filter(sample => now - sample.time <= 60000);
          
          if (speedHistoryRef.current.length > 1) {
            const oldest = speedHistoryRef.current[0];
            const timeDiff = (now - oldest.time) / 1000;
            if (timeDiff >= 5) { // Esperar al menos 5 segundos de datos estables
              const bytesDiff = Math.max(0, totalTransferred - oldest.bytes);
              const avgSpeed = bytesDiff / timeDiff;
              
              if (avgSpeed > 0) {
                const remainingBytes = Math.max(0, totalBytes - totalTransferred);
                setEtaSeconds(Math.round(remainingBytes / avgSpeed));
              } else {
                setEtaSeconds(null);
              }
            } else {
              setEtaSeconds(null);
            }
          } else {
            setEtaSeconds(null);
          }
        } else {
          speedHistoryRef.current = [];
          setEtaSeconds(null);
        }

        // Actualizar icono e indicador en segundo plano (System Tray)
        const electronBridge = (window as any).electronBridge;
        if (electronBridge?.updateTray) {
          const isSyncing = syncingPairs.length > 0;
          const currentFile = syncingPairs.find(p => p.progress?.currentFile)?.progress?.currentFile || '';
          const totalTransferred = syncingPairs.reduce((sum, p) => sum + (p.progress?.bytesTransferred || 0), 0);
          const totalBytes = syncingPairs.reduce((sum, p) => sum + (p.progress?.totalBytes || 0), 0);
          const totalFiles = syncingPairs.reduce((sum, p) => sum + (p.progress?.currentFileIndex || 0), 0);
          const totalAllFiles = syncingPairs.reduce((sum, p) => sum + (p.progress?.totalFiles || 0), 0);
          const percentage = isSyncing
            ? (totalBytes > 0
                ? Math.min(99, Math.round((totalTransferred / totalBytes) * 100))
                : (totalAllFiles > 0
                    ? Math.max(1, Math.round((totalFiles / totalAllFiles) * 100))
                    : 5))
            : 100;

          const hasUpload = syncingPairs.some(p => p.progress?.action === 'subiendo');
          const hasDownload = syncingPairs.some(p => p.progress?.action === 'descargando');
          const isPaused = fetchedPairs.length > 0 && fetchedPairs.some(p => p.status === 'paused');

          electronBridge.updateTray({
            isSyncing,
            percentage,
            uploadSpeed: hasUpload ? uploadSpeed : 0,
            downloadSpeed: hasDownload ? downloadSpeed : 0,
            isOnline,
            pingMs,
            activePairsCount: fetchedPairs.length,
            conflictsCount: data.pendingConflicts?.length || 0,
            currentFile,
            isPaused,
            pairs: fetchedPairs
          });
        }
      }
    } catch (err) {
      logger.error(`Error al consultar estado del motor: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const checkPing = async () => {
      const start = performance.now();
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          setPingMs(Math.round(performance.now() - start));
          setIsOnline(true);
        }
      } catch {
        setPingMs(null);
        setIsOnline(false);
      }
    };

    checkPing();
    const pingInterval = setInterval(checkPing, 4000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(pingInterval);
    };
  }, []);

  const pairsRef = useRef(pairs);
  pairsRef.current = pairs;

  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let isCancelled = false;

    const poll = async () => {
      if (isCancelled) return;
      await fetchBackendStatus();
      if (isCancelled) return;
      const isSyncing = pairsRef.current.some(p => p.status === 'syncing' || !!p.progress);
      const nextDelay = isSyncing ? 800 : 2500; // Refresco en tiempo real durante transferencias
      timerId = setTimeout(poll, nextDelay);
    };

    poll();

    return () => {
      isCancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  useEffect(() => {
    const electronBridge = (window as any).electronBridge;
    if (electronBridge?.onTrayAction) {
      const handler = async (action: any) => {
        if (typeof action === 'string') {
          if (action === 'force-sync-all') {
            pairsRef.current.forEach(p => forceSync(p.id));
          } else if (action === 'resolve-conflicts-mtime') {
            pendingConflictsRef.current.forEach(c => {
              const isLocalNewer = c.localMtime >= c.remoteMtime;
              resolveConflict(c.id, isLocalNewer ? 'local' : 'remote');
            });
          } else if (action === 'clean-duplicates-all') {
            for (const p of pairsRef.current) {
              await syncService.cleanDuplicates(p.id);
            }
            fetchBackendStatus();
          } else if (action === 'clean-cloud-trash') {
            if (typeof handleCleanCloudTrash === 'function') {
              handleCleanCloudTrash();
            }
          } else if (action === 'toggle-pause-sync') {
            const hasActivePairs = pairsRef.current.some(p => p.status !== 'paused');
            for (const p of pairsRef.current) {
              if (hasActivePairs) {
                if (p.status !== 'paused') await syncService.pauseSync(p.id);
              } else {
                if (p.status === 'paused') await syncService.pauseSync(p.id);
              }
            }
            fetchBackendStatus();
          } else if (action === 'open-conflicts') {
            setActiveTab('overview');
          }
        } else if (typeof action === 'object' && action !== null) {
          if (action.type === 'force-sync-pair') {
            forceSync(action.pairId);
          } else if (action.type === 'pause-pair') {
            pauseSync(action.pairId);
          } else if (action.type === 'clean-dedup-pair') {
            const pair = pairsRef.current.find(p => p.id === action.pairId);
            if (pair) await syncService.cleanDuplicates(pair.id);
            fetchBackendStatus();
          }
        }
      };
      electronBridge.onTrayAction(handler);
      // Cleanup: desregistrar al desmontar para evitar múltiples listeners en HMR
      return () => { electronBridge.offTrayAction?.(handler); };
    }
  }, []);

  const dismissExternalDrive = async (drivePath: string) => {
    await syncService.dismissAlert(drivePath);
    setExternalDrives(current => current.filter(d => d.path !== drivePath));
  };

  const linkExternalDrive = async (drive: ExternalDriveAlert) => {
    const newPair: SyncPair = {
      id: Math.random().toString(36).substr(2, 9),
      localPath: drive.path,
      remotePath: `GoogleDrive:/Respaldos USB (${drive.name})`,
      direction: 'upload',
      status: 'syncing',
      lastSynced: null,
      accountId: selectedAccount
    };
    await addPair(newPair);
    await dismissExternalDrive(drive.path);
    setActiveTab('folders');
  };

  useEffect(() => {
    const unsubscribe = initAuth(
      async (user, token, refreshToken) => {
        setUser(user);
        setNeedsAuth(false);
        await syncService.setToken(token, refreshToken); // <--- AHORA ENVIAMOS AMBOS
        fetchBackendStatus();
      },
      async () => {
        setUser(null);
        setNeedsAuth(true);
        await syncService.setToken(null);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    if (isLoggingInRef.current) return;
    isLoggingInRef.current = true;
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setNeedsAuth(false);
        await syncService.setToken(result.accessToken, result.refreshToken); // <--- AHORA ENVIAMOS AMBOS
        fetchBackendStatus();
      }
    } catch (err: unknown) {
      logger.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      // Mostrar error descriptivo al usuario
      const msg = (err instanceof Error ? err.message : String(err)) || 'Error desconocido al iniciar sesión';
      // Simplificar errores comunes de OAuth
      if (msg.includes('redirect_uri_mismatch')) {
        setLoginError('Error de configuración: La URI de redirección no está registrada en Google Cloud Console. Contacta al desarrollador.');
      } else if (msg.includes('access_denied')) {
        setLoginError('Inicio de sesión cancelado. Debes permitir los permisos para usar la aplicación.');
      } else if (msg.includes('popup_closed') || msg.includes('user_cancelled')) {
        setLoginError('Ventana de inicio de sesión cerrada. Intenta de nuevo.');
      } else if (msg.includes('REDIRECT_INITIATED')) {
        // No es un error real, es la señal de que se inició redirect flow
        setLoginError('Redirigiendo al navegador para autenticación... Vuelve a la app después de iniciar sesión.');
      } else if (msg.includes('network') || msg.includes('Network') || msg.includes('ERR_CONNECTION')) {
        setLoginError('Error de red. Verifica tu conexión a internet e intenta de nuevo.');
      } else {
        setLoginError(msg.length > 120 ? msg.substring(0, 120) + '...' : msg);
      }
    } finally {
      isLoggingInRef.current = false;
      setIsLoggingIn(false);
    }
  };

  // B15 Fix: Limpiar también tokens de localStorage al cerrar sesión
  const handleLogout = async () => {
    await logout();
    await syncService.setToken(null);
    setUser(null);
    setNeedsAuth(true);
    setPairs([]);
    setEvents([]);
    setPendingConflicts([]);
  };

  const addPair = async (newPair: SyncPair) => {
    const prev = pairs;
    const updated = [...pairs, newPair];
    setPairs(updated);
    try {
      await syncService.setPairs(updated);
      fetchBackendStatus();
    } catch (e: any) {
      // Rollback optimistic update and show user the error
      setPairs(prev);
      const msg = e instanceof Error ? e.message : String(e);
      alert(`No se pudo crear el par: ${msg}`);
      throw e;
    }
  };

  const toggleSync = async (id: string) => {
    setPairs(current => current.map(p => p.id === id ? { ...p, status: p.status === 'syncing' ? 'idle' : 'syncing' } : p));
    syncService.toggleSync(id).finally(() => setTimeout(fetchBackendStatus, 500));
  };

  const forceSync = async (id: string) => {
    setPairs(current => current.map(p => p.id === id ? { ...p, status: 'syncing' } : p));
    syncService.forceSync(id).finally(() => setTimeout(fetchBackendStatus, 500));
  };

  const pauseSync = async (id: string) => {
    setPairs(current => current.map(p => p.id === id ? { ...p, status: p.status === 'paused' ? 'idle' : 'paused' } : p));
    syncService.pauseSync(id).finally(() => setTimeout(fetchBackendStatus, 500));
  };

  const removePair = async (id: string) => {
    if (window.confirm('¿Estás seguro de que quieres eliminar esta configuración de sincronización? (Esto no eliminará los archivos reales)')) {
      setPairs(current => current.filter(p => p.id !== id));
      await syncService.removePair(id);
      fetchBackendStatus();
    }
  };

  const resolveConflict = async (conflictId: string, resolution: 'local' | 'remote' | 'rename') => {
    // FASE 4: Optimistic UI - Desaparecer el aviso al instante
    setPendingConflicts(current => current.filter(c => c.id !== conflictId));
    try {
      await syncService.resolveConflict(conflictId, resolution);
      fetchBackendStatus();
    } catch (err) {
      logger.error(`Error al resolver conflicto: ${err instanceof Error ? err.message : String(err)}`);
      fetchBackendStatus(); // Rollback (volver a mostrar) si el servidor falla
    }
  };

  const handleSettingsChange = async (newSettings: SyncSettings) => {
    setSettings(newSettings);
    await syncService.updateSettings(newSettings);
  };

  const handleCleanCloudTrash = async () => {
    if (isCleaningCloudJunk) return;

    const confirmClean = window.confirm(
      `🧹 Limpieza de Archivos Excluidos en Google Drive\n\n` +
      `¿Deseas buscar y eliminar en Google Drive todos los archivos que coinciden con tu Lista de Exclusiones (*.aux, *.log, *.synctex.gz, *.out, *.toc, etc.)?\n\n` +
      `🔒 GARANTÍA DE SEGURIDAD: Tu Papelera de Google Drive NO será tocada.`
    );
    if (!confirmClean) return;

    setIsCleaningCloudJunk(true);

    try {
      const res = await syncService.cleanCloudTrash();
      if (res) {
        const count = res.excludedFilesCleaned || 0;
        const patternsCount = res.patternsChecked || 0;

        const msg =
          `🎉 ¡Limpieza de Archivos Excluidos Completada con Éxito!\n\n` +
          `• Archivos temporales de LaTeX y exclusiones eliminados en Drive: ${count}\n` +
          `• Patrones de exclusión evaluados: ${patternsCount}\n\n` +
          `ℹ️ Tu Papelera de Google Drive se mantuvo totalmente intacta.`;

        const electronBridge = (window as any).electronBridge;
        if (electronBridge?.showNotification) {
          electronBridge.showNotification(
            '🧹 Limpieza de Exclusiones Completada',
            `Se eliminaron ${count} archivos temporales (*.aux, *.log) en Google Drive.`
          );
        }

        alert(msg);
        fetchBackendStatus();
      }
    } catch (e: any) {
      alert(`Error al limpiar archivos excluidos en la nube: ${e.message || e}`);
    } finally {
      setIsCleaningCloudJunk(false);
    }
  };

  const handleCancelCleanCloudTrash = async () => {
    try {
      await syncService.cancelCleanCloudTrash();
      alert('⏹️ Solicitud de cancelación enviada. La limpieza de exclusiones en la nube se detendrá inmediatamente.');
    } catch (e: any) {
      alert(`Error al cancelar la limpieza: ${e.message || e}`);
    }
  };

  if (needsAuth) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-100 font-sans">
        <div className="bg-neutral-900 border border-neutral-800 p-8 rounded-2xl max-w-sm w-full text-center">
          <div className="w-16 h-16 rounded-2xl bg-blue-500/20 text-blue-400 flex items-center justify-center mx-auto mb-6">
            <FolderSync size={32} />
          </div>
          <h1 className="text-2xl font-medium mb-2">SyncClient</h1>
          <p className="text-neutral-400 text-sm mb-8">Conecta tu cuenta de Google Drive para empezar a sincronizar archivos de forma bidireccional.</p>

          <button
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full flex items-center justify-center space-x-3 bg-white text-black py-3 rounded-xl font-medium hover:bg-neutral-200 transition-colors disabled:opacity-50"
          >
            {isLoggingIn ? (
              <RefreshCw className="animate-spin" size={18} />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
            )}
            <span>{isLoggingIn ? 'Conectando...' : 'Iniciar sesión con Google'}</span>
          </button>
        </div>
      </div>
    );
  }

  const isSessionExpired = !backendAuthenticated || pairs.some(p => p.status === 'unauthenticated');

  return (
    <div className="flex h-screen bg-[#090b14] text-neutral-100 font-sans overflow-hidden flex-col md:flex-row bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(29,78,216,0.15),rgba(255,255,255,0))]">
      {/* Sidebar - Desktop / Tablet */}
      <div className="hidden md:flex w-64 bg-black/40 backdrop-blur-xl border-r border-white/[0.05] flex-col shrink-0">
        <div className="p-6 flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center">
            <FolderSync size={20} />
          </div>
          <h1 className="font-semibold tracking-wide text-sm uppercase text-neutral-300">SyncClient</h1>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <NavItem active={activeTab === 'overview'} onClick={() => setActiveTab('overview')} icon={<Cloud size={18} />} label="Resumen" badge={pendingConflicts.length > 0 ? pendingConflicts.length : undefined} />
          <NavItem active={activeTab === 'folders'} onClick={() => setActiveTab('folders')} icon={<HardDrive size={18} />} label="Carpetas" />
          <NavItem active={activeTab === 'activity'} onClick={() => setActiveTab('activity')} icon={<Activity size={18} />} label="Actividad" />
          <NavItem active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings size={18} />} label="Ajustes" />
        </nav>

        <div className="p-4 border-t border-neutral-800">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-3 text-sm text-neutral-400">
              <div className={`w-2 h-2 rounded-full ${isSessionExpired ? 'bg-amber-400 animate-pulse' :
                pairs.some(p => p.status === 'syncing') ? 'bg-blue-400 animate-pulse' : 'bg-green-400'
                }`} />
              <span>
                {isSessionExpired ? 'Sesión expirada' :
                  pairs.some(p => p.status === 'syncing') ? 'Sincronizando...' : 'Todo actualizado'}
              </span>
            </div>
          </div>
          <div className="bg-black/20 p-3 rounded-xl border border-white/[0.05] shadow-inner mb-4">
            <div className="flex items-center justify-between">
              <div className="flex flex-col truncate">
                <span className="text-xs text-neutral-200 font-medium truncate flex items-center gap-1.5">
                  <span>{user?.displayName || 'Cuenta Principal'}</span>
                  <span className="px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[9px] rounded font-mono font-bold">ACTIVA</span>
                </span>
                <span className="text-[10px] text-neutral-400 font-mono truncate">{user?.email || 'google@gmail.com'}</span>
              </div>
              <button onClick={handleLogout} className="text-neutral-500 hover:text-white transition-colors ml-2" title="Cerrar sesión">
                <LogOut size={16} />
              </button>
            </div>

            <div className="pt-2 border-t border-neutral-800 flex items-center justify-between text-[11px] text-neutral-400">
              <span className="flex items-center gap-1.5 font-mono text-neutral-300">
                <Users size={13} className="text-blue-400" />
                <span>Multi-Cuenta</span>
              </span>
              <button
                onClick={() => alert("¡Soporte Multi-Cuenta habilitado! Tus próximas configuraciones en 'Carpetas' operan de forma nativa sin colisionar con otras sesiones de Google Drive.")}
                className="text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-2 py-0.5 rounded transition-colors border border-neutral-700 font-mono"
              >
                + Añadir
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Top Header - Visible en teléfonos móviles (< 768px) */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 bg-neutral-900/95 backdrop-blur-md border-b border-neutral-800 shrink-0 z-40 sticky top-0 shadow-md">
        <div className="flex items-center space-x-2.5 truncate pr-2">
          <div className="w-7 h-7 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
            <FolderSync size={17} />
          </div>
          <div className="flex flex-col truncate">
            <span className="font-bold tracking-wide text-xs uppercase text-white flex items-center gap-1.5">
              <span>SYNC CLIENT</span>
              <div className={`w-2 h-2 rounded-full shrink-0 ${isSessionExpired ? 'bg-amber-400 animate-pulse' :
                pairs.some(p => p.status === 'syncing') ? 'bg-blue-400 animate-pulse' : 'bg-green-400'
                }`} title={isSessionExpired ? 'Sesión expirada' : pairs.some(p => p.status === 'syncing') ? 'Sincronizando' : 'Al día'} />
            </span>
            <span className="text-[10px] text-neutral-400 font-mono truncate">{user?.email || 'Cuenta Google Activa'}</span>
          </div>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          {isSessionExpired ? (
            <button
              onClick={handleLogin}
              disabled={isLoggingIn}
              className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-semibold rounded transition-colors"
            >
              {isLoggingIn ? '...' : 'Conectar'}
            </button>
          ) : (
            <button
              onClick={handleLogout}
              className="p-1.5 text-neutral-400 hover:text-red-400 bg-neutral-800 hover:bg-neutral-700/80 rounded-lg border border-neutral-700 transition-colors"
              title="Cerrar sesión en móvil"
            >
              <LogOut size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto w-full">
        <div className="p-4 sm:p-6 md:p-8 pb-32 sm:pb-24 md:pb-8 max-w-6xl mx-auto w-full">
          {/* Banner Alerta Sesión Expirada */}
          {isSessionExpired && (
            <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl p-4 mb-6 flex items-center justify-between">
              <div className="flex items-center space-x-3 text-amber-200 text-sm">
                <ShieldAlert size={20} className="text-amber-400 shrink-0" />
                <div>
                  <p className="font-medium">Sesión de Google Drive expirada</p>
                  <p className="text-xs text-amber-400/80">Tu token de acceso ha caducado. Vuelve a conectar tu cuenta para reanudar la sincronización.</p>
                </div>
              </div>
              <button
                onClick={handleLogin}
                disabled={isLoggingIn}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium rounded-lg transition-colors shrink-0"
              >
                {isLoggingIn ? 'Conectando...' : 'Reconectar Google'}
              </button>
            </div>
          )}

          {/* FASE 4: Banner de Cuota Excedida en Drive */}
          {pairs.some(p => p.status === 'error') && events.some(e => e.details?.includes('espacio suficiente')) && (
            <div className="bg-red-950/40 border border-red-800/60 rounded-xl p-4 mb-6 flex items-center space-x-3 text-red-200 text-sm shadow-sm">
              <AlertCircle size={24} className="text-red-400 shrink-0" />
              <div>
                <p className="font-bold text-red-300">Almacenamiento de Google Drive Lleno</p>
                <p className="text-xs text-red-200/80 mt-0.5">La sincronización se detuvo porque no tienes más espacio en tu cuenta de Google. Libera espacio para continuar subiendo archivos.</p>
              </div>
            </div>
          )}

          {/* Banner Inteligente Modo de Ahorro o Desconectado */}
          {powerSavingMode && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-xl p-4 mb-6 flex items-center space-x-3.5 shadow-sm">
              <BatteryWarning size={24} className="text-amber-400 shrink-0 animate-pulse" />
              <div>
                <p className="font-medium text-sm">Modo de Ahorro y Optimización del Sistema Activado</p>
                <p className="text-xs text-amber-300/80 mt-0.5">{powerSavingMode}</p>
              </div>
            </div>
          )}

          {/* Modal/Alerta de Dispositivo de Almacenamiento Externo USB/SD */}
          {externalDrives.length > 0 && (
            <div className="bg-gradient-to-r from-blue-900/50 to-indigo-900/50 border border-blue-500/50 rounded-xl p-5 mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xl shadow-blue-500/10">
              <div className="flex items-center space-x-4 text-blue-100 text-sm">
                <div className="p-3 bg-blue-500/20 border border-blue-400/30 rounded-xl text-blue-400">
                  <Usb size={26} className="animate-bounce" />
                </div>
                <div>
                  <h4 className="font-bold text-base flex items-center gap-2 text-white">
                    <span>Unidad de almacenamiento USB Detectada: '{externalDrives[0].name}'</span>
                    <span className="text-[10px] bg-blue-500/30 border border-blue-400 text-blue-200 px-2.5 py-0.5 rounded-full font-mono uppercase">Linux Mount</span>
                  </h4>
                  <p className="text-xs text-blue-200/80 font-mono mt-1">Ruta física en sistema: {externalDrives[0].path}</p>
                  <p className="text-xs text-neutral-300 mt-1">¿Deseas vincular de inmediato este dispositivo para un respaldo continuo hacia Google Drive?</p>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => linkExternalDrive(externalDrives[0])}
                  className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs rounded-lg shadow-md hover:shadow-blue-500/20 transition-all flex items-center gap-2"
                >
                  <Cloud size={15} />
                  <span>Vincular Respaldo USB</span>
                </button>
                <button
                  onClick={() => dismissExternalDrive(externalDrives[0].path)}
                  className="p-2.5 hover:bg-neutral-800/80 text-neutral-400 hover:text-neutral-200 rounded-lg transition-colors border border-transparent hover:border-neutral-700"
                  title="Ignorar dispositivo"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
          )}

          {/* Sección de Conflictos Pendientes */}
          <ConflictsSection conflicts={pendingConflicts} onResolve={resolveConflict} />

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.08 }}
            >
              {/* Renderizar TODOS los paneles pero solo mostrar el activo, evitando desmontear el motor */}
              <div style={{ display: activeTab === 'overview' ? 'block' : 'none' }}>
                <OverviewTab pairs={pairs} events={events} conflictsCount={pendingConflicts.length} uploadSpeed={uploadSpeed} downloadSpeed={downloadSpeed} isOnline={isOnline} pingMs={pingMs} etaSeconds={etaSeconds} />
              </div>
              <div style={{ display: activeTab === 'folders' ? 'block' : 'none' }}>
                <FoldersTab pairs={pairs} onAddPair={addPair} forceSync={forceSync} pauseSync={pauseSync} removePair={removePair} uploadSpeed={uploadSpeed} downloadSpeed={downloadSpeed} isOnline={isOnline} pingMs={pingMs} etaSeconds={etaSeconds} onCleanCloudTrash={handleCleanCloudTrash} isCleaningCloudJunk={isCleaningCloudJunk} onCancelCleanCloudTrash={handleCancelCleanCloudTrash} />
              </div>
              <div style={{ display: activeTab === 'activity' ? 'block' : 'none' }}>
                <ActivityTab events={events} pairs={pairs} />
              </div>
              <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}>
                <SettingsTab settings={settings} onUpdateSettings={handleSettingsChange} />
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Bottom Nav Bar - Smartphone Touch UI (< 768px) */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-neutral-900/98 backdrop-blur-lg border-t border-neutral-800 flex items-center justify-around px-2 z-50 shadow-2xl pb-1">
        <button onClick={() => setActiveTab('overview')} className={`flex flex-col items-center justify-center flex-1 py-1.5 rounded-lg transition-colors ${activeTab === 'overview' ? 'text-blue-400 font-bold bg-blue-500/10' : 'text-neutral-400 hover:text-neutral-200'}`}>
          <Cloud size={19} className="mb-0.5" />
          <span className="text-[11px] font-medium">Resumen</span>
        </button>
        <button onClick={() => setActiveTab('folders')} className={`flex flex-col items-center justify-center flex-1 py-1.5 rounded-lg transition-colors ${activeTab === 'folders' ? 'text-blue-400 font-bold bg-blue-500/10' : 'text-neutral-400 hover:text-neutral-200'}`}>
          <HardDrive size={19} className="mb-0.5" />
          <span className="text-[11px] font-medium">Carpetas</span>
        </button>
        <button onClick={() => setActiveTab('activity')} className={`flex flex-col items-center justify-center flex-1 py-1.5 rounded-lg transition-colors ${activeTab === 'activity' ? 'text-blue-400 font-bold bg-blue-500/10' : 'text-neutral-400 hover:text-neutral-200'}`}>
          <Activity size={19} className="mb-0.5" />
          <span className="text-[11px] font-medium">Actividad</span>
        </button>
        <button onClick={() => setActiveTab('settings')} className={`flex flex-col items-center justify-center flex-1 py-1.5 rounded-lg transition-colors ${activeTab === 'settings' ? 'text-blue-400 font-bold bg-blue-500/10' : 'text-neutral-400 hover:text-neutral-200'}`}>
          <Settings size={19} className="mb-0.5" />
          <span className="text-[11px] font-medium">Ajustes</span>
        </button>
      </div>
    </div>
  );
}

function NavItem({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm transition-colors ${active
        ? 'bg-neutral-800/80 text-white'
        : 'text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200'
        }`}
    >
      <div className="flex items-center space-x-3">
        {icon}
        <span>{label}</span>
      </div>
      {badge !== undefined && badge > 0 && (
        <span className="bg-amber-500/20 text-amber-400 text-xs px-2 py-0.5 rounded-full font-medium">
          {badge}
        </span>
      )}
    </button>
  );
}

// Helper para evitar mostrar la fecha 31/12/1969 cuando mtime es 0
const formatConflictDate = (mtimeMs: number, fallbackMs?: number) => {
  if (!mtimeMs || mtimeMs <= 0) {
    if (fallbackMs && fallbackMs > 0) return new Date(fallbackMs).toLocaleString();
    return 'Fecha no registrada';
  }
  return new Date(mtimeMs).toLocaleString();
};

function ConflictsSection({ conflicts, onResolve }: { conflicts: PendingConflict[], onResolve: (id: string, res: 'local' | 'remote' | 'rename') => void }) {
  if (conflicts.length === 0) return null;

  const handleAutoResolveAllByDate = () => {
    conflicts.forEach(c => {
      const isLocalNewer = c.localMtime > c.remoteMtime;
      onResolve(c.id, isLocalNewer ? 'local' : 'remote');
    });
  };

  return (
    <div className="bg-amber-950/30 border border-amber-800/50 rounded-2xl p-5 mb-6 shadow-xl shadow-amber-950/20 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-amber-800/40">
        <div>
          <div className="flex items-center space-x-2 text-amber-400 mb-1">
            <AlertCircle size={18} />
            <h3 className="text-sm font-bold uppercase tracking-wider">Conflictos Pendientes ({conflicts.length})</h3>
          </div>
          <p className="text-xs text-amber-200/80">
            Los siguientes archivos fueron modificados simultáneamente en local y remoto. Selecciona la versión que deseas conservar.
          </p>
        </div>

        <button
          onClick={handleAutoResolveAllByDate}
          className="px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-black font-bold rounded-xl text-xs transition-all shadow-md shadow-amber-500/20 flex items-center justify-center space-x-1.5 shrink-0 active:scale-95"
          title="Resolver automáticamente todos los conflictos seleccionando la versión con la fecha de modificación más reciente"
        >
          <span>⚡ Resolver Todos por Fecha Reciente</span>
        </button>
      </div>

      <div className="space-y-3">
        {conflicts.map(c => {
          const isLocalNewer = c.localMtime > c.remoteMtime;
          const isRemoteNewer = c.remoteMtime > c.localMtime;
          const isSameHash = c.localHash && c.remoteHash && c.localHash === c.remoteHash;

          return (
            <div key={c.id} className="bg-white/[0.02] backdrop-blur-md border border-white/[0.05] rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-5 hover:bg-white/[0.04] transition-all hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-black/50">
              <div className="space-y-1.5 flex-1 min-w-0">
                <p className="text-sm font-mono text-white font-semibold break-all">{c.relativePath}</p>
                
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                  {/* FIX DE FECHA 1969 */}
                  <span className={`px-2.5 py-1 rounded-md border ${isLocalNewer ? 'bg-blue-500/20 text-blue-300 border-blue-500/40 font-bold' : 'bg-neutral-950 text-neutral-400 border-neutral-800'}`}>
                    Local: {formatConflictDate(c.localMtime, c.timestamp)} {isLocalNewer && ' (Más reciente)'}
                  </span>
                  <span className="text-neutral-600">•</span>
                  <span className={`px-2.5 py-1 rounded-md border ${isRemoteNewer ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold' : 'bg-neutral-950 text-neutral-400 border-neutral-800'}`}>
                    Remoto: {formatConflictDate(c.remoteMtime, c.timestamp)} {isRemoteNewer && ' (Más reciente)'}
                  </span>
                  {isSameHash && (
                    <span className="bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 px-2 py-0.5 rounded text-[11px] font-sans font-semibold">
                      ✅ Contenido Idéntico
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  onClick={() => onResolve(c.id, isLocalNewer ? 'local' : 'remote')}
                  className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/35 border border-amber-500/50 text-amber-300 rounded-lg text-xs font-bold transition-colors flex items-center space-x-1"
                  title="Conservar la versión con la fecha de modificación más reciente"
                >
                  <span>⚡ Usar Más Reciente ({isLocalNewer ? 'Local' : 'Remoto'})</span>
                </button>
                <button
                  onClick={() => onResolve(c.id, 'local')}
                  className="px-3 py-1.5 bg-neutral-800 hover:bg-blue-600/80 text-white rounded-lg text-xs font-medium transition-colors border border-neutral-700"
                >
                  Usar Local
                </button>
                <button
                  onClick={() => onResolve(c.id, 'remote')}
                  className="px-3 py-1.5 bg-neutral-800 hover:bg-green-600/80 text-white rounded-lg text-xs font-medium transition-colors border border-neutral-700"
                >
                  Usar Remoto
                </button>
                <button
                  onClick={() => onResolve(c.id, 'rename')}
                  className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg text-xs font-medium transition-colors border border-neutral-700"
                >
                  Guardar Ambos
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverviewTab({ pairs, events, conflictsCount, uploadSpeed = 0, downloadSpeed = 0, isOnline = true, pingMs = null, etaSeconds = null }: {
  pairs: SyncPair[];
  events: SyncEvent[];
  conflictsCount: number;
  uploadSpeed?: number;
  downloadSpeed?: number;
  isOnline?: boolean;
  pingMs?: number | null;
  etaSeconds?: number | null;
}) {
  const activeCount = pairs.filter(p => p.status === 'syncing').length;

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-2xl font-medium text-white mb-1">Panel de Control</h2>
        <p className="text-neutral-400 text-sm">Supervisa el estado de tu sincronización en tiempo real.</p>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 md:gap-6">
        <StatCard title="Syncs Activas" value={activeCount.toString()} icon={<RefreshCw size={20} className={activeCount > 0 ? 'animate-spin text-blue-400' : 'text-neutral-500'} />} />
        <StatCard title="Carpetas" value={pairs.length.toString()} icon={<FolderSync size={20} className="text-neutral-500" />} />
        <StatCard title="Eventos" value={events.length.toString()} icon={<Activity size={20} className="text-neutral-500" />} />
        <StatCard title="Conflictos" value={conflictsCount.toString()} icon={<AlertCircle size={20} className={conflictsCount > 0 ? 'text-amber-400' : 'text-neutral-500'} />} />
      </div>

      {/* Barra de Progreso TOTAL de Sincronización (suma de todos los pares) */}
      <TotalSyncProgressBar pairs={pairs} uploadSpeed={uploadSpeed} downloadSpeed={downloadSpeed} isOnline={isOnline} pingMs={pingMs} etaSeconds={etaSeconds} />

      {pairs.some(p => p.status === 'syncing' || p.progress) && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-blue-400 uppercase tracking-wider flex items-center">
            <RefreshCw size={15} className="animate-spin mr-2 text-blue-400" />
            Sincronizaciones en Progreso
          </h3>
          {pairs.filter(p => p.status === 'syncing' || p.progress).map(p => (
            <div key={p.id} className="bg-neutral-900/95 border border-blue-500/40 rounded-xl p-4 shadow-xl shadow-blue-950/20">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs font-mono text-neutral-300 mb-2 gap-1 break-all sm:break-normal">
                <span className="truncate text-neutral-200 font-semibold" title={p.localPath}>📁 {p.localPath}</span>
                <span className="truncate text-blue-400 font-semibold" title={p.remotePath}>☁️ {p.remotePath}</span>
              </div>
              <SyncProgressBar progress={p.progress} status={p.status} />
            </div>
          ))}
        </div>
      )}

      <div className="bg-white/[0.02] backdrop-blur-md border border-white/[0.05] rounded-2xl p-6 shadow-2xl hover:bg-white/[0.03] transition-colors">
        <h3 className="text-sm font-medium text-neutral-300 mb-4 uppercase tracking-wide">Actividad Reciente</h3>
        {events.length === 0 ? (
          <div className="text-center py-8 text-neutral-500 text-sm">No hay actividad de sincronización reciente.</div>
        ) : (
          <div className="space-y-3.5">
            {events.slice(0, 5).map(event => (
              <div key={event.id} className="flex items-center justify-between text-sm py-2 border-b border-neutral-800/40 last:border-0">
                <div className="flex items-center space-x-3 truncate pr-4">
                  <div className={`p-2 rounded-full shrink-0 ${event.action === 'uploaded' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' :
                    event.action === 'downloaded' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                      event.action === 'deleted' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                        event.action === 'cleaned' ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20' :
                          event.action === 'sync_start' || event.action === 'sync_end' ? 'bg-teal-500/10 text-teal-300 border border-teal-500/20' :
                            'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    }`}>
                    {event.action === 'uploaded' ? <Upload size={14} /> :
                      event.action === 'downloaded' ? <Download size={14} /> :
                        event.action === 'deleted' ? <Trash2 size={14} /> :
                          event.action === 'cleaned' ? <CheckCircle2 size={14} /> :
                            event.action === 'sync_start' || event.action === 'sync_end' ? <RefreshCw size={14} className={event.action === 'sync_start' ? 'animate-spin' : ''} /> :
                              <AlertCircle size={14} />}
                  </div>
                  <div className="truncate">
                    <span className="text-neutral-200 font-medium">{event.filename}</span>
                    <span className="text-neutral-400 ml-2 font-mono text-xs">
                      {event.details ? `— ${event.details}` : (
                        event.action === 'uploaded' ? 'Subido' :
                          event.action === 'downloaded' ? 'Descargado' :
                            event.action === 'deleted' ? 'Eliminado' :
                              event.action === 'cleaned' ? 'Limpieza de duplicado' :
                                event.action === 'sync_start' ? 'Iniciando verificación' :
                                  event.action === 'sync_end' ? 'Ciclo finalizado' : 'Conflicto')}
                    </span>
                  </div>
                </div>
                <div className="text-neutral-500 text-xs flex items-center shrink-0 font-mono">
                  <Clock size={12} className="mr-1" />
                  {new Date(event.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-white/[0.02] backdrop-blur-md border border-white/[0.05] rounded-2xl p-6 flex items-center justify-between shadow-lg hover:shadow-xl hover:bg-white/[0.04] transition-all hover:-translate-y-0.5">
      <div>
        <p className="text-xs text-neutral-400 uppercase tracking-wider mb-1">{title}</p>
        <p className="text-3xl font-light text-white">{value}</p>
      </div>
      <div className="w-12 h-12 rounded-full bg-neutral-950 flex items-center justify-center border border-neutral-800">
        {icon}
      </div>
    </div>
  );
}

function TotalSyncProgressBar({ pairs, uploadSpeed = 0, downloadSpeed = 0, isOnline = true, pingMs = null, etaSeconds = null }: {
  pairs: SyncPair[];
  uploadSpeed?: number;
  downloadSpeed?: number;
  isOnline?: boolean;
  pingMs?: number | null;
  etaSeconds?: number | null;
}) {
  if (pairs.length === 0) return null;

  const syncingPairs = pairs.filter(p => p.status === 'syncing' || p.progress);
  const isActivelySyncing = syncingPairs.length > 0;

  const rawTransferred = syncingPairs.reduce((sum, p) => sum + (p.progress?.bytesTransferred || 0), 0);
  const totalBytes = syncingPairs.reduce((sum, p) => sum + (p.progress?.totalBytes || 0), 0);
  const totalFiles = syncingPairs.reduce((sum, p) => sum + (p.progress?.currentFileIndex || 0), 0);
  const totalAllFiles = syncingPairs.reduce((sum, p) => sum + (p.progress?.totalFiles || 0), 0);

  // Acotar los bytes transferidos para que NUNCA superen los bytes totales
  const safeTransferred = totalBytes > 0 ? Math.min(rawTransferred, totalBytes) : rawTransferred;

  // Cálculo de Porcentaje Coherente
  const pct = isActivelySyncing
    ? (totalBytes > 0
        ? (safeTransferred >= totalBytes
            ? 99
            : Math.max(1, Math.round((safeTransferred / totalBytes) * 100)))
        : (totalAllFiles > 0
            ? Math.min(99, Math.max(1, Math.round((totalFiles / totalAllFiles) * 100)))
            : 5
          )
      )
    : 100;

  const formatSize = (bytes?: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const isFinalizingDb = isActivelySyncing && totalBytes > 0 && safeTransferred >= totalBytes;

  const bidiPairs = pairs.filter(p => p.direction === 'bidirectional');
  const uploadPairs = pairs.filter(p => p.direction === 'upload');
  const downloadPairs = pairs.filter(p => p.direction === 'download');
  const mirrorPairs = pairs.filter(p => (p.syncMode || 'mirror') === 'mirror');
  const streamingPairs = pairs.filter(p => p.syncMode === 'streaming');

  return (
    <div className={`border-2 rounded-2xl p-5 shadow-xl transition-all space-y-4 ${
      isActivelySyncing
        ? 'bg-gradient-to-r from-blue-950/90 via-indigo-950/90 to-blue-950/90 border-blue-500/50 shadow-blue-500/10'
        : 'bg-gradient-to-r from-emerald-950/40 via-neutral-900 to-teal-950/40 border-emerald-500/40 shadow-emerald-500/10'
    }`}>
      <div className="flex flex-col gap-3.5">
        {/* Encabezado Superior Responsivo sin Colisión de Texto */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 w-full min-w-0">
          {/* Lado Izquierdo: Estado + Badge */}
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <div className="flex items-center gap-2 font-bold text-xs sm:text-sm uppercase tracking-wider shrink-0">
              {isActivelySyncing ? (
                <RefreshCw size={16} className="animate-spin text-blue-400 shrink-0" />
              ) : (
                <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
              )}
              <span className={isActivelySyncing ? 'text-blue-300' : 'text-emerald-300'}>
                {isActivelySyncing 
                  ? (isFinalizingDb ? '💾 Guardando cambios en SQLite...' : 'Progreso Total de Bisincronización') 
                  : 'Estado de Bisincronización Total'}
              </span>
            </div>

            <span className={`text-[10px] sm:text-[11px] px-2.5 py-0.5 rounded-full font-mono font-bold border shrink-0 ${
              isActivelySyncing
                ? 'bg-blue-500/20 border-blue-400/40 text-blue-200'
                : 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'
            }`}>
              {pairs.length} {pairs.length === 1 ? 'carpeta configurada' : 'carpetas configuradas'}
            </span>
          </div>

          {/* Lado Derecho: Cifras de Progreso */}
          <div className="flex items-center gap-2 font-mono text-xs text-neutral-300 flex-wrap shrink-0">
            {isActivelySyncing && totalBytes > 0 && (
              <span className="text-emerald-400 font-bold bg-emerald-950/80 px-2.5 py-1 rounded-lg border border-emerald-800/60 shadow-sm">
                {formatSize(safeTransferred)} / {formatSize(totalBytes)}
              </span>
            )}
            {isActivelySyncing && totalAllFiles > 0 && (
              <span className="text-neutral-300 bg-neutral-900 px-2.5 py-1 rounded-lg border border-neutral-800">
                {Math.min(totalFiles, totalAllFiles)} de {totalAllFiles} archivos
              </span>
            )}
            {isActivelySyncing && !isFinalizingDb && (
              <span className="text-amber-400 font-mono bg-amber-950/80 px-2.5 py-1 rounded-lg border border-amber-800/60 shadow-sm">
                ⏱ {etaSeconds !== null 
                  ? etaSeconds < 60 ? `${etaSeconds}s` : `${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s` 
                  : 'ETA...'}
              </span>
            )}
            <span className={`font-bold border px-2.5 py-1 rounded-lg text-xs sm:text-sm shadow-md ${
              isActivelySyncing
                ? 'text-cyan-300 bg-cyan-950/90 border-cyan-700/80'
                : 'text-emerald-300 bg-emerald-950/90 border-emerald-700/80'
            }`}>
              {pct}%
            </span>
          </div>
        </div>

        {/* Barra de progreso */}
        <div className="w-full h-3.5 bg-neutral-950 rounded-full overflow-hidden p-0.5 border border-neutral-700 shadow-inner">
          <div
            className={`h-full rounded-full transition-all duration-500 relative shadow-md ${
              isActivelySyncing
                ? 'bg-gradient-to-r from-blue-500 via-indigo-400 to-cyan-400 shadow-blue-500/40'
                : 'bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 shadow-emerald-500/40'
            }`}
            style={{ width: `${pct}%` }}
          >
            {isActivelySyncing && (
              <div className="absolute inset-0 bg-white/20 animate-pulse rounded-full"></div>
            )}
          </div>
        </div>

        {/* Estado de Red y Velocidad */}
        <div className="bg-neutral-950/90 border border-neutral-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center space-x-2">
            <span className={`w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse shadow-sm shadow-emerald-500/50' : 'bg-red-500'}`} />
            <span className="font-sans font-semibold text-neutral-300">Estado de Red:</span>
            <span className={isOnline ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
              {isOnline ? `Online ${pingMs !== null ? `(${pingMs} ms)` : '⚡ Excelente'}` : 'Sin Conexión'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center space-x-1.5 bg-blue-950/60 border border-blue-800/50 px-2.5 py-1 rounded-lg">
              <span className="text-blue-300 font-sans font-semibold">⬆️ Subida:</span>
              <span className={`font-bold ${uploadSpeed > 0 ? 'text-cyan-300 animate-pulse' : 'text-neutral-400'}`}>
                {formatSize(uploadSpeed)}/s
              </span>
            </div>

            <div className="flex items-center space-x-1.5 bg-emerald-950/60 border border-emerald-800/50 px-2.5 py-1 rounded-lg">
              <span className="text-emerald-300 font-sans font-semibold">⬇️ Bajada:</span>
              <span className={`font-bold ${downloadSpeed > 0 ? 'text-emerald-300 animate-pulse' : 'text-neutral-400'}`}>
                {formatSize(downloadSpeed)}/s
              </span>
            </div>
          </div>
        </div>

        {/* Resumen por tipo de par */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-neutral-800/80 text-xs font-mono">
          <div className="bg-neutral-900/80 p-2.5 rounded-xl border border-neutral-800 flex items-center justify-between">
            <span className="text-blue-300 font-sans flex items-center gap-1.5 font-semibold">
              <ArrowLeftRight size={13} className="text-blue-400" /> Bidireccional:
            </span>
            <span className="text-neutral-200 font-bold">
              {bidiPairs.length} {bidiPairs.length === 1 ? 'par' : 'pares'}
            </span>
          </div>

          <div className="bg-neutral-900/80 p-2.5 rounded-xl border border-neutral-800 flex items-center justify-between">
            <span className="text-emerald-300 font-sans flex items-center gap-1.5 font-semibold">
              <Upload size={13} className="text-emerald-400" /> Solo Subida:
            </span>
            <span className="text-neutral-200 font-bold">
              {uploadPairs.length} {uploadPairs.length === 1 ? 'par' : 'pares'}
            </span>
          </div>

          <div className="bg-neutral-900/80 p-2.5 rounded-xl border border-neutral-800 flex items-center justify-between">
            <span className="text-cyan-300 font-sans flex items-center gap-1.5 font-semibold">
              <Download size={13} className="text-cyan-400" /> Solo Descarga:
            </span>
            <span className="text-neutral-200 font-bold">
              {downloadPairs.length} {downloadPairs.length === 1 ? 'par' : 'pares'}
            </span>
          </div>
        </div>

        {/* Desglose de Modo */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400 font-mono pt-1">
          <div className="flex items-center gap-3">
            <span>💾 <strong>Offline (Mirror):</strong> {mirrorPairs.length}</span>
            <span>☁️ <strong>Virtual (Streaming):</strong> {streamingPairs.length}</span>
          </div>
          <span className="text-neutral-300 font-medium truncate">
            {isActivelySyncing
              ? `Sincronizando ${formatSize(safeTransferred)} de ${formatSize(totalBytes)}`
              : '✅ Todas las carpetas están al día y verificadas con Google Drive'}
          </span>
        </div>
      </div>
    </div>
  );
}

function SyncProgressBar({ progress, status }: { progress?: SyncProgress | null, status: SyncStatus, key?: string | number }) {
  if (status !== 'syncing' && !progress) return null;

  // BUG-05 fix: 5% en lugar de 45% — más honesto durante la fase de escaneo inicial
  const pct = progress ? progress.percentage : (status === 'syncing' ? 5 : 0);
  const actionText = progress
    ? progress.action === 'subiendo' ? '🚀 Subiendo hacia Google Drive'
      : progress.action === 'descargando' ? '📥 Descargando a Dispositivo'
        : progress.action === 'comprobando' ? '🔍 Analizando archivos y versiones'
          : progress.action === 'deduplicando' ? '✨ Limpiando duplicados y obsoletos'
            : '✅ Ciclo verificado exitosamente'
    : '⏳ Sincronizando en segundo plano...';

  const formatSize = (bytes?: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="w-full mt-3.5 p-3.5 rounded-xl bg-neutral-950 border border-blue-500/40 shadow-lg shadow-blue-900/10 transition-all duration-300">
      <div className="flex flex-wrap items-center justify-between text-xs mb-2.5 gap-2">
        <div className="flex items-center space-x-2 flex-wrap min-w-0">
          <span className="font-semibold text-blue-300 flex items-center shrink-0">
            {actionText}
          </span>
          {progress?.currentFile && (
            <span className="text-neutral-200 font-mono text-[11px] bg-neutral-900/90 px-2.5 py-0.5 rounded-md border border-neutral-800 break-all max-w-full font-medium" title={progress.currentFile}>
              📄 {progress.currentFile}
            </span>
          )}
        </div>
        <div className="flex items-center space-x-3 shrink-0 font-mono text-neutral-300 text-[11px]">
          {progress && progress.totalBytes > 0 && (
            <span className="text-emerald-400 font-semibold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/50">
              {formatSize(progress.bytesTransferred)} / {formatSize(progress.totalBytes)}
            </span>
          )}
          {progress && progress.totalFiles > 0 && (
            <span className="text-neutral-400">
              ({progress.currentFileIndex || 0} de {progress.totalFiles})
            </span>
          )}
          <span className="font-bold text-cyan-400 bg-cyan-950/80 border border-cyan-800/60 px-2 py-0.5 rounded text-xs shadow-sm">
            {pct}%
          </span>
        </div>
      </div>
      <div className="w-full h-3 bg-black/40 rounded-full overflow-hidden p-0.5 border border-white/[0.05] shadow-inner">
        <div
          className="h-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 rounded-full transition-all duration-300 relative shadow-md shadow-cyan-500/30"
          style={{ width: `${pct}%` }}
        >
          <div className="absolute inset-0 bg-white/20 animate-pulse rounded-full"></div>
        </div>
      </div>
    </div>
  );
}

function FoldersTab({ pairs, onAddPair, forceSync, pauseSync, removePair, uploadSpeed = 0, downloadSpeed = 0, isOnline = true, pingMs = null, etaSeconds = null, onCleanCloudTrash, isCleaningCloudJunk, onCancelCleanCloudTrash }: {
  pairs: SyncPair[];
  onAddPair: (p: SyncPair) => void;
  forceSync: (id: string) => void;
  pauseSync: (id: string) => void;
  removePair: (id: string) => void;
  uploadSpeed?: number;
  downloadSpeed?: number;
  isOnline?: boolean;
  pingMs?: number | null;
  etaSeconds?: number | null;
  onCleanCloudTrash?: () => void;
  isCleaningCloudJunk?: boolean;
  onCancelCleanCloudTrash?: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [activeDedupPairs, setActiveDedupPairs] = useState<Set<string>>(new Set());

  const handleDehydrate = async (pairId: string) => {
    try {
      await syncService.dehydrate(pairId);
      forceSync(pairId);
    } catch (e: unknown) {
      logger.error(`Error al deshidratar par: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleHydrate = async (pairId: string) => {
    try {
      await syncService.hydrate(pairId);
      forceSync(pairId);
    } catch (e: unknown) {
      logger.error(`Error al hidratar par: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleCleanDuplicates = async (pair: SyncPair) => {
    if (activeDedupPairs.has(pair.id)) return;

    const confirmClean = window.confirm(
      `🔍 Deduplicador Inteligente A Demanda\n\n` +
      `¿Deseas buscar y limpiar archivos duplicados en '${pair.localPath}'?\n\n` +
      `🛡️ Medidas de Seguridad Aplicadas:\n` +
      `1. Los duplicados locales se respaldarán en la carpeta '.syncclient-backups/'.\n` +
      `2. Los duplicados en Google Drive se moverán a la PAPELERA DE DRIVE (recuperables durante 30 días).\n` +
      `3. Siempre se conservará la versión con el contenido y fecha más reciente.`
    );

    if (!confirmClean) return;

    setActiveDedupPairs(prev => new Set(prev).add(pair.id));

    try {
      const result = await syncService.cleanDuplicates(pair.id);
      if (result) {
        if (result.localDeleted === 0 && result.localRenamed === 0 && result.remoteDeleted === 0 && result.remoteRenamed === 0) {
          alert('✅ No se encontraron archivos duplicados. Todas tus carpetas están limpias.');
        } else {
          alert(
            `🎉 ¡Limpieza de duplicados completada con éxito!\n\n` +
            `📁 En Disco Local:\n` +
            `  • Archivos respaldados en .syncclient-backups: ${result.localDeleted}\n` +
            `  • Renombrados al nombre original: ${result.localRenamed}\n\n` +
            `☁️ En Google Drive:\n` +
            `  • Copias duplicadas enviadas a la Papelera de Drive: ${result.remoteDeleted}\n` +
            `  (Puedes restaurarlas desde la Papelera de Google Drive si lo necesitas).`
          );
        }
      }
    } catch (e: any) {
      alert(`Error al limpiar duplicados: ${e.message || e}`);
    } finally {
      setActiveDedupPairs(prev => {
        const next = new Set(prev);
        next.delete(pair.id);
        return next;
      });
    }
  };

  const handleCancelCleanDuplicates = async (pairId: string) => {
    try {
      await syncService.cancelCleanDuplicates(pairId);
      alert('⏹️ Solicitud de cancelación enviada. La deduplicación se detendrá inmediatamente.');
    } catch (e: any) {
      alert(`Error al cancelar deduplicación: ${e.message || e}`);
    }
  };

  return (
    <div className="space-y-6 pb-20 md:pb-0">
      <div className="flex items-center justify-between">
        <header>
          <h2 className="text-2xl font-medium text-white mb-1">Carpetas</h2>
          <p className="text-neutral-400 text-sm">Gestiona tus destinos de sincronización bidireccional.</p>
        </header>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center space-x-2 bg-white text-black px-4 py-2 rounded-lg text-sm font-medium hover:bg-neutral-200 transition-colors shadow-lg shadow-white/5"
        >
          <Plus size={16} />
          <span>Añadir Par</span>
        </button>
      </div>

      <TotalSyncProgressBar pairs={pairs} uploadSpeed={uploadSpeed} downloadSpeed={downloadSpeed} isOnline={isOnline} pingMs={pingMs} etaSeconds={etaSeconds} />

      <AnimatePresence>
        {showAdd && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <AddPairForm onAdd={(pair) => {
              onAddPair(pair);
              setShowAdd(false);
            }} onCancel={() => setShowAdd(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="space-y-4">
        {pairs.length === 0 && !showAdd && (
          <div className="text-center py-16 border border-dashed border-neutral-800 rounded-xl text-neutral-500 bg-neutral-900/30">
            <FolderSync size={32} className="mx-auto mb-3 opacity-50 text-blue-400" />
            <p className="text-sm text-neutral-300 font-medium">No hay carpetas de sincronización configuradas.</p>
            <p className="text-xs text-neutral-500 mt-1">Haz clic en "Añadir Par" para vincular una carpeta de tu sistema con Google Drive.</p>
          </div>
        )}
        {pairs.map(pair => (
          <div 
            key={pair.id} 
            className="bg-white/[0.02] backdrop-blur-md border border-white/[0.05] hover:border-white/10 rounded-2xl p-4 sm:p-5 flex flex-col space-y-4 transition-all shadow-xl hover:shadow-2xl hover:-translate-y-0.5 overflow-hidden w-full min-w-0"
          >
            {/* FILA 1: Rutas Local y Google Drive (Ocupan el 100% del ancho siempre) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full min-w-0">
              {/* Disco Local */}
              <div className="bg-neutral-950/80 border border-neutral-800 rounded-xl p-3 flex flex-col justify-between min-w-0 w-full space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-neutral-400 uppercase tracking-wider font-semibold flex items-center">
                    <HardDrive size={13} className="mr-1.5 text-neutral-400 shrink-0" /> Disco Local
                  </span>
                  <button
                    onClick={() => navigator.clipboard.writeText(pair.localPath)}
                    className="text-neutral-500 hover:text-neutral-300 p-1 transition-colors shrink-0"
                    title="Copiar ruta local completa"
                  >
                    <Copy size={12} />
                  </button>
                </div>
                <div className="text-xs font-mono text-neutral-200 font-medium truncate w-full" title={pair.localPath}>
                  {pair.localPath}
                </div>
              </div>

              {/* Google Drive */}
              <div className="bg-neutral-950/80 border border-neutral-800 rounded-xl p-3 flex flex-col justify-between min-w-0 w-full space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-blue-400 uppercase tracking-wider font-semibold flex items-center">
                    <Cloud size={13} className="mr-1.5 text-blue-400 shrink-0" /> Google Drive
                  </span>
                  <button
                    onClick={() => navigator.clipboard.writeText(pair.remotePath)}
                    className="text-neutral-500 hover:text-blue-300 p-1 transition-colors shrink-0"
                    title="Copiar ruta remota completa"
                  >
                    <Copy size={12} />
                  </button>
                </div>
                <div className="text-xs font-mono text-blue-300 font-medium truncate w-full" title={pair.remotePath}>
                  {pair.remotePath}
                </div>
              </div>
            </div>

            {/* FILA 2: Badges de Motor, Estado y Acciones de Control */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-neutral-800/80 w-full min-w-0">
              {/* Badges del Motor */}
              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-[10px] sm:text-[11px] font-mono font-bold border ${
                  pair.engineType === 'rclone'
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-blue-500/10 text-blue-300 border-blue-500/30'
                }`}>
                  {pair.engineType === 'rclone' ? '🚀 MOTOR RCLONE CLI' : '⚡ MOTOR NATIVO V2'}
                </span>

                <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-[10px] sm:text-[11px] font-mono font-medium border ${
                  pair.syncMode === 'streaming'
                    ? 'bg-purple-500/10 text-purple-300 border-purple-500/30'
                    : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                }`}>
                  {pair.syncMode === 'streaming' ? '☁️ MODO STREAMING' : '🔄 MODO DUPLICADO (OFFLINE)'}
                </span>

                <span className="inline-flex items-center px-2.5 py-0.5 rounded text-[10px] sm:text-[11px] font-mono text-neutral-300 bg-neutral-950 border border-neutral-800 truncate max-w-full">
                  {pair.cloudCategory === 'shared' ? '🌐 Colaborativa' : `💻 ${pair.deviceName || VFSBridge.getDeviceLabel()}`}
                </span>
              </div>

              {/* Estado e Indicador de Hora */}
              <div className="flex items-center space-x-3 shrink-0 self-end sm:self-auto">
                <div className="flex flex-col items-end">
                  <span className="text-xs font-medium uppercase mb-0.5">
                    {pair.status === 'syncing' ? (
                      <span className="text-blue-400 flex items-center font-semibold">
                        <RefreshCw size={12} className="mr-1.5 animate-spin text-blue-400" /> Sincronizando
                      </span>
                    ) : pair.status === 'paused' ? (
                      <span className="text-amber-400 flex items-center">
                        <Pause size={12} className="mr-1.5" /> Pausado
                      </span>
                    ) : pair.status === 'unauthenticated' ? (
                      <span className="text-amber-400 flex items-center">
                        <ShieldAlert size={12} className="mr-1.5" /> Re-conectar
                      </span>
                    ) : pair.status === 'idle' ? (
                      <span className="text-green-400 flex items-center font-semibold">
                        <CheckCircle2 size={13} className="mr-1.5 text-green-400" /> Al día
                      </span>
                    ) : (
                      <span className="text-red-400 flex items-center">
                        <AlertCircle size={12} className="mr-1.5" /> Error
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-neutral-500 font-mono">
                    {pair.lastSynced ? `Sync: ${new Date(pair.lastSynced).toLocaleTimeString()}` : 'Pendiente de inicio'}
                  </span>
                </div>

                {/* Botones Primarios (Sincronizar, Pausa, Eliminar) */}
                <div className="flex items-center space-x-1.5 shrink-0">
                  <button
                    onClick={() => forceSync(pair.id)}
                    disabled={pair.status === 'syncing'}
                    className="px-3 py-1.5 flex items-center justify-center space-x-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-30 transition-colors shadow-md text-xs font-medium"
                    title="Forzar sincronización manual"
                  >
                    <RefreshCw size={13} className={pair.status === 'syncing' ? 'animate-spin' : ''} />
                    <span>Sincronizar</span>
                  </button>
                  <button
                    onClick={() => pauseSync(pair.id)}
                    className="p-1.5 flex items-center justify-center rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white border border-neutral-700 text-xs transition-colors"
                    title={pair.status === 'paused' ? 'Reanudar' : 'Pausar'}
                  >
                    {pair.status === 'paused' ? <Play size={14} className="text-green-400" /> : <Pause size={14} />}
                  </button>
                  <button
                    onClick={() => removePair(pair.id)}
                    className="p-1.5 flex items-center justify-center rounded-lg bg-neutral-800/70 hover:bg-red-500/20 text-neutral-400 hover:text-red-400 border border-neutral-800 text-xs transition-colors"
                    title="Desvincular carpeta"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>

            {/* FILA 3: Botones de Limpieza de Duplicados, Resync Rclone e Hidratación */}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-neutral-800/50 w-full">
              {pair.engineType === 'rclone' && (
                <button
                  type="button"
                  onClick={async () => {
                    if (window.confirm('¿Deseas actualizar la base de datos .bisync de Rclone conservando la versión más reciente?')) {
                      await forceSync(pair.id);
                    }
                  }}
                  className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/35 border border-amber-500/40 text-amber-300 rounded-lg text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm"
                  title="Reconstruye la base de datos de Rclone"
                >
                  <span>🔄 Re-sincronizar Base Rclone</span>
                </button>
              )}

              {activeDedupPairs.has(pair.id) ? (
                <button
                  type="button"
                  onClick={() => handleCancelCleanDuplicates(pair.id)}
                  className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/35 border border-red-500/50 text-red-300 rounded-lg text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm animate-pulse"
                  title="Detener inmediatamente el proceso de deduplicación"
                >
                  <span>⏹️ Detener Deduplicación</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleCleanDuplicates(pair)}
                  className="px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/35 border border-purple-500/40 text-purple-300 rounded-lg text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm"
                  title="Eliminar copias duplicadas (1), (2) en disco y Google Drive"
                >
                  <span>✨ Limpiar Duplicados</span>
                 </button>
               )}

                {onCleanCloudTrash && (
                  <button
                    type="button"
                    onClick={onCleanCloudTrash}
                    disabled={isCleaningCloudJunk}
                    className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/35 border border-amber-500/40 text-amber-300 rounded-lg text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-md disabled:opacity-50"
                    title="Elimina de Google Drive los archivos que coinciden con tu lista de patrones excluidos (*.aux, *.log, etc.) sin tocar la papelera"
                  >
                    {isCleaningCloudJunk ? (
                      <>
                        <RefreshCw size={15} className="animate-spin text-amber-400" />
                        <span>⏳ Limpiando Exclusiones...</span>
                      </>
                    ) : (
                      <span>🧹 Limpiar Exclusiones en Nube</span>
                    )}
                  </button>
                )}

                {isCleaningCloudJunk && (
                  <button
                    type="button"
                    onClick={onCancelCleanCloudTrash}
                    className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/35 border border-red-500/50 text-red-300 rounded-lg text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm animate-pulse"
                    title="Detener inmediatamente la eliminación de archivos excluidos en Google Drive"
                  >
                    <RefreshCw size={15} className="animate-spin text-red-400" />
                    <span>⏹️ Detener Limpieza Exclusiones</span>
                  </button>
                )}

               {pair.syncMode === 'streaming' ? (
                <button
                  onClick={() => handleHydrate(pair.id)}
                  className="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-300 rounded-lg text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm"
                >
                  <span>📥 Hidratar para Offline</span>
                </button>
              ) : (
                <button
                  onClick={() => handleDehydrate(pair.id)}
                  className="px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/35 border border-amber-500/40 text-amber-300 rounded-lg text-xs font-semibold transition-colors flex items-center space-x-1.5 shadow-sm"
                >
                  <span>🧹 Liberar Espacio (Deshidratar)</span>
                </button>
              )}
            </div>

            {/* FILA 4: Barra de Progreso Individual */}
            <SyncProgressBar progress={pair.progress} status={pair.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

function GoogleDriveFolderModal({ isOpen, onClose, onSelect }: { isOpen: boolean; onClose: () => void; onSelect: (path: string) => void }) {
  const [currentFolderId, setCurrentFolderId] = useState('root');
  const [folderStack, setFolderStack] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'Mi Unidad' }]);
  const [folders, setFolders] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadFolders(currentFolderId);
    }
  }, [isOpen, currentFolderId]);

  const loadFolders = async (folderId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listFolders(folderId);
      setFolders(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error cargando carpetas de Google Drive');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenFolder = (folder: DriveFile) => {
    setFolderStack([...folderStack, { id: folder.id, name: folder.name }]);
    setCurrentFolderId(folder.id);
  };

  const handleBreadcrumbClick = (index: number) => {
    const nextStack = folderStack.slice(0, index + 1);
    setFolderStack(nextStack);
    setCurrentFolderId(nextStack[nextStack.length - 1].id);
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    setCreating(true);
    try {
      const newFolder = await createFolder(currentFolderId, newFolderName.trim());
      setFolders([...folders, newFolder].sort((a, b) => a.name.localeCompare(b.name)));
      setNewFolderName('');
      setShowNewFolder(false);
    } catch (err: any) {
      alert(`Error creando carpeta en Google Drive: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleConfirmSelection = () => {
    const pathParts = folderStack.slice(1).map(f => f.name);
    const fullPath = pathParts.length > 0 ? `GoogleDrive:/${pathParts.join('/')}` : 'GoogleDrive:/';
    onSelect(fullPath);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-neutral-900 border border-neutral-700/80 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
        <div className="p-5 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/80">
          <div className="flex items-center space-x-2.5">
            <Cloud className="text-blue-400" size={22} />
            <div>
              <h3 className="text-base font-medium text-white">Explorador de Google Drive</h3>
              <p className="text-[11px] text-neutral-400">Navega y elige una carpeta de tu nube como destino</p>
            </div>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-white p-1.5 rounded-lg hover:bg-neutral-800 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Breadcrumb Trail */}
        <div className="px-5 py-3 bg-neutral-950/40 border-b border-neutral-800 flex items-center flex-wrap gap-1 text-xs text-neutral-300">
          {folderStack.map((item, index) => (
            <React.Fragment key={item.id}>
              {index > 0 && <span className="text-neutral-600 px-0.5">/</span>}
              <button
                onClick={() => handleBreadcrumbClick(index)}
                className={`px-2.5 py-1 rounded-md transition-colors ${index === folderStack.length - 1 ? 'font-semibold text-blue-400 bg-blue-500/15 border border-blue-500/30' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
              >
                {item.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* Create Folder Bar */}
        <div className="px-5 py-2.5 bg-neutral-950/20 border-b border-neutral-800/80 flex items-center justify-between">
          {!showNewFolder ? (
            <button
              onClick={() => setShowNewFolder(true)}
              className="text-xs text-blue-400 hover:text-blue-300 flex items-center space-x-1.5 font-medium transition-colors p-1"
            >
              <Plus size={15} />
              <span>Nueva Carpeta en esta ubicación</span>
            </button>
          ) : (
            <form onSubmit={handleCreateFolder} className="flex items-center space-x-2 w-full py-0.5">
              <input
                type="text"
                placeholder="Nombre para la nueva carpeta..."
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                autoFocus
                className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
              />
              <button type="submit" disabled={creating || !newFolderName.trim()} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium disabled:opacity-50 flex items-center">
                {creating ? <RefreshCw size={12} className="animate-spin mr-1" /> : 'Crear'}
              </button>
              <button type="button" onClick={() => setShowNewFolder(false)} className="px-2 py-1 text-neutral-400 hover:text-white text-xs">
                Cancelar
              </button>
            </form>
          )}
        </div>

        {/* Folder List Content */}
        <div className="p-4 overflow-y-auto flex-1 min-h-[260px] max-h-[380px] bg-neutral-900/50">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-56 text-neutral-400 text-sm">
              <RefreshCw size={26} className="animate-spin text-blue-400 mb-3" />
              <span>Sincronizando carpetas con tu Google Drive...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-56 text-red-400 text-sm p-4 text-center">
              <AlertCircle size={28} className="mb-2.5 text-amber-400 animate-bounce" />
              <span className="max-w-xs text-xs sm:text-sm text-neutral-300 mb-2">{error}</span>
              {(error.includes('401') || error.toLowerCase().includes('expirad') || error.toLowerCase().includes('autentic') || error.toLowerCase().includes('unauthorized')) ? (
                <button
                  onClick={async () => {
                    try {
                      setLoading(true);
                      setError(null);
                      const res = await googleSignIn();
                      if (res && res.accessToken) {
                        await syncService.setToken(res.accessToken);
                        await loadFolders(currentFolderId);
                      }
                    } catch (e: any) {
                      setError(e.message || 'Error en reautenticación');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  className="mt-3 px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-blue-500/30 flex items-center space-x-2 active:scale-95 border border-blue-400/30"
                >
                  <LogIn size={16} />
                  <span>Re-conectar Google Drive Ahora</span>
                </button>
              ) : (
                <button onClick={() => loadFolders(currentFolderId)} className="mt-3 px-4 py-2 bg-neutral-800 text-white rounded-xl text-xs font-medium hover:bg-neutral-700 transition-colors">
                  Reintentar lectura
                </button>
              )}
            </div>
          ) : folders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-56 text-neutral-500 text-sm text-center p-6">
              <Folder size={36} className="mb-2.5 opacity-30 text-blue-400" />
              <span className="text-neutral-300 font-medium">No hay subcarpetas dentro de {folderStack[folderStack.length - 1].name}</span>
              <span className="text-xs text-neutral-500 mt-1">Puedes crear una nueva arriba o seleccionar esta ubicación como destino.</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              {folders.map(folder => (
                <div
                  key={folder.id}
                  onClick={() => handleOpenFolder(folder)}
                  className="flex items-center justify-between p-3 rounded-xl hover:bg-neutral-800/80 cursor-pointer text-sm text-neutral-200 transition-all border border-transparent hover:border-neutral-700/50 group"
                >
                  <div className="flex items-center space-x-3.5 truncate">
                    <div className="p-1.5 rounded-lg bg-blue-500/10 text-blue-400 group-hover:bg-blue-500/20 transition-colors">
                      <Folder size={18} />
                    </div>
                    <span className="truncate font-medium group-hover:text-white">{folder.name}</span>
                  </div>
                  <span className="text-xs text-neutral-500 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center bg-neutral-950 px-2 py-1 rounded border border-neutral-800">
                    <span>Explorar</span>
                    <ArrowLeftRight size={12} className="ml-1 rotate-90 text-blue-400" />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-neutral-800 bg-neutral-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
          <div className="text-xs text-neutral-300 truncate font-mono bg-neutral-900 px-3 py-2 rounded-xl border border-neutral-800/80 shadow-inner">
            Destino: <span className="font-mono text-blue-400 font-bold">{folderStack[folderStack.length - 1].name}</span>
          </div>
          <div className="flex items-center justify-end space-x-2.5 shrink-0">
            <button onClick={onClose} type="button" className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 transition-colors">
              Cancelar
            </button>
            <button onClick={handleConfirmSelection} type="button" className="px-4 sm:px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-xs sm:text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-600/35 flex items-center space-x-2 active:scale-95">
              <CheckCircle2 size={16} className="shrink-0" />
              <span>Seleccionar esta carpeta</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LocalFolderModal({
  isOpen,
  onClose,
  onSelect,
  initialPath
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath: string;
}) {
  const [currentPath, setCurrentPath] = useState(initialPath || (VFSBridge.isNative() ? '/storage/emulated/0/Documents' : VFSBridge.getHomeDir() + '/Documentos'));
  const [folders, setFolders] = useState<Array<{ name: string; path: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  const shortcuts = VFSBridge.isNative()
    ? [
      { label: '📄 Documents', path: '/storage/emulated/0/Documents' },
      { label: '⭐ StarNote Export', path: '/storage/emulated/0/Documents/StarNote/export' },
      { label: '📥 Download', path: '/storage/emulated/0/Download' },
      { label: '💾 Raíz Almacenamiento', path: '/storage/emulated/0' }
    ]
    : [
      { label: '📁 Documentos', path: VFSBridge.getHomeDir() + '/Documentos' },
      { label: '📑 Apuntes Tablet StarNote', path: VFSBridge.getHomeDir() + '/Documentos/Apuntes_Tablet_StarNote' },
      { label: '📥 Descargas', path: VFSBridge.getHomeDir() + '/Descargas' },
      { label: '🏠 Home', path: VFSBridge.getHomeDir() }
    ];

  useEffect(() => {
    if (isOpen) {
      loadDirectories(currentPath);
    }
  }, [isOpen, currentPath]);

  const loadDirectories = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await VFSBridge.listLocalDirectories(path);
      setFolders(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'No se pudo acceder al directorio');
    } finally {
      setLoading(false);
    }
  };

  const handleGoUp = () => {
    const parts = currentPath.replace(/\/$/, '').split('/');
    if (parts.length > 1 && (currentPath !== '/storage/emulated/0' && currentPath !== '/')) {
      parts.pop();
      const parent = parts.join('/') || '/';
      setCurrentPath(parent);
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    setCreating(true);
    const targetPath = `${currentPath.replace(/\/$/, '')}/${newFolderName.trim()}`;
    const ok = await VFSBridge.createLocalDirectory(targetPath);
    setCreating(false);
    if (ok) {
      setNewFolderName('');
      setShowNewFolder(false);
      setCurrentPath(targetPath);
    } else {
      alert('Error creando carpeta en el dispositivo.');
    }
  };

  const handleConfirm = () => {
    onSelect(currentPath);
    onClose();
  };

  if (!isOpen) return null;

  const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
  const canGoUp = parentPath && parentPath !== '' && currentPath !== '/storage/emulated/0' && currentPath !== '/';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/50">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Folder size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Seleccionar Carpeta Local</h3>
              <p className="text-xs text-neutral-400">Dispositivo ({VFSBridge.getDeviceLabel()})</p>
            </div>
          </div>
          <button onClick={onClose} type="button" className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Shortcuts Bar */}
        <div className="p-2.5 bg-neutral-950 border-b border-neutral-800/80 flex items-center gap-1.5 overflow-x-auto">
          {shortcuts.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setCurrentPath(s.path)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors border ${currentPath === s.path || currentPath.startsWith(s.path + '/')
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                : 'bg-neutral-900 text-neutral-300 border-neutral-800 hover:bg-neutral-800'
                }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Current Path & Up button */}
        <div className="px-4 py-2 bg-neutral-900/80 border-b border-neutral-800 flex items-center justify-between gap-2">
          <div className="flex items-center space-x-2 flex-1 truncate font-mono text-xs text-emerald-400 bg-neutral-950 px-3 py-1.5 rounded-lg border border-neutral-800/80">
            <Folder size={14} className="text-neutral-500 shrink-0" />
            <span className="truncate" title={currentPath}>{currentPath}</span>
          </div>
          {canGoUp && (
            <button
              onClick={handleGoUp}
              type="button"
              className="px-2.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg text-xs flex items-center space-x-1 transition-colors shrink-0 font-medium"
            >
              <span>Subir ⬆</span>
            </button>
          )}
        </div>

        {/* New Folder Action Bar */}
        <div className="px-4 py-2 bg-neutral-950/40 border-b border-neutral-800/80 flex items-center justify-between">
          {!showNewFolder ? (
            <button
              type="button"
              onClick={() => setShowNewFolder(true)}
              className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center space-x-1.5 font-medium transition-colors"
            >
              <Plus size={15} />
              <span>Nueva Carpeta en esta ubicación</span>
            </button>
          ) : (
            <form onSubmit={handleCreateFolder} className="flex items-center space-x-2 w-full">
              <input
                type="text"
                placeholder="Nombre para nueva carpeta..."
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                autoFocus
                className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1 text-xs text-white focus:outline-none focus:border-emerald-500 font-mono"
              />
              <button type="submit" disabled={creating || !newFolderName.trim()} className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium disabled:opacity-50">
                {creating ? 'Creando...' : 'Crear'}
              </button>
              <button type="button" onClick={() => setShowNewFolder(false)} className="px-2 py-1 text-neutral-400 hover:text-white text-xs">
                Cancelar
              </button>
            </form>
          )}
        </div>

        {/* Folder List Content */}
        <div className="p-4 overflow-y-auto flex-1 min-h-[240px] max-h-[340px] bg-neutral-900/50">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 text-neutral-400 text-sm">
              <RefreshCw size={24} className="animate-spin text-emerald-400 mb-3" />
              <span>Leyendo directorio local...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-48 text-red-400 text-xs p-4 text-center">
              <AlertCircle size={24} className="mb-2" />
              <span>{error}</span>
              <button onClick={() => loadDirectories(currentPath)} type="button" className="mt-3 px-3 py-1 bg-neutral-800 text-white rounded-lg hover:bg-neutral-700">
                Reintentar
              </button>
            </div>
          ) : folders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-neutral-500 text-sm text-center p-6">
              <Folder size={32} className="mb-2 opacity-30 text-emerald-400" />
              <span className="text-neutral-300 font-medium">No hay subcarpetas en este directorio</span>
              <span className="text-xs text-neutral-500 mt-1">Puedes crear una nueva arriba o seleccionar esta ubicación como ruta local.</span>
            </div>
          ) : (
            <div className="space-y-1">
              {folders.map((f, idx) => (
                <div
                  key={idx}
                  onClick={() => setCurrentPath(f.path)}
                  className="flex items-center justify-between p-3 rounded-xl hover:bg-neutral-800/80 cursor-pointer text-sm text-neutral-200 transition-all border border-transparent hover:border-neutral-700/50 group"
                >
                  <div className="flex items-center space-x-3 truncate">
                    <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20 transition-colors">
                      <Folder size={18} />
                    </div>
                    <span className="truncate font-medium group-hover:text-white">{f.name}</span>
                  </div>
                  <span className="text-xs text-neutral-500 opacity-0 group-hover:opacity-100 transition-opacity bg-neutral-950 px-2 py-1 rounded border border-neutral-800">
                    Abrir ➔
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-neutral-800 bg-neutral-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
          <div className="text-xs text-neutral-300 truncate font-mono bg-neutral-900 px-3 py-2 rounded-xl border border-neutral-800/80 shadow-inner">
            Elegido: <span className="font-mono text-emerald-400 font-bold">{currentPath.split('/').pop() || currentPath}</span>
          </div>
          <div className="flex items-center justify-end space-x-2.5 shrink-0">
            <button onClick={onClose} type="button" className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 transition-colors">
              Cancelar
            </button>
            <button onClick={handleConfirm} type="button" className="px-4 sm:px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs sm:text-sm font-bold rounded-xl transition-all shadow-lg shadow-emerald-600/35 flex items-center space-x-2 active:scale-95">
              <CheckCircle2 size={16} className="shrink-0" />
              <span>Usar esta carpeta local</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddPairForm({ onAdd, onCancel }: { onAdd: (p: SyncPair) => void, onCancel: () => void }) {
  // Inicializar vacíos para evitar folder "hardcodeada" al crear un nuevo par
  const [local, setLocal] = useState('');
  const [remote, setRemote] = useState('');
  const [direction, setDirection] = useState<SyncDirection>('bidirectional');
  const [syncMode, setSyncMode] = useState<SyncMode>('mirror');
  const [cloudCategory, setCloudCategory] = useState<CloudCategory>('shared');
  const [engineType, setEngineType] = useState<EngineType>('native');
  const [rcloneOperation, setRcloneOperation] = useState<RcloneOp>('bisync');
  const [showDriveModal, setShowDriveModal] = useState(false);
  const [showLocalModal, setShowLocalModal] = useState(false);

  const handleBrowse = async () => {
    try {
      const selected = await VFSBridge.selectLocalFolder();
      if (selected) {
        setLocal(selected);
        setCloudCategory(VFSBridge.getDefaultCloudCategory(selected));
        return;
      }
    } catch (e) {
      console.error('[VFSBridge] Error al seleccionar carpeta local:', e);
    }
    setShowLocalModal(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!local || !remote) {
      alert('Selecciona una carpeta local y una carpeta remota antes de crear el par.');
      return;
    }
    onAdd({
      id: Math.random().toString(36).substr(2, 9),
      localPath: local,
      remotePath: remote,
      direction,
      syncMode,
      cloudCategory,
      engineType,
      rcloneOperation,
      deviceName: VFSBridge.getDeviceLabel(),
      status: 'idle',
      lastSynced: null
    });
  };

  return (
    <form onSubmit={handleSubmit} className="bg-neutral-900/95 border border-neutral-700/80 rounded-2xl p-4 sm:p-7 mb-8 shadow-2xl space-y-7 relative overflow-hidden backdrop-blur-xl transition-all animate-fadeIn">
      {/* Cabecera del Configurador */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-5 border-b border-neutral-800 gap-3">
        <div className="flex items-center space-x-3.5">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/30 shrink-0">
            <FolderSync size={24} className="animate-pulse" />
          </div>
          <div>
            <h3 className="text-lg sm:text-xl font-bold text-white tracking-wide">Configurar Nuevo Enlace de Sincronización</h3>
            <p className="text-xs sm:text-sm text-neutral-400">Enlaza una carpeta de tu dispositivo con Google Drive y define las reglas del flujo de datos.</p>
          </div>
        </div>
        <span className="inline-flex items-center self-start sm:self-auto px-3 py-1 rounded-full text-[11px] font-mono font-bold bg-blue-500/10 text-blue-300 border border-blue-500/30 shrink-0 shadow-sm">
          ⚡ CONFIGURACIÓN INTELIGENTE
        </span>
      </div>

      {/* Sección 1: Tarjetas de Rutas Local & Nube */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-400 flex items-center space-x-2">
          <HardDrive size={15} className="text-blue-400" />
          <span>1. Definir Ubicaciones de Origen y Destino</span>
        </h4>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Tarjeta Disco Local */}
          <div className="bg-gradient-to-b from-emerald-950/40 to-neutral-950/90 border border-emerald-500/40 hover:border-emerald-500/60 rounded-2xl p-4 sm:p-5 flex flex-col justify-between transition-all shadow-lg space-y-4 group">
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <span className="flex items-center space-x-2 text-xs sm:text-sm font-bold tracking-wide text-emerald-400">
                  <HardDrive size={17} className="text-emerald-400 shrink-0" />
                  <span>Carpeta Local ({VFSBridge.getDeviceLabel()})</span>
                </span>
                <span className="text-[10px] bg-emerald-500/15 text-emerald-300 px-2.5 py-0.5 rounded-full border border-emerald-500/30 font-mono font-semibold">
                  Almacenamiento Físico
                </span>
              </div>
              <p className="text-xs text-neutral-300 leading-relaxed mb-3">
                Directorio físico donde tus apps (ej. StarNote en Tablet) crean y guardan tus documentos o apuntes en PDF.
              </p>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Folder size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-emerald-400 shrink-0" />
                  <input
                    type="text"
                    value={local}
                    onChange={e => { setLocal(e.target.value); setCloudCategory(VFSBridge.getDefaultCloudCategory(e.target.value)); }}
                    placeholder="/storage/emulated/0/..."
                    className="w-full bg-neutral-950/90 border border-neutral-700 rounded-xl pl-10 pr-3.5 py-2.5 text-xs sm:text-sm text-white font-mono focus:outline-none focus:border-emerald-500 shadow-inner transition-colors"
                    required
                  />
                </div>
                <button
                  type="button"
                  onClick={handleBrowse}
                  className="px-4 py-2.5 sm:py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl flex items-center justify-center sm:justify-start space-x-2 text-xs sm:text-sm transition-all shrink-0 shadow-md shadow-emerald-900/40 active:scale-95"
                  title="Abrir explorador visual de carpetas en tu teléfono o tablet"
                >
                  <Folder size={16} />
                  <span>Examinar Disco</span>
                </button>
              </div>
            </div>

            {/* Atajos Rápidos */}
            <div className="pt-3 border-t border-emerald-900/40 flex items-center flex-wrap gap-2">
              <span className="text-[11px] font-semibold text-emerald-400/90">⚡ Atajos veloces:</span>
              <button
                type="button"
                onClick={() => {
                  const p = VFSBridge.isNative() ? '/storage/emulated/0/Documents/StarNote/export' : VFSBridge.getHomeDir() + '/Documentos/Apuntes_Tablet_StarNote';
                  setLocal(p);
                  setCloudCategory(VFSBridge.getDefaultCloudCategory(p));
                }}
                className="px-3 py-1 rounded-lg text-xs font-mono font-bold bg-emerald-500/20 hover:bg-emerald-500/35 text-emerald-300 border border-emerald-500/40 transition-all shadow-sm truncate max-w-full"
                title="Ruta oficial de exportación de StarNote PDF"
              >
                ⭐ Apuntes StarNote
              </button>
              {VFSBridge.isNative() ? (
                <button
                  type="button"
                  onClick={() => { setLocal('/storage/emulated/0/Documents'); setCloudCategory('computers'); }}
                  className="px-2.5 py-1 rounded-lg text-xs font-mono font-semibold bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700 transition-colors"
                >
                  📄 Documents
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setLocal(VFSBridge.getHomeDir() + '/Documentos'); setCloudCategory('computers'); }}
                  className="px-2.5 py-1 rounded-lg text-xs font-mono font-semibold bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700 transition-colors"
                >
                  📁 Documentos Linux
                </button>
              )}
            </div>
          </div>

          {/* Tarjeta Google Drive */}
          <div className="bg-gradient-to-b from-blue-950/40 to-neutral-950/90 border border-blue-500/40 hover:border-blue-500/60 rounded-2xl p-4 sm:p-5 flex flex-col justify-between transition-all shadow-lg space-y-4 group">
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <span className="flex items-center space-x-2 text-xs sm:text-sm font-bold tracking-wide text-blue-400">
                  <Cloud size={17} className="text-blue-400 shrink-0" />
                  <span>Ruta Remota en Google Drive</span>
                </span>
                <span className="text-[10px] bg-blue-500/15 text-blue-300 px-2.5 py-0.5 rounded-full border border-blue-500/30 font-mono font-semibold">
                  Nube Google
                </span>
              </div>
              <p className="text-xs text-neutral-300 leading-relaxed mb-3">
                Ubicación en tu Google Drive donde se clonarán tus archivos. Las carpetas inexistentes se crearán automáticamente.
              </p>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Cloud size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-blue-400 shrink-0" />
                  <input
                    type="text"
                    value={remote}
                    onChange={e => setRemote(e.target.value)}
                    placeholder="GoogleDrive:/..."
                    className="w-full bg-neutral-950/90 border border-neutral-700 rounded-xl pl-10 pr-3.5 py-2.5 text-xs sm:text-sm text-white font-mono focus:outline-none focus:border-blue-500 shadow-inner transition-colors"
                    required
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowDriveModal(true)}
                  className="px-4 py-2.5 sm:py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl flex items-center justify-center sm:justify-start space-x-2 text-xs sm:text-sm transition-all shrink-0 shadow-md shadow-blue-900/40 active:scale-95"
                  title="Examinar carpetas directamente en tu Google Drive en la nube"
                >
                  <Cloud size={16} />
                  <span>Explorar Nube</span>
                </button>
              </div>
            </div>

            {/* Atajos Remoto */}
            <div className="pt-3 border-t border-blue-900/40 flex items-center flex-wrap gap-2">
              <span className="text-[11px] font-semibold text-blue-400/90">☁️ Ruta oficial:</span>
              <button
                type="button"
                onClick={() => setRemote('GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote')}
                className="px-3 py-1 rounded-lg text-xs font-mono font-bold bg-blue-500/20 hover:bg-blue-500/35 text-blue-300 border border-blue-500/40 transition-all shadow-sm truncate max-w-full"
                title="Asignar la ruta colaborativa oficial Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote"
              >
                📑 Documentos-Ubuntu-Fayfer/.../StarNote
              </button>
            </div>
          </div>
        </div>
      </div>

      <GoogleDriveFolderModal isOpen={showDriveModal} onClose={() => setShowDriveModal(false)} onSelect={path => setRemote(path)} />
      <LocalFolderModal isOpen={showLocalModal} onClose={() => setShowLocalModal(false)} onSelect={path => { setLocal(path); setCloudCategory(VFSBridge.getDefaultCloudCategory(path)); }} initialPath={local} />

      {/* Sección 2: Dirección y Flujo de la Sincronización */}
      <div className="bg-neutral-950/70 border border-neutral-800 rounded-2xl p-4 sm:p-6 space-y-4 shadow-inner">
        <div className="flex items-center space-x-2 text-white">
          <ArrowLeftRight size={18} className="text-indigo-400 shrink-0" />
          <h4 className="text-xs font-bold uppercase tracking-widest text-indigo-300">2. Dirección del Flujo de Sincronización</h4>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className={`p-4 sm:p-5 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between text-left relative overflow-hidden ${direction === 'bidirectional' ? 'border-blue-500 bg-gradient-to-b from-blue-500/20 to-neutral-900/90 text-white shadow-xl shadow-blue-500/10' : 'border-neutral-800 bg-neutral-900/50 hover:border-neutral-700 hover:bg-neutral-900 text-neutral-400'}`}>
            <div>
              <div className="flex items-center justify-between w-full mb-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${direction === 'bidirectional' ? 'bg-blue-500 text-white font-bold shadow-md shadow-blue-500/40' : 'bg-neutral-800 text-neutral-400'}`}>
                  <ArrowLeftRight size={18} />
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase ${direction === 'bidirectional' ? 'bg-blue-500/30 text-blue-300 border border-blue-400/30' : 'bg-neutral-800 text-neutral-500'}`}>
                  ★ RECOMENDADA
                </span>
              </div>
              <input type="radio" className="sr-only" checked={direction === 'bidirectional'} onChange={() => setDirection('bidirectional')} />
              <span className="text-sm sm:text-base font-bold text-white block mb-1.5">Bidireccional (Espejo en Vivo)</span>
              <p className="text-xs text-neutral-300 leading-relaxed">
                Mantiene tus apuntes idénticos en tu Tablet y PC simultáneamente. Ediciones en cualquiera de los dos extremos se propagan al instante.
              </p>
            </div>
          </label>

          <label className={`p-4 sm:p-5 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between text-left relative overflow-hidden ${direction === 'upload' ? 'border-blue-500 bg-gradient-to-b from-blue-500/20 to-neutral-900/90 text-white shadow-xl shadow-blue-500/10' : 'border-neutral-800 bg-neutral-900/50 hover:border-neutral-700 hover:bg-neutral-900 text-neutral-400'}`}>
            <div>
              <div className="flex items-center justify-between w-full mb-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${direction === 'upload' ? 'bg-blue-500 text-white font-bold shadow-md shadow-blue-500/40' : 'bg-neutral-800 text-neutral-400'}`}>
                  <Upload size={18} />
                </div>
                <span className="text-[10px] bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded font-mono">
                  SOLO SUBIDA
                </span>
              </div>
              <input type="radio" className="sr-only" checked={direction === 'upload'} onChange={() => setDirection('upload')} />
              <span className="text-sm sm:text-base font-bold text-white block mb-1.5">Respaldo a Nube (Upload Only)</span>
              <p className="text-xs text-neutral-300 leading-relaxed">
                Sube una copia exacta de tu carpeta local hacia Google Drive. Nunca descargará ni modificará los ficheros locales si cambian en Drive.
              </p>
            </div>
          </label>

          <label className={`p-4 sm:p-5 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between text-left relative overflow-hidden ${direction === 'download' ? 'border-blue-500 bg-gradient-to-b from-blue-500/20 to-neutral-900/90 text-white shadow-xl shadow-blue-500/10' : 'border-neutral-800 bg-neutral-900/50 hover:border-neutral-700 hover:bg-neutral-900 text-neutral-400'}`}>
            <div>
              <div className="flex items-center justify-between w-full mb-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${direction === 'download' ? 'bg-blue-500 text-white font-bold shadow-md shadow-blue-500/40' : 'bg-neutral-800 text-neutral-400'}`}>
                  <Download size={18} />
                </div>
                <span className="text-[10px] bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded font-mono">
                  SOLO BAJADA
                </span>
              </div>
              <input type="radio" className="sr-only" checked={direction === 'download'} onChange={() => setDirection('download')} />
              <span className="text-sm sm:text-base font-bold text-white block mb-1.5">Descarga Continua (Download Only)</span>
              <p className="text-xs text-neutral-300 leading-relaxed">
                Reemplaza tu contenido local descargando siempre desde Google Drive. Perfecto para clonar archivos generados en otra PC.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Sección 3: Opciones Avanzadas del Motor y Nube */}
      <div className="space-y-4 pt-2">
        <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-400 flex items-center space-x-2">
          <Settings size={15} className="text-emerald-400" />
          <span>3. Opciones Avanzadas de Almacenamiento y Categoría Drive</span>
        </h4>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Modo Almacenamiento */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-2xl p-4 sm:p-5 flex flex-col justify-between">
            <div>
              <label className="block text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Modo de Almacenamiento Local</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <button
                  type="button"
                  onClick={() => setSyncMode('mirror')}
                  className={`p-4 rounded-xl border-2 text-left transition-all relative overflow-hidden flex flex-col justify-between ${syncMode === 'mirror' ? 'border-emerald-500 bg-gradient-to-b from-emerald-500/20 to-neutral-900 text-emerald-300 shadow-md' : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:bg-neutral-900'}`}
                >
                  <div>
                    <div className="font-bold text-xs sm:text-sm mb-1.5 flex items-center gap-2 text-white">
                      <span className="text-base">🔄</span>
                      <span>Duplicado (1:1)</span>
                    </div>
                    <p className="text-xs text-neutral-300 leading-relaxed">
                      Archivos reales en disco, velocidad instantánea SSD y disponibles 100% offline.
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setSyncMode('streaming')}
                  className={`p-4 rounded-xl border-2 text-left transition-all relative overflow-hidden flex flex-col justify-between ${syncMode === 'streaming' ? 'border-blue-500 bg-gradient-to-b from-blue-500/20 to-neutral-900 text-blue-300 shadow-md' : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:bg-neutral-900'}`}
                >
                  <div>
                    <div className="font-bold text-xs sm:text-sm mb-1.5 flex items-center gap-2 text-white">
                      <span className="text-base">☁️</span>
                      <span>Streaming Virtual</span>
                    </div>
                    <p className="text-xs text-neutral-300 leading-relaxed">
                      Crea stubs ligeros de 1KB en disco, descargando el archivo completo solo cuando lo abres.
                    </p>
                  </div>
                </button>
              </div>
            </div>
          </div>

          {/* Categoría Google Drive */}
          <div className="bg-neutral-950/60 border border-neutral-800 rounded-2xl p-4 sm:p-5 flex flex-col justify-between">
            <div>
              <label className="block text-xs font-bold text-neutral-300 uppercase tracking-wider mb-3">Estructura en Google Drive</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <button
                  type="button"
                  onClick={() => setCloudCategory('shared')}
                  className={`p-4 rounded-xl border-2 text-left transition-all relative overflow-hidden flex flex-col justify-between ${cloudCategory === 'shared' ? 'border-blue-500 bg-gradient-to-b from-blue-500/20 to-neutral-900 text-blue-300 shadow-md' : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:bg-neutral-900'}`}
                >
                  <div>
                    <div className="font-bold text-xs sm:text-sm mb-1.5 flex items-center gap-2 text-white">
                      <span className="text-base">🌐</span>
                      <span>Mi Unidad (Multi-Equipo)</span>
                    </div>
                    <p className="text-xs text-neutral-300 leading-relaxed">
                      Enlaza directo en tu nube para compartir notas entre Tablet Android ↔ Ubuntu en tiempo real.
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setCloudCategory('computers')}
                  className={`p-4 rounded-xl border-2 text-left transition-all relative overflow-hidden flex flex-col justify-between ${cloudCategory === 'computers' ? 'border-indigo-500 bg-gradient-to-b from-indigo-500/20 to-neutral-900 text-indigo-300 shadow-md' : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:bg-neutral-900'}`}
                >
                  <div>
                    <div className="font-bold text-xs sm:text-sm mb-1.5 flex items-center gap-2 text-white">
                      <span className="text-base">💻</span>
                      <span>Sección 'Ordenadores'</span>
                    </div>
                    <p className="text-xs text-neutral-300 leading-relaxed">
                      Respaldo oficial aislado bajo Ordenadores ➔ {VFSBridge.getDeviceLabel()}.
                    </p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* NUEVA SECCIÓN: Selección de Motor de Sincronización */}
      <div className="bg-neutral-950/70 border border-neutral-800 rounded-2xl p-4 sm:p-6 space-y-4 shadow-inner">
        <div className="flex items-center space-x-2 text-white">
          <Layers size={18} className="text-amber-400 shrink-0" />
          <h4 className="text-xs font-bold uppercase tracking-widest text-amber-300">
            3. Seleccionar Motor de Sincronización (R14)
          </h4>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className={`p-4 sm:p-5 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between text-left relative overflow-hidden ${
            engineType === 'native'
              ? 'border-blue-500 bg-gradient-to-b from-blue-500/20 to-neutral-900/90 text-white shadow-xl shadow-blue-500/10'
              : 'border-neutral-800 bg-neutral-900/50 hover:border-neutral-700 hover:bg-neutral-900 text-neutral-400'
          }`}>
            <div>
              <div className="flex items-center justify-between w-full mb-3">
                <span className="font-bold text-sm text-white flex items-center gap-2">
                  <span>⚡ Motor Nativo V2</span>
                </span>
                <span className="text-[10px] bg-blue-500/30 text-blue-200 border border-blue-400/30 px-2 py-0.5 rounded font-mono font-bold">
                  NATIVO + SQLITE
                </span>
              </div>
              <input type="radio" name="engineType" className="sr-only" checked={engineType === 'native'} onChange={() => setEngineType('native')} />
              <p className="text-xs text-neutral-300 leading-relaxed">
                Utiliza la API v3 oficial de Google Drive y SQLite WAL local. Ofrece detección de cambios instantánea vía Firebase RTDB y sanado atómico 404.
              </p>
            </div>
          </label>

          <label className={`p-4 sm:p-5 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between text-left relative overflow-hidden ${
            engineType === 'rclone'
              ? 'border-amber-500 bg-gradient-to-b from-amber-500/20 to-neutral-900/90 text-white shadow-xl shadow-amber-500/10'
              : 'border-neutral-800 bg-neutral-900/50 hover:border-neutral-700 hover:bg-neutral-900 text-neutral-400'
          }`}>
            <div>
              <div className="flex items-center justify-between w-full mb-3">
                <span className="font-bold text-sm text-white flex items-center gap-2">
                  <span>🚀 Motor Rclone CLI</span>
                </span>
                <span className="text-[10px] bg-amber-500/30 text-amber-200 border border-amber-400/30 px-2 py-0.5 rounded font-mono font-bold">
                  AUTÓNOMO (RCLONE)
                </span>
              </div>
              <input type="radio" name="engineType" className="sr-only" checked={engineType === 'rclone'} onChange={() => setEngineType('rclone')} />
              <p className="text-xs text-neutral-300 leading-relaxed">
                Ejecuta el binario oficial de Rclone (`bisync` / `sync`) mediante un proceso CLI hijo totalmente independiente. Requiere tener Rclone instalado en el sistema.
              </p>
            </div>
          </label>
        </div>

        {/* Si selecciona Rclone, mostrar opción de modo de operación Rclone */}
        {engineType === 'rclone' && (
          <div className="pt-3 border-t border-neutral-800/80 flex items-center gap-4">
            <label className="text-xs font-bold text-neutral-300 font-mono">Modo Operativo Rclone:</label>
            <select
              value={rcloneOperation}
              onChange={e => setRcloneOperation(e.target.value as RcloneOp)}
              className="bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-amber-500"
            >
              <option value="bisync">bisync (Sincronización Bidireccional Rclone)</option>
              <option value="sync">sync (Clonar Local a Remoto)</option>
              <option value="copy">copy (Copiar Archivos Nuevos)</option>
            </select>
          </div>
        )}
      </div>

      {/* Pie de Acciones */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6 border-t border-neutral-800">
        <p className="text-xs text-neutral-400 italic text-center sm:text-left flex items-center space-x-1">
          <span>💡 <strong className="text-neutral-200 font-normal">Tip:</strong> Puedes alternar entre el Motor Nativo V2 y Rclone en cualquier momento.</span>
        </p>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-5 py-3 text-xs sm:text-sm font-bold text-neutral-300 hover:text-white bg-neutral-800/80 hover:bg-neutral-700 border border-neutral-700 rounded-xl transition-all text-center"
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="px-6 py-3 bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500 hover:from-blue-500 hover:to-indigo-500 text-white text-xs sm:text-sm font-bold rounded-xl transition-all shadow-xl shadow-blue-500/30 flex items-center justify-center space-x-2.5 active:scale-95 border border-blue-400/30"
          >
            <Plus size={18} className="stroke-[3]" />
            <span>Confirmar y Vincular Carpeta</span>
          </button>
        </div>
      </div>
    </form>
  );
}

function ActivityTab({ events, pairs }: { events: SyncEvent[], pairs: SyncPair[] }) {
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 25;

  const filteredEvents = events.filter(e => {
    if (filter !== 'all' && e.action !== filter) return false;
    if (search && !e.filename.toLowerCase().includes(search.toLowerCase()) && !(e.details && e.details.toLowerCase().includes(search.toLowerCase()))) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredEvents.length / pageSize));
  const displayedEvents = filteredEvents.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setCurrentPage(1);
  }, [filter, search]);

  // Helper para renderizar la insignia de estado / acción de forma 100% precisa
  const renderStatusBadge = (event: SyncEvent, pair?: SyncPair) => {
    const isCurrentActiveFile = pair?.progress?.currentFile === event.filename;
    const activeAction = pair?.progress?.action;

    if (isCurrentActiveFile && activeAction === 'subiendo') {
      return (
        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-500/20 text-blue-300 border border-blue-400/50 animate-pulse shadow-sm">
          <RefreshCw size={11} className="mr-1.5 animate-spin text-blue-400" /> 🚀 Subiendo...
        </span>
      );
    }

    if (isCurrentActiveFile && activeAction === 'descargando') {
      return (
        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-400/50 animate-pulse shadow-sm">
          <RefreshCw size={11} className="mr-1.5 animate-spin text-emerald-400" /> 📥 Descargando...
        </span>
      );
    }

    switch (event.action) {
      case 'uploaded':
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-500/15 text-blue-300 border border-blue-500/30">
            ☁️ Subido a Drive
          </span>
        );
      case 'downloaded':
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            📥 Descargado
          </span>
        );
      case 'deleted':
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-red-500/15 text-red-300 border border-red-500/30">
            🗑️ Eliminado
          </span>
        );
      case 'cleaned':
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">
            ✨ Deduplicado
          </span>
        );
      case 'sync_start':
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
            🔍 Analizando
          </span>
        );
      case 'sync_end':
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            ✅ Al Día
          </span>
        );
      case 'info':
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-teal-500/15 text-teal-300 border border-teal-500/30">
            ℹ️ Registro Sistema
          </span>
        );
      case 'conflict':
      default:
        return (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm animate-pulse">
            ⚠️ Conflicto Versión
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Cabecera y Filtros */}
      <header className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-medium text-white mb-1">Registro de Actividad</h2>
          <p className="text-neutral-400 text-sm">Historial en tiempo real de transferencias, deduplicación y verificación de tus ficheros.</p>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full xl:w-auto">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              placeholder="Buscar archivo..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full sm:w-48 bg-neutral-900 border border-neutral-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-neutral-600 font-mono"
            />
          </div>

          <div className="flex flex-wrap items-center bg-neutral-900 border border-neutral-800 rounded-lg p-1 gap-1 justify-center sm:justify-start">
            <button onClick={() => setFilter('all')} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${filter === 'all' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}>Todos</button>
            <button onClick={() => setFilter('uploaded')} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${filter === 'uploaded' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}>Subidos</button>
            <button onClick={() => setFilter('downloaded')} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${filter === 'downloaded' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}>Descargas</button>
            <button onClick={() => setFilter('cleaned')} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${filter === 'cleaned' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}>Limpieza</button>
            <button onClick={() => setFilter('conflict')} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${filter === 'conflict' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}>Conflictos</button>
          </div>
        </div>
      </header>

      {/* Estado del Motor en Vivo */}
      {pairs.some(p => p.status === 'syncing' || p.progress) && (
        <div className="bg-neutral-900/90 border border-blue-500/40 rounded-xl p-4 shadow-lg shadow-blue-950/20">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-blue-300 mb-2 flex items-center">
            <Activity size={14} className="mr-2 text-blue-400 animate-pulse" /> Estado del Motor en Vivo
          </h4>
          {pairs.filter(p => p.status === 'syncing' || p.progress).map(p => (
            <SyncProgressBar key={p.id} progress={p.progress} status={p.status} />
          ))}
        </div>
      )}

      {/* Tabla Rediseñada */}
      <div className="bg-white/[0.02] backdrop-blur-md border border-white/[0.05] rounded-2xl overflow-hidden shadow-2xl">
        <table className="hidden lg:table w-full text-left text-sm table-fixed">
          <thead className="bg-neutral-950/80 border-b border-neutral-800 text-neutral-400 text-[11px] uppercase tracking-wider font-mono">
            <tr>
              <th className="px-5 py-3.5 font-semibold w-[35%]">Archivo / Origen - Destino</th>
              <th className="px-4 py-3.5 font-semibold w-[18%]">Estado / Acción</th>
              <th className="px-4 py-3.5 font-semibold w-[12%] text-right">Tamaño</th>
              <th className="px-4 py-3.5 font-semibold w-[17%] text-center">Enlace Nube</th>
              <th className="px-5 py-3.5 font-semibold w-[18%] text-right">Fecha y Hora</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {displayedEvents.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-neutral-500">
                  <Activity size={28} className="mx-auto mb-2 opacity-30 text-neutral-400" />
                  <span>{events.length === 0 ? 'Aún no se ha registrado actividad en esta sesión o el motor se está iniciando.' : 'No hay eventos que coincidan con tus criterios de filtro.'}</span>
                </td>
              </tr>
            ) : (
              displayedEvents.map(event => {
                const pair = pairs.find(p => p.id === event.pairId);
                const formattedSize = (() => {
                  if (event.size && event.size > 0) {
                    const k = 1024;
                    const sizes = ['B', 'KB', 'MB', 'GB'];
                    const i = Math.floor(Math.log(event.size) / Math.log(k));
                    return parseFloat((event.size / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                  }
                  if (event.details) {
                    const match = event.details.match(/(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB))/i);
                    if (match) return match[1];
                  }
                  return null;
                })();

                const localFolder = pair ? (pair.localPath.split('/').filter(Boolean).pop() || pair.localPath) : 'Local';
                const remoteFolder = pair ? pair.remotePath.replace(/^(GoogleDrive|Drive):/, '').replace(/^\/+/, '') : 'Drive';

                return (
                  <tr key={event.id} className="hover:bg-white/[0.03] transition-colors group">
                    {/* Archivo y Par/Contexto */}
                    <td className="px-5 py-3.5 min-w-0">
                      <div className="font-semibold text-neutral-100 truncate text-sm" title={event.filename}>
                        {event.filename}
                      </div>
                      <div className="text-[11px] font-mono text-neutral-400 truncate mt-0.5 flex items-center gap-1.5 opacity-80 group-hover:opacity-100" title={pair ? `${pair.localPath} ➔ ${pair.remotePath}` : ''}>
                        <span className="text-blue-400 font-semibold truncate">📁 {localFolder}</span>
                        <span className="text-neutral-600 shrink-0">➔</span>
                        <span className="text-neutral-400 truncate">☁️ {remoteFolder}</span>
                      </div>
                    </td>

                    {/* Estado / Acción Corregido */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {renderStatusBadge(event, pair)}
                    </td>

                    {/* Tamaño / Peso */}
                    <td className="px-4 py-3.5 whitespace-nowrap text-right font-mono text-xs">
                      {formattedSize ? (
                        <span className="inline-block bg-neutral-950/80 text-emerald-400 border border-emerald-800/50 px-2.5 py-1 rounded-md font-semibold shadow-inner">
                          {formattedSize}
                        </span>
                      ) : (
                        <span className="text-neutral-600 italic text-[11px]">—</span>
                      )}
                    </td>

                    {/* Compartir URL */}
                    <td className="px-4 py-3.5 whitespace-nowrap text-center">
                      {event.webViewLink ? (
                        <button
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(event.webViewLink!);
                              setCopiedId(event.id);
                              setTimeout(() => setCopiedId(null), 2000);
                            } catch (e) {
                              console.error('Error al copiar enlace:', e);
                            }
                          }}
                          className="inline-flex items-center justify-center space-x-1.5 px-3 py-1.5 text-xs bg-indigo-500/10 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-300 rounded-lg transition-all font-semibold font-mono active:scale-95 shadow-sm"
                          title="Copiar enlace web oficial de Google Drive"
                        >
                          {copiedId === event.id ? <CheckCircle2 size={13} className="text-green-400" /> : <Link size={13} className="text-indigo-400" />}
                          <span>{copiedId === event.id ? '¡Link Copiado!' : 'Copiar URL'}</span>
                        </button>
                      ) : (
                        <span className="text-neutral-600 text-[11px] font-mono italic">Solo Local</span>
                      )}
                    </td>

                    {/* Fecha y Hora */}
                    <td className="px-5 py-3.5 text-right text-neutral-400 text-xs font-mono whitespace-nowrap" title={new Date(event.timestamp).toLocaleString()}>
                      {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Vista en Tarjetas Táctiles para Teléfonos Móviles y Tablets (< 1024px) */}
        <div className="lg:hidden divide-y divide-neutral-800/80">
          {displayedEvents.length === 0 ? (
            <div className="p-8 text-center text-neutral-500 text-sm">
              <Activity size={28} className="mx-auto mb-2 opacity-30 text-neutral-400" />
              <p>{events.length === 0 ? 'Aún no se ha registrado actividad en esta sesión o el motor se está iniciando.' : 'No hay eventos que coincidan con tus criterios de filtro.'}</p>
            </div>
          ) : (
            displayedEvents.map(event => {
              const pair = pairs.find(p => p.id === event.pairId);
              const formattedSize = (() => {
                if (event.size && event.size > 0) {
                  const k = 1024;
                  const sizes = ['B', 'KB', 'MB', 'GB'];
                  const i = Math.floor(Math.log(event.size) / Math.log(k));
                  return parseFloat((event.size / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                }
                return null;
              })();

              return (
                <div key={event.id} className="p-4 hover:bg-neutral-800/30 transition-colors space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col min-w-0">
                      <span className="font-semibold text-neutral-100 text-sm truncate">{event.filename}</span>
                      {formattedSize && (
                        <span className="text-[11px] font-mono text-emerald-400 font-semibold mt-0.5">
                          💾 {formattedSize}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-neutral-400 font-mono shrink-0">{new Date(event.timestamp).toLocaleTimeString()}</span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    {renderStatusBadge(event, pair)}

                    {event.webViewLink && (
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(event.webViewLink!);
                            setCopiedId(event.id);
                            setTimeout(() => setCopiedId(null), 2000);
                          } catch (e) {
                            console.error('Error al copiar enlace:', e);
                          }
                        }}
                        className="inline-flex items-center space-x-1.5 px-3 py-1 text-xs bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 rounded-md transition-colors font-semibold font-mono shadow-sm"
                      >
                        {copiedId === event.id ? <CheckCircle2 size={14} className="text-green-400" /> : <Link size={14} className="text-indigo-400" />}
                        <span>{copiedId === event.id ? '¡Copiado!' : 'Copiar URL'}</span>
                      </button>
                    )}
                  </div>

                  <div className="text-[11px] text-neutral-300 font-mono bg-neutral-950 p-2 rounded-lg border border-neutral-800/80 truncate shadow-inner">
                    🔗 {pair ? `${pair.localPath} ➔ ${pair.remotePath}` : 'Par Eliminada/Desconocida'}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Paginación */}
        {filteredEvents.length > pageSize && (
          <div className="flex flex-col sm:flex-row items-center justify-between px-4 sm:px-6 py-3 bg-neutral-950/60 border-t border-neutral-800 text-xs text-neutral-400 font-mono gap-2 text-center">
            <span>Mostrando {(currentPage - 1) * pageSize + 1} - {Math.min(currentPage * pageSize, filteredEvents.length)} de {filteredEvents.length} sucesos</span>
            <div className="flex items-center space-x-2 shrink-0">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1 bg-neutral-800 text-neutral-200 rounded-md disabled:opacity-40 hover:bg-neutral-700 transition-colors font-medium"
              >
                Anterior
              </button>
              <span className="px-2 font-semibold text-neutral-300">Pág {currentPage} / {totalPages}</span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-1 bg-neutral-800 text-neutral-200 rounded-md disabled:opacity-40 hover:bg-neutral-700 transition-colors font-medium"
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsTab({ settings, onUpdateSettings }: { settings: SyncSettings, onUpdateSettings: (s: SyncSettings) => void }) {
  const [newPattern, setNewPattern] = useState('');
  const [resettingDb, setResettingDb] = useState(false);
  const patterns = settings.ignoredPatterns || ['*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.synctex.gz', '*.bcf*', '*.bbl*', '*SAVE-ERROR*', '*.swp', '*.lock', '*~', 'node_modules', '.git', '.DS_Store', '*.tmp'];

  const addPattern = () => {
    if (newPattern && !patterns.includes(newPattern.trim())) {
      onUpdateSettings({ ...settings, ignoredPatterns: [...patterns, newPattern.trim()] });
      setNewPattern('');
    }
  };

  const removePattern = (p: string) => {
    onUpdateSettings({ ...settings, ignoredPatterns: patterns.filter(x => x !== p) });
  };

  const handleAutoStartToggle = async (checked: boolean) => {
    onUpdateSettings({ ...settings, autoStart: checked });
    if ((window as any).electronBridge?.setAutoStart) {
      await (window as any).electronBridge.setAutoStart(checked);
    }
  };

  return (
    <div className="space-y-6 pb-12">
      <header>
        <h2 className="text-2xl font-medium text-white mb-1">Ajustes</h2>
        <p className="text-neutral-400 text-sm">Configurar preferencias globales de sincronización, exclusiones y sistema.</p>
      </header>

      <div className="max-w-3xl space-y-6">
        {/* Editor .syncignore para LaTeX / Desarrollo */}
        <div className="bg-white/[0.02] backdrop-blur-md border border-white/[0.05] rounded-2xl p-6 shadow-xl hover:bg-white/[0.03] transition-colors">
          <div className="flex items-center space-x-2.5 mb-2">
            <Tag size={18} className="text-blue-400" />
            <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Exclusión de Archivos (.syncignore & LaTeX)</h3>
          </div>
          <p className="text-xs text-neutral-400 mb-4">
            Los archivos que coincidan con estos patrones serán automáticamente ignorados para evitar saturar Google Drive con ficheros temporales de compilación en LaTeX o dependencias pesadas de programación.
          </p>
          <div className="flex flex-wrap gap-2 mb-4">
            {patterns.map((p, idx) => (
              <span key={idx} className="inline-flex items-center gap-1.5 px-3 py-1 bg-neutral-800/90 text-neutral-200 text-xs font-mono rounded-lg border border-neutral-700">
                <span>{p}</span>
                <button onClick={() => removePattern(p)} className="text-neutral-400 hover:text-red-400 transition-colors">
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 max-w-sm">
            <input
              type="text"
              placeholder="Ejemplo: *.pdf, *.tmp, dist..."
              value={newPattern}
              onChange={e => setNewPattern(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addPattern(); }}
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3.5 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={addPattern}
              className="px-3.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-white font-medium text-xs rounded-lg transition-colors border border-neutral-700"
            >
              + Agregar
            </button>
          </div>
        </div>

        {/* Integración con Linux y Notificaciones */}
        <div className="bg-white/[0.02] backdrop-blur-md border border-white/[0.05] rounded-2xl p-6 shadow-xl hover:bg-white/[0.03] transition-colors">
          <div className="flex items-center space-x-2.5 mb-2">
            <Bell size={18} className="text-green-400" />
            <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Integración Natively con Sistema Linux</h3>
          </div>
          <p className="text-xs text-neutral-400 mb-4">Opciones nativas de escritorio para tu sistema Ubuntu / Distros basadas en Debian & FOSS.</p>
          <div className="space-y-3.5">
            <label className="flex items-center justify-between text-sm text-neutral-300 p-3 bg-neutral-950/60 rounded-lg border border-neutral-800 cursor-pointer hover:bg-neutral-950 transition-colors">
              <div>
                <span className="font-medium text-white block">Iniciar con el Sistema (Auto-Start en Linux)</span>
                <span className="text-xs text-neutral-500">Ejecutar en segundo plano desde la bandeja de Ubuntu tan pronto inices sesión.</span>
              </div>
              <input
                type="checkbox"
                checked={!!settings.autoStart}
                onChange={e => handleAutoStartToggle(e.target.checked)}
                className="w-4 h-4 accent-blue-500 rounded cursor-pointer"
              />
            </label>

            <label className="flex items-center justify-between text-sm text-neutral-300 p-3 bg-neutral-950/60 rounded-lg border border-neutral-800 cursor-pointer hover:bg-neutral-950 transition-colors">
              <div>
                <span className="font-medium text-white block">Notificaciones Nativas del Escritorio</span>
                <span className="text-xs text-neutral-500">Mostrar avisos y banners de OS cuando finalice una sincronización o se detecten USBs.</span>
              </div>
              <input
                type="checkbox"
                checked={settings.desktopNotifications ?? true}
                onChange={e => onUpdateSettings({ ...settings, desktopNotifications: e.target.checked })}
                className="w-4 h-4 accent-blue-500 rounded cursor-pointer"
              />
            </label>
          </div>
        </div>

        <div className="bg-white/[0.02] backdrop-blur-md border border-white/[0.05] rounded-2xl p-6 shadow-xl hover:bg-white/[0.03] transition-colors">
          <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Límites de Ancho de Banda</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-neutral-400 mb-2">Velocidad Máx. de Descarga (KB/s)</label>
              <input
                type="number"
                value={settings.maxDownloadSpeed}
                onChange={(e) => onUpdateSettings({ ...settings, maxDownloadSpeed: parseInt(e.target.value) || 0 })}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2 text-sm text-white"
              />
              <p className="text-[10px] text-neutral-500 mt-1">Establecer en 0 para ilimitado.</p>
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-2">Velocidad Máx. de Subida (KB/s)</label>
              <input
                type="number"
                value={settings.maxUploadSpeed}
                onChange={(e) => onUpdateSettings({ ...settings, maxUploadSpeed: parseInt(e.target.value) || 0 })}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2 text-sm text-white"
              />
            </div>
          </div>
        </div>

        <div className="bg-red-950/20 backdrop-blur-md border border-red-900/50 rounded-2xl p-6 shadow-xl shadow-red-900/10">
          <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Resolución de Conflictos</h3>
          <p className="text-xs text-neutral-400 mb-4">Cuando un archivo se modifica en ambas ubicaciones simultáneamente:</p>
          <div className="space-y-2">
            <label className="flex items-center space-x-3 text-sm text-neutral-300 cursor-pointer">
              <input type="radio" name="conflict" checked={settings.conflictResolution === 'prompt'} onChange={() => onUpdateSettings({ ...settings, conflictResolution: 'prompt' })} className="bg-neutral-950 border-neutral-800" />
              <span>Preguntarme para elegir (Mostrar alerta interactiva)</span>
            </label>
            <label className="flex items-center space-x-3 text-sm text-neutral-300 cursor-pointer">
              <input type="radio" name="conflict" checked={settings.conflictResolution === 'local'} onChange={() => onUpdateSettings({ ...settings, conflictResolution: 'local' })} className="bg-neutral-950 border-neutral-800" />
              <span>Sobrescribir siempre con la copia Local</span>
            </label>
            <label className="flex items-center space-x-3 text-sm text-neutral-300 cursor-pointer">
              <input type="radio" name="conflict" checked={settings.conflictResolution === 'remote'} onChange={() => onUpdateSettings({ ...settings, conflictResolution: 'remote' })} className="bg-neutral-950 border-neutral-800" />
              <span>Sobrescribir siempre con la copia Remota</span>
            </label>
            <label className="flex items-center space-x-3 text-sm text-neutral-300 cursor-pointer">
              <input type="radio" name="conflict" checked={settings.conflictResolution === 'rename'} onChange={() => onUpdateSettings({ ...settings, conflictResolution: 'rename' })} className="bg-neutral-950 border-neutral-800" />
              <span>Renombrar y mantener ambos archivos</span>
            </label>
          </div>
        </div>

        <div className="bg-red-900/20 border border-red-900/50 rounded-xl p-6 shadow-md mt-6">
          <h3 className="text-sm font-semibold text-red-400 mb-2 uppercase tracking-wider">Zona de Peligro</h3>
          <p className="text-xs text-red-300/70 mb-4">
            Regenerar la base de datos de sincronización solucionará posibles errores de estado interno, pero provocará que en el siguiente escaneo todos los archivos se vuelvan a comparar desde cero. No se borrarán archivos de Drive ni de tu PC.
          </p>
          <button
            onClick={async () => {
              if (window.confirm('¿Estás seguro de regenerar la base de datos de sincronización?')) {
                setResettingDb(true);
                try {
                  await syncService.resetDatabase();
                  alert('Base de datos regenerada con éxito. Por favor reinicia la aplicación.');
                } catch (err) {
                  alert(`Error al regenerar: ${err instanceof Error ? err.message : String(err)}`);
                }
                setResettingDb(false);
              }
            }}
            disabled={resettingDb}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${resettingDb ? 'bg-red-500/20 text-red-400 cursor-not-allowed' : 'bg-red-600 hover:bg-red-700 text-white'}`}
          >
            {resettingDb ? 'Regenerando...' : 'Regenerar Base de Datos'}
          </button>
        </div>
      </div>
    </div>
  );
}