# Mainnet preparation status

The contracts implement atomic market creation, project tokens, operating treasuries, fixed revenue allocation, permanently locked liquidity, a Uniswap v4 fee hook, an exact-input swap router, a revert-based quote service and a standalone customer-controlled job escrow. Tests use the real PoolManager implementation plus opt-in tests against the deployed Ethereum PoolManager at a pinned block. Approved launch configuration, production application rehearsal and funded zkAPI acceptance are still required. No Veyl mainnet deployment is recorded by this project.

## Approved economics

`RevenueRouter` credits 70% of received ETH to the agent treasury, 20% to the creator and the remaining 10% to the protocol. Treasury and creator shares round down for each receipt; the protocol receives residual wei. The percentages are constants and cannot be changed after deployment. These are allocations of collected revenue, not percentages of trading volume.

The platform VEYL/ETH market collects native ETH directly. Agent/VEYL markets collect VEYL into `QuoteRevenueRouter`, which reserves the entire receipt for conversion through the fixed main VEYL/ETH router. Only actual ETH received after that conversion is split 70/20/10 into independent ETH claims. Creator and platform claims never pay VEYL. Conversion starts disabled; the treasury owner sets an executor, per-conversion and daily VEYL ceilings and a minimum ETH-per-VEYL floor. Every conversion also has an output minimum and a deadline of at most five minutes. Price limits, insufficient liquidity or unsettled outcomes can delay conversion. This is a real swap with price impact and the main pool's fees, not a guaranteed exchange rate.

Both factories create a revenue router for each project. Initial treasury deposits bypass that router and fund the operating treasury in full. The project token has no transfer tax. The original `AgentFactory` remains compatible and allocates all one-billion tokens to its caller without creating a market. The new `VeylMarketFactory` allocates actual seed tokens to permanent liquidity and the entire remainder to the creator. Treasury ownership includes the ability to withdraw operating funds; that treasury is distinct from the permanently locked liquidity vault.

The public draft `config/mainnet.json` uses 180 basis points on buys and sells, zero LP fee and tick spacing 200. Local agent examples use 300 basis points. The hook charges the factory's fixed quote currency, and beneficiary payouts apply the approved 70/20/10 split to collected or converted ETH. There is no creator exemption or launch snipe-tax window. No arbitrary contract parameter is silently fixed to these examples.

## Reproduce the checks

Run from `zk-agent-prototype`:

```powershell
& C:\Users\operator\.foundry\bin\forge.exe test --root contracts
& C:\Users\operator\.foundry\bin\forge.exe build --root contracts --sizes
& C:\Users\operator\.foundry\bin\forge.exe fmt --root contracts --check
node --test contracts/preflight-mainnet.test.mjs
node contracts/export-abi.mjs
node scripts/preflight-mainnet.mjs --offline
node scripts/preflight-mainnet.mjs
```

The mainnet-fork acceptance is explicitly skipped in the ordinary suite. To opt in to public RPC reads and local EVM simulation:

```powershell
$env:VEYL_MAINNET_FORK='true'
& C:\Users\operator\.foundry\bin\forge.exe test --root contracts --match-contract 'Veyl.*MainnetForkTest' -vv
Remove-Item Env:\VEYL_MAINNET_FORK
```

These tests pin Ethereum block `26,100,053`, deploy fixtures only inside the test VM, and exercise complete atomic market creation, quotes, VeylSwapRouter buys/sells, native-ETH settlement, ERC-6909 fee redemption and exact 70/20/10 beneficiary balance changes against the deployed PoolManager. They use public archive reads through `https://eth.drpc.org`; network availability is required. No signer is used, no transactions are sent and nothing is funded on Ethereum. Their swap rates are test fixtures only.

The preflight reads `config/mainnet.example.json` unless `--config <public-config.json>` is supplied. It never reads environment files, accesses accounts, signs messages, broadcasts transactions, or funds anything. Do not put private keys, seed phrases, auth tokens, or credential-bearing URLs in this file. Unknown fields and key-sized hexadecimal values are rejected without reflecting their contents.

Exit code `2` means the report ran but deployment is blocked. Exit code `1` means the command/configuration failed. `deploymentReady` remains false even if every configuration value is present: missing integrations cannot be resolved by changing a flag. The example deliberately leaves undecided values null and does not invent recipient wallets or trading fees.

