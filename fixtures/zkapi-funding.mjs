// Offline response shapes from ethereum/zkapi b826c169b4831665822529f535f824265f50630b:
// zkapi-clientd/internal/zkapi/{address_funding,address_quote,funding_admin}.go.
// Addresses, IDs and credentials below are deliberately synthetic test data.
import { ZKAPI_MAINNET } from '../src/funding.mjs';
export const FIXTURE_TIME = 1_800_000_000_000;
export const FIXTURE_KEY = 'offline-test-inference-credential-not-a-real-key';
export const FIXTURE_MANAGEMENT = 'offline-test-management-credential-not-a-real-key';
export const FIXTURE_ADDRESS = '0x1111111111111111111111111111111111111111';
export const FIXTURE_TX = `0x${'a'.repeat(64)}`;
export function fundingStatus(overrides = {}) {
  return { address: FIXTURE_ADDRESS, chain_id: 1, deployment_id: ZKAPI_MAINNET.deploymentId,
    billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000',
    token_address: '', token_decimals: 9, token_balance: '2000000', eth_balance: '2000000000000000',
    amount: 0, phase: 'ready', message: 'Synthetic fixture status', ...overrides };
}
export function fundingQuote(overrides = {}) {
  return { id: '1'.repeat(64), kind: 'deposit', address: FIXTURE_ADDRESS, chain_id: 1,
    contract_address: ZKAPI_MAINNET.vault, deployment_id: ZKAPI_MAINNET.deploymentId, amount: 1_000_000,
    principal_wei: '1000000000000000', balance_wei: '2000000000000000', expected_fee_wei: '10000000000000',
    required_fee_wei: '12000000000000', fee_reserve_wei: '120000000000000', fee_buffer_wei: '108000000000000',
    required_total_wei: '1012000000000000', recommended_total_wei: '1120000000000000', shortfall_wei: '0',
    recommended_top_up_wei: '0', estimated_gas: 100000, gas_limit: 120000, max_fee_per_gas: '1000000000',
    max_priority_fee_per_gas: '100000000', fee_policy: 'low', expires_at: FIXTURE_TIME + 30_000,
    commitment: `0x${'2'.repeat(64)}`, nonce: 3, ...overrides };
}
