// Mainnet preparation only. This module deliberately has no signing or broadcasting interface.
// It reads a public-only JSON config and compiled artifacts, never .env or account material.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAddress, keccak256, parseEther, zeroAddress } from 'viem';
import { verifyMainnet } from './check-mainnet.mjs';

const ROOT = new URL('../', import.meta.url);
const SCHEMA = {
  chainId: null,
  project: { name: null, symbol: null },
  addresses: { deployer: null, owner: null, operator: null, protocolRecipient: null, poolInitializer: null },
  agentMarkets: { mainMarketFactory: null, quoteAsset: null, conversionSwapRouter: null, marketFactory: null },
  funding: { initialTreasuryEth: null, dailyTreasuryLimitEth: null, initialLiquidityEth: null, initialLiquidityTokens: null },
  trading: { buyFeeBps: null, sellFeeBps: null, lpFeePips: null, tickSpacing: null, initialSqrtPriceX96: null, liquidityCustodyPolicy: null, launchProtection: null },
  zkapi: { daemonHostPlan: null, maxPrepaidEth: null, reconciliationPolicy: null },
  confirmations: { freshSignerConfirmed: null },
};

function publicSchema(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a public configuration object.');
  if (Object.keys(value).some(key => !Object.hasOwn(schema, key))) throw new Error('Unrecognized configuration fields; only the public schema is supported.');
  for (const [key, shape] of Object.entries(schema)) {
    if (!Object.hasOwn(value, key)) throw new Error('Configuration is missing required schema fields.');
    if (shape) publicSchema(value[key], shape);
    else if (value[key] !== null && !['string', 'number', 'boolean'].includes(typeof value[key])) throw new Error('Invalid public configuration field type.');
    else if (typeof value[key] === 'string' && /(?:0x)?[0-9a-fA-F]{64}/.test(value[key])) throw new Error('Configuration must not contain key-sized hexadecimal material.');
  }
}

export function validateConfig(config) {
  publicSchema(config, SCHEMA);
  const missing = [], invalid = [];
  const check = (path, predicate) => {
    const value = path.split('.').reduce((object, key) => object[key], config);
    if (value === null || value === '') missing.push(path);
    else if (!predicate(value)) invalid.push(path);
  };
  check('chainId', value => value === 1);
  check('project.name', value => typeof value === 'string' && Buffer.byteLength(value) <= 64 && value.trim().length > 0);
  check('project.symbol', value => typeof value === 'string' && /^[A-Z0-9]{1,10}$/.test(value));
  for (const key of Object.keys(SCHEMA.addresses)) check(`addresses.${key}`, value => typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress);
  for (const key of Object.keys(SCHEMA.agentMarkets)) check(`agentMarkets.${key}`, value => typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress);
  const decimal = value => typeof value === 'string' && /^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value);
  for (const key of Object.keys(SCHEMA.funding)) check(`funding.${key}`, decimal);
  for (const key of ['buyFeeBps', 'sellFeeBps']) check(`trading.${key}`, value => Number.isInteger(value) && value >= 0 && value < 10_000);
  check('trading.lpFeePips', value => Number.isInteger(value) && value >= 0 && value < 1_000_000);
  check('trading.tickSpacing', value => Number.isInteger(value) && value > 0 && value <= 32_767);
  check('trading.initialSqrtPriceX96', value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) >= 4_295_128_739n && BigInt(value) < 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n);
  check('trading.liquidityCustodyPolicy', value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2_000);
  check('trading.launchProtection', value => typeof value === 'boolean' && (!(config.project.name === 'Veyl' && config.project.symbol === 'VEYL') || value === true));
  if (config.trading.launchProtection === true && decimal(config.funding.initialLiquidityTokens) && (parseEther(config.funding.initialLiquidityTokens) < parseEther('980000000') || parseEther(config.funding.initialLiquidityTokens) > parseEther('1000000000'))) invalid.push('funding.initialLiquidityTokens');
  for (const key of ['daemonHostPlan', 'reconciliationPolicy']) check(`zkapi.${key}`, value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2_000);
  check('zkapi.maxPrepaidEth', decimal);
  check('confirmations.freshSignerConfirmed', value => value === true);
  return { complete: missing.length === 0 && invalid.length === 0, missing, invalid, allocationBps: { treasury: 7_000, creator: 2_000, protocol: 1_000 } };
}

