import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { win32, posix } from 'node:path';
import { runInNewContext } from 'node:vm';

// Evaluate only the real path initializer; never run artwork writes or spawn Anvil.
function initializer(file, variable) {
  const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
  const expression = source.match(new RegExp(`^const ${variable} = (.+);$`, 'm'))?.[1];
  assert.ok(expression, `Missing ${variable} initializer`);
  return expression;
}

test('local runway resolves Windows Foundry from the active home and respects an explicit binary', () => {
  const expression = initializer('check-local-runway.mjs', 'anvil');
  const context = { process: { platform: 'win32', env: {} }, homedir: () => 'C:\\Profiles\\runner', join: win32.join };
  assert.equal(runInNewContext(expression, context), 'C:\\Profiles\\runner\\.foundry\\bin\\anvil.exe');
  context.process.env.ANVIL_BINARY = 'D:\\Tools With Spaces\\anvil.exe';
  assert.equal(runInNewContext(expression, context), context.process.env.ANVIL_BINARY);
  context.process = { platform: 'linux', env: {} };
  context.join = posix.join;
  assert.equal(runInNewContext(expression, context), 'anvil');
});

test('brand scripts resolve bundled Sharp from the active home and respect an explicit module', () => {
  for (const file of ['build-brand.mjs', 'export-social.mjs']) {
    const expression = initializer(file, 'sharp');
    const context = { process: { env: {} }, homedir: () => 'C:\\Profiles\\runner', resolve: win32.resolve, require: value => value };
    assert.equal(runInNewContext(expression, context), 'C:\\Profiles\\runner\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\sharp');
    context.process.env.VEYL_SHARP_PATH = 'D:\\Dependencies\\sharp';
    assert.equal(runInNewContext(expression, context), context.process.env.VEYL_SHARP_PATH);
    context.process.env = {};
    context.homedir = () => '/home/veyl';
    context.resolve = posix.resolve;
    assert.equal(runInNewContext(expression, context), '/home/veyl/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
  }
});
