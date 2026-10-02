const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const date = value => Number.isFinite(+new Date(value)) ? new Date(value).toLocaleString() : 'Date unavailable';
const usd = value => (value / 1e6).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
export function activityCharge(charge) {
  if (!charge) return '';
  if (charge.mode === 'demo') return 'Simulated usage. No inference funds spent.';
  if (typeof charge.settledWei !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(charge.settledWei) || !['settledMicroUsd','pendingMicroUsd','settledCalls','totalCalls'].every(key => Number.isSafeInteger(charge[key]) && charge[key] >= 0)) return 'Usage record unavailable; unresolved reservations remain held.';
  const wei = BigInt(charge.settledWei), fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${wei / 10n ** 18n}${fraction ? '.' + fraction : ''} ETH settled · ${usd(charge.settledMicroUsd)} verified value · ${usd(charge.pendingMicroUsd)} reserved`;
}
export function activitySource(value) {
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url.href; } catch {}
  return null;
}
export function mountActivityPanel(element, { project, api, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let live = true, loading = false, events = [], nextCursor = null, omitted = 0, error = '', checkedAt = null;
  const base = `/api/projects/${encodeURIComponent(project.id)}/activity`;
  element.innerHTML = '<section class="panel activity-panel"><div class="section-title"><div><h2>Activity</h2><p>Actions, results and usage as they are recorded.</p></div><button class="button secondary compact" data-activity="refresh">Refresh</button></div><div data-activity-state role="status" aria-live="polite"></div><div data-activity-feed></div><div data-activity-more></div></section>';
  const region = name => element.querySelector(`[data-activity-${name}]`);
  function render() {
    if (!live) return;
    region('state').innerHTML = error ? `<p class="error">${esc(error)}</p>` : `<p class="hint">${loading ? 'Reading activity…' : checkedAt ? `Updated ${esc(date(checkedAt))}` : 'Reading activity…'}${omitted ? ` · ${omitted} older records outside this feed` : ''}</p>`;
    const opened = new Set([...(region('feed').querySelectorAll?.('details[open]') || [])].map(node => node.dataset.activityEvent));
    region('feed').innerHTML = events.length ? events.map(event => {
      const source = activitySource(event.source);
      return `<article class="activity-event"><div class="activity-event-heading"><strong>${esc(event.title)}</strong><span class="status">${esc(event.status)}</span></div><time datetime="${esc(event.at)}">${esc(date(event.at))}${event.finishedAt ? ` · Finished ${esc(date(event.finishedAt))}` : ''}</time>${source ? `<a class="activity-source" href="${esc(source)}" target="_blank" rel="noreferrer">${esc(source)}</a>` : ''}${event.details ? `<details data-activity-event="${esc(event.id)}" ${opened.has(event.id) ? 'open' : ''}><summary>Details</summary><p>${esc(event.details)}</p>${event.jobId ? `<small>Job ${esc(event.jobId)}</small>` : ''}</details>` : ''}${event.artifactId && typeof event.artifactId === 'string' ? `<a class="text-link" href="/api/artifacts/${encodeURIComponent(event.artifactId)}">Download result ↗</a>` : ''}${event.charge ? `<p class="activity-cost">${esc(activityCharge(event.charge))}</p>` : ''}</article>`;
    }).join('') : '<div class="empty"><b>Ready when you are.</b>Run a task or source check to begin its activity record.</div>';
    region('more').innerHTML = nextCursor ? `<button class="button secondary" data-activity="older" ${loading ? 'disabled' : ''}>Older activity</button>` : '';
    for (const button of element.querySelectorAll('[data-activity="refresh"]')) button.disabled = loading;
  }
  async function refresh(older = false) {
    if (!live || loading) return; loading = true; render();
    try {
      const result = await api(`${base}?limit=30${older && nextCursor ? `&before=${encodeURIComponent(nextCursor)}` : ''}`);
      if (!live) return;
      if (!result || !Array.isArray(result.events) || result.events.length > 100 || result.events.some(event => typeof event.id !== 'string' || typeof event.title !== 'string' || typeof event.status !== 'string' || !Number.isFinite(+new Date(event.at)) || (event.details != null && typeof event.details !== 'string')) || (result.nextCursor != null && typeof result.nextCursor !== 'string')) throw Error('The activity record could not be verified.');
      const combined = older ? [...events, ...result.events] : result.events;
      events = [...new Map(combined.map(event => [event.id, event])).values()].slice(0, 200);
      nextCursor = events.length < 200 ? result.nextCursor : null; omitted = Number.isSafeInteger(result.omitted) ? result.omitted : 0;
      error = ''; checkedAt = new Date().toISOString();
    } catch (failure) { if (live) error = failure.message || 'Activity is temporarily unavailable.'; }
    finally { loading = false; render(); }
  }
  function click(event) { const button = event.target.closest('[data-activity]'); if (button && element.contains(button) && !button.disabled) return refresh(button.dataset.activity === 'older'); }
  element.addEventListener('click', click); const ready = refresh();
  const timer = setTimer(() => { if (live && !globalThis.document?.hidden && events.length <= 30) return refresh(); }, 5000);
  return { ready, refresh, destroy() { live = false; clearTimer(timer); element.removeEventListener('click', click); element.innerHTML = ''; events = []; } };
}
