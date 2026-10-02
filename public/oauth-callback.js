const status = document.querySelector('#status');
const query = new URLSearchParams(location.search), code = query.get('code'), state = query.get('state'), rejected = query.get('error');
history.replaceState(null, '', '/oauth/x');
async function complete() {
  if (rejected) throw new Error('X authorization was not completed. You can reconnect from your project.');
  if (!code || !state || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('This authorization link is invalid or incomplete. Reconnect from your project.');
  const sessionResponse = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
  if (!sessionResponse.ok) throw new Error('The Veyl runtime is unavailable. Reconnect when it is online.');
  const session = await sessionResponse.json();
  if (!session.authenticated) throw new Error('Sign in to Veyl with the wallet that started this connection, then reconnect X.');
  const projectId = state.split('.')[0];
  const response = await fetch(`/api/projects/${projectId}/social/x-complete`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-agent-csrf': session.csrf }, body: JSON.stringify({ state, code }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'The X connection could not be confirmed.');
  status.textContent = 'Your X account is connected. Returning to Veyl…'; location.replace(`/app#view=project&id=${encodeURIComponent(projectId)}&tab=connections`);
}
complete().catch(error => { status.textContent = error.message; });
