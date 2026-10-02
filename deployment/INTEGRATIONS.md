# Veyl runtime integrations

The integration code is separate from enabling real transactions or publishing.
Every project needs its own zkAPI profile, loopback API port, companion port,
credentials and recovery directory. Never share a funded private note between
projects. Preserve those directories during upgrades and restore them together
with Veyl's encrypted state and the original state-encryption key.

## zkAPI source and bootstrap

The reviewed daemon source is Ethereum zkAPI commit
`b826c169b4831665822529f535f824265f50630b`. Its normal `serve` command requires
an already funded private note. `scripts/patch-zkapi-control.mjs` checks the
exact upstream source hash and adds `serve-control`, which starts the existing
authenticated loopback API and companion before funding. It changes no proofs,
settlement checks, signing approvals or inference-solvency checks. It does not
fund anything during startup.

On Linux, apply the patch to that source tree and build with Go 1.25:

```sh
node scripts/patch-zkapi-control.mjs /path/to/zkapi
cd /path/to/zkapi/zkapi-clientd
go test ./cmd/zkapi-clientd ./internal/config ./internal/zkapi ./internal/server
CGO_ENABLED=0 go build -trimpath -ldflags '-X main.version=veyl-b826c169-control1' -o /path/to/veyl/bin/zkapi-clientd ./cmd/zkapi-clientd
/path/to/veyl/bin/zkapi-clientd --config-dir /private/project/profile serve-control
```

Use the source-compatible native wallet companion and verified proof assets.
The companion's private files are never read by Veyl's application database.
`key_reuse_window_seconds` is set to zero for isolated per-request leases.
This does not by itself provide a signed per-job billing receipt.

## Funding lifecycle

`ZkApiFunding` wraps the actual authenticated daemon API: deposit address,
exact-gwei quote, approval, saved-transaction recovery, private-note withdrawal,
and exact public-ETH return. Quote endpoints cannot sign. Approvals name a
saved, unexpired quote and exact digest. The 30-second daemon quotes must be
refreshed after a treasury payment reaches Ethereum finality.

`TreasuryRunway` binds one project, treasury, owner, operator and funding address.
It prepares an owner `setRecipient` call when necessary, then the operator's
exact `pay` call. It enforces per-transfer and daily policy ceilings, onchain
daily limits, account identities and treasury balance. The confirmed transaction
must contain the exact payment calldata and `Expense` event in a canonical,
finalized block. An uncertain signing result is never automatically resent.

Automatic funding requires an explicitly supplied operator signer, a persisted
automatic project policy, server enablement and daemon approval enablement.
It waits until the runtime is idle. At low balance it waits for inference
settlement, withdraws the private remainder back to the same treasury, closes
the note, and creates the next capped deposit. A shortfall in withdrawal gas can
be prepared as another bounded treasury payment. There is no sweep of the whole
trading-fee allocation. Fee movement beyond an already funded deposit stops
approval and requires another reviewed top-up.

Public journals persist public authorizations and transaction identities only.
Never add wallet secrets, note proofs, raw signed transactions or signer keys to
these records. Approval and replay remain disabled unless explicitly enabled.

### Note expiry is a real loss boundary

The pinned mainnet vault has a 30-day `noteTtl`; deposit expiry is rounded up to
the next day boundary, so an individual note lasts roughly 30–31 days. Its
`claimExpired` function permits an expired active note's entire deposit amount
to be transferred to the zkAPI treasury. An unused private balance is therefore
not guaranteed to remain withdrawable indefinitely. ETH still held in the Veyl
treasury has not entered that note and is outside this expiry mechanism.

`NoteExpiryGuard` combines the authenticated daemon's selected note ID with the
pinned vault's `notes(uint32)` result at a fresh finalized Ethereum block. It
rechecks both the canonical block hash and daemon note selection. Each hosted
paid-call boundary checks again: warn within seven days, stop new calls at
three days, and block unknown expiry, stale RPC state, or a nonactive note.
The guard is read-only and does not disable the manual withdrawal controls.
The stop window provides time to act, not a guarantee of successful recovery.
No automatic pre-expiry withdrawal/renewal or funded expiry-recovery acceptance
is claimed. Those remain requirements before enabling unattended real-money
operation; retain only a small working deposit in the daemon.

## What zkAPI verifies

The daemon's verification headers describe provider-key ownership and privacy
settings. They are not proofs of inference correctness, hidden prompts, or
finalized per-job charges. The companion wallet verifies the protocol's signed
state and commitment transitions internally.

