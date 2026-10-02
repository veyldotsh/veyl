import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptancePlan, acceptanceProvider, acceptanceReservation, FundedAcceptance } from '../src/acceptance.mjs';
import { ZkApiProvider } from '../src/provider.mjs';
import { fundingFromEnv } from '../src/funding.mjs';
import { Store } from '../src/store.mjs';
import { Kit } from '../src/kit.mjs';
import { AgentTools } from '../src/agent-tools.mjs';
import { NoteExpiryGuard } from '../src/note-expiry.mjs';
import { MainnetMarkets } from '../src/mainnet.mjs';

// No wallet key loader, external RPC signer, deployment path or automatic
// transaction replay. Default invocation prints an offline public plan only.
const args = process.argv.slice(2), options = {}, booleans = new Set(['--plan', '--inspect', '--run']);
for (let i = 0; i < args.length; i++) {
  const name = args[i];
  if (!['--config', '--directory', '--approval', '--resume', '--transaction-hash', ...booleans].includes(name) || Object.hasOwn(options, name)) throw new Error('Unknown or duplicate acceptance argument.');
  options[name] = booleans.has(name) ? true : args[++i];
  if (options[name] === undefined || typeof options[name] === 'string' && options[name].startsWith('--')) throw new Error('Acceptance argument is missing its value.');
}
if (!options['--config']) throw new Error('Usage: node scripts/acceptance-zkapi.mjs --config PUBLIC_CONFIG.json [--plan | --inspect | --run --approval DIGEST | --resume deposit|withdrawal --transaction-hash SAVED_HASH --approval DIGEST]');
if (['--plan', '--inspect', '--run', '--resume'].filter(name => options[name]).length > 1) throw new Error('Choose one acceptance mode.');
const plan = acceptancePlan(JSON.parse(readFileSync(resolve(options['--config']), 'utf8'))), config = plan.config;
if (!options['--inspect'] && !options['--run'] && !options['--resume']) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  const provider = new ZkApiProvider({ base: config.daemonOrigin, key: process.env.ZKAPI_LOCAL_KEY || '' });
  if (options['--inspect']) {
    const diagnostics = await provider.diagnostics(), models = await provider.models(), selected = models.find(item => item.id === config.model);
    console.log(JSON.stringify({ ...plan, mode: 'read-only', diagnostics, selectedModel: selected || null, withinApprovedModelCap: acceptanceReservation(selected, config.maxRequestMicroUsd) !== null }, null, 2));
  } else {
    if (process.env.VEYL_ACCEPTANCE_ENABLE_PAID !== 'true' || options['--approval'] !== plan.approvalDigest) throw new Error('Paid mode requires VEYL_ACCEPTANCE_ENABLE_PAID=true and the exact reviewed plan digest. No action was performed.');
    const directory = resolve(options['--directory'] || 'output/funded-acceptance', config.runId);
    const funding = fundingFromEnv({ file: resolve(directory, 'funding.json'), localMode: true, env: { ZKAPI_ORIGIN: config.daemonOrigin, ZKAPI_LOCAL_KEY: process.env.ZKAPI_LOCAL_KEY || '', ZKAPI_MANAGEMENT_TOKEN: process.env.ZKAPI_MANAGEMENT_TOKEN || '', VEYL_ENABLE_ZKAPI_APPROVAL: 'true' } });
    let acceptance;
    const wrapped = acceptanceProvider(provider, (body, accounting) => acceptance.dispatch(body, accounting)), tools = new AgentTools();
    const onlyMemory = { schemas: () => tools.schemas().filter(tool => tool.function.name === 'save_note'), execute: (call, context) => { if (call.name !== 'save_note') throw new Error('Only save_note is allowed in acceptance.'); return tools.execute(call, context); } };
    const kit = new Kit({ store: new Store(resolve(directory, 'kit.json'), 'zkapi'), provider: wrapped, chain: {}, agentTools: onlyMemory });
    const expiryGuard = new NoteExpiryGuard({ funding, client: new MainnetMarkets().client });
    acceptance = new FundedAcceptance({ file: resolve(directory, 'acceptance.json'), config, provider, funding, kit, expiryGuard, enabled: true });
    const report = options['--run'] ? await acceptance.run(options['--approval']) : await acceptance.resume({ approvalDigest: options['--approval'], kind: options['--resume'], transactionHash: options['--transaction-hash'] });
    console.log(JSON.stringify(report, null, 2));
  }
}
