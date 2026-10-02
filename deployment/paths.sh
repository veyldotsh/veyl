#!/usr/bin/env bash
# Public defaults; pass existing host paths/accounts as explicit private overrides.
base=${VEYL_HOME:-/home/veyl/veyl}
service_user=${VEYL_SERVICE_USER:-veyl}
[[ "$base" =~ ^/([A-Za-z0-9_-][A-Za-z0-9._-]*/)+veyl$ && "$base" != *'/../'* && "$base" != *'/./'* ]] || { printf 'Invalid VEYL_HOME.\n' >&2; exit 1; }
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { printf 'Invalid VEYL_SERVICE_USER.\n' >&2; exit 1; }
export VEYL_HOME="$base" VEYL_SERVICE_USER="$service_user"
# Render templates in memory. Private deployment paths never enter source files.
veyl_render() {
  sed -e "s|/home/veyl/veyl|$base|g" -e "s|^User=veyl$|User=$service_user|" -e "s|^Group=veyl$|Group=$service_user|" "$1"
}
