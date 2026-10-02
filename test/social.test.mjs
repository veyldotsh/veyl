import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialService } from '../src/social.mjs';
import { encryptedCodec } from '../src/encrypted-state.mjs';

const OWNER = '0x1111111111111111111111111111111111111111', PROJECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TIME = 1_800_000_000_000;
const TOKEN = '123456:' + 'offline_bot_fixture_'.repeat(3), ACCESS = 'offline-x-access-token', REFRESH = 'offline-x-refresh-token', CHAT = '-100123456';
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-social-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 7), file = join(dir, 'social.sealed.json'), calls = []; let clock = TIME, intercept;
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'error'); const u = new URL(url);
    const body = init.body ? init.headers['Content-Type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body) : undefined;
    const call = { url: u, method: init.method, headers: init.headers, body }; calls.push(call);
    const custom = await intercept?.(call); if (custom) return custom;
    let result;
    if (u.href === 'https://api.x.com/2/oauth2/token') result = { token_type: 'bearer', access_token: ACCESS, refresh_token: REFRESH, expires_in: 7200, scope: 'tweet.read tweet.write users.read offline.access' };
    else if (u.href === 'https://api.x.com/2/users/me') { assert.equal(init.headers.Authorization, 'Bearer ' + ACCESS); result = { data: { id: '1234', username: 'VeylFixture' } }; }
    else if (u.href === 'https://api.x.com/2/tweets') { assert.equal(init.headers.Authorization, 'Bearer ' + ACCESS); result = { data: { id: '98765', text: body.text } }; }
    else if (u.origin === 'https://api.telegram.org') {
      assert.ok(u.pathname.startsWith('/bot' + TOKEN + '/'));
      if (u.pathname.endsWith('/getMe')) result = { ok: true, result: { id: 123456, username: 'veyl_fixture_bot', is_bot: true } };
      else if (u.pathname.endsWith('/getChat')) result = { ok: true, result: { id: Number(CHAT), type: 'channel', title: 'Fixture channel' } };
      else if (u.pathname.endsWith('/getChatMember')) result = { ok: true, result: { status: 'administrator', can_post_messages: true, user: { id: 123456 } } };
      else if (u.pathname.endsWith('/sendMessage')) result = { ok: true, result: { message_id: 77, chat: { id: Number(CHAT) }, text: body.text } };
      else assert.fail(u.href);
    } else assert.fail(u.href);
    return new Response(JSON.stringify(result));
  };
  const config = { file, key, owner: OWNER, projectId: PROJECT, x: { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'https://veyl.sh/oauth/x' }, fetcher, now: () => clock, allowPublishing: true, ...options };
  return { service: new SocialService(config), config, file, calls, restart: () => new SocialService(config), setClock: value => { clock = value; }, intercept: fn => { intercept = fn; },
    state: () => encryptedCodec(key, `social:${OWNER}:${PROJECT}`).decode(readFileSync(file, 'utf8')) };
}
async function connectX(f) { const auth = await f.service.beginX(); return f.service.completeX({ state: auth.state, code: 'offline-authorization-code' }); }
const draft = (service, channel = 'x') => service.draft({ channel, text: 'A reviewed Veyl post.', idempotencyKey: 'fixture-draft-1', madeWithAi: true });
const approve = item => ({ intentId: item.id, approvalDigest: item.approvalDigest });

test('X PKCE binds wallet/project, exact callback, state expiry and single-use token exchange', async t => {
  const f = fixture(t), begun = await f.service.beginX(), url = new URL(begun.authorizationUrl);
  assert.equal(url.origin, 'https://x.com'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('redirect_uri'), 'https://veyl.sh/oauth/x'); assert.equal(begun.state.split('.')[0], PROJECT);
  const privateState = f.state(); assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(privateState.oauth[0].verifier).digest('base64url'));
  await assert.rejects(f.service.completeX({ state: 'another-project.random', code: 'test' }), e => e.status === 409); assert.equal(f.calls.length, 0);
  const account = await f.service.completeX({ state: begun.state, code: 'offline-code' }); assert.equal(account.username, 'VeylFixture');
  assert.equal(f.calls[0].body.code_verifier, privateState.oauth[0].verifier); assert.equal(f.calls[0].headers.Authorization, 'Basic ' + Buffer.from('fixture-client:fixture-secret').toString('base64'));
  await assert.rejects(f.service.completeX({ state: begun.state, code: 'offline-code' }), e => e.status === 409); assert.equal(f.calls.length, 2);
});

test('social credentials stay encrypted and absent from public snapshots or other wallet/project contexts', async t => {
  const f = fixture(t); await connectX(f); await f.service.connectTelegram({ token: TOKEN, chatId: CHAT });
  const raw = readFileSync(f.file, 'utf8'), publicData = JSON.stringify([f.service, f.service.snapshot()]);
  for (const secret of [TOKEN, ACCESS, REFRESH, 'fixture-secret']) { assert.equal(raw.includes(secret), false); assert.equal(publicData.includes(secret), false); }
  assert.throws(() => new SocialService({ ...f.config, owner: '0x2222222222222222222222222222222222222222' }), /original key/);
  assert.throws(() => new SocialService({ ...f.config, projectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }), /original key/);
});

