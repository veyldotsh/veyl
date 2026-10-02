import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, lstatSync, accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyAccountingRuntime(directory) {
  if (process.platform !== 'linux' || process.arch !== 'arm64') throw Error('Accounting runtime requires Linux ARM64.');
  directory = resolve(directory);
  if (!/^\/home\/veyl\/veyl\/native-releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(directory) || realpathSync(directory) !== directory) throw Error('Unexpected native candidate directory.');
  const read = name => {
    const path = resolve(directory, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw Error('Invalid native build metadata.');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const hash = async path => { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); };
  const lockPath = new URL('../deployment/native/source-lock.json', import.meta.url), lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const sourceLockSha256 = await hash(lockPath);
  const accepted = JSON.parse(readFileSync(new URL('../deployment/native/accepted-build.json', import.meta.url), 'utf8'));
  if (accepted.version !== 1 || accepted.sourceLockSha256 !== sourceLockSha256 ||
      accepted.builderSha256 !== await hash(new URL('./build-native-accounting.mjs', import.meta.url)) ||
      accepted.controlPatchSha256 !== await hash(new URL('./patch-zkapi-control.mjs', import.meta.url))) throw Error('The accepted native build differs from the reviewed compiler inputs.');
  if (await hash(resolve(directory, 'source-lock.json')) !== sourceLockSha256) throw Error('Candidate source lock differs from the reviewed worker.');
  const wallet = read('build-report.json'), client = read('go-build-report.json'), manifest = read('runtime-manifest.json');
  for (const report of [wallet, client]) {
    if (report.version !== 1 || report.success !== true || report.platform !== 'linux-arm64' || report.sourceLockSha256 !== sourceLockSha256 ||
        !/^[a-f0-9]{40}$/.test(report.sourceCommit) || !/^[0-9]+$/.test(String(report.runId)) || report.paidInferenceCalls !== 0 || report.signedTransactions !== 0 || report.installed !== false) throw Error('Unrecognized or mismatched native build report.');
  }
  if (wallet.sourceCommit !== client.sourceCommit || wallet.runId !== client.runId || !wallet.rust.startsWith(`rustc ${lock.rustVersion} `) || !client.goVersion.includes(`go${lock.goVersion} `)) throw Error('Native components were not checked together with pinned compilers.');
  if (wallet.sourceCommit !== accepted.sourceCommit || String(wallet.runId) !== String(accepted.runId) || wallet.walletSha256 !== accepted.walletSha256 || client.clientSha256 !== accepted.clientSha256) throw Error('Native reports do not match the exact accepted CI run and artifacts.');
  const binaries = {};
  for (const [name, expected] of [['zkapi-clientd-control', client.clientSha256], ['zkapi-walletd', wallet.walletSha256]]) {
    const path = resolve(directory, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || await hash(path) !== expected) throw Error('Candidate binary checksum or permissions differ.');
    accessSync(path, constants.R_OK | constants.X_OK);
    binaries[name] = expected;
  }
  const metadata = execFileSync(process.env.VEYL_GO_BINARY || '/usr/local/go/bin/go', ['version', '-m', resolve(directory, 'zkapi-clientd-control')], { encoding: 'utf8' });
  for (const value of ['GOOS=linux', 'GOARCH=arm64', 'CGO_ENABLED=0', `vcs.revision=${lock.daemonRevision}`, 'vcs.modified=true']) if (!metadata.includes(value)) throw Error('Candidate Go build metadata differs.');
  const expected = { version: 2, sourceRevision: lock.daemonRevision, companionRevision: lock.companionRevision, protocolRevision: lock.protocolRevision,
    patch: 'VEYL_CALL_ACCOUNTING_V1', sourceLockSha256, clientSha256: client.clientSha256, walletSha256: wallet.walletSha256,
    proofManifestSha256: await hash('/home/veyl/veyl/vendor/runtime/lib/zkapi-clientd/current/share/zkapi-clientd/proof-setup/manifest.json') };
  for (const [name, value] of Object.entries(expected)) if (manifest[name] !== value) throw Error('Candidate runtime manifest differs from reviewed inputs.');
  return { manifest: expected, sourceCommit: wallet.sourceCommit, runId: wallet.runId };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Pass the named native candidate directory.');
  await verifyAccountingRuntime(process.argv[2]);
  console.log('Native candidate source locks, build reports, executable hashes and pinned compiler metadata verified.');
}
