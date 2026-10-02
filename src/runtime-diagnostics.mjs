// Informational only. These enums never authorize retries or budget releases.
const codes = new Set([
  'lease_response_mismatch', 'lease_inference_origin_mismatch', 'verifier_origin_mismatch',
  'verifier_transport_failed', 'verifier_response_invalid', 'verifier_response_rejected',
  'verifier_binding_mismatch', 'verifier_station_banned', 'verifier_key_expired',
  'key_verification_failed', 'lease_reservation_failed', 'wallet_error',
  'companion_unavailable', 'companion_request_failed', 'invalid_companion_response',
  'anonymous_access_failed', 'wallet_conflict', 'funding_required', 'request_cancelled',
  'invalid_upstream_response', 'withdrawal_pending', 'testnet_password_required',
  'invalid_model', 'model_budget_unavailable', 'model_policy_unavailable',
]);
export const runtimeFailureCode = value => typeof value === 'string' && codes.has(value) ? value : null;

export async function readRuntimeFailureCode(response) {
  const reader = response.body?.getReader?.();
  if (!reader) { await response.body?.cancel?.(); return null; }
  try {
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return runtimeFailureCode(body?.error?.code);
  } catch { return null; }
  finally { reader.releaseLock(); }
}
