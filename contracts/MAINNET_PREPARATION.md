# Mainnet deployment and validation status

The main VEYL market, legacy agent factory and fixed-policy agent factory are deployed and verified on Ethereum. Main liquidity NFT #429089 is held by the dead address; agent positions use permanent ownerless vaults. The contracts also implement operating treasuries, fixed revenue allocation, swap hooks, exact-input routing, quotes and a standalone customer-controlled job escrow. Local and fork tests cover these mechanisms; real paid zkAPI, funded recovery and social-provider acceptance remain separate unperformed checks. Public deployment evidence is in `../config/public-addresses.json`, `../config/main-liquidity-lock.json`, `../config/agent-market-infrastructure.json` and `../config/standard-agent-infrastructure.json`.

## Approved economics

`RevenueRouter` credits 70% of received ETH to the agent treasury, 20% to the creator and the remaining 10% to the protocol. Treasury and creator shares round down for each receipt; the protocol receives residual wei. The percentages are constants and cannot be changed after deployment. These are allocations of collected revenue, not percentages of trading volume.

The platform VEYL/ETH market collects native ETH directly. Agent/VEYL markets collect VEYL into `QuoteRevenueRouter`, which reserves the entire receipt for conversion through the fixed main VEYL/ETH router. Only actual ETH received after that conversion is split 70/20/10 into independent ETH claims. Creator and platform claims never pay VEYL. Conversion starts disabled; the treasury owner sets an executor, per-conversion and daily VEYL ceilings and a minimum ETH-per-VEYL floor. Every conversion also has an output minimum and a deadline of at most five minutes. Price limits, insufficient liquidity or unsettled outcomes can delay conversion. This is a real swap with price impact and the main pool's fees, not a guaranteed exchange rate.

Market factories create a revenue router for each project. Initial treasury deposits bypass that router and fund the operating treasury in full. The project token has no transfer tax. The original `AgentFactory` remains compatible and allocates all one-billion tokens to its caller without creating a market. The legacy `VeylMarketFactory` allocates actual seed tokens to the selected liquidity module and the remainder to the creator. New `VeylAgentLaunchFactory` launches allocate the whole supply to permanent liquidity, retaining any bounded rounding dust in the same vault and delivering no free creator allocation. Agent positions use the permanent vault; the main VEYL position uses a canonical PositionManager NFT minted to the deployer. Treasury ownership includes the ability to withdraw operating funds; operating funds are separate from either liquidity arrangement.

The active `config/mainnet.json` uses 180 basis points on buys and sells, zero LP fee and tick spacing 1 for the main token and new fixed-policy agent launches. Legacy agent markets retain spacing 200 and their recorded launch parameters. Local legacy examples use 300 basis points and do not define production terms. The hook charges the factory's fixed quote currency, and beneficiary payouts apply the approved 70/20/10 split to collected or converted ETH. There is no creator fee exemption or launch snipe-tax window.

## Active fixed-policy agent factory

