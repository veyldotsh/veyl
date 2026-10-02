// Wallet recovery acceptance is an explicit, narrower check. It never turns a
// failed catalog request into success and never represents inference readiness.
export function runtimeSmokeScope(args = []) {
  if (args.length === 0) return 'full';
  if (args.length === 1 && args[0] === '--recovery-only') return 'wallet-recovery';
  throw new Error('Expected no arguments or exactly --recovery-only.');
}

export async function acquireSmokeRuntime(registry, owner, project, scope) {
  if (scope === 'wallet-recovery') return registry.ready(owner, project.id);
  if (scope === 'full') return registry.provision(owner, project);
  throw new Error('Unknown runtime acceptance scope.');
}

export async function checkSmokeCatalog(provider, scope) {
  if (scope === 'wallet-recovery') return { acceptanceScope: scope, catalogChecked: false, modelCatalogReady: null, modelCount: null, inferenceReady: false };
  if (scope !== 'full') throw new Error('Unknown runtime acceptance scope.');
  const models = await provider.models();
  if (!Array.isArray(models) || models.length === 0) throw new Error('Unfunded daemon model catalog acceptance failed.');
  // A healthy catalog alone does not prove paid inference. This check does not
  // create a funded note, lease, provider request or settlement.
  return { acceptanceScope: scope, catalogChecked: true, modelCatalogReady: true, modelCount: models.length, inferenceReady: false };
}

export function requireSmokeAccounting(scope, nativeAccounting) {
  if (!['full', 'wallet-recovery'].includes(scope)) throw new Error('Unknown runtime acceptance scope.');
  if (scope === 'wallet-recovery' && nativeAccounting !== true) throw new Error('Wallet recovery acceptance requires authenticated native accounting.');
}
