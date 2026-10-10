#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o StrictHostKeyChecking=yes andre@chimera "$@"; }
host_key() { ssh-keyscan -t ed25519 "$1" 2>/dev/null | awk '!/^#/ { print $2, $3 }'; }

"$chimera" wake
key_before=$(host_key chimera)
token="sleep-wake-$(date +%s)-$RANDOM"
remote "echo $token > .sleep-wake-test"

"$chimera" sleep
[ "$("$chimera" status)" = asleep ] || fail "computer is not asleep after sleep"

"$chimera" wake
[ "$(host_key chimera)" = "$key_before" ] || fail "host key changed"
[ "$(remote cat .sleep-wake-test)" = "$token" ] || fail "file did not survive sleep"
remote rm .sleep-wake-test

echo "PASS: file and host key survived sleep and wake"
