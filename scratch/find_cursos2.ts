import Database from 'better-sqlite3';

const dbPath = '/home/fayfer/.config/syncclient/sync_state_v2.db';
const db = new Database(dbPath);

const rows = db.prepare(`SELECT rel_path, remote_id FROM file_states WHERE rel_path LIKE '%Cursos-2026-I%.pdf' LIMIT 5`).all();
console.log(rows);
