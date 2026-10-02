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
export function renderPublicAgent(result, slug) {
  const page = result?.page;
  if (!page || page.slug !== slug || typeof page.title !== 'string' || page.title.length > 100 || typeof page.description !== 'string' || page.description.length > 600 || !Array.isArray(page.artifacts) || !page.artifacts.length || page.artifacts.length > 5 || page.artifacts.some(artifact => typeof artifact.title !== 'string' || typeof artifact.content !== 'string' || artifact.content.length > MAX_RESULT_LENGTH || !['demo','zkapi'].includes(artifact.mode))) throw Error('This agent page is unavailable.');
  return `<section class="public-agent-heading"><p class="section-number">SELECTED WORK · SHARED BY ITS OWNER</p><h1>${esc(page.title)}</h1><p class="public-agent-description">${esc(page.description)}</p><p class="public-agent-date">Updated ${esc(date(page.updatedAt))} · ${page.artifacts.length} shared result${page.artifacts.length === 1 ? '' : 's'}</p></section><section class="public-agent-results" aria-label="Shared results">${page.artifacts.map((artifact, index) => `<article><div class="public-result-heading"><span class="section-number">${String(index + 1).padStart(2, '0')}</span><h2>${esc(artifact.title)}</h2><span>${artifact.mode === 'demo' ? 'Simulated output' : 'Model output'}</span></div><p class="public-agent-date">${esc(date(artifact.at))}</p><div class="public-result-content">${formatPublicResult(artifact.content)}</div></article>`).join('')}</section><p class="public-agent-note">These are results selected by this agent’s owner. Generated findings may contain errors. Publication is not a verification or endorsement by Veyl.</p>`;
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
