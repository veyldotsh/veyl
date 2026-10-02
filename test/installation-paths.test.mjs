import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installationPaths, namedInstallationPath } from '../scripts/installation-paths.mjs';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const unix = path => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
const paths = unix(fileURLToPath(new URL('../deployment/paths.sh', import.meta.url)));
const custom = { VEYL_HOME: '/home/operator/veyl', VEYL_SERVICE_USER: 'operator' };

test('installation defaults and named release confinement are portable and explicit', () => {
  assert.deepEqual(installationPaths({}), { base: '/home/veyl/veyl', user: 'veyl' });
  assert.deepEqual(installationPaths(custom), { base: custom.VEYL_HOME, user: 'operator' });
  for (const group of ['releases', 'native-releases']) {
    assert.equal(namedInstallationPath(custom.VEYL_HOME + '/' + group + '/release-1', group, custom), true);
    for (const name of ['..', '../outside', 'nested/release', '', 'x\nother']) assert.equal(namedInstallationPath(custom.VEYL_HOME + '/' + group + '/' + name, group, custom), false);
    assert.equal(namedInstallationPath('/home/other/veyl/' + group + '/release-1', group, custom), false);
  }
  assert.equal(namedInstallationPath(custom.VEYL_HOME + '/data/name', 'data', custom), false);
});

test('path and service account inputs reject traversal and template or shell syntax', () => {
  for (const base of ['/veyl', '/', '/home/operator/../veyl', '/home/./veyl', '/home/operator/veyl/', '/home/a b/veyl', '/home/a&b/veyl', '/home/a|b/veyl', '/home/a\n/veyl', 'relative/veyl']) assert.throws(() => installationPaths({ VEYL_HOME: base }));
  for (const user of ['root;id', 'a b', 'a\n', '../user', '-user', 'user$', 'user&other']) assert.throws(() => installationPaths({ VEYL_SERVICE_USER: user }));
});

test('unit rendering changes only private paths and service identity, preserving resource protections', { skip: !existsSync(bash) }, () => {
  for (const name of ['veyl.service', 'veyl-data.mount', 'journald@veyl.conf']) {
    const url = new URL('../deployment/' + name, import.meta.url);
    const original = readFileSync(url, 'utf8');
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'source "$1"; veyl_render "$2"', 'fixture', paths, unix(fileURLToPath(url))], { env: { ...process.env, ...custom }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, original.replaceAll('/home/veyl/veyl', custom.VEYL_HOME).replace(/^User=veyl$/m, 'User=operator').replace(/^Group=veyl$/m, 'Group=operator'));
  }
});

test('shell path validation rejects unsafe overrides before rendering or host changes', { skip: !existsSync(bash) }, () => {
  for (const env of [{ VEYL_HOME: '/home/a&b/veyl' }, { VEYL_HOME: '/home/../veyl' }, { VEYL_SERVICE_USER: 'a;id' }]) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'source "$1"; printf unexpected', 'fixture', paths], { env: { ...process.env, ...custom, ...env }, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
