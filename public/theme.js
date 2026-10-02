/* Apply the saved choice before page content paints. Light is the default. */
(() => {
  const key = 'veyl:theme';
  const root = document.documentElement;
  let choice = 'light';
  try { if (localStorage.getItem(key) === 'dark') choice = 'dark'; } catch {}
  root.dataset.theme = choice;

  function mount() {
    if (document.querySelector('.veyl-theme-control')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'veyl-theme-control';
    button.setAttribute('aria-label', 'Dark theme');
    button.innerHTML = '<svg class="theme-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/></svg><svg class="theme-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    const sync = () => {
      const dark = root.dataset.theme === 'dark';
      button.setAttribute('aria-pressed', String(dark));
      button.dataset.tip = dark ? 'Switch to light theme' : 'Switch to dark theme';
      button.title = button.dataset.tip;
    };
    button.addEventListener('click', () => {
      choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = choice;
      try { localStorage.setItem(key, choice); } catch {}
      sync();
    });
    window.addEventListener('storage', event => {
      if (event.key !== key && event.key !== null) return;
      root.dataset.theme = event.key === key && event.newValue === 'dark' ? 'dark' : 'light';
      sync();
    });
    sync();
    document.body.append(button);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
