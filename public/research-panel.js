const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const stamp = value => value && Number.isFinite(+new Date(value)) ? new Date(value).toLocaleString() : 'Not checked yet';
const usd = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value / 1e6);
const statuses = { checking: 'Checking sources', baseline: 'Baseline saved', changed: 'Source changed', unchanged: 'No change', error: 'Source unavailable', interrupted: 'Interrupted', pending: 'Waiting for report', queued: 'Queued', running: 'Running', completed: 'Completed', blocked: 'Needs attention', none: 'No inference needed' };
const cadence = { 60: 'Hourly', 360: 'Every 6 hours', 1440: 'Daily' };
const toolNames = { read_source: 'Read source', chain_read: 'Read Ethereum data', save_note: 'Saved a project note', prepare_social_draft: 'Prepared a draft for review' };

export function researchSourceUrl(value, hosts) {
  let url; try { url = new URL(value); } catch { throw Error('Enter a complete HTTPS source URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) throw Error('Use an HTTPS URL on one of the supported source hosts below.');
  return url.href;
}

export function researchCharges(job, demo = false) {
  if (demo || job.mode === 'demo') return { label: 'Simulated usage', text: 'Demo output does not spend inference funds.' };
  if (!Number.isSafeInteger(job.reservation) || job.reservation < 0) return { label: 'Usage unavailable', text: 'Wait for the recorded job budget before checking costs.' };
  const calls = (job.steps || []).flatMap(step => [step, ...(step.additionalCalls || [])]).map(step => step.callAccounting).filter(Boolean);
  let wei = 0n, valued = 0, count = 0;
  for (const call of calls) {
    if (call.status !== 'settled') continue;
    if (!/^(0|[1-9][0-9]{0,77})$/.test(call.chargeWei) || !Number.isSafeInteger(call.valuationMicroUsd) || call.valuationMicroUsd < 0) return { label: 'Usage unavailable', text: 'The settlement record could not be read. Reserved budget remains held.' };
    wei += BigInt(call.chargeWei); valued += call.valuationMicroUsd; count++;
  }
  if (!Number.isSafeInteger(valued) || valued > job.reservation) return { label: 'Usage unavailable', text: 'The recorded budget needs reconciliation.' };
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  const eth = (wei / 10n ** 18n).toString() + (fraction ? '.' + fraction : '');
  return { label: count ? `${eth} ETH settled` : 'No settled charge yet', text: `${usd(valued)} verified budget value · ${usd(job.reservation - valued)} reserved. Unresolved caps stay held; these are not additional charges.` };
}

export function checkedResearchSnapshot(value) {
  if (!value || !Array.isArray(value.watchlists) || value.watchlists.length > 100 || !Array.isArray(value.checks) || value.checks.length > 1000 || !Array.isArray(value.sourceHosts) || value.sourceHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))) throw Error('Research history could not be verified. Refresh before making changes.');
  const ids = new Set();
  for (const watch of value.watchlists) {
    if (typeof watch.id !== 'string' || ids.has(watch.id) || typeof watch.name !== 'string' || typeof watch.brief !== 'string' || !Array.isArray(watch.sources) || watch.sources.length < 1 || watch.sources.length > 3 || typeof watch.enabled !== 'boolean' || !Object.hasOwn(cadence, watch.cadenceMinutes)) throw Error('Research watch settings could not be verified.');
    ids.add(watch.id); watch.sources.forEach(url => researchSourceUrl(url, value.sourceHosts));
  }
  const checks = new Set();
  for (const check of value.checks) {
    if (typeof check.id !== 'string' || checks.has(check.id) || !ids.has(check.watchId) || !['checking', 'baseline', 'changed', 'unchanged', 'error', 'interrupted'].includes(check.status) || !Array.isArray(check.sources) || check.sources.length > 3) throw Error('Research check history could not be verified.');
    checks.add(check.id);
    check.sources.forEach(source => { researchSourceUrl(source.url, value.sourceHosts); if (!['baseline', 'changed', 'unchanged', 'error'].includes(source.status)) throw Error('Unrecognized source check status.'); });
  }
  return value;
}

