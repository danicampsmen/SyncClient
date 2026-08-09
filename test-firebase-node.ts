import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue } from 'firebase/database';
const app = initializeApp({ projectId: 'syncclient-ac0a8', databaseURL: 'https://syncclient-ac0a8-default-rtdb.firebaseio.com' });
const db = getDatabase(app);
const r = ref(db, 'drive_events');
onValue(r, (snap) => { console.log(snap.val()); process.exit(0); }, (err) => { console.error(err); process.exit(1); });
setTimeout(() => { console.log('Timeout'); process.exit(0); }, 5000);
