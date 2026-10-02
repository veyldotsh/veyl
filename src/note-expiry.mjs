import { parseAbi } from 'viem';
import { Problem } from './agent.mjs';
import { ZKAPI_MAINNET } from './funding.mjs';

const abi = parseAbi(['function notes(uint32) view returns (bytes32 commitment,uint128 depositAmount,uint64 expiryTs,uint8 status)']);
export const NOTE_EXPIRY_POLICY = Object.freeze({ warningSeconds: 7 * 86400, stopSeconds: 3 * 86400 });
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const safeSeconds = value => Number.isSafeInteger(Number(value)) && BigInt(value) > 0n && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const sameNote = (a, b, phases) => a.kind === 'withdrawal' && b.kind === 'withdrawal' && a.chainId === 1 && b.chainId === 1 && a.address === b.address && a.noteId === b.noteId && phases.includes(a.phase) && phases.includes(b.phase);

/** Read-only guard. Authenticated daemon note selection is checked against the
 * pinned mainnet vault at a fresh finalized block; no private files are read.
 * A warning or blocked state never authorizes withdrawal or renews a note. */
export class NoteExpiryGuard {
  constructor({ funding, client, now = Date.now }) { this.funding = funding; this.client = client; this.now = now; }
  async inspect({ forWithdrawal = false } = {}) {
    const now = Math.floor(Number(this.now()) / 1000);
    const base = { ...NOTE_EXPIRY_POLICY, checkedAt: now, canInfer: false, source: 'finalized-vault-with-authenticated-daemon-note' };
    const unknown = () => ({ ...base, status: 'unknown', message: 'The active note expiry could not be verified. New inference is blocked; inspect funding and preserve recovery files.' });
    try {
      if (!Number.isSafeInteger(now) || now <= 0 || !this.funding || !this.client) return unknown();
      const selected = await this.funding.inspectOperation('withdrawal');
      if (selected.kind !== 'withdrawal' || selected.chainId !== 1) return unknown();
      if (selected.phase === 'no_note') return { ...base, status: 'no_note', message: 'No active private note. ETH retained in the Veyl treasury is outside this note-expiry mechanism.' };
      const phases = forWithdrawal ? ['ready', 'waiting_settlement', 'quoted', 'waiting_funds'] : ['ready', 'waiting_settlement'];
      if (!phases.includes(selected.phase)) return { ...base, status: 'blocked', message: 'Funding recovery or withdrawal is in progress. New inference remains blocked.' };
      if (!Number.isSafeInteger(selected.noteId) || selected.noteId < 0 || selected.noteId > 0xffffffff || !/^0x[0-9a-f]{40}$/.test(selected.address || '')) return unknown();
      if (await this.client.getChainId() !== 1) return unknown();
      const block = await this.client.getBlock({ blockTag: 'finalized' });
      // Mainnet finality is normally about 13 minutes behind the tip. Refuse a
      // stalled/misconfigured RPC instead of reusing an old healthy decision.
      if (!hash(block.hash) || typeof block.number !== 'bigint' || block.number < 0n || !safeSeconds(block.timestamp) || now - Number(block.timestamp) > 3600 || Number(block.timestamp) > now + 60) return unknown();
      const note = await this.client.readContract({ address: ZKAPI_MAINNET.vault, abi, functionName: 'notes', args: [selected.noteId], blockNumber: block.number });
      const canonical = await this.client.getBlock({ blockNumber: block.number });
      const current = await this.funding.inspectOperation('withdrawal');
      if (!sameNote(selected, current, phases) || canonical.hash !== block.hash || !Array.isArray(note) || note.length !== 4 || !hash(note[0]) || /^0x0{64}$/.test(note[0]) || typeof note[1] !== 'bigint' || note[1] <= 0n || !safeSeconds(note[2])) return unknown();
      const expiresAt = Number(note[2]), secondsRemaining = expiresAt - Math.max(now, Number(block.timestamp));
      const report = { ...base, noteId: selected.noteId, fundingAddress: selected.address, noteState: Number(note[3]) === 1 ? 'active' : 'inactive', expiresAt, stopNewCallsAt: expiresAt - base.stopSeconds, secondsRemaining, blockNumber: block.number.toString(), blockHash: block.hash };
      if (Number(note[3]) !== 1) return { ...report, status: 'blocked', message: 'The selected vault note is no longer active. New inference is blocked; inspect withdrawal or expiry recovery.' };
      if (secondsRemaining <= 0) return { ...report, status: 'expired', message: 'This active note has expired and can be claimed by the zkAPI treasury. New inference is blocked; recovery of unused funds is not guaranteed.' };
      if (secondsRemaining <= base.stopSeconds) return { ...report, status: 'blocked', message: 'This note expires within three days. New inference is blocked. Review whole-note withdrawal promptly; withdrawal is not automatic.' };
      const canInfer = ['ready', 'waiting_settlement'].includes(selected.phase) && ['ready', 'waiting_settlement'].includes(current.phase);
      if (secondsRemaining <= base.warningSeconds) return { ...report, status: 'warning', canInfer, message: 'This note expires within seven days. Arrange withdrawal before expiry; the unused balance does not remain available indefinitely.' };
      return { ...report, status: 'healthy', canInfer, message: 'Expiry was checked against the finalized vault state. New calls stop three days before expiry; this does not renew or withdraw the note.' };
    } catch { return unknown(); }
  }
  async assertCanInfer() {
    const report = await this.inspect();
    if (!report.canInfer) { const error = new Problem(report.message, 409); error.code = report.status === 'unknown' ? 'ZKAPI_NOTE_EXPIRY_UNKNOWN' : 'ZKAPI_NOTE_EXPIRY_BLOCKED'; error.noteExpiry = report; throw error; }
    return report;
  }
}
