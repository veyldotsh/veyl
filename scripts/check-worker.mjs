const origin = new URL(process.env.VEYL_HEALTH_ORIGIN || 'http://127.0.0.1:4320');
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/') throw new Error('Health checks require the local worker origin.');
const health = await fetch(origin + 'healthz', { redirect: 'error', signal: AbortSignal.timeout(5000) });
const result = await health.json();
if (!health.ok || result.status !== 'ok' || result.service !== 'veyl-runtime') throw new Error('Worker health is blocked.');
const privateRoute = await fetch(origin + 'api/state', { redirect: 'error', signal: AbortSignal.timeout(5000) });
if (privateRoute.status !== 403) throw new Error('Private gateway boundary failed.');
console.log('Worker healthy; unauthenticated private API rejected.');
