const address = value => /^0x[\da-f]{40}$/i.test(value || '') && !/^0x0{40}$/i.test(value);
const hash = value => /^0x[\da-f]{64}$/i.test(value || '');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const integer = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const word = value => BigInt(value).toString(16).padStart(64, '0');
const addressWord = value => value.slice(2).toLowerCase().padStart(64, '0');
const txLink = value => hash(value) ? `<a href="https://etherscan.io/tx/${value}" target="_blank" rel="noopener noreferrer">View Ethereum receipt ↗</a>` : '';
const wei = value => { if (!integer(String(value))) return '-'; const n = BigInt(value); return `${n / 10n ** 18n}.${(n % 10n ** 18n).toString().padStart(18, '0')}`.replace(/\.?0+$/, '') || '0'; };
export function ethToWei(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value)) throw new Error('Use an exact ETH amount with at most 18 decimals.');
  const [whole, fraction = ''] = value.split('.'), result = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (result >= 2n ** 256n) throw new Error('ETH amount is too large.'); return result.toString();
}
const ethToGwei = value => { const n = BigInt(ethToWei(value)); if (n % 10n ** 9n) throw new Error('Private-note amounts use whole gwei (at most 9 ETH decimals).'); return String(n / 10n ** 9n); };
const gweiEth = value => integer(String(value)) ? wei(String(BigInt(value) * 10n ** 9n)) : '-';
export function noteExpiryView(note, now = Date.now()) {
  const unknown = { status: 'unknown', title: 'Private-note expiry unverified', canInfer: false, expires: 'Unverified', stop: 'New paid calls are blocked until expiry is verified.' };
  if (!note || !['healthy', 'warning', 'blocked', 'expired', 'unknown', 'no_note'].includes(note.status)) return unknown;
  if (note.status === 'no_note') return { status: 'no_note', title: 'No active private note', canInfer: false, expires: 'Not active', stop: 'A new deposit starts a time-limited note.' };
  if (note.status === 'unknown' || note.source !== 'finalized-vault-with-authenticated-daemon-note' || !Number.isSafeInteger(note.expiresAt) || note.expiresAt <= 0 || note.expiresAt > 8640000000000 || typeof note.canInfer !== 'boolean') return unknown;
  const remaining = note.expiresAt - Math.floor(now / 1000);
  const status = remaining <= 0 ? 'expired' : note.status === 'expired' ? 'expired' : remaining <= 259200 || note.status === 'blocked' || !note.canInfer ? 'blocked' : remaining <= 604800 || note.status === 'warning' ? 'warning' : 'healthy';
  return { status, canInfer: ['healthy', 'warning'].includes(status), expires: new Date(note.expiresAt * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC'),
    title: { healthy: 'Private-note expiry verified', warning: 'Plan your private-note withdrawal', blocked: 'Withdraw before the note expires', expired: 'Private note has expired' }[status],
    stop: status === 'expired' ? 'Expired funds may already be claimable by the zkAPI treasury. Inspect recovery; a refund is not guaranteed.' : status === 'blocked' ? 'New paid calls are blocked. Inspect and close the whole note while withdrawal is still available.' : 'Warning begins seven days before expiry; new paid calls stop 72 hours before expiry.' };
}
export function checkedRunway(value, project, owner) {
  if (!value || value.chainId !== 1 || !Array.isArray(value.refills) || value.refills.length > 1000) throw new Error('Invalid runway response.');
  const p = value.policy;
  if (p && (p.projectId !== project.id || !same(p.owner, owner) || !same(p.treasury, project.mainnet?.treasury) || !address(p.operator) || !['depositGwei', 'lowWaterGwei', 'maxTopUpWei', 'dailyTopUpWei'].every(k => integer(p[k])))) throw new Error('Runway policy belongs to another project or wallet.');
  if (p && ['automatic', 'closeBeforeExpiry'].some(k => p[k] !== undefined && typeof p[k] !== 'boolean')) throw new Error('Invalid automatic runway consent.');
  for (const item of value.refills) {
    if (!p || !/^[a-f0-9-]{36}$/.test(item.id || '') || (item.amountWei !== undefined && !integer(item.amountWei)) || item.calls?.length > 2 || (item.calls?.length && (!address(item.fundingAddress) || !hash(item.expenseId)))) throw new Error('Invalid saved refill.');
    for (const call of item.calls || []) {
      const recipient = '0xb33480ca' + addressWord(item.fundingAddress) + word(1);
      const pay = '0x97d4df67' + item.expenseId.slice(2).toLowerCase() + addressWord(item.fundingAddress) + word(item.amountWei);
      if (call.chainId !== '0x1' || call.value !== '0x0' || !same(call.to, p.treasury) || !((same(call.from, p.owner) && call.data.toLowerCase() === recipient) || (same(call.from, p.operator) && call.data.toLowerCase() === pay))) throw new Error('Refill calldata does not match its exact recipient and amount.');
    }
  }
  return value;
}
export function canRetireUnsigned(item, funding) {
  if (!item || item.status !== 'prepare_unknown' || item.transactionHash || item.expenseId || item.calls?.length || item.confirmationBlock || item.kind || funding?.persistence !== 'healthy') return false;
  const intent = funding.intents.find(i => i.idempotencyKey === 'runway-' + item.id);
  return (!item.quoteIntentId || intent?.id === item.quoteIntentId) && (!intent || (!intent.approvalAttempted && !intent.transactionHash && !intent.observed && ['quoted', 'quote_unknown', 'abandoned'].includes(intent.status)));
}
export function checkedFunding(value, owner, project) {
  if (!value || value.chainId !== 1 || !Array.isArray(value.intents) || !Array.isArray(value.operations)) throw new Error('Invalid funding response.');
  for (const item of value.operations) {
    if (!['withdrawal', 'return'].includes(item.request?.kind) || ![owner, project.mainnet?.treasury].some(a => same(a, item.request.destination))) throw new Error('Recovery destination does not belong to this wallet or treasury.');
    if (item.quote && (!/^[\da-f]{64}$/i.test(item.approvalDigest || '') || !/^[\da-f]{64}$/i.test(item.quote.id || '') || item.quote.chain_id !== 1 || !same(item.quote.destination, item.request.destination) || !address(item.address) || !['required_fee_wei', 'fee_reserve_wei', 'recommended_top_up_wei'].every(k => integer(item.quote[k])))) throw new Error('Recovery quote identity is invalid.');
  }
  return value;
}
/** Uses the existing EIP-1193 wallet boundary, with a separate durable browser
 * journal because treasury receipts are verified by the runway endpoint. */
export class RunwayWalletClient {
  constructor({ project, owner, client, api, storage = client?.storage || globalThis.localStorage, now = Date.now }) { this.project = project; this.owner = owner; this.client = client; this.api = api; this.storage = storage; this.now = now; this.key = `veyl:runway:${owner.toLowerCase()}:${project.id}`; }
  pending() { const raw = this.storage?.getItem(this.key); if (!raw) return []; const rows = JSON.parse(raw); if (!Array.isArray(rows) || rows.some(r => !r.refillId || (r.transactionHash && !hash(r.transactionHash)))) throw new Error('Browser recovery state is invalid. Preserve it and inspect your wallet.'); return rows; }
  save(rows) { if (!this.storage) throw new Error('Browser recovery storage is required.'); this.storage.setItem(this.key, JSON.stringify(rows)); if (this.storage.getItem(this.key) !== JSON.stringify(rows)) throw new Error('Browser recovery state could not be saved.'); }
  uncertainOperations() { const rows = JSON.parse(this.storage?.getItem(this.key + ':operations') || '[]'); if (!Array.isArray(rows) || rows.some(id => !/^[a-f0-9-]{36}$/.test(id))) throw new Error('Preserve invalid operation recovery state before continuing.'); return rows; }
  operationAttempt(id, remove = false) { const rows = this.uncertainOperations().filter(value => value !== id); if (!remove) rows.push(id); if (!this.storage) throw new Error('Browser recovery storage is required.'); const encoded = JSON.stringify(rows); this.storage.setItem(this.key + ':operations', encoded); if (this.storage.getItem(this.key + ':operations') !== encoded) throw new Error('Operation recovery state could not be saved.'); }
  async send(snapshot, refillId, { enabled = false, reviewed = false } = {}) {
    const s = checkedRunway(snapshot, this.project, this.owner), item = s.refills.find(i => i.id === refillId);
    if (!enabled || !this.client?.transactionsEnabled || !reviewed) throw new Error('Wallet sending requires launch enablement and exact transaction review.');
    if (!item || item.status !== 'prepared' || s.persistence !== 'healthy') throw new Error('This refill is not awaiting a payment or persistence is blocked.');
    if (this.client.busy || this.pending().some(i => i.refillId === refillId)) throw new Error('A wallet action is pending. Recover its exact receipt before another send.');
    const call = item.calls.find(c => c.data.toLowerCase().startsWith('0x97d4df67'));
    if (!call || !same(call.from, this.owner)) throw new Error('The treasury operator must sign this payment. Download its exact transaction, then import the receipt.');
    await this.client.wallet.ensure(this.owner); this.client.busy = true;
    const record = { refillId, status: 'sending', submittedAt: this.now() };
    try {
      this.save([...this.pending(), record]);
      let transactionHash;
      try { transactionHash = await this.client.wallet.send({ id: 'runway-' + refillId, kind: 'runway-payment', status: 'prepared', chainId: 1, account: call.from, expiresAt: this.now() + 300000, transaction: call }, { enabled: true }); }
      catch (error) { if (error?.code === 4001) this.save(this.pending().filter(i => i.refillId !== refillId)); throw error; }
      record.transactionHash = transactionHash; record.status = 'submitted';
      try { this.save(this.pending().map(i => i.refillId === refillId ? record : i)); }
      catch { throw new Error(`Payment submitted but browser storage failed. Preserve transaction ${transactionHash} and import it manually; do not resend.`); }
      try { return await this.confirm(refillId, transactionHash); }
      catch (error) { return { status: 'pending', transactionHash, message: error.message }; }
    } finally { this.client.busy = false; }
  }
  async confirm(refillId, transactionHash) {
    if (!hash(transactionHash)) throw new Error('Enter the exact Ethereum transaction hash.');
    const result = await this.api(`/api/projects/${encodeURIComponent(this.project.id)}/runway/confirm`, { refillId, transactionHash });
    if (result.id !== refillId || !same(result.transactionHash, transactionHash)) throw new Error('Receipt confirmation did not match this refill.');
    if (['funded', 'active', 'reverted'].includes(result.status)) this.save(this.pending().filter(i => i.refillId !== refillId)); return result;
  }
}
export function mountRunwayPanel(element, { project, owner, hosted = false, api, client, capabilities = {}, notify = () => {}, now = Date.now, storage } = {}) {
  if (!element || !project || typeof api !== 'function') throw new Error('Runway panel needs a project and authenticated API.');
  let alive = true, busy = false, pauseInFlight = false, pausedLocally = false, generation = 0, runway = null, funding = null, error = '', message = '', inspected = {}, review = null, accepted = false, recipientIntent = null;
  const base = `/api/projects/${encodeURIComponent(project.id)}`, wallet = hosted && address(owner) ? new RunwayWalletClient({ project, owner, client, api, now, ...(storage ? { storage } : {}) }) : null;
  const enabled = () => capabilities.transactionsEnabled === true && client?.transactionsEnabled === true;
  const approvalEnabled = () => enabled() && funding?.approvalEnabled === true && funding.persistence === 'healthy';
  const automaticAvailable = () => approvalEnabled() && runway?.capabilities?.automaticAvailable === true && address(runway.capabilities.operator) && (!runway.policy || same(runway.policy.operator, runway.capabilities.operator));
  const automaticScheduled = () => !pausedLocally && (runway?.scheduling?.automatic ?? runway?.policy?.automatic) === true;
  const current = () => alive && element.isConnected !== false;
  const post = (area, action, body = {}) => api(`${base}/${area}/${action}`, body);
  const button = (action, label, disabled = false, attrs = '') => `<button type="button" class="button secondary compact" data-runway="${action}" ${disabled || busy ? 'disabled' : ''} ${attrs}>${label}</button>`;
  const input = (label, name, value = '', placeholder = '') => `<label>${label}<input name="${name}" inputmode="decimal" autocomplete="off" value="${esc(value)}" placeholder="${placeholder}" required></label>`;
  const row = (label, value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  const findOperation = id => funding?.operations.find(i => i.id === id);
  const operationUncertain = id => { try { return wallet?.uncertainOperations().includes(id); } catch { return true; } };
  function expiryPanel() {
    const note = noteExpiryView(funding?.noteExpiry, now());
    return `<section class="panel runway-expiry runway-expiry-${note.status}" aria-label="Private-note expiry"><div class="section-title"><strong>${esc(note.title)}</strong><span class="badge">${esc(note.status.replaceAll('_', ' '))}</span></div><p class="hint">Expiry: <strong>${esc(note.expires)}</strong>. ${esc(note.stop)}</p><p class="hint">zkAPI notes expire after about 30 days, rounded to a UTC day. After expiry, the deposited amount can be claimed by the zkAPI treasury. Keep spare ETH in your project treasury and prepay only a bounded amount; unused private balance is not indefinitely recoverable.</p>${button('inspect-withdrawal', 'Inspect note & recovery')}</section>`;
  }
  function pending() { try { return wallet?.pending() || []; } catch (e) { error = e.message; return []; } }
  function configurePanel() {
    const p = runway?.policy;
    return `<details class="panel runway-section"><summary>Refill policy ${p ? '· configured' : '· setup'}</summary><p class="hint">Choose how much to prepay and maximum treasury top-ups. This saves limits; it sends no transaction. Existing notes must close before a fresh deposit.</p>${!project.mainnet?.treasury ? '<p>Launch and verify the market treasury first in the Market tab.</p>' : `<form data-runway-form="configure"><div class="form-row">${input('Prepaid principal · ETH', 'depositEth', p ? gweiEth(p.depositGwei) : '', 'Whole gwei; up to 9 decimals')}${input('Low-water threshold · ETH', 'lowWaterEth', p ? gweiEth(p.lowWaterGwei) : '0')}</div><div class="form-row">${input('Maximum per refill · ETH', 'maxTopUpEth', p ? wei(p.maxTopUpWei) : '')}${input('Daily top-up ceiling · ETH', 'dailyTopUpEth', p ? wei(p.dailyTopUpWei) : '')}</div><label class="runway-consent"><input type="checkbox" name="automatic" ${automaticScheduled() ? 'checked' : ''} ${automaticAvailable() || automaticScheduled() ? '' : 'disabled'}>Enable bounded automatic refills and low-water note closure to this treasury.</label><label class="runway-consent"><input type="checkbox" name="closeBeforeExpiry" ${p?.closeBeforeExpiry ? 'checked' : ''} ${automaticAvailable() || automaticScheduled() ? '' : 'disabled'}>Also close a verified active note within seven days of expiry.</label><button class="button secondary" type="submit" ${busy ? 'disabled' : ''}>Save runway policy</button></form><p class="hint">${automaticAvailable() ? 'Automatic payments require these separate owner opt-ins and the saved caps. The worker waits for idle state and final receipts; unknown operations require recovery.' : 'Automatic signing is unavailable or paused. Manual preparation and recovery remain available; no key is requested in this browser.'}</p>`}${p ? `<dl class="runway-metrics">${row('Owner', p.owner)}${row('Operator', p.operator)}</dl>${button('prepare', 'Prepare bounded refill')}` : ''}</details>`;
  }
  function refillPanel() {
    return `<details class="panel runway-section" ${runway?.refills.length ? 'open' : ''}><summary>Treasury payments ${runway?.refills.length ? '· ' + runway.refills.length : ''}</summary>${runway?.refills.slice(-4).reverse().map(item => { const id = `data-refill="${esc(item.id)}"`, sent = pending().find(r => r.refillId === item.id); return `<article class="runway-item"><div class="section-title"><strong>${item.kind === 'recovery-fee' ? 'Recovery network fee' : 'Inference refill'}</strong><span class="badge">${esc(item.status.replaceAll('_', ' '))}</span></div><dl class="runway-metrics">${row('Treasury payment', `${wei(item.amountWei)} ETH`)}${row('Daemon funding address', item.fundingAddress || 'Preparing quote')}</dl>${sent ? `<p class="hint">${sent.transactionHash ? 'Payment submitted. Finalized Ethereum confirmation is still required.' : 'Submission may have reached your wallet. Check it and import the exact hash; sending again is blocked.'}</p>${txLink(sent.transactionHash)}` : ''}<div class="fee-actions">${item.status === 'prepared' ? `${item.calls?.some(c => c.data.startsWith('0xb33480ca')) ? button('recipient', 'Review recipient approval', false, id) : ''}${button('payment', 'Review treasury payment', !!sent, id)}` : ''}${item.status === 'prepare_unknown' ? button('recover-refill', 'Recover preparation', false, id) : ''}${canRetireUnsigned(item, funding) ? button('retire-refill', 'Retire unsigned preparation', false, id) : ''}${['funded', 'deposit_pending', 'active'].includes(item.status) ? button('sync', 'Check note activation', false, id) : ''}</div>${['prepared', 'pending', 'sending', 'send_unknown', 'funded'].includes(item.status) && item.amountWei !== '0' ? `<form data-runway-form="confirm" data-refill="${esc(item.id)}">${input('Payment transaction hash', 'transactionHash', sent?.transactionHash || item.transactionHash || '', '0x…')}<button class="button secondary compact" type="submit">Verify finalized payment</button></form>` : ''}${item.quoteIntentId ? '<p class="hint">Once funded, refresh and approve its exact deposit quote in Inference funding below, then check note activation.</p>' : ''}</article>`; }).join('') || '<p class="hint">No treasury payment prepared. Each refill and its recovery state are saved separately.</p>'}</details>`;
  }
  function operationPanel() {
    const targetOptions = [owner, project.mainnet?.treasury].filter((a, i, list) => address(a) && list.findIndex(b => same(a, b)) === i).map(a => `<option value="${esc(a)}">${same(a, owner) ? 'Your wallet' : 'Project treasury'} · ${esc(a)}</option>`).join('');
    return `<details class="panel runway-section" ${Object.keys(inspected).length ? 'open' : ''}><summary>Withdraw or return funds</summary><p class="hint">Withdrawal closes the entire selected private note. Return sends an exact amount from the daemon’s public funding address. The daemon signs these operations after your explicit approval; a browser wallet does not sign the private-note proof.</p><div class="fee-actions">${button('inspect-withdrawal', 'Inspect private note')}${button('inspect-return', 'Inspect public balance')}</div>${Object.values(inspected).map(s => `<dl class="runway-metrics">${row(s.kind === 'withdrawal' ? 'Private note status' : 'Public-address status', s.phase)}${row('Public ETH', wei(s.balanceWei))}${s.kind === 'withdrawal' ? row('Private balance · daemon report', gweiEth(s.privateBalanceGwei) + ' ETH') + row('Note ID', s.noteId) : ''}</dl>`).join('')}<form data-runway-form="operation"><div class="form-row"><label>Operation<select name="kind"><option value="withdrawal">Close private note</option><option value="return">Return public ETH</option></select></label><label>Destination<select name="destination">${targetOptions}</select></label></div><label>Exact return amount · ETH<input name="amountEth" inputmode="decimal" placeholder="Only for public-address return" autocomplete="off"></label><p class="hint">Inspect the private note before requesting withdrawal. A return amount is never inferred as a sweep.</p><button class="button secondary" type="submit" ${busy ? 'disabled' : ''}>Prepare recovery quote</button></form>${funding?.operations.slice(-4).reverse().map(item => `<article class="runway-item"><div class="section-title"><strong>${esc(item.request.kind)}</strong><span class="badge">${esc(item.status.replaceAll('_', ' '))}</span></div><p class="address">To ${esc(item.request.destination)}</p>${txLink(item.transactionHash)}<div class="fee-actions">${!item.approvalAttempted && !operationUncertain(item.id) ? button('refresh-operation', 'Refresh quote', false, `data-intent="${esc(item.id)}"`) + (item.quote ? button('review-operation', 'Review exact quote', false, `data-intent="${esc(item.id)}"`) : '') : button('recover-operation', 'Check recorded operation', false, `data-intent="${esc(item.id)}"`)}${item.approvalAttempted && hash(item.transactionHash) && ['pending', 'resume_unknown'].includes(item.status) ? button('review-resume', 'Review same-transaction resume', !approvalEnabled(), `data-intent="${esc(item.id)}"`) : ''}${item.status === 'reverted' && item.request.kind === 'withdrawal' && hash(item.transactionHash) ? button('retry-withdrawal', 'Prepare explicit retry quote', false, `data-intent="${esc(item.id)}"`) : ''}</div>${(item.approvalAttempted || operationUncertain(item.id)) && !item.transactionHash ? '<p class="hint">Approval outcome is unknown. Only inspection is available; no new approval or replay.</p>' : ''}</article>`).join('') || ''}<p class="hint">No separate escape path is exposed by this reviewed backend. Preserve the daemon state when recovery requires operator intervention.</p></details>`;
  }
  function reviewPanel() {
    if (!review) return '';
    let body = '', signDisabled = !accepted || !enabled();
    if (review.kind === 'retire') {
      const item = runway?.refills.find(i => i.id === review.id);
      body = `<p>This retires only a failed preparation that has no saved payment plan or signing attempt. The backend rechecks its funding journal and daemon state. Its history stays saved; you can then choose a different principal and prepare a new quote.</p><p class="address">Preparation ${esc(review.id)}</p>`;
      signDisabled = !accepted || !canRetireUnsigned(item, funding) || pending().some(i => i.refillId === review.id);
    } else if (review.kind === 'payment' || review.kind === 'recipient') {
      const item = runway.refills.find(i => i.id === review.id), call = review.kind === 'recipient' ? recipientIntent?.transaction : item.calls.find(c => c.data.startsWith('0x97d4df67'));
      if (!call) return '';
      body = `<dl class="runway-metrics">${row('Action', review.kind === 'recipient' ? 'Allow this funding recipient' : 'Pay exact refill from treasury')}${row('Signer', call.from)}${row('Contract', call.to)}${row('Funding recipient', item.fundingAddress)}${row('Treasury amount', review.kind === 'payment' ? wei(item.amountWei) + ' ETH' : 'Permission only')}${row('Network', 'Ethereum · chain 1')}</dl><details><summary>Exact unsigned transaction</summary><textarea readonly rows="5" aria-label="Unsigned treasury transaction">${esc(JSON.stringify(call, null, 2))}</textarea></details>${!same(call.from, owner) ? '<p class="hint">This operator differs from your signed-in wallet. Download the call for that operator, then import its finalized transaction hash.</p>' : ''}`;
      signDisabled ||= !same(call.from, owner) || !!pending().find(i => i.refillId === review.id);
    } else {
      const item = findOperation(review.id), q = item?.quote; if (!item || !q) return '';
      body = `<dl class="runway-metrics">${row('Operation', review.kind === 'resume' ? 'Resume only the saved transaction' : item.request.kind)}${row('Amount', item.request.kind === 'return' ? wei(item.request.amountWei) + ' ETH' : gweiEth(String(q.amount)) + ' ETH · entire private note')}${row('Destination', item.request.destination)}${row('Daemon address', item.address)}${row('Estimated network fee', wei(q.required_fee_wei) + ' ETH')}${row('Network fee reserve', wei(q.fee_reserve_wei) + ' ETH')}${row('Public top-up needed', wei(q.recommended_top_up_wei) + ' ETH')}${row('Expires', new Date(q.expires_at).toLocaleTimeString())}${row('Network', 'Ethereum · chain 1')}</dl><p class="address">Quote ${esc(q.id)}</p>${review.kind === 'resume' ? txLink(item.transactionHash) : ''}<p class="hint">This approval instructs the dedicated daemon to sign or broadcast. It is separate from signing a treasury payment in your browser wallet.</p>`;
      signDisabled ||= !approvalEnabled() || operationUncertain(item.id) || (review.kind !== 'resume' && (item.approvalAttempted || item.status !== 'quoted' || q.expires_at <= now() || review.digest !== item.approvalDigest));
      if (review.kind !== 'resume' && item.request.kind === 'withdrawal' && same(item.request.destination, project.mainnet?.treasury) && BigInt(q.recommended_top_up_wei) > 0n && runway?.policy) body += button('recovery-fee', 'Prepare bounded treasury fee top-up', false, `data-intent="${esc(item.id)}"`);
    }
    return `<section class="panel runway-review" aria-live="polite"><h2>Review before approval</h2>${body}<label class="runway-consent"><input type="checkbox" data-runway-review ${accepted ? 'checked' : ''}>I reviewed the exact signer, destination, amount and operation.</label><div class="fee-actions">${button('execute', review.kind === 'retire' ? 'Retire this unsigned preparation' : review.kind === 'payment' || review.kind === 'recipient' ? 'Review in wallet' : 'Approve daemon operation', signDisabled)}${['payment', 'recipient'].includes(review.kind) ? button('download', 'Download unsigned call') : ''}${button('close-review', 'Close review')}</div>${!enabled() ? '<p class="hint">Mainnet transactions remain disabled for this release. Preparing and inspecting does not enable signing.</p>' : ''}</section>`;
  }
  function render() {
    if (!current()) return;
    if (!hosted) { element.innerHTML = '<section class="panel"><h2>Treasury runway & recovery</h2><p class="hint">The hosted service provides per-project private-note funding and recovery. Local development ETH cannot fund Ethereum inference.</p></section>'; return; }
    element.innerHTML = `<div class="runway-head"><h2>Runway & recovery</h2><div class="fee-actions">${button('refresh', 'Refresh saved state')}<button type="button" class="button secondary compact" data-runway="pause-automatic" ${pauseInFlight ? 'disabled' : ''}>Pause automatic funding</button></div></div>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${message ? `<p class="hint" role="status">${esc(message)}</p>` : ''}${!funding ? '<p class="hint">Reading the project funding journal…</p>' : ''}${expiryPanel()}${reviewPanel()}${configurePanel()}${refillPanel()}${operationPanel()}`;
  }
  async function read() {
    const token = ++generation;
    const [r, f] = await Promise.allSettled([api(`${base}/runway`), api(`${base}/funding`)]);
    if (!current() || token !== generation) return;
    if (f.status === 'fulfilled') funding = checkedFunding(f.value, owner, project); else throw f.reason;
    if (r.status === 'fulfilled') runway = checkedRunway(r.value, project, owner); else { runway = null; error = r.reason.message; }
  }
  async function act(fn) {
    if (!current() || busy) return; busy = true; error = ''; render();
    try { await fn(); } catch (e) { if (current()) error = e.message || 'Operation could not be confirmed. Inspect the saved state.'; }
    finally { busy = false; render(); }
  }
  const onClick = event => {
    const target = event.target.closest('[data-runway]'); if (!target || !element.contains(target) || target.disabled) return; event.preventDefault(); event.stopPropagation();
    const action = target.dataset.runway;
    if (action === 'pause-automatic') {
      if (pauseInFlight) return; pauseInFlight = true; error = ''; render();
      (async () => {
        try {
          const result = await post('runway', 'pause');
          if (result.automatic !== false) throw new Error('Automatic funding pause could not be confirmed.');
          if (!current()) return;
          pausedLocally = true; accepted = false;
          message = 'New automatic authorizations are paused. Already signed or submitted transactions cannot be cancelled by this control.'; notify(message);
        } catch (e) { if (current()) error = `Pause not confirmed: ${e.message}. Retry this control before assuming automatic funding has stopped.`; }
        finally { pauseInFlight = false; render(); }
      })();
      return;
    }
    if (action === 'close-review') { review = null; accepted = false; render(); return; }
    act(async () => {
      if (action === 'refresh') { review = null; accepted = false; await read(); }
      else if (action === 'prepare') { await post('runway', 'prepare', { idempotencyKey: crypto.randomUUID() }); await read(); }
      else if (action === 'retire-refill') { const item = runway?.refills.find(i => i.id === target.dataset.refill); if (!canRetireUnsigned(item, funding) || pending().some(i => i.refillId === item.id)) throw new Error('This preparation cannot be proven unsigned. Preserve it for recovery.'); review = { kind: 'retire', id: item.id }; accepted = false; }
      else if (action === 'recover-refill' || action === 'sync') { await post('runway', action === 'sync' ? 'sync' : 'recover', { refillId: target.dataset.refill }); await read(); }
      else if (action.startsWith('inspect-')) { const kind = action.slice(8), result = await post('funding', 'operation-inspect', { kind }); if (current()) inspected[kind] = result; }
      else if (action === 'refresh-operation' || action === 'recover-operation') { await post('funding', action === 'refresh-operation' ? 'operation-refresh' : 'operation-recover', { intentId: target.dataset.intent }); if (action === 'recover-operation') wallet.operationAttempt(target.dataset.intent, true); await read(); }
      else if (action === 'review-operation' || action === 'review-resume') { const item = findOperation(target.dataset.intent); if (!item?.quote) throw new Error('Refresh this saved operation first.'); review = { kind: action === 'review-resume' ? 'resume' : 'operation', id: item.id, digest: item.approvalDigest }; accepted = false; }
      else if (action === 'retry-withdrawal') { const item = findOperation(target.dataset.intent); if (item?.status !== 'reverted' || !hash(item.transactionHash) || item.request.kind !== 'withdrawal') throw new Error('Only a recorded reverted withdrawal can request this retry.'); await post('funding', 'operation-quote', { ...item.request, idempotencyKey: crypto.randomUUID(), retryTransactionHash: item.transactionHash }); await read(); }
      else if (action === 'recovery-fee') { await post('runway', 'recovery-fee', { operationId: target.dataset.intent, idempotencyKey: crypto.randomUUID() }); review = null; accepted = false; await read(); }
      else if (action === 'recipient' || action === 'payment') {
        const item = runway?.refills.find(i => i.id === target.dataset.refill); if (!item || item.status !== 'prepared') throw new Error('Refresh the prepared refill first.');
        if (action === 'recipient') { const expected = item.calls.find(c => c.data.startsWith('0xb33480ca')); const intent = await client.prepare(project.id, 'maintenance', { action: 'recipient', recipient: item.fundingAddress, allowed: true }); if (!current()) return; if (!expected || !same(intent.transaction.to, expected.to) || !same(intent.account, owner) || intent.transaction.data.toLowerCase() !== expected.data.toLowerCase() || intent.transaction.value !== '0x0') throw new Error('Recipient intent differs from the saved refill.'); recipientIntent = intent; }
        review = { kind: action, id: item.id }; accepted = false;
      }
      else if (action === 'execute') {
        if (!review || !accepted || (review.kind !== 'retire' && !enabled())) throw new Error('Enablement and exact review are required.');
        if (review.kind === 'retire') { const item = runway?.refills.find(i => i.id === review.id); if (!canRetireUnsigned(item, funding) || pending().some(i => i.refillId === review.id)) throw new Error('This preparation cannot be proven unsigned.'); const result = await post('runway', 'abandon-unsigned', { refillId: review.id }); if (result.id !== review.id || result.status !== 'abandoned') throw new Error('Retirement was not confirmed; recover saved state before preparing again.'); message = 'Unsigned preparation retired. Its history is preserved; you can review a different principal in the policy.'; }
        else if (review.kind === 'recipient') { const result = await client.execute(project.id, recipientIntent); message = result.status === 'confirmed' ? 'Funding recipient approved. Review the separate treasury payment next.' : 'Recipient transaction saved. Recover it in the Market tab before paying.'; }
        else if (review.kind === 'payment') { const result = await wallet.send(runway, review.id, { enabled: enabled(), reviewed: accepted }); message = result.status === 'funded' ? 'Treasury payment finalized. Review its deposit quote below.' : 'Payment submitted. Save its hash and verify after Ethereum finality.'; }
        else {
          const item = findOperation(review.id); if (!approvalEnabled() || !item || operationUncertain(item.id) || item.approvalDigest !== review.digest) throw new Error('This recovery quote changed or signing is disabled.');
          if (review.kind === 'resume') { if (!item.approvalAttempted || !hash(item.transactionHash) || !['pending', 'resume_unknown'].includes(item.status)) throw new Error('Resume requires the exact saved pending transaction.'); wallet.operationAttempt(item.id); await post('funding', 'operation-resume', { intentId: item.id, transactionHash: item.transactionHash }); wallet.operationAttempt(item.id, true); }
          else { if (item.approvalAttempted || item.status !== 'quoted' || item.quote.expires_at <= now()) throw new Error('Refresh and review the quote before approval.'); wallet.operationAttempt(item.id); await post('funding', 'operation-approve', { intentId: item.id, quoteId: item.quote.id, approvalDigest: review.digest }); wallet.operationAttempt(item.id, true); }
          message = 'Recorded daemon operation updated. Inspect its transaction status.';
        }
        accepted = false; review = null; await read(); notify(message);
      }
      else if (action === 'download' && review && ['payment', 'recipient'].includes(review.kind)) {
        const call = review.kind === 'recipient' ? recipientIntent.transaction : runway.refills.find(i => i.id === review.id).calls.find(c => c.data.startsWith('0x97d4df67'));
        const url = URL.createObjectURL(new Blob([JSON.stringify(call, null, 2)], { type: 'application/json' })), a = document.createElement('a'); a.href = url; a.download = `veyl-${review.kind}-${review.id}.json`; a.click(); URL.revokeObjectURL(url);
      }
    });
  };
  const onChange = event => { if (!element.contains(event.target) || !event.target.matches?.('[data-runway-review]')) return; accepted = event.target.checked === true; render(); };
  const onSubmit = event => {
    const form = event.target.closest('[data-runway-form]'); if (!form || !element.contains(form)) return; event.preventDefault(); event.stopPropagation();
    const value = name => String(form.elements[name]?.value ?? '');
    act(async () => {
      if (form.dataset.runwayForm === 'configure') { const automatic = form.elements.automatic?.checked === true; if (automatic && !automaticAvailable()) throw new Error('Automatic funding is not enabled for this verified treasury operator.'); await post('runway', 'configure', { depositGwei: ethToGwei(value('depositEth')), lowWaterGwei: ethToGwei(value('lowWaterEth')), maxTopUpWei: ethToWei(value('maxTopUpEth')), dailyTopUpWei: ethToWei(value('dailyTopUpEth')), automatic, closeBeforeExpiry: automatic && form.elements.closeBeforeExpiry?.checked === true }); pausedLocally = false; }
      else if (form.dataset.runwayForm === 'confirm') { await wallet.confirm(form.dataset.refill, value('transactionHash')); message = 'Exact treasury receipt verified.'; }
      else if (form.dataset.runwayForm === 'operation') { const kind = value('kind'), destination = value('destination'); if (![owner, project.mainnet?.treasury].some(a => same(a, destination))) throw new Error('Choose your wallet or this project treasury.'); const input = { kind, destination, idempotencyKey: crypto.randomUUID() }; if (kind === 'withdrawal') { const s = inspected.withdrawal; if (!s || !Number.isSafeInteger(s.noteId) || !['ready', 'quoted'].includes(s.phase)) throw new Error('Inspect a ready private note before withdrawal.'); input.noteId = s.noteId; } else if (kind === 'return') { input.amountWei = ethToWei(value('amountEth')); if (input.amountWei === '0') throw new Error('Choose an exact positive return amount.'); } else throw new Error('Unsupported recovery operation.'); await post('funding', 'operation-quote', input); }
      review = null; accepted = false; await read();
    });
  };
  element.addEventListener('click', onClick); element.addEventListener('change', onChange); element.addEventListener('submit', onSubmit);
  const walletChanged = () => { accepted = false; render(); }; client?.addEventListener?.('change', walletChanged);
  render(); const ready = hosted ? act(read) : Promise.resolve();
  return { ready, refresh: () => act(read), isBusy: () => busy || pauseInFlight, destroy() { alive = false; generation++; element.removeEventListener('click', onClick); element.removeEventListener('change', onChange); element.removeEventListener('submit', onSubmit); client?.removeEventListener?.('change', walletChanged); } };
}
