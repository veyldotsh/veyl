const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const date = value => Number.isFinite(+new Date(value)) ? new Date(value).toLocaleString() : 'Date unavailable';
export function mountNotificationPanel(element, { api, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let live = true, reading = false, busy = false, data = null, error = '';
  function render() {
    if (!live) return;
    element.innerHTML = `<section class="panel notification-panel"><div class="section-title"><div><h2>Notifications${data?.unread ? ` <span class="count">${data.unread}</span>` : ''}</h2><p>Updates that need your attention, in this workspace.</p></div><div class="notification-actions"><button class="text-link" data-notification="refresh" ${reading || busy ? 'disabled' : ''}>Refresh</button>${data?.unread ? `<button class="text-link" data-notification="all" ${busy ? 'disabled' : ''}>Mark all read</button>` : ''}</div></div>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${data ? data.notifications.length ? data.notifications.slice(0, 30).map(item => `<article class="notification-item ${item.readAt ? '' : 'unread'}"><div><strong>${esc(item.title)}</strong><p>${esc(item.message)}</p><time>${esc(date(item.at))}</time></div><div class="notification-actions">${item.projectId ? `<button class="text-link" data-project="${esc(item.projectId)}">Open agent →</button>` : ''}${!item.readAt ? `<button class="text-link" data-notification="read" data-notification-id="${esc(item.id)}" ${busy ? 'disabled' : ''}>Mark read</button>` : ''}</div></article>`).join('') : '<p class="hint">You are caught up. Agent updates will appear here.</p>' : '<p class="hint">Reading your notifications…</p>'}</section>`;
  }
  async function refresh() {
    if (!live || reading) return; reading = true;
    try {
      const result = await api('/api/notifications'); if (!live) return;
      if (!result || !Array.isArray(result.notifications) || result.notifications.length > 1000 || !Number.isSafeInteger(result.unread) || result.unread < 0 || result.notifications.some(item => typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.message !== 'string')) throw Error('Notification history could not be verified.');
      data = result; error = '';
    } catch (failure) { if (live) error = failure.message || 'Notifications are temporarily unavailable.'; }
    finally { reading = false; render(); }
  }
  async function click(event) {
    const button = event.target.closest('[data-notification]'); if (!button || !element.contains(button) || button.disabled || busy) return;
    if (button.dataset.notification === 'refresh') return refresh();
    const id = button.dataset.notification === 'all' ? 'all' : button.dataset.notificationId;
    if (id !== 'all' && !data?.notifications.some(item => item.id === id)) return;
    busy = true; render();
    try { await api('/api/notifications/ack', { id }); if (live) await refresh(); }
    catch (failure) { if (live) error = failure.message || 'The read status could not be saved.'; }
    finally { busy = false; render(); }
  }
  render(); element.addEventListener('click', click); const ready = refresh();
  const timer = setTimer(() => { if (live && !busy && !globalThis.document?.hidden) return refresh(); }, 30000);
  return { ready, refresh, destroy() { live = false; clearTimer(timer); element.removeEventListener('click', click); element.innerHTML = ''; data = null; } };
}
