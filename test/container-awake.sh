#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "$@" </dev/null; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }

wake_with_short_timeout() {
  "$chimera" sleep
  "$chimera" wake
  for _ in $(seq 60); do remote "incus list" >/dev/null 2>&1 && break; sleep 3; done
  remote "sudo sh -c 'echo 2 > /run/chimera-idle/minutes'"
}

stays_awake_for_4_minutes() {
  echo "Waiting 4 minutes with nobody connected..."
  sleep 240
  [ "$(provider_status)" = running ] || fail "slept while $1"
}

powers_off_within() {
  for _ in $(seq "$1"); do
    [ "$(provider_status)" = off ] && return
    sleep 10
  done
  fail "$2"
}

wake_with_short_timeout
remote "incus profile device get default awake readonly" | grep -qx true || fail "containers don't get the awake lock, read-only"
c rm c-awake --yes >/dev/null 2>&1 || true
c base >/dev/null
c new c-awake >/dev/null
c shell c-awake test -e /etc/claude-code/managed-settings.json || fail "Claude's busy hooks aren't in the container"
! c shell c-awake touch /var/lib/chimera-awake/x 2>/dev/null || fail "a container can write to the computer's lock folder"
c run c-awake -- sleep 300 >/dev/null
stays_awake_for_4_minutes "'chimera run' had a command running in a container"
powers_off_within 40 "did not power off after the container's command finished"

wake_with_short_timeout
c shell c-awake bash -c 'cp /bin/bash /tmp/claude; echo "{\"hook_event_name\": \"UserPromptSubmit\"}" > /tmp/prompt.json; setsid -f /tmp/claude -c "chimera-agent-busy < /tmp/prompt.json; sleep 3600; true" </dev/null >/dev/null 2>&1'
stays_awake_for_4_minutes "Claude's busy hook held the lock inside a container"
c shell c-awake pkill -KILL -x claude
sleep 3
remote "flock -n -x /var/lib/chimera-awake/awake.lock true" || fail "the lock stayed held after the container's Claude was killed"
c rm c-awake --yes >/dev/null
powers_off_within 40 "did not power off after the container's Claude was killed"

"$chimera" sleep
[ "$("$chimera" status | head -1)" = asleep ] || fail "computer is not asleep after sleep"

echo "PASS: commands and Claude inside containers keep the computer awake, and it sleeps once they end or are killed"
