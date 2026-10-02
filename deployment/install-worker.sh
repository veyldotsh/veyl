#!/usr/bin/env bash
# Reviewed isolated install only. No nginx, firewall, funding or signer changes.
set -euo pipefail
umask 077
fail() { printf 'Veyl worker install: %s\n' "$*" >&2; exit 1; }
base=/home/veyl/veyl
release=${1:?Usage: sudo bash deployment/install-worker.sh /home/veyl/veyl/releases/RELEASE}
[[ "$(id -u)" == 0 ]] || fail 'Run the reviewed installer with sudo.'
[[ "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] || fail 'Linux ARM64 is required.'
[[ "$release" =~ ^/home/veyl/veyl/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail 'Release must be one named directory inside the Veyl releases folder.'
[[ -d "$release" && "$(realpath "$release")" == "$release" && "$(realpath "$base")" == "$base" ]] || fail 'Release and installation paths must be real directories inside Veyl.'
[[ "$(stat -c %U "$release")" == veyl ]] || fail 'The service user must own the verified release.'
for command in node npm git runuser systemctl systemd-run systemd-escape systemd-analyze findmnt losetup mountpoint blkid cmp install ss sha256sum flock nice ionice; do command -v "$command" >/dev/null || fail "Required existing tool is missing: $command"; done
[[ ! -L "$base/install.lock" && ( ! -e "$base/install.lock" || -f "$base/install.lock" ) ]] || fail 'Installer lock path is not a regular file.'
exec 9>>"$base/install.lock"
flock -n 9 || fail 'Another Veyl installation is already in progress.'
starting=false
trap 'if [[ "$starting" == true ]]; then systemctl stop veyl.service || true; fi' EXIT
prepare_sequence=0
bounded_prepare() {
  prepare_sequence=$((prepare_sequence + 1))
  systemd-run --quiet --wait --pipe --collect --unit="veyl-prepare-$$-$prepare_sequence" --uid=veyl --gid=veyl \
    --property=WorkingDirectory="$release" --property=CPUQuota=50% --property=MemoryMax=768M --property=MemorySwapMax=0 \
    --property=TasksMax=64 --property=RuntimeMaxSec=600 --property=UMask=0077 --property=NoNewPrivileges=yes --property=PrivateTmp=yes \
    --property=Nice=19 --property=IOWeight=10 \
    --setenv=PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin "$@"
}
[[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22')" == true ]] || fail 'Node22 or newer is required.'
for path in deployment/veyl.service deployment/veyl-data.mount deployment/journald@veyl.conf deployment/create-data-volume.sh scripts/verify-native-install.mjs scripts/prepare-worker-env.mjs scripts/check-vps-runtime.mjs scripts/check-worker.mjs src/production.mjs config/mainnet.json package.json package-lock.json; do
  [[ -f "$release/$path" && ! -L "$release/$path" ]] || fail "Verified release is missing a regular file: $path"
done
mount_unit=$(systemd-escape --path --suffix=mount "$base/worker-data")
service=/etc/systemd/system/veyl.service
mount_file="/etc/systemd/system/$mount_unit"
journal=/etc/systemd/journald@veyl.conf
check_managed_file() {
  local expected=$1 actual=$2
  [[ ! -L "$actual" ]] || fail 'A managed configuration path is a symlink.'
  if [[ -e "$actual" ]]; then [[ -f "$actual" ]] && cmp -s "$expected" "$actual" || fail "Existing Veyl configuration differs: $actual"; fi
}
check_managed_file "$release/deployment/veyl.service" "$service"
check_managed_file "$release/deployment/veyl-data.mount" "$mount_file"
check_managed_file "$release/deployment/journald@veyl.conf" "$journal"
for unit in veyl.service "$mount_unit"; do
  fragment=$(systemctl show "$unit" -p FragmentPath --value)
  [[ -z "$fragment" || "$fragment" == "/etc/systemd/system/$unit" ]] || fail 'A Veyl unit name is already owned by another installation.'
  [[ -z "$(systemctl show "$unit" -p DropInPaths --value)" ]] || fail 'Existing Veyl unit overrides require review.'
done
if [[ -e "$base/current" || -L "$base/current" ]]; then
  [[ -L "$base/current" && "$(realpath "$base/current")" == "$release" ]] || fail 'Current release differs; this installer does not upgrade or replace it.'
fi
if [[ -e "$base/runtime.env" || -L "$base/runtime.env" ]]; then runuser -u veyl -- /usr/bin/node "$release/scripts/prepare-worker-env.mjs" "$release"; fi
if systemctl is-active --quiet veyl.service; then
  [[ -f "$service" && -f "$mount_file" && -f "$journal" && -f "$base/runtime.env" ]] || fail 'Active Veyl installation is incomplete.'
  runuser -u veyl -- /usr/bin/node "$release/scripts/check-worker.mjs"
  printf 'Matching Veyl service is already healthy; no restart or changes performed.\n'; exit 0
fi
[[ -z "$(ss -H -ltn 'sport = :4320')" ]] || fail 'Port4320 is occupied; its existing owner was not changed.'
[[ ! -L "$base/worker-data.ext4" && ! -L "$base/worker-data" ]] || fail 'Private data target must not be a symlink.'
if [[ -e "$base/worker-data.ext4" ]]; then
  [[ -f "$base/worker-data.ext4" && "$(stat -c %s "$base/worker-data.ext4")" == 2147483648 && "$(stat -c %U "$base/worker-data.ext4")" == root && "$(stat -c %a "$base/worker-data.ext4")" == 600 && "$(blkid -p -s TYPE -o value "$base/worker-data.ext4")" == ext4 ]] || fail 'Existing data image differs; it was preserved.'
else
  [[ ! -d "$base/worker-data" || -z "$(find "$base/worker-data" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'Data target contains files; nothing will be hidden or replaced.'
  available=$(df --output=avail -B1 "$base" | tail -n 1 | tr -d ' ')
  (( available >= 6442450944 )) || fail 'At least6GiB free storage is required before creating the bounded volume.'
fi
# Source and dependency operations run without root privileges and never execute
# npm lifecycle scripts. No global package or OS package installation occurs.
bounded_prepare /usr/bin/node "$release/scripts/verify-native-install.mjs"
bounded_prepare /usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
runuser -u veyl -- /usr/bin/node --check "$release/src/production.mjs"
runuser -u veyl -- /usr/bin/node --input-type=module - "$release" <<'NODE'
import { pathToFileURL } from 'node:url';
const release = process.argv[2], { MainnetMarkets } = await import(pathToFileURL(release + '/src/mainnet.mjs'));
const mainnet = new MainnetMarkets();
for (const name of ['VeylMarketFactory', 'VeylMarketDeployer', 'VeylProjectDeployer', 'VeylProjectBuilder', 'VeylMarketBuilder', 'VeylLiquidityBuilder', 'VeylLiquidityDeployer', 'QuoteRevenueRouter', 'VeylFeeHook', 'VeylLiquidityVault', 'VeylSwapRouter', 'VeylQuoter', 'RevenueRouter', 'AgentTreasury', 'AgentToken']) {
  const artifact = mainnet.artifact(name);
  if (!Array.isArray(artifact.abi) || !/^0x[0-9a-f]+$/i.test(artifact.bytecode?.object || '') || !/^0x[0-9a-f]+$/i.test(artifact.deployedBytecode?.object || '')) throw new Error('Compiled mainnet artifacts are absent or invalid. Build the reviewed release locally before installing.');
}
console.log('Required compiled artifacts are present. No chain write was requested.');
NODE
if [[ ! -e "$base/worker-data.ext4" ]]; then nice -n 19 ionice -c 3 bash "$release/deployment/create-data-volume.sh"; fi
install -o root -g root -m 644 "$release/deployment/veyl-data.mount" "$mount_file"
systemctl daemon-reload
systemctl start "$mount_unit"
mountpoint -q "$base/worker-data" || fail 'Private bounded data volume is not mounted.'
source_device=$(findmnt -n -o SOURCE --mountpoint "$base/worker-data")
[[ "$(losetup --noheadings --output BACK-FILE "$source_device" | xargs)" == "$base/worker-data.ext4" ]] || fail 'Data mount is backed by an unexpected device.'
mount_options=",$(findmnt -n -o OPTIONS --mountpoint "$base/worker-data"),"
for option in nodev nosuid noexec; do [[ "$mount_options" == *",$option,"* ]] || fail 'Data mount lacks a required isolation option.'; done
install -d -o veyl -g veyl -m 700 "$base/worker-data/production" "$base/worker-data/acceptance"
runuser -u veyl -- /usr/bin/node "$release/scripts/prepare-worker-env.mjs" "$release"
if [[ ! -e "$base/current" && ! -L "$base/current" ]]; then ln -s "$release" "$base/current"; fi
# A fresh isolated, unfunded project exercises the actual production module,
# authenticated native daemon, catalog and funding metadata before service start.
# Its wallet state is preserved, even when acceptance fails.
acceptance="veyl-acceptance-$(date +%s)-$$"
systemd-run --quiet --wait --pipe --collect --unit="$acceptance" --uid=veyl --gid=veyl \
  --property=WorkingDirectory="$release" --property=EnvironmentFile="$base/runtime.env" \
  --property=CPUQuota=50% --property=MemoryHigh=512M --property=MemoryMax=768M --property=MemorySwapMax=0 \
  --property=TasksMax=64 --property=RuntimeMaxSec=120 --property=TimeoutStopSec=10 --property=KillMode=control-group \
  --property=Nice=19 --property=IOWeight=10 \
  --property=UMask=0077 --property=NoNewPrivileges=yes --property=PrivateTmp=yes --property=ProtectSystem=strict \
  --property=ProtectHome=read-only --property=ReadWritePaths="$base/worker-data" \
  --setenv=NODE_OPTIONS=--max-old-space-size=384 --setenv=VEYL_SMOKE_ROOT="$base/worker-data/acceptance" \
  /usr/bin/node "$release/scripts/check-vps-runtime.mjs"
install -o root -g root -m 644 "$release/deployment/journald@veyl.conf" "$journal"
install -o root -g root -m 644 "$release/deployment/veyl.service" "$service"
systemd-analyze verify "$service" "$mount_file"
systemctl daemon-reload
systemctl enable "$mount_unit" veyl.service
starting=true
systemctl start veyl.service
for attempt in $(seq 1 20); do
  if runuser -u veyl -- /usr/bin/node "$release/scripts/check-worker.mjs" >/dev/null 2>&1; then
    starting=false
    printf 'Veyl worker started on 127.0.0.1:4320 with 2 CPU/4 GiB/no swap and bounded private storage. No nginx, firewall, signer, funding or other service changed.\n'; exit 0
  fi
  sleep 1
done
systemctl stop veyl.service
fail 'Veyl health acceptance failed; only Veyl was stopped. Private data and configuration were preserved.'
