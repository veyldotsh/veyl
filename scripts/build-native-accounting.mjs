import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline wallet fixtures only. This builder never installs, starts or funds a daemon.
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(checkout, 'deployment/native/source-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (process.platform !== 'linux' || process.arch !== 'arm64') throw Error('Build on Linux ARM64.');
if (!process.argv[2]) throw Error('Pass a fresh build directory.');
const base = resolve(process.argv[2]);
if (existsSync(base)) throw Error('Build directory already exists; preserve it and use a new directory.');
mkdirSync(base, { recursive: true });
const go = resolve(base, 'daemon'), companion = resolve(base, 'companion'), artifacts = resolve(base, 'artifacts');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (cmd, args, cwd = base, capture = false) => execFileSync(cmd, args, {
  cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: capture ? 'utf8' : undefined,
  env: { ...process.env, CARGO_BUILD_JOBS: '2', CARGO_TARGET_DIR: resolve(base, 'target'), CARGO_PROFILE_DEV_DEBUG: '0', CARGO_PROFILE_TEST_DEBUG: '0' },
});
mkdirSync(go);
run('git', ['init', go]);
run('git', ['-C', go, 'fetch', '--depth=1', 'https://github.com/ethereum/zkapi.git', lock.daemonRevision]);
run('git', ['-C', go, 'checkout', '--detach', 'FETCH_HEAD']);
if (run('git', ['-C', go, 'rev-parse', 'HEAD'], base, true).trim() !== lock.daemonRevision) throw Error('Wrong daemon revision.');
for (const item of lock.officialPatches) if (digest(resolve(go, item.path)) !== item.sha256) throw Error('Official patch checksum differs.');
run('bash', [resolve(go, 'zkapi-clientd/scripts/prepare-zkapi.sh'), companion]);
for (const [path, revision] of [[companion, lock.companionRevision], [resolve(companion, 'protocol'), lock.protocolRevision]]) {
  if (run('git', ['-C', path, 'rev-parse', 'HEAD'], base, true).trim() !== revision) throw Error('Wrong wallet source revision.');
}
for (const item of lock.patches) {
  const directory = item.name === 'protocol' ? resolve(companion, 'protocol') : companion;
  const patch = resolve(checkout, item.path);
  if (digest(patch) !== item.sha256) throw Error('Accounting patch checksum differs.');
  for (const file of item.files) {
    const path = resolve(directory, file.path);
    if (file.originalSha256LF === null ? existsSync(path) : digest(path) !== file.originalSha256LF) throw Error('Unexpected original accounting source.');
  }
  run('git', ['-C', directory, 'apply', '--check', '--index', patch]);
  run('git', ['-C', directory, 'apply', '--index', patch]);
  for (const file of item.files) if (digest(resolve(directory, file.path)) !== file.patchedSha256LF) throw Error('Patched accounting source differs.');
}
const rust = run('rustc', [`+${lock.rustVersion}`, '--version'], companion, true).trim();
run('cargo', [`+${lock.rustVersion}`, 'test', '--locked', '-p', 'zkapi-client', '--lib'], companion);
run('cargo', [`+${lock.rustVersion}`, 'test', '--locked', '-p', 'zkapi-clientd', '--lib'], companion);
run('cargo', [`+${lock.rustVersion}`, 'build', '--release', '--locked', '--bin', 'zkapi'], companion);
mkdirSync(artifacts);
const wallet = resolve(artifacts, 'zkapi-walletd');
copyFileSync(resolve(base, 'target/release/zkapi'), wallet); chmodSync(wallet, 0o755);
run(wallet, ['--help']);
copyFileSync(lockPath, resolve(artifacts, 'source-lock.json'));
const report = { version: 1, success: true, builtAt: new Date().toISOString(), platform: 'linux-arm64', rust,
  sourceLockSha256: digest(lockPath), walletSha256: digest(wallet), sourceCommit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null, tests: ['zkapi-client full library', 'zkapi-clientd full library'],
  paidInferenceCalls: 0, signedTransactions: 0, installed: false };
writeFileSync(resolve(artifacts, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
