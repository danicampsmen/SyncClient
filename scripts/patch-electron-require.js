const path = require('path');
const fs = require('fs');

const electronDir = path.dirname(require.resolve('electron/package.json'));
const indexPath = path.join(electronDir, 'index.js');

const original = fs.readFileSync(indexPath, 'utf8');
const patched = original.replace(
  "module.exports = getElectronPath();",
  `if (process.type === 'browser') {
    try {
      module.exports = require('electron');
    } catch {
      module.exports = getElectronPath();
    }
  } else {
    module.exports = getElectronPath();
  }`
);

fs.writeFileSync(indexPath, patched);
console.log('[patch] electron/index.js patched for main-process require()');