export async function inspectArtifacts() {
  const contracts = [ ['AgentKit.sol', 'AgentFactory'], ['AgentKit.sol', 'AgentToken'], ['AgentKit.sol', 'AgentTreasury'], ['Funding.sol', 'RevenueRouter'], ['Funding.sol', 'JobEscrow'], ['VeylFeeHook.sol', 'VeylFeeHook'], ['VeylSwapRouter.sol', 'VeylSwapRouter'], ['VeylMarketFactory.sol', 'VeylMarketFactory'], ['VeylProjectDeployer.sol', 'VeylProjectDeployer'], ['VeylMarketDeployer.sol', 'VeylMarketDeployer'], ['VeylLiquidityVault.sol', 'VeylLiquidityVault'], ['VeylQuoter.sol', 'VeylQuoter'], ...['VeylProjectBuilder', 'VeylMarketBuilder', 'VeylLiquidityBuilder', 'VeylLiquidityDeployer', 'QuoteRevenueRouter'].map(name => [name + '.sol', name]) ];
  return Promise.all(contracts.map(async ([source, name]) => {
    try {
      const artifact = JSON.parse(await readFile(new URL(`contracts/out/${source}/${name}.json`, ROOT), 'utf8'));
      const creation = artifact.bytecode.object, runtime = artifact.deployedBytecode.object;
      if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(creation) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(runtime)) throw new Error('Missing bytecode');
      const runtimeBytes = (runtime.length - 2) / 2, initcodeBytesBeforeConstructorArgs = (creation.length - 2) / 2;
      return { name, compiled: true, runtimeBytes, initcodeBytesBeforeConstructorArgs, withinBaseSizeLimits: runtimeBytes <= 24_576 && initcodeBytesBeforeConstructorArgs <= 49_152, creationBytecodeHash: keccak256(creation) };
    } catch { return { name, compiled: false }; }
  }));
}

export async function preflight(config, { offline = false, verify = verifyMainnet, artifacts = inspectArtifacts } = {}) {
  const configuration = validateConfig(config);
  const compiledArtifacts = await artifacts();
  let zkapi;
  if (offline) zkapi = { checked: false, reason: 'Offline mode requested.' };
  else {
    try { zkapi = { checked: true, ...(await verify()) }; }
    catch { zkapi = { checked: false, reason: 'Read-only manifest/RPC verification failed; no transaction attempted.' }; }
  }
  return {
    checkedAt: new Date().toISOString(), mode: 'read-only-no-signing', chainId: 1,
    deploymentReady: false, configuration, compiledArtifacts, zkapi,
    blockers: [
      'Canonical mainnet pool creation and launch-factory wiring are implemented and tested in a local VM and pinned Ethereum fork; approved mainnet configuration and production application rehearsal remain required.',
      'Launch price, seed amounts, price range and creator remainder require explicit approval. Actual seeded liquidity and its LP fees are permanently locked; unused seed inputs and remaining tokens go to the creator.',
      'The Veyl main-token preset requires immutable 2% max-transfer and max-wallet limits for blocks B through B+9. Its creator has no exemption: at least 980 million tokens must actually enter locked liquidity, including after seed refunds. This constraint does not approve an allocation.',
      'Funded zkAPI deposit, inference, signed settlement reconciliation and withdrawal/recovery have not passed end-to-end acceptance.',
      'Hosted authentication, isolated wallet profiles, bounded execution and recovery are implemented but not activated publicly. Full hosted acceptance, proof-peak sizing and funded operator-policy rehearsal remain required.',
      'A fresh signer must be established separately through secure wallet software. This command does not connect to any signer.',
      'Source verification, deployment simulation and reviewed deployment transaction plan are still required.',
    ],
    notes: [
      '70/20/10 applies to net ETH fee proceeds. Main VEYL/ETH fees are ETH; agent/VEYL receipts convert in full through the pinned main pool before ETH claims are credited. Conversion sell fees and slippage reduce proceeds.',
      'Initial launch funding goes entirely to the treasury. Treasury owners can withdraw operating funds.',
      'VeylFeeHook supports all four swap modes, but exact-input buys and exact-output sells must fill completely or revert; the other modes charge the actual executed quote asset. The Veyl main-token preset is 180 bps each way with zero LP fee; agent rates are separate launch parameters.',
      'VeylSwapRouter provides one-pool exact-input swaps with caller-only funding/output, minimum output and deadline checks. Wallet application wiring has local and fork coverage; production transactions remain disabled.',
      'VeylQuoter simulates the actual PoolManager via eth_call and reverts the inner swap before returning amounts, hook fee and resulting pool state; pure helpers calculate seed costs and affordable liquidity.',
      'The optional hook and complete atomic-market fork tests use Ethereum block 26100053 and deployed PoolManager 0x000000000004444c5dc75cB358380D2e3dE08A90. Their new contracts and trades exist only in the test VM; they skip unless VEYL_MAINNET_FORK=true.',
      'Artifact size/hash checks inspect local compiler outputs, not deployed Veyl contracts. Constructor arguments are not included in initcode size.',
      'Completed configuration does not establish live acceptance or a security review; deploymentReady remains false.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    let filename = fileURLToPath(new URL('config/mainnet.example.json', ROOT)), offline = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--offline') offline = true;
      else if (args[index] === '--config' && args[index + 1]) filename = args[++index];
      else throw new Error('Unsupported argument.');
    }
    if (!filename.toLowerCase().endsWith('.json')) throw new Error('Only public JSON configuration is supported.');
    const raw = await readFile(filename, 'utf8');
    if (Buffer.byteLength(raw) > 65_536) throw new Error('Configuration exceeds size limit.');
    const report = await preflight(JSON.parse(raw), { offline });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.deploymentReady ? 0 : 2;
  } catch {
    console.error('Preflight could not validate the public configuration. No signer was opened and no transaction was sent.');
    process.exitCode = 1;
  }
}
