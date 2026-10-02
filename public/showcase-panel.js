import { formatPublicResult, renderPublicRun } from './public-agent.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export function showcaseLink(value, slug) {
  try { const url = new URL(value); if (url.origin === 'https://veyl.sh' && !url.username && !url.password && !url.search && !url.hash && /^[A-Za-z0-9_-]{24}$/.test(slug) && url.pathname === `/agents/${slug}`) return url.href; } catch {}
  return null;
}
export function mountShowcasePanel(element, { project, api, notify = () => {} } = {}) {
  let live = true, busy = false, loading = true, saved = null, error = '', draft = null, preview = null, previewInput = null, editorOpen = false;
  const base = `/api/projects/${encodeURIComponent(project.id)}/showcase`;
  const inputOf = fields => ({ title: String(fields.get('title') || '').trim(), description: String(fields.get('description') || '').trim(), artifactIds: fields.getAll('artifactId'), includeRunHistory: fields.get('includeRunHistory') === 'on' });
  function previewHtml() {
    if (!preview) return '';
    return `<section class="showcase-preview" aria-label="Exact public preview"><h3>Exact public preview</h3><h4>${esc(preview.preview.title)}</h4><p>${esc(preview.preview.description)}</p>${preview.preview.artifacts.map(artifact => `<article><h4>${esc(artifact.title)}</h4><p class="hint">${artifact.mode === 'demo' ? 'Simulated output' : 'Model output'} · ${esc(artifact.at)}</p><div class="showcase-preview-result">${formatPublicResult(artifact.content)}</div>${renderPublicRun(artifact.run, artifact.mode)}${draft?.includeRunHistory && !artifact.run ? '<p class="hint">No reliably linked completed run is available for this result. No history or cost will be added.</p>' : ''}</article>`).join('')}<p class="hint">This snapshot will be public. Open the history details to inspect every included timestamp, source link and usage amount. It will not update automatically.</p></section>`;
  }
  function render() {
    if (!live) return;
    const link = saved && showcaseLink(saved.url, saved.slug), fields = draft || { title: saved?.title || project.name, description: saved?.description || '', artifactIds: saved?.artifactIds || [], includeRunHistory: saved?.includeRunHistory === true };
    element.innerHTML = `<section class="panel showcase-panel"><div class="section-title"><div><h2>Public agent page</h2><p>Share chosen results, with optional recorded run history. Keep the rest of this workspace private.</p></div>${link ? `<a class="text-link" href="${esc(link)}" target="_blank" rel="noreferrer">View public page ↗</a>` : '<span class="status">Not shared</span>'}</div>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${loading ? '<p class="hint">Reading sharing settings…</p>' : `<details ${editorOpen ? 'open' : ''}><summary>${saved ? 'Edit shared results' : 'Choose what to share'}</summary><form data-showcase-form><fieldset ${busy ? 'disabled' : ''}><label>Public page title<input name="title" required maxlength="100" value="${esc(fields.title)}"></label><label>Public description<textarea name="description" maxlength="600" required>${esc(fields.description)}</textarea></label><p class="hint">Select one to five completed results. Inspect the full text before sharing; it can include facts or quotations from your private task.</p><div class="showcase-choices">${project.artifacts.slice().reverse().map((artifact, index) => `<article><label class="showcase-choice"><input type="checkbox" name="artifactId" value="${esc(artifact.id)}" ${fields.artifactIds.includes(artifact.id) ? 'checked' : ''}><span>${esc(artifact.title || `Result ${index + 1}`)}<small>${artifact.mode === 'demo' ? 'Simulated output' : 'Model output'}</small></span></label><details><summary>Inspect exact result</summary><pre>${esc(artifact.content)}</pre></details></article>`).join('') || '<p class="hint">Complete a task to select a result.</p>'}</div><label class="showcase-choice"><input type="checkbox" name="includeRunHistory" ${fields.includeRunHistory ? 'checked' : ''}><span>Share selected results’ recorded run history and costs.<small>Optional. Includes bounded stage/tool statuses and dates, reviewed source links, confirmed settled ETH and unresolved held budget. No prompts, notes, reasoning, raw tool output or wallet data are added.</small></span></label><button class="button secondary" type="submit" name="action" value="preview" ${project.artifacts.length ? '' : 'disabled'}>Preview public page</button><div data-showcase-preview>${previewHtml()}</div><label class="showcase-choice"><input name="approve" type="checkbox" ${preview ? '' : 'disabled'}><span>I reviewed this exact preview, including any selected history and costs, and approve publishing it. Removing the page cannot remove visitor copies.</span></label><p class="hint">The selected result text itself is public. Changing any choice requires a new preview.</p><button class="button" type="submit" name="action" value="publish" data-showcase-publish ${preview ? '' : 'disabled'}>${saved ? 'Update public page' : 'Publish selected results'}</button></fieldset></form></details>${saved ? `<details><summary>Remove public page</summary><p class="hint">This disables its public URL. Saved private results remain.</p><button class="button secondary" data-showcase="revoke" ${busy ? 'disabled' : ''}>Remove public page</button></details>` : ''}<button class="text-link" data-showcase="refresh" ${busy ? 'disabled' : ''}>Refresh sharing status</button>`}</section>`;
  }
  function invalidate(event) {
    if (event && (!event.target.closest?.('[data-showcase-form]') || event.target.name === 'approve')) return;
    preview = null; previewInput = null;
    const region = element.querySelector('[data-showcase-preview]'); if (region) region.innerHTML = '';
    const approval = element.querySelector('[name="approve"]'); if (approval) { approval.checked = false; approval.disabled = true; }
    const publish = element.querySelector('[data-showcase-publish]'); if (publish) publish.disabled = true;
  }
  async function refresh() {
    invalidate();
    try { const result = await api(base); if (!live) return; if (!result || !Object.hasOwn(result, 'showcase') || (result.showcase && (!Array.isArray(result.showcase.artifactIds) || !showcaseLink(result.showcase.url, result.showcase.slug)))) throw Error('Public sharing status could not be verified.'); saved = result.showcase; error = ''; }
    catch (failure) { if (live) error = failure.message || 'Sharing status is unavailable.'; }
    finally { loading = false; if (live) render(); }
  }
  async function action(work) { if (!live || busy) return; busy = true; error = ''; render(); try { await work(); } catch (failure) { if (live) { invalidate(); error = `${failure.message || 'Sharing outcome could not be confirmed.'} No automatic retry was sent.`; } } finally { busy = false; if (live) render(); } }
  function click(event) { const button = event.target.closest('[data-showcase]'); if (!button || !element.contains(button) || button.disabled || busy) return; if (button.dataset.showcase === 'refresh') return refresh(); if (button.dataset.showcase === 'revoke') return action(async () => { await api(base + '/revoke', {}); if (!live) return; draft = null; await refresh(); notify('Public page removed. Saved private deliverables remain.'); }); }
  async function submit(event) {
    if (!event.target.matches('[data-showcase-form]')) return; event.preventDefault(); if (!live || busy) return;
    const fields = new FormData(event.target), input = inputOf(fields); draft = input; editorOpen = true;
    if (input.artifactIds.length < 1 || input.artifactIds.length > 5 || new Set(input.artifactIds).size !== input.artifactIds.length || input.artifactIds.some(id => !project.artifacts.some(artifact => artifact.id === id))) { invalidate(); error = 'Select one to five saved results to preview.'; render(); return; }
    if (event.submitter?.value === 'publish') {
      if (!preview || previewInput !== JSON.stringify(input) || fields.get('approve') !== 'on') { invalidate(); error = 'Preview these exact choices and explicitly approve them before publishing.'; render(); return; }
      const digest = preview.previewDigest;
      return action(async () => { await api(base, { ...input, previewDigest: digest }); if (!live) return; draft = null; await refresh(); notify('Selected public snapshot published.'); });
    }
    invalidate();
    return action(async () => {
      const result = await api(base + '/preview', input); if (!live) return;
      const page = result?.preview;
      if (!page || !/^[a-f0-9]{64}$/.test(result.previewDigest) || result.includeRunHistory !== input.includeRunHistory || page.title !== input.title || page.description !== input.description || !Array.isArray(page.artifacts) || page.artifacts.length !== input.artifactIds.length || page.artifacts.some((artifact, index) => artifact.id !== input.artifactIds[index] || typeof artifact.title !== 'string' || artifact.title.length > 100 || !['demo', 'zkapi'].includes(artifact.mode))) throw Error('The exact public preview could not be verified.');
      for (const artifact of page.artifacts) { if (!input.includeRunHistory && artifact.run) throw Error('The preview includes unselected run history.'); formatPublicResult(artifact.content); renderPublicRun(artifact.run, artifact.mode); }
      preview = result; previewInput = JSON.stringify(input);
    });
  }
  render(); element.addEventListener('click', click); element.addEventListener('submit', submit); element.addEventListener('input', invalidate); element.addEventListener('change', invalidate); const ready = refresh();
  return { ready, refresh, destroy() { live = false; for (const [name, handler] of [['click', click], ['submit', submit], ['input', invalidate], ['change', invalidate]]) element.removeEventListener(name, handler); element.innerHTML = ''; saved = null; preview = null; } };
}
