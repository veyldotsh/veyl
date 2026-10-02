import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute the actual installer against private fixture paths and mocked host
// control commands. Copies, atomic renames, symlinks, checksums and shell traps
// are real. These tests never call systemd, a daemon, a network or a live host.
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const unix = path => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
const script = readFileSync(new URL('../deployment/upgrade-accounting-worker.sh', import.meta.url), 'utf8');
const enabled = existsSync(bash);
function fixture(fault = '') {
  const root = mkdtempSync(join(tmpdir(), 'veyl-upgrade-')), base = unix(join(root, 'veyl')), mocks = unix(join(root, 'mocks')), etc = unix(join(root, 'etc'));
  const release = base + '/releases/new', old = base + '/releases/old', candidate = base + '/native-releases/reviewed';
  mkdirSync(join(root, 'mocks'));
  const env = { ...process.env, MSYS: 'winsymlinks', VEYL_TEST_MOCKS: mocks, VEYL_TEST_BASE: base, VEYL_TEST_ETC: etc, VEYL_TEST_FAULT: fault };
  function run(command, args = []) { return spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$VEYL_TEST_MOCKS:/usr/bin:/bin"; ' + command, 'fixture', ...args], { env, encoding: 'utf8', timeout: 20000 }); }
  let prepared = run('mkdir -p "$1"/{bin,worker-data,vendor/runtime/bin,vendor/runtime/lib/original,native-releases/reviewed,releases/new/deployment,releases/old} "$2/system"; printf "#!old-client" >"$1/bin/zkapi-clientd-control"; printf old-manifest >"$1/bin/runtime-manifest.json"; printf "#!old-wallet" >"$1/vendor/runtime/lib/original/zkapi-walletd"; printf private-unchanged >"$1/runtime.env"; printf data >"$1/worker-data/state"; printf image >"$1/worker-data.ext4"; printf new-client >"$1/native-releases/reviewed/zkapi-clientd-control"; printf new-wallet >"$1/native-releases/reviewed/zkapi-walletd"; for name in runtime-manifest.json source-lock.json build-report.json go-build-report.json; do printf new-manifest >"$1/native-releases/reviewed/$name"; done; chmod 755 "$1/bin/zkapi-clientd-control" "$1/vendor/runtime/lib/original/zkapi-walletd"; ln -s "$1/vendor/runtime/lib/original/zkapi-walletd" "$1/vendor/runtime/bin/zkapi-walletd"; ln -s "$1/releases/old" "$1/current"; printf active >"$1/service-state"', [base, etc]);
  assert.equal(prepared.status, 0, prepared.stderr);
  for (const [name, destination] of [['veyl.service', 'system/veyl.service'], ['veyl-data.mount', 'system/veyl-data.mount'], ['journald@veyl.conf', 'journald@veyl.conf']]) {
    const content = readFileSync(new URL('../deployment/' + name, import.meta.url));
    writeFileSync(join(root, 'veyl/releases/new/deployment', name), content); writeFileSync(join(root, 'etc', destination), content);
  }
  const mock = (name, source) => writeFileSync(join(root, 'mocks', name), '#!/usr/bin/env bash\nset -eu\n' + source + '\n', { mode: 0o755 });
  mock('id', 'printf "0\\n"');
  mock('flock', 'exit 0');
  mock('systemd-escape', 'printf "veyl-data.mount\\n"');
  mock('mountpoint', 'exit 0');
  mock('findmnt', 'if [[ "$*" == *SOURCE* ]]; then printf "/dev/loop0\\n"; else printf "rw,nodev,nosuid,noexec\\n"; fi');
  mock('losetup', 'printf "%s/worker-data.ext4\\n" "$VEYL_TEST_BASE"');
  mock('df', 'printf "Avail\\n9999999999\\n"');
  mock('ss', 'exit 0');
  mock('sync', 'exit 0');
  mock('sleep', 'exit 0');
  mock('stat', 'case "$2" in "%U") printf "veyl\\n";; "%U %a") printf "root 700\\n";; "%U %a %s") printf "root 600 2147483648\\n";; *) exec /usr/bin/stat "$@";; esac');
  mock('readlink', 'if [[ "$*" == "-f /proc/123/cwd" ]]; then exec /usr/bin/realpath "$VEYL_TEST_BASE/current"; else exec /usr/bin/readlink "$@"; fi');
  mock('install', 'while [[ "$1" == -* ]]; do if [[ "$1" == -- ]]; then shift; break; fi; shift 2; done; /usr/bin/cp "$1" "$2"; /usr/bin/chmod 755 "$2"');
  mock('mv', 'if [[ "$VEYL_TEST_FAULT" == manifest-write && "${@: -1}" == "$VEYL_TEST_BASE/bin/runtime-manifest.json" && ! -f "$VEYL_TEST_BASE/fault-fired" ]]; then touch "$VEYL_TEST_BASE/fault-fired"; exit 1; fi; exec /usr/bin/mv "$@"');
  mock('runuser', 'if [[ "$*" == *check-worker.mjs* && "$VEYL_TEST_FAULT" == new-health && "$*" == *releases/new/* ]]; then exit 1; fi; exit 0');
  mock('systemctl', `
printf '%s\n' "$*" >>"$VEYL_TEST_BASE/control-log"
case "$1" in
  show)
    property=$4
    case "$property" in
      FragmentPath) printf '%s/system/%s\n' "$VEYL_TEST_ETC" "$2";;
      DropInPaths) :;; NeedDaemonReload) printf 'no\n';;
      MemoryMax) if [[ "$VEYL_TEST_FAULT" == resource-limit ]]; then printf 'infinity\n'; else printf '4294967296\n'; fi;;
      MemoryHigh) printf '3221225472\n';; MemorySwapMax) printf '0\n';; CPUQuotaPerSecUSec) printf '2s\n';; TasksMax) printf '128\n';; KillMode) printf 'mixed\n';; ControlGroup) printf '/system.slice/veyl.service\n';;
      MainPID) if [[ $(cat "$VEYL_TEST_BASE/service-state") == active ]]; then printf '123\n'; else printf '0\n'; fi;;
      *) exit 2;;
    esac;;
  is-active) [[ $(cat "$VEYL_TEST_BASE/service-state") == active ]];;
  stop) [[ "$VEYL_TEST_FAULT" != cannot-stop ]] || exit 1; printf inactive >"$VEYL_TEST_BASE/service-state";;
  start) printf active >"$VEYL_TEST_BASE/service-state";;
  *) exit 2;;
esac`);
  mock('systemd-run', `
printf '%s\n' "$*" >>"$VEYL_TEST_BASE/prepare-log"
if [[ "$*" == *verify-accounting-runtime.mjs* && "$VEYL_TEST_FAULT" == candidate ]]; then exit 1; fi
if [[ "$*" == *check-vps-runtime.mjs* ]]; then
  [[ "$*" == *"/usr/bin/env NODE_OPTIONS="* && "$*" == *"VEYL_ZKAPI_CLIENTD=$VEYL_TEST_BASE/native-releases/reviewed/zkapi-clientd-control"* && "$*" == *"VEYL_ZKAPI_WALLETD=$VEYL_TEST_BASE/native-releases/reviewed/zkapi-walletd"* && "$*" == *"VEYL_ZKAPI_MANIFEST=$VEYL_TEST_BASE/native-releases/reviewed/runtime-manifest.json"* ]] || exit 2
  [[ "$VEYL_TEST_FAULT" != smoke ]] || exit 1
fi`);
  const source = script.replaceAll('/home/veyl/veyl', base).replaceAll('/etc/systemd', etc);
  writeFileSync(join(root, 'upgrade.sh'), source);
  // Git Bash honors its own symlink representation without Windows symlink privileges.
  prepared = run('chmod 755 "$1"/*', [mocks]); assert.equal(prepared.status, 0, prepared.stderr);
  const result = run('bash "$1" "$2" "$3" "$4"', [unix(join(root, 'upgrade.sh')), release, old, candidate]);
  const inspect = run('printf "client=%s\\nwallet=%s\\nmanifest=%s\\ncurrent=%s\\nenv=%s\\noriginal=%s\\nstate=%s\\nservice=%s\\n" "$(cat "$1/bin/zkapi-clientd-control")" "$(readlink "$1/vendor/runtime/bin/zkapi-walletd")" "$(cat "$1/bin/runtime-manifest.json")" "$(realpath "$1/current")" "$(cat "$1/runtime.env")" "$(cat "$1/vendor/runtime/lib/original/zkapi-walletd")" "$(cat "$1/worker-data/state")" "$(cat "$1/service-state")"', [base]);
  assert.equal(inspect.status, 0, inspect.stderr);
  const state = Object.fromEntries(inspect.stdout.trim().split('\n').map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
  return { result, state, base, candidate, old, release, log: existsSync(join(root, 'veyl/control-log')) ? readFileSync(join(root, 'veyl/control-log'), 'utf8') : '' };
}
function preserved(f) {
  assert.equal(f.state.client, '#!old-client'); assert.equal(f.state.manifest, 'old-manifest');
  assert.equal(f.state.wallet, f.base + '/vendor/runtime/lib/original/zkapi-walletd'); assert.equal(f.state.current, f.old);
  assert.equal(f.state.env, 'private-unchanged'); assert.equal(f.state.original, '#!old-wallet'); assert.equal(f.state.state, 'data'); assert.equal(f.state.service, 'active');
}
test('accounting upgrade validates and switches four paths while preserving state and original native wallet', { skip: !enabled }, () => {
  const f = fixture(); assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.state.client, 'new-client'); assert.equal(f.state.manifest, 'new-manifest'); assert.equal(f.state.wallet, f.candidate + '/zkapi-walletd'); assert.equal(f.state.current, f.release);
  assert.equal(f.state.env, 'private-unchanged'); assert.equal(f.state.original, '#!old-wallet'); assert.equal(f.state.state, 'data');
  assert.ok(f.log.split('\n').filter(line => /^(stop|start) /.test(line)).every(line => /^(stop|start) veyl\.service$/.test(line)));
});
for (const fault of ['candidate', 'smoke', 'resource-limit']) test('accounting upgrade rejects ' + fault + ' before stopping the worker', { skip: !enabled }, () => {
  const f = fixture(fault); assert.notEqual(f.result.status, 0); preserved(f); assert.doesNotMatch(f.log, /^stop /m);
});
for (const fault of ['manifest-write', 'new-health']) test('accounting upgrade restores all four paths after ' + fault, { skip: !enabled }, () => {
  const f = fixture(fault); assert.notEqual(f.result.status, 0); preserved(f); assert.match(f.result.stderr, /restored and healthy/);
});
test('accounting upgrade never changes native files while the worker refuses to stop', { skip: !enabled }, () => {
  const f = fixture('cannot-stop'); assert.notEqual(f.result.status, 0); preserved(f); assert.doesNotMatch(f.log, /^start /m);
});
