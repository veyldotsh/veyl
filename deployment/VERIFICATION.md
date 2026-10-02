# Explorer verification after deployment

These tools publish reviewed Solidity source to Ethereum's explorer. They do not deploy, sign or send blockchain transactions. No current address is assumed to be deployed, and no explorer submission has been performed by adding these scripts.

Create an explicit public JSON manifest after a separately approved Ethereum mainnet deployment:

```json
{
  "version": 1,
  "chainId": 1,
  "contracts": [
    {
      "address": "<deployed public contract address>",
      "contract": "RevenueRouter",
      "constructorArgs": "<exact ABI-encoded constructor arguments beginning 0x>"
    }
  ]
}
```

The placeholders must be replaced. Constructor arguments are the canonical ABI encoding of that contract's constructor values, without a selector or creation bytecode. Use the saved deployment arguments; the script does not guess them. Contracts without constructor arguments use `0x`. An optional `runtimeCodeHash` pins the exact deployed runtime keccak256. Duplicate addresses, extra fields, another chain and unrecognized contracts are rejected.

Known names are `AgentToken`, `AgentTreasury`, `AgentFactory`, `RevenueRouter`, `QuoteRevenueRouter`, `JobEscrow`, `VeylFeeHook`, `VeylSwapRouter`, `VeylMarketFactory`, `VeylAgentLaunchFactory`, `VeylAgentExecutionFactory`, `VeylMarketDeployer`, `VeylProjectDeployer`, `VeylLiquidityDeployer`, `VeylProjectBuilder`, `VeylMarketBuilder`, `VeylLiquidityBuilder`, `VeylLiquidityVault`, `VeylQuoter`, `VeylMainLiquidityBuilder`, `VeylMainLiquidityDeployer`, and `VeylMainLiquidityPosition`. Native and VEYL-quoted factories have different constructor values; always use the exact saved values for each address. The reviewed compiled artifacts must exist in `contracts/out`, with the current source/dependency files matching their metadata. The compiler configuration is Solidity0.8.26, optimizer200 and Cancun. Build/review changes before attempting verification.

The default is completely offline and never decrypts an explorer key:

```powershell
.\scripts\verify-contracts.ps1 -Manifest .\config\deployed-verification.json
```

Read-only mainnet validation also leaves the encrypted key untouched:

```powershell
.\scripts\verify-contracts.ps1 -Manifest .\config\deployed-verification.json -Check
```

Only after deployment and an explicit decision to submit source verification:

```powershell
.\scripts\verify-contracts.ps1 -Manifest .\config\deployed-verification.json -Submit
```

The Windows wrapper expects the existing current-user `ConvertFrom-SecureString` DPAPI text file at `data/operator/etherscan-key.dpapi`. It first checks every address on chain1, then decrypts in memory and passes the API key only in the Node child's environment. That child repeats chain/code validation and invokes `forge verify-contract --verifier etherscan --watch` with the key solely in its child environment. No key is put on the command line, written to another file, or printed. Raw Forge diagnostics are suppressed because they may include credential-bearing URLs; failures report no success and send no blockchain transaction. The DPAPI file works only for its owning Windows user and remains excluded from Git.

The live executable comparison checks the artifact's code while masking compiler-declared immutable slots and the metadata source digest. The optional runtime hash checks all deployed bytes. Constructor arguments are validated against the ABI; explorer verification performs the final constructor/compiled-bytecode match. A passing dry run or read-only check is not proof that Etherscan accepted the source. Only successful explicit submission reports `verified-or-already-verified`.

Advanced callers can use `node scripts/verify-contracts.mjs --manifest FILE`, `--check`, or `--submit`; direct submission requires `ETHERSCAN_API_KEY` to be provided through a secure child environment. `--rpc`/`-Rpc` accepts an HTTPS read-only Ethereum RPC. `VEYL_FORGE_BINARY` can select an existing Forge executable. Never run Forge help/debug commands with the explorer key loaded.