`scripts/check-mainnet.mjs` separately verifies the public zkAPI manifest and compares the vault and verifier bytecode at one recorded Ethereum block. This checks correspondence with the operator's manifest. It does not establish independent circuit provenance, security audit completion, privacy beyond documented boundaries, or successful funded inference/withdrawal/recovery.

## Implemented hook and remaining trading integration

`src/hook/VeylFeeHook.sol` binds one sorted native-ETH/token or VEYL/agent PoolKey, including fixed LP fee and tick spacing, to an immutable PoolManager and revenue router. Its constructor validates contract addresses, quote currency, the approved allocation, static LP fees below 100%, tick spacing and immutable buy/sell rates below 100%. The rates are deployment inputs; test values are not adopted mainnet fees. There are no owner privileges, fee setters or exemptions. The authorized initializer prevents another party from initializing the intended pool first at an arbitrary price.

During swaps the hook mints ERC-6909 claims in the quote currency, so initial buying does not require the PoolManager to hold that physical asset before settlement. Anyone can call `flushFees()` outside an existing manager unlock. Native ETH receipts credit the 70/20/10 claims immediately; VEYL receipts use an exact temporary allowance into `QuoteRevenueRouter.deposit`, then await bounded conversion. The allowance is reset to zero. Flush and conversion do not call beneficiaries. Failed individual payouts cannot interrupt trading or fee accrual. A nested flush during an active manager unlock reverts and preserves claims. Unsolicited assets are not treated as accrued fee revenue.

| Swap mode | Hook fee calculation | Partial fill behavior |
| --- | --- | --- |
| Buy exact input | Floor of total specified quote input times buy rate | Reverts unless the pool consumes the post-fee input completely |
| Buy exact output | Ceiling of executed pool quote input times rate / (10,000 minus rate) | Allowed; charges only actual executed quote |
| Sell exact input | Floor of executed gross quote output times sell rate | Allowed; charges only actual executed quote |
| Sell exact output | Ceiling of requested net quote output times rate / (10,000 minus rate) | Reverts unless requested net quote plus fee is fully supplied by the pool |

Gross-up modes express the fee as a fraction of total quote currency. Rounding is per swap and can dominate very small trades. UI quotes and slippage limits must include hook fees, LP fees and these fill-or-revert constraints. The hook's low address bits are validated against its enabled callbacks; the test suite includes a real mined CREATE2 deployment.

`src/VeylSwapRouter.sol` binds one immutable VeylFeeHook and its PoolManager/PoolKey. `buy(quoteAmountIn, minTokensOut, sqrtPriceLimitX96, deadline)` consumes the full quote input or reverts. Native buys require that exact `msg.value`; VEYL buys require zero ETH and an ERC-20 allowance. `sell(tokenAmountIn, minQuoteOut, sqrtPriceLimitX96, deadline)` pulls only the tokens consumed and returns actual input and net quote output; unused tokens stay with the caller. Both minimum outputs must be positive and apply after fees. Currency direction follows sorted addresses. Funding and output are fixed to the caller, with no arbitrary payer, recipient or route. The guarded callback consumes an internally stored request once; there is no admin sweep or standing PoolManager allowance. Transfer-tax and rebasing assets are rejected by exact settlement checks.

Deploy and verify `VeylQuoter(poolManager)` and the three manager-bound creation helpers `VeylProjectBuilder`, `VeylMarketBuilder` and `VeylLiquidityBuilder` first. The factory constructor is `(poolManager, protocol, quoter, quoteAsset, conversionSwapRouter, projectBuilder, marketBuilder, liquidityBuilder)`. Native factories use zero quote/conversion addresses; agent factories bind the reviewed VEYL asset and main VEYL/ETH router permanently. A launch cannot choose another quote token. The constructor checks declared relationships; the deployment client must also verify helper/router runtime identities. Each helper binds its child module's authority to its caller and holds no assets. Splitting the modules keeps runtime and initialization code within Ethereum limits without via-IR.