export function mountResearchPanel(element, { project, api, hosted = true, mode = 'zkapi', notify = () => {}, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let live = true, busy = false, refreshing = false, generation = 0, snapshot = null, error = '', modelError = '', models = [], editing = null, historyPage = 0;
  let createKey = crypto.randomUUID(); const checkKeys = new Map();
  const base = `/api/projects/${encodeURIComponent(project.id)}`;
  const region = name => element.querySelector(`[data-research-${name}]`);
  element.innerHTML = `<section class="panel research-panel"><div class="section-title"><div><p class="eyebrow">A RECORD YOU CAN FOLLOW</p><h2>Research</h2><p>Watch sources, inspect changes and keep the findings.</p></div><button class="button secondary" data-research="refresh">Refresh</button></div><p class="hint">Source checks and reports stay in this agent’s workspace.${mode === 'demo' ? ' Model reports in the local demo are simulated.' : ''}</p><div data-research-message role="status" aria-live="polite"></div><div data-research-editor></div><div data-research-watches></div><section class="research-history" aria-label="Research history"><div class="section-title"><h2>Observed activity</h2><span data-research-count class="hint"></span></div><div data-research-history></div></section></section>`;

  function modelOptions(selected = '') {
    return `<option value="">No second-model review</option>${models.filter(model => model.id !== project.model).map(model => `<option value="${esc(model.id)}" ${model.id === selected ? 'selected' : ''}>${esc(model.id)}${Number.isSafeInteger(model.oa_request_limit_micro_usd) ? ` · ${esc(usd(model.oa_request_limit_micro_usd))} per-call cap` : ''}</option>`).join('')}${selected && !models.some(model => model.id === selected) ? `<option value="${esc(selected)}" selected>${esc(selected)} · unavailable in current catalog</option>` : ''}`;
  }
  function renderEditor(watch = null) {
    editing = watch?.id || null;
    region('editor').innerHTML = `<details class="research-editor" ${watch ? 'open' : ''}><summary>${watch ? 'Edit watchlist' : 'Add a source watch'}</summary><form data-research-form><fieldset ${!snapshot || busy ? 'disabled' : ''}><label>Name<input name="name" required maxlength="80" autocomplete="off" placeholder="Ethereum protocol updates" value="${esc(watch?.name)}"></label><label>What should the report focus on?<textarea name="brief" maxlength="1200" required placeholder="Explain material changes, quote supporting evidence and separate confirmed facts from open questions.">${esc(watch?.brief)}</textarea></label><label>Source URLs<textarea name="sources" required rows="3" placeholder="One supported HTTPS URL per line, up to 3">${esc(watch?.sources?.join('\n'))}</textarea></label><details><summary>Supported sources</summary><p class="hint" data-research-hosts>${snapshot ? snapshot.sourceHosts.map(esc).join(', ') : 'Loading…'}</p><p class="hint">Only captured text is compared; pages may change beyond that capture.</p></details><details><summary>Schedule & second-model review</summary><label class="research-choice"><input type="checkbox" name="enabled" ${watch?.enabled ? 'checked' : ''}><span>Check automatically. A captured text change can queue a paid report.</span></label><label>Check frequency<select name="cadenceMinutes">${Object.entries(cadence).map(([minutes, label]) => `<option value="${minutes}" ${Number(minutes) === (watch?.cadenceMinutes || 1440) ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Optional reviewer model<select name="reviewerModel">${modelOptions(watch?.reviewerModel || '')}</select></label><p class="hint" data-research-model-hint>${esc(modelError || 'The report uses this agent’s selected model. A different reviewer runs only after a completed report and uses an additional budget reservation. It does not guarantee correctness.')}</p></details><p class="hint">The first successful check establishes a baseline. No change means no inference. Reports stay subject to the agent’s active status, funding and spending limits. Nothing is posted to social accounts.</p><div class="research-actions"><button class="button" type="submit">${watch ? 'Save watchlist' : 'Create watchlist'}</button>${watch ? '<button class="button secondary" type="button" data-research="cancel-edit">Cancel</button>' : ''}</div></fieldset></form></details>`;
  }
  function sourceLink(url) { return `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>`; }
  function evidence(source) {
    return `<div class="research-evidence"><div class="research-event-head"><strong>${esc(statuses[source.status] || source.status)}</strong><time>${source.fetchedAt ? 'Fetched' : 'Attempted'} ${esc(stamp(source.fetchedAt || source.attemptedAt))}</time></div>${sourceLink(source.url)}${source.error ? `<p class="error">${esc(source.error)}</p>` : ''}${source.afterExcerpt || source.beforeExcerpt ? `<details data-research-detail="${esc(source.url)}"><summary>${source.status === 'changed' ? 'Compare captured excerpts' : 'Read captured excerpt'}</summary>${source.beforeExcerpt ? `<h4>Previous capture</h4><blockquote>${esc(source.beforeExcerpt)}</blockquote>` : ''}${source.afterExcerpt ? `<h4>Latest capture</h4><blockquote>${esc(source.afterExcerpt)}</blockquote>` : ''}<p class="hint">Excerpts from fetched text, not a complete page diff.${source.possiblyTruncated ? ' Comparison covers the first 20,000 captured characters.' : ''}</p></details>` : ''}</div>`;
  }
  function reportCard(report, label) {
    if (!report || report.status === 'none') return '';
    const job = report.job, artifact = report.artifact;
    const charge = job ? researchCharges(job, artifact?.mode === 'demo') : null;
    return `<section class="research-report"><div class="research-event-head"><h4>${label}</h4><span class="status">${esc(statuses[report.status] || report.status)}</span></div>${report.error || job?.error ? `<p class="error">${esc(report.error || job.error)}</p>` : ''}${report.status === 'blocked' ? '<p class="hint">No automatic retry. Review funding, model and limits in Runtime. To cover this same change after fixing them, submit a manual task there.</p><button class="text-link" data-tab="runtime">Review model & budget →</button>' : ''}${job ? `<p class="hint">${esc(job.model)} · ${esc(stamp(job.at))}<br>Job ${esc(job.id)}</p><ol class="research-stages">${(job.steps || []).map(step => `<li><strong>${esc(step.role)}</strong><span>${esc(statuses[step.status] || step.status)}</span>${step.toolActivity?.length ? `<ul>${step.toolActivity.map(activity => `<li>${esc(toolNames[activity.name] || activity.name)} · ${esc(activity.status)} <time>${esc(stamp(activity.at))}</time></li>`).join('')}</ul>` : ''}${step.output && !artifact ? `<details><summary>Read ${esc(step.role)} output</summary><pre>${esc(step.output)}</pre></details>` : ''}</li>`).join('')}</ol><div class="research-cost"><strong>${esc(charge.label)}</strong><p>${esc(charge.text)}</p></div>` : ''}${artifact ? `<details class="research-findings" data-research-detail="artifact-${esc(artifact.id)}"><summary>Read ${label.toLowerCase()} findings</summary><pre>${esc(artifact.content)}</pre>${artifact.preview ? '<p class="hint">Report preview. Download the full findings below.</p>' : ''}<a class="text-link" href="/api/artifacts/${encodeURIComponent(artifact.id)}">Download report ↗</a></details>` : ''}</section>`;
  }
  function renderData() {
    if (!live) return;
    region('message').innerHTML = error ? `<p class="error" role="alert">${esc(error)}</p>` : busy ? '<p class="hint">Saving this action…</p>' : '';
    if (!snapshot) { region('watches').innerHTML = `<p class="hint">${error ? 'Research history is unavailable until the connection is restored. Refresh to try again.' : 'Reading source watches and recorded checks…'}</p>`; return; }
    region('watches').innerHTML = snapshot.watchlists.length ? `<div class="research-watchlist">${snapshot.watchlists.map(watch => `<article class="research-watch"><div class="research-event-head"><h3>${esc(watch.name)}</h3><span class="status">${watch.enabled ? esc(cadence[watch.cadenceMinutes]) : 'Manual'}</span></div><p>${esc(watch.brief)}</p><ul class="research-source-list">${watch.sources.map(url => `<li>${sourceLink(url)}</li>`).join('')}</ul><p class="hint">Last check: ${esc(stamp(watch.lastCheckedAt))}${watch.enabled && watch.nextAt ? `<br>Next check: ${esc(stamp(watch.nextAt))}` : ''}${watch.reviewerModel ? `<br>Reviewer: ${esc(watch.reviewerModel)}` : ''}</p><div class="research-actions"><button class="button secondary" data-research="check" data-watch="${esc(watch.id)}" ${busy || project.status !== 'active' ? 'disabled' : ''}>Check now</button><button class="text-link" data-research="edit" data-watch="${esc(watch.id)}" ${busy ? 'disabled' : ''}>Edit</button><button class="text-link" data-research="toggle" data-watch="${esc(watch.id)}" ${busy ? 'disabled' : ''}>${watch.enabled ? 'Pause checks' : 'Enable schedule'}</button></div></article>`).join('')}</div>` : '<div class="empty"><b>Start with a source worth following.</b>Add up to three supported pages to a watchlist. Checks keep their evidence here.</div>';
    const all = snapshot.checks.slice().sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
    const pages = Math.max(1, Math.ceil(all.length / 5)); historyPage = Math.min(historyPage, pages - 1);
    const opened = [...(region('history').querySelectorAll?.('details[open][data-research-detail]') || [])].map(detail => detail.dataset.researchDetail);
    region('count').textContent = `${all.length} recorded check${all.length === 1 ? '' : 's'}${snapshot.historyOmitted ? ` · ${snapshot.historyOmitted} older checks omitted` : ''}`;
    region('history').innerHTML = all.length ? all.slice(historyPage * 5, historyPage * 5 + 5).map(check => `<article class="research-check"><div class="research-event-head"><div><h3>${esc(statuses[check.status])}</h3><p>${esc(check.name || snapshot.watchlists.find(watch => watch.id === check.watchId)?.name)}</p></div><time>${esc(stamp(check.startedAt))}</time></div>${check.status === 'baseline' || check.status === 'unchanged' ? '<p class="hint">No model call needed for this check.</p>' : ''}${check.error ? `<p class="error">${esc(check.error)}</p>` : ''}${check.sources.map(evidence).join('')}${reportCard(check.report, 'Change report')}${reportCard(check.review, 'Second-model review')}</article>`).join('') + (pages > 1 ? `<div class="pagination"><button class="button secondary" data-research="previous" ${historyPage === 0 ? 'disabled' : ''}>Previous</button><span>${historyPage + 1} / ${pages}</span><button class="button secondary" data-research="next" ${historyPage === pages - 1 ? 'disabled' : ''}>Next</button></div>` : '') : '<p class="hint">Your first check will appear here, with source URLs and capture times.</p>';
    for (const detail of region('history').querySelectorAll?.('[data-research-detail]') || []) if (opened.includes(detail.dataset.researchDetail)) detail.open = true;
    for (const button of element.querySelectorAll('[data-research="refresh"]')) button.disabled = busy;
    const fieldset = region('editor').querySelector('fieldset'); if (fieldset) fieldset.disabled = busy;
  }
  async function refresh() {
    if (!live || refreshing) return; refreshing = true; const current = ++generation;
    try {
      const result = checkedResearchSnapshot(await api(`${base}/research`));
      if (!live || current !== generation) return;
      const first = snapshot === null; snapshot = result; error = '';
      if (first) renderEditor(); renderData();
    } catch (failure) { if (live && current === generation) { error = `${failure.message || 'Research is unavailable.'} Nothing was automatically retried.`; renderData(); } }
    finally { refreshing = false; }
  }
  async function loadModels() {
    try { const result = await api(hosted ? `${base}/models` : '/api/models'); if (!Array.isArray(result) || result.some(model => typeof model.id !== 'string')) throw Error('Model catalog is unavailable.'); if (!live) return; models = result; }
    catch { if (!live) return; modelError = 'Reviewer catalog unavailable. Refresh this tab later to choose a second model; source watches can still be saved without one.'; }
    const select = region('editor').querySelector('[name="reviewerModel"]'); if (select) select.innerHTML = modelOptions(select.value);
    const hint = region('editor').querySelector('[data-research-model-hint]'); if (hint && modelError) hint.textContent = modelError;
  }
  async function action(work) {
    if (busy || !live) return; busy = true; error = ''; renderData();
    try { await work(); if (live) await refresh(); }
    catch (failure) { if (live) error = `${failure.message || 'The action could not be confirmed.'} Refresh history before retrying. No automatic retry was sent.`; }
    finally { busy = false; if (live) renderData(); }
  }
  async function click(event) {
    const button = event.target.closest('[data-research]'); if (!button || !element.contains(button) || button.disabled || busy) return;
    const name = button.dataset.research;
    if (name === 'refresh') return refresh();
    if (name === 'cancel-edit') { renderEditor(); return; }
    if (name === 'previous' || name === 'next') { historyPage += name === 'next' ? 1 : -1; renderData(); return; }
    const watch = snapshot?.watchlists.find(item => item.id === button.dataset.watch); if (!watch) return;
    if (name === 'edit') { renderEditor(watch); region('editor').querySelector('input')?.focus(); return; }
    if (name === 'toggle') return action(() => api(`${base}/watches/${encodeURIComponent(watch.id)}`, { enabled: !watch.enabled }));
    if (name === 'check') return action(async () => {
      if (project.status !== 'active') throw Error('Resume this agent from Runtime before checking sources.');
      if (!checkKeys.has(watch.id)) checkKeys.set(watch.id, crypto.randomUUID());
      await api(`${base}/watches/${encodeURIComponent(watch.id)}/check`, { requestKey: checkKeys.get(watch.id) });
      if (!live) return;
      checkKeys.delete(watch.id); historyPage = 0; notify('Source check recorded. Changes and report status appear in Research.');
    });
  }
  async function submit(event) {
    if (!event.target.matches('[data-research-form]')) return; event.preventDefault();
    if (busy || !snapshot || !live) return;
    const fields = new FormData(event.target);
    let payload;
    try {
      const sources = String(fields.get('sources') || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (!sources.length || sources.length > 3) throw Error('Add one to three source URLs, one per line.');
      const reviewerModel = String(fields.get('reviewerModel') || '') || null;
      if (reviewerModel && (reviewerModel === project.model || !models.some(model => model.id === reviewerModel))) throw Error('Choose a different reviewer from the current model catalog.');
      payload = { name: String(fields.get('name') || '').trim(), brief: String(fields.get('brief') || '').trim(), sources: sources.map(url => researchSourceUrl(url, snapshot.sourceHosts)), enabled: fields.get('enabled') === 'on', cadenceMinutes: Number(fields.get('cadenceMinutes')), reviewerModel };
    } catch (failure) { error = failure.message; renderData(); return; }
    const id = editing;
    return action(async () => {
      await api(`${base}/watches${id ? `/${encodeURIComponent(id)}` : ''}`, id ? payload : { ...payload, requestKey: createKey });
      if (!live) return; createKey = crypto.randomUUID(); renderEditor(); notify(id ? 'Watchlist updated.' : 'Watchlist saved. Check once to establish its baseline.');
    });
  }
  renderEditor(); renderData(); element.addEventListener('click', click); element.addEventListener('submit', submit);
  const ready = refresh(); const modelReady = loadModels();
  const timer = setTimer(() => { if (live && !busy && !globalThis.document?.hidden && (snapshot?.watchlists.some(watch => watch.enabled) || snapshot?.checks.some(check => check.status === 'checking' || [check.report?.status, check.review?.status].some(status => ['pending', 'queued', 'running'].includes(status))))) return refresh(); }, 10000);
  return { ready, modelReady, refresh, destroy() { live = false; generation++; clearTimer(timer); element.removeEventListener('click', click); element.removeEventListener('submit', submit); element.innerHTML = ''; snapshot = null; models = []; checkKeys.clear(); } };
}
