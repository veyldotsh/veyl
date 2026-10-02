// Keep native disclosure controls usable without JavaScript; enhance topic links.
const topics = [...document.querySelectorAll('details.docs-topic')];
const navLinks = [...document.querySelectorAll('.docs-nav a[href^="#"]')];
function showTopic(hash, focus = false) {
  const selected = topics.find(topic => '#' + topic.id === hash);
  if (!selected) return;
  for (const topic of topics) topic.open = topic === selected;
  for (const link of navLinks) {
    if (link.hash === hash) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  if (focus) selected.querySelector('summary').focus({ preventScroll: true });
  selected.scrollIntoView({ block: 'start', behavior: 'instant' });
}
for (const link of navLinks) link.addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (location.hash !== link.hash) history.pushState(null, '', link.hash);
  showTopic(link.hash, true);
});
for (const topic of topics) topic.addEventListener('toggle', () => {
  const current = topics.find(item => item.open);
  for (const link of navLinks) {
    if (current && link.hash === '#' + current.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
});
window.addEventListener('hashchange', () => showTopic(location.hash));
window.addEventListener('popstate', () => {
  if (location.hash) showTopic(location.hash);
  else { for (const topic of topics) topic.open = false; for (const link of navLinks) link.removeAttribute('aria-current'); }
});
showTopic(location.hash);
