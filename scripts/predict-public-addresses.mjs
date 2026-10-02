import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, getCreate2Address, http, keccak256, padHex, stringToHex, zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { VEYL_MAIN_TOKEN_SALT, VEYL_MAIN_TOKEN_SALT_LABEL, ETHEREUM_POSITION_MANAGER } from '../src/mainnet.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';
const STAGES = ['VeylQuoter', 'VeylProjectBuilder', 'VeylMarketBuilder', 'VeylLiquidityBuilder', 'VeylMarketFactory'];
const load = name => {
  const source = name === 'AgentToken' ? 'AgentKit' : name;
  const relative = `contracts/out/${source}.sol/${name}.json`;
  const data = JSON.parse(readFileSync(resolve(ROOT, relative), 'utf8'));
  if (!/^0x[0-9a-f]+$/i.test(data.bytecode?.object || '')) throw new Error(`Build the reviewed ${name} artifact first.`);
  return { data, source: relative, creationBytecodeKeccak256: keccak256(data.bytecode.object) };
};

/** Pure CREATE/CREATE2 address calculation. No wallet, signature or RPC write. */
export function predictPublicAddresses({ config, startNonce = 0n, creator = config.addresses.deployer, projectId = config.project.id } = {}) {
  if (config?.chainId !== 1 || config?.project?.name !== 'Veyl' || config?.project?.symbol !== 'VEYL' || config?.trading?.launchProtection !== true) throw new Error('Expected the explicit protected Veyl mainnet preset.');
  if (typeof startNonce !== 'bigint' || startNonce < 0n || startNonce > (1n << 64n) - 5n) throw new Error('Invalid starting deployment nonce.');
  if (projectId !== undefined && (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId))) throw new Error('Use the exact saved project.id; do not invent a salt.');
  const deployer = getAddress(config.addresses.deployer), protocolRecipient = getAddress(config.addresses.protocolRecipient);
  creator = getAddress(creator);
  const canonical = config.project.launchSalt !== undefined;
  if (canonical && (config.project.launchSalt !== VEYL_MAIN_TOKEN_SALT || creator !== deployer)) throw new Error('The canonical main-token salt and configured creator must match the launch plan.');
  const mainPosition = config.trading.liquidityCustody === 'deployer-position-nft';
  const stages = STAGES.map(name => mainPosition && name === 'VeylLiquidityBuilder' ? 'VeylMainLiquidityBuilder' : name);
  const deployments = stages.map((contract, index) => ({ contract, nonce: (startNonce + BigInt(index)).toString(), address: getContractAddress({ from: deployer, nonce: startNonce + BigInt(index) }), method: 'CREATE', deployed: null }));
  const addresses = Object.fromEntries(deployments.map(item => [item.contract, item.address]));
  const factory = addresses.VeylMarketFactory, salt = padHex(factory, { size: 32 });
  const definitions = [
    ['VeylProjectDeployer', 'VeylProjectBuilder', [factory, protocolRecipient, MANAGER, zeroAddress, zeroAddress]],
    ['VeylMarketDeployer', 'VeylMarketBuilder', [factory, MANAGER, zeroAddress]],
    mainPosition ? ['VeylMainLiquidityDeployer', 'VeylMainLiquidityBuilder', [factory, MANAGER, ETHEREUM_POSITION_MANAGER, creator, VEYL_MAIN_TOKEN_SALT]] : ['VeylLiquidityDeployer', 'VeylLiquidityBuilder', [factory, MANAGER]]
  ];
  const artifacts = [];
  const children = definitions.map(([contract, builder, args]) => {
    const artifact = load(contract); artifacts.push({ contract, path: artifact.source, creationBytecodeKeccak256: artifact.creationBytecodeKeccak256 });
    const initCode = encodeDeployData({ abi: artifact.data.abi, bytecode: artifact.data.bytecode.object, args });
    return { contract, builder: addresses[builder], salt, constructorArguments: args, initCodeHash: keccak256(initCode), address: getCreate2Address({ from: addresses[builder], salt, bytecodeHash: keccak256(initCode) }), method: 'CREATE2', deployed: null };
  });
  const tokenArtifact = load('AgentToken'); artifacts.push({ contract: 'AgentToken', path: tokenArtifact.source, creationBytecodeKeccak256: tokenArtifact.creationBytecodeKeccak256 });
  const tokenCode = encodeDeployData({ abi: tokenArtifact.data.abi, bytecode: tokenArtifact.data.bytecode.object, args: ['Veyl', 'VEYL', factory, true, MANAGER] });
  const projectDeployer = children.find(item => item.contract === 'VeylProjectDeployer').address;
  const token = { contract: 'AgentToken', name: 'Veyl', symbol: 'VEYL', method: 'CREATE2', from: projectDeployer, initCodeHash: keccak256(tokenCode), address: null, deployed: null,
    status: canonical || projectId ? 'conditional-prediction' : 'missing-fixed-project-id', dependsOnLiquidityPriceOrBudget: false };
  if (canonical || projectId) {
    if (projectId) token.projectId = projectId;
    token.launchSalt = canonical ? VEYL_MAIN_TOKEN_SALT : keccak256(stringToHex(`veyl:ethereum:${projectId}`));
    token.saltLabel = canonical ? VEYL_MAIN_TOKEN_SALT_LABEL : `veyl:ethereum:${projectId}`;
    token.marketId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator, token.launchSalt]));
    token.address = getCreate2Address({ from: projectDeployer, salt: token.marketId, bytecodeHash: token.initCodeHash });
  }
  return { version: 1, chainId: 1, generatedAt: new Date().toISOString(), calculationOnly: true, transactionSent: false, deployer, creator, protocolRecipient,
    poolManager: MANAGER, quoteAsset: zeroAddress, startingNonce: startNonce.toString(), deployments, factoryChildren: children, token, artifacts,
    ...(mainPosition ? { mainTokenLaunch: config.mainTokenLaunch, liquidityCustody: 'deployer-position-nft', liquidityBuilderArguments: [MANAGER, ETHEREUM_POSITION_MANAGER, creator, VEYL_MAIN_TOKEN_SALT] } : {}),
    requirements: [
      'The same public deployer must CREATE the five contracts at the exact listed nonces and in this order, with no intervening transaction.',
      'The factory must use the listed helpers, PoolManager, protocol recipient, native ETH quote and zero conversion router.',
      ...(mainPosition ? ['The main factory must use VeylMainLiquidityBuilder with the canonical PositionManager, listed creator and canonical salt. Its liquidity NFT is minted to the creator and is not locked until custody changes.'] : []),
      canonical ? 'The token creator must be the listed creator and its treasury owner must match configured owner. The main token uses the published canonical launch salt, independent of workspace ID.' : 'The token creator must be the listed creator; the exact saved project.id determines its creator-scoped salt.',
      'The compiled creation bytecode hashes must remain identical; rebuilding changed source or metadata can change CREATE2 addresses.',
      'Predicted addresses do not show deployment, available liquidity, ownership or approval to spend.'
    ], missingForTokenPrediction: canonical || projectId ? [] : ['The exact fixed project.id used by the saved Veyl launch workspace.'], chainObservation: null };
}

