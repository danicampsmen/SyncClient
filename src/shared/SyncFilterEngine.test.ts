import { describe, it, expect } from 'vitest';
import { SyncFilterEngine } from './SyncFilterEngine';
import { SyncPairFilter } from './schema';

describe('SyncFilterEngine', () => {
  const sampleFilters: SyncPairFilter[] = [
    { pair_id: 'pair1', rule_type: 'FileType', string_value: 'aux', is_include: 0, created_at: Date.now() },
    { pair_id: 'pair1', rule_type: 'FileNameEndsWith', string_value: '.synctex.gz', is_include: 0, created_at: Date.now() },
    { pair_id: 'pair1', rule_type: 'FolderNameEquals', string_value: 'node_modules', is_include: 0, created_at: Date.now() },
    { pair_id: 'pair1', rule_type: 'FileSizeLargerThan', numeric_value: 50 * 1024 * 1024, is_include: 0, created_at: Date.now() },
  ];

  it('should exclude .aux files via FileType rule', () => {
    const result = SyncFilterEngine.evaluateFilters(
      { relPath: 'capitulo1/documento.aux' },
      sampleFilters
    );
    expect(result.shouldFilter).toBe(true);
    expect(result.action).toBe('exclude');
  });

  it('should exclude files inside node_modules via FolderNameEquals rule', () => {
    const result = SyncFilterEngine.evaluateFilters(
      { relPath: 'proyecto/node_modules/express/index.js' },
      sampleFilters
    );
    expect(result.shouldFilter).toBe(true);
  });

  it('should exclude files larger than threshold', () => {
    const result = SyncFilterEngine.evaluateFilters(
      { relPath: 'data/large_dataset.iso', fileSize: 100 * 1024 * 1024 },
      sampleFilters
    );
    expect(result.shouldFilter).toBe(true);
  });

  it('should allow normal source files', () => {
    const result = SyncFilterEngine.evaluateFilters(
      { relPath: 'capitulo1/documento.tex', fileSize: 5000 },
      sampleFilters
    );
    expect(result.shouldFilter).toBe(false);
    expect(result.action).toBe('include');
  });
});
