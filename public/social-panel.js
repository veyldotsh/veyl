const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const channels = new Set(['x', 'telegram']);
const states = new Set(['draft', 'sending', 'published', 'failed', 'unknown', 'cancelled']);
const label = channel => channel === 'x' ? 'X' : 'Telegram';
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const date = value => Number.isFinite(value) ? new Date(value).toLocaleString() : 'Unknown';

export function checkedSocialSnapshot(value, projectId) {
  if (!value || value.projectId !== projectId || !value.accounts || !Array.isArray(value.outbox) || value.outbox.length > 2000 || typeof value.publishingEnabled !== 'boolean' || typeof value.xConfigured !== 'boolean') throw new Error('The connection status could not be verified. Refresh before continuing.');
  if (value.xApp !== undefined) {
    const app = value.xApp;
    if (!app || !['platform', 'custom'].includes(app.mode) || typeof app.platformAvailable !== 'boolean' || Object.keys(app).some(key => !['mode', 'callbackUri', 'platformAvailable'].includes(key))) throw new Error('The X app status could not be verified.');
    if (app.callbackUri !== null) { let url; try { url = new URL(app.callbackUri); } catch {} if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The fixed X callback could not be verified.'); }
  }
  const ids = new Set();
  for (const item of value.outbox) {
    if (!uuid(item.id) || ids.has(item.id) || !channels.has(item.channel) || !states.has(item.status) || item.preview?.projectId !== projectId || item.preview?.channel !== item.channel || typeof item.preview.text !== 'string' || item.preview.text.length > 4096 || !/^[a-f0-9]{64}$/.test(item.approvalDigest || '') || !Number.isFinite(item.expiresAt)) throw new Error('A draft has invalid review data. Publishing is unavailable.');
    ids.add(item.id);
  }
  return structuredClone(value);
}

export function checkedXAuthorization(value, projectId) {
  let url; try { url = new URL(value?.authorizationUrl); } catch { throw new Error('X returned an invalid authorization link.'); }
  if (url.origin !== 'https://x.com' || url.pathname !== '/i/oauth2/authorize' || url.username || url.password || url.hash ||
      typeof value.state !== 'string' || !value.state.startsWith(projectId + '.') || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value.state) ||
      url.searchParams.get('state') !== value.state || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('The X authorization link does not match this project.');
  // Navigate to the exact server URL. The browser never invents a successful
  // callback or reconstructs OAuth parameters. Saved credentials are never read back.
  return value.authorizationUrl;
}

function destination(preview) {
  return preview.channel === 'x' ? `@${preview.username || preview.accountId} · account ${preview.accountId}` : `${preview.chatTitle || 'Telegram chat'} · ${preview.chatId}`;
}

/** One project-scoped panel. Only explicit clicks can authorize connection or
 * publishing; background refreshes are read-only. Destroy on SPA navigation. */
export function mountSocialPanel(element, { project, hosted = false, api, notify = () => {}, navigate = url => location.assign(url), now = Date.now } = {}) {
  if (!uuid(project?.id)) throw new Error('Invalid project connection scope.');
  const base = `/api/projects/${encodeURIComponent(project.id)}/social`;
  let live = true, busy = false, snapshot = null, error = '', reviewed = null, selected = null, page = 0, loading = true, composeOpen = false;
  let compose = { channel: 'x', text: '', key: crypto.randomUUID() };
  const unknown = new Set();
  const active = () => live && element.isConnected !== false;
  const button = (action, title, disabled = false, extra = '') => `<button type="button" class="button secondary compact" data-social="${action}" ${disabled || busy ? 'disabled' : ''} ${extra}>${title}</button>`;
  const account = channel => snapshot?.accounts[channel];
  const canDraft = channel => account(channel)?.status === 'connected';

  function xAppSettings() {
    const app = snapshot.xApp; if (!app) return '';
    const connected = !!account('x');
    return `<details><summary>X app · ${app.mode === 'custom' ? 'Your app' : 'Veyl app'}</summary><p class="hint">Use Veyl’s app when available, or supply your own OAuth 2.0 app for this agent. Register this exact callback in X:</p><p class="address"><code>${esc(app.callbackUri || 'Server callback unavailable')}</code></p><p class="hint">Enable tweet.read, tweet.write, users.read and offline.access. X app access and API permissions are managed in your X developer account.</p>${connected ? '<p class="hint">Disconnect this agent’s X account below before changing its app. This cancels unsent X drafts and pending authorizations.</p>' : app.callbackUri ? `<form data-social-form="x-app" autocomplete="off"><fieldset ${busy ? 'disabled' : ''}><label>OAuth 2.0 client ID<input name="clientId" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="512" required placeholder="Enter your app client ID"></label><label>Client secret · confidential apps only<input type="password" name="clientSecret" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="4096" placeholder="Leave blank only for a public app"></label><p class="hint">Credentials are encrypted for this agent and never displayed again. Saving replaces its app and cancels pending X authorizations and unsent drafts. Web and bot apps normally require a client secret.</p><button type="submit" class="button secondary">Save my X app</button></fieldset></form>${app.mode === 'custom' ? button('x-app-platform', app.platformAvailable ? 'Remove my app · use Veyl app' : 'Remove my saved app') : ''}${!app.platformAvailable ? '<p class="hint">The Veyl app is unavailable. Your own configured app can be used instead.</p>' : ''}` : '<p class="hint">The server callback must be available before an app can be saved.</p>'}</details>`;
  }

  function accountCard(channel) {
    const saved = account(channel), connected = saved?.status === 'connected', reconnect = !!saved && !connected;
    const status = connected ? 'Connected' : reconnect ? 'Reconnect required' : 'Not connected';
    return `<article class="panel"><div class="section-title"><div><h2>${label(channel)}</h2><p>${esc(status)}</p></div><span class="badge">${connected ? 'CONNECTED' : 'ACCOUNT'}</span></div>${saved ? `<p><strong>${esc(saved.username ? '@' + saved.username : saved.id)}</strong>${channel === 'telegram' ? `<br><span class="hint">${esc(saved.chatTitle || 'Telegram chat')} · ${esc(saved.chatId)}</span>` : ''}</p>` : `<p class="subtext">${channel === 'x' ? 'Authorize this project to prepare and publish reviewed posts.' : 'Connect a bot to the exact group, channel or private chat you choose.'}</p>`}${channel === 'x' ? `${button('x-begin', saved ? 'Reconnect X ↗' : 'Connect X ↗', !snapshot.xConfigured)}${!snapshot.xConfigured ? '<p class="hint">Configure your own X app below, or use the Veyl app when available.</p>' : '<p class="hint">Continue on X to review account permissions.</p>'}${xAppSettings()}` : `<details><summary>${saved ? 'Replace Telegram connection' : 'Connect a Telegram bot'}</summary><form data-social-form="telegram" autocomplete="off"><fieldset ${busy ? 'disabled' : ''}><label>Bot token<input type="password" name="token" autocomplete="off" spellcheck="false" autocapitalize="off" required maxlength="256" placeholder="Enter your bot token" aria-describedby="telegram-token-note"></label><label>Exact numeric chat ID<input name="chatId" inputmode="numeric" autocomplete="off" required maxlength="17" pattern="-?[1-9][0-9]{0,15}" placeholder="e.g. -1001234567890"></label><p id="telegram-token-note" class="hint">Sent securely to this workspace and encrypted at rest. The operator can decrypt hosted credentials. The token field clears when submitted. Groups and channels require bot administrator permission.</p><button type="submit" class="button secondary">Verify & connect</button></fieldset></form></details>`}${saved ? `<details><summary>Connection settings</summary><p class="hint">Disconnecting removes this project’s stored credentials and cancels its unsent drafts. Revoke app access on X or rotate the Telegram token to invalidate provider credentials too.</p>${button('disconnect', 'Disconnect ' + label(channel), false, `data-channel="${channel}"`)}</details>` : ''}</article>`;
  }
  function reviewPanel(item) {
    if (!item) return '<div class="empty"><b>Review before anything leaves.</b>Open a saved draft to inspect its exact account, destination and text.</div>';
    const status = unknown.has(item.id) ? 'unknown' : item.status, expired = item.expiresAt <= now(), current = account(item.channel)?.connectionId === item.preview.connectionId;
    const publishable = status === 'draft' && !expired && current && snapshot.publishingEnabled && reviewed === item.approvalDigest;
    const postedId = item.result?.id && /^[1-9][0-9]{0,20}$/.test(item.result.id) ? item.result.id : null;
    return `<div class="social-review"><div class="section-title"><div><h3>${label(item.channel)} · ${esc(status)}</h3><p>${esc(destination(item.preview))}</p></div></div><pre class="social-copy">${esc(item.preview.text)}</pre>${item.channel === 'x' ? `<p class="hint">AI-assisted draft: ${item.preview.madeWithAi === true ? 'yes' : 'no'}. This is a Veyl review note, not an X media label.</p>` : '<p class="hint">Plain text · link previews disabled.</p>'}<details><summary>Exact review record</summary><p class="hint">Expires ${esc(date(item.expiresAt))}</p><div class="address">${esc(item.approvalDigest)}</div></details>${status === 'draft' ? `${expired ? '<p class="error">This draft expired. Prepare a fresh preview.</p>' : !current ? '<p class="error">The connected account changed. Prepare a fresh preview.</p>' : `<label class="choice"><input type="checkbox" data-social-review="${esc(item.id)}" ${reviewed === item.approvalDigest ? 'checked' : ''} ${busy ? 'disabled' : ''}><span>I reviewed this exact text and destination.</span></label>`}${!snapshot.publishingEnabled ? '<p class="hint">Publishing is disabled for this workspace. Drafts remain available for review.</p>' : ''}<div class="fee-actions">${button('publish', 'Approve & publish', !publishable, `data-intent="${esc(item.id)}"`)}${button('cancel', 'Cancel draft', false, `data-intent="${esc(item.id)}"`)}</div>` : status === 'unknown' || status === 'sending' ? '<p class="error" role="status">Publication may have succeeded. Check the provider before creating a replacement. This item will not retry automatically.</p>' : status === 'published' ? `<p class="hint">Published${postedId ? ' · ID ' + esc(postedId) : ''}.</p>${item.channel === 'x' && postedId ? `<a class="text-link" href="https://x.com/i/status/${postedId}" target="_blank" rel="noopener noreferrer">View on X ↗</a>` : ''}` : `<p class="hint">${status === 'failed' ? 'The provider rejected this publication. A new draft and approval are required.' : 'Cancelled. Nothing will be published from this draft.'}</p>`}</div>`;
  }
  function render() {
    if (!active()) return;
    if (!hosted) { element.innerHTML = `<section class="panel"><div class="section-title"><div><h2>Give your agent a voice.</h2><p>X and Telegram · reviewed publishing</p></div><span class="badge">HOSTED WORKSPACE</span></div><p class="subtext">Connect accounts from a signed-in hosted workspace. This local demo does not accept credentials or publish posts.</p><div class="tool-grid"><article class="tool"><h3>X</h3><span class="tool-state">Account authorization</span><p>Connect through X, then review the exact text before publishing.</p></article><article class="tool"><h3>Telegram</h3><span class="tool-state">Bot & destination</span><p>Choose a bot and chat. Your agent can prepare drafts for your approval.</p></article></div><p class="hint">The agent prepares the work. Publishing always requires your approval.</p></section>`; return; }
    if (!snapshot) { element.innerHTML = `<section class="panel"><h2>Project connections</h2><p role="status">${loading ? 'Reading your account connections…' : esc(error || 'Connection status is unavailable.')}</p>${loading ? '' : button('refresh', 'Try reading status again')}</section>`; return; }
    const items = snapshot.outbox.slice().reverse(), pages = Math.max(1, Math.ceil(items.length / 3)); page = Math.min(page, pages - 1);
    const selectedItem = snapshot.outbox.find(item => item.id === selected);
    element.innerHTML = `<div class="section-title"><div><h2>Connections</h2><p>Accounts and reviewed posts for ${esc(project.name)}.</p></div>${button('refresh', 'Refresh status')}</div>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<div class="two-col">${accountCard('x')}${accountCard('telegram')}</div><section class="panel social-outbox"><div class="section-title"><div><h2>Drafts & publications</h2><p>Agents can draft. Only you can approve publication.</p></div><span class="badge">${items.length} ITEMS</span></div><details ${composeOpen ? 'open' : ''}><summary>Write a draft</summary><form data-social-form="draft"><fieldset ${busy ? 'disabled' : ''}><label>Channel<select name="channel"><option value="x" ${compose.channel === 'x' ? 'selected' : ''} ${canDraft('x') ? '' : 'disabled'}>X${canDraft('x') ? '' : ' · connect first'}</option><option value="telegram" ${compose.channel === 'telegram' ? 'selected' : ''} ${canDraft('telegram') ? '' : 'disabled'}>Telegram${canDraft('telegram') ? '' : ' · connect first'}</option></select></label><label>Exact text<textarea name="text" maxlength="4096" required placeholder="Prepare a post for review.">${esc(compose.text)}</textarea></label><p class="hint">${compose.channel === 'x' ? 'X allows 280 weighted characters. The server checks URL, emoji and Unicode counting before saving. AI assistance is recorded with the draft.' : 'Up to 4,096 characters. Plain text, with link previews disabled.'}</p><button type="submit" class="button secondary" ${canDraft(compose.channel) ? '' : 'disabled'}>Save reviewable draft</button></fieldset></form></details><div class="two-col"><div>${items.slice(page * 3, page * 3 + 3).map(item => `<article class="artifact"><span class="badge">${label(item.channel)} · ${esc(unknown.has(item.id) ? 'unknown' : item.status)}</span><p>${esc(item.preview.text.slice(0, 100))}${item.preview.text.length > 100 ? '…' : ''}</p>${button('review', selected === item.id ? 'Review open' : 'Review details', false, `data-intent="${esc(item.id)}"`)}</article>`).join('') || '<div class="empty"><b>No drafts yet.</b>Connect an account, then ask your agent for a draft or write one here.</div>'}${pages > 1 ? `<nav class="pagination" aria-label="Social draft pages">${button('previous', '← Previous', page === 0)}<span>${page + 1} / ${pages}</span>${button('next', 'Next →', page === pages - 1)}</nav>` : ''}</div><div>${reviewPanel(selectedItem)}</div></div></section>`;
  }
  async function read() {
    const result = checkedSocialSnapshot(await api(base), project.id);
    if (!active()) return;
    snapshot = result; loading = false;
    for (const item of result.outbox) if (['published', 'failed', 'cancelled'].includes(item.status)) unknown.delete(item.id);
    if (!canDraft(compose.channel)) compose.channel = canDraft('x') ? 'x' : canDraft('telegram') ? 'telegram' : 'x';
  }
  async function run(operation) {
    if (!active() || busy) return;
    busy = true; error = ''; render();
    try { await operation(); }
    catch (failure) { if (active()) error = failure instanceof Error ? failure.message : 'The operation could not be confirmed.'; }
    finally { if (active()) { busy = false; loading = false; render(); } }
  }
  async function refresh() { return run(read); }
  const click = event => {
    const control = event.target.closest('[data-social]'); if (!control || !element.contains(control) || control.disabled || busy) return;
    event.preventDefault(); const action = control.dataset.social;
    if (action === 'review') { selected = control.dataset.intent; reviewed = null; render(); return; }
    if (action === 'previous' || action === 'next') { page += action === 'next' ? 1 : -1; render(); return; }
    if (action === 'refresh') { void refresh(); return; }
    void run(async () => {
      if (action === 'x-begin') {
        if (!snapshot.xConfigured) throw new Error('The X developer app is not configured.');
        const result = await api(base + '/x-begin', {}); if (active()) navigate(checkedXAuthorization(result, project.id)); return;
      }
      if (action === 'disconnect') {
        if (!channels.has(control.dataset.channel)) return;
        await api(base + '/disconnect', { channel: control.dataset.channel }); if (active()) { reviewed = null; notify('Connection removed from this project.'); } await read(); return;
      }
      if (action === 'x-app-platform') {
        if (account('x') || snapshot.xApp?.mode !== 'custom') throw new Error('Disconnect this agent’s X account before changing its app.');
        await api(base + '/x-app', { mode: 'platform' }); reviewed = null; await read(); if (active()) notify('Custom X app removed from this agent.'); return;
      }
      const item = snapshot.outbox.find(entry => entry.id === control.dataset.intent);
      if (!item) throw new Error('Read the current draft before continuing.');
      if (action === 'publish') {
        if (!snapshot.publishingEnabled || item.status !== 'draft' || unknown.has(item.id) || selected !== item.id || reviewed !== item.approvalDigest || item.expiresAt <= now() || account(item.channel)?.connectionId !== item.preview.connectionId) throw new Error('Review the exact current draft and destination before publishing.');
        const approval = { intentId: item.id, approvalDigest: item.approvalDigest }; reviewed = null;
        // Once sent, an uncertain response is never exposed as a retry button.
        unknown.add(item.id);
        try { await api(base + '/publish', approval); await read(); }
        catch (failure) { try { await read(); } catch {} throw failure; }
      } else if (action === 'cancel') { if (unknown.has(item.id)) throw new Error('Check the provider before changing an uncertain publication.'); await api(base + '/cancel', { intentId: item.id }); reviewed = null; await read(); }
    });
  };
  const input = event => {
    const form = event.target.closest('[data-social-form="draft"]');
    if (form && element.contains(form) && !busy) { composeOpen = true; compose = { channel: form.elements.channel.value, text: form.elements.text.value, key: crypto.randomUUID() }; }
  };
  const change = event => {
    if (event.target.matches('[data-social-review]')) { const item = snapshot?.outbox.find(entry => entry.id === event.target.dataset.socialReview); reviewed = item && item.id === selected && event.target.checked ? item.approvalDigest : null; render(); }
    else if (event.target.name === 'channel' && event.target.closest('[data-social-form="draft"]')) { input(event); render(); }
  };
  const submit = event => {
    const form = event.target.closest('[data-social-form]'); if (!form || !element.contains(form)) return;
    event.preventDefault(); event.stopPropagation(); if (busy || !hosted) return;
    if (form.dataset.socialForm === 'x-app') {
      const payload = { mode: 'custom', clientId: form.elements.clientId.value.trim(), clientSecret: form.elements.clientSecret.value.trim() };
      form.elements.clientId.value = ''; form.elements.clientSecret.value = '';
      void run(async () => {
        try {
          if (account('x') || !snapshot?.xApp?.callbackUri) throw new Error();
          await api(base + '/x-app', payload); reviewed = null; await read(); if (active()) notify('X app saved for this agent. Connect X to authorize its account.');
        } catch { throw new Error('X app settings could not be confirmed. Disconnect X first if connected, then refresh status before trying again.'); }
        finally { payload.clientId = ''; payload.clientSecret = ''; }
      });
    } else if (form.dataset.socialForm === 'telegram') {
      const payload = { token: form.elements.token.value.trim(), chatId: form.elements.chatId.value.trim() };
      form.elements.token.value = ''; form.elements.chatId.value = '';
      void run(async () => { try { await api(base + '/telegram', payload); if (active()) notify('Telegram destination verified.'); await read(); } finally { payload.token = ''; payload.chatId = ''; } });
    } else if (form.dataset.socialForm === 'draft') {
      compose.channel = form.elements.channel.value; compose.text = form.elements.text.value;
      const payload = { channel: compose.channel, text: compose.text, idempotencyKey: compose.key, madeWithAi: true };
      void run(async () => { const result = await api(base + '/draft', payload); if (!active()) return; selected = result.id; reviewed = null; composeOpen = false; compose = { channel: payload.channel, text: '', key: crypto.randomUUID() }; page = 0; await read(); });
    }
  };
  element.addEventListener('click', click); element.addEventListener('input', input); element.addEventListener('change', change); element.addEventListener('submit', submit);
  render(); const ready = hosted ? refresh() : Promise.resolve();
  return { ready, refresh, isBusy: () => busy, destroy() { live = false; snapshot = null; compose.text = ''; reviewed = null; element.querySelectorAll('input[type="password"]').forEach(field => { field.value = ''; }); element.removeEventListener('click', click); element.removeEventListener('input', input); element.removeEventListener('change', change); element.removeEventListener('submit', submit); } };
}
