import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { formatPublicResult } from '../public/public-agent.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

for (const tab of ['runtime', 'research', 'deliverables']) {
  test(`${tab} polling refreshes the selected agent's deliverables badge without replacing its editor`, async () => {
    const elements = new Map(), badge = { textContent: 'Deliverables (0)' }, requests = [];
    const element = id => {
      if (!elements.has(id)) elements.set(id, { addEventListener() {}, style: {}, innerHTML: '', textContent: '', value: '' });
      return elements.get(id);
    };
    element('content').innerHTML = 'Mounted editor and panel stay intact';
    element('task-prompt').value = 'Unsaved owner task';
    let poll, next;
    const context = createContext({
      document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [],
        querySelector: selector => selector === '[data-tab="deliverables"]' ? badge : null,
        activeElement: { closest: () => true, matches: () => true } },
      crypto: { randomUUID }, setInterval: callback => { poll = callback; },
      sessionBootstrap: async () => false, matchMedia: () => ({ matches: false }), Intl,
      fetch: async (path, options) => { requests.push({ path, options }); return { ok: true, json: async () => next }; }
    });
    runInContext(source, context);
    const project = { id: 'selected-agent', name: 'Trace', status: 'active', policy: { total: 4004000 }, committed: 1001000, artifacts: [] };
    context.initial = { hosted: true, wallet: '0x1111111111111111111111111111111111111111', mode: 'zkapi', persistence: 'healthy', busy: true,
      projects: [project, { ...project, id: 'other-agent', artifacts: [{ id: 'other-a' }, { id: 'other-b' }] }],
      jobs: [{ id: 'job', projectId: project.id, status: 'running' }] };
    runInContext(`state = initial; view = 'project'; selected = 'selected-agent'; tab = '${tab}';`, context);
    next = structuredClone(context.initial);
    next.busy = false; next.jobs[0].status = 'completed'; next.jobs[0].artifactId = 'delivered-result';
    next.projects[0].artifacts.push({ id: 'delivered-result' });
    await poll();
    assert.equal(badge.textContent, 'Deliverables (1)');
    assert.match(element('project-stats').innerHTML, /Delivered tasks<\/span><strong>01<\/strong>/);
    assert.equal(element('content').innerHTML, 'Mounted editor and panel stay intact');
    assert.equal(element('task-prompt').value, 'Unsaved owner task');
    assert.equal(requests.length, 1); assert.equal(requests[0].path, '/api/state');
    assert.equal(requests[0].options.method, undefined); assert.equal(requests[0].options.body, undefined);
  });
}

test('private deliverables reuse safe formatting without changing stored Markdown or download', () => {
  const element = { addEventListener() {}, style: {} };
  const context = createContext({ document: { getElementById: () => element, addEventListener() {}, querySelectorAll: () => [] }, crypto: { randomUUID }, setInterval() {}, sessionBootstrap: async () => false });
  runInContext(source, context);
  const artifact = { id: randomUUID(), title: 'A cited result', mode: 'zkapi', content: '## Findings\n\n- Evidence first\n- Check activation\n\n> A quoted passage\n\n[Primary source](https://ethereum.org/roadmap/)\n\n<script>alert(1)</script> [bad](javascript:alert(1))\n\n```js\nconst safe = "<b>";\n```' };
  const original = structuredClone(artifact); context.artifact = artifact; context.formatter = formatPublicResult;
  const html = runInContext('deliveredFormatter = formatter; deliveredArtifact(artifact);', context);
  assert.match(html, /class="public-result-content delivered-result"/);
  assert.match(html, /<h4>Findings<\/h4>/); assert.match(html, /<ul><li>Evidence first<\/li>/);
  assert.match(html, /<blockquote>/); assert.match(html, /href="https:\/\/ethereum.org\/roadmap\/"/);
  assert.match(html, /&lt;script&gt;alert/); assert.doesNotMatch(html, /<script>|href="javascript:|<b>/);
  assert.match(html, new RegExp('/api/artifacts/' + artifact.id)); assert.deepEqual(artifact, original);
  const fallback = runInContext('deliveredFormatter = null; deliveredArtifact(artifact);', context);
  assert.match(fallback, /<pre>## Findings/); assert.doesNotMatch(fallback, /<script>/);
});
