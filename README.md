# Veyl

An Ethereum agent workspace with persistent context, bounded tools, solo or three-stage workflows, operating treasuries and zkAPI inference payments. Product domain: **veyl.sh** · [X: @Veyldotsh](https://x.com/Veyldotsh).

Use the [workspace](https://veyl.sh/app), read the [docs](https://veyl.sh/docs), or connect through the [API, SDK and MCP](https://veyl.sh/developers).

**VEYL address:** [`0x2eaB833d244352D4A7f8dC93285B1776F01954cB`](https://etherscan.io/address/0x2eaB833d244352D4A7f8dC93285B1776F01954cB).

## Run the local demo

Requires Node 22+. From this directory:

```powershell
npm ci
npm start
```

Open the [overview](http://127.0.0.1:4318/), [workspace](http://127.0.0.1:4318/app), [documentation](http://127.0.0.1:4318/docs) or [identity assets](http://127.0.0.1:4318/brand). Create a project, choose solo or swarm, add notes/sources and submit a task. Demo output is deterministic: no model is called or real funds spent. USD allowances are policy limits, not deposited balances.

For local markets, install the pinned dependencies, build and start Anvil:

```powershell
npm run setup:contracts
forge build --root contracts
anvil --host 127.0.0.1 --port 8547 --quiet
```

Dependencies are installed in `contracts/lib` from the exact official commits in `contracts/dependencies.json`; the parent repository's libraries are not required. Solidity settings are in `contracts/foundry.toml`.

The demo verifies loopback, chain 31337 and Anvil identity before using unlocked development accounts. Market → Create local market creates the token, treasury, fee router, hook, swap router and permanent liquidity vault atomically. The rehearsal uses approximately 100M tokens plus 1 development ETH for liquidity, 0.05 development ETH for the treasury and a labeled 3% hook fee. Unused seed inputs and remaining supply go to the creator. These are demo terms, not the production allocation. Existing token-only projects remain separate; use a new project for a market launch.

## Production flow

1. Connect an Ethereum wallet and sign a one-use login challenge. A wallet-scoped session controls access to that owner's projects and artifacts.
2. Create a project and its dedicated zkAPI wallet profile. Profile creation saves metadata; it does not keep a daemon pair running for every project.
3. Choose a catalog model and policy limits. The global durable queue admits a job only after its stage caps have been saved. A bounded process pool leases that project's daemon for execution and releases it afterward.
4. Run a specialist, or planner → specialist → reviewer. Projects retain notes, sources, deliverables and activity. Pausing prevents later calls; it cannot undo a dispatched request.
5. When launch is authorized, review explicit token/liquidity terms and unsigned market transactions. The connected wallet signs; the market service has no signer. Exact receipts and contract identities are checked before importing a launch or trade. Uncertain submissions are recovered by hash, never automatically resent.

The hosted topology is a static site and signed gateway on Vercel, a persistent Node worker, Ethereum RPC and per-project zkAPI profiles. It is implemented in `src/production.mjs` and `api/gateway.mjs`; `npm start` remains the local demo. See `deployment/OPERATIONS.md` and `deployment/runtime.env.example` for operator setup. Daemon ports stay on loopback. Server administration can access running processes and wallet secrets: this is hosted custody.

The shared-host pilot is configured for 50 registered profiles (10 per owner), one active job, one daemon pair, 100 admitted jobs (10 per wallet) and eight loaded tenant states. Tenant state has a 16 MiB ceiling, with output space reserved before a paid call. The service budget is two CPU cores, 4 GiB hard memory (3 GiB pressure threshold), no swap and a 384 MiB Node heap. Storage admission checks a 2 GiB data ceiling and 512 MiB free reserve; a separately mounted bounded filesystem supplies a hard disk limit. These bounds are installed for the gated pilot; they are not a measured funded-proof capacity claim.

The scheduler applies global and per-wallet admission limits, one running job per wallet and fair rotation across wallets. Only untouched queued jobs matching both durable ledgers survive restart. Interrupted dispatch becomes uncertain and retains its reservations. A capacity-only deferral is distinct from an unknown inference result. Cancellation does not promise a refund.

Recurring schedules use the same queue every 15 minutes, hour or day while the worker runs; missed intervals do not create a backlog. Heartbeats report worker activity, not successful inference or an onchain attestation. The shared-host preset and memory/disk limits are operator capacity boundaries, not demonstrated funded-proof throughput.

## Tools and social actions

The model can read a supplied source on a reviewed HTTPS host, read Ethereum ETH/ERC-20 balances, save a project note and prepare an X or Telegram draft. No arbitrary shell, RPC write, trading, deployment or publishing tool is exposed. Tool results are untrusted context. Each additional model round requires another persisted request-cap reservation; a stage allows at most four model calls and three tool rounds.

The source reader is not a search engine. It rejects redirects, credentials and custom ports, caps fetched responses at 500 KB, and retains source URLs and capture times. Saved source text is capped at 20,000 characters; model-tool source results use a smaller 12,000-character limit.

Autonomous research is an explicit owner opt-in. Set an objective, cadence, daily cycle cap, allowed tools and source scope in Research. Each cycle separately admits a planner, source-backed research job and optional different-model review through the existing queue and budgets. Completed findings inform the next question. Policy changes and pause stop later calls; unknown outcomes are not replayed. This is bounded hosted research, not arbitrary browsing or wallet control.

The Activity panel and read-only API/SDK/MCP interfaces show saved actions, results and settled versus reserved charges. Private notifications cover completed work, low budgets and failed connections. In Deliverables, owners preview and select up to five results for a public page. Optional run-history sharing is off by default: it adds a bounded snapshot of the reliably linked completed job's stage/tool statuses, dates, safe source links and confirmed settled ETH versus unresolved held budget. The owner approves the exact preview; changed content or costs require another preview. Prompts, notes, model reasoning, raw tool output and wallet data are not added, although the selected result text itself is public. Existing pages stay results-only. Snapshots do not update automatically or expose a full agent archive. Revocation invalidates the URL, but cannot recall visitor copies. API tokens, SDK and MCP cannot publish or change this sharing choice.

Owner-authenticated X OAuth, Telegram connection, draft, approval and publishing server routes exist, with encrypted tokens and a durable outbox. Publishing requires explicit owner approval and a separate enable flag. Owners can opt into bounded automatic publication of new agent-origin drafts per channel; the rule binds the current connection and policy revision, with daily attempt limits and minimum spacing. Direct API drafts remain manual. The Connections tab supports account setup, exact draft review and a separate approval step; local demo mode explains that connections require the hosted service. Real provider acceptance was deliberately not tested at the owner’s request. A saved draft is not a published post.

## Funding and fee allocation

| Recipient | Share of ETH fee proceeds |
| --- | --- |
| Agent operating treasury | 70% |
| Creator | 20% |
| Platform | 10% |

Veyl's main-token preset is **1.8% buys / 1.8% sells, zero LP fee**. It also requires immutable **2% per-transfer and per-wallet limits for the first ten launch blocks**, active from B through B+9 and absent at B+10. Only the fixed PoolManager is exempt from the wallet cap; the creator has no exemption. Standard Uniswap v4 routing is available immediately after the atomic launch activates. The hook does not whitelist swap routers. A bot or interface still needs to support Uniswap v4 and this pool's hook; compatibility with every bot is not established. The approved main-token seed deposits only VEYL, targeting 980 million tokens (98%) in liquidity and up to 20 million (2%) to the deployer. There is no initial ETH liquidity deposit. The 2 ETH starting total valuation rounds to approximately 2.00004029 ETH at the selected v4 tick. New fixed-policy agent tokens have no early transfer or wallet caps. These limits apply to ERC-20 transfers and balances per address. ERC-6909 claims, wrapped positions and multiple wallets can represent economic exposure above 2%; the caps do not aggregate or constrain that exposure. New fixed-policy agent markets also have immutable 1.8% buy/sell hook fees and zero LP fee; legacy markets retain their recorded launch parameters. The split applies to collected receipts, not trading volume or token supply. The main VEYL/ETH hook accumulates native-ETH ERC-6909 claims. Agent-token markets pair with the pinned main VEYL token and accumulate VEYL claims. Anyone can flush either asset into its fixed router. Agent fee receipts are converted in full through the verified VEYL/ETH market before any payouts, then actual net ETH receives the same 70/20/10 split. The main pool’s sell fee and price impact reduce the resulting ETH. No VEYL token payouts are made. Beneficiaries receive independent claims. Treasury and creator shares round down, and the platform receives the remainder. Direct treasury top-ups bypass this split.

The treasury funds inference, tools, hosting, gas and retained runway. Operator payments require approved recipients, unique expense IDs and a daily limit. **Owner withdrawals bypass those operator limits.** VEYL liquidity locking uses an NFT transfer to the dead address. Launchpad liquidity locks automatically in permanent vaults. Hook fees and operating treasuries are separate from liquidity. There is no staking return, guaranteed buyback, recurring credit yield or promise that trading pays every future bill.

The funding controller implements daemon deposit quotes, exact-quote approval, withdrawal, unspent-address returns and recovery of the same recorded operation. Unknown outcomes retain their journals and cannot automatically create another payment. A direct transfer to the zkAPI vault does not create a private note.

`TreasuryRunway` prepares bounded treasury payments to the verified project's daemon funding address and checks recipient/daily/per-refill limits and final receipts. Automatic refills are implemented but **disabled by default**: they require the global transaction switch, separate daemon-approval switch, a separately armed treasury operator, onchain matching operator/recipient/daily limits and explicit owner opt-in. This signer cannot harvest fees; the fee signer cannot fund inference. Both persist nonce/gas reservations before signing, enforce gas-price and daily spending caps, and block uncertain outcomes without automatic replay. The entire 70% share is never swept into inference.

The Treasury tab exposes limits and separate automatic-refill/expiry-closure opt-ins, recipient approval, exact unsigned payments, finalized receipt import, note activation, whole-note withdrawal, exact public-address return and bounded recovery-fee preparation. Its owner-only pause stops new automatic authorizations even when daemon/RPC reads fail; it cannot cancel signed or submitted transactions. A reviewed retirement control can retire only a failed, provably unsigned preparation while preserving its history. A different treasury operator can download the exact call and import its receipt. Unknown outcomes remain recorded across page reloads and cannot be resent automatically.

**zkAPI private notes expire.** The reviewed mainnet vault uses a 30-day lifetime rounded to a UTC day; after expiry, `claimExpired` can send the deposited amount to the zkAPI treasury. Unused private balance is not indefinitely recoverable. Veyl reads the current note's expiry from finalized vault state, warns seven days beforehand and blocks new paid calls with 72 hours remaining or when expiry cannot be verified. Close the whole note before expiry; retained operating reserves belong in the project treasury, with only bounded prepaid amounts exposed to note expiry. An independent owner opt-in can request whole-note closure within seven days of expiry, return to the same project treasury and bounded redeposit after confirmed closure. Fresh canonical active-note evidence is required around quote refresh; unknown, expired or inactive notes stop automatic changes. Offline workers, failed RPC or unavailable gas can prevent rescue, so this is not an expiry guarantee. Funded expiry/withdrawal acceptance remains a launch requirement.

The production `FeeKeeper` is implemented but disabled. It verifies factory, pool, hook and router identities before permissionless `flushFees` or fixed-recipient `distribute` calls. A separate fee operator, explicit arming, gas-price/transaction/daily caps and an economic minimum are required. It saves nonce/gas before signing and the transaction hash before submission; uncertain outcomes block the global signer until inspected. It waits for canonical finalized receipts and never automatically replays a transaction. No operator key or treasury signer is included in the source.

Daemon approval uses separate private inference and management credentials and an explicit enable flag; hosted transaction approval is also gated globally. Approval/resume can cause the daemon to sign and broadcast. Mainnet funding, settlement, withdrawal and return acceptance have not been exercised with real funds in this implementation.

## What zkAPI changes

The inference route is **Veyl → zkAPI → OpenRouter → the chosen model/provider**. The [official zkAPI site](https://zkapi.openanonymity.ai/) describes private prepaid authorization using native ETH and short-lived OpenRouter credentials. zkAPI is a payment/access layer, not a new language model. Veyl's distinction is its integrated workspace, bounded workflow and funding controls; this does not promise better model answers or a cheaper route for every task.

The adapter is pinned to upstream revision `b826c169b4831665822529f535f824265f50630b`. It reads `/v1/models`, reserves `oa_request_limit_micro_usd`, and uses `/v1/chat/completions`, including reviewed tool-call passthrough. The installer builds a narrowly patched control daemon so an unfunded profile can expose its catalog and funding controls; a build manifest records source/binary identity. Catalog and readiness are checked separately because HTTP health can precede model readiness.

**A response is not a reconciled charge.** Tracked calls require the Veyl accounting extension to the pinned native daemon. Each model round saves a call ID before dispatch and reserves the model cap plus an explicit $0.001 rounding allowance within the owner’s limits. The daemon binds that call to its private session and frozen ETH/USD quote before requesting a lease. It refuses a native cap that exceeds the saved reservation. After the wallet verifies the signed state transition, a durable receipt records the exact ETH charge in integer gwei. Veyl applies that receipt once, values it at the original quote rounded up to microdollars, and releases the unused reservation. Missing, uncertain and older untracked calls remain held. Provider `usage.cost`, timing and balance differences are never used as settlement evidence. This is authenticated local reconciliation, not a public proof of model execution. Requests are never automatically retried.

## Privacy and control

Production account state, sessions, runtime registry, queue and social tokens are encrypted at rest. Local demo state is plaintext. Upstream-compatible daemon configuration/private wallet files require owner-only filesystem permissions; public funding/runway journals preserve recovery metadata. Backups encrypt the complete state, including daemon files.

The Veyl worker sees prompts and outputs. OpenRouter and the selected provider process inference content. zkAPI's payment-note authorization primitive does not make the whole hosted product sovereign, anonymous or end-to-end private. Public chain transactions and network/timing metadata remain observable. Verification headers concern reported provider-key ownership/privacy settings, not proof of model correctness or independently reconciled cost. Agent review is also not cryptographic verification. See the [pinned upstream client documentation](https://github.com/ethereum/zkapi/blob/b826c169b4831665822529f535f824265f50630b/zkapi-clientd/docs/CLI_ZKAPI.md).

## Contracts and wallet transactions

The token has a fixed one-billion supply, no later minting and no transfer tax. The deployed factories create markets atomically with immutable contract bindings. The main VEYL pool uses a canonical Uniswap v4 liquidity NFT, 98% liquidity allocation, up to 2% creator allocation, zero LP fee and 1.8% hook fees. NFT #429089 is held by the dead address. The application reads current NFT ownership and liquidity directly from PositionManager.

Agent markets use `VeylLiquidityBuilder` and `VeylLiquidityVault`. The vault has no withdrawal, position transfer or arbitrary-call path. Existing legacy agent markets retain their original configurable seed terms and spacing 200; their unused seed inputs returned during launch. Treasury seed, operator and daily limits remain separate explicit inputs.

**New agent launches:** the verified [`VeylAgentExecutionFactory`](https://etherscan.io/address/0x0f5B4Adbc0651fC5477B36952b161F7BDFEFeBCC#code) is selected for new hosted launches. It fixes 1B supply, 100% allocated to token-only permanent liquidity, zero ETH/VEYL seed, no free creator tokens, spacing 1, zero LP fee and 1.8% buy/sell hook fees. Up to 1,000,000 token wei of rounding dust stays permanently in the same vault, so pool inventory plus locked dust equals the whole supply. The factory derives the 2 ETH starting FDV target from the canonical VEYL/ETH spot when the transaction executes, with tick rounding. It does not bind a launch to an earlier spot quote. An optional paid creator buy retains its exact VEYL spend, signed minimum token output and deadline; the whole launch reverts if the purchase cannot meet that minimum. Spot is manipulable and is not a TWAP or independent valuation oracle. The [confirmed deployment](https://etherscan.io/tx/0x76f5d4d4b661ed8557627de539d40eb04056eea15dacaf7d683dd730fbc52921) and four verified runtime hashes are recorded in [config/execution-agent-infrastructure.json](config/execution-agent-infrastructure.json).

**Versioned receipt recovery:** execution-priced browser amounts are indicative; token, hook and router identities remain deterministic, while the vault depends on the executed range. Canonical events, factory records and compiled runtime establish the actual vault, seed and purchased output. Each prepared intent keeps its own recovery snapshot. The [older policy-2 factory](https://etherscan.io/address/0x5391727eC9726f3d5F3c77d7468521a48E0A7AEa#code) remains independently pinned for historical markets and intents, including its saved-price bound. Existing main VEYL and legacy markets are unchanged. Configuration activation requires a distinct reviewed execution-factory address; it cannot reuse an older factory pin.

`VeylSwapRouter` offers exact-input swaps in one immutable pool. The caller pays and receives, with positive minimum output checked after hook fees and a deadline. Buys fill fully or revert; partial sells pull only consumed tokens. `VeylQuoter` simulates the actual pool/hook without retaining state changes. No fee exemption, fee setter or admin sweep exists in this market route.

`src/mainnet.mjs` checks Ethereum chain identity, configured deployed code and constructor relationships, prepares unsigned transactions and verifies exact receipts. The browser wallet handles chain/account changes, finite approvals and pending transaction recovery. The hosted worker enables wallet-approved mainnet transactions through the deployed main market and shared agent factory. `JobEscrow` is tested separately and has no customer payment dashboard flow. Veyl is separate from the parent SPECIE project.

Agent markets require the exact reviewed main VEYL token, main factory and conversion router in `agentMarkets`; unset addresses fail closed. New fixed-policy launches require no VEYL allowance for their token-only seed. The Market tab prepares finite VEYL allowances for optional creator buys and trades (and legacy liquidity inputs), handles either currency ordering, and provides conversion policy and exact conversion review. The conversion policy starts disabled and requires an explicit executor, per-conversion/day limits and minimum ETH-per-VEYL floor. The floor is an owner limit, not an oracle. A separate capped conversion operator is disabled by default; it cannot harvest fees or fund inference. Unknown signed outcomes are recovered without replay. Gas caps, low liquidity or the owner floor can delay payouts.

## Validation and remaining acceptance

| Check | Command/evidence | Scope |
| --- | --- | --- |
| Application tests | `npm test` | Runtime/tools, reservation/recovery, queue/pool, wallet/market, auth, social and funding fixtures |
| Contract dependencies | `node scripts/install-contract-deps.mjs --check` | Exact pinned dependency identities |
| Solidity | `forge test --root contracts` | Market, hook, router, main liquidity NFT, permanent agent liquidity, treasury, escrow and fuzz checks |
| Local market | `node scripts/check-local-market.mjs` | Disposable Anvil launch, quotes/swaps, fee claims and recovery |
| Local receipts | `node scripts/check-local-revenue.mjs` | Exact 70/20/10 receipt delivery |
| Ethereum wallet-flow fork | `node scripts/check-mainnet-wallet-flow.mjs` | Disposable fork; unsigned intents, receipt verification and real PoolManager behavior |
| Fee keeper and runway fork | `node scripts/check-fee-keeper-fork.mjs` | Real local-fork swaps/fees/treasury payment; fixture zkAPI activation and model response |
| Mainnet preparation | `node scripts/preflight-mainnet.mjs --offline` | Public configuration/artifacts; no signer or broadcast interface |
| Upstream code read | `node scripts/check-mainnet.mjs` | Manifest and deployed upstream code identity, without spending |
| Website | `node scripts/check-web.mjs` | Local read-only page/asset/anchor checks |

The refreshed native wallet-flow fork passed at Ethereum block **26,100,949**: quoter, three creation helpers, factory, protected Veyl market launch with oversized-buy rejection, buy, finite approval, sell, hook flush and all three claims. `output/mainnet-protected-wallet-fork/report.json` records **zero external broadcasts and zero real funds spent**. Opt-in Solidity fork suites use `VEYL_MAINNET_FORK=true`; they are separate from a deployed release.

The dual-market fork passed at Ethereum block **26,100,945**, including main VEYL/ETH and agent/VEYL launch, finite VEYL approvals, buys/sells, collection, full fee conversion and exact ETH 70/20/10 delivery. `node scripts/check-agent-market-fork.mjs` uses only disposable Anvil accounts; its saved report records zero public transactions, zero real funds and zero paid inference calls.

The automatic-funding fork passed at block **26,100,799**: 0.0009 ETH in swap fees delivered exactly 0.00063 / 0.00018 / 0.00009 ETH to treasury/creator/platform. A separately constrained treasury operator automatically paid 0.00001 ETH under the saved policy, funding a simulated zkAPI activation and one fixture runner call. All transactions used disposable local Anvil ETH; no live zkAPI completion or public transaction occurred.

On **1 October 2026**, native ARM64 daemon/companion checks returned **389 catalog models** without funding. The installed bounded worker serves the authenticated gateway, and live wallet-session isolation, replay denial, CSRF denial and logout were checked. These checks did not perform paid inference, proof generation, social publishing or sustained funded load. Those initial checks preceded the market deployments.

On **2 October 2026**, the main VEYL market and shared agent factory were deployed on Ethereum, with all 19 contracts verified on Etherscan. Main liquidity NFT **429089** was transferred to the dead address; its liquidity and separate hook fees remain intact. A fresh fork at block **26,102,065** exercised a customer launch through the deployed shared factory, buys/sells, fee conversion and exact ETH allocation. Public no-spend acceptance confirmed wallet isolation, shared-factory readiness, the 389-model catalog, installed SDK reads, and MCP discovery plus project reads with nine tools exposed. At that earlier release, the application suite passed 469 tests. These checks did not perform paid inference or real social publishing.

The fixed-policy agent factory and its three child deployers were subsequently confirmed at block **26,105,962** and verified on Etherscan, with runtime hashes checked at **26,105,973**. New hosted launches use this factory; existing legacy markets retain their bindings. Its ordinary Solidity suite passed 124 tests with eight opt-in fork cases skipped. Separate Ethereum forks covered the canonical pool path at **26,105,693** and the actual JavaScript approval, atomic creator buy, receipt import, trading and fee-conversion path at **26,105,748**. These rehearsals used no real funds.

Real paid inference, settlement/recovery and social publishing remain untested in release acceptance. The hosted worker now allows owner-approved manual funding and social publishing; each project still needs its own funding and social connections, and publication follows explicit manual approval or an owner-enabled automatic posting rule. Automatic fee, conversion and treasury operators remain disabled. Before expanding funded operation, complete bounded provider acceptance, measure proof CPU/RAM and sustained capacity, and review contracts and operations independently. The installed accounting extension requires its matching native build; passing configuration checks alone does not establish funded readiness.

## Recovery and code map

Run one worker per state directory. Preserve private notes, funding intents, runway records and transaction hashes. Confirm the old process and daemon children have stopped before removing a stale process lock. Use `scripts/backup-runtime.mjs`; restore only into an empty directory. Restored state is quarantined until chain/notes/pending operations are reconciled. Never delete journals to clear a billing error.

| Path | Responsibility |
| --- | --- |
| `public/app.js`, `public/panels.js`, `public/mainnet-panel.js` | Workspace, project controls and reviewed market intents |
| `public/wallet.js`, `public/chain-client.js` | Wallet/session boundary and pending transaction recovery |
| `public/runway-panel.js`, `public/social-panel.js` | Reviewed treasury/recovery controls, expiry notice and social connections |
| `src/kit.mjs`, `src/store.mjs`, `src/scheduler.mjs` | Workflows, conservative reservations and durable global dispatch |
| `src/production.mjs`, `src/runtime-provision.mjs` | Tenant API, isolated profiles and bounded daemon leases |
| `src/auth.mjs`, `src/encrypted-state.mjs`, `api/gateway.mjs` | Wallet sessions, encrypted persistence and signed gateway |
| `src/provider.mjs`, `src/agent-tools.mjs` | zkAPI adapter and bounded model tools |
| `src/mainnet.mjs`, `src/market.mjs` | Unsigned mainnet plans and separate Anvil execution |
| `src/funding.mjs`, `src/funding-operations.mjs`, `src/runway.mjs` | Funding, withdrawal/return and bounded treasury runway |
| `src/note-expiry.mjs`, `src/fee-keeper.mjs`, `src/fee-operator.mjs` | Canonical note-expiry guard and disabled bounded fee maintenance |
| `src/social.mjs` | Owner-approved social outbox and provider connections |
| `contracts/src`, `deployment` | Contracts and operator setup/recovery |

## Developer access

The hosted Developer tab issues one-time, project-bound tokens with read/jobs/memory/drafts scopes and expiry. Read-only is the default; jobs can consume the existing funded inference allowance. API credentials cannot fund wallets, trade, change treasury policy, approve drafts or publish. The SDK and local stdio MCP adapter share the versioned `@veyl/sdk` package at `packages/veyl`; distribution is a downloadable site tarball, not npm registry publication. See `/developers` for installation, exact request-key recovery and the HTTP API. Unknown mutation outcomes are never retried automatically.
