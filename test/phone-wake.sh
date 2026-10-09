#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"
config="$HOME/.config/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }

for f in wake-url wake-token; do
  [ -f "$config/$f" ] || fail "$config/$f is missing"
done
url=$(cat "$config/wake-url")
token=$(cat "$config/wake-token")

body=
wake() {
  local out
  out=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $1" "$url/wake")
  body=${out%$'\n'*}
  status=${out##*$'\n'}
}

"$chimera" sleep

wake "not-the-password"
[ "$status" = 401 ] || fail "wrong password was accepted ($status: $body)"
[ -z "$(provider_status)" ] || fail "server was created with a wrong password"

wake "$token"
[ "$status" = 202 ] || fail "waking returned $status: $body"

ip=$(hcloud primary-ip describe chimera-ip -o json | jq -r .ip)
answered=
for _ in $(seq 36); do
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "andre@$ip" true 2>/dev/null; then answered=1; break; fi
  sleep 5
done
[ -n "$answered" ] || fail "SSH didn't answer within 3 minutes of waking"

wake "$token"
[ "$status" = 200 ] && [ "$body" = "Already awake." ] || fail "second wake returned $status: $body"

"$chimera" sleep
[ "$("$chimera" status)" = asleep ] || fail "computer is not asleep after sleeping"

echo "PASS: phone wake refused a wrong password, woke the computer, and left a running one alone"
