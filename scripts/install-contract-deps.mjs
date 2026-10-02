import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../contracts/', import.meta.url)), library = resolve(root, 'lib');
const manifest = JSON.parse(readFileSync(resolve(root, 'dependencies.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');
mkdirSync(library, { recursive: true });
if (realpathSync(library).toLowerCase() !== library.toLowerCase().replace(/[\\/]$/, '')) throw new Error('Dependency directory cannot be a symlink outside the project.');
async function git(args, cwd) {
  return new Promise((resolveResult, reject) => {
    // Per-command trust applies only to this validated project dependency path;
    // it does not modify the user's global Git ownership policy.
    const process = spawn('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = '';
    process.stdout.on('data', b => { out += b.toString(); }); process.stderr.on('data', b => { error = (error + b.toString()).slice(-4000); });
    process.on('error', reject); process.on('exit', code => code === 0 ? resolveResult(out.trim()) : reject(new Error(`git ${args[0]} failed: ${error}`)));
  });
}
for (const dependency of manifest.dependencies) {
  if (!/^[a-z0-9-]+$/.test(dependency.name) || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.git$/.test(dependency.repository) || !/^[a-f0-9]{40}$/.test(dependency.commit)) throw new Error('Malformed pinned dependency manifest.');
  const directory = resolve(library, dependency.name);
  if (!directory.startsWith(library + sep)) throw new Error('Dependency path leaves the project.');
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error(`Refusing linked dependency: ${dependency.name}`);
  if (!existsSync(resolve(directory, '.git'))) {
    if (checkOnly) throw new Error(`${dependency.name} is absent. Run node scripts/install-contract-deps.mjs first.`);
    if (existsSync(directory) && readdirSync(directory).length) throw new Error(`Refusing to replace existing files in ${dependency.name}.`);
    mkdirSync(directory, { recursive: true });
    await git(['init', '--quiet'], directory); await git(['remote', 'add', 'origin', dependency.repository], directory);
  }
  const remote = await git(['remote', 'get-url', 'origin'], directory);
  if (remote.toLowerCase() !== dependency.repository.toLowerCase()) throw new Error(`${dependency.name} has an unexpected remote; preserve and inspect it.`);
  let revision;
  try { revision = await git(['rev-parse', 'HEAD'], directory); } catch { revision = null; }
  if (revision !== dependency.commit) {
    if (checkOnly || revision) throw new Error(`${dependency.name} is not pinned to ${dependency.commit}; existing checkouts are not overwritten.`);
    await git(['-c', 'core.hooksPath=', 'fetch', '--depth=1', 'origin', dependency.commit], directory);
    await git(['-c', 'core.hooksPath=', 'checkout', '--detach', dependency.commit], directory);
  }
  if ((await git(['rev-parse', 'HEAD'], directory)) !== dependency.commit || await git(['status', '--porcelain', '--untracked-files=normal'], directory)) throw new Error(`${dependency.name} has unexpected local changes.`);
  console.log(`${dependency.name} ${dependency.commit}`);
}
console.log('Contract dependencies are pinned and self-contained.');
