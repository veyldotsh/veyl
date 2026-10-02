import { backup, restore } from '../src/backup.mjs';
import { stateKey } from '../src/encrypted-state.mjs';
const [action, path] = process.argv.slice(2), directory = process.env.VEYL_DATA_DIR;
if (!directory || !path || !['backup', 'restore'].includes(action)) throw new Error('Usage: VEYL_DATA_DIR=... node scripts/backup-runtime.mjs backup|restore /absolute/backup-file');
const backupKey = stateKey(process.env.VEYL_BACKUP_KEY);
const result = action === 'backup' ? await backup({ directory, output: path, backupKey, stateKey: stateKey(process.env.VEYL_STATE_KEY) }) : restore({ directory, input: path, backupKey });
console.log(JSON.stringify(result));
