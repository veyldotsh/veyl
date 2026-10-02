import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = '/home/veyl/veyl';
export function workerEnvironment() { return {
  NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://veyl.sh', BIND_HOST: '127.0.0.1', PORT: '4320',
  VEYL_DATA_DIR: base + '/worker-data/production', VEYL_MAINNET_CONFIG: base + '/current/config/mainnet.json', ETHEREUM_RPC_URL: 'https://ethereum-rpc.publicnode.com',
  VEYL_MAX_TENANTS: '100', VEYL_MAX_LOADED_TENANTS: '8', VEYL_MAX_ACTIVE_RUNTIMES: '1', VEYL_MAX_RUNTIME_PROFILES: '50', VEYL_RUNTIMES_PER_OWNER: '10',
  VEYL_ACTIVE_JOBS: '1', VEYL_MAX_QUEUED_JOBS: '100', VEYL_MAX_QUEUED_PER_OWNER: '10', VEYL_MAX_DATA_BYTES: '2147483648', VEYL_MIN_FREE_BYTES: '536870912',
  VEYL_DAEMON_FIRST_PORT: '19000', VEYL_ZKAPI_CLIENTD: base + '/bin/zkapi-clientd-control', VEYL_ZKAPI_MANIFEST: base + '/bin/runtime-manifest.json',
  VEYL_ZKAPI_WALLETD: base + '/vendor/runtime/bin/zkapi-walletd', VEYL_ZKAPI_PROOF_SETUP: base + '/vendor/runtime/lib/zkapi-clientd/current/share/zkapi-clientd/proof-setup',
  VEYL_ENABLE_MAINNET_TRANSACTIONS: 'false', VEYL_ENABLE_SOCIAL_PUBLISHING: 'false', VEYL_FEE_KEEPER_ENABLED: 'false'
}; }
const secrets = ['VEYL_STATE_KEY', 'VEYL_GATEWAY_KEY', 'VEYL_BACKUP_KEY'];
export function validateWorkerEnvironment(raw) {
  const expected = workerEnvironment();
  const data = {};
  for (const line of raw.split('\n').filter(Boolean)) {
    const match = /^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/.exec(line); if (!match || Object.hasOwn(data, match[1])) throw new Error('Invalid or duplicate worker environment field.'); data[match[1]] = match[2];
  }
  if (Object.keys(data).length !== Object.keys(expected).length + secrets.length) throw new Error('Existing worker environment has unexpected fields; review it without printing secrets.');
  for (const [name, value] of Object.entries(expected)) if (data[name] !== value) throw new Error('Existing worker environment differs from the approved isolated preset.');
  if (secrets.some(name => !/^[0-9a-f]{64}$/.test(data[name])) || new Set(secrets.map(name => data[name])).size !== secrets.length) throw new Error('Worker secret format or independence is invalid.');
  return true;
}
export function createWorkerEnvironment() {
  const expected = workerEnvironment();
  for (const name of secrets) expected[name] = randomBytes(32).toString('hex');
  return Object.entries(expected).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = resolve(process.argv[2] || ''), file = base + '/runtime.env';
  if (!/^\/home\/veyl\/veyl\/releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(release)) throw new Error('An explicit isolated release directory is required.');
  if (existsSync(file)) {
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw new Error('Existing worker environment must be owned by the service user with mode0600.');
    validateWorkerEnvironment(readFileSync(file, 'utf8'));
  } else writeFileSync(file, createWorkerEnvironment(), { flag: 'wx', mode: 0o600 });
  console.log('Owner-only worker configuration validated. Secret values are not printed.');
}
