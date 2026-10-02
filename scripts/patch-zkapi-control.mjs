import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reproducible, narrowly scoped bootstrap extension for ethereum/zkapi at
// b826c169b4831665822529f535f824265f50630b. It starts the existing authenticated
// control API while a wallet is unfunded. No funding method is called by boot.
// It does not change proofs, settlement, approval, transport, or inference.
const marker = '// VEYL_UNFUNDED_CONTROL_V1';
const expected = '464aaf9aa912841d15ca6e3d8fd07801876d25c5a4728df5a2aa1018179b3610';
export function patchControlSource(source) {
if (source.includes(marker)) throw new Error('Source is already patched. Build from the recorded tree or start with a fresh pinned source archive.');
if (createHash('sha256').update(source).digest('hex') !== expected) throw new Error('Unexpected upstream main.go; do not patch another revision.');
const replacements = [
  ['if args[0] != "config" && args[0] != "serve" {', 'if args[0] != "config" && args[0] != "serve" && args[0] != "serve-control" {'],
  ['\tc, err := config.Load(dir)', '\t' + marker + '\n\tif args[0] == "serve-control" && len(args) != 1 {\n\t\treturn errors.New("serve-control accepts no arguments")\n\t}\n\tc, err := config.Load(dir)'],
  ['\treturn runConfiguredServe(ctx, dir, c, expected, os.Stdout)', '\tif args[0] == "serve-control" {\n\t\t// Keep the existing authenticated management API available before funding.\n\t\t// The companion and model policy still enforce solvency on each request.\n\t\treturn serveSnapshot(ctx, dir, c, expected, os.Stdout)\n\t}\n\treturn runConfiguredServe(ctx, dir, c, expected, os.Stdout)']
];
let patched = source;
for (const [before, after] of replacements) {
  if (patched.split(before).length !== 2) throw new Error('Patch anchor missing or ambiguous.');
  patched = patched.replace(before, after);
}
return patched;
}
// New accounting releases can pin the full combined main.go, including this
// control extension. Only that exact reviewed source may skip the old transform.
export function prepareAccountingControlSource(source, goPatch) {
  if (goPatch?.name !== 'go' || !Array.isArray(goPatch.files)) throw new Error('Invalid Go accounting patch.');
  const entries = goPatch.files.filter(file => file.path === 'zkapi-clientd/cmd/zkapi-clientd/main.go');
  if (!entries.length) return patchControlSource(source);
  if (entries.length !== 1) throw new Error('Ambiguous combined control source.');
  const file = entries[0], digest = createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex');
  if (file.originalSha256LF !== expected || !/^[a-f0-9]{64}$/.test(file.patchedSha256LF || '') || digest !== file.patchedSha256LF || source.split(marker).length !== 2) throw new Error('Pinned combined control source differs.');
  return source;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/patch-zkapi-control.mjs /path/to/pinned/zkapi');
  const path = resolve(process.argv[2], 'zkapi-clientd/cmd/zkapi-clientd/main.go');
  writeFileSync(path, patchControlSource(readFileSync(path, 'utf8')));
  console.log('Applied Veyl unfunded-control patch to pinned public source. Build and test before installation.');
}