`src/market/VeylMarketFactory.sol` connects each project's market path in one reverting launch transaction. Creator is the caller, treasury owner is explicit, and `id = keccak256(abi.encode(creator, config.salt))`. `predictLaunch` returns every contract address, quote asset, pool ID and hook initialization hash. The hook's effective CREATE2 salt is `keccak256(abi.encode(id, hookSalt))`, deployed by `factory.marketDeployer()`. Its low 14 address bits must equal `0x20cc`. The separate factory-only liquidity deployer creates the permanently locked vault. The factory immediately initializes and seeds the pool, preventing another caller from interposing a different initial price.

`launch(config, hookSalt)` requires `msg.value == config.treasuryEth + config.maxQuote` for native markets, and only `config.treasuryEth` for VEYL markets. An agent launch also needs a VEYL allowance covering `maxQuote`; the factory transfers it directly into the new vault with exact balance checks. The creator chooses initial price, range, liquidity and `minToken/maxToken/minQuote/maxQuote` bounds. At least one token wei must be required in the seed. Only actually consumed seed assets are locked; unused inputs and the remaining one-billion token supply return to the creator. Any funding, minimum, salt, initialization, settlement or refund failure reverts every deployment and movement. There is no partial launch.

`LaunchConfig.launchProtection` is an immutable per-token choice. The reviewed Veyl/VEYL main-token preset requires it; generic agent markets default to false. ERC-20 transfers and per-address ERC-20 balances are capped at 20 million tokens (2%) for blocks B through B+9, ending at B+10. Only the fixed PoolManager recipient is exempt from the wallet cap; buys from the PoolManager still obey both limits and the creator has no exemption. Bootstrap transfers are limited to atomic seeding/refunds, then activation precedes delivery of the creator remainder. At least 980 million tokens must therefore actually enter locked liquidity after refunds. Incompatible seed terms revert; this constraint does not approve production amounts. Before activation, swaps are blocked regardless of router. After activation, external Uniswap v4 routers and bot settlement contracts are permitted immediately, including during the ten-block window. There is no router allowlist, mutable cap, whitelist setter or later reactivation.

The caps apply to each ERC-20 transfer and recipient balance, not aggregate economic ownership. ERC-6909 claim balances, claim-settled trades, wrapped positions and holdings spread across addresses are outside their scope and can exceed 2%. Converting claims to ERC-20 tokens during the protected window still invokes the token's transfer and wallet caps. The tests exercise Uniswap core's external `PoolSwapTest` and `PoolClaimsTest` contracts; this establishes v4 settlement compatibility, not automatic listing or route discovery in the Uniswap website or every bot.

`VeylLiquidityVault` owns one v4 position forever. It has no administrator, transfer, liquidity removal, LP-fee collection or withdrawal method. It is seeded once by the factory; only unused inputs from that same call can be refunded. The chosen range can become inactive as price moves; this is not automatically full-range liquidity. If the configured LP fee is nonzero, those LP fees also remain locked. The separate hook fees remain available through RevenueRouter. With the zero-LP-fee preset, no LP swap fee accumulates.

`factory.quoter()` exposes `quoteExactInput(hook, buy, amountIn, sqrtPriceLimitX96)` for `eth_call`/`simulateContract`. It simulates the actual PoolManager swap then deliberately reverts the inner call, rolling back prices, balances and hook claims before returning consumed input, net output, hook fee and resulting price/tick/liquidity. It needs no allowance or funds. `getPoolState(hook)` returns current price/tick/active liquidity; `previewSeed` and `previewLiquidity` use sorted currency0/currency1 amounts. Clients map quote/token amounts using `tokenIsCurrency0`; the price is always sqrt(currency1/currency0). A quote does not reserve a price; executing callers still need output minimums and deadlines.

Still required: approve the intended initial distribution, amounts, price range and funding; rehearse the production application with the actual planned deployment; and complete funded inference/recovery acceptance. The ordinary tests deploy the actual installed PoolManager source; the separate opt-in fork tests exercise deployed Ethereum state. A received transfer into RevenueRouter alone is not evidence of swap-fee collection.

