let hostedSession = null, chainClient = null, mainnetPanel = null, mainnetPanelGeneration = 0, walletEventsBound = false, socialPanel = null, socialPanelGeneration = 0, runwayPanel = null, runwayPanelGeneration = 0, developerPanel = null, developerPanelGeneration = 0;
async function sessionBootstrap() {
  $('mode').hidden = true; $('mode').textContent = '';
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('The Veyl runtime is unavailable. Please try again shortly.');
  hostedSession = await response.json();
  if (hostedSession.mode !== 'production') return true;
  const { VeylChainClient } = await import('/chain-client.js');
  chainClient ||= new VeylChainClient({ api, transactionsEnabled: false });
  $('wallet-control').hidden = false;
  if (!walletEventsBound) chainClient.addEventListener('change', () => {
    const account = chainClient.wallet.account;
    if (hostedSession?.authenticated && account && account.toLowerCase() !== hostedSession.address.toLowerCase()) signOut().catch(() => {});
  });
  walletEventsBound = true;
  if (!hostedSession.authenticated) { renderSignIn(); return false; }
  await chainClient.wallet.restore();
  return true;
}
function renderSignIn(message = '') {
  researchPanel?.destroy(); researchPanel = null; researchPanelGeneration++;
  socialPanel?.destroy(); socialPanel = null; socialPanelGeneration++; mainnetPanel?.destroy(); mainnetPanel = null; mainnetPanelGeneration++;
  runwayPanel?.destroy(); runwayPanel = null; runwayPanelGeneration++;
  developerPanel?.destroy(); developerPanel = null; developerPanelGeneration++;
  state = null;
  document.querySelectorAll('[data-launch], .sidebar .nav').forEach(el => el.disabled = true);
  $('project-nav').innerHTML = ''; $('job-count').textContent = '0';
  $('mode').hidden = true; $('mode').textContent = ''; $('runtime-status').hidden = true; $('runtime-status').textContent = '';
  $('wallet-control').textContent = 'Connect wallet';
  $('content').innerHTML = `<section class="signin-panel"><img src="/logo.svg" alt="" width="64" height="64"><p class="eyebrow">YOUR IDEAS HAVE A HOME.</p><h1>Welcome to Veyl.</h1><p>One workspace for your agents, their memory and the work they deliver.</p><button class="button" data-signin>Connect & sign in ↗</button><p class="hint">Sign an ownership message with your Ethereum wallet. Signing in costs no gas and sends no transaction.</p><p class="hint">On mobile, open veyl.sh in your Ethereum wallet’s browser.</p>${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}<a class="text-link" href="/market">View the public VEYL market →</a><br><a class="text-link" href="/docs#start">Get to know Veyl →</a></section>`;
}
async function signIn(button) {
  button.disabled = true;
  try {
    const wallet = await chainClient.wallet.connect();
    if (!wallet.ethereum) await chainClient.wallet.switchEthereum();
    const challenge = await api('/api/auth/challenge', { address: chainClient.wallet.account, chainId: 1 });
    const signature = await chainClient.wallet.signLogin(challenge.message);
    hostedSession = { ...await api('/api/auth/verify', { id: challenge.id, signature }), mode: 'production', authenticated: true };
    await init();
  } catch (error) { renderSignIn(error.message); }
  finally { button.disabled = false; }
}
async function signOut() {
  if (hostedSession?.authenticated) await api('/api/auth/logout', {});
  hostedSession = { mode: 'production', authenticated: false }; chainClient?.wallet.disconnect(); renderSignIn();
}
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-signin') || button.id === 'wallet-control' && !hostedSession?.authenticated) signIn(button);
  else if (button.id === 'wallet-control') signOut().catch(error => toast(error.message));
});
function runtimeSettings(p) {
  return `<details class="runtime-settings"><summary>Model & spending limits</summary><form id="settings-form"><label>Inference model<select name="model" id="project-model"><option value="${esc(p.model)}">${esc(p.model)}</option></select></label><p id="model-status" class="hint">Reading the model catalog…</p><div class="form-row"><label>Total ($)<input name="total" type="number" min="0.01" step="0.01" max="1000" value="${p.policy.total / 1e6}" required></label><label>Daily ($)<input name="daily" type="number" min="0.01" step="0.01" max="1000" value="${p.policy.daily / 1e6}" required></label><label>Per call ($)<input name="request" type="number" min="0.01" step="0.01" max="1000" value="${p.policy.request / 1e6}" required></label></div><button type="submit" class="button secondary">Save limits</button><p class="hint">Limits are maximum authorized usage, not deposited funds. Existing reservations stay counted.</p></form></details>`;
}
async function loadProjectModels(id) {
  try {
    const list = await api(state.hosted ? `/api/projects/${id}/models` : '/api/models');
    if (selected !== id || !$('project-model')) return;
    const current = state.projects.find(p => p.id === id)?.model;
    $('project-model').innerHTML = list.length ? list.map(m => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.id)} · ${money(m.oa_request_limit_micro_usd)} cap${m.oa_accounting_margin_micro_usd ? ` + ${(m.oa_accounting_margin_micro_usd / 1e6).toFixed(3)} USD reserve` : ''}</option>`).join('') : '<option value="pending">Awaiting model catalog</option>';
    $('model-status').textContent = list.length ? 'Catalog from this agent’s inference provider.' : 'The dedicated inference service is starting. Reopen this tab to refresh.';
  } catch (error) { if (selected === id && $('model-status')) $('model-status').textContent = error.message; }
}
function hostedTreasury(p) {
  return `<section class="panel"><h2>Operating treasury</h2><p class="subtext">${p.mainnet ? 'Verified Ethereum market' : 'Ethereum market setup'}</p>${p.mainnet ? `<label>Treasury</label><div class="address">${esc(p.mainnet.treasury)}</div>` : '<p>Your market launch creates its token, permanent liquidity vault and operating treasury together. Review the exact terms in the Market tab.</p>'}<div class="fee-legend"><div><b>70%</b><strong>Agent treasury</strong></div><div><b>20%</b><strong>Creator</strong></div><div><b>10%</b><strong>Platform</strong></div></div><p class="hint">Shares of collected trading fees. Treasury ETH and the inference note are separate balances; a funding operation connects them.</p></section><div id="runway-panel">Reading treasury runway…</div><details class="hosted-funding-details"><summary>Inference funding · deposits & activation</summary>${renderFundingPanel(p)}</details>`;
}
function renderHostedTools() {
  const items = [
    ['zkAPI inference', 'Per-agent runtime', 'Each agent uses a dedicated daemon, wallet state and model catalog. Fund its inference balance before running paid tasks.'],
    ['Persistent memory', 'Encrypted storage', 'Notes, sources and deliverables survive restarts and stay in your wallet-owned workspace. The operator can decrypt hosted state.'],
    ['Source reader', 'Available', 'Fetch bounded public documents from the supported domains, then include them in your agent’s task.'],
    ['Scheduled tasks', 'Available', 'The worker runs scheduled jobs with daily and total limits. Budget or service failures pause the schedule.'],
    ['Ethereum markets', 'Wallet transaction review', 'Inspect market terms, balances and exact wallet transactions. Confirmed deployments and trades are checked against Ethereum receipts.'],
    ['Social accounts', 'Project connections', 'Connect X or a Telegram bot in an agent’s Connections tab. Review exact drafts before publishing; server publishing must also be enabled.']
  ];
  return `<section class="overview-head"><div><p class="eyebrow">A CAPABLE WORKSPACE</p><h1>Tools, with clear boundaries.</h1><p>Funding and model settings live in each agent’s workspace.</p></div></section><div class="tool-grid">${items.map(([name, status, detail]) => `<article class="tool"><h3>${name}</h3><span class="tool-state">${status}</span><p>${detail}</p></article>`).join('')}</div>`;
}
async function loadMainnetPanel(p) {
  const element = $('mainnet-panel'), generation = mainnetPanelGeneration; if (!element || !p) return;
  try {
    const { mountMainnetPanel } = await import('/mainnet-panel.js');
    if (generation !== mainnetPanelGeneration || $('mainnet-panel') !== element || !state || (view === 'platform' ? p.id !== 'platform-market' : selected !== p.id)) return;
    mainnetPanel = mountMainnetPanel(element, { project: p, api, client: chainClient, capabilities: state.capabilities, notify: toast, onChange: () => refresh() });
  } catch (error) { element.textContent = error.message; }
}
async function loadSocialPanel(p) {
  const element = $('social-panel'), generation = socialPanelGeneration, hosted = state?.hosted === true;
  if (!element || !p) return;
  try {
    const { mountSocialPanel } = await import('/social-panel.js');
    if (generation !== socialPanelGeneration || selected !== p.id || $('social-panel') !== element || !state) return;
    socialPanel = mountSocialPanel(element, { project: p, hosted, api, notify: toast });
  } catch (error) { if (generation === socialPanelGeneration && $('social-panel') === element) element.textContent = error.message; }
}

async function loadRunwayPanel(p) {
  const element = $('runway-panel'), generation = runwayPanelGeneration;
  if (!element || !p || !state?.hosted) return;
  try {
    const { mountRunwayPanel } = await import('/runway-panel.js');
    if (generation !== runwayPanelGeneration || selected !== p.id || $('runway-panel') !== element || !state?.hosted) return;
    runwayPanel = mountRunwayPanel(element, { project: p, owner: state.wallet || hostedSession.address, hosted: true, api, client: chainClient, capabilities: state.capabilities, notify: toast });
  } catch (error) { if (generation === runwayPanelGeneration && $('runway-panel') === element) element.textContent = error.message; }
}

async function loadDeveloperPanel(p) {
  const element = $('developer-panel'), generation = developerPanelGeneration;
  if (!element || !p) return;
  try {
    const { mountDeveloperPanel } = await import('/developer-panel.js');
    if (generation !== developerPanelGeneration || selected !== p.id || $('developer-panel') !== element || !state) return;
    developerPanel = mountDeveloperPanel(element, { project: p, hosted: state.hosted === true, api, notify: toast });
  } catch (error) { if (generation === developerPanelGeneration && $('developer-panel') === element) element.textContent = error.message; }
}

async function loadResearchPanel(p) {
  const element = $('research-panel'), generation = researchPanelGeneration;
  if (!element || !p) return;
  try {
    const { mountResearchPanel } = await import('/research-panel.js');
    if (generation !== researchPanelGeneration || selected !== p.id || $('research-panel') !== element || !state) return;
    researchPanel = mountResearchPanel(element, { project: p, hosted: state.hosted === true, mode: state.mode, api, notify: toast });
  } catch (error) { if (generation === researchPanelGeneration && $('research-panel') === element) element.textContent = error.message; }
}
