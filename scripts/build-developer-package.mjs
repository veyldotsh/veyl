import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function buildDeveloperPackage(destination = resolve('dist/downloads')) {
  const directory = fileURLToPath(new URL('../packages/veyl/', import.meta.url));
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (manifest.name !== '@veyl/sdk' || manifest.version !== '0.2.0' || !Array.isArray(manifest.files) || manifest.files.length > 20) throw Error('Review the developer package identity and file list before release.');
  const expected = new Set(['package.json', ...manifest.files]);
  for (const name of expected) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || name.split('/').some(p => ['..', 'node_modules', 'data', 'output', '.git'].includes(p)) || /(^|\/)\.env/.test(name)) throw Error('Invalid developer package file.');
    const file = resolve(directory, name);
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw Error('Developer package must contain only reviewed regular files: ' + name);
  }
  mkdirSync(destination, { recursive: true });
  const npmArgs = ['pack', '--ignore-scripts', '--json', '--cache', resolve(directory, '../../output/npm-package-cache'), '--pack-destination', destination];
  const npmCli = [process.env.npm_execpath, resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(file => file && existsSync(file));
  if (process.platform === 'win32' && !npmCli) throw Error('A local npm CLI is required to package the SDK.');
  const result = spawnSync(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...npmArgs] : npmArgs, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 2_000_000 });
  if (result.status !== 0) throw Error('Developer package build failed; no package was approved for release.');
  const packed = JSON.parse(result.stdout);
  if (packed.length !== 1 || packed[0].filename !== 'veyl-sdk-0.2.0.tgz' || !Array.isArray(packed[0].files)) throw Error('Unexpected package output.');
  const actual = new Set(packed[0].files.map(file => file.path));
  if (actual.size !== expected.size || [...actual].some(name => !expected.has(name))) throw Error('Package contents differ from the reviewed file list.');
  const bytes = readFileSync(resolve(destination, packed[0].filename));
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (integrity !== packed[0].integrity) throw Error('Developer package integrity differs from npm output.');
  const report = { name: manifest.name, version: manifest.version, file: packed[0].filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity, files: [...actual].sort() };
  writeFileSync(resolve(destination, 'veyl-sdk-0.2.0.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildDeveloperPackage()));
