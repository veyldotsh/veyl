import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { decodeFunctionData, isAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Problem } from './agent.mjs';

export const CONVERSION_OPERATOR_ARM = 'I AUTHORIZE BOUNDED VEYL FEE CONVERSION ON ETHEREUM';
export const CONVERSION_ABI = parseAbi(['function convertFees(uint256 amountIn,uint256 minEthOut,uint160 sqrtPriceLimitX96,uint256 deadline) returns (uint256 ethOut)']);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const inside = (parent, file) => { const part = relative(resolve(parent), file); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };

/** Separate sign-only role. It cannot configure policies, transfer tokens,
 * approve allowances, pay treasury expenses or call arbitrary contracts through
 * a generic method. ConversionKeeper binds its only call to verified markets. */
export function loadConversionOperator({ env = process.env, forbiddenAddresses = [], forbiddenDirectories = [process.cwd()] } = {}) {
  if (env.VEYL_CONVERSION_KEEPER_ENABLED !== 'true') { delete env.VEYL_CONVERSION_OPERATOR_PRIVATE_KEY; return null; }
  if (env.VEYL_CONVERSION_OPERATOR_ARM !== CONVERSION_OPERATOR_ARM) throw new Problem('Conversion operator is not explicitly armed.', 503);
  const expected = env.VEYL_CONVERSION_OPERATOR_ADDRESS;
  if (!isAddress(expected || '') || /^0x0{40}$/i.test(expected) || forbiddenAddresses.some(a => same(a, expected))) throw new Problem('Configure a separate public conversion operator address.', 503);
  const path = env.VEYL_CONVERSION_OPERATOR_KEY_FILE, supplied = env.VEYL_CONVERSION_OPERATOR_PRIVATE_KEY;
  delete env.VEYL_CONVERSION_OPERATOR_PRIVATE_KEY;
  if (Boolean(path) === Boolean(supplied)) throw new Problem('Configure exactly one operator-only conversion key source.', 503);
  let key, bytes;
  try {
    if (path) {
      if (process.platform !== 'linux' || !isAbsolute(path)) throw new Error();
      const file = resolve(path);
      if (forbiddenDirectories.filter(Boolean).some(dir => inside(dir, file))) throw new Error();
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 128) throw new Error();
        bytes = readFileSync(fd); key = bytes.toString('utf8').trim();
      } finally { closeSync(fd); }
    } else key = supplied;
    if (!/^0x[\da-f]{64}$/i.test(key || '')) throw new Error();
    const account = privateKeyToAccount(key);
    if (!same(account.address, expected)) throw new Error();
    return Object.freeze({ address: account.address, async signTransaction(transaction) {
      const allowed = new Set(['type', 'chainId', 'to', 'data', 'value', 'nonce', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas']);
      let valid = false;
      try {
        const decoded = decodeFunctionData({ abi: CONVERSION_ABI, data: transaction.data });
        const [amount, minimum, limit, deadline] = decoded.args;
        valid = transaction.data.length === 266 && decoded.functionName === 'convertFees' && amount > 0n && minimum > 0n && limit > 0n && deadline > 0n;
      } catch {}
      if (Object.keys(transaction).some(k => !allowed.has(k)) || transaction.type !== 'eip1559' || transaction.chainId !== 1 || transaction.value !== 0n || !isAddress(transaction.to || '') || !valid) throw new Problem('Conversion operator rejected a non-conversion transaction.', 403);
      return account.signTransaction(transaction);
    } });
  } catch { throw new Problem('Conversion operator key source or public address is invalid. No key material was logged.', 503); }
  finally { bytes?.fill(0); key = undefined; }
}
