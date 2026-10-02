import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePublicDeploymentRecord } from '../scripts/public-deployment-record.mjs';
import { writeAddressPrediction } from '../scripts/predict-public-addresses.mjs';

const saved = JSON.parse(readFileSync(new URL('../config/public-addresses.json', import.meta.url))), hash = '0x' + 'a'.repeat(64);
const html = (record, deployed = false) => `<a data-veyl-token="${record.token.address}" ${deployed ? 'data-veyl-status="deployed"' : ''} href="https://etherscan.io/address/${record.token.address}"><code>${record.token.address}</code></a>${deployed ? `<a href="https://etherscan.io/tx/${hash}">Launch receipt</a>` : ''}`;
function deployed() { const record = structuredClone(saved); record.calculationOnly = false; record.transactionSent = true; record.deployments.forEach(item => item.deployed = true); Object.assign(record.token, { status: 'deployed', deployed: true, runtimeCodeHash: hash, receipt: { chainId: 1, transactionHash: hash, blockNumber: '26102000', blockHash: hash, confirmations: 2 } }); return record; }

test('public website guard accepts consistent conditional prediction and confirmed deployment branches', () => {
  const predicted = structuredClone(saved); Object.assign(predicted, { calculationOnly: true, transactionSent: false }); Object.assign(predicted.token, { status: 'conditional-prediction', deployed: false });
  assert.equal(validatePublicDeploymentRecord(predicted, html(predicted)).deployed, false);
  const record = deployed(); assert.equal(validatePublicDeploymentRecord(record, html(record, true)).deployed, true);
});
test('a deployed label requires exact receipt evidence, canonical addresses and matching explorer links', () => {
  for (const alter of [r => { delete r.token.receipt; }, r => { r.token.receipt.chainId = 8453; }, r => { r.token.receipt.confirmations = 1; }, r => { r.token.receipt.blockHash = 'missing'; }, r => { r.token.receipt.blockNumber = '0'; }, r => { r.token.runtimeCodeHash = null; }, r => { r.token.address = '0x' + '1'.repeat(40); }, r => { r.token.marketId = hash; }, r => { r.deployments[4].nonce = '5'; }, r => { r.calculationOnly = true; }, r => { r.deployments[0].deployed = false; }]) {
    const record = deployed(); alter(record); assert.throws(() => validatePublicDeploymentRecord(record, html(record, true)));
  }
  const record = deployed(); assert.throws(() => validatePublicDeploymentRecord(record, html(record))); assert.throws(() => validatePublicDeploymentRecord(record, html(record, true).replace('/tx/' + hash, '/tx/' + '0x' + 'b'.repeat(64))));
});

test('address recalculation cannot overwrite a confirmed public deployment record', t => {
  const directory = mkdtempSync(join(tmpdir(), 'veyl-public-address-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'public-addresses.json'), confirmed = JSON.stringify(deployed()); writeFileSync(file, confirmed);
  assert.throws(() => writeAddressPrediction(file, saved), /will not be overwritten/); assert.equal(readFileSync(file, 'utf8'), confirmed);
  const output = join(directory, 'new-prediction.json'); writeAddressPrediction(output, saved); assert.deepEqual(JSON.parse(readFileSync(output)), saved);
});
