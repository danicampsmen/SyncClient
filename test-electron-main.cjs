console.log('process version:', process.version);
console.log('process platform:', process.platform);

// En procesos de Electron, la API también puede exponerse por enlaces nativos
try {
  const e = process.atomBinding || process.electronBinding || process.electron;
  console.log('atomBinding type:', typeof e);
  console.log('atomBinding keys:', e ? Object.keys(e).slice(0, 20) : 'n/a');
} catch (err) {
  console.error('native binding error:', err.message);
}

setTimeout(() => {
  console.log('done');
  process.exit(0);
}, 500);
