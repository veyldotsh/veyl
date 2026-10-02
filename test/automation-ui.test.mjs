import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mountAutonomyPanel } from '../public/autonomy-panel.js';
import { mountActivityPanel, activityCharge } from '../public/activity-panel.js';
import { mountNotificationPanel } from '../public/notification-panel.js';
import { mountShowcasePanel, showcaseLink } from '../public/showcase-panel.js';
import { renderPublicAgent, loadPublicAgent } from '../public/public-agent.js';

class Region {
  innerHTML = ''; textContent = ''; fieldset = {}; select = { value: '', innerHTML: '' };
  querySelector(selector) { return selector === 'fieldset' ? this.fieldset : selector === '[name="reviewerModel"]' ? this.select : {}; }
  querySelectorAll() { return []; }
}
class Element extends Region {
  regions = new Map(); handlers = new Map();
  querySelector(selector) { if (!this.regions.has(selector)) this.regions.set(selector, new Region()); return this.regions.get(selector); }
  contains(node) { return node.owned !== false; }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  removeEventListener(name) { this.handlers.delete(name); }
  html() { return this.innerHTML + [...this.regions.values()].map(region => region.innerHTML).join(''); }
  click(name, action, extra = {}) { return this.handlers.get('click')({ target: { closest() { return { dataset: { [name]: action, ...extra } }; } } }); }
}
const project = { id: randomUUID(), name: 'Evidence agent', model: 'model-one', status: 'active', artifacts: [{ id: 'result-one', title: 'Private title', content: 'Exact <script>selected result</script>', mode: 'zkapi' }] };
const autonomous = () => ({ sourceHosts: ['ethereum.org'], runsToday: 0, cycles: [], policy: { enabled: false, objective: '', cadenceMinutes: 360, dailyRunCap: 1, allowedTools: ['read_source'], sourceUrls: [], sourceHosts: [], reviewerModel: null, nextAt: null } });
const timers = () => { let fn; return { setTimer: callback => { fn = callback; return 1; }, clearTimer() {}, poll: () => fn?.() }; };
async function submit(element, values, name, action) {
  const original = globalThis.FormData;
  globalThis.FormData = class { get(key) { return values[key] ?? null; } getAll(key) { return values[key] || []; } };
  try { await element.handlers.get('submit')({ target: { matches: selector => selector === `[data-${name}-form]` }, submitter: action ? { value: action } : undefined, preventDefault() {} }); }
  finally { globalThis.FormData = original; }
}

test('autonomy remains off until explicit owner settings and does not mutate during reads', async () => {
  const element = new Element(), clock = timers(), writes = [], data = autonomous();
  const panel = mountAutonomyPanel(element, { project, ...clock, api: async (path, body) => { if (body) writes.push({ path, body }); return path.endsWith('/models') ? [{ id: 'model-one' }, { id: 'model-two' }] : data; } });
  await Promise.all([panel.ready, panel.modelReady]);
  assert.match(element.html(), /Automatic research paused/); assert.doesNotMatch(element.html(), /name="enabled" checked/);
  await element.click('autonomy', 'run'); await clock.poll(); assert.equal(writes.length, 0);
  await submit(element, { objective: 'Investigate evidence.', enabled: 'on', cadenceMinutes: '60', dailyRunCap: '2', tool: ['read_source', 'save_note'], host: ['ethereum.org'], sourceUrls: '', reviewerModel: 'model-two' }, 'autonomy');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, `/api/projects/${project.id}/autonomy`);
  assert.deepEqual(writes[0].body, { enabled: true, objective: 'Investigate evidence.', cadenceMinutes: 60, dailyRunCap: 2, allowedTools: ['read_source','save_note'], sourceUrls: [], sourceHosts: ['ethereum.org'], reviewerModel: 'model-two' }); panel.destroy();
});

test('autonomy rejects unsupported actions, sources and same-model reviewer before writes', async () => {
  const element = new Element(), writes = [], panel = mountAutonomyPanel(element, { project, ...timers(), api: async (path, body) => { if (body) writes.push(body); return path.endsWith('/models') ? [{ id: 'model-one' }] : autonomous(); } });
  await Promise.all([panel.ready, panel.modelReady]);
  const input = { objective: 'Investigate.', enabled: 'on', cadenceMinutes: '60', dailyRunCap: '1', tool: ['read_source'], host: ['ethereum.org'], sourceUrls: '' };
  await submit(element, { ...input, tool: ['execute_shell'] }, 'autonomy');
  await submit(element, { ...input, sourceUrls: 'https://ethereum.org@127.0.0.1/' }, 'autonomy');
  await submit(element, { ...input, reviewerModel: 'model-one' }, 'autonomy');
  assert.equal(writes.length, 0); panel.destroy();
});

