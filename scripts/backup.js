// Manual backup: node --no-warnings scripts/backup.js  (the server also does this daily)
import { backup, cleanup } from '../src/db.js';
cleanup();
console.log('Backup written:', backup());
