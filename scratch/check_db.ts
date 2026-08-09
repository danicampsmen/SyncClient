import Database from 'better-sqlite3';

const dbPath = '/home/fayfer/.config/syncclient/sync_state_v2.db';
const db = new Database(dbPath);

console.log("--- FOLDERS IN DB ---");
const pairs = db.prepare('SELECT DISTINCT pair_id FROM file_states').all();
console.log("Pairs found:", pairs);

for (const pair of pairs) {
  const root = db.prepare('SELECT * FROM file_states WHERE pair_id = ? AND rel_path = ?').get(pair.pair_id, '');
  console.log(`Root for ${pair.pair_id}:`, root);
  
  const files = db.prepare('SELECT COUNT(*) as count, is_tombstone FROM file_states WHERE pair_id = ? GROUP BY is_tombstone').all(pair.pair_id);
  console.log(`Files for ${pair.pair_id}:`, files);
  
  const sampleFiles = db.prepare('SELECT rel_path, remote_id, is_tombstone FROM file_states WHERE pair_id = ? AND is_tombstone = 0 LIMIT 5').all(pair.pair_id);
  console.log(`Sample valid files for ${pair.pair_id}:`, sampleFiles);
}