Current official documentation lists Ethereum chain 1 PoolManager as `0x000000000004444c5dc75cB358380D2e3dE08A90`; the pinned fork test checks and calls its deployed code. Recheck the deployment when preparing actual launch transactions. Sources checked 2026-10-01: [deployments](https://developers.uniswap.org/docs/protocols/v4/deployments), [hooks](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks), [ERC-6909](https://developers.uniswap.org/docs/protocols/v4/concepts/erc-6909).

## Missing runtime and operational acceptance

A completed mainnet path must also demonstrate capped treasury-to-zkAPI funding, a paid model/tool request, conservative budget accounting, uncertain-response recovery, and withdrawal/escape recovery. Exact verified final-charge reconciliation for each Veyl job remains unavailable through the pinned daemon interface; retained request ceilings must not be presented as actual bills. Define daemon hosting, note/key custody, process recovery and allowed recipients before allocating real operating funds. Fee income is variable and can stop; prepaid inference consumes ETH and is not recurring DIEM-style staking credit. No live funded acceptance is recorded.

Use a fresh signer established in secure wallet software. Never reuse a signing key that was exposed in conversation. Public recipient addresses and transaction intent can be reviewed without revealing signing material. Deployment, liquidity funding, recipient permissions and source verification require a separate concrete reviewed transaction plan.

## Validation recorded in this pass

- The original 21 Solidity tests cover treasuries, allocation, escrow and reentrancy. An additional 19 hook integration tests cover all four swap modes, exact rejection reasons, partial fills, unfunded initial ETH settlement, constructor/pool binding, CREATE2 permissions, fee delivery and two further fuzz tests. Another 17 router tests cover caller accounting, output minimums, deadlines, partial fills, callback authorization, reentrancy, payment/delivery rollback and a further fuzz test. The combined offline suite has five fuzz tests at 256 cases each.
- Market-factory and quoter tests additionally cover atomic seeding, precise supply/funding conservation, failed-launch rollback, refund reentry, callback/module authorization, permanent position ownership, prediction namespaces, seed previews and quoted versus executed trades. Exact current counts are recorded in `reports/contracts-validation.json` after the combined checks.
- The final offline Solidity run passed 108 tests, with two optional fork tests explicitly skipped. Four real two-pool tests cover both quote address orderings, exact seed refunds, all four external v4 swap modes, fee redemption, conversion of all VEYL fees through the actual main router and delivery of 70/20/10 ETH claims. Fourteen converter tests cover policy, rounding, slippage, partial fills, allowances, payout isolation and reentry. Eleven launch-protection cases retain the ERC-20 limit and open-routing coverage. The suite includes eight fuzz tests at 256 cases each.
- Factory initialization code is 12,605 bytes plus 256 constructor bytes (12,861 total), below EIP-3860's 49,152-byte limit; its runtime is 8,408 bytes. The largest creation-helper runtime is 22,027 bytes, below EIP-170's 24,576-byte limit. Formatting and build-size checks passed with Solidity 0.8.26, the existing optimizer configuration and no via-IR.
- Earlier opt-in Solidity fork tests passed against Ethereum block `26,100,053`, including complete VeylMarketFactory deployment, market launch, actual-pool quotation, VeylSwapRouter trading and revenue delivery. Those recorded results predate this final router-policy revision; the current ordinary run explicitly skipped them.
- Public-config/read-only preflight tests include the required Veyl protection flag and explicit unapproved seed constraints, without network access.
- The earlier native-market JavaScript wallet flow passed on disposable fork block `26,100,839`; this precedes the generalized factory ABI. The constrained automatic-treasury flow previously passed on block `26,100,799`; zkAPI activation and model output remained fixtures. New dual-market application-fork evidence is recorded separately after its run. None of these checks represents public broadcasts, real funds spent or paid upstream model calls.
- Prototype Solidity formatting and build-size checks must be rerun after each contract edit. Non-blocking naming/style lint notes preserve the current public getter API.
- The saved read-only snapshot in `reports/mainnet-preflight.json` records its own check time, Ethereum block and artifact hashes. It records no Veyl deployment and explicitly reports deployment blocked.
- `reports/contracts-validation.json` records the tested suite counts, pinned fork and remaining integration work. Re-run the commands after changes; this file is a recorded result, not an automatic freshness guarantee.
- `abi/` contains 17 public ABIs exported from the compiled artifacts. Re-run `node contracts/export-abi.mjs` after contract compilation to keep client integrations current.

These checks are local correctness/preparation evidence, not a production security audit.
