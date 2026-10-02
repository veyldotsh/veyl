// Public ABI export only: no account, environment-file, signer or network access.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const artifacts = [
  ['AgentKit.sol', 'AgentFactory'], ['AgentKit.sol', 'AgentToken'], ['AgentKit.sol', 'AgentTreasury'],
  ['Funding.sol', 'RevenueRouter'], ['Funding.sol', 'JobEscrow'],
  ['VeylFeeHook.sol', 'VeylFeeHook'], ['VeylSwapRouter.sol', 'VeylSwapRouter'],
  ['VeylMarketFactory.sol', 'VeylMarketFactory'], ['VeylMarketDeployer.sol', 'VeylMarketDeployer'],
  ['VeylProjectDeployer.sol', 'VeylProjectDeployer'], ['VeylLiquidityVault.sol', 'VeylLiquidityVault'],
  ['VeylQuoter.sol', 'VeylQuoter'],
  ['QuoteRevenueRouter.sol', 'QuoteRevenueRouter'],
  ['VeylLiquidityDeployer.sol', 'VeylLiquidityDeployer'],
  ['VeylProjectBuilder.sol', 'VeylProjectBuilder'],
  ['VeylMarketBuilder.sol', 'VeylMarketBuilder'],
  ['VeylLiquidityBuilder.sol', 'VeylLiquidityBuilder'],
  ['VeylMainLiquidityBuilder.sol', 'VeylMainLiquidityBuilder'],
  ['VeylMainLiquidityDeployer.sol', 'VeylMainLiquidityDeployer'],
  ['VeylMainLiquidityPosition.sol', 'VeylMainLiquidityPosition'],
];
await mkdir(new URL('./abi/', import.meta.url), { recursive: true });
for (const [source, name] of artifacts) {
  const artifact = JSON.parse(await readFile(new URL(`./out/${source}/${name}.json`, import.meta.url), 'utf8'));
  if (!Array.isArray(artifact.abi)) throw new Error(`Missing compiled ABI: ${name}`);
  await writeFile(new URL(`./abi/${name}.json`, import.meta.url), `${JSON.stringify(artifact.abi, null, 2)}\n`);
}
console.log(`Exported ${artifacts.length} public contract ABIs.`);