test('uncertain autonomous run never auto-retries and explicit retry retains its request key', async () => {
  const data = autonomous(); data.policy.enabled = true; const element = new Element(), writes = [], clock = timers();
  const panel = mountAutonomyPanel(element, { project, ...clock, api: async (path, body) => { if (body) { writes.push(body); throw Error('Lost reply'); } return path.endsWith('/models') ? [] : data; } }); await panel.ready;
  await element.click('autonomy', 'run'); await clock.poll(); assert.equal(writes.length, 1);
  await element.click('autonomy', 'run'); assert.equal(writes[0].requestKey, writes[1].requestKey);
  const editor = element.querySelector('[data-autonomy-editor]'); editor.innerHTML = 'Unsaved objective'; await panel.refresh(); assert.equal(editor.innerHTML, 'Unsaved objective'); panel.destroy(); await clock.poll(); assert.equal(writes.length, 2);
});

test('activity renders only recorded fields with exact charges, safe sources and download links', async () => {
  const element = new Element(), requests = [], clock = timers();
  const charge = { mode: 'zkapi', settledWei: '1000000001', settledMicroUsd: 1, pendingMicroUsd: 2000000, settledCalls: 1, totalCalls: 2 };
  const event = { id: 'event-one', at: '2026-10-02T00:00:00Z', status: 'completed', title: '<img onerror=x>', details: 'Actual result <script>text</script>', source: 'javascript:alert(1)', artifactId: 'result-one', charge, reasoning: 'Hidden marker' };
  const panel = mountActivityPanel(element, { project, ...clock, api: async (path, body) => { requests.push({path,body}); return { events: [event], nextCursor: null, omitted: 0 }; } }); await panel.ready;
  assert.match(element.html(), /&lt;img/); assert.match(element.html(), /0\.000000001000000001 ETH/); assert.match(element.html(), /\$2\.00 reserved/);
  assert.doesNotMatch(element.html(), /javascript:|Hidden marker|<script>text/); assert.match(element.html(), /\/api\/artifacts\/result-one/);
  await clock.poll(); assert.ok(requests.every(r => r.body === undefined)); panel.destroy(); await clock.poll(); assert.equal(requests.length, 2);
  assert.match(activityCharge({ ...charge, settledWei: 1000000001 }), /unavailable/);
});

test('activity older cursor is encoded and no overlapping live read is sent', async () => {
  const element = new Element(), clock = timers(), paths = []; let resolveRead, delayed = false;
  const panel = mountActivityPanel(element, { project, ...clock, api: async path => { paths.push(path); return delayed ? new Promise(resolve => { resolveRead = resolve; }) : { events: [], nextCursor: 'opaque/cursor', omitted: 0 }; } }); await panel.ready;
  delayed = true; const pending = element.click('activity', 'older'); await clock.poll(); assert.equal(paths.length, 2); assert.match(paths[1], /before=opaque%2Fcursor/);
  panel.destroy(); resolveRead({ events: [], nextCursor: null, omitted: 0 }); await pending; assert.equal(element.innerHTML, '');
});

test('notifications stay private and only acknowledge on an explicit click', async () => {
  const element = new Element(), clock = timers(), writes = [];
  const panel = mountNotificationPanel(element, { ...clock, api: async (path, body) => { if (body) writes.push({path,body}); return { notifications: [{ id:'note-one', projectId:project.id, title:'Budget <script>', message:'Review the funding limit.', at:'2026-10-02T00:00:00Z', readAt:null }], unread:1 }; } }); await panel.ready;
  await clock.poll(); assert.equal(writes.length, 0); assert.match(element.html(), /Budget &lt;script&gt;/);
  await element.click('notification','read',{ notificationId:'note-one' }); assert.deepEqual(writes, [{ path:'/api/notifications/ack', body:{id:'note-one'} }]); panel.destroy();
});