`VeylAgentLaunchFactory` at [`0x5391727eC9726f3d5F3c77d7468521a48E0A7AEa`](https://etherscan.io/address/0x5391727eC9726f3d5F3c77d7468521a48E0A7AEa#code) was confirmed in [transaction `0xa7e7e8099daa1258eb0cfb43d6da873c93e53d03e340b9d4548eea20db4050e0`](https://etherscan.io/tx/0xa7e7e8099daa1258eb0cfb43d6da873c93e53d03e340b9d4548eea20db4050e0) at block 26,105,962. The factory and its three child deployers are verified, with exact runtime hashes recorded in `../config/standard-agent-infrastructure.json`. `LAUNCH_POLICY_VERSION` is 2; the application records these markets as `standard-agent-v1`.

Every launch fixes 1B supply, 100% allocated to a permanent token-only agent/VEYL position, zero quote seed, zero free creator allocation, 1.8% buy/sell hook fees, zero LP fee, spacing 1 and no early token caps. The largest affordable liquidity amount is seeded; at most 1,000,000 token wei of integer rounding dust is re-locked in the same vault. Seeded tokens plus locked dust equal the entire supply. No factory refund creates a free creator allocation. `launchAndBuy` optionally pulls an exact approved VEYL amount for an atomic creator buy, charges the normal hook fee and enforces a positive minimum output and deadline.

`standardLaunchConfig` derives economic fields from the canonical main VEYL/ETH spot price, targeting a 2 ETH initial total valuation. Tick rounding applies, and launch rechecks a 50-bps bound against the current reference. This is a manipulable spot reference, not a TWAP or independent valuation oracle. Saved terms are not silently repriced. Existing main VEYL and legacy agent markets keep their original bindings; the immutable legacy factory remains callable directly.

## Reproduce the checks

Run from `zk-agent-prototype`:

```powershell
$forgePath = Join-Path $HOME '.foundry\bin\forge.exe'
& $forgePath test --root contracts
& $forgePath build --root contracts --sizes
& $forgePath fmt --root contracts --check
node --test contracts/preflight-mainnet.test.mjs
node contracts/export-abi.mjs
node scripts/preflight-mainnet.mjs --offline
node scripts/preflight-mainnet.mjs
```

The mainnet-fork acceptance is explicitly skipped in the ordinary suite. To opt in to public RPC reads and local EVM simulation:

```powershell
$env:VEYL_MAINNET_FORK='true'
$forgePath = Join-Path $HOME '.foundry\bin\forge.exe'
& $forgePath test --root contracts --match-contract 'Veyl.*MainnetForkTest' -vv
Remove-Item Env:\VEYL_MAINNET_FORK
```

These tests pin Ethereum block `26,100,053`, deploy fixtures only inside the test VM, and exercise complete atomic market creation, quotes, VeylSwapRouter buys/sells, native-ETH settlement, ERC-6909 fee redemption and exact 70/20/10 beneficiary balance changes against the deployed PoolManager. They use public archive reads through `https://eth.drpc.org`; network availability is required. No signer is used, no transactions are sent and nothing is funded on Ethereum. Their swap rates are test fixtures only.

The preflight reads `config/mainnet.example.json` unless `--config <public-config.json>` is supplied. It never reads environment files, accesses accounts, signs messages, broadcasts transactions, or funds anything. Do not put private keys, seed phrases, auth tokens, or credential-bearing URLs in this file. Unknown fields and key-sized hexadecimal values are rejected without reflecting their contents.

Exit code `2` means the report ran but deployment is blocked. Exit code `1` means the command/configuration failed. `deploymentReady` remains false even if every configuration value is present: missing integrations cannot be resolved by changing a flag. The example deliberately leaves undecided values null and does not invent recipient wallets or trading fees.

`scripts/check-mainnet.mjs` separately verifies the public zkAPI manifest and compares the vault and verifier bytecode at one recorded Ethereum block. This checks correspondence with the operator's manifest. It does not establish independent circuit provenance, security audit completion, privacy beyond documented boundaries, or successful funded inference/withdrawal/recovery.

## Implemented hook and trading integration

`src/hook/VeylFeeHook.sol` binds one sorted native-ETH/token or VEYL/agent PoolKey, including fixed LP fee and tick spacing, to an immutable PoolManager and revenue router. Its constructor validates contract addresses, quote currency, the approved allocation, static LP fees below 100%, tick spacing and immutable buy/sell rates below 100%. The general hook accepts deployment inputs; the active fixed-policy agent factory enforces 180 basis points on both sides. Legacy test values are not adopted mainnet fees. There are no owner privileges, fee setters or exemptions. The authorized initializer prevents another party from initializing the intended pool first at an arbitrary price.

During swaps the hook mints ERC-6909 claims in the quote currency, so initial buying does not require the PoolManager to hold that physical asset before settlement. Anyone can call `flushFees()` outside an existing manager unlock. Native ETH receipts credit the 70/20/10 claims immediately; VEYL receipts use an exact temporary allowance into `QuoteRevenueRouter.deposit`, then await bounded conversion. The allowance is reset to zero. Flush and conversion do not call beneficiaries. Failed individual payouts cannot interrupt trading or fee accrual. A nested flush during an active manager unlock reverts and preserves claims. Unsolicited assets are not treated as accrued fee revenue.

| Swap mode | Hook fee calculation | Partial fill behavior |
| --- | --- | --- |
| Buy exact input | Floor of total specified quote input times buy rate | Reverts unless the pool consumes the post-fee input completely |
| Buy exact output | Ceiling of executed pool quote input times rate / (10,000 minus rate) | Allowed; charges only actual executed quote |
| Sell exact input | Floor of executed gross quote output times sell rate | Allowed; charges only actual executed quote |
| Sell exact output | Ceiling of requested net quote output times rate / (10,000 minus rate) | Reverts unless requested net quote plus fee is fully supplied by the pool |

Gross-up modes express the fee as a fraction of total quote currency. Rounding is per swap and can dominate very small trades. UI quotes and slippage limits must include hook fees, LP fees and these fill-or-revert constraints. The hook's low address bits are validated against its enabled callbacks; the test suite includes a real mined CREATE2 deployment.

`src/VeylSwapRouter.sol` binds one immutable VeylFeeHook and its PoolManager/PoolKey. `buy(quoteAmountIn, minTokensOut, sqrtPriceLimitX96, deadline)` consumes the full quote input or reverts. Native buys require that exact `msg.value`; VEYL buys require zero ETH and an ERC-20 allowance. `sell(tokenAmountIn, minQuoteOut, sqrtPriceLimitX96, deadline)` pulls only the tokens consumed and returns actual input and net quote output; unused tokens stay with the caller. Both minimum outputs must be positive and apply after fees. Currency direction follows sorted addresses. Funding and output are fixed to the caller, with no arbitrary payer, recipient or route. The guarded callback consumes an internally stored request once; there is no admin sweep or standing PoolManager allowance. Transfer-tax and rebasing assets are rejected by exact settlement checks.

Deploy and verify `VeylQuoter(poolManager)` and the three manager-bound creation helpers `VeylProjectBuilder`, `VeylMarketBuilder` and a liquidity builder first. The main preset uses `VeylMainLiquidityBuilder(poolManager, positionManager, creator, canonicalSalt)`; agent markets use `VeylLiquidityBuilder(poolManager)`. The factory constructor is `(poolManager, protocol, quoter, quoteAsset, conversionSwapRouter, projectBuilder, marketBuilder, liquidityBuilder)`. Native factories use zero quote/conversion addresses; agent factories bind the reviewed VEYL asset and main VEYL/ETH router permanently. A launch cannot choose another quote token. The constructor checks declared relationships; the deployment client must also verify helper/router runtime identities. Each helper binds its child module's authority to its caller and holds no assets. Splitting the modules keeps runtime and initialization code within Ethereum limits without via-IR.

`src/market/VeylMarketFactory.sol` connects each project's market path in one reverting launch transaction. Creator is the caller, treasury owner is explicit, and `id = keccak256(abi.encode(creator, config.salt))`. `predictLaunch` returns every contract address, quote asset, pool ID and hook initialization hash. The hook's effective CREATE2 salt is `keccak256(abi.encode(id, hookSalt))`, deployed by `factory.marketDeployer()`. Its low 14 address bits must equal `0x20cc`. The separate factory-only liquidity deployer creates either the agent permanent vault or the main-only PositionManager adapter. The main deployer pins the creator, name, symbol, salt, protection, ETH quote, fees and exact approved seed economics. The factory immediately initializes and seeds the pool, preventing another caller from interposing a different initial price.

For the legacy `VeylMarketFactory`, `launch(config, hookSalt)` requires `msg.value == config.treasuryEth + config.maxQuote` for native markets, and only `config.treasuryEth` for VEYL markets. An agent launch also needs a VEYL allowance covering `maxQuote`; the factory transfers it directly into the new vault with exact balance checks. The creator chooses initial price, range, liquidity and `minToken/maxToken/minQuote/maxQuote` bounds. At least one token wei must be required in the seed. Only actually consumed seed assets enter the position; unused inputs and the remaining one-billion token supply return to the creator. Agent positions are permanently locked. Main-token liquidity remains controlled by its NFT owner until ownership is relinquished. Any funding, minimum, salt, initialization, settlement or refund failure reverts every deployment and movement. There is no partial launch.

`LaunchConfig.launchProtection` is an immutable per-token choice. The reviewed Veyl/VEYL main-token preset requires it; generic agent markets default to false. ERC-20 transfers and per-address ERC-20 balances are capped at 20 million tokens (2%) for blocks B through B+9, ending at B+10. Only the fixed PoolManager recipient is exempt from the wallet cap; buys from the PoolManager still obey both limits and the creator has no exemption. Bootstrap transfers are limited to atomic seeding/refunds, then activation precedes delivery of the creator remainder. At least 980 million tokens must therefore actually enter liquidity after refunds. The approved main seed rounds liquidity up within a 1,000,000 token-wei bound so the creator never exceeds 20 million tokens. Incompatible seed terms revert. Before activation, swaps are blocked regardless of router. After activation, external Uniswap v4 routers and bot settlement contracts are permitted immediately, including during the ten-block window. There is no router allowlist, mutable cap, whitelist setter or later reactivation.

The caps apply to each ERC-20 transfer and recipient balance, not aggregate economic ownership. ERC-6909 claim balances, claim-settled trades, wrapped positions and holdings spread across addresses are outside their scope and can exceed 2%. Converting claims to ERC-20 tokens during the protected window still invokes the token's transfer and wallet caps. The tests exercise Uniswap core's external `PoolSwapTest` and `PoolClaimsTest` contracts; this establishes v4 settlement compatibility, not automatic listing or route discovery in the Uniswap website or every bot.

`VeylLiquidityVault`, used by agent markets, owns one v4 position forever. It has no administrator, transfer, liquidity removal, LP-fee collection or withdrawal method. It is seeded once by the factory; only unused inputs from that same call can be refunded. The new fixed-policy factory receives any such token rounding refund itself and permanently transfers it back to the vault before launch completes. The chosen range can become inactive as price moves; this is not automatically full-range liquidity. If the configured LP fee is nonzero, those LP fees also remain locked. The separate hook fees remain available through RevenueRouter. With the zero-LP-fee preset, no LP swap fee accumulates.

`factory.quoter()` exposes `quoteExactInput(hook, buy, amountIn, sqrtPriceLimitX96)` for `eth_call`/`simulateContract`. It simulates the actual PoolManager swap then deliberately reverts the inner call, rolling back prices, balances and hook claims before returning consumed input, net output, hook fee and resulting price/tick/liquidity. It needs no allowance or funds. `getPoolState(hook)` returns current price/tick/active liquidity; `previewSeed` and `previewLiquidity` use sorted currency0/currency1 amounts. Clients map quote/token amounts using `tokenIsCurrency0`; the price is always sqrt(currency1/currency0). A quote does not reserve a price; executing callers still need output minimums and deadlines.

The main-token liquidity plan uses zero ETH, a 980 million VEYL target, ticks -887272 through 200311, spacing 1 and initial sqrt price 1771577727172025373304338615273325 at the upper boundary. Its target 2 ETH FDV becomes 2.000040289648088261 ETH at that tick. Liquidity is 43827373799693085948824 units, consuming 980000000000000000000012538 token wei and leaving 19999999999999999999987462 token wei to the creator.

`VeylMainLiquidityPosition` uses canonical PositionManager 0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e and Permit2 0x000000000022D473030F116dDEE9F6B43aC78BA3. Bootstrap tokens travel directly from the adapter to PoolManager. The adapter verifies the new NFT owner, seeded liquidity, token spend and zero leftovers, then clears both approvals. Its `lockedLiquidity` getter exists only for the shared seed ABI and records the original amount; live NFT ownership and liquidity must be read from PositionManager. Main NFT #429089 was transferred to the dead address in the confirmed transaction recorded in `../config/main-liquidity-lock.json`; this did not change the separate hook fee routing.

Remaining funded acceptance concerns operating budgets, paid inference and withdrawal/recovery. Infrastructure deployment and explorer verification are recorded separately from those checks. The ordinary tests deploy the actual installed PoolManager source; the separate opt-in fork tests exercise deployed Ethereum state. A received transfer into RevenueRouter alone is not evidence of swap-fee collection.

Current official documentation lists Ethereum chain 1 PoolManager as `0x000000000004444c5dc75cB358380D2e3dE08A90`; the pinned fork test checks and calls its deployed code. Recheck the deployment when preparing actual launch transactions. Sources checked 2026-10-01: [deployments](https://developers.uniswap.org/docs/protocols/v4/deployments), [hooks](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks), [ERC-6909](https://developers.uniswap.org/docs/protocols/v4/concepts/erc-6909).

## Missing runtime and operational acceptance

A completed mainnet path must also demonstrate capped treasury-to-zkAPI funding, a paid model/tool request, conservative budget accounting, uncertain-response recovery, and withdrawal/escape recovery. The Veyl native accounting extension provides signed, durable per-call receipts bound to the original session and valuation. The runtime applies exact receipt charges once and releases unused reservations; uncertain and legacy ceilings remain held. Local/native tests and unfunded deployment checks cover this path, but funded provider acceptance remains unperformed. Define daemon hosting, note/key custody, process recovery and allowed recipients before allocating real operating funds. Fee income is variable and can stop; prepaid inference consumes ETH and does not produce recurring staking credits. No live funded acceptance is recorded.

Use a fresh signer established in secure wallet software. Never reuse a signing key that was exposed in conversation. Public recipient addresses and transaction intent can be reviewed without revealing signing material. Deployment, liquidity funding, recipient permissions and source verification require a separate concrete reviewed transaction plan.

## Fixed-policy factory validation

- The ordinary Solidity suite passed 124 tests with eight opt-in fork cases skipped, including 15 fixed-policy cases and two 256-run fuzz tests.
- A canonical Ethereum fork at block 26,105,693 checked new-factory launches and first-buy behavior. The actual JavaScript integration passed at block 26,105,748, including finite creator-buy approval, atomic launch, exact receipt import, market status, sell, fee conversion and ETH claims. These rehearsals sent no public transactions and spent no real funds.
- The actual factory deployment confirmed at block 26,105,962. All four new runtime identities were rechecked and source verification succeeded at block 26,105,973. This evidence does not establish funded inference or an independent security audit.

## Earlier main-token validation

- The ordinary Foundry suite passes 109 tests, with seven opt-in fork cases skipped. It covers hooks, all swap modes, agent fee conversion, permanent agent positions, treasury accounting, escrow, early token caps and fuzz checks.
- Five main-position fork tests pass against canonical Ethereum PositionManager and Permit2 at block 26,100,053. They cover token-only minting, exact rounded allocation, direct NFT ownership, cleared approvals, manual dead-address transfer, removable liquidity before that transfer, first buy/sell fees and launch caps. Existing agent/VEYL regression cases also pass.
- The actual JavaScript wallet path passes on a disposable Ethereum fork at block 26,101,566: five infrastructure transactions, unsigned launch preparation, exact receipt checks, NFT mint, buys/sells, finite approvals, 70/20/10 ETH claims and NFT transfer/status verification. No public transaction was broadcast and no real funds were spent.
- All 20 compiled contracts fit runtime and initcode limits; formatting checks pass with Solidity 0.8.26, optimizer 200 and Cancun. All 20 public ABIs were regenerated from these artifacts.
- Public-config tests check approved main economics, canonical address inputs, NFT recipient, zero ETH seed and bounded rounding. The verification tool supports the three additional main-position contracts while retaining exact source and constructor checks.
- Application and native-accounting tests cover local fixtures and recovery behavior. Funded inference, social-provider publishing and recovery acceptance remain outside the performed tests.

Re-run these checks after source or dependency changes. These are local and fork correctness checks, not an independent production security audit.
