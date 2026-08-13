/**
 * SyncFilterEngine - Motor de filtrado avanzado para SyncClient.
 * Soporta reglas basadas en extensiones, nombres, carpetas, expresiones regulares,
 * tamaño y antigüedad de archivos (equivalente al motor de filtros de FolderSync).
 */

import { SyncPairFilter, SyncPairFilterRuleType } from './schema';
import type { TransferSortCriterion } from '../types';

export interface FileFilterContext {
  relPath: string;
  fileSize?: number | null;
  mtimeMs?: number | null;
  isDirectory?: boolean;
}

export type FilterRuleType = 'glob' | 'size' | 'mtime' | 'hidden' | 'system' | 'symlink' | 'FileType' | 'FileNameEquals' | 'FileNameStartsWith' | 'FileNameEndsWith' | 'FileNameContains' | 'FolderNameEquals' | 'FolderNameContains' | 'FileRegex' | 'FilePathRegex' | 'FileSizeLargerThan' | 'FileSizeSmallerThan' | 'FileAgeOlderMinutes' | 'FileAgeNewerMinutes';

export class SyncFilterEngine {
  public static sortTransferQueue<T extends { size?: number; mtimeMs?: number; relPath?: string }>(
    items: T[],
    criterion: TransferSortCriterion
  ): T[] {
    if (!criterion || criterion === 'default') return items;
    const sorted = [...items];
    switch (criterion) {
      case 'size_smallest':
        sorted.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
        break;
      case 'size_largest':
        sorted.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
        break;
      case 'modified_oldest':
        sorted.sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0));
        break;
      case 'modified_newest':
        sorted.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
        break;
    }
    return sorted;
  }
  /**
   * Evalúa si un archivo o directorio debe ser filtrado.
   * Devuelve { shouldFilter: true, matchedFilter } si la regla indica que se debe EXCLUIR o INCLUIR.
   */
  public static evaluateFilters(
    context: FileFilterContext,
    filters: SyncPairFilter[]
  ): { shouldFilter: boolean; action: 'exclude' | 'include'; matchedFilter?: SyncPairFilter } {
    if (!filters || filters.length === 0) {
      return { shouldFilter: false, action: 'include' };
    }

    const pathParts = context.relPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const fileName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '';
    const folderNames = pathParts.slice(0, -1);
    const now = Date.now();

    for (const filter of filters) {
      const isMatch = this.matchesSingleFilter(filter, context, fileName, folderNames, now);
      if (isMatch) {
        const action = filter.is_include === 1 ? 'include' : 'exclude';
        return {
          shouldFilter: action === 'exclude',
          action,
          matchedFilter: filter,
        };
      }
    }

    return { shouldFilter: false, action: 'include' };
  }

  private static matchesSingleFilter(
    filter: SyncPairFilter,
    context: FileFilterContext,
    fileName: string,
    folderNames: string[],
    nowMs: number
  ): boolean {
    const valStr = (filter.string_value || '').trim();
    const valNum = filter.numeric_value ?? 0;

    switch (filter.rule_type) {
      case 'FileType': {
        const ext = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
        return ext.toLowerCase() === valStr.toLowerCase().replace(/^\./, '');
      }

      case 'FileNameEquals':
        return fileName.toLowerCase() === valStr.toLowerCase();

      case 'FileNameStartsWith':
        return fileName.toLowerCase().startsWith(valStr.toLowerCase());

      case 'FileNameEndsWith':
        return fileName.toLowerCase().endsWith(valStr.toLowerCase());

      case 'FileNameContains':
        return fileName.toLowerCase().includes(valStr.toLowerCase());

      case 'FolderNameEquals':
        return folderNames.some((folder) => folder.toLowerCase() === valStr.toLowerCase());

      case 'FolderNameContains':
        return folderNames.some((folder) => folder.toLowerCase().includes(valStr.toLowerCase()));

      case 'FileRegex':
        try {
          const regex = new RegExp(valStr, 'i');
          return regex.test(fileName);
        } catch {
          return false;
        }

      case 'FilePathRegex':
        try {
          const regex = new RegExp(valStr, 'i');
          return regex.test(context.relPath);
        } catch {
          return false;
        }

      case 'FileSizeLargerThan':
        return typeof context.fileSize === 'number' && context.fileSize > valNum;

      case 'FileSizeSmallerThan':
        return typeof context.fileSize === 'number' && context.fileSize < valNum;

      case 'FileAgeOlderMinutes': {
        if (typeof context.mtimeMs !== 'number') return false;
        const ageMinutes = (nowMs - context.mtimeMs) / (1000 * 60);
        return ageMinutes > valNum;
      }

      case 'FileAgeNewerMinutes': {
        if (typeof context.mtimeMs !== 'number') return false;
        const ageMinutes = (nowMs - context.mtimeMs) / (1000 * 60);
        return ageMinutes < valNum;
      }

      default:
        return false;
    }
  }
}
