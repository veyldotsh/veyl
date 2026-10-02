// Public defaults. Existing installations can supply private process overrides.
export function installationPaths(env = process.env) {
  const base = env.VEYL_HOME || '/home/veyl/veyl';
  const user = env.VEYL_SERVICE_USER || 'veyl';
  if (!/^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+veyl$/.test(base) || base.split('/').some(part => part === '.' || part === '..')) throw new Error('VEYL_HOME must be an absolute named installation directory ending in /veyl.');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error('VEYL_SERVICE_USER must be a valid service account name.');
  return { base, user };
}
export function namedInstallationPath(path, group, env = process.env) {
  const { base } = installationPaths(env), prefix = `${base}/${group}/`;
  return ['releases', 'native-releases'].includes(group) && typeof path === 'string' && path.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(path.slice(prefix.length));
}
