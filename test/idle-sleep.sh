#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o StrictHostKeyChecking=yes andre@chimera "$@"; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }

woke=
cleanup() {
  if [ "$?" -ne 0 ] && [ -n "$woke" ]; then remote rm -f .keep-awake 2>/dev/null || true; fi
}
trap cleanup EXIT

"$chimera" sleep
"$chimera" wake
woke=1

sshd_config=$(remote sudo sshd -T)
echo "$sshd_config" | grep -qx 'clientaliveinterval 60' || fail "dead-connection setting missing"
echo "$sshd_config" | grep -qx 'clientalivecountmax 3' || fail "dead-connection setting missing"

remote "sudo mkdir -p /run/chimera-idle && sudo sh -c 'echo 2 > /run/chimera-idle/minutes' && touch .keep-awake"

echo "Waiting 4 minutes with keep-awake set..."
sleep 240
[ "$(provider_status)" = running ] || fail "slept despite keep-awake"

remote rm .keep-awake
off=
for _ in $(seq 30); do
  if [ "$(provider_status)" = off ]; then off=1; break; fi
  sleep 10
done
[ -n "$off" ] || fail "did not power off after 2 idle minutes"

"$chimera" sleep
[ "$("$chimera" status)" = asleep ] || fail "computer is not asleep after sleep"

echo "PASS: powered off when idle, stayed on with keep-awake"
