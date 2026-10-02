import { Problem } from './agent.mjs';
export const SOURCE_HOSTS = ['ethereum.org', 'blog.ethereum.org', 'docs.base.org', 'github.com', 'raw.githubusercontent.com', 'zkapi.openanonymity.ai'];
export async function readSource(raw, { fetcher = fetch } = {}) {
  let url; try { url = new URL(raw); } catch { throw new Problem('Invalid source URL.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !SOURCE_HOSTS.includes(url.hostname)) throw new Problem('Source must use HTTPS on one of the reviewed public domains.');
  try {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'text/html,text/plain,application/json' } });
  if (!response.ok || !/text\/|application\/json/.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw new Problem('Source did not return a readable document.', 502); }
  let size = 0; const chunks = []; const reader = response.body.getReader();
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 500_000) { await reader.cancel(); throw new Problem('Source exceeds 500 KB.', 413); } chunks.push(value); }
  const rawText = Buffer.concat(chunks).toString('utf8');
  const text = (/text\/html/i.test(response.headers.get('content-type')) ? rawText.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ') : rawText).replace(/\s+/g, ' ').trim().slice(0, 20_000);
  if (!text) throw new Problem('Source returned no readable text.', 502);
  return { url: url.href, text, fetchedAt: new Date().toISOString() };
  } catch (error) { throw error instanceof Problem ? error : new Problem('Source could not be read. Redirects and automatic retries are disabled.', 502); }
}
