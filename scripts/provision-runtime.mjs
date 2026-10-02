import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { SealedState, stateKey } from '../src/encrypted-state.mjs';
import { ZkApiProvider } from '../src/provider.mjs';

// Operator-only recovery/provisioning path. Read secret input from stdin or a
// protected file, never CLI arguments or a public HTTP endpoint.
const input = JSON.parse(readFileSync(0, 'utf8'));
const owner = getAddress(input.owner), projectId = input.projectId;
if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error('Invalid project ID.');
if (typeof input.key !== 'string' || input.key.length < 32 || typeof input.managementToken !== 'string' || input.managementToken.length < 32) throw new Error('Distinct daemon credentials of at least 32 characters are required.');
if (input.key === input.managementToken) throw new Error('Daemon inference and management credentials must differ.');
const provider = new ZkApiProvider({ base: input.origin, key: input.key });
await provider.diagnostics({ expectedNetwork: 'mainnet' });
const directory = resolve(process.env.VEYL_DATA_DIR || 'data/production', 'tenants');
const state = new SealedState(resolve(directory, 'runtimes.sealed.json'), stateKey(process.env.VEYL_STATE_KEY), 'runtime-configuration', { version: 1, projects: [] });
if (state.data.projects.some(p => p.origin === input.origin && (p.owner !== owner || p.projectId !== projectId))) throw new Error('A daemon origin cannot be shared across projects.');
const entry = { owner, projectId, origin: input.origin, key: input.key, managementToken: input.managementToken, managed: false, approvalEnabled: false };
state.data.projects = state.data.projects.filter(p => p.owner.toLowerCase() !== owner.toLowerCase() || p.projectId !== projectId);
state.data.projects.push(entry); state.save();
console.log('Dedicated runtime configuration saved encrypted. Reload the Veyl service configuration; restart only if replacing a cached daemon.');
