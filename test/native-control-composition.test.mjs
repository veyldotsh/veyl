import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareAccountingControlSource } from '../scripts/patch-zkapi-control.mjs';

const path = 'zkapi-clientd/cmd/zkapi-clientd/main.go';
const source = 'package main\n// VEYL_UNFUNDED_CONTROL_V1\n// Offline combined-patch fixture.\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const pin = value => ({ name: 'go', files: [{ path, originalSha256LF: '464aaf9aa912841d15ca6e3d8fd07801876d25c5a4728df5a2aa1018179b3610', patchedSha256LF: sha(value) }] });

test('combined Go patch keeps its exact pinned control source without applying the old transformation twice', () => {
  assert.equal(prepareAccountingControlSource(source, pin(source)), source);
  const windows = source.replaceAll('\n', '\r\n');
  assert.equal(prepareAccountingControlSource(windows, pin(source)), windows);
});

test('a control marker alone never bypasses the final source lock', () => {
  assert.throws(() => prepareAccountingControlSource(source + '// changed\n', pin(source)), /combined control source differs/);
  const withoutMarker = source.replace('// VEYL_UNFUNDED_CONTROL_V1\n', '');
  assert.throws(() => prepareAccountingControlSource(withoutMarker, pin(withoutMarker)), /combined control source differs/);
  assert.throws(() => prepareAccountingControlSource(source, { name: 'go', files: [{ ...pin(source).files[0], patchedSha256LF: null }] }), /combined control source differs/);
});

test('legacy accounting builds retain the strict original control transformation', () => {
  assert.throws(() => prepareAccountingControlSource(source, { name: 'go', files: [] }), /already patched/);
  assert.throws(() => prepareAccountingControlSource('package main\n', { name: 'go', files: [] }), /Unexpected upstream/);
  const unrelated = { ...pin(source).files[0], path: 'other/main.go' };
  assert.throws(() => prepareAccountingControlSource(source, { name: 'go', files: [unrelated] }), /already patched/);
});

test('ambiguous, foreign or wrong-base patch records cannot select the combined control path', () => {
  assert.throws(() => prepareAccountingControlSource(source, { ...pin(source), name: 'protocol' }), /Invalid Go accounting patch/);
  assert.throws(() => prepareAccountingControlSource(source, { name: 'go', files: [...pin(source).files, ...pin(source).files] }), /Ambiguous combined control source/);
  assert.throws(() => prepareAccountingControlSource(source, { name: 'go', files: [{ ...pin(source).files[0], originalSha256LF: '0'.repeat(64) }] }), /combined control source differs/);
});