The pinned native companion does export an authenticated operational feed at
`GET /oa/v1/session-events`. A `settled` event is emitted only after wallet
recovery verifies and installs the signed state; it includes `session_id`,
`charge_units` and `balance_units`. For the mainnet deployment these amounts
are native-ETH gwei. This is genuine companion-verified settlement evidence.
However, the feed retains only 128 events in memory, resets its instance and
sequence on restart, and is not a durable billing ledger. Its session ID hashes
the native request identity. The Go chat response and lease response do not
export that identity to Veyl, and its local `key_ref` is a different counter.
Neither timing proximity nor a balance difference proves which Veyl call paid.

An exact-charge refund integration therefore needs a pinned upstream extension:
export a trusted call-to-native-session binding at lease issuance, persist it
before dispatch, and expose durable acknowledged settlement events with reset
and gap detection. Conversion back to a USD budget also needs the verified
pricing quote bound to that lease, not today's exchange rate. It must reject
foreign, duplicate, missing and malformed events and preserve uncertain calls
across crashes. Veyl has not substituted an unsigned provider field or changed
the protocol's cryptography to fill this gap.

Veyl therefore accounts for each live model request at its full spending ceiling.
Successful responses, tool rounds and uncertain calls retain that reservation.
Budget settings can be raised by the owner; no estimate, provider `usage.cost`,
balance subtraction or local HMAC is presented as a verified settlement refund.

The pinned daemon accepts OpenAI-style `tools`, `tool_choice`, assistant
`tool_calls` and tool-role messages. Veyl limits calls to its offered catalog,
validates function arguments and reserves every model round. Individual model
tool support remains model-dependent. Publication and signing are not model
tools.

## Future funded acceptance

`scripts/acceptance-zkapi.mjs` is an operator acceptance harness, not a service
enablement command. Default execution prints an offline public plan; `--inspect`
reads authenticated daemon metadata and the model catalog only. Neither mode
funds, signs, calls a model, connects social accounts or changes production flags.

Prepare a new exclusive daemon profile and fill a copy of
`deployment/acceptance.example.json` with public addresses, an exact deposit,
the selected model's request ceiling, a total of two to four calls, and separate
deposit-inclusive and withdrawal-gas limits. Keep its recovery directory. Never
add wallet keys or local API credentials to that JSON. The dedicated public
payment address must be funded separately after explicit approval; the harness
has no treasury signer or funding-transfer function.

```sh
node scripts/acceptance-zkapi.mjs --config /private/acceptance-public.json
node scripts/acceptance-zkapi.mjs --config /private/acceptance-public.json --inspect
```

Only after the exact displayed plan has been approved, a future operator can
set `VEYL_ACCEPTANCE_ENABLE_PAID=true`, supply `ZKAPI_LOCAL_KEY` and
`ZKAPI_MANAGEMENT_TOKEN` securely in the process environment, then invoke
`--run --approval EXACT_PLAN_DIGEST`. Changing a destination or spending limit
changes that digest. The harness refreshes and checks the daemon's fee-inclusive
quote before authorizing one deposit, runs one Veyl task with a real `save_note`
tool round, waits for settlement readiness, and requests one whole-note
withdrawal to the approved public address. The inference gate records each
attempt durably before I/O and stops at the exact call ceiling.
Before every model call it also checks the canonical note expiry through the
read-only `ETHEREUM_RPC_URL` client (public mainnet RPC by default).

Rerunning the same plan only advances saved lifecycle state; it never repeats
an absent, interrupted or uncertain task. A pending known transaction requires
`--resume deposit|withdrawal --transaction-hash SAVED_HASH --approval DIGEST`.
An unknown transaction result stops for daemon recovery. Failed inference
acceptance also stops; use the existing funding recovery controls to withdraw
the remainder without authorizing another task. The acceptance journal retains
public identities and call status, not credentials or signed transactions.

The deployed zkAPI manifest currently specifies `native_eth`, `gwei`, and no
billing token. Veyl's USD limits are spending ceilings, not USDC deposits or
verified invoices. For a small future check, the example allows two requests
with a combined $2 ceiling. The public billing quote with update time 2026-10-01
22:30:59 UTC priced ETH at $2,698.84668531: $2 converted upward to 741,058 gwei
(0.000741058 ETH). This dated principal estimate excludes deposit and withdrawal
gas and is not a final funding instruction. Refresh the quote and obtain the
dedicated daemon's actual fee quotes before approving the complete amount.

Offline tests cover the real Kit tool loop, exact approval and fee limits,
lost responses and saved-hash recovery using fixtures. Separately,
`scripts/check-local-runway.mjs` performs real transactions on a fresh disposable
Anvil chain: a v4 swap creates a 0.0018 ETH fee, its 70% treasury share is
0.00126 ETH, and the bounded operator pays 0.00112 ETH to the fixture daemon
address, retaining 0.00014 ETH. The daemon is a fixture in that rehearsal.
Neither result claims a funded live OpenRouter request or mainnet deployment.

