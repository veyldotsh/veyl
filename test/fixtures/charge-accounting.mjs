import { randomUUID } from 'node:crypto';
import { ACCOUNTING_FEED } from '../../src/charge-accounting.mjs';
export function fixtureCharge({ callId = randomUUID(), reserved = 501000, modelCap = 500000, charge = '10000', session = 'b'.repeat(64), receipt = 'c'.repeat(64), journal = 'a'.repeat(32) } = {}) {
  const call = { version: 1, callId, journalId: journal, requestHash: 'd'.repeat(64), createdAt: 1800000000, modelCapMicroUsd: modelCap, reservedMicroUsd: reserved, status: 'pending' };
  const report = { version: 1, journal_id: journal, call_id: callId, status: 'settled', binding: { version: 1, journal_id: journal, call_id: callId, session_id: session, request_limit_micro_usd: String(modelCap), cap_units: '166667', billing_quote: { asset: 'native_eth', units_per_eth: 1000000000, chain_id: 1, feed_address: ACCOUNTING_FEED, round_id: '123', answer: '300000000000', decimals: 8, updated_at: 1799999900, expires_at: 1800004400 } }, receipt: { receipt_id: '0x' + receipt, charge_units: charge, balance_units: '1000000' } };
  return { call, report };
}
