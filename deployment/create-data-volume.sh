#!/usr/bin/env bash
# Optional hard disk boundary for a shared VPS. Run only after reviewing space.
# Never formats a block device, replaces an image, or hides existing data.
set -euo pipefail
[[ "$(id -u)" == 0 ]] || { printf 'Run this isolated volume setup as root.\n' >&2; exit 1; }
source "$(dirname -- "${BASH_SOURCE[0]}")/paths.sh"
image="$base/worker-data.ext4"
target="$base/worker-data"
[[ ! -e "$image" ]] || { printf 'Volume image already exists; preserve it.\n' >&2; exit 1; }
[[ ! -L "$base" && ! -L "$target" ]] || { printf 'Symlink target rejected.\n' >&2; exit 1; }
mkdir -p "$target"
[[ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { printf 'Target is not empty; preserve existing data.\n' >&2; exit 1; }
mountpoint -q "$target" && { printf 'Target is already mounted.\n' >&2; exit 1; }
# A fully allocated 2 GiB image bounds Veyl disk usage and avoids sparse growth
# consuming the root filesystem unexpectedly. Keep at least 4 GiB free outside it.
available=$(df --output=avail -B1 "$base" | tail -n 1 | tr -d ' ')
(( available >= 6442450944 )) || { printf 'Less than 6 GiB available; no volume created.\n' >&2; exit 1; }
fallocate -l 2147483648 "$image"
chmod 600 "$image"
mkfs.ext4 -q -F "$image"
mount -o loop,nodev,nosuid,noexec "$image" "$target"
chown "$service_user:$service_user" "$target"
chmod 700 "$target"
printf 'Bounded Veyl data volume mounted at %s. Configure VEYL_DATA_DIR there; arrange this mount before service startup after reboot.\n' "$target"