## Queue and tenant storage bounds

Queued jobs do not hold a daemon process. Admission persists the exact project,
model, financial reservation and output-space reservation before enqueueing.
On restart, only an untouched queued job matched by the durable scheduler can
resume. A running or uncertain request never retries automatically. A worker
rechecks the live model spending ceiling before dispatch and holds one isolated
project daemon lease for the entire job.

Canonical tenant state is limited to 16 MiB, with 64 KiB kept available for
recovery updates. Every initial stage and final artifact reserves 256 KiB of
output growth; each later paid tool round rechecks and replenishes that space
before dispatch. Concurrent memory edits cannot consume these reservations.
Exhaustion stops new work with HTTP 507 and preserves financial records,
idempotency keys and uncertain results. The operator must reconcile and archive
records deliberately before increasing capacity; there is no automatic ledger
deletion. Large tool-result history retains an explicit preview and SHA-256
digest; the model receives the bounded full tool response for that round.
Only routine presentation events rotate after 200 entries, with an omitted
counter. Transaction events are retained under the same tenant limit.

Full shared queues postpone recurring admission for one minute. Budget,
storage and policy failures disable the schedule for review. Idle daemon
eviction must inspect the independent funding, private-withdrawal and public-
return states under the runtime lease lock; `waiting_settlement` and uncertain
local approvals prohibit eviction.

## X and Telegram

`SocialService` uses per-wallet, per-project AES-256-GCM state. It supports X
OAuth 2.0 authorization-code PKCE with S256, exact HTTPS callback matching,
short-lived one-use authorization state and private refresh-token rotation.
Configure a developer app with `tweet.read tweet.write users.read offline.access`
and callback `https://veyl.sh/oauth/x`. App access and account/API entitlements
are provider requirements; no Veyl test creates those credentials.

Telegram requires a bot token entered securely and an exact numeric chat ID.
The connector verifies the bot and chat with read-only API methods; group or
channel publishing requires bot administrator rights, including channel posting
permission. It sends plain text, with link previews disabled.

Both connectors produce immutable previews. Publishing requires the exact
preview digest after human review and explicit server publishing enablement.
An agent can prepare a draft; it cannot authorize publication. The outbox is
saved before the external request. A lost response stays unknown across restarts
and is never automatically retried. Inspect the provider before replacing it.
Disconnect removes Veyl's local credentials; provider-side app revocation is
performed in the provider's own account settings.

The automated connector tests use synthetic credentials and offline HTTP
fixtures. They verify encryption, owner/project isolation, exact request schemas,
durable authorization and uncertain-result recovery. They do not claim a live
funded zkAPI session or live social account acceptance.

## Sources

- [Pinned daemon routing and sanitization](https://github.com/ethereum/zkapi/blob/b826c169b4831665822529f535f824265f50630b/zkapi-clientd/internal/server/server.go)
- [Pinned funding management routes](https://github.com/ethereum/zkapi/blob/b826c169b4831665822529f535f824265f50630b/zkapi-clientd/internal/zkapi/funding_admin.go)
- [Pinned funding quotes](https://github.com/ethereum/zkapi/blob/b826c169b4831665822529f535f824265f50630b/zkapi-clientd/internal/zkapi/address_quote.go)
- [Pinned native companion patch and verified session events](https://github.com/ethereum/zkapi/blob/b826c169b4831665822529f535f824265f50630b/zkapi-clientd/internal/zkapi/companion.patch)
- [Pinned Go session-event reader](https://github.com/ethereum/zkapi/blob/b826c169b4831665822529f535f824265f50630b/zkapi-clientd/internal/zkapi/session_events.go)
- [Pinned native source revisions](https://github.com/ethereum/zkapi/blob/b826c169b4831665822529f535f824265f50630b/zkapi-clientd/packaging/zkapi-source.env)
- [Pinned vault expiry and claim semantics](https://github.com/ethereum/zkapi/blob/b826c169b4831665822529f535f824265f50630b/protocol/contracts/src/ZkApiVault.sol)
- [Public zkAPI mainnet deployment manifest](https://zkapi-mainnet.openanonymity.ai/config.json)
- [Public native-ETH billing quote](https://zkapi-mainnet.openanonymity.ai/v2/billing/quote)
- [X OAuth 2.0 and PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
- [X create post endpoint](https://docs.x.com/x-api/posts/create-post)
- [Telegram Bot API](https://core.telegram.org/bots/api)
