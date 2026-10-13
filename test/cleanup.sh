#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o StrictHostKeyChecking=yes andre@chimera "$@"; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }

[ "$(hcloud volume describe chimera-home -o json | jq -r .protection.delete)" = true ] \
  || fail "volume chimera-home is not delete-protected"
[ "$(hcloud primary-ip describe chimera-ip -o json | jq -r .protection.delete)" = true ] \
  || fail "primary IP chimera-ip is not delete-protected"

"$chimera" wake

remote sudo systemctl poweroff || true

echo "Waiting up to 7 minutes for the cleanup worker..."
gone=
for _ in $(seq 28); do
  if [ -z "$(provider_status)" ]; then gone=1; break; fi
  sleep 15
done
[ -n "$gone" ] || fail "server still exists 7 minutes after powering off"

hcloud volume describe chimera-home >/dev/null || fail "volume was deleted"
hcloud primary-ip describe chimera-ip >/dev/null || fail "primary IP was deleted"

[ "$("$chimera" status | head -1)" = asleep ] || fail "computer is not asleep after cleanup"

echo "PASS: cleanup worker deleted the powered-off server and kept the volume and address"
