// Read-only verification. No accounts, signing, deposits, environment files or transactions.
import { createPublicClient, http, isAddress, keccak256 } from 'viem';
import { mainnet } from 'viem/chains';
import { pathToFileURL } from 'node:url';

export const MANIFEST_URL = 'https://zkapi-mainnet.openanonymity.ai/config.json';
export const MAINNET_RPC_URL = 'https://ethereum-rpc.publicnode.com';
const HASH = /^0x[0-9a-fA-F]{64}$/;

export async function readManifest(fetchImpl = fetch) {
  const response = await fetchImpl(MANIFEST_URL, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error('Mainnet manifest request failed.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 1_000_000) { await reader.cancel(); throw new Error('Mainnet manifest exceeds size limit.'); }
    chunks.push(value);
  }
  let manifest;
  try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Mainnet manifest is not valid JSON.'); }
  if (manifest.chain_id !== 1 || manifest.billing_asset !== 'native_eth' || manifest.proof_setup?.circuit_id !== 'zkapi-v2-note-bound-v1'
    || !isAddress(manifest.contract_address ?? '') || !isAddress(manifest.proof_adapter_address ?? '')
    || !HASH.test(manifest.deployment_evidence?.vault_runtime_keccak256 ?? '')
    || !HASH.test(manifest.deployment_evidence?.verifier_runtime_keccak256 ?? '')) {
    throw new Error('Unexpected mainnet configuration. Stop and review.');
  }
  return manifest;
}

export async function verifyMainnet({ fetchImpl = fetch, client } = {}) {
  const manifest = await readManifest(fetchImpl);
  client ??= createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC_URL, { retryCount: 0, timeout: 15_000 }) });
  if (await client.getChainId() !== 1) throw new Error('RPC chain mismatch.');
  const blockNumber = await client.getBlockNumber();
  const [vault, verifier, block] = await Promise.all([
    client.getCode({ address: manifest.contract_address, blockNumber }),
    client.getCode({ address: manifest.proof_adapter_address, blockNumber }),
    client.getBlock({ blockNumber }),
  ]);
  if (!vault || vault === '0x' || !verifier || verifier === '0x') throw new Error('Missing runtime bytecode.');
  if (keccak256(vault) !== manifest.deployment_evidence.vault_runtime_keccak256.toLowerCase()
    || keccak256(verifier) !== manifest.deployment_evidence.verifier_runtime_keccak256.toLowerCase()) {
    throw new Error('Runtime differs from advertised manifest.');
  }
  return {
    checkedAt: new Date().toISOString(), chainId: 1, block: String(blockNumber), blockHash: block.hash,
    manifestUrl: MANIFEST_URL, rpcUrl: MAINNET_RPC_URL, deployment: manifest.deployment_id,
    vault: manifest.contract_address, verifier: manifest.proof_adapter_address,
    runtimeMatchesManifest: true, noteTTLSeconds: manifest.note_ttl_seconds, limitations: manifest.limitations,
    scope: 'Both runtime bytecodes match the operator manifest at the recorded block. Not an audit, independent setup provenance check or funded lifecycle acceptance.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyMainnet(), null, 2)); }
  catch { console.error('Read-only mainnet verification failed. No transaction was sent. Recheck the public endpoints and manifest.'); process.exitCode = 1; }
}
