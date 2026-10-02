import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contract = 'VeylAgentLaunchFactory';

/** Offline release check. A configured address remains required even when new launches are disabled,
 * because already-created standard markets still need this artifact for status and receipt recovery. */
export function checkStandardLaunchArtifact(release) {
  const root = resolve(release);
  const config = JSON.parse(readFileSync(resolve(root, 'config/mainnet.json'), 'utf8'));
  const policy = config.agentMarkets || {};
  const required = policy.standardLaunch === true || (typeof policy.standardFactory === 'string' && policy.standardFactory.length > 0);
  const artifactPath = resolve(root, `contracts/out/${contract}.sol/${contract}.json`);
  const abiPath = resolve(root, `contracts/abi/${contract}.json`);
  if (!required && !existsSync(artifactPath) && !existsSync(abiPath)) return { required: false, checked: false, contract };
  if (!existsSync(artifactPath) || !existsSync(abiPath)) throw Error('Standard launch requires both the compiled factory artifact and matching ABI export.');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const exportedAbi = JSON.parse(readFileSync(abiPath, 'utf8'));
  const init = artifact.bytecode?.object, runtime = artifact.deployedBytecode?.object;
  if (!Array.isArray(artifact.abi) || !/^0x(?:[0-9a-f]{2})+$/i.test(init || '') || !/^0x(?:[0-9a-f]{2})+$/i.test(runtime || '')) throw Error('Invalid standard launch factory artifact.');
  if ((runtime.length - 2) / 2 > 24576 || (init.length - 2) / 2 + 8 * 32 > 49152) throw Error('Standard launch factory exceeds deployment size limits.');
  const settings = artifact.metadata?.settings;
  if (artifact.metadata?.compiler?.version !== '0.8.26+commit.8a97fa7a' || settings?.compilationTarget?.['src/market/VeylAgentLaunchFactory.sol'] !== contract || settings?.optimizer?.enabled !== true || settings.optimizer.runs !== 200 || settings.evmVersion !== 'cancun') throw Error('Standard launch compiler or target differs from the reviewed build.');
  if (JSON.stringify(exportedAbi) !== JSON.stringify(artifact.abi)) throw Error('Standard launch factory ABI differs from the compiled artifact.');
  for (const name of ['LAUNCH_POLICY_VERSION', 'standardLaunchConfig', 'previewInitialBuy', 'launch', 'launchAndBuy', 'getMarket']) {
    if (!artifact.abi.some(item => item.type === 'function' && item.name === name)) throw Error('Standard launch factory is missing required interface: ' + name);
  }
  return { required, checked: true, contract, runtimeBytes: (runtime.length - 2) / 2, initcodeBytesWithConstructor: (init.length - 2) / 2 + 256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Pass the exact candidate release directory.');
  console.log(JSON.stringify(checkStandardLaunchArtifact(process.argv[2])));
}
