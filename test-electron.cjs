try {
  const e = require('electron');
  console.log('electron type:', typeof e);
  console.log('electron keys:', Object.keys(e).slice(0, 10));
} catch (err) {
  console.log('electron require error:', err.message);
}

try {
  const remote = require('@electron/remote/main');
  console.log('@electron/remote/main type:', typeof remote);
  console.log('@electron/remote/main keys:', Object.keys(remote).slice(0, 10));
} catch (err) {
  console.log('@electron/remote/main error:', err.message);
}

try {
  console.log('global.app:', typeof global.app);
  console.log('global.BrowserWindow:', typeof global.BrowserWindow);
} catch (err) {
  console.log('global check error:', err.message);
}
