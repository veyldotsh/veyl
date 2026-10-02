const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scopes = { read: 'Read project, models, jobs, memory and drafts', jobs: 'Queue work and manage watchlist checks and schedules using this project’s inference budget', memory: 'Add project memory', drafts: 'Prepare social drafts for owner review' };
const date = value => value ? new Date(value).toLocaleDateString() : '-';
export function mountDeveloperPanel(element, { project, hosted, api, notify = () => {} } = {}) {
  let live = true, busy = false, keys = [], secret = '', error = '', generation = 0;
  const endpoint = `/api/projects/${encodeURIComponent(project.id)}/developer-keys`;
  function render() {
    if (!live) return;
    if (!hosted) { element.innerHTML = '<section class="panel"><h2>Build with Veyl.</h2><p>Project tokens are available in the signed-in hosted workspace. The local demo does not issue credentials.</p><a class="text-link" href="/developers">SDK, API and MCP documentation →</a></section>'; return; }
    element.innerHTML = `<section class="panel"><div class="section-title"><div><h2>Developer access</h2><p>One token, one project, only the permissions you choose.</p></div><a class="text-link" href="/developers">API & SDK →</a></div>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${secret ? `<div class="developer-secret" role="status"><strong>Save this token now. It is shown only once.</strong><p>Keep it in a secret manager or protected environment. Leaving this tab clears this display.</p><input type="password" readonly autocomplete="off" aria-label="New project API token" value="${esc(secret)}"><div class="fee-actions"><button class="button secondary" data-developer="reveal">Show / hide</button><button class="button secondary" data-developer="copy">Copy token</button><button class="button secondary" data-developer="dismiss">I saved it</button></div></div>` : ''}<details><summary>Create a project token</summary><form data-developer-form><fieldset ${busy || secret ? 'disabled' : ''}><label>Token name<input name="name" maxlength="64" required placeholder="My research integration" autocomplete="off"></label><div class="developer-scopes">${Object.entries(scopes).map(([scope, label]) => `<label><input type="checkbox" name="scope" value="${scope}" ${scope === 'read' ? 'checked' : ''}><span><strong>${scope}</strong> · ${label}</span></label>`).join('')}</div><label>Expires after<select name="expiresInDays"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label><p class="hint">The jobs permission can queue tasks, create or edit watchlists, and run checks. Enabled watch schedules can queue reports and optional reviewer jobs that consume funded inference allowance under the project’s existing limits. Tokens cannot fund wallets, trade, change treasury settings, approve drafts or publish posts.</p><button class="button" type="submit">Issue token</button></fieldset></form></details><div class="developer-keys">${keys.length ? keys.map(key => `<article class="artifact"><div class="section-title"><div><b>${esc(key.name)}</b><p>${esc(key.scopes.join(', '))} · Expires ${esc(date(key.expiresAt))}</p></div><button class="button secondary" data-developer="revoke" data-key="${esc(key.id)}" ${busy || key.revokedAt ? 'disabled' : ''}>${key.revokedAt ? 'Revoked' : 'Revoke'}</button></div><small>Created ${esc(date(key.createdAt))} · ${esc(key.prefix || key.id)}</small></article>`).join('') : '<p class="hint">No project tokens yet. Start with read-only access.</p>'}</div><button class="text-link" data-developer="refresh" ${busy ? 'disabled' : ''}>Refresh token list</button></section>`;
  }
  async function refresh() {
    const current = ++generation;
    try { const result = await api(endpoint); if (!live || current !== generation) return; if (!Array.isArray(result.keys) || result.keys.some(k => typeof k.id !== 'string' || !Array.isArray(k.scopes))) throw Error('The token list could not be verified.'); keys = result.keys; error = ''; }
    catch (e) { if (live && current === generation) error = String(e.message).replace(/veyl_sk_[a-f0-9]{64}/gi, '[redacted]'); }
    render();
  }
  async function click(event) {
    const button = event.target.closest('[data-developer]'); if (!button || !element.contains(button) || button.disabled) return;
    const action = button.dataset.developer;
    if (action === 'reveal') { const input = element.querySelector('.developer-secret input'); input.type = input.type === 'password' ? 'text' : 'password'; return; }
    if (action === 'dismiss') { secret = ''; render(); return; }
    if (action === 'copy') { try { await navigator.clipboard.writeText(secret); notify('Token copied. Keep it private.'); } catch { notify('Copy unavailable. Reveal and copy the token manually.'); } return; }
    if (busy) return; busy = true; error = ''; render();
    try { if (action === 'revoke') { await api(`${endpoint}/${encodeURIComponent(button.dataset.key)}/revoke`, {}); secret = ''; } await refresh(); }
    catch (e) { error = String(e.message).replace(/veyl_sk_[a-f0-9]{64}/gi, '[redacted]'); }
    finally { busy = false; render(); }
  }
  async function submit(event) {
    if (!event.target.matches('[data-developer-form]')) return; event.preventDefault(); if (busy || secret) return;
    const values = new FormData(event.target), selected = values.getAll('scope');
    if (!selected.length || selected.some(scope => !Object.hasOwn(scopes, scope))) { error = 'Choose at least one permission.'; render(); return; }
    const body = { name: values.get('name'), scopes: selected, expiresInDays: Number(values.get('expiresInDays')) };
    busy = true; error = ''; render();
    try { const result = await api(endpoint, body); if (!live) return; if (!/^veyl_sk_[a-f0-9]{64}$/.test(result.token || '')) throw Error('Token creation outcome is uncertain. Inspect the list and revoke the new token before creating another.'); secret = result.token; await refresh(); }
    catch (e) { if (live) error = 'Token issuance was not confirmed. Inspect the list and revoke any unexpected token before trying again.'; }
    finally { busy = false; render(); }
  }
  element.addEventListener('click', click); element.addEventListener('submit', submit); render(); if (hosted) void refresh();
  return { refresh, destroy() { live = false; generation++; secret = ''; element.innerHTML = ''; element.removeEventListener('click', click); element.removeEventListener('submit', submit); } };
}
