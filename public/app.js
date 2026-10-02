const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((n || 0) / 1e6);
const when = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const glyph = type => ({ research: '◈', builder: '⌘', community: '✳' }[type] || '◈');
let state, models = [], chain = {}, view = 'home', selected = null, tab = 'runtime', step = 0, creating = false, toastTimer;
let launchKey = crypto.randomUUID(), pendingRender = false;
let researchPanel = null, researchPanelGeneration = 0;
const featurePanels = new Map(); let featurePanelGeneration = 0;
function destroyFeaturePanels() { featurePanelGeneration++; for (const panel of featurePanels.values()) panel.destroy(); featurePanels.clear(); }
const pages = Object.create(null);
let agentFilter = 'all';
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-CSRF': state?.csrf || hostedSession?.csrf || '' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function toast(message) { $('toast').textContent = message; $('toast').style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').style.display = 'none', 6000); }
const publicPlatformProject = { id: 'platform-market', name: 'Veyl', symbol: 'VEYL' };
const isPlatformProject = p => p?.mainnet?.token?.toLowerCase() === '0x2eab833d244352d4a7f8dc93285b1776f01954cb';
function stats(project) {
  const ps = project ? [project] : state.projects.filter(p => !isPlatformProject(p)), jobs = state.jobs.filter(j => !project || j.projectId === project.id);
  const total = ps.reduce((n, p) => n + p.policy.total, 0), committed = ps.reduce((n, p) => n + p.committed, 0);
  return `<div class="stats"><div class="stat"><span class="label">${project ? 'Runtime' : 'Your agents'}</span><strong>${project ? project.swarm ? '3 roles' : '1 role' : ps.length.toString().padStart(2, '0')}</strong><small>${project ? esc(project.status) + (state.hosted ? ' · hosted runtime' : ' · local runtime') : ps.filter(p => p.status === 'active').length + ' ready agents'}</small></div><div class="stat"><span class="label">Available allowance</span><strong>${money(total - committed)}</strong><small>Local policy · not a wallet balance</small></div><div class="stat"><span class="label">${state.mode === 'demo' ? 'Simulated usage' : 'Committed spending'}</span><strong>${money(committed)}</strong><small>${state.mode === 'demo' ? 'No inference funds spent' : 'Unsettled caps stay reserved'}</small></div><div class="stat"><span class="label">Delivered tasks</span><strong>${jobs.filter(j => j.status === 'completed').length.toString().padStart(2, '0')}</strong><small>Saved deliverables & stage history</small></div></div>`;
}
function renderShell() {
  $('mode').hidden = state.hosted === true;
  $('mode').textContent = state.hosted ? '' : state.mode === 'demo' ? 'LOCAL DEMO' : 'zkAPI WORKSPACE';
  $('runtime-status').hidden = false;
  $('runtime-status').textContent = state.persistence === 'blocked' ? 'Storage error · runtime blocked' : state.busy ? 'Runtime working' : state.hosted ? 'Hosted runtime online' : 'Local runtime online';
  $('job-count').textContent = state.jobs.length; document.querySelectorAll('[data-launch], .sidebar .nav').forEach(el => el.disabled = false); if (state.hosted) { $('wallet-control').textContent = state.wallet.slice(0, 6) + '…' + state.wallet.slice(-4) + ' · Sign out'; }
  $('project-nav').innerHTML = state.projects.filter(p => !state.hosted || !isPlatformProject(p)).map(p => `<button class="project-link ${selected === p.id && view === 'project' ? 'active' : ''}" data-project="${p.id}"><span>${glyph(p.template)}</span>${esc(p.name)}</button>`).join('');
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const liveProject = state.projects.find(p => p.id === selected);
  if (view === 'project' && liveProject && $('project-stats')) $('project-stats').innerHTML = stats(liveProject);
  $('page-title').textContent = view === 'home' ? 'Overview' : view === 'platform' ? 'VEYL market' : view === 'jobs' ? 'Activity' : view === 'tools' ? 'Tools & connections' : state.projects.find(p => p.id === selected)?.name || 'Agent';
}
function pageList(items, key, size, item, empty = '') {
  const count = Math.max(1, Math.ceil(items.length / size));
  const current = Math.max(0, Math.min(pages[key] || 0, count - 1)); pages[key] = current;
  const content = items.slice(current * size, (current + 1) * size).map(item).join('') || empty;
  return content + (count > 1 ? `<nav class="pagination" aria-label="List pages"><button class="button secondary compact" data-page="${key}" data-offset="-1" ${current === 0 ? 'disabled' : ''}>← Previous</button><span>Page ${current + 1} of ${count} · ${items.length} items</span><button class="button secondary compact" data-page="${key}" data-offset="1" ${current === count - 1 ? 'disabled' : ''}>Next →</button></nav>` : '');
}
function renderHome() {
  const platform = state.projects.find(isPlatformProject), projects = state.projects.filter(p => !isPlatformProject(p) && (agentFilter === 'all' || p.status === agentFilter));
  const pageSize = matchMedia('(max-width:760px)').matches ? 3 : 6;
  return `<section class="overview-head"><div><p class="eyebrow">YOUR WORKSPACE</p><h1>A clear view of your agents.</h1><p>Set a task. Follow the work. Keep the budget in sight.</p></div><div class="notification-actions"><button class="text-link" data-view="jobs">Notifications</button><a href="/docs#start" class="text-link">Quick start ↗</a></div></section>${state.hosted || platform ? `<section class="panel"><div class="section-title"><div><span class="badge">PLATFORM TOKEN</span><h2>VEYL · Ethereum</h2><p>The platform’s VEYL/ETH market and operating treasury.</p></div><button class="button secondary" ${state.hosted ? 'data-view="platform"' : `data-project="${platform.id}"`}>Trade & view fees ↗</button></div></section>` : ''}${stats()}<section><div class="section-title"><div><h2>Your agents</h2><p>Purpose, status and remaining allowance at a glance.</p></div><label class="filter-label">Status<select id="agent-filter" aria-label="Agent status"><option value="all" ${agentFilter === 'all' ? 'selected' : ''}>All agents</option><option value="active" ${agentFilter === 'active' ? 'selected' : ''}>Active</option><option value="paused" ${agentFilter === 'paused' ? 'selected' : ''}>Paused</option></select></label></div><div class="cards">${pageList(projects, 'agents', pageSize, p => `<button class="agent-card" data-project="${p.id}"><div class="card-top"><span class="avatar ${p.template === 'builder' ? 'blue' : p.template === 'community' ? 'purple' : ''}">${glyph(p.template)}</span><span class="badge">${esc(p.status)}</span></div><h3>${esc(p.name)}</h3><span class="symbol">$${esc(p.symbol)} · ${p.swarm ? 'Specialist swarm' : 'Solo agent'}</span><p>${esc(p.purpose.slice(0, 105))}${p.purpose.length > 105 ? '…' : ''}</p><div class="card-bottom"><span><b>${money(p.policy.total - p.committed)}</b> allowance</span><span>Open workspace ↗</span></div></button>`, '<div class="empty"><b>No agents in this view.</b>Create your first agent or change the status filter.</div>')}${projects.length < pageSize ? '<button class="agent-card new-card" data-launch><span class="plus">＋</span><div><h3>Create an agent</h3><p>Choose a purpose and set its limits.</p></div></button>' : ''}</div></section><div class="workspace-note"><span>${state.mode === 'demo' ? 'Local demo · model output is simulated' : 'zkAPI · settled charges and pending caps tracked separately'}</span><a href="/docs#mainnet">Network & contracts ↗</a></div>`;
}
function jobAccounting(job) {
  if (job.mode === 'demo') return '';
  const calls = job.steps.flatMap(step => [step, ...(step.additionalCalls || [])]).map(step => step.callAccounting).filter(Boolean);
  if (!calls.length) return '';
  const settled = calls.filter(call => call.status === 'settled');
  const valued = settled.reduce((sum, call) => sum + call.valuationMicroUsd, 0);
  const wei = settled.reduce((sum, call) => sum + BigInt(call.chargeWei), 0n);
  const fraction = (wei % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '');
  const eth = (wei / 1_000_000_000_000_000_000n).toString() + (fraction ? '.' + fraction : '');
  const precise = value => (value / 1e6).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
  return `<details><summary>Usage charges · ${settled.length} settled · ${precise(Math.max(0, job.reservation - valued))} pending</summary><p>${eth} ETH settled. Budget value: ${precise(valued)}, rounded up to microdollars using each call’s saved quote. Pending caps remain held until the native wallet verifies settlement.</p></details>`;
}
function jobCard(job) {
  const p = state.projects.find(p => p.id === job.projectId);
  return `<article class="job"><div class="job-top"><span>${esc(p?.name)} · ${when(job.at)}</span><span class="status ${job.status}">${esc(job.status)}</span></div>${job.prompt.length > 180 ? `<details class="task-prompt"><summary>${esc(job.prompt.slice(0, 180))}…</summary><p>${esc(job.prompt)}</p></details>` : `<div class="job-title">${esc(job.prompt)}</div>`}<div class="steps">${job.steps.map(s => `<span class="step ${s.status}">${s.status === 'completed' ? '✓' : s.status === 'running' ? '◌' : '○'} ${esc(s.role)}</span>`).join('')}</div><small>${money(job.reservation)} ${job.mode === 'demo' ? 'simulated / reserved' : 'committed'} · ${job.mode === 'demo' ? 'Deterministic demo' : 'zkAPI'}</small>${jobAccounting(job)}${job.error ? `<p class="error">${esc(job.error)}</p>` : ''}${job.steps.filter(s => s.output).map(s => `<details><summary>${esc(s.role)} output · ${esc(s.verification)}</summary><pre>${esc(s.output)}</pre></details>`).join('')}${job.artifactId ? `<p><a class="text-link" href="/api/artifacts/${job.artifactId}">Download deliverable ↗</a></p>` : ''}</article>`;
}
function feeRevenuePanel(p) {
  const allocation = state.feeAllocation;
  if (!allocation) return '';
  return `<section class="panel fee-panel"><div class="section-title"><div><h2>Where collected fees go</h2><p>Fixed shares of receipts · the trading fee rate is separate.</p></div><a class="text-link" href="/docs#economics">How funding works ↗</a></div><div class="fee-bar" role="img" aria-label="70 percent treasury, 20 percent creator, 10 percent platform"><span></span><span></span><span></span></div><div class="fee-legend"><div><b>${allocation.treasuryBps / 100}%</b><strong>Agent treasury</strong></div><div><b>${allocation.creatorBps / 100}%</b><strong>Creator</strong></div><div><b>${allocation.protocolBps / 100}%</b><strong>Platform</strong></div></div><p class="hint">Direct top-ups stay in full. Market fees accrue in the v4 hook until collected.</p>${p.chain ? `<details><summary>Inspect fee router & receipts</summary><div id="fee-state" aria-live="polite">Reading local fee router…</div>${state.mode === 'demo' && !p.chain.hook ? '<div class="fee-actions"><button class="button secondary" data-action="revenue">Test 0.01 ETH fee receipt</button><button class="button secondary" data-action="distribute" id="deliver-fees" disabled>Deliver fee shares</button></div>' : ''}<p class="hint">${p.chain.hook ? 'Collect fees from the Market tab to redeem hook receipts and deliver every share.' : 'A development-only test receipt creates a router for older projects if needed.'} ETH receipts do not change inference allowances or fund zkAPI.</p></details>` : '<p class="hint">Create a local treasury to test receipts.</p>'}</section>`;
}
function renderProject() {
  const p = state.projects.find(p => p.id === selected); if (!p) { view = 'home'; return renderHome(); }
  if (isPlatformProject(p)) {
    tab = 'market';
    return `<div class="project-head"><div class="project-title"><span class="avatar">◈</span><div><h1>VEYL</h1><p>Platform token · Ethereum · VEYL/ETH</p></div></div></div><p class="subtext">Manage the platform market and its operating treasury. Individual agent models, budgets and social connections belong to their own workspaces.</p><div id="mainnet-panel">Reading Ethereum market…</div>`;
  }
  const jobs = state.jobs.filter(j => j.projectId === p.id).reverse();
  const header = `<div class="project-head"><div class="project-title"><span class="avatar">${glyph(p.template)}</span><div><h1>${esc(p.name)}</h1><p>$${esc(p.symbol)} · ${p.swarm ? 'Specialist swarm' : 'Solo agent'} · ${esc(p.status)}</p></div></div><button class="button secondary" data-action="pause">${p.status === 'active' ? 'Ⅱ Pause runtime' : '▷ Resume runtime'}</button></div>${['research', 'market', 'connections', 'developer'].includes(tab) ? '' : `<div id="project-stats">${stats(p)}</div>`}<div class="tabs">${['runtime', 'research', 'market', 'treasury', 'memory', 'deliverables', 'connections', 'developer'].map(t => `<button class="tab ${tab === t ? 'active' : ''}" data-tab="${t}">${t === 'runtime' ? 'Activity' : t[0].toUpperCase() + t.slice(1)}${t === 'deliverables' ? ` (${p.artifacts.length})` : ''}</button>`).join('')}</div>`;
  if (tab === 'research') return header + '<div id="autonomy-panel">Reading research rules…</div><div id="research-panel">Reading research history…</div>';
  if (tab === 'developer') return header + '<div id="developer-panel">Reading project developer access…</div>';
  if (tab === 'connections') return header + '<div id="social-panel" class="social-panel">Reading project connections…</div>';
  if (tab === 'market') return header + (state.hosted ? '<div id="mainnet-panel">Reading Ethereum configuration…</div>' : renderMarketPanel(p));
  if (tab === 'runtime') return header + `<div class="two-col"><section class="panel"><h2>Put your team to work.</h2>${p.purpose.length > 220 ? `<details class="purpose"><summary>${esc(p.purpose.slice(0, 220))}…</summary><p>${esc(p.purpose)}</p></details>` : `<p class="subtext">${esc(p.purpose)}</p>`}<div class="team-flow">${(p.swarm ? ['Planner', state.templates[p.template].role, 'Reviewer'] : [state.templates[p.template].role]).map((role, i) => `<div class="role"><span>${['◇', glyph(p.template), '✓'][i]}</span>${role}<small><br>${i === 2 ? 'Checks & delivers' : i === 0 && p.swarm ? 'Breaks down the task' : 'Creates the deliverable'}</small></div>`).join('')}</div><form id="task-form"><label for="task-prompt">New task</label><textarea id="task-prompt" required maxlength="8000" placeholder="What should your team work on?"></textarea><p class="hint">${p.model === 'pending' ? 'Select a model in settings below' : esc(p.model)} · ${money(p.policy.request)} per-call ceiling · ${money(p.policy.daily)} daily allowance</p><button class="button full" type="submit" ${(!state.hosted && state.busy) || p.status !== 'active' || p.model === 'pending' ? 'disabled' : ''}>${state.hosted ? 'Queue task ↗' : state.busy ? 'Runtime is working…' : 'Run task ↗'}</button></form><div class="info-box">${state.mode === 'demo' ? 'Demo responses are simulated. The job queue, memory, budget accounting and files work locally.' : 'Each call reserves its cap and rounding allowance. Verified settlement records the ETH charge and releases unused budget; uncertain charges stay held.'}</div>${runtimeSettings(p)}<details><summary>Repeat a task on a schedule</summary><form id="schedule-form"><label>Task<textarea name="prompt" required maxlength="8000" placeholder="Prepare a recurring project brief.">${esc(p.schedule?.prompt || '')}</textarea></label><label>Frequency<select name="minutes"><option value="15">Every 15 minutes</option><option value="60">Every hour</option><option value="1440">Daily</option></select></label><button class="button secondary" type="submit">Save schedule</button></form><p class="hint">${p.schedule ? `Next run: ${esc(new Date(p.schedule.nextAt).toLocaleString())}. ` : ''}${state.hosted ? 'Runs on the hosted worker, including when you close this page.' : 'Runs while this local server is open.'} Budget exhaustion pauses the schedule; missed runs do not build a backlog.</p>${p.schedule ? '<button class="text-link" data-action="unschedule">Remove schedule</button>' : ''}</details></section><div><div id="activity-panel">Reading recorded activity…</div><details class="panel"><summary>Saved task results</summary>${jobs.length ? pageList(jobs, 'timeline-' + p.id, 3, jobCard) : '<p class="hint">Completed work also appears in Deliverables.</p>'}</details></div></div>`;
  if (tab === 'treasury' && state.hosted) return header + hostedTreasury(p);
  if (tab === 'treasury') return header + feeRevenuePanel(p) + `<div class="two-col"><section class="panel"><h2>Token & operating treasury</h2><p class="subtext">Local chain 31337 · development assets only</p>${p.chain ? `<details><summary>Token, treasury & owner addresses</summary><label>Project token</label><div class="address">${p.chain.token}</div><label>Operating treasury</label><div class="address">${p.chain.treasury}</div><label>Owner</label><div class="address">${p.chain.owner}</div></details><p class="hint">${p.chain.hook ? '1B fixed supply. The seeded inventory is locked in the pool; the creator holds the remaining tokens.' : 'Earlier token setup: 1B fixed supply held by the local owner; no trading pool.'}</p><div class="info-box">Treasury balance: <strong id="eth-balance">Checking…</strong> development ETH<br>Operator daily limit: 0.01 ETH. No spending recipients approved by default.</div><button class="button secondary" data-action="fund">Add 0.01 development ETH</button>` : `<div class="empty"><b>Ready for its own treasury.</b>Create a fixed-supply token and operating vault on your local Anvil node.</div><button class="button" data-action="deploy" ${chain.ready ? '' : 'disabled'}>Deploy local token & treasury ↗</button>`}<div class="info-box">The owner can withdraw operating funds. Market liquidity is locked separately. Local ETH does not fund the live zkAPI wallet.</div></section><section class="panel"><h2>Funding activity</h2><p class="subtext">Recorded treasury deposits, market launches and fee distributions.</p>${pageList(p.events.slice().reverse(), 'funding-' + p.id, 4, e => `<div class="activity-row"><time>${when(e.at)}</time>${e.message.length > 120 ? `<details><summary>${esc(e.message.slice(0, 115))}…</summary><p>${esc(e.message)}</p></details>` : `<p>${esc(e.message)}</p>`}</div>`)}</section></div>`;
  if (tab === 'memory') return header + `<div class="two-col"><section class="panel"><h2>Shared memory</h2><p class="subtext">The latest eight notes and two deliverables enter each new task.</p><form id="memory-form"><label>Add project context<textarea name="content" required maxlength="8000" placeholder="Decisions, facts, preferences, or context your team should remember."></textarea></label><button class="button" type="submit">Save to memory</button></form>${pageList(p.notes.slice().reverse(), 'notes-' + p.id, 5, n => `<details class="memory-note"><summary>${esc(n.content.slice(0, 100))}${n.content.length > 100 ? '…' : ''}</summary><p>${esc(n.content)}</p></details>`)}</section><section class="panel"><h2>Source library</h2><p class="subtext">Fetch a document from a reviewed public domain. The most recent three enter the model context.</p><form id="source-form"><label>Public source URL<input name="url" type="url" required placeholder="https://zkapi.openanonymity.ai/docs"></label><button class="button secondary" type="submit">Read & attach source ↗</button></form><p class="hint">Allowed: ${state.sourceHosts.map(esc).join(', ')}. Redirects are refused.</p>${pageList(p.sources.slice().reverse(), 'sources-' + p.id, 5, s => `<div class="artifact"><a class="source-url" href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url)}</a><p class="hint">Read ${new Date(s.fetchedAt).toLocaleString()} · ${s.text.length.toLocaleString()} characters</p><details><summary>Inspect captured text</summary><pre>${esc(s.text)}</pre></details></div>`)}</section></div>`;
  return header + `<div id="showcase-panel">Reading public sharing settings…</div><section class="panel"><h2>Delivered work</h2><p class="subtext">${state.hosted ? 'Saved privately in your encrypted workspace.' : 'Outputs stay local. Demo artifacts are clearly labelled.'}</p>${pageList(p.artifacts.slice().reverse(), 'artifacts-' + p.id, 5, a => `<article class="artifact"><h3>${esc(a.title)}</h3><span class="badge">${a.mode === 'demo' ? 'SIMULATED OUTPUT' : 'MODEL OUTPUT'}</span><details><summary>Read deliverable</summary><pre>${esc(a.content)}</pre></details><a href="/api/artifacts/${a.id}">Download Markdown ↗</a></article>`, '<div class="empty"><b>Make something worth keeping.</b>Completed tasks save their final output here.</div>')}</section>`;
}
function renderTools() {
  if (state.hosted) return renderHostedTools();
  const tools = [ ['◇', 'zkAPI inference', state.mode === 'demo' ? 'Adapter ready · live connection not configured' : 'Live daemon adapter', 'Connects to your local zkAPI daemon. Proofs and private notes stay with that daemon; this app stores transcripts. Authenticated signed receipts record exact ETH charges; unresolved calls retain their caps.'], ['≋', 'Persistent memory', 'Available', 'Project notes and recent deliverables survive restarts and enter future task context. Stored as local plaintext.'], ['↗', 'Public source reader', 'Available', 'Reads bounded HTTPS documents from reviewed domains. Source URLs and captured text are saved with the project.'], ['↓', 'Artifact delivery', 'Available', 'Each completed task produces a downloadable Markdown deliverable and an inspectable record of each specialist’s contribution.'], ['◈', 'Token & treasury', chain.ready ? 'Local Anvil connected' : 'Local Anvil not running', 'Fixed-supply ERC-20 and owner-controlled operating vault. Per-day operator limits, approved recipients and payment replay protection. New launches include a v4 market with permanently locked liquidity and real hook fee collection.'], ['◷', 'Scheduled tasks', 'Demo mode', 'Repeat tasks while the runtime is open. Budget exhaustion pauses the schedule. Verified final charges release the unused reservation; uncertain calls remain reserved.'], ['⌘', 'Code execution & hosting', 'Not connected', 'Builder agents can create a code handoff. Sandboxed execution, deployed sites and independent runtime hosting are a separate integration.'], ['◎', 'Socials & customer payments', 'Not connected', 'External publishing, OAuth connections and paid customer jobs are not enabled in this local build.'] ];
  return renderFundingPanel() + `<div class="section-title"><div><h2>Everything your team can use.</h2><p>Tools, context and controls for your agents.</p></div></div><div class="tool-grid">${tools.map(([g,n,s,d]) => `<article class="tool"><span class="avatar">${g}</span><h3>${n}</h3><span class="tool-state">${s}</span><p>${d}</p></article>`).join('')}</div>`;
}
function renderPlatformMarket() { return `<div class="project-head"><div><p class="eyebrow">PLATFORM TOKEN</p><h1>VEYL market.</h1><p class="subtext">Trade VEYL/ETH and collect fees to their fixed recipients. Every transaction requires your wallet approval.</p></div><a class="text-link" href="/market">Public market overview ↗</a></div><div id="mainnet-panel">Reading Ethereum market…</div>`; }
function render() {
  destroyFeaturePanels();
  researchPanel?.destroy(); researchPanel = null; researchPanelGeneration++;
  mainnetPanel?.destroy(); mainnetPanel = null; mainnetPanelGeneration++; socialPanel?.destroy(); socialPanel = null; socialPanelGeneration++; runwayPanel?.destroy(); runwayPanel = null; runwayPanelGeneration++; developerPanel?.destroy(); developerPanel = null; developerPanelGeneration++; pendingRender = false;
  if (view === 'project' && !state.projects.some(p => p.id === selected)) { view = 'home'; selected = null; }
  if (view === 'platform' && !state.hosted) view = 'home';
  const locationState = new URLSearchParams({ view }); if (view === 'project') { locationState.set('id', selected); locationState.set('tab', tab); } history.replaceState(null, '', '/app#' + locationState);
  renderShell(); $('content').innerHTML = view === 'home' ? renderHome() : view === 'platform' ? renderPlatformMarket() : view === 'project' ? renderProject() : view === 'tools' ? renderTools() : `<div class="section-title"><div><h2>Work, from start to finish.</h2><p>Every task across your agents.</p></div><span class="badge">${state.jobs.length} TASKS</span></div><div id="notification-panel">Reading notifications…</div><section class="panel">${pageList(state.jobs.slice().reverse(), 'activity', matchMedia('(max-width:760px)').matches ? 3 : 5, jobCard, '<div class="empty"><b>A fresh page.</b>Create an agent and give it a task to start.</div>')}</section>`;
  if (view === 'project' && tab === 'treasury' && state.hosted) loadRunwayPanel(state.projects.find(p => p.id === selected));
  if (view === 'project' && tab === 'research') { loadResearchPanel(state.projects.find(p => p.id === selected)); loadFeaturePanel('autonomy', state.projects.find(p => p.id === selected)); }
  if (view === 'project' && tab === 'runtime') loadFeaturePanel('activity', state.projects.find(p => p.id === selected));
  if (view === 'project' && tab === 'deliverables') loadFeaturePanel('showcase', state.projects.find(p => p.id === selected));
  if (view === 'jobs') loadFeaturePanel('notification');
  if (view === 'project' && tab === 'developer') loadDeveloperPanel(state.projects.find(p => p.id === selected));
  if (view === 'project' && tab === 'connections') loadSocialPanel(state.projects.find(p => p.id === selected));
  if (view === 'platform' && state.hosted) loadMainnetPanel(publicPlatformProject);
  if (view === 'project' && tab === 'market' && state.hosted) loadMainnetPanel(state.projects.find(p => p.id === selected));
  if (view === 'project' && tab === 'market' && $('market-live')) loadMarketPanel(selected);
  if (view === 'project' && tab === 'runtime') loadProjectModels(selected);
  if (view === 'tools' && !state.hosted || view === 'project' && tab === 'treasury' && state.hosted) loadFundingPanel();
  if (state.persistence === 'blocked') $('content').insertAdjacentHTML('afterbegin', '<div class="storage-alert" role="alert">Storage could not be saved. The runtime is blocked. Preserve the data file and resolve the disk error before restarting.</div>');
  if (view === 'project' && tab === 'treasury' && $('eth-balance')) { const projectId = selected; api(`/api/projects/${projectId}/balance`).then(b => { if (selected === projectId && $('eth-balance')) { $('eth-balance').textContent = readable(b.eth, 9); $('eth-balance').title = b.eth + ' ETH'; } }).catch(e => { if (selected === projectId && $('eth-balance')) $('eth-balance').textContent = e.message; }); }
  if (view === 'project' && tab === 'treasury' && $('fee-state')) {
    const projectId = selected;
    api(`/api/projects/${projectId}/revenue`).then(result => {
      if (selected !== projectId || !$('fee-state')) return;
      $('fee-state').innerHTML = result.configured ? `<label>Fee router</label><div class="address">${esc(result.router)}</div><p class="hint">Verified on local chain: ${result.allocation.treasuryBps / 100}% / ${result.allocation.creatorBps / 100}% / ${result.allocation.protocolBps / 100}%</p><div class="fee-pending">${Object.entries(result.claimable).map(([role, eth]) => `<div><span>${role === 'treasury' ? 'Agent treasury' : role === 'creator' ? 'Creator' : 'Platform'} pending</span><strong>${esc(eth)} ETH</strong></div>`).join('')}</div>` : '<p class="hint">This project predates the fee router. Its first test receipt will deploy the approved router.</p>';
      if ($('deliver-fees')) $('deliver-fees').disabled = !result.configured || Object.values(result.claimable).every(value => Number(value) === 0);
    }).catch(error => { if (selected === projectId && $('fee-state')) $('fee-state').textContent = error.message; });
  }
}
async function refresh(renderPage = true) { state = await api('/api/state'); if (renderPage) render(); else renderShell(); }
function showStep(n) { step = n; document.querySelectorAll('.wizard-page').forEach(el => el.hidden = Number(el.dataset.step) !== n); document.querySelectorAll('.wizard-steps span').forEach((el,i) => el.classList.toggle('current', i === n)); $('back').hidden = n === 0; $('next').hidden = n === 2; $('create').hidden = n !== 2; }
function launch(template) { if (!state) return; if (creating) return; if (template) $('launch-form').elements.template.value = template; $('launch-error').textContent = ''; $('launch-disclosure').textContent = state.hosted ? 'Creating this workspace does not deploy a token. You can launch an optional token market later in Market. Paid tasks use your funded zkAPI balance; these allowances are spending limits, not deposits.' : state.mode === 'demo' ? 'Demo inference is simulated. Allowances are local policy, not deposited USD. No real wallet or payment is needed.' : 'Live tasks can spend your daemon balance. Local USD allowances are conservative reservations, not verified wallet funds. Funding and settlement remain with zkAPI.'; const localDeploy = $('launch-form').elements.deploy; localDeploy.closest('label').hidden = !!state.hosted; localDeploy.disabled = !!state.hosted; if (state.hosted) localDeploy.checked = false; showStep(0); $('launch-dialog').showModal(); }
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.page) { pages[button.dataset.page] = (pages[button.dataset.page] || 0) + Number(button.dataset.offset); render(); document.querySelector(`[data-page="${CSS.escape(button.dataset.page)}"][data-offset="${button.dataset.offset}"]`)?.focus(); return; }
  if (button.hasAttribute('data-launch')) return launch();
  if (button.dataset.template) return launch(button.dataset.template);
  if (button.dataset.view) { view = button.dataset.view; return render(); }
  if (button.dataset.project) { selected = button.dataset.project; view = 'project'; tab = 'runtime'; return render(); }
  if (button.dataset.tab) { tab = button.dataset.tab; return render(); }
  if (button.classList.contains('close')) return $('launch-dialog').close();
  if (button.dataset.funding) {
    button.disabled = true;
    try {
      const action = button.dataset.funding, intent = fundingState?.intents.find(i => i.id === button.dataset.intent);
      const body = action === 'approve' ? { intentId: intent.id, quoteId: intent.quote.id, approvalDigest: intent.approvalDigest } : action === 'resume' ? { intentId: intent.id, transactionHash: intent.transactionHash } : { intentId: intent?.id };
      if (['approve', 'resume'].includes(action) && state.hosted && state.capabilities.transactionsEnabled !== true) throw new Error('Mainnet funding signing remains disabled.');
      const result = await api(fundingPath() + '/' + action, body);
      if (action === 'inspect' && $('funding-inspect')) $('funding-inspect').innerHTML = '<p class="hint">Ethereum · ' + esc(result.funding.phase) + ' · ' + ethWei(result.funding.balanceWei) + ' ETH</p><div class="address">' + esc(result.funding.address) + '</div>';
      await loadFundingPanel(); toast('Funding status updated.');
    } catch (error) { toast(error.message); } finally { button.disabled = false; }
    return;
  }
  if (button.dataset.action) {
    button.disabled = true;
    try { const action = button.dataset.action; await api(`/api/projects/${selected}/${action === 'unschedule' ? 'schedule' : action}`, action === 'unschedule' ? { enabled: false } : action === 'market-swap' ? { quoteId: marketQuotes.get(selected)?.id } : {}); await refresh(); toast(action === 'fund' ? 'Development ETH added. Inference allowance is unchanged.' : action === 'revenue' ? 'Test receipt allocated 70/20/10. Deliver the shares to move funds.' : action === 'distribute' ? 'Pending shares delivered. Inference allowance is unchanged.' : 'Workspace updated.'); }
    catch (error) { toast(error.message); button.disabled = false; }
  }
});
document.addEventListener('change', event => { if (event.target.id === 'agent-filter') { agentFilter = event.target.value; pages.agents = 0; render(); $('agent-filter')?.focus(); } });
$('next').onclick = () => { const inputs = document.querySelector(`.wizard-page[data-step="${step}"]`).querySelectorAll('input,textarea,select'); for (const input of inputs) if (!input.reportValidity()) return; showStep(step + 1); };
$('back').onclick = () => showStep(step - 1);
$('launch-form').addEventListener('submit', async event => {
  event.preventDefault(); if (creating) return; creating = true; $('create').disabled = true; $('create').textContent = 'Creating workspace…'; $('launch-error').textContent = '';
  const data = new FormData(event.target);
  try {
    const project = await api('/api/projects', { requestKey: launchKey, name: data.get('name'), symbol: data.get('symbol'), purpose: data.get('purpose'), template: data.get('template'), swarm: data.get('team') === 'swarm', model: data.get('model'), total: Math.round(Number(data.get('total')) * 1e6), daily: Math.round(Number(data.get('daily')) * 1e6), request: Math.round(Number(data.get('request')) * 1e6) });
    let message = 'Your agent workspace is ready.';
    if (data.get('deploy') && !state.hosted) { try { await api(`/api/projects/${project.id}/market-launch`, {}); message = 'Agent, trading pool and treasury are ready on Anvil.'; } catch (error) { message = `Runtime created. Market step pending: ${error.message}`; } }
    selected = project.id; view = 'project'; tab = 'runtime'; launchKey = crypto.randomUUID(); $('launch-dialog').close(); event.target.reset(); await refresh(); toast(message);
  } catch (error) { $('launch-error').textContent = error.message; }
  finally { creating = false; $('create').disabled = false; $('create').textContent = 'Create agent ↗'; }
});
document.addEventListener('submit', async event => {
  const form = event.target; if (form.id === 'launch-form' || form.hasAttribute('data-mainnet-form') || form.hasAttribute('data-social-form') || form.hasAttribute('data-runway-form') || form.hasAttribute('data-developer-form') || form.hasAttribute('data-research-form') || form.hasAttribute('data-autonomy-form') || form.hasAttribute('data-showcase-form')) return;
  event.preventDefault(); const button = form.querySelector('button[type=submit]'); if (button) button.disabled = true;
  try {
    const data = new FormData(form), base = `/api/projects/${selected}`;
    if (form.id === 'trade-form') { const q = await api(`${base}/market-quote`, { side: data.get('side'), amount: data.get('amount'), slippageBps: Number(data.get('slippage')) }); showMarketQuote(selected, q); button.disabled = false; return; }
    if (form.id === 'funding-form') { form.dataset.requestKey ||= crypto.randomUUID(); await api(fundingPath() + '/quote', { idempotencyKey: form.dataset.requestKey, amountGwei: data.get('amountGwei') }); await loadFundingPanel(); button.disabled = false; return; }
    if (form.id === 'task-form') { form.dataset.requestKey ||= crypto.randomUUID(); await api(`${base}/jobs`, { requestKey: form.dataset.requestKey, prompt: $('task-prompt').value }); toast('Task accepted. Your team is working.'); }
    if (form.id === 'settings-form') await api(`${base}/settings`, { model: data.get('model'), total: Math.round(Number(data.get('total')) * 1e6), daily: Math.round(Number(data.get('daily')) * 1e6), request: Math.round(Number(data.get('request')) * 1e6) });
    if (form.id === 'memory-form') await api(`${base}/notes`, { content: data.get('content') });
    if (form.id === 'source-form') await api(`${base}/sources`, { url: data.get('url') });
    if (form.id === 'schedule-form') await api(`${base}/schedule`, { enabled: true, minutes: Number(data.get('minutes')), prompt: data.get('prompt') });
    await refresh();
  } catch (error) { toast(error.message); if (button) button.disabled = false; }
});
async function init() {
  try { if (!await sessionBootstrap()) return; const savedView = new URLSearchParams(location.hash.slice(1)); if (['home','project','jobs','tools','platform'].includes(savedView.get('view'))) view = savedView.get('view'); selected = savedView.get('id'); if (['runtime','research','market','treasury','memory','deliverables','connections','developer'].includes(savedView.get('tab'))) tab = savedView.get('tab'); await refresh(); const results = await Promise.allSettled([api('/api/models'), api('/api/chain')]);
    if (results[0].status === 'fulfilled') models = results[0].value; else toast(results[0].reason.message);
    if (results[1].status === 'fulfilled') chain = results[1].value;
    $('launch-model').innerHTML = models.length ? models.map(m => `<option value="${esc(m.id)}">${esc(m.id)} · ${money(m.oa_request_limit_micro_usd)} cap${m.oa_accounting_margin_micro_usd ? ` + ${(m.oa_accounting_margin_micro_usd / 1e6).toFixed(3)} USD reserve` : ''}</option>`).join('') : '<option value="pending">Select after runtime setup</option>'; render();
    const preset = new URLSearchParams(location.search).get('template'); if (Object.hasOwn(state.templates, preset)) launch(preset);
  } catch (error) { $('content').textContent = error.message; }
}
setInterval(async () => { if (!state || creating) return; try { const wasBusy = state.busy; const next = await api('/api/state'); pendingRender ||= next.persistence !== state.persistence || next.busy !== wasBusy || JSON.stringify(next.jobs) !== JSON.stringify(state.jobs); state = next; if (pendingRender && !(view === 'project' && ['connections', 'developer', 'research', 'runtime', 'deliverables'].includes(tab)) && !document.activeElement?.closest('form, details') && !document.activeElement?.matches('input, select, textarea')) render(); else renderShell(); } catch {} }, 5000);
init();

document.addEventListener('input', event => { if (event.target.closest('#trade-form')) { marketQuotes.delete(selected); if ($('trade-quote')) $('trade-quote').innerHTML = ''; } });
document.addEventListener('change', event => { if (event.target.matches('#trade-form select[name=side]')) { $('trade-unit').textContent = event.target.value === 'buy' ? '(ETH)' : '(tokens)'; event.target.form.elements.amount.value = event.target.value === 'buy' ? '0.01' : '100000'; } });
