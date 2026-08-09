import Database from 'better-sqlite3';

const dbPath = '/home/fayfer/.config/syncclient/sync_state_v2.db';
const db = new Database(dbPath);

console.log("Searching for Cursos-2026-I...");
const rows = db.prepare(`SELECT rel_path, remote_id, is_tombstone FROM file_states WHERE rel_path LIKE '%Cursos-2026-I%' AND pair_id = 'lrzifs37l' LIMIT 20`).all();
console.log(rows);
