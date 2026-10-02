#!/usr/bin/env bash
# Reload only after renewal of Veyl's dedicated certificate. Existing sites
# and their certificates are not modified.
set -euo pipefail
[[ "${RENEWED_LINEAGE:-}" == /etc/letsencrypt/live/runtime.veyl.sh ]] || exit 0
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
