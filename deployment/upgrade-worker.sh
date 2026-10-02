#!/usr/bin/env bash
# Upgrade one explicitly identified Veyl release. Preserve all financial state.
set -euo pipefail
umask 077
base=/home/veyl/veyl
release=${1:?Pass the new named Veyl release directory}
expected_old=${2:?Pass the exact current Veyl release directory}
fail() { printf 'Veyl upgrade: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail 'Run with sudo.'
[[ "$release" =~ ^/home/veyl/veyl/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail 'Invalid release path.'
[[ -d "$release" && "$(realpath "$release")" == "$release" && "$(realpath "$base")" == "$base" ]] || fail 'Unexpected path or symlink.'
[[ "$(stat -c %U "$release")" == veyl && -L "$base/current" ]] || fail 'Unexpected owner or current pointer.'
old=$(realpath "$base/current")
[[ "$expected_old" =~ ^/home/veyl/veyl/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ && "$old" == "$expected_old" && "$old" != "$release" ]] || fail 'Current release differs from the explicitly expected release.'
[[ ! -L "$base/install.lock" && ( ! -e "$base/install.lock" || -f "$base/install.lock" ) ]] || fail 'Invalid installation lock.'
exec 9>>"$base/install.lock"
flock -n 9 || fail 'Another installation is running.'
mount_unit=$(systemd-escape --path --suffix=mount "$base/worker-data")
for pair in "deployment/veyl.service|/etc/systemd/system/veyl.service" "deployment/veyl-data.mount|/etc/systemd/system/$mount_unit" "deployment/journald@veyl.conf|/etc/systemd/journald@veyl.conf"; do
  source=${pair%%|*}; target=${pair#*|}
  [[ -f "$target" && ! -L "$target" ]] && cmp -s "$release/$source" "$target" || fail 'Existing service settings differ; preserve and review them.'
done
for unit in veyl.service "$mount_unit"; do
  [[ "$(systemctl show "$unit" -p FragmentPath --value)" == "/etc/systemd/system/$unit" && -z "$(systemctl show "$unit" -p DropInPaths --value)" && "$(systemctl show "$unit" -p NeedDaemonReload --value)" == no ]] || fail 'Existing unit configuration differs.'
done
[[ -f "$base/runtime.env" && ! -L "$base/runtime.env" && -f "$base/bin/runtime-manifest.json" && ! -L "$base/bin/runtime-manifest.json" ]] || fail 'Existing private configuration required.'
runuser -u veyl -- /usr/bin/node "$release/scripts/prepare-worker-env.mjs" "$release"
env_digest=$(sha256sum "$base/runtime.env")
mountpoint -q "$base/worker-data" || fail 'Bounded data volume is not mounted.'
device=$(findmnt -n -o SOURCE --mountpoint "$base/worker-data")
[[ "$(losetup --noheadings --output BACK-FILE "$device" | xargs)" == "$base/worker-data.ext4" ]] || fail 'Unexpected data backing device.'
options=",$(findmnt -n -o OPTIONS --mountpoint "$base/worker-data"),"
for option in nodev nosuid noexec; do [[ "$options" == *",$option,"* ]] || fail 'Missing mount protection.'; done
[[ "$(stat -c '%U %a %s' "$base/worker-data.ext4")" == 'root 600 2147483648' ]] || fail 'Unexpected data image.'
[[ $(df -B1 --output=avail "$base/worker-data" | tail -n 1) -ge 536870912 ]] || fail 'Insufficient storage headroom.'
systemctl is-active --quiet veyl.service || fail 'Existing Veyl worker must be active.'
runuser -u veyl -- /usr/bin/node "$old/scripts/check-worker.mjs"
prepare_seq=0
prep() {
  prepare_seq=$((prepare_seq + 1))
  systemd-run --quiet --wait --pipe --collect --unit="veyl-upgrade-prepare-$$-$prepare_seq" --uid=veyl --gid=veyl \
    --property=WorkingDirectory="$release" --property=CPUQuota=50% --property=MemoryMax=768M --property=MemorySwapMax=0 \
    --property=TasksMax=64 --property=RuntimeMaxSec=600 --property=UMask=0077 --property=NoNewPrivileges=yes --property=PrivateTmp=yes \
    --property=Nice=19 --property=IOWeight=10 --setenv=PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin "$@"
}
prep /usr/bin/node "$release/scripts/verify-native-install.mjs"
prep /usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
prep /usr/bin/node --check "$release/src/production.mjs"
prep /usr/bin/node --input-type=module - "$release" <<'NODE'
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const release = process.argv[2];
const { MainnetMarkets } = await import(pathToFileURL(release + '/src/mainnet.mjs'));
const markets = new MainnetMarkets();
for (const name of ['VeylMarketFactory','VeylMarketDeployer','VeylProjectDeployer','VeylProjectBuilder','VeylMarketBuilder','VeylLiquidityBuilder','VeylLiquidityDeployer','QuoteRevenueRouter','VeylFeeHook','VeylLiquidityVault','VeylSwapRouter','VeylQuoter','RevenueRouter','AgentTreasury','AgentToken']) {
  const artifact = markets.artifact(name), init = artifact.bytecode?.object, runtime = artifact.deployedBytecode?.object;
  if (!Array.isArray(artifact.abi) || !/^0x[0-9a-f]+$/i.test(init || '') || !/^0x[0-9a-f]+$/i.test(runtime || '')) throw Error('Invalid artifact: ' + name);
  if ((runtime.length - 2) / 2 > 24576 || (init.length - 2) / 2 + (name === 'VeylMarketFactory' ? 256 : 0) > 49152) throw Error('Contract deployment size exceeds limit: ' + name);
  if (JSON.stringify(JSON.parse(readFileSync(`${release}/contracts/abi/${name}.json`, 'utf8'))) !== JSON.stringify(artifact.abi)) throw Error('ABI differs: ' + name);
}
console.log('Compiled artifacts, ABI exports and deployment sizes passed.');
NODE
for port in 19800 19801; do [[ -z "$(ss -H -ltn "sport = :$port")" ]] || fail 'Smoke port occupied; existing owner preserved.'; done
systemd-run --quiet --wait --pipe --collect --unit="veyl-upgrade-smoke-$$" --uid=veyl --gid=veyl \
  --property=WorkingDirectory="$release" --property=EnvironmentFile="$base/runtime.env" \
  --property=CPUQuota=50% --property=MemoryHigh=512M --property=MemoryMax=768M --property=MemorySwapMax=0 \
  --property=TasksMax=64 --property=RuntimeMaxSec=120 --property=TimeoutStopSec=10 --property=KillMode=control-group \
  --property=Nice=19 --property=IOWeight=10 --property=UMask=0077 --property=NoNewPrivileges=yes --property=PrivateTmp=yes \
  --property=ProtectSystem=strict --property=ProtectHome=read-only --property=ReadWritePaths="$base/worker-data" \
  --setenv=NODE_OPTIONS=--max-old-space-size=384 --setenv=VEYL_SMOKE_ROOT="$base/worker-data/acceptance" \
  --setenv=VEYL_MAINNET_CONFIG="$release/config/mainnet.json" /usr/bin/node "$release/scripts/check-vps-runtime.mjs"
[[ "$(sha256sum "$base/runtime.env")" == "$env_digest" && "$(realpath "$base/current")" == "$old" ]] || fail 'Configuration changed during preparation.'
link_seq=0
switch_current() {
  link_seq=$((link_seq + 1)); local temporary="$base/.current-upgrade-$$-$link_seq"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  ln -s "$1" "$temporary"; mv -Tf -- "$temporary" "$base/current"
}
healthy() {
  local expected=$1 pid
  for attempt in $(seq 1 20); do
    pid=$(systemctl show veyl.service -p MainPID --value)
    if systemctl is-active --quiet veyl.service && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" == "$expected" ]] && runuser -u veyl -- /usr/bin/node "$expected/scripts/check-worker.mjs" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
switched=0; committed=0
rollback() {
  local status=$?; trap - EXIT INT TERM HUP
  if [[ "$switched" == 1 && "$committed" == 0 ]]; then
    set +e
    systemctl stop veyl.service; switch_current "$old"
    if [[ "$(realpath "$base/current")" == "$old" ]] && systemctl start veyl.service && healthy "$old"; then
      printf 'Upgrade failed; prior Veyl code restored and healthy.\n' >&2
    else
      printf 'Code rollback needs review. Data and process.lock preserved; no other service changed.\n' >&2
    fi
    exit 1
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
switched=1; switch_current "$release"
systemctl restart veyl.service
healthy "$release" || fail 'New worker health failed.'
committed=1
printf 'New Veyl release healthy. Environment, data volume and other services unchanged.\n'