test('social drafting does not publish; exact human digest sends once and persists before request', async t => {
  const f = fixture(t); await connectX(f); const item = await draft(f.service);
  assert.equal(item.status, 'draft'); assert.equal(f.calls.some(c => c.url.pathname === '/2/tweets'), false);
  await assert.rejects(f.service.publish({ ...approve(item), approvalDigest: '0'.repeat(64) }), e => e.status === 409);
  f.intercept(call => { if (call.url.pathname === '/2/tweets') { assert.equal(f.state().outbox[0].status, 'sending'); assert.deepEqual(call.body, { text: item.preview.text }); } });
  const sent = await f.service.publish(approve(item)); assert.equal(sent.status, 'published'); assert.equal(sent.result.url, 'https://x.com/i/status/98765');
  await f.service.publish(approve(item)); await f.restart().publish(approve(item)); assert.equal(f.calls.filter(c => c.url.pathname === '/2/tweets').length, 1);
});

test('unknown social publication is never retried after lost response or restart', async t => {
  const f = fixture(t); await connectX(f); const item = await draft(f.service);
  f.intercept(call => { if (call.url.pathname === '/2/tweets') throw new Error('provider may have published'); });
  await assert.rejects(f.service.publish(approve(item)), /may have succeeded/);
  assert.equal(f.service.snapshot().outbox[0].status, 'unknown'); await f.restart().publish(approve(item)); assert.equal(f.calls.filter(c => c.url.pathname === '/2/tweets').length, 1);
});

test('X refresh rotates privately before publishing and unknown refresh requires reconnect', async t => {
  const f = fixture(t); await connectX(f); const item = await draft(f.service); f.setClock(TIME + 7_200_000);
  await f.service.publish(approve(item));
  const refreshed = f.calls.filter(c => c.url.pathname === '/2/oauth2/token'); assert.equal(refreshed.length, 2); assert.equal(refreshed[1].body.grant_type, 'refresh_token'); assert.equal(refreshed[1].body.refresh_token, REFRESH);
  const g = fixture(t); await connectX(g); const other = await draft(g.service); g.setClock(TIME + 7_200_000);
  g.intercept(call => { if (call.url.pathname === '/2/oauth2/token') throw new Error('lost refresh'); });
  await assert.rejects(g.service.publish(approve(other))); assert.equal(g.service.snapshot().accounts.x.status, 'reconnect_required'); assert.equal(g.calls.some(c => c.url.pathname === '/2/tweets'), false);
});

test('Telegram checks exact bot/chat permissions then publishes literal approved text to that chat', async t => {
  const f = fixture(t); await f.service.connectTelegram({ token: TOKEN, chatId: CHAT }); const item = await draft(f.service, 'telegram');
  assert.deepEqual(f.calls.map(c => c.url.pathname.split('/').at(-1)), ['getMe', 'getChat', 'getChatMember']);
  const result = await f.service.publish(approve(item)); assert.equal(result.result.chatId, CHAT);
  assert.deepEqual(f.calls.at(-1).body, { chat_id: CHAT, text: item.preview.text, link_preview_options: { is_disabled: true } });
  assert.equal(f.calls.at(-1).body.parse_mode, undefined);
});

test('Telegram refuses insufficient posting rights and sanitizes token-bearing failures', async t => {
  const f = fixture(t); f.intercept(call => call.url.pathname.endsWith('/getChatMember') ? new Response(JSON.stringify({ ok: true, result: { status: 'member', user: { id: 123456 } } })) : undefined);
  await assert.rejects(f.service.connectTelegram({ token: TOKEN, chatId: CHAT }), /administrator/); assert.equal(f.service.snapshot().accounts.telegram, null);
  const g = fixture(t); g.intercept(() => { throw new Error('sensitive URL /bot' + TOKEN); });
  await assert.rejects(g.service.connectTelegram({ token: TOKEN, chatId: CHAT }), error => !error.message.includes(TOKEN));
});

test('publishing gates, stale-account preview and idempotency protect the outbox', async t => {
  const f = fixture(t, { allowPublishing: false }); await connectX(f); const item = await draft(f.service);
  await assert.rejects(f.service.publish(approve(item)), e => e.status === 403);
  await assert.rejects(f.service.draft({ channel: 'x', text: 'Changed', idempotencyKey: 'fixture-draft-1' }), e => e.status === 409);
  const g = fixture(t); await connectX(g); const old = await draft(g.service); await connectX(g);
  await assert.rejects(g.service.publish(approve(old)), /changed/); await g.service.disconnect({ channel: 'x' }); assert.equal(g.service.snapshot().outbox[0].status, 'cancelled');
});

test('stale social process fails closed instead of overwriting newer tokens', async t => {
  const f = fixture(t), stale = f.restart(); await connectX(f);
  await assert.rejects(stale.beginX(), /another process/); assert.equal(f.calls.length, 2);
});

test('X draft validation follows official URL, NFC and combined-emoji weights without changing approved text', async t => {
  const f = fixture(t); await connectX(f);
  const accepted = ['a'.repeat(256) + ' https://x.co', 'https://example.com/' + 'a'.repeat(300), 'e\u0301'.repeat(280), 'Ā'.repeat(280), '👨‍👩‍👧‍👦'.repeat(140)];
  for (const [index, text] of accepted.entries()) {
    const item = await f.service.draft({ channel: 'x', text, idempotencyKey: 'accepted-text-' + index });
    assert.equal(item.preview.text, text); assert.equal(item.preview.madeWithAi, true);
  }
  const denied = ['a'.repeat(257) + ' https://x.co', '👨‍👩‍👧‍👦'.repeat(141), 'a'.repeat(281), '\uFEFF'];
  for (const [index, text] of denied.entries()) await assert.rejects(f.service.draft({ channel: 'x', text, idempotencyKey: 'denied-text-' + index }), /280 weighted|Choose/);
  assert.equal(f.calls.some(call => call.url.pathname === '/2/tweets'), false);
});
