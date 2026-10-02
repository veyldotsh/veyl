import { researchCharges, researchSourceUrl } from './research-panel.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const date = value => value && Number.isFinite(+new Date(value)) ? new Date(value).toLocaleString() : 'Not scheduled';
const tools = { read_source: ['Read sources', 'Supported HTTPS pages within your source rules.'], chain_read: ['Read Ethereum balances', 'Read-only ETH and token balances.'], save_note: ['Save project notes', 'Write findings to this agent’s memory.'], prepare_social_draft: ['Prepare social drafts', 'Publication follows the separate rules in Connections.'] };
const cadence = { 60: 'Hourly', 360: 'Every 6 hours', 1440: 'Daily' };
const labels = { planning:'Planning research', researching:'Researching', reviewing:'Independent review', completed:'Completed', blocked:'Needs attention', interrupted:'Interrupted', pending:'Waiting', queued:'Queued', running:'Running', none:'Not requested' };
export function mountAutonomyPanel(element, { project, api, hosted = true, notify = () => {}, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let live = true, busy = false, reading = false, data = null, models = [], modelError = '', error = '', runKey = crypto.randomUUID();
  const base = `/api/projects/${encodeURIComponent(project.id)}/autonomy`;
  const region = name => element.querySelector(`[data-autonomy-${name}]`);
  element.innerHTML = '<section class="panel autonomy-panel"><div class="section-title"><div><p class="eyebrow">A BRIEF THAT KEEPS MOVING</p><h2>Autonomous research</h2><p>Set an objective. Let this agent choose its next research question.</p></div><button class="button secondary compact" data-autonomy="refresh">Refresh</button></div><div data-autonomy-message role="status" aria-live="polite"></div><div data-autonomy-status></div><div data-autonomy-editor></div><div data-autonomy-cycles></div></section>';
  function modelOptions(selected) { return '<option value="">No second-model review</option>' + models.filter(model => model.id !== project.model).map(model => `<option value="${esc(model.id)}" ${selected === model.id ? 'selected' : ''}>${esc(model.id)}</option>`).join('') + (selected && !models.some(model => model.id === selected) ? `<option value="${esc(selected)}" selected>${esc(selected)} · currently unavailable</option>` : ''); }
  function editor() {
    const policy = data.policy;
    region('editor').innerHTML = `<details class="autonomy-editor"><summary>Objective & action rules</summary><form data-autonomy-form><fieldset ${busy ? 'disabled' : ''}><label>Research objective<textarea name="objective" required maxlength="1200" placeholder="Identify meaningful protocol changes, investigate their impact and preserve evidence.">${esc(policy.objective)}</textarea></label><label class="autonomy-choice"><input type="checkbox" name="enabled" ${policy.enabled ? 'checked' : ''}><span>Run automatically within this agent’s existing model and spending limits.</span></label><div class="form-row"><label>Cadence<select name="cadenceMinutes">${Object.entries(cadence).map(([minutes, label]) => `<option value="${minutes}" ${Number(minutes) === policy.cadenceMinutes ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Maximum cycles per day<input type="number" name="dailyRunCap" min="1" max="24" step="1" required value="${esc(policy.dailyRunCap)}"></label></div><h3>Allowed actions</h3><div class="autonomy-tools">${Object.entries(tools).map(([name, [label, detail]]) => `<label class="autonomy-choice"><input type="checkbox" name="tool" value="${name}" ${policy.allowedTools.includes(name) ? 'checked' : ''}><span><b>${label}</b><small>${detail}</small></span></label>`).join('')}</div><details><summary>Source boundaries</summary><label>Exact source URLs<textarea name="sourceUrls" rows="3" placeholder="Up to 8 supported HTTPS URLs, one per line">${esc(policy.sourceUrls.join('\n'))}</textarea></label><p class="hint">Allow exact pages, approved domains, or both. Each cycle may choose up to three sources.</p><div class="autonomy-hosts">${data.sourceHosts.map(host => `<label class="autonomy-choice"><input type="checkbox" name="host" value="${esc(host)}" ${policy.sourceHosts.includes(host) ? 'checked' : ''}><span>${esc(host)}</span></label>`).join('')}</div><p class="hint">Choose up to five supported domains. Reading sources requires at least one URL or domain.</p></details><label>Optional reviewer<select name="reviewerModel">${modelOptions(policy.reviewerModel)}</select></label><p class="hint" data-autonomy-model-note>${esc(modelError || 'Planning and research are separately budgeted model jobs. A different reviewer adds another job after research completes. Each stays within your per-call, daily and total allowance.')}</p><p class="hint">These rules do not authorize trades, wallet transfers or software execution. Social publication has its own owner rules in Connections.</p><button class="button" type="submit">Save research rules</button></fieldset></form></details>`;
  }
  function render() {
    if (!live) return;
    region('message').innerHTML = error ? `<p class="error">${esc(error)}</p>` : busy ? '<p class="hint">Saving this action…</p>' : '';
    if (!data) { region('status').innerHTML = '<p class="hint">Reading autonomous research settings…</p>'; return; }
    region('status').innerHTML = `<div class="autonomy-state"><div><strong>${data.policy.enabled ? 'Automatic research enabled' : 'Automatic research paused'}</strong><p>${data.policy.enabled ? `Next cycle: ${esc(date(data.policy.nextAt))}` : 'Enable your saved rules before starting or scheduling a cycle.'}</p></div><div class="autonomy-actions"><button class="button secondary" data-autonomy="run" ${busy || project.status !== 'active' || !data.policy.enabled || data.runsToday >= data.policy.dailyRunCap || data.cycles.some(cycle => ['planning','researching','reviewing'].includes(cycle.status)) ? 'disabled' : ''}>Run one cycle</button>${data.policy.enabled ? `<button class="text-link" data-autonomy="pause" ${busy ? 'disabled' : ''}>Pause automatic research</button>` : ''}</div></div>`;
    region('cycles').innerHTML = data.cycles.length ? `<details class="autonomy-history"><summary>Recent research cycles (${data.cycles.length})</summary>${data.cycles.slice().reverse().slice(0, 5).map(cycle => `<article class="autonomy-cycle"><div class="section-title"><strong>${esc(labels[cycle.status] || cycle.status)}</strong><time>${esc(date(cycle.at))}</time></div>${cycle.question ? `<p>${esc(cycle.question)}</p>` : ''}${cycle.error ? `<p class="error">${esc(cycle.error)}</p>` : ''}${['planner','research','review'].map(kind => { const stage = cycle[kind]; if (!stage || stage.status === 'none') return ''; const job = stage.job, charge = job ? researchCharges(job) : null; return `<div class="autonomy-stage"><strong>${kind === 'planner' ? 'Plan' : kind === 'research' ? 'Research' : 'Review'}</strong><span>${esc(labels[stage.status] || stage.status)}</span>${stage.error ? `<p class="error">${esc(stage.error)}</p>` : ''}${job ? `<p class="hint">${esc(job.model)} · ${esc(charge.label)}<br>${esc(charge.text)}</p>` : ''}${kind !== 'planner' && stage.artifact ? `<details><summary>Read findings</summary><pre>${esc(stage.artifact.content)}</pre>${stage.artifact.preview ? '<p class="hint">Report preview.</p>' : ''}<a class="text-link" href="/api/artifacts/${encodeURIComponent(stage.artifact.id)}">Download full report ↗</a></details>` : ''}</div>`; }).join('')}${cycle.status === 'blocked' || cycle.status === 'interrupted' ? '<p class="hint">No automatic replay of this cycle. Inspect the cause, then explicitly start new work if appropriate.</p>' : ''}</article>`).join('')}</details>` : '';
    const fieldset = region('editor').querySelector('fieldset'); if (fieldset) fieldset.disabled = busy;
  }
  async function refresh(replaceEditor = false) {
    if (!live || reading) return; reading = true;
    try {
      const result = await api(base); if (!live) return;
      const policy = result?.policy;
      if (!policy || typeof policy.enabled !== 'boolean' || !Array.isArray(policy.allowedTools) || policy.allowedTools.some(tool => !Object.hasOwn(tools, tool)) || !Array.isArray(policy.sourceUrls) || !Array.isArray(policy.sourceHosts) || !Array.isArray(result.sourceHosts) || !Array.isArray(result.cycles) || result.cycles.length > 100) throw Error('Research rules could not be verified.');
      const first = !data; data = result; error = ''; if (first || replaceEditor) editor(); render();
    } catch (failure) { if (live) { error = failure.message || 'Research settings are unavailable.'; render(); } }
    finally { reading = false; }
  }
  async function action(work, replaceEditor = false) {
    if (!live || busy) return; busy = true; error = ''; render();
    try { await work(); if (live) await refresh(replaceEditor); }
    catch (failure) { if (live) error = `${failure.message || 'Outcome could not be confirmed.'} No automatic retry was sent. Refresh before retrying.`; }
    finally { busy = false; render(); }
  }
  async function click(event) {
    const button = event.target.closest('[data-autonomy]'); if (!button || !element.contains(button) || button.disabled || busy) return;
    if (button.dataset.autonomy === 'refresh') return refresh();
    if (button.dataset.autonomy === 'pause') return action(() => api(base, { enabled: false }), true);
    if (button.dataset.autonomy === 'run' && (!data?.policy.enabled || project.status !== 'active')) { error = 'Enable your saved rules on an active agent before running a cycle.'; render(); return; }
    if (button.dataset.autonomy === 'run') return action(async () => { await api(base + '/run', { requestKey: runKey }); runKey = crypto.randomUUID(); notify('Research cycle recorded. Follow its actions in Activity.'); });
  }
  async function submit(event) {
    if (!event.target.matches('[data-autonomy-form]')) return; event.preventDefault(); if (!live || busy || !data) return;
    const fields = new FormData(event.target); let policy;
    try {
      const allowedTools = fields.getAll('tool'), sourceHosts = fields.getAll('host'), sourceUrls = String(fields.get('sourceUrls') || '').split(/\r?\n/).map(url => url.trim()).filter(Boolean), reviewerModel = fields.get('reviewerModel') || null;
      if (!allowedTools.length || allowedTools.some(tool => !Object.hasOwn(tools, tool))) throw Error('Choose at least one allowed action.');
      if (sourceUrls.length > 8 || sourceHosts.length > 5 || sourceHosts.some(host => !data.sourceHosts.includes(host))) throw Error('Use up to eight URLs and five supported domains.');
      if (allowedTools.includes('read_source') && !sourceUrls.length && !sourceHosts.length) throw Error('Add a source URL or supported domain for source reading.');
      if (reviewerModel && (reviewerModel === project.model || !models.some(model => model.id === reviewerModel))) throw Error('Choose a different reviewer from the current model catalog.');
      policy = { enabled: fields.get('enabled') === 'on', objective: String(fields.get('objective') || '').trim(), cadenceMinutes: Number(fields.get('cadenceMinutes')), dailyRunCap: Number(fields.get('dailyRunCap')), allowedTools, sourceUrls: sourceUrls.map(url => researchSourceUrl(url, data.sourceHosts)), sourceHosts, reviewerModel };
    } catch (failure) { error = failure.message; render(); return; }
    return action(async () => { await api(base, policy); notify('Research rules saved for this agent.'); }, true);
  }
  async function loadModels() {
    try { const result = await api(hosted ? `/api/projects/${encodeURIComponent(project.id)}/models` : '/api/models'); if (!live) return; if (!Array.isArray(result)) throw Error(); models = result.filter(model => typeof model.id === 'string'); }
    catch { if (!live) return; modelError = 'Reviewer catalog unavailable. Save without a reviewer or refresh this tab later.'; }
    const select = region('editor').querySelector('[name="reviewerModel"]'); if (select) select.innerHTML = modelOptions(select.value);
    const hint = region('editor').querySelector('[data-autonomy-model-note]'); if (modelError && hint) hint.textContent = modelError;
  }
  render(); element.addEventListener('click', click); element.addEventListener('submit', submit);
  const ready = refresh(), modelReady = loadModels();
  const timer = setTimer(() => { if (live && !busy && !globalThis.document?.hidden && (data?.policy.enabled || data?.cycles.some(cycle => ['planning','researching','reviewing'].includes(cycle.status)))) return refresh(); }, 10000);
  return { ready, modelReady, refresh, destroy() { live = false; clearTimer(timer); element.removeEventListener('click', click); element.removeEventListener('submit', submit); element.innerHTML = ''; data = null; models = []; } };
}
