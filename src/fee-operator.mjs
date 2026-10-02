import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isAddress, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Problem } from './agent.mjs';

export const FEE_OPERATOR_ARM = 'I AUTHORIZE VEYL FEE MAINTENANCE ON ETHEREUM';
const flush = toFunctionSelector('flushFees()'), distribute = toFunctionSelector('distribute(address)');
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const inside = (parent, file) => { const part = relative(resolve(parent), file); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };

/** A separate operator, never a treasury signer. It can sign only the two
 * permissionless fee-maintenance call shapes. Contract identity and gas policy
 * are enforced again by FeeKeeper. No RPC or submission capability is exposed. */
export function loadFeeOperator({ env = process.env, forbiddenAddresses = [], forbiddenDirectories = [process.cwd()] } = {}) {
  if (env.VEYL_FEE_KEEPER_ENABLED !== 'true') { delete env.VEYL_FEE_OPERATOR_PRIVATE_KEY; return null; }
  if (env.VEYL_FEE_OPERATOR_ARM !== FEE_OPERATOR_ARM) throw new Problem('Fee operator is not explicitly armed.', 503);
  const expected = env.VEYL_FEE_OPERATOR_ADDRESS;
  if (!isAddress(expected || '') || /^0x0{40}$/i.test(expected) || forbiddenAddresses.some(a => same(a, expected))) throw new Problem('Configure a separate public fee operator address.', 503);
  const path = env.VEYL_FEE_OPERATOR_KEY_FILE, supplied = env.VEYL_FEE_OPERATOR_PRIVATE_KEY;
  if (Boolean(path) === Boolean(supplied)) throw new Problem('Configure exactly one operator-only fee key source.', 503);
  let key, bytes;
  try {
    if (path) {
      // Production is Linux. Refuse to pretend POSIX mode bits validate a Windows ACL.
      if (process.platform !== 'linux' || !isAbsolute(path)) throw new Error();
      const file = resolve(path);
      if (forbiddenDirectories.filter(Boolean).some(dir => inside(dir, file))) throw new Error();
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 128) throw new Error();
        bytes = readFileSync(fd); key = bytes.toString('utf8').trim();
      } finally { closeSync(fd); }
    } else {
      key = supplied;
      // Do not inherit the operator key into subsequently spawned zkAPI children.
      delete env.VEYL_FEE_OPERATOR_PRIVATE_KEY;
    }
    if (!/^0x[\da-f]{64}$/i.test(key || '')) throw new Error();
    const account = privateKeyToAccount(key);
    if (!same(account.address, expected)) throw new Error();
    return Object.freeze({ address: account.address, async signTransaction(transaction) {
      const data = transaction.data;
      const shape = data === flush || (typeof data === 'string' && data.startsWith(distribute) && /^0x[\da-f]{72}$/i.test(data) && /^0{24}$/i.test(data.slice(10, 34)));
      const allowed = new Set(['type', 'chainId', 'to', 'data', 'value', 'nonce', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas']);
      if (Object.keys(transaction).some(k => !allowed.has(k)) || transaction.type !== 'eip1559' || transaction.chainId !== 1 || transaction.value !== 0n || !isAddress(transaction.to || '') || !shape) throw new Problem('Fee operator rejected a non-maintenance transaction.', 403);
      return account.signTransaction(transaction);
    } });
  } catch { throw new Problem('Fee operator key source or public address is invalid. No key material was logged.', 503); }
  finally { bytes?.fill(0); key = undefined; }
}
