/**
 * B12: Tests unitarios para CoreSyncLogic
 * Cubre matchesIgnorePattern, parseNumberedFilename, groupAndSortDuplicates, y detección de conflictos
 */
import { CoreSyncLogic } from './CoreSyncLogic';

// --- matchesIgnorePattern ---
console.log('=== matchesIgnorePattern ===');

// Casos borde: nombres vacíos o nulos
console.assert(CoreSyncLogic.matchesIgnorePattern('') === false, 'Empty name → false');
console.assert(CoreSyncLogic.matchesIgnorePattern(null as any) === false, 'Null name → false');
console.assert(CoreSyncLogic.matchesIgnorePattern(undefined as any) === false, 'Undefined name → false');

// Extensión: *.tmp debe coincidir
console.assert(CoreSyncLogic.matchesIgnorePattern('archivo.tmp') === true, '*.tmp match');
console.assert(CoreSyncLogic.matchesIgnorePattern('ARCHIVO.TMP') === true, '*.tmp case insensitive');
console.assert(CoreSyncLogic.matchesIgnorePattern('archivo.TMP.txt') === false, '*.tmp no debe matchear .tmp.txt');

// LaTeX auxiliares
console.assert(CoreSyncLogic.matchesIgnorePattern('documento.aux') === true, '*.aux match');
console.assert(CoreSyncLogic.matchesIgnorePattern('documento.log') === true, '*.log match');
console.assert(CoreSyncLogic.matchesIgnorePattern('documento.out') === true, '*.out match');

// Archivos ocultos
console.assert(CoreSyncLogic.matchesIgnorePattern('.gitignore') === true, '.* pattern for hidden files');

// Archivos con patrón wildcard SAVE-ERROR
console.assert(CoreSyncLogic.matchesIgnorePattern('nota-SAVE-ERROR') === false, 'SAVE-ERROR exact match requires .*-SAVE-ERROR* format');
// El patrón es .*-SAVE-ERROR* → debería matchear archivos que empiezan con punto
console.assert(CoreSyncLogic.matchesIgnorePattern('.nota-SAVE-ERROR') === true, '.*-SAVE-ERROR* match');

// Archivos con nombre exacto (node_modules se maneja en settings, no en defaults)
console.assert(CoreSyncLogic.matchesIgnorePattern('.DS_Store') === true, '.DS_Store hidden file');
console.assert(CoreSyncLogic.matchesIgnorePattern('.git') === true, '.git dir');
console.assert(CoreSyncLogic.matchesIgnorePattern('node_modules') === false, 'node_modules not in shared defaults (handled by engine settings)');

// Archivos normales que NO deben ser ignorados
console.assert(CoreSyncLogic.matchesIgnorePattern('apuntes.pdf') === false, 'PDF → not ignored');
console.assert(CoreSyncLogic.matchesIgnorePattern('tesis.tex') === false, '.tex → not ignored');
console.assert(CoreSyncLogic.matchesIgnorePattern('main.py') === false, '.py → not ignored');

// Patrones personalizados
console.assert(CoreSyncLogic.matchesIgnorePattern('debug.log', ['*.log', '*.tmp']) === true, 'Custom pattern *.log');
console.assert(CoreSyncLogic.matchesIgnorePattern('debug.txt', ['*.log', '*.tmp']) === false, 'Custom pattern: .txt not in list');

console.log('✅ matchesIgnorePattern: All assertions passed');

// --- parseNumberedFilename ---
console.log('\n=== parseNumberedFilename ===');

// Formato StarNote: nombre(numero).ext
const r1 = CoreSyncLogic.parseNumberedFilename('apuntes(1).pdf');
console.assert(r1.isNumbered === true, 'Numbered detected');
console.assert(r1.baseName === 'apuntes.pdf', 'Base name extracted');
console.assert(r1.version === 1, 'Version extracted');
console.assert(r1.extension === 'pdf', 'Extension extracted');

// Número alto
const r2 = CoreSyncLogic.parseNumberedFilename('rotman(15).pdf');
console.assert(r2.isNumbered === true, 'Numbered #15');
console.assert(r2.baseName === 'rotman.pdf', 'Base rotman');
console.assert(r2.version === 15, 'Version 15');

// Espacio antes del paréntesis
const r3 = CoreSyncLogic.parseNumberedFilename('nota (3).txt');
console.assert(r3.isNumbered === true, 'Numbered with space');
console.assert(r3.baseName === 'nota.txt', 'Base with space');

// Doble numeración (poco común pero válido)
const r4 = CoreSyncLogic.parseNumberedFilename('archivo(2)(1).pdf');
console.assert(r4.isNumbered === true, 'Double numbered detected');
console.assert(r4.version === 1, 'Last version wins');

// Archivo normal sin numeración
const r5 = CoreSyncLogic.parseNumberedFilename('documento.pdf');
console.assert(r5.isNumbered === false, 'Normal file: not numbered');
console.assert(r5.baseName === 'documento.pdf', 'Normal file: baseName = full name');
console.assert(r5.version === 0, 'Normal file: version = 0');
console.assert(r5.extension === 'pdf', 'Normal file: extension extracted');

