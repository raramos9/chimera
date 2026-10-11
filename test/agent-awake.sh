#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "$@"; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }

wake_with_short_timeout() {
  "$chimera" sleep
  "$chimera" wake
  remote "command -v awake" >/dev/null || fail "awake isn't installed"
  remote "sudo sh -c 'echo 2 > /run/chimera-idle/minutes'"
}

start_in_tmux() {
  remote "tmux new-session -d -s agent 'awake $1'"
}

stays_awake_for_4_minutes() {
  echo "Waiting 4 minutes with nobody connected..."
  sleep 240
  [ "$(provider_status)" = running ] || fail "slept while '$1' was running under awake"
}

powers_off_within() {
  for _ in $(seq "$1"); do
    [ "$(provider_status)" = off ] && return
    sleep 10
  done
  fail "$2"
}

wake_with_short_timeout
start_in_tmux "sleep 300"
stays_awake_for_4_minutes "sleep 300"
powers_off_within 40 "did not power off after the awake command finished"

wake_with_short_timeout
start_in_tmux "sleep 3600"
stays_awake_for_4_minutes "sleep 3600"
remote "pkill -KILL -x sleep"
powers_off_within 40 "did not power off after the awake command was killed"

"$chimera" sleep
[ "$("$chimera" status)" = asleep ] || fail "computer is not asleep after sleep"

echo "PASS: stayed awake while an awake command ran, slept after it finished or was killed"
