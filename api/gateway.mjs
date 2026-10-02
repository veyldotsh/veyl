import { createHash, randomUUID } from 'node:crypto';
import { signGateway } from '../src/gateway-auth.mjs';

export const config = { maxDuration: 60 };
export default async function gateway(req, res) {
  const requestId = randomUUID(); res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (status, message) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: message, code: { 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 413: 'REQUEST_TOO_LARGE', 414: 'QUERY_TOO_LONG', 502: 'UPSTREAM_UNAVAILABLE', 503: 'SERVICE_UNAVAILABLE' }[status] || 'INVALID_REQUEST', requestId })); };
  try {
    const publicOrigin = new URL(process.env.PUBLIC_ORIGIN || 'https://veyl.sh');
    if (publicOrigin.protocol !== 'https:' || publicOrigin.pathname !== '/' || publicOrigin.username || publicOrigin.password || publicOrigin.search || publicOrigin.hash) return fail(503, 'Invalid public service configuration.');
    if (req.headers.host !== publicOrigin.host || (req.headers.origin && req.headers.origin !== publicOrigin.origin) || req.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Same-origin access required.');
    if (!['GET', 'POST'].includes(req.method)) return fail(405, 'Method not allowed.');
    const incoming = new URL(req.url, publicOrigin), route = incoming.searchParams.get('veyl_path');
    const pathname = route !== null ? '/api/' + route : incoming.pathname;
    if (incoming.searchParams.getAll('veyl_path').length > 1 || !/^\/api\/[a-zA-Z0-9/_-]{1,200}$/.test(pathname) || pathname.includes('//') || pathname === '/api/gateway') return fail(404, 'Not found.');
    // Vercel also forwards the named :path* capture from vercel.json as a
    // query parameter. Consume only the exact matching routing metadata;
    // genuine API queries still reach the worker's strict validation.
    if (route !== null && incoming.searchParams.has('path')) {
      const captures = incoming.searchParams.getAll('path');
      if (captures.length !== 1 || captures[0] !== route) return fail(404, 'Not found.');
      incoming.searchParams.delete('path');
    }
    const developerPath = pathname.startsWith('/api/developer/v1/'), bearer = req.headers.authorization;
    if (bearer !== undefined && (!developerPath || req.headers.origin || req.headers.cookie)) return fail(403, 'Developer credentials require a server-to-server developer endpoint.');
    if (developerPath && (typeof bearer !== 'string' || !/^Bearer veyl_sk_[a-f0-9]{64}$/.test(bearer))) return fail(401, 'A developer bearer key is required.');
    if (req.method === 'POST' && !developerPath && req.headers.origin !== publicOrigin.origin) return fail(403, 'Same-origin access required.');
    incoming.searchParams.delete('veyl_path');
    const query = incoming.searchParams.toString(); if (query.length > 8000) return fail(414, 'Query too long.');
    const path = pathname + (query ? '?' + query : '');
    if (!process.env.VEYL_RUNTIME_ORIGIN || !process.env.VEYL_GATEWAY_KEY) return fail(503, 'The hosted agent runtime is not connected yet. No agent work or transactions were started.');
    const worker = new URL(process.env.VEYL_RUNTIME_ORIGIN);
    if (worker.protocol !== 'https:' || worker.pathname !== '/' || worker.username || worker.password || worker.search || worker.hash) return fail(503, 'Invalid runtime service configuration.');
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 40_000) return fail(413, 'Request too large.'); chunks.push(Buffer.from(chunk)); }
    // Vercel may parse the body before invoking plain Node functions.
    const body = chunks.length ? Buffer.concat(chunks) : req.body === undefined ? Buffer.alloc(0) : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (body.length > 40_000) return fail(413, 'Request too large.');
    const headers = {};
    for (const name of ['content-type', 'cookie', 'origin', 'x-agent-csrf']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    if (developerPath) headers.authorization = bearer;
    // The hosting edge overwrites this header. Hashing avoids storing raw IPs.
    headers['x-veyl-client'] = createHash('sha256').update(String(req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown')).digest('hex');
    Object.assign(headers, signGateway({ key: process.env.VEYL_GATEWAY_KEY, method: req.method, path, headers, body }));
    const response = await fetch(worker.origin + path, { method: req.method, headers, body: req.method === 'POST' ? body : undefined, redirect: 'error', signal: AbortSignal.timeout(50_000) });
    res.statusCode = response.status;
    for (const name of ['content-type', 'content-disposition', 'x-request-id']) { const value = response.headers.get(name); if (value) res.setHeader(name, value); }
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies);
    if (!response.body) return res.end();
    const reader = response.body.getReader(); let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8_000_000) { await reader.cancel(); throw new Error('Runtime response too large'); } res.write(value); }
    res.end();
  } catch { if (res.headersSent) res.end(); else fail(502, 'The agent runtime could not be reached. No request is automatically retried.'); }
}
