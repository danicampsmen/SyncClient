/**
 * CoreSyncLogic - Módulo Universal de Lógica de Sincronización
 * Extrae y centraliza las reglas de negocio, algoritmos y heurísticas
 * compartidas entre Ubuntu Linux (Node.js/Backend) y Android (Capacitor/Nativo).
 * Principio DRY (Don't Repeat Yourself).
 */

export interface NumberedFileInfo {
  isNumbered: boolean;
  baseName: string;
  version: number;
  extension: string;
}

export interface FileGroupItem {
  name: string;
  mtime: number;
  version?: number;
  [key: string]: any;
}

export class CoreSyncLogic {
  /**
   * Patrones de exclusión por defecto para archivos temporales, ocultos y bloqueos de edición
   * (StarNote en Android, LaTeX/LibreOffice en Linux).
   */
  public static readonly DEFAULT_IGNORE_PATTERNS: string[] = [
    '*.tmp',
    '*.temp',
    '.*',
    '~*',
    '*.lock',
    '*.swp',
    '*.aux',
    '*.log',
    '*.out',
    '.*-SAVE-ERROR*'
  ];

  /**
   * Comprueba si un nombre de archivo coincide con algún patrón de exclusión
   */
  public static matchesIgnorePattern(name: string, patterns: string[] = CoreSyncLogic.DEFAULT_IGNORE_PATTERNS): boolean {
    if (!name) return false;
    // Si la lista no contiene patrones, usar defaults
    const activePatterns = patterns.length > 0 ? patterns : CoreSyncLogic.DEFAULT_IGNORE_PATTERNS;

    for (const pattern of activePatterns) {
      if (!pattern) continue;
      if (pattern.startsWith('*.') && pattern.indexOf('*', 2) === -1) {
        const ext = pattern.slice(1).toLowerCase();
        if (name.toLowerCase().endsWith(ext)) return true;
      } else if (pattern.startsWith('.*') && name.startsWith('.')) {
        return true;
      } else if (pattern.startsWith('~') && name.startsWith('~')) {
        return true;
      } else {
        try {
          // Reemplazar comodines '*' por regex '.*' con escape del punto
          const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
          const regex = new RegExp(regexStr, 'i');
          if (regex.test(name)) return true;
        } catch {
          if (name.toLowerCase() === pattern.toLowerCase()) return true;
        }
      }
    }
    return false;
  }

  /**
   * Temporizador de estabilización de escritura (Settle Timer / Debounce Buffer).
   * Determina si un archivo ha terminado de guardarse antes de iniciar su transmisión por red.
   * Por defecto exige 2000 ms (2 segundos) de inactividad de modificación sobre el disco.
   */
  public static isReadyForSync(mtimeMs: number, bufferMs: number = 2000, now?: number): boolean {
    if (!mtimeMs || mtimeMs <= 0) return true;
    const currentTime = now || Date.now();
    return Math.abs(currentTime - mtimeMs) >= bufferMs;
  }

  /**
   * Extrae información de numeración de archivos duplicados automáticos como "rotman(8).pdf" o "apuntes (1).txt".
   */
  public static parseNumberedFilename(filename: string): NumberedFileInfo {
    const numberedMatch = filename.match(/^(.+?)(?:\s*\(\s*(\d+)\s*\))+\.([a-zA-Z0-9]+)$/);
    if (numberedMatch) {
      const baseName = `${numberedMatch[1].trim()}.${numberedMatch[3]}`;
      const version = parseInt(numberedMatch[2], 10);
      return { isNumbered: true, baseName, version, extension: numberedMatch[3] };
    }
    const dotIndex = filename.lastIndexOf('.');
    const ext = dotIndex !== -1 ? filename.slice(dotIndex + 1) : '';
    return { isNumbered: false, baseName: filename, version: 0, extension: ext };
  }

  /**
   * Agrupa una lista de archivos del sistema por su nombre base y los ordena
   * situando al "ganador" en el índice 0 (mayor mtime con margen de 2s, o versión de número más alta).
   */
  public static groupAndSortDuplicates<T extends FileGroupItem>(files: T[]): Map<string, Array<T & { version: number; baseName: string }>> {
    const groups = new Map<string, Array<T & { version: number; baseName: string }>>();

    for (const file of files) {
      const parsed = CoreSyncLogic.parseNumberedFilename(file.name);
      const enriched = { ...file, version: parsed.version, baseName: parsed.baseName };
      if (!groups.has(parsed.baseName)) {
        groups.set(parsed.baseName, []);
      }
      groups.get(parsed.baseName)!.push(enriched);
    }

    for (const [_, versions] of groups.entries()) {
      versions.sort((a, b) => {
        const timeDiff = b.mtime - a.mtime;
        // Si la diferencia de modificación es significativa (> 2000ms), prevalece la marca temporal
        if (Math.abs(timeDiff) > 2000) {
          return timeDiff;
        }
        // De lo contrario, prevalece la copia con mayor numeración
        return b.version - a.version;
      });
    }

    return groups;
  }

  /**
   * Estandariza las rutas remotas de Google Drive a la jerarquía oficial:
   * GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote
   */
  public static normalizeRemotePath(remotePath: string | undefined): string {
    if (!remotePath) {
      return 'GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote';
    }
    let norm = remotePath.replace(/^(RemoteServer|Drive):/, 'GoogleDrive:');
    if (!norm.startsWith('GoogleDrive:')) {
      norm = 'GoogleDrive:' + (norm.startsWith('/') ? norm : '/' + norm);
    }
    // Convertir rutas antiguas como /Documentos-Ubuntu/ o /Apuntes en pdf - tablet
    if (norm.includes('Documentos-Ubuntu') && !norm.includes('Documentos-Ubuntu-Fayfer')) {
      norm = norm.replace('Documentos-Ubuntu', 'Documentos-Ubuntu-Fayfer');
    }
    if (norm.includes('Apuntes en pdf - tablet')) {
      norm = 'GoogleDrive:/Documentos-Ubuntu-Fayfer/Apuntes_Tablet_StarNote';
    }
    return norm;
  }
}
