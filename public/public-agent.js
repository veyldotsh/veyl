const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const date = value => Number.isFinite(+new Date(value)) ? new Date(value).toLocaleString() : 'Date unavailable';
const MAX_RESULT_LENGTH = 32000;
function sourceLink(value) {
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f<>"'\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
function inlineResult(value) {
  // Tokens are bounded and non-recursive. Everything else remains literal text.
  const tokens = /!\[[^\]\n]{0,1000}\]\([^\n)]{0,2048}\)|\[[^\]\n]{1,1000}\]\([^\n)]{1,2048}\)|`[^`\n]{1,2048}`|\*\*[^*\n]{1,2048}\*\*|https:\/\/[^\s<>"'`]{1,2048}/g;
  let html = '', at = 0;
  for (const match of value.matchAll(tokens)) {
    html += esc(value.slice(at, match.index));
    const token = match[0];
    if (token.startsWith('![')) html += esc(token);
    else if (token.startsWith('`')) html += `<code>${esc(token.slice(1, -1))}</code>`;
    else if (token.startsWith('**')) html += `<strong>${esc(token.slice(2, -2))}</strong>`;
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const raw = link ? link[2] : token.replace(/[.,;:!?\])}]+$/, '');
      const href = sourceLink(raw);
      html += href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(link ? link[1] : raw)}</a>${link ? '' : esc(token.slice(raw.length))}` : esc(token);
    }
    at = match.index + token.length;
  }
  return html + esc(value.slice(at));
}
export function formatPublicResult(content) {
  if (typeof content !== 'string' || content.length > MAX_RESULT_LENGTH) throw Error('This result is unavailable.');
  const lines = content.replace(/\r\n?/g, '\n').split('\n'), blocks = [];
  const special = line => /^(?:#{1,6}\s|>\s?|[-*+]\s|\d{1,4}[.)]\s|```)/.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const code = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      blocks.push(`<h${level}>${inlineResult(heading[2])}</h${level}>`); i++; continue;
    }
    if (/^>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(`<blockquote><p>${inlineResult(quote.join(' '))}</p></blockquote>`); continue;
    }
    const ordered = /^\d{1,4}[.)]\s+/.test(line), list = ordered ? /^\d{1,4}[.)]\s+/ : /^[-*+]\s+/;
    if (list.test(line)) {
      const items = [];
      while (i < lines.length && list.test(lines[i])) items.push(`<li>${inlineResult(lines[i++].replace(list, ''))}</li>`);
      const tag = ordered ? 'ol' : 'ul'; blocks.push(`<${tag}>${items.join('')}</${tag}>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !special(lines[i])) paragraph.push(lines[i++]);
    blocks.push(`<p>${inlineResult(paragraph.join(' '))}</p>`);
  }
  return blocks.join('');
}
const runRoles = new Set(['Planner', 'Researcher', 'Developer', 'Writer', 'Reviewer', 'Model stage']);
const runTools = { read_source: 'Read source', chain_read: 'Read Ethereum balance', save_note: 'Save project note', prepare_social_draft: 'Prepare social draft' };
function historySource(value) {
  const link = typeof value === 'string' ? sourceLink(value) : null;
  if (!link) return null;
  const url = new URL(link);
  return !url.search && !url.hash && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ? link : null;
}
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const usdExact = value => '$' + (value / 1e6).toFixed(6);
export function renderPublicRun(run, mode) {
  if (!run) return '';
  if (run.version !== 1 || run.status !== 'completed' || !validTime(run.startedAt) || !validTime(run.finishedAt) || !Array.isArray(run.events) || run.events.length > 64 || !Number.isSafeInteger(run.omittedEvents) || run.omittedEvents < 0 || run.events.some(event => !event || !validTime(event.at) || !validTime(event.finishedAt) || (event.type === 'stage' ? !runRoles.has(event.role) || !['completed', 'not-dispatched'].includes(event.status) : event.type !== 'tool' || !Object.hasOwn(runTools, event.tool) || !['completed', 'failed'].includes(event.status)))) throw Error('Shared run history could not be verified.');
  let cost = mode === 'demo' ? '<p>Simulated run. No paid inference charge.</p>' : '<p>Usage record unavailable. This is not a zero-cost claim.</p>';
  if (mode === 'zkapi' && run.charge !== null) {
    const charge = run.charge;
    if (!charge || typeof charge.settledWei !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(charge.settledWei) || !['settledMicroUsd', 'pendingMicroUsd', 'settledCalls', 'totalCalls'].every(key => Number.isSafeInteger(charge[key]) && charge[key] >= 0) || charge.settledCalls > charge.totalCalls) throw Error('Shared usage record could not be verified.');
    const wei = BigInt(charge.settledWei), fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    const pendingCalls = charge.totalCalls - charge.settledCalls;
    cost = `<dl class="public-run-cost"><div><dt>Inference cost</dt><dd>${usdExact(charge.settledMicroUsd)}</dd></div>${charge.pendingMicroUsd ? `<div><dt>Reserved budget</dt><dd>${usdExact(charge.pendingMicroUsd)}</dd></div>` : ''}</dl>${pendingCalls ? `<p class="public-run-note">${pendingCalls} call${pendingCalls === 1 ? '' : 's'} awaiting settlement.${charge.pendingMicroUsd ? ' Reserved budget is not spent.' : ''}</p>` : ''}<details class="public-run-payment"><summary>Payment details</summary><p>${wei / 10n ** 18n}${fraction ? '.' + fraction : ''} ETH paid · USD value at settlement.</p></details><p class="public-run-note">Inference only; excludes funding and network gas.</p>`;
  }
  return `<details class="public-run"><summary>Run history &amp; cost</summary><p class="public-run-note">Owner-shared snapshot · ${esc(date(run.startedAt))}</p>${cost}<ol class="public-run-events">${run.events.map(event => { const source = historySource(event.source); return `<li><div><strong>${esc(event.type === 'stage' ? event.role : runTools[event.tool])}</strong><span>${event.status === 'not-dispatched' ? 'Not dispatched' : event.status === 'failed' ? 'Failed' : 'Completed'}</span></div><time datetime="${esc(event.at)}">${esc(date(event.at))}</time>${source ? `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(source)}</a>` : ''}</li>`; }).join('')}</ol>${run.omittedEvents ? `<p>${run.omittedEvents} additional events not shared.</p>` : ''}</details>`;
}
export function renderPublicAgent(result, slug) {
  const page = result?.page;
  if (!page || page.slug !== slug || typeof page.title !== 'string' || page.title.length > 100 || typeof page.description !== 'string' || page.description.length > 600 || !Array.isArray(page.artifacts) || !page.artifacts.length || page.artifacts.length > 5 || page.artifacts.some(artifact => typeof artifact.title !== 'string' || typeof artifact.content !== 'string' || artifact.content.length > MAX_RESULT_LENGTH || !['demo','zkapi'].includes(artifact.mode))) throw Error('This agent page is unavailable.');
  return `<section class="public-agent-heading"><p class="section-number">SELECTED WORK · SHARED BY ITS OWNER</p><h1>${esc(page.title)}</h1><p class="public-agent-description">${esc(page.description)}</p><p class="public-agent-date">Updated ${esc(date(page.updatedAt))} · ${page.artifacts.length} shared result${page.artifacts.length === 1 ? '' : 's'}</p></section><section class="public-agent-results" aria-label="Shared results">${page.artifacts.map((artifact, index) => `<article><div class="public-result-heading"><span class="section-number">${String(index + 1).padStart(2, '0')}</span><h2>${esc(artifact.title)}</h2><span>${artifact.mode === 'demo' ? 'Simulated output' : 'Model output'}</span></div><p class="public-agent-date">${esc(date(artifact.at))}</p><div class="public-result-content">${formatPublicResult(artifact.content)}</div>${renderPublicRun(artifact.run, artifact.mode)}</article>`).join('')}</section><p class="public-agent-note">These are results selected by this agent’s owner. Generated findings may contain errors. Publication is not a verification or endorsement by Veyl.</p>`;
}
export async function loadPublicAgent(element, { pathname = globalThis.location?.pathname || '', fetcher = fetch } = {}) {
  const match = /^\/agents\/([A-Za-z0-9_-]{24})\/?$/.exec(pathname);
  if (!match) { element.textContent = 'This agent page is unavailable.'; return; }
  try {
    const response = await fetcher(`/api/showcase/${encodeURIComponent(match[1])}`, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw Error('This agent page is unavailable or has been removed.');
    const result = await response.json(); element.innerHTML = renderPublicAgent(result, match[1]);
  } catch { element.textContent = 'This agent page is unavailable or has been removed.'; }
}
if (typeof document !== 'undefined') { const element = document.getElementById('public-agent'); if (element) loadPublicAgent(element); }