test('public sharing requires an exact preview and approval, with history off by default', async () => {
  const element = new Element(), writes = [];
  const panel = mountShowcasePanel(element, { project, api: async (path, body) => { if (body) writes.push({path,body}); return path.endsWith('/preview') ? { preview: { title:body.title,description:body.description,artifacts:project.artifacts.map(a=>({...a,title:'Result 1'})) }, previewDigest:'a'.repeat(64),includeRunHistory:body.includeRunHistory } : { showcase:null }; } }); await panel.ready;
  assert.match(element.html(), /Exact &lt;script&gt;selected result/);
  assert.doesNotMatch(element.html(), /name="includeRunHistory" checked/);
  const input = { title:'Shared work', description:'Chosen findings', artifactId:['result-one'] };
  await submit(element,input,'showcase','publish'); await submit(element,{...input,approve:'on',artifactId:['another-agent']},'showcase'); assert.equal(writes.length,0);
  await submit(element,input,'showcase','preview'); assert.equal(writes.length,1); assert.match(element.html(),/Exact public preview/);
  await submit(element,{...input,approve:'on'},'showcase','publish'); assert.deepEqual(writes[1],{path:`/api/projects/${project.id}/showcase`,body:{title:'Shared work',description:'Chosen findings',artifactIds:['result-one'],includeRunHistory:false,previewDigest:'a'.repeat(64)}}); panel.destroy();
});

test('editing public history choices invalidates the preview and stale/uncertain publication never retries', async () => {
  const element = new Element(), writes = [], input = { title:'Shared', description:'Reviewed content',artifactId:['result-one'],includeRunHistory:'on',approve:'on' };
  const panel = mountShowcasePanel(element,{project,api:async(path,body)=>{ if(body)writes.push({path,body}); if(path.endsWith('/preview'))return{preview:{title:body.title,description:body.description,artifacts:project.artifacts.map(a=>({...a,title:'Result 1'}))},previewDigest:'b'.repeat(64),includeRunHistory:true}; if(body)throw Error('Public content changed. Preview again.');return{showcase:null}; }});await panel.ready;
  await submit(element,input,'showcase','preview'); assert.match(element.html(),/No reliably linked completed run/);
  element.handlers.get('input')({target:{name:'description',closest:()=>({})}});
  await submit(element,input,'showcase','publish'); assert.equal(writes.length,1);
  await submit(element,input,'showcase','preview'); await submit(element,{...input,title:'Changed'},'showcase','publish');assert.equal(writes.length,2);
  await submit(element,input,'showcase','preview');await submit(element,input,'showcase','publish');assert.equal(writes.length,4);assert.match(element.html(),/No automatic retry/);
  await submit(element,input,'showcase','publish');assert.equal(writes.length,4);panel.destroy();
});

test('sharing status refuses arbitrary links and exposes only explicit revoke', async () => {
  assert.equal(showcaseLink('https://evil.example/agents/ABCdef0123456789_-ABCdef','ABCdef0123456789_-ABCdef'),null); assert.equal(showcaseLink('https://veyl.sh/agents/ABCdef0123456789_-ABCdef?token=secret','ABCdef0123456789_-ABCdef'),null);
  const element = new Element(), writes = [], showcase = { slug:'ABCdef0123456789_-ABCdef',url:'https://veyl.sh/agents/ABCdef0123456789_-ABCdef',title:'Chosen title',description:'Chosen text',artifactIds:['result-one'] };
  const panel = mountShowcasePanel(element,{project,api:async(path,body)=>{if(body)writes.push({path,body});return{showcase};}});await panel.ready;
  assert.equal(writes.length,0);await element.click('showcase','revoke');assert.deepEqual(writes,[{path:`/api/projects/${project.id}/showcase/revoke`,body:{}}]);panel.destroy();
});

test('public agent page escapes all result text and unauthenticated fetch never includes credentials', async () => {
  const fixture = { page:{slug:'ABCdef0123456789_-ABCdef',title:'Public <b>title</b>',description:'Chosen description',updatedAt:'2026-10-02T00:00:00Z',artifacts:[{id:'a',title:'Result 1',mode:'demo',content:'<script>alert(1)</script> [link](javascript:bad)',at:'2026-10-02T00:00:00Z'}]},owner:'secret-owner',privatePrompt:'private-marker' };
  const html=renderPublicAgent(fixture,'ABCdef0123456789_-ABCdef');assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|secret-owner|private-marker|href="javascript/);assert.match(html,/Simulated output/);
  const element={innerHTML:'',textContent:''};let request;
  await loadPublicAgent(element,{pathname:'/agents/ABCdef0123456789_-ABCdef',fetcher:async(path,options)=>{request={path,options};return{ok:true,json:async()=>fixture};}});
  assert.equal(request.path,'/api/showcase/ABCdef0123456789_-ABCdef');assert.equal(request.options.credentials,'omit');assert.equal(request.options.cache,'no-store');
  await loadPublicAgent(element,{pathname:'/agents/ABCdef0123456789_-ABCdef',fetcher:async()=>({ok:false})});assert.match(element.textContent,/removed/);
});