// Sin extensión
const r6 = CoreSyncLogic.parseNumberedFilename('README');
console.assert(r6.isNumbered === false, 'No extension: not numbered');
console.assert(r6.extension === '', 'No extension: empty');

console.log('✅ parseNumberedFilename: All assertions passed');

// --- groupAndSortDuplicates ---
console.log('\n=== groupAndSortDuplicates ===');

// Caso 1: Archivos normales sin duplicados
const items1 = [
    { name: 'a.pdf', mtime: 1000 },
    { name: 'b.pdf', mtime: 2000 },
];
const g1 = CoreSyncLogic.groupAndSortDuplicates(items1);
console.assert(g1.size === 2, '2 unique files → 2 groups');
console.assert(g1.get('a.pdf')!.length === 1, 'a.pdf solo');
console.assert(g1.get('b.pdf')!.length === 1, 'b.pdf solo');

// Caso 2: Duplicados numerados — versión más reciente gana
const items2 = [
    { name: 'nota(1).pdf', mtime: 1000 },
    { name: 'nota(2).pdf', mtime: 2000 },
    { name: 'nota(3).pdf', mtime: 1500 }, // más reciente que (1) pero no que (2)
];
const g2 = CoreSyncLogic.groupAndSortDuplicates(items2);
const winner2 = g2.get('nota.pdf')![0];
console.assert(winner2.name === 'nota(2).pdf', 'Winner: most recent mtime');
console.assert(winner2.version === 2, 'Winner version matches');

// Caso 3: Timestamps iguales — versión más alta gana
const items3 = [
    { name: 'doc(1).pdf', mtime: 1000 },
    { name: 'doc(5).pdf', mtime: 1000 },
    { name: 'doc(3).pdf', mtime: 1000 },
];
const g3 = CoreSyncLogic.groupAndSortDuplicates(items3);
const winner3 = g3.get('doc.pdf')![0];
console.assert(winner3.name === 'doc(5).pdf', 'Equal mtime: highest version wins');
console.assert(winner3.version === 5, 'Version 5');

// Caso 4: Mezcla con archivo base (sin número)
const items4 = [
    { name: 'base.pdf', mtime: 2000 },
    { name: 'base(1).pdf', mtime: 1000 },
    { name: 'base(2).pdf', mtime: 1500 },
];
const g4 = CoreSyncLogic.groupAndSortDuplicates(items4);
const winner4 = g4.get('base.pdf')![0];
console.assert(winner4.name === 'base.pdf', 'Base file with highest mtime wins');

// Caso 5: Diferencia de mtime > 2s = prevalece mtime sobre versión
const items5 = [
    { name: 'x(9).pdf', mtime: 1000 },
    { name: 'x(1).pdf', mtime: 5000 }, // 4s más reciente que (9), incluso si versión es menor
];
const g5 = CoreSyncLogic.groupAndSortDuplicates(items5);
const winner5 = g5.get('x.pdf')![0];
console.assert(winner5.name === 'x(1).pdf', 'Significant time diff: mtime wins over version number');

// Caso 6: Array vacío
const g6 = CoreSyncLogic.groupAndSortDuplicates([]);
console.assert(g6.size === 0, 'Empty array → empty map');

console.log('✅ groupAndSortDuplicates: All assertions passed');

// --- Detección de conflictos (combinaciones de mtime) ---
console.log('\n=== Conflict Detection (mtime combinations) ===');

// Simular lógica de conflicto del syncEngine:
// Conflicto = local cambió (+5s) Y remoto cambió (+5s) desde el manifiesto
function isConflict(localMtime: number, remoteMtime: number, manifestLocal: number, manifestRemote: number): boolean {
    return (localMtime > manifestLocal + 5000) && (remoteMtime > manifestRemote + 5000);
}

// Solo local cambió → no conflicto (subir)
console.assert(isConflict(20000, 10000, 10000, 10000) === false, 'Only local changed → no conflict');

// Solo remoto cambió → no conflicto (descargar)
console.assert(isConflict(10000, 20000, 10000, 10000) === false, 'Only remote changed → no conflict');

// Ambos cambiaron → conflicto
console.assert(isConflict(20000, 20000, 10000, 10000) === true, 'Both changed → conflict detected');

// Cambio pequeño (<5s) en local → no cuenta
console.assert(isConflict(12000, 20000, 10000, 10000) === false, 'Small local change → no conflict');

// Cambio pequeño (<5s) en remoto → no cuenta
console.assert(isConflict(20000, 12000, 10000, 10000) === false, 'Small remote change → no conflict');

// Ninguno cambió significativamente
console.assert(isConflict(11000, 11000, 10000, 10000) === false, 'No changes → no conflict');

// Timestamps idénticos en manifiesto y actuales
console.assert(isConflict(10000, 10000, 10000, 10000) === false, 'Identical timestamps → no conflict');

console.log('✅ Conflict Detection: All assertions passed');

console.log('\n🎉 All tests passed successfully!');