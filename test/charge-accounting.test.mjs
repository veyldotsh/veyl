import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_FEED, accountingIdentity, applySettlement, validateCall, valuationMicroUsd } from '../src/charge-accounting.mjs';

import { fixtureCharge } from './fixtures/charge-accounting.mjs';

test('exact native charge and ceiling USD valuation release only unused held reservation once', () => {
  const { call, report } = fixtureCharge(); assert.equal(applySettlement(call, report), 471000);
  assert.equal(call.chargeWei, '10000000000000'); assert.equal(call.valuationMicroUsd, 30000);
  assert.equal(validateCall(call, { journalId: call.journalId, cap: 501000, modelCap: 500000 }), 30000);
  assert.equal(applySettlement(call, report), 0); assert.equal(valuationMicroUsd('1', '300000000001'), 4);
});
test('reserved and bound reports retain caps; historical expired quotes can reconcile', () => {
  const { call, report } = fixtureCharge(); const bound = { ...report, status: 'bound' }; delete bound.receipt;
  assert.equal(applySettlement(call, { version: 1, journal_id: call.journalId, call_id: call.callId, status: 'reserved' }), 0);
  assert.equal(applySettlement(call, bound), 0); assert.equal(validateCall(call, { journalId: call.journalId, cap: 501000, modelCap: 500000 }), 501000);
  assert.equal(applySettlement(call, report), 471000);
});
test('zero and full native-cap receipts preserve exact units without cost clamping', () => {
  const zero = fixtureCharge({ charge: '0' }); assert.equal(applySettlement(zero.call, zero.report), 501000); assert.equal(zero.call.chargeWei, '0');
  const full = fixtureCharge({ charge: '166667' }); assert.equal(applySettlement(full.call, full.report), 999); assert.equal(full.call.valuationMicroUsd, 500001);
});

test('canonical padded receipt releases a held call once while a raw native short hash stays rejected', () => {
  const { call, report } = fixtureCharge({ charge: '3604' });
  report.receipt.receipt_id = '0x' + 'a'.repeat(63);
  assert.throws(() => applySettlement(call, report)); assert.equal(call.status, 'pending');
  report.receipt.receipt_id = '0x0' + 'a'.repeat(63);
  const released = applySettlement(call, report);
  assert.equal(call.chargeWei, '3604000000000'); assert.equal(call.valuationMicroUsd, 10812);
  assert.equal(released, call.reservedMicroUsd - 10812); assert.equal(applySettlement(call, report), 0);
  assert.equal(call.report.receipt.receipt_id, '0x0' + 'a'.repeat(63));
});
test('mismatched call, session, journal, quote, cap and receipt never release budget', () => {
  const mutations = [r => r.call_id = randomUUID(), r => r.journal_id = 'e'.repeat(32), r => r.binding.request_limit_micro_usd = '1', r => r.binding.billing_quote.feed_address = '0x' + 'f'.repeat(40), r => r.binding.billing_quote.answer = '0300000000000', r => r.binding.billing_quote.chain_id = 11155111, r => r.binding.billing_quote.expires_at = 1799999999, r => r.binding.cap_units = '100000000', r => r.receipt.charge_units = '166668', r => r.receipt.balance_units = '-1', r => r.receipt.receipt_id = 'invalid'];
  for (const mutate of mutations) { const { call, report } = fixtureCharge(); mutate(report); assert.throws(() => applySettlement(call, report)); assert.equal(call.status, 'pending'); }
  const { call, report } = fixtureCharge(); applySettlement(call, report); report.receipt.charge_units = '0'; assert.throws(() => applySettlement(call, report));
  assert.throws(() => accountingIdentity({ version: 1, journal_id: 'not-a-journal' }));
});
