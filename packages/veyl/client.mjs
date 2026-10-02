const TOKEN = /^veyl_sk_[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RESPONSE = 1024 * 1024;
const clean = (value, token) => String(value || '').replaceAll(token, '[redacted]').replace(/veyl_sk_[a-f0-9]{64}/gi, '[redacted]').slice(0, 500);

export class VeylApiError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED', requestId, uncertain = false } = {}) {
    super(message); this.name = 'VeylApiError'; this.status = status; this.code = code;
    this.requestId = requestId; this.uncertain = uncertain;
  }
}

/** No retries, browser credential storage or wallet signing. Tokens bind one project. */
export class VeylClient {
  #token; #fetch; #base; #timeout;
  constructor({ token, baseUrl = 'https://veyl.sh', timeoutMs = 30000, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!TOKEN.test(token || '')) throw new TypeError('A valid project-scoped Veyl API token is required.');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new TypeError('baseUrl must be an HTTPS origin, or loopback HTTP for tests.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || typeof fetchImpl !== 'function') throw new TypeError('Use a fetch implementation and a timeout of 1 to 120000 milliseconds.');
    this.#token = token; this.#base = url.origin; this.#timeout = timeoutMs; this.#fetch = fetchImpl;
  }
  async #request(path, body) {
    const mutation = body !== undefined, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    let response;
    try {
      response = await this.#fetch(`${this.#base}/api/developer/v1/${path}`, {
        method: mutation ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
        ...(mutation ? { body: JSON.stringify(body) } : {})
      });
      const requestId = /^[A-Za-z0-9_-]{1,128}$/.test(response.headers.get('x-request-id') || '') ? response.headers.get('x-request-id') : undefined;
      const reader = response.body?.getReader(); let raw = '', bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_RESPONSE) throw Error('Response too large'); raw += decoder.decode(value, { stream: true }); } raw += decoder.decode(); }
        finally { await reader.cancel().catch(() => {}); }
      }
      let result; try { result = JSON.parse(raw); } catch { throw new VeylApiError('Veyl returned an invalid response. Inspect the project before repeating a mutation.', { status: response.status, code: 'INVALID_RESPONSE', requestId, uncertain: mutation }); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new VeylApiError('Veyl returned an invalid response.', { status: response.status, code: 'INVALID_RESPONSE', requestId, uncertain: mutation });
      if (!response.ok) throw new VeylApiError(clean(result.error || 'The Veyl request was rejected.', this.#token), { status: response.status, code: /^[A-Z0-9_]{1,64}$/.test(result.code || '') ? result.code : 'REQUEST_REJECTED', requestId, uncertain: mutation && (response.status >= 500 || response.status === 408) });
      return result;
    } catch (error) {
      if (error instanceof VeylApiError) throw error;
      throw new VeylApiError(controller.signal.aborted ? 'Veyl request timed out. Inspect the project before repeating a mutation.' : 'Veyl could not confirm the request outcome. Inspect the project before repeating a mutation.', { code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', status: response?.status || 0, uncertain: mutation });
    } finally { clearTimeout(timer); }
  }
  project() { return this.#request('project'); }
  models() { return this.#request('models'); }
  jobs({ requestKey } = {}) { if (requestKey !== undefined) key(requestKey); return this.#request('jobs' + (requestKey === undefined ? '' : '?requestKey=' + encodeURIComponent(requestKey))); }
  job(id) { if (!ID.test(id || '')) throw new TypeError('Invalid job ID.'); return this.#request(`jobs/${encodeURIComponent(id)}`); }
  submitJob({ requestKey, prompt } = {}) { key(requestKey); text(prompt, 8000, 'prompt'); return this.#request('jobs', { requestKey, prompt }); }
  memory() { return this.#request('memory'); }
  saveMemory({ requestKey, content } = {}) { key(requestKey); text(content, 8000, 'content'); return this.#request('memory', { requestKey, content }); }
  drafts() { return this.#request('drafts'); }
  prepareDraft({ channel, text: content, idempotencyKey, madeWithAi = true } = {}) {
    if (!['x', 'telegram'].includes(channel) || typeof madeWithAi !== 'boolean') throw new TypeError('Choose x or telegram and a boolean madeWithAi value.');
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new TypeError('Use an 8 to 128 character draft key containing letters, digits, underscore or hyphen.'); text(content, channel === 'x' ? 280 : 4096, 'text');
    return this.#request('drafts', { channel, text: content, idempotencyKey, madeWithAi });
  }
}
function key(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(value)) throw new TypeError('Use an 16 to 80 character request key containing letters, digits or hyphen; a UUID is recommended.'); }
function text(value, maximum, name) { if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new TypeError(`${name} must contain 1 to ${maximum} characters.`); }
