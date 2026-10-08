#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "andre@$ip" "$@"; }
host_key() { ssh-keyscan -t ed25519 "$1" 2>/dev/null; }

"$chimera" wake
ip=$(hcloud server ip chimera)
ip_before=$ip
key_before=$(host_key "$ip")
token="sleep-wake-$(date +%s)-$RANDOM"
remote "echo $token > ~/.sleep-wake-test"

"$chimera" sleep
[ "$("$chimera" status)" = asleep ] || fail "computer is not asleep after sleep"

"$chimera" wake
ip=$(hcloud server ip chimera)
[ "$ip" = "$ip_before" ] || fail "address changed from $ip_before to $ip"
[ "$(host_key "$ip")" = "$key_before" ] || fail "host key changed"
[ "$(remote cat ~/.sleep-wake-test)" = "$token" ] || fail "file did not survive sleep"
remote rm ~/.sleep-wake-test

echo "PASS: file, host key, and address survived sleep and wake"
