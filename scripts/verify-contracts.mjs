import { readFileSync, realpathSync } from 'node:fs';
import { resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPublicClient, http, getAddress, zeroAddress, decodeAbiParameters, encodeAbiParameters, keccak256 } from 'viem';
import { mainnet } from 'viem/chains';
import { matchesRuntime } from '../src/mainnet.mjs';

const root = fileURLToPath(new URL('../contracts/', import.meta.url));
const contracts = {
  AgentToken: 'src/AgentKit.sol', AgentTreasury: 'src/AgentKit.sol', AgentFactory: 'src/AgentKit.sol',
  RevenueRouter: 'src/Funding.sol', JobEscrow: 'src/Funding.sol', VeylFeeHook: 'src/hook/VeylFeeHook.sol',
  VeylSwapRouter: 'src/VeylSwapRouter.sol', VeylMarketFactory: 'src/market/VeylMarketFactory.sol',
  VeylAgentLaunchFactory: 'src/market/VeylAgentLaunchFactory.sol',
  VeylAgentExecutionFactory: 'src/market/VeylAgentExecutionFactory.sol',
  VeylMarketDeployer: 'src/market/VeylMarketDeployer.sol', VeylProjectDeployer: 'src/market/VeylProjectDeployer.sol',
  VeylLiquidityVault: 'src/market/VeylLiquidityVault.sol', VeylQuoter: 'src/market/VeylQuoter.sol',
  QuoteRevenueRouter: 'src/QuoteRevenueRouter.sol', VeylProjectBuilder: 'src/market/VeylProjectBuilder.sol',
  VeylMarketBuilder: 'src/market/VeylMarketBuilder.sol', VeylLiquidityBuilder: 'src/market/VeylLiquidityBuilder.sol',
  VeylLiquidityDeployer: 'src/market/VeylLiquidityDeployer.sol',
  VeylMainLiquidityBuilder: 'src/market/VeylMainLiquidityBuilder.sol',
  VeylMainLiquidityDeployer: 'src/market/VeylMainLiquidityDeployer.sol',
  VeylMainLiquidityPosition: 'src/market/VeylMainLiquidityPosition.sol'
};
export class VerificationError extends Error {}
const reject = message => { throw new VerificationError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, required, optional = []) {
  if (!object(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) reject('Verification manifest has missing or unexpected fields.');
}
function artifact(name) { return JSON.parse(readFileSync(resolve(root, 'out', basename(contracts[name]), name + '.json'), 'utf8')); }
export function sourceDigestMatches(bytes, expected) {
  // Foundry's source loader normalizes CRLF from Windows Git checkouts to LF.
  // Accept that exact transformation only, preserving every other source byte.
  return keccak256(bytes) === expected || keccak256(Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))) === expected;
}
function currentSources(compiled) {
  if (!object(compiled.metadata?.sources) || !Object.keys(compiled.metadata.sources).length) reject('Compiled source metadata is missing.');
  for (const [source, info] of Object.entries(compiled.metadata.sources)) {
    if (!/^(src|lib)\/[A-Za-z0-9_./@-]+\.sol$/.test(source) || source.split('/').includes('..')) reject('Compiled metadata has an unexpected source path.');
    const path = realpathSync(resolve(root, source)); if (!path.startsWith(realpathSync(root) + sep)) reject('Compiled source path escapes the contract project.');
    if (!sourceDigestMatches(readFileSync(path), info.keccak256)) reject('Contract sources differ from the reviewed compiled artifacts. Rebuild and review before verification.');
  }
}
export function prepareVerification(manifest, { readArtifact = artifact, verifySources = currentSources } = {}) {
  fields(manifest, ['version', 'chainId', 'contracts']);
  if (manifest.version !== 1 || manifest.chainId !== 1) reject('Verification requires manifest version1 and Ethereum chain1.');
  if (!Array.isArray(manifest.contracts) || !manifest.contracts.length || manifest.contracts.length > 20) reject('Provide between1 and20 deployed contracts.');
  const seen = new Set();
  const entries = manifest.contracts.map(entry => {
    fields(entry, ['address', 'contract', 'constructorArgs'], ['runtimeCodeHash']);
    let address; try { address = getAddress(entry.address); } catch { reject('A valid deployed contract address is required.'); }
    if (address === zeroAddress || seen.has(address.toLowerCase())) reject('Contract addresses must be nonzero and unique.'); seen.add(address.toLowerCase());
    if (!Object.hasOwn(contracts, entry.contract)) reject('Only known Veyl contract artifacts can be verified.');
    if (typeof entry.constructorArgs !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(entry.constructorArgs) || entry.constructorArgs.length > 32770) reject('Constructor arguments must be bounded ABI-encoded bytes.');
    if (entry.runtimeCodeHash !== undefined && !/^0x[a-fA-F0-9]{64}$/.test(entry.runtimeCodeHash)) reject('Expected runtime code hash must contain32bytes.');
    const compiled = readArtifact(entry.contract), metadata = compiled.metadata;
    if (!Array.isArray(compiled.abi) || !/^0x(?:[a-fA-F0-9]{2})+$/.test(compiled.deployedBytecode?.object || '') || metadata?.compiler?.version !== '0.8.26+commit.8a97fa7a' || metadata.settings?.optimizer?.enabled !== true || metadata.settings.optimizer.runs !== 200 || metadata.settings.evmVersion !== 'cancun' || metadata.settings.compilationTarget?.[contracts[entry.contract]] !== entry.contract) reject('Contract artifact does not match the reviewed compiler, target and optimizer settings.');
    const constructors = compiled.abi.filter(item => item.type === 'constructor'); if (constructors.length > 1) reject('Artifact constructor ABI is ambiguous.');
    const parameters = constructors[0]?.inputs || [];
    try {
      const encoded = parameters.length ? encodeAbiParameters(parameters, decodeAbiParameters(parameters, entry.constructorArgs)) : '0x';
      if (encoded.toLowerCase() !== entry.constructorArgs.toLowerCase()) reject('Constructor arguments are not canonical for this exact ABI.');
    } catch { reject('Constructor arguments are not canonical for this exact ABI.'); }
    verifySources(compiled);
    return { address, contract: entry.contract, target: `${contracts[entry.contract]}:${entry.contract}`, constructorArgs: entry.constructorArgs, runtimeCodeHash: entry.runtimeCodeHash, artifact: compiled };
  });
  return { version: 1, chainId: 1, entries };
}
export async function verifyLive(plan, client) {
  if (await client.getChainId() !== 1) reject('RPC is not Ethereum mainnet. No explorer submission was made.');
  const blockNumber = await client.getBlockNumber(), checked = [];
  for (const entry of plan.entries) {
    const code = await client.getCode({ address: entry.address, blockNumber });
    if (!code || code === '0x') reject('A manifest address has no deployed code. No explorer submission was made.');
    if (!matchesRuntime(code, entry.artifact)) reject('Deployed executable code differs from its compiled artifact. No explorer submission was made.');
    const codeHash = keccak256(code);
    if (entry.runtimeCodeHash && entry.runtimeCodeHash.toLowerCase() !== codeHash) reject('Deployed runtime hash differs from the manifest. No explorer submission was made.');
    checked.push({ address: entry.address, contract: entry.contract, codeHash });
  }
  return { chainId: 1, blockNumber: String(blockNumber), contracts: checked };
}
export function forgeArguments(entry) {
  return ['verify-contract', '--root', root, '--chain', '1', '--verifier', 'etherscan', '--watch', '--compiler-version', 'v0.8.26+commit.8a97fa7a', '--num-of-optimizations', '200', '--evm-version', 'cancun', '--constructor-args', entry.constructorArgs, entry.address, entry.target];
}
export function runForge(entry, key, forge = process.env.VEYL_FORGE_BINARY || 'forge') {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(key)) reject('A valid explorer key must be supplied through the child environment only.');
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  env.ETHERSCAN_API_KEY = key;
  const result = spawnSync(forge, forgeArguments(entry), { cwd: root, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 600_000, maxBuffer: 2 * 1024 * 1024 });
  // Forge diagnostics can contain API URLs/credentials. Never relay raw output,
  // even on failure. Never invoke --help with the API key present.
  delete env.ETHERSCAN_API_KEY;
  if (result.error || result.status !== 0) reject('Explorer verification did not finish successfully. Child diagnostics were withheld to protect credentials; no chain transaction was sent.');
  return { address: entry.address, contract: entry.contract, status: 'verified-or-already-verified' };
}
export async function executeVerification(plan, { mode = 'dry-run', client, key, submit = runForge } = {}) {
  if (!['dry-run', 'check', 'submit'].includes(mode)) reject('Unknown verification mode.');
  const summary = { mode, chainId: 1, contracts: plan.entries.map(({ address, contract, target }) => ({ address, contract, target })), explorerSubmitted: false, transactionsSent: 0 };
  if (mode === 'dry-run') return { ...summary, note: 'Offline plan only. No explorer credential was loaded and no network request was made.' };
  const live = await verifyLive(plan, client);
  if (mode === 'check') return { ...summary, live };
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(key)) reject('Explorer submission requires a key in the private child environment.');
  const results = [];
  for (const entry of plan.entries) results.push(await submit(entry, key));
  return { ...summary, explorerSubmitted: true, live, results };
}
async function main() {
  const args = process.argv.slice(2), options = {}; let mode = 'dry-run';
  while (args.length) {
    const arg = args.shift();
    if (arg === '--check' || arg === '--submit') { if (mode !== 'dry-run') reject('Choose a single verification mode.'); mode = arg.slice(2); }
    else if (['--manifest', '--rpc'].includes(arg)) { if (!args.length || Object.hasOwn(options, arg)) reject('Missing or duplicate verification argument.'); options[arg] = args.shift(); }
    else reject('Usage: node scripts/verify-contracts.mjs --manifest FILE [--check|--submit] [--rpc HTTPS_RPC]');
  }
  if (!options['--manifest']) reject('Provide an explicit deployed-contract manifest.');
  const plan = prepareVerification(JSON.parse(readFileSync(resolve(options['--manifest']), 'utf8')));
  let client;
  if (mode !== 'dry-run') {
    const url = new URL(options['--rpc'] || process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) reject('Verification requires an HTTPS Ethereum RPC.');
    client = createPublicClient({ chain: mainnet, transport: http(url.href, { retryCount: 0, timeout: 20000, fetchOptions: { redirect: 'error' } }) });
  }
  const key = mode === 'submit' ? process.env.ETHERSCAN_API_KEY : undefined;
  delete process.env.ETHERSCAN_API_KEY; delete process.env.VERIFIER_API_KEY;
  console.log(JSON.stringify(await executeVerification(plan, { mode, client, key }), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof VerificationError ? error.message : 'Verification preparation or read-only RPC check failed. No verification success is claimed.'); process.exitCode = 1; });
