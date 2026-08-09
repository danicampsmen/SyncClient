import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const dbPath = path.join(os.homedir(), '.config', 'syncclient', 'sync_state_v2.db');
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`SELECT rel_path as localPath FROM file_states`).all() as { localPath: string }[];

const extensionCounts: Record<string, number> = {};

for (const row of rows) {
  const ext = path.extname(row.localPath).toLowerCase();
  if (ext) {
    extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
  }
}

const sorted = Object.entries(extensionCounts).sort((a, b) => b[1] - a[1]);

console.log("Top 30 extensiones en tu base de datos local:");
for (let i = 0; i < Math.min(30, sorted.length); i++) {
  console.log(`${sorted[i][0].padEnd(10)}: ${sorted[i][1]} archivos`);
}
db.close();
