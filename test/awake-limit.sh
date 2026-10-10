#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
chimera="$root/bin/chimera"
limit=10
force_after=$((limit + 15))

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "andre@$ip" "$@"; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }
deploy() { (cd "$root/control" && npx wrangler deploy "$@" >/dev/null); }

restore() {
  echo "Restoring the 24-hour limit..."
  deploy || echo "WARNING: restore failed. Run 'npx wrangler deploy' from control/ now." >&2
}
trap restore EXIT

echo "Deploying the Worker with a $limit-minute limit..."
deploy --var "MAX_AWAKE_MINUTES:$limit"

"$chimera" sleep
woke=$(date +%s)
"$chimera" wake
ip=$(hcloud server ip chimera)

remote "sudo mkdir -p /run/chimera-idle && echo 1000 | sudo tee /run/chimera-idle/minutes >/dev/null"

echo "Waiting for the Worker to shut the server down and delete it (up to $force_after minutes)..."
saw_off=
while [ $(( $(date +%s) - woke )) -lt $((force_after * 60)) ]; do
  status=$(provider_status)
  [ "$status" = off ] && saw_off=1
  if [ -z "$status" ]; then
    elapsed=$(( ($(date +%s) - woke) / 60 ))
    [ "$elapsed" -ge "$limit" ] || fail "server was deleted after $elapsed minutes, before the $limit-minute limit"
    [ "$("$chimera" status)" = asleep ] || fail "computer is not asleep"
    hcloud volume describe chimera-home >/dev/null || fail "volume was deleted"
    echo "PASS: the Worker shut down and deleted the server $elapsed minutes after waking${saw_off:+ (seen powered off first)}"
    exit 0
  fi
  sleep 15
done
fail "server still exists $force_after minutes after waking, the shutdown didn't happen in time"
