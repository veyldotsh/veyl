#!/usr/bin/env bash
# Install one reviewed native candidate and one named worker release together.
# No funding, inference, transaction, secret rotation, or other service changes.
set -euo pipefail
umask 077
source "$(dirname -- "${BASH_SOURCE[0]}")/paths.sh"
release=${1:?Pass the new named Veyl release directory}
expected_old=${2:?Pass the exact current Veyl release directory}
candidate=${3:?Pass the reviewed named native candidate directory}
fail() { printf 'Veyl accounting upgrade: %s\n' "$*" >&2; exit 1; }
[[ ( $# == 3 || ( $# == 4 && "${4:-}" == --recovery-only ) ) && $(id -u) == 0 ]] || fail 'Run with sudo and three named paths, optionally followed by --recovery-only.'
smoke_args=()
[[ $# == 3 ]] || smoke_args=(--recovery-only)
[[ "$release" =~ ^"$base"/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ && "$expected_old" =~ ^"$base"/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail 'Invalid worker release path.'
[[ "$candidate" =~ ^"$base"/native-releases/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail 'Invalid native candidate path.'
for directory in "$base" "$base/bin" "$base/vendor/runtime/bin" "$release" "$expected_old" "$candidate"; do
  [[ -d "$directory" && "$(realpath "$directory")" == "$directory" ]] || fail 'Unexpected directory or symlink.'
done
[[ "$(stat -c %U "$release")" == "$service_user" && "$(stat -c %U "$candidate")" == "$service_user" && -L "$base/current" ]] || fail 'Unexpected release owner or current pointer.'
[[ ! -L "$base/install.lock" && ( ! -e "$base/install.lock" || -f "$base/install.lock" ) ]] || fail 'Invalid installation lock.'
exec 9>>"$base/install.lock"
flock -n 9 || fail 'Another installation is running.'
old=$(realpath "$base/current")
[[ "$old" == "$expected_old" && "$old" != "$release" ]] || fail 'Current release differs from the explicitly expected release.'
client="$base/bin/zkapi-clientd-control"
wallet="$base/vendor/runtime/bin/zkapi-walletd"
manifest="$base/bin/runtime-manifest.json"
[[ -f "$client" && ! -L "$client" && -x "$client" && -L "$wallet" && -f "$manifest" && ! -L "$manifest" && -f "$base/runtime.env" && ! -L "$base/runtime.env" ]] || fail 'Existing native installation and private configuration required.'
old_wallet_link=$(readlink "$wallet")
old_wallet=$(realpath "$wallet")
[[ "$old_wallet" == "$base/"* && -f "$old_wallet" && -x "$old_wallet" && "$old_wallet" != "$candidate/zkapi-walletd" ]] || fail 'Unexpected original wallet target; preserve it for review.'
for name in zkapi-clientd-control zkapi-walletd runtime-manifest.json source-lock.json build-report.json go-build-report.json; do
  [[ -f "$candidate/$name" && ! -L "$candidate/$name" ]] || fail 'Candidate file missing or is a symlink.'
done
mount_unit=$(systemd-escape --path --suffix=mount "$base/worker-data")
for pair in "deployment/veyl.service|/etc/systemd/system/veyl.service" "deployment/veyl-data.mount|/etc/systemd/system/$mount_unit" "deployment/journald@veyl.conf|/etc/systemd/journald@veyl.conf"; do
  source=${pair%%|*}; target=${pair#*|}
  [[ -f "$target" && ! -L "$target" ]] && cmp -s <(veyl_render "$release/$source") "$target" || fail 'Existing service settings differ; preserve and review them.'
done
for unit in veyl.service "$mount_unit"; do
  [[ "$(systemctl show "$unit" -p FragmentPath --value)" == "/etc/systemd/system/$unit" && -z "$(systemctl show "$unit" -p DropInPaths --value)" && "$(systemctl show "$unit" -p NeedDaemonReload --value)" == no ]] || fail 'Existing unit configuration differs.'
done
for expected in MemoryMax=4294967296 MemoryHigh=3221225472 MemorySwapMax=0 CPUQuotaPerSecUSec=2s TasksMax=128 KillMode=mixed ControlGroup=/system.slice/veyl.service; do
  property=${expected%%=*}; value=${expected#*=}
  [[ "$(systemctl show veyl.service -p "$property" --value)" == "$value" ]] || fail 'Effective worker resource isolation differs.'
done
runuser -u "$service_user" -- /usr/bin/env VEYL_HOME="$base" VEYL_SERVICE_USER="$service_user" /usr/bin/node "$release/scripts/prepare-worker-env.mjs" "$release"
env_digest=$(sha256sum "$base/runtime.env")
client_digest=$(sha256sum "$client")
manifest_digest=$(sha256sum "$manifest")
wallet_digest=$(sha256sum "$old_wallet")
mountpoint -q "$base/worker-data" || fail 'Bounded data volume is not mounted.'
device=$(findmnt -n -o SOURCE --mountpoint "$base/worker-data")
[[ "$(losetup --noheadings --output BACK-FILE "$device" | xargs)" == "$base/worker-data.ext4" ]] || fail 'Unexpected data backing device.'
options=",$(findmnt -n -o OPTIONS --mountpoint "$base/worker-data"),"
for option in nodev nosuid noexec; do [[ "$options" == *",$option,"* ]] || fail 'Missing mount protection.'; done
[[ "$(stat -c '%U %a %s' "$base/worker-data.ext4")" == 'root 600 2147483648' ]] || fail 'Unexpected data image.'
[[ $(df -B1 --output=avail "$base/worker-data" | tail -n 1) -ge 536870912 ]] || fail 'Insufficient data headroom.'
[[ $(df -B1 --output=avail "$base" | tail -n 1) -ge $(( $(stat -c %s "$client") * 3 + 104857600 )) ]] || fail 'Insufficient native backup headroom.'
systemctl is-active --quiet veyl.service || fail 'Existing Veyl worker must be active.'
runuser -u "$service_user" -- /usr/bin/env VEYL_HOME="$base" VEYL_SERVICE_USER="$service_user" /usr/bin/node "$old/scripts/check-worker.mjs"
prepare_seq=0
prep() {
  prepare_seq=$((prepare_seq + 1))
  systemd-run --quiet --wait --pipe --collect --unit="veyl-accounting-prepare-$$-$prepare_seq" --uid="$service_user" --gid="$service_user" --setenv=VEYL_HOME="$base" --setenv=VEYL_SERVICE_USER="$service_user" \
    --property=WorkingDirectory="$release" --property=CPUQuota=50% --property=MemoryMax=768M --property=MemorySwapMax=0 \
    --property=TasksMax=64 --property=RuntimeMaxSec=600 --property=UMask=0077 --property=NoNewPrivileges=yes --property=PrivateTmp=yes \
    --property=Nice=19 --property=IOWeight=10 --setenv=PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin "$@"
}
# The installed binary belongs to the old release's accepted build. Check the
# candidate separately against the new release, then verify it again installed.
prep /usr/bin/node "$old/scripts/verify-native-install.mjs"
prep /usr/bin/node "$release/scripts/verify-accounting-runtime.mjs" "$candidate"
candidate_digest=$(cd "$candidate" && sha256sum zkapi-clientd-control zkapi-walletd runtime-manifest.json source-lock.json build-report.json go-build-report.json)
prep /usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
prep /usr/bin/node --check "$release/src/production.mjs"
prep /usr/bin/node --input-type=module - "$release" <<'NODE'
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const release = process.argv[2];
const { MainnetMarkets } = await import(pathToFileURL(release + '/src/mainnet.mjs'));
const markets = new MainnetMarkets();
for (const name of ['VeylMainLiquidityBuilder','VeylMainLiquidityDeployer','VeylMainLiquidityPosition','VeylMarketFactory','VeylMarketDeployer','VeylProjectDeployer','VeylProjectBuilder','VeylMarketBuilder','VeylLiquidityBuilder','VeylLiquidityDeployer','QuoteRevenueRouter','VeylFeeHook','VeylLiquidityVault','VeylSwapRouter','VeylQuoter','RevenueRouter','AgentTreasury','AgentToken']) {
  const artifact = markets.artifact(name), init = artifact.bytecode?.object, runtime = artifact.deployedBytecode?.object;
  if (!Array.isArray(artifact.abi) || !/^0x[0-9a-f]+$/i.test(init || '') || !/^0x[0-9a-f]+$/i.test(runtime || '')) throw Error('Invalid artifact: ' + name);
  if ((runtime.length - 2) / 2 > 24576 || (init.length - 2) / 2 + (name === 'VeylMarketFactory' ? 256 : 0) > 49152) throw Error('Contract deployment size exceeds limit: ' + name);
  if (JSON.stringify(JSON.parse(readFileSync(`${release}/contracts/abi/${name}.json`, 'utf8'))) !== JSON.stringify(artifact.abi)) throw Error('ABI differs: ' + name);
}
console.log('Compiled artifacts, ABI exports and deployment sizes passed.');
NODE
prep /usr/bin/node "$release/scripts/check-standard-launch-artifact.mjs" "$release"
for port in 19800 19801; do [[ -z "$(ss -H -ltn "sport = :$port")" ]] || fail 'Smoke port occupied; existing owner preserved.'; done
# EnvironmentFile overrides --setenv. Apply candidate overrides in the command.
systemd-run --quiet --wait --pipe --collect --unit="veyl-accounting-smoke-$$" --uid="$service_user" --gid="$service_user" --setenv=VEYL_HOME="$base" --setenv=VEYL_SERVICE_USER="$service_user" \
  --property=WorkingDirectory="$release" --property=EnvironmentFile="$base/runtime.env" \
  --property=CPUQuota=50% --property=MemoryHigh=512M --property=MemoryMax=768M --property=MemorySwapMax=0 \
  --property=TasksMax=64 --property=RuntimeMaxSec=120 --property=TimeoutStopSec=10 --property=KillMode=control-group \
  --property=Nice=19 --property=IOWeight=10 --property=UMask=0077 --property=NoNewPrivileges=yes --property=PrivateTmp=yes \
  --property=ProtectSystem=strict --property=ProtectHome=read-only --property=ReadWritePaths="$base/worker-data" \
  /usr/bin/env NODE_OPTIONS=--max-old-space-size=384 VEYL_HOME="$base" VEYL_SERVICE_USER="$service_user" VEYL_SMOKE_ROOT="$base/worker-data/acceptance" \
  VEYL_MAINNET_CONFIG="$release/config/mainnet.json" VEYL_ZKAPI_CLIENTD="$candidate/zkapi-clientd-control" \
  VEYL_ZKAPI_WALLETD="$candidate/zkapi-walletd" VEYL_ZKAPI_MANIFEST="$candidate/runtime-manifest.json" \
  /usr/bin/node "$release/scripts/check-vps-runtime.mjs" "${smoke_args[@]}"
[[ "$(sha256sum "$base/runtime.env")" == "$env_digest" && "$(sha256sum "$client")" == "$client_digest" && "$(sha256sum "$manifest")" == "$manifest_digest" && "$(readlink "$wallet")" == "$old_wallet_link" && "$(sha256sum "$old_wallet")" == "$wallet_digest" && "$(realpath "$base/current")" == "$old" ]] || fail 'Existing installation changed during preparation.'
[[ "$(cd "$candidate" && sha256sum zkapi-clientd-control zkapi-walletd runtime-manifest.json source-lock.json build-report.json go-build-report.json)" == "$candidate_digest" ]] || fail 'Candidate changed during preparation.'
backups="$base/native-backups"
if [[ -e "$backups" || -L "$backups" ]]; then
  [[ -d "$backups" && ! -L "$backups" && "$(realpath "$backups")" == "$backups" && "$(stat -c '%U %a' "$backups")" == 'root 700' ]] || fail 'Invalid native backup directory.'
else mkdir -m 700 -- "$backups"; fi
backup="$backups/$(basename "$release")-$$"
mkdir -m 700 -- "$backup"
cp -p -- "$client" "$backup/client"; cp -p -- "$manifest" "$backup/manifest"
printf '%s\n' "$old_wallet_link" >"$backup/wallet-link"
printf '%s\n' "$old" >"$backup/current-release"
sync -f "$backup"
sequence=0
atomic_file() {
  local source=$1 target=$2 owner=${3:-preserve} temporary
  sequence=$((sequence + 1)); temporary="${target}.accounting-$$-$sequence"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  if [[ "$owner" == preserve ]]; then cp -p -- "$source" "$temporary" || return 1
  else install -o "$service_user" -g "$service_user" -m "$owner" -- "$source" "$temporary" || return 1; fi
  sync -f "$temporary" && mv -Tf -- "$temporary" "$target" && sync -f "$(dirname "$target")"
}
atomic_link() {
  local target=$1 destination=$2 temporary
  sequence=$((sequence + 1)); temporary="${destination}.accounting-$$-$sequence"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  ln -s -- "$target" "$temporary" && mv -Tf -- "$temporary" "$destination" && sync -f "$(dirname "$destination")"
}
healthy() {
  local expected=$1 pid
  for attempt in $(seq 1 30); do
    pid=$(systemctl show veyl.service -p MainPID --value)
    if systemctl is-active --quiet veyl.service && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" == "$expected" ]] && runuser -u "$service_user" -- /usr/bin/env VEYL_HOME="$base" VEYL_SERVICE_USER="$service_user" /usr/bin/node "$expected/scripts/check-worker.mjs" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
stopped() {
  [[ "$(systemctl show veyl.service -p MainPID --value)" == 0 ]] && ! systemctl is-active --quiet veyl.service
}
transition=0; committed=0
rollback() {
  local status=$? restored=1; trap - EXIT INT TERM HUP
  if [[ "$transition" == 1 && "$committed" == 0 ]]; then
    set +e
    if systemctl stop veyl.service && stopped; then
      atomic_file "$backup/client" "$client" || restored=0
      atomic_link "$old_wallet_link" "$wallet" || restored=0
      atomic_file "$backup/manifest" "$manifest" || restored=0
      atomic_link "$old" "$base/current" || restored=0
      [[ "$(sha256sum "$client")" == "$client_digest" && "$(sha256sum "$manifest")" == "$manifest_digest" && "$(readlink "$wallet")" == "$old_wallet_link" && "$(sha256sum "$old_wallet")" == "$wallet_digest" && "$(realpath "$base/current")" == "$old" && "$(sha256sum "$base/runtime.env")" == "$env_digest" ]] || restored=0
      if [[ "$restored" == 1 ]] && systemctl start veyl.service && healthy "$old"; then
        printf 'Upgrade failed; prior client, wallet pointer, manifest and worker release restored and healthy. Backup: %s\n' "$backup" >&2
      else printf 'Rollback requires review; recovery files preserved at %s. No other service was changed.\n' "$backup" >&2; fi
    else printf 'Veyl did not stop; rollback left executable paths untouched. Recovery files: %s\n' "$backup" >&2; fi
    exit 1
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
transition=1
systemctl stop veyl.service
stopped || fail 'Veyl did not stop cleanly.'
atomic_file "$candidate/zkapi-clientd-control" "$client" 755
atomic_link "$candidate/zkapi-walletd" "$wallet"
atomic_file "$candidate/runtime-manifest.json" "$manifest" 600
atomic_link "$release" "$base/current"
prep /usr/bin/node "$release/scripts/verify-native-install.mjs"
[[ "$(sha256sum "$base/runtime.env")" == "$env_digest" && "$(sha256sum "$old_wallet")" == "$wallet_digest" ]] || fail 'Private configuration or original wallet changed.'
systemctl start veyl.service
healthy "$release" || fail 'New worker health failed.'
committed=1
printf 'Veyl native accounting and worker release healthy. Prior native recovery files: %s\n' "$backup"
if [[ ${#smoke_args[@]} != 0 ]]; then printf 'Acceptance scope: wallet recovery only. Model catalog was not checked; inference readiness is not established.\n'; fi
