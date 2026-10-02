#!/usr/bin/env bash
# Installs only inside the explicitly supplied Veyl directory. Never runs config,
# starts a daemon, creates a wallet, signs, or funds a transaction.
set -euo pipefail
umask 077
source "$(dirname -- "${BASH_SOURCE[0]}")/paths.sh"
requested_base=${1:?Pass the explicit installation directory}
checkout=${2:?Veyl source checkout is required}
[[ "$requested_base" == "$base" ]] || { printf 'Unexpected installation directory\n' >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] || { printf 'This lock is for Linux ARM64\n' >&2; exit 1; }
mkdir -p "$base/vendor" "$base/bin" "$base/build"
revision=b826c169b4831665822529f535f824265f50630b
source_dir="$base/build/zkapi-$revision"
if [[ ! -d "$source_dir/.git" ]]; then
  git init "$source_dir"
  git -C "$source_dir" fetch --depth=1 https://github.com/ethereum/zkapi.git "$revision"
  git -C "$source_dir" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$revision" ]] || { printf 'Wrong source revision\n' >&2; exit 1; }
archive="$base/vendor/zkapi-clientd_0.1.3_linux_arm64.tar.gz"
checksum=1eb8b36618341aa406f6b83b2843c30dbadd5ad08dc86111f94961594b5bc26b
if [[ ! -f "$archive" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 --max-time 600 'https://github.com/ethereum/zkapi/releases/download/clientd-v0.1.3/zkapi-clientd_0.1.3_linux_arm64.tar.gz' -o "$archive.partial"
  printf '%s  %s\n' "$checksum" "$archive.partial" | sha256sum --check --status
  mv "$archive.partial" "$archive"
fi
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
if [[ ! -x "$base/vendor/runtime/bin/zkapi-walletd" ]]; then
  bash "$source_dir/zkapi-clientd/install.sh" --prefix "$base/vendor/runtime" --archive "$archive" --sha256 "$checksum" --version 0.1.3
fi
# The published 0.1.3 walletd and proof assets are unchanged between its release
# commit 39abfedc2c32802e96b5a8214ab1bd24b2b38290 and the source revision above.
node "$checkout/scripts/patch-zkapi-control.mjs" "$source_dir"
cd "$source_dir/zkapi-clientd"
export GOMAXPROCS=2 GOTOOLCHAIN=auto GOFLAGS=-p=2
# Upstream permission-rejection tests intentionally create 0644 fixtures. A
# process-wide 077 mask would silently turn them into valid owner-only files.
(umask 022; go test ./cmd/zkapi-clientd ./internal/config ./internal/server ./internal/zkapi)
go build -trimpath -o "$base/bin/zkapi-clientd-control.new" ./cmd/zkapi-clientd
chmod 755 "$base/bin/zkapi-clientd-control.new"
mv "$base/bin/zkapi-clientd-control.new" "$base/bin/zkapi-clientd-control"
node --input-type=module - "$base" "$revision" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [base, sourceRevision] = process.argv.slice(2);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = { version: 1, sourceRevision, patch: 'VEYL_UNFUNDED_CONTROL_V1', release: 'clientd-v0.1.3',
  clientSha256: hash(base + '/bin/zkapi-clientd-control'), walletSha256: hash(base + '/vendor/runtime/bin/zkapi-walletd'),
  proofManifestSha256: hash(base + '/vendor/runtime/lib/zkapi-clientd/current/share/zkapi-clientd/proof-setup/manifest.json') };
writeFileSync(base + '/bin/runtime-manifest.json', JSON.stringify(manifest, null, 2), { mode: 0o600 });
NODE
printf 'Pinned runtime built and tested; no daemon or wallet was started.\n'
