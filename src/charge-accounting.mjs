import { createHash } from 'node:crypto';
import { Problem } from './agent.mjs';

export const ACCOUNTING_MARGIN_MICRO_USD = 1000;
export const ACCOUNTING_FEED = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const journal = /^[0-9a-f]{32}$/;
const hex = /^[0-9a-f]{64}$/;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const uint = (v, max = (1n << 128n) - 1n) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 39 && BigInt(v) <= max;
const fail = () => { throw new Problem('Settlement identity or accounting mismatch. Reservation retained.', 502); };
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function accountingIdentity(v) {
  if (!object(v) || v.version !== 1 || !journal.test(v.journal_id)) fail();
  return { version: 1, journal_id: v.journal_id };
}
export function valuationMicroUsd(units, answer) {
  const value = (BigInt(units) * BigInt(answer) * 1_000_000n + 100_000_000_000_000_000n - 1n) / 100_000_000_000_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(value);
}
export function validateCall(call, { journalId, cap, modelCap }) {
  if (!object(call) || call.version !== 1 || !uuid.test(call.callId) || call.callId === '00000000-0000-0000-0000-000000000000' ||
      call.journalId !== journalId || !journal.test(call.journalId) || !hex.test(call.requestHash) ||
      !Number.isSafeInteger(call.createdAt) || call.createdAt <= 0 || call.reservedMicroUsd !== cap || call.modelCapMicroUsd !== modelCap ||
      !['pending', 'bound', 'settled'].includes(call.status)) fail();
  if (call.report !== undefined) {
    const report = settlementReport(call.report, call);
    if (digest(report) !== call.reportDigest || (call.status === 'settled') !== (report.status === 'settled') || (call.status === 'bound' && report.status !== 'bound')) fail();
    if (report.status === 'settled') {
      const charge = valuationMicroUsd(report.receipt.charge_units, report.binding.billing_quote.answer);
      if (call.valuationMicroUsd !== charge || call.chargeWei !== (BigInt(report.receipt.charge_units) * 1_000_000_000n).toString()) fail();
      return charge;
    }
  } else if (call.status !== 'pending') fail();
  if (call.valuationMicroUsd !== undefined || call.chargeWei !== undefined) fail();
  return cap;
}
export function settlementReport(v, call) {
  if (!object(v) || v.version !== 1 || v.journal_id !== call.journalId || v.call_id !== call.callId || !['reserved', 'bound', 'settled'].includes(v.status)) fail();
  const report = { version: 1, journal_id: v.journal_id, call_id: v.call_id, status: v.status };
  if (v.status === 'reserved') { if (v.binding != null || v.receipt != null) fail(); return report; }
  const b = v.binding, q = b?.billing_quote;
  if (!object(b) || b.version !== 1 || b.journal_id !== call.journalId || b.call_id !== call.callId || !hex.test(b.session_id) ||
      b.request_limit_micro_usd !== String(call.modelCapMicroUsd) || !uint(b.cap_units) || b.cap_units === '0' ||
      !object(q) || q.asset !== 'native_eth' || q.units_per_eth !== 1_000_000_000 || q.chain_id !== 1 || q.feed_address !== ACCOUNTING_FEED || q.decimals !== 8 ||
      !uint(q.round_id, (1n << 80n) - 1n) || q.round_id === '0' || !uint(q.answer, 1_000_000_000_000_000_000n) || q.answer === '0' ||
      !Number.isSafeInteger(q.updated_at) || !Number.isSafeInteger(q.expires_at) || q.updated_at <= 0 || q.expires_at - q.updated_at !== 4500 ||
      q.expires_at < call.createdAt || valuationMicroUsd(b.cap_units, q.answer) > call.reservedMicroUsd) fail();
  const numerator = BigInt(call.modelCapMicroUsd) * 100_000_000_000_000_000n, denominator = BigInt(q.answer) * 1_000_000n;
  const converted = (numerator + denominator - 1n) / denominator;
  if (BigInt(b.cap_units) !== (converted < 50_000n ? 50_000n : converted)) fail();
  report.binding = { version: 1, journal_id: b.journal_id, call_id: b.call_id, session_id: b.session_id, request_limit_micro_usd: b.request_limit_micro_usd, cap_units: b.cap_units,
    billing_quote: { asset: q.asset, units_per_eth: q.units_per_eth, chain_id: q.chain_id, feed_address: q.feed_address, round_id: q.round_id, answer: q.answer, decimals: q.decimals, updated_at: q.updated_at, expires_at: q.expires_at } };
  if (v.status === 'bound') { if (v.receipt != null) fail(); return report; }
  const r = v.receipt;
  if (!object(r) || typeof r.receipt_id !== 'string' || !/^0x[0-9a-f]{64}$/.test(r.receipt_id) || !uint(r.charge_units) || !uint(r.balance_units) || BigInt(r.charge_units) > BigInt(b.cap_units)) fail();
  report.receipt = { receipt_id: r.receipt_id, charge_units: r.charge_units, balance_units: r.balance_units };
  return report;
}
export function applySettlement(call, raw) {
  const report = settlementReport(raw, call), reportDigest = digest(report);
  if (call.status === 'settled') { if (call.reportDigest !== reportDigest) fail(); return 0; }
  if (call.report?.binding && digest(call.report.binding) !== digest(report.binding)) fail();
  if (call.status === 'bound' && report.status === 'reserved') fail();
  if (report.status === 'reserved') return 0;
  call.report = report; call.reportDigest = reportDigest; call.status = report.status;
  if (report.status !== 'settled') return 0;
  call.valuationMicroUsd = valuationMicroUsd(report.receipt.charge_units, report.binding.billing_quote.answer);
  call.chargeWei = (BigInt(report.receipt.charge_units) * 1_000_000_000n).toString();
  return call.reservedMicroUsd - call.valuationMicroUsd;
}
