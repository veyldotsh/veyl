import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { getAddress } from 'viem';
import { SealedState } from './encrypted-state.mjs';
import { Problem } from './agent.mjs';
import twitterText from 'twitter-text';

const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const CHANNELS = new Set(['x', 'telegram']);
const equivalent = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const appCredential = (value, max, optional = false) => typeof value === 'string' && value.length <= max && (optional && value === '' || /^[\x21-\x7e]+$/.test(value));
function clean(value, max = 512) { if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Problem('Provider returned invalid connection data.', 502); return value; }
function id(value) { const text = String(value); if (!/^[1-9][0-9]{0,20}$/.test(text)) throw new Problem('Provider returned an invalid account identifier.', 502); return text; }
function chatId(value) { if (typeof value !== 'string' || !/^-?[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Problem('Enter the exact numeric Telegram chat ID.'); return value; }
function publicAccount(account) {
  if (!account) return null;
  return { connectionId: account.connectionId, channel: account.channel, id: account.id, username: account.username || '', ...(account.channel === 'telegram' ? { chatId: account.chatId, chatTitle: account.chatTitle, chatType: account.chatType } : {}), connectedAt: account.connectedAt, status: account.status };
}

/** Text-only social connectors. Credentials, PKCE verifiers and outbox are
 * authenticated-encrypted at rest, separately scoped to wallet and project.
 * A generated draft never authorizes publication; publishing always requires
 * the human-reviewed exact digest. Unknown results never automatically retry. */
export class SocialService {
  #store; #owner; #projectId; #x; #fetch; #now; #publish; #busy = false; #diskHash;
  constructor({ file, key, owner, projectId, x = {}, fetcher = fetch, now = Date.now, allowPublishing = false } = {}) {
    this.#owner = getAddress(owner).toLowerCase();
    if (typeof projectId !== 'string' || !/^[a-f0-9-]{36}$/.test(projectId)) throw new Problem('Invalid social project identifier.');
    this.#projectId = projectId; this.#x = { ...x }; this.#fetch = fetcher; this.#now = now; this.#publish = allowPublishing === true;
    if (this.#x.redirectUri) { const url = new URL(this.#x.redirectUri); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Problem('X callback must be a fixed HTTPS URL without query parameters.'); }
    this.#store = new SealedState(file, key, `social:${this.#owner}:${projectId}`, { version: 1, owner: this.#owner, projectId, oauth: [], accounts: { x: null, telegram: null }, outbox: [] });
    this.#diskHash = createHash('sha256').update(readFileSync(file)).digest('hex');
    const s = this.#store.data;
    if (s.version !== 1 || s.owner !== this.#owner || s.projectId !== projectId || !Array.isArray(s.oauth) || !Array.isArray(s.outbox) || !s.accounts || s.oauth.length > 50 || s.outbox.length > 2000) throw new Problem('Invalid encrypted social state. Preserve it for recovery.', 503);
    if (s.xApp !== undefined && s.xApp !== null && (typeof s.xApp !== 'object' || Object.keys(s.xApp).some(key => !['clientId', 'clientSecret'].includes(key)) || !appCredential(s.xApp.clientId, 512) || !appCredential(s.xApp.clientSecret, 4096, true))) throw new Problem('Invalid encrypted X app settings. Preserve them for recovery.', 503);
    for (const entry of s.outbox) {
      if (!CHANNELS.has(entry.channel) || !['draft', 'sending', 'published', 'failed', 'unknown', 'cancelled'].includes(entry.status) || entry.approvalDigest !== digest(entry.preview)) throw new Problem('Invalid encrypted social outbox.', 503);
      if (entry.status === 'sending') entry.status = 'unknown';
    }
    for (const entry of s.oauth) if (entry.status === 'exchanging') entry.status = 'unknown';
    for (const account of Object.values(s.accounts)) if (account?.status === 'refreshing') account.status = 'reconnect_required';
    if (s.accounts.x && !equivalent(s.accounts.x.appBinding, this.#xBinding())) s.accounts.x.status = 'reconnect_required';
  }
  #exclusive(fn) {
    if (!this.#store.healthy) return Promise.reject(new Problem('Social credential persistence is blocked.', 503));
    if (this.#busy) return Promise.reject(new Problem('Another social operation is running.', 409));
    this.#busy = true; let lock;
    return Promise.resolve().then(() => {
      try { lock = openSync(this.#store.file + '.lock', 'wx', 0o600); } catch { throw new Problem('Social state is locked. Inspect recovery before removing a stale lock.', 409); }
      if (createHash('sha256').update(readFileSync(this.#store.file)).digest('hex') !== this.#diskHash) { this.#store.healthy = false; throw new Problem('Social state changed in another process. Reload it before continuing.', 503); }
      return fn();
    }).finally(() => { this.#busy = false; if (lock !== undefined) { try { closeSync(lock); unlinkSync(this.#store.file + '.lock'); } catch { this.#store.healthy = false; throw new Problem('Cannot release social state lock.', 503); } } });
  }
  #save() { try { this.#store.save(); this.#diskHash = createHash('sha256').update(readFileSync(this.#store.file)).digest('hex'); } catch { this.#store.healthy = false; throw new Problem('Cannot persist social authorization. Publishing is blocked.', 503); } }
  canEvict() { return !this.#busy; }
  #xApp() { return { ...(this.#store.data.xApp || this.#x), redirectUri: this.#x.redirectUri }; }
  #xBinding() { const app = this.#xApp(); return digest({ mode: this.#store.data.xApp ? 'custom' : 'platform', clientId: app.clientId || null, clientSecret: app.clientSecret || null, redirectUri: app.redirectUri || null }); }
  #publicXApp() { return { mode: this.#store.data.xApp ? 'custom' : 'platform', callbackUri: this.#x.redirectUri || null, platformAvailable: !!(this.#x.clientId && this.#x.redirectUri) }; }
  snapshot() { const app = this.#xApp(); return { projectId: this.#projectId, xConfigured: !!(app.clientId && app.redirectUri), xApp: this.#publicXApp(), publishingEnabled: this.#publish,
    accounts: Object.fromEntries(Object.entries(this.#store.data.accounts).map(([channel, account]) => [channel, publicAccount(account)])), outbox: this.#store.data.outbox.map(item => this.#publicIntent(item)) }; }
  #publicIntent(item) { return { id: item.id, channel: item.channel, status: item.status, preview: structuredClone(item.preview), approvalDigest: item.approvalDigest, createdAt: item.createdAt, expiresAt: item.expiresAt, ...(item.result ? { result: structuredClone(item.result) } : {}), ...(item.error ? { error: item.error } : {}) }; }
  async #request(url, { headers = {}, method = 'GET', body, form = false } = {}) {
    let response;
    try {
      response = await this.#fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { ...(body === undefined ? {} : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...headers }, body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
      if (!response.ok) { await response.body?.cancel(); const error = new Problem(`Social provider returned HTTP ${response.status}.`, 502); error.definiteFailure = response.status >= 400 && response.status < 500 && response.status !== 408; throw error; }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 131072) { await reader.cancel(); throw new Error(); } chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { if (error instanceof Problem) throw error; throw new Problem('Social provider response could not be confirmed. Inspect the saved operation; no automatic retry was sent.', 502); }
  }
  #xHeaders(app) { return app.clientSecret ? { Authorization: 'Basic ' + Buffer.from(encodeURIComponent(app.clientId) + ':' + encodeURIComponent(app.clientSecret)).toString('base64') } : {}; }
  #invalidateX() {
    const s = this.#store.data;
    for (const item of s.oauth) { if (item.status === 'pending') item.status = 'cancelled'; delete item.verifier; }
    for (const item of s.outbox) if (item.channel === 'x' && item.status === 'draft') item.status = 'cancelled';
  }
  configureXApp(input = {}) {
    return this.#exclusive(() => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'clientId', 'clientSecret'].includes(key)) || !['custom', 'platform'].includes(input.mode)) throw new Problem('Choose your own X app or the Veyl app. The callback is fixed by Veyl.');
      if (this.#store.data.accounts.x) throw new Problem('Disconnect this agent’s X account before changing its app. Unsent X drafts will be cancelled.', 409);
      if (input.mode === 'custom') {
        if (!this.#x.redirectUri) throw new Problem('The fixed X callback is not configured by the server.', 503);
        if (!appCredential(input.clientId, 512) || !appCredential(input.clientSecret ?? '', 4096, true)) throw new Problem('Enter a valid OAuth 2.0 client ID and, for a confidential app, its client secret.');
      } else if (Object.hasOwn(input, 'clientId') || Object.hasOwn(input, 'clientSecret')) throw new Problem('Removing the custom app does not accept credentials.');
      this.#invalidateX();
      this.#store.data.xApp = input.mode === 'custom' ? { clientId: input.clientId, clientSecret: input.clientSecret || '' } : null;
      this.#save(); const app = this.#xApp();
      return { xApp: this.#publicXApp(), xConfigured: !!(app.clientId && app.redirectUri) };
    });
  }
  #tokens(raw) {
    if (!raw || raw.token_type?.toLowerCase() !== 'bearer' || !Number.isSafeInteger(raw.expires_in) || raw.expires_in <= 0 || raw.expires_in > 31_536_000 || typeof raw.scope !== 'string' || !SCOPES.every(scope => raw.scope.split(' ').includes(scope))) throw new Problem('X did not grant the required posting and refresh permissions.', 502);
    return { accessToken: clean(raw.access_token, 8192), refreshToken: clean(raw.refresh_token, 8192), expiresAt: this.#now() + raw.expires_in * 1000 };
  }
  beginX() {
    return this.#exclusive(() => {
      const app = this.#xApp();
      if (!app.clientId || !app.redirectUri) throw new Problem('Configure an X developer app for this agent first.', 503);
      const s = this.#store.data; s.oauth = s.oauth.filter(item => item.expiresAt > this.#now()).slice(-20);
      const state = this.#projectId + '.' + secret(), verifier = secret(), expiresAt = this.#now() + 600_000;
      s.oauth.push({ state, verifier, expiresAt, status: 'pending', appBinding: this.#xBinding() }); this.#save();
      const url = new URL('https://x.com/i/oauth2/authorize');
      url.search = new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: app.redirectUri, scope: SCOPES.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      return { authorizationUrl: url.href, state, expiresAt };
    });
  }
  completeX({ state, code } = {}) {
    return this.#exclusive(async () => {
      if (typeof code !== 'string' || !code || code.length > 4096 || typeof state !== 'string') throw new Problem('Missing X callback parameters.');
      const intent = this.#store.data.oauth.find(item => equivalent(item.state, state));
      if (!intent || intent.expiresAt <= this.#now() || intent.status !== 'pending' || !equivalent(intent.appBinding, this.#xBinding())) throw new Problem('X authorization is expired, used or belongs to another project or app. Start a new connection.', 409);
      const app = this.#xApp();
      intent.status = 'exchanging'; this.#save();
      try {
        const tokens = this.#tokens(await this.#request('https://api.x.com/2/oauth2/token', { method: 'POST', form: true, headers: this.#xHeaders(app), body: { grant_type: 'authorization_code', client_id: app.clientId, code, redirect_uri: app.redirectUri, code_verifier: intent.verifier } }));
        const me = await this.#request('https://api.x.com/2/users/me', { headers: { Authorization: 'Bearer ' + tokens.accessToken } });
        const account = { channel: 'x', connectionId: randomUUID(), id: id(me.data?.id), username: clean(me.data?.username, 50), connectedAt: this.#now(), status: 'connected', appBinding: intent.appBinding, ...tokens };
        this.#store.data.accounts.x = account; intent.status = 'complete'; delete intent.verifier; this.#save(); return publicAccount(account);
      } catch (error) { intent.status = 'unknown'; delete intent.verifier; if (this.#store.healthy) this.#save(); throw error; }
    });
  }
  async #xToken(account) {
    if (!equivalent(account.appBinding, this.#xBinding())) { account.status = 'reconnect_required'; this.#save(); throw new Problem('The X app changed. Reconnect this account before publishing.', 409); }
    if (account.status !== 'connected') throw new Problem('Reconnect the X account before publishing.', 409);
    if (account.expiresAt > this.#now() + 60_000) return account.accessToken;
    account.status = 'refreshing'; this.#save();
    try {
      const app = this.#xApp();
      const tokens = this.#tokens(await this.#request('https://api.x.com/2/oauth2/token', { method: 'POST', form: true, headers: this.#xHeaders(app), body: { grant_type: 'refresh_token', client_id: app.clientId, refresh_token: account.refreshToken } }));
      Object.assign(account, tokens, { status: 'connected' }); this.#save(); return account.accessToken;
    } catch (error) { account.status = 'reconnect_required'; if (this.#store.healthy) this.#save(); throw error; }
  }
  async #telegram(token, method, body = {}) {
    if (!['getMe', 'getChat', 'getChatMember', 'sendMessage'].includes(method)) throw new Problem('Unsupported Telegram method.');
    const result = await this.#request(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body });
    if (result.ok !== true || !result.result) { const error = new Problem('Telegram rejected the operation.', 502); error.definiteFailure = result.ok === false; throw error; }
    return result.result;
  }
  connectTelegram({ token, chatId: target } = {}) {
    return this.#exclusive(async () => {
      if (typeof token !== 'string' || !/^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{25,100}$/.test(token)) throw new Problem('Enter the bot token securely in this connection form.');
      target = chatId(target);
      const me = await this.#telegram(token, 'getMe'); if (me.is_bot !== true || !Number.isSafeInteger(me.id)) throw new Problem('Telegram did not identify a bot.', 502);
      const chat = await this.#telegram(token, 'getChat', { chat_id: target });
      if (!Number.isSafeInteger(chat.id) || String(chat.id) !== target || !['private', 'group', 'supergroup', 'channel'].includes(chat.type)) throw new Problem('Telegram chat does not match the chosen destination.', 409);
      if (chat.type !== 'private') {
        const membership = await this.#telegram(token, 'getChatMember', { chat_id: target, user_id: me.id });
        if (membership.user?.id !== me.id || !['creator', 'administrator'].includes(membership.status) || (chat.type === 'channel' && membership.status !== 'creator' && membership.can_post_messages !== true)) throw new Problem('Give this bot administrator and posting permission in the selected chat first.', 409);
      }
      const account = { channel: 'telegram', connectionId: randomUUID(), id: id(me.id), username: clean(me.username || String(me.id), 100), token, chatId: target, chatType: chat.type, chatTitle: clean(chat.title || chat.first_name || target, 256), connectedAt: this.#now(), status: 'connected' };
      this.#store.data.accounts.telegram = account; this.#save(); return publicAccount(account);
    });
  }
  disconnect({ channel } = {}) {
    return this.#exclusive(() => {
      if (!CHANNELS.has(channel)) throw new Problem('Unknown social channel.');
      this.#store.data.accounts[channel] = null;
      if (channel === 'x') this.#invalidateX();
      for (const item of this.#store.data.outbox) if (item.channel === channel && item.status === 'draft') item.status = 'cancelled';
      this.#save(); return { disconnected: true, providerRevocation: 'Revoke app access in the provider settings if you also want to invalidate its issued credentials.' };
    });
  }
  draft({ channel, text, idempotencyKey, madeWithAi = true } = {}) {
    return this.#exclusive(() => {
      if (!CHANNELS.has(channel) || typeof text !== 'string' || !text.trim() || /\u0000/.test(text) || typeof madeWithAi !== 'boolean' || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Problem('Choose a connected channel, message and unique draft key.');
      if (text.length > 4096) throw new Problem('Draft text must be at most 4096 characters.');
      // X's official parser handles URL shortening, NFC and combined emoji.
      // Keep the literal reviewed text; the parser's normalization is only for validation.
      if (channel === 'x' && !twitterText.parseTweet(text).valid) throw new Problem('Use valid X text within 280 weighted characters. URLs count as 23 and combined emoji as two.');
      const account = this.#store.data.accounts[channel]; if (!account || account.status !== 'connected') throw new Problem('Connect this project to the selected channel first.', 409);
      const preview = { projectId: this.#projectId, channel, connectionId: account.connectionId, accountId: account.id, username: account.username, ...(channel === 'telegram' ? { chatId: account.chatId, chatTitle: account.chatTitle } : { madeWithAi }), text };
      const old = this.#store.data.outbox.find(i => i.key === idempotencyKey);
      if (old) { if (old.approvalDigest !== digest(preview)) throw new Problem('Draft key belongs to different content or account.', 409); return this.#publicIntent(old); }
      if (this.#store.data.outbox.length >= 2000) throw new Problem('Social outbox capacity reached; archive it before continuing.', 409);
      const item = { id: randomUUID(), key: idempotencyKey, channel, status: 'draft', preview, approvalDigest: digest(preview), createdAt: this.#now(), expiresAt: this.#now() + 86_400_000 };
      this.#store.data.outbox.push(item); this.#save(); return this.#publicIntent(item);
    });
  }
  publish({ intentId, approvalDigest } = {}) {
    return this.#exclusive(async () => {
      if (!this.#publish) throw new Problem('Publishing is disabled by server configuration.', 403);
      const item = this.#store.data.outbox.find(i => i.id === intentId);
      if (!item || !equivalent(item.approvalDigest, approvalDigest)) throw new Problem('Approval does not match the exact displayed social draft.', 409);
      if (item.status !== 'draft') return this.#publicIntent(item); // No uncertain replay.
      const account = this.#store.data.accounts[item.channel];
      if (!account || account.connectionId !== item.preview.connectionId || item.expiresAt <= this.#now()) throw new Problem('Account or draft changed. Review a fresh draft.', 409);
      let accessToken; if (item.channel === 'x') accessToken = await this.#xToken(account);
      item.status = 'sending'; this.#save();
      try {
        if (item.channel === 'x') {
          // made_with_ai describes generated media in X's API. This connector
          // sends text only; madeWithAi remains local draft provenance.
          const raw = await this.#request('https://api.x.com/2/tweets', { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken }, body: { text: item.preview.text } });
          const publishedId = id(raw.data?.id); item.result = { id: publishedId, url: `https://x.com/i/status/${publishedId}` };
        } else {
          const raw = await this.#telegram(account.token, 'sendMessage', { chat_id: item.preview.chatId, text: item.preview.text, link_preview_options: { is_disabled: true } });
          if (!Number.isSafeInteger(raw.message_id) || raw.message_id <= 0 || String(raw.chat?.id) !== item.preview.chatId) throw new Problem('Telegram publication could not be bound to its destination.', 502);
          item.result = { id: String(raw.message_id), chatId: item.preview.chatId };
        }
        item.status = 'published'; this.#save(); return this.#publicIntent(item);
      } catch (error) {
        item.status = error.definiteFailure ? 'failed' : 'unknown'; item.error = error.definiteFailure ? 'Provider rejected this publication. Prepare and approve a new draft to retry.' : 'Publication may have succeeded. Check the provider before preparing any replacement.';
        if (this.#store.healthy) this.#save(); throw new Problem(item.error, 502);
      }
    });
  }
  cancel({ intentId } = {}) { return this.#exclusive(() => { const item = this.#store.data.outbox.find(i => i.id === intentId); if (!item || item.status !== 'draft') throw new Problem('Only an unsent draft can be cancelled.', 409); item.status = 'cancelled'; this.#save(); return this.#publicIntent(item); }); }
}
