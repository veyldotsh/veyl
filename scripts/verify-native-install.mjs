import { installationPaths } from './installation-paths.mjs';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { patchControlSource } from './patch-zkapi-control.mjs';
import { verifyAccountingRuntime } from './verify-accounting-runtime.mjs';
import { dirname } from 'node:path';

// This verifies the already-reviewed build's current provenance and records its
// hashes; it does not retroactively attest every original compiler input.
const { base } = installationPaths();
const revision = 'b826c169b4831665822529f535f824265f50630b';
if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('The native installation lock requires Linux ARM64.');
const source = `${base}/build/zkapi-${revision}`, client = `${base}/bin/zkapi-clientd-control`, wallet = `${base}/vendor/runtime/bin/zkapi-walletd`, proofs = `${base}/vendor/runtime/lib/zkapi-clientd/current/share/zkapi-clientd/proof-setup`;
const savedManifest = `${base}/bin/runtime-manifest.json`;
const accounting = existsSync(savedManifest) && JSON.parse(readFileSync(savedManifest, 'utf8')).version === 2
  ? await verifyAccountingRuntime(dirname(realpathSync(wallet))) : null;
for (const path of [base, source, client, wallet, proofs]) if (!realpathSync(path).startsWith(base + '/') && realpathSync(path) !== base) throw new Error('Native path escapes the Veyl installation.');
const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim();
if (!accounting && (git(['rev-parse', 'HEAD']) !== revision || git(['status', '--porcelain=v1', '--untracked-files=all']) !== 'M zkapi-clientd/cmd/zkapi-clientd/main.go')) throw new Error('Native source differs from the single reviewed patch.');
const original = execFileSync('git', ['-C', source, 'show', 'HEAD:zkapi-clientd/cmd/zkapi-clientd/main.go'], { encoding: 'utf8' });
const patched = readFileSync(resolve(source, 'zkapi-clientd/cmd/zkapi-clientd/main.go'), 'utf8');
if (!accounting && patched !== patchControlSource(original)) throw new Error('Native control patch differs from the reviewed source transformation.');
const goBinary = process.env.VEYL_GO_BINARY || (existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : '/usr/bin/go');
const metadata = execFileSync(goBinary, ['version', '-m', client], { encoding: 'utf8' });
for (const value of ['GOOS=linux', 'GOARCH=arm64', `vcs.revision=${revision}`, 'vcs.modified=true']) if (!metadata.includes(value)) throw new Error('Native Go binary build metadata differs from the reviewed build.');
const hash = async path => { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); };
const archive = `${base}/vendor/zkapi-clientd_0.1.3_linux_arm64.tar.gz`;
if (await hash(archive) !== '1eb8b36618341aa406f6b83b2843c30dbadd5ad08dc86111f94961594b5bc26b') throw new Error('Native archive checksum differs.');
async function archiveHash(name) {
  const child = spawn('tar', ['-xOf', archive, name], { stdio: ['ignore', 'pipe', 'ignore'] }), digest = createHash('sha256');
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Cannot inspect the pinned native archive.'))); });
  for await (const chunk of child.stdout) digest.update(chunk); await done; return digest.digest('hex');
}
if (!accounting && await hash(wallet) !== await archiveHash('zkapi-walletd')) throw new Error('Installed wallet differs from the pinned native archive.');
for (const name of ['request.pk', 'request.vk', 'withdrawal.pk', 'withdrawal.vk', 'manifest.json']) if (await hash(resolve(proofs, name)) !== await archiveHash('share/zkapi-clientd/proof-setup/' + name)) throw new Error('Installed proof assets differ from the pinned native archive.');
const manifest = accounting?.manifest || { version: 1, sourceRevision: revision, patch: 'VEYL_UNFUNDED_CONTROL_V1', release: 'clientd-v0.1.3', clientSha256: await hash(client), walletSha256: await hash(wallet), proofManifestSha256: await hash(resolve(proofs, 'manifest.json')) };
if (manifest.clientSha256 !== await hash(client) || manifest.walletSha256 !== await hash(wallet)) throw Error('Installed executable differs from reviewed native candidate.');
const target = `${base}/bin/runtime-manifest.json`;
if (existsSync(target)) {
  const current = JSON.parse(readFileSync(target, 'utf8'));
  for (const [name, value] of Object.entries(manifest)) if (current[name] !== value) throw new Error('Existing runtime manifest differs; preserve it for review.');
} else writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Native source, reviewed patches, build metadata, executable and proof hashes verified. No daemon was started.');
