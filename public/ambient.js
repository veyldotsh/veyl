const preferenceKey = 'veyl:background-motion';

// CSS owns the animation. JavaScript only remembers the preference and pauses hidden tabs.
export function mountAmbientMotion(doc = globalThis.document, win = globalThis.window) {
  if (!doc?.body || !win || doc.querySelector('.veyl-motion-control')) return;
  const root = doc.documentElement;
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  let preference = null;
  try { preference = win.localStorage.getItem(preferenceKey); } catch { /* Motion controls also work without storage. */ }
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'veyl-motion-control';
  button.setAttribute('aria-label', 'Background motion');
  button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g class="motion-stop"><rect x="4" y="3" width="2.5" height="10" rx=".7"/><rect x="9.5" y="3" width="2.5" height="10" rx=".7"/></g><path class="motion-start" d="M5 2.8a.5.5 0 0 1 .76-.42l7.1 5.2a.5.5 0 0 1 0 .84l-7.1 5.2A.5.5 0 0 1 5 13.2Z"/></svg>';
  function update() {
    const paused = reduced.matches || preference === 'paused';
    root.dataset.veylMotion = paused ? 'paused' : 'active';
    button.setAttribute('aria-pressed', String(!paused));
    button.disabled = reduced.matches;
    const tip = reduced.matches ? 'Reduced motion is on in your device settings' : paused ? 'Resume background motion' : 'Pause background motion';
    button.title = tip;
    button.dataset.tip = tip;
  }
  function visibility() {
    if (doc.hidden) root.dataset.veylInactive = '';
    else delete root.dataset.veylInactive;
  }
  button.addEventListener('click', () => {
    if (reduced.matches) return;
    preference = preference === 'paused' ? 'active' : 'paused';
    try { win.localStorage.setItem(preferenceKey, preference); } catch { /* Session-only fallback. */ }
    update();
  });
  win.addEventListener('storage', event => {
    if (event.key === preferenceKey || event.key === null) { preference = event.newValue; update(); }
  });
  reduced.addEventListener('change', update);
  doc.addEventListener('visibilitychange', visibility);
  update(); visibility(); doc.body.append(button);
  return button;
}

if (typeof document !== 'undefined') mountAmbientMotion();
