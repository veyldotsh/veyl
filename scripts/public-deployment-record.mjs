import { encodeAbiParameters, getContractAddress, getCreate2Address, keccak256, stringToHex } from 'viem';

const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '') && !/^0x0{40}$/.test(value);
const hash = value => /^0x[0-9a-fA-F]{64}$/.test(value || '') && !/^0x0{64}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Offline publication guard. It validates the reviewed record and matching copy;
 * live receipt/runtime verification must produce the record before publication. */
export function validatePublicDeploymentRecord(record, html) {
  const token = record?.token, salt = keccak256(stringToHex('veyl:ethereum:main-token:v1'));
  if (record?.version !== 1 || record.chainId !== 1 || !address(record.deployer) || !same(record.creator, record.deployer) || !address(token?.address) || !hash(token.initCodeHash) || !same(token.launchSalt, salt)) throw new Error('Invalid public Ethereum platform-token record.');
  const names = ['VeylQuoter', 'VeylProjectBuilder', 'VeylMarketBuilder', 'VeylMainLiquidityBuilder', 'VeylMarketFactory'];
  if (!Array.isArray(record.deployments) || record.deployments.length !== 5 || record.deployments.some((item, index) => item.contract !== names[index] || item.nonce !== String(index) || !same(item.address, getContractAddress({ from: record.deployer, nonce: BigInt(index) })))) throw new Error('Public infrastructure differs from the canonical nonce sequence.');
  const creatorId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [record.creator, salt]));
  const module = record.factoryChildren?.find(item => item.contract === 'VeylProjectDeployer');
  if (!module || !address(module.address) || !same(token.from, module.address) || !same(token.marketId, creatorId) || !same(token.address, getCreate2Address({ from: token.from, salt: creatorId, bytecodeHash: token.initCodeHash }))) throw new Error('Public token address differs from its canonical CREATE2 identity.');
  const deployed = token.status === 'deployed';
  if (deployed) {
    const receipt = token.receipt;
    if (token.deployed !== true || record.calculationOnly !== false || record.transactionSent !== true || record.deployments.some(item => item.deployed !== true) || !hash(token.runtimeCodeHash) || receipt?.chainId !== 1 || !hash(receipt.transactionHash) || !hash(receipt.blockHash) || !/^[1-9][0-9]*$/.test(receipt.blockNumber || '') || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2) throw new Error('Deployed platform-token record lacks confirmed Ethereum receipt evidence.');
    if (!html.includes('data-veyl-status="deployed"') || !html.includes(`href="https://etherscan.io/tx/${receipt.transactionHash}"`)) throw new Error('Deployed public copy must identify the confirmed status and exact launch receipt.');
  } else if (token.status !== 'conditional-prediction' || token.deployed !== false || record.calculationOnly !== true || record.transactionSent !== false || html.includes('data-veyl-status="deployed"')) throw new Error('Public prediction and deployment labels are inconsistent.');
  const addresses = [...html.matchAll(/data-veyl-token="([^"]+)"/g)].map(match => match[1]);
  if (addresses.length !== 1 || addresses[0] !== token.address || !html.includes(`href="https://etherscan.io/address/${token.address}"`) || !html.includes(`<code>${token.address}</code>`)) throw new Error('Public token links differ from the reviewed deployment record.');
  return { address: token.address, deployed };
}