export function writeAddressPrediction(file, result) {
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved?.token?.status === 'deployed' || saved?.token?.receipt) throw new Error('This file records a confirmed deployment. Use a different output path for address recalculation; the deployment record will not be overwritten.');
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
}

async function main() {
  const options = new Map(); const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--check-chain') { options.set(name, true); continue; }
    if (!['--project-id', '--start-nonce', '--creator', '--rpc-url', '--output'].includes(name) || !args[i + 1] || options.has(name)) throw new Error('Usage: node scripts/predict-public-addresses.mjs [--project-id EXACT_ID] [--start-nonce 0] [--creator PUBLIC_ADDRESS] [--check-chain] [--rpc-url HTTPS_URL] [--output FILE]');
    options.set(name, args[++i]);
  }
  const config = JSON.parse(readFileSync(resolve(ROOT, 'config/mainnet.json'), 'utf8'));
  const result = predictPublicAddresses({ config, startNonce: BigInt(options.get('--start-nonce') || '0'), ...(options.has('--project-id') ? { projectId: options.get('--project-id') } : {}), ...(options.has('--creator') ? { creator: options.get('--creator') } : {}) });
  if (options.has('--check-chain')) {
    const url = new URL(options.get('--rpc-url') || 'https://ethereum-rpc.publicnode.com');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use a public HTTPS read-only RPC without credentials or query parameters.');
    const client = createPublicClient({ chain: mainnet, transport: http(url.toString(), { retryCount: 0, timeout: 15000, fetchOptions: { redirect: 'error' } }) });
    if (await client.getChainId() !== 1) throw new Error('RPC is not Ethereum mainnet.');
    const blockNumber = await client.getBlockNumber();
    const [confirmedNonce, pendingNonce, code] = await Promise.all([client.getTransactionCount({ address: result.deployer, blockNumber }), client.getTransactionCount({ address: result.deployer, blockTag: 'pending' }), client.getBytecode({ address: result.deployer, blockNumber })]);
    const predicted = [...result.deployments, ...result.factoryChildren, ...(result.token.address ? [result.token] : [])];
    await Promise.all(predicted.map(async item => { const deployed = await client.getBytecode({ address: item.address, blockNumber }); item.deployed = Boolean(deployed && deployed !== '0x'); }));
    const deployerHasCode = Boolean(code && code !== '0x');
    result.chainObservation = { checkedAt: new Date().toISOString(), rpcHost: url.hostname, blockNumber: blockNumber.toString(), confirmedNonce, pendingNonce, deployerHasCode, nonceSequenceCurrentlyPossible: !deployerHasCode && BigInt(confirmedNonce) === BigInt(result.startingNonce) && confirmedNonce === pendingNonce };
  }
  const file = resolve(ROOT, options.get('--output') || 'output/public-address-predictions.json');
  writeAddressPrediction(file, result);
  console.log(JSON.stringify({ output: file, nonceZeroIs: result.deployments[0], token: result.token, chainObservation: result.chainObservation, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
