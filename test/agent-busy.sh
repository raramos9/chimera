#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 dev@chimera "$@"; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }

wake_with_short_timeout() {
  "$chimera" sleep
  "$chimera" wake
  remote "command -v chimera-agent-busy" >/dev/null || fail "chimera-agent-busy isn't installed"
  remote "sudo sh -c 'echo 2 > /run/chimera-idle/minutes'"
}

start_claude_with_background_task() {
  remote "mkdir -p /tmp/agent-busy-test && tmux new-session -d -x 200 -y 50 -s agentbusy -c /tmp/agent-busy-test ~/.local/bin/claude"
  sleep 8
  if remote "tmux capture-pane -p -t agentbusy" | grep -qi "trust this folder"; then
    remote "tmux send-keys -t agentbusy Down Enter"
    sleep 5
  fi
  remote "tmux send-keys -t agentbusy 'Run the shell command \"sleep 240\" in the background, then end your turn without waiting for it.'"
  sleep 2
  remote "tmux send-keys -t agentbusy C-m"
}

stays_awake_for_4_minutes() {
  echo "Waiting 4 minutes with nobody connected..."
  sleep 240
  [ "$(provider_status)" = running ] || fail "slept while Claude's background task was running"
}

powers_off_within() {
  for _ in $(seq "$1"); do
    [ "$(provider_status)" = off ] && return
    sleep 10
  done
  fail "$2"
}

wake_with_short_timeout
start_claude_with_background_task
stays_awake_for_4_minutes
powers_off_within 30 "stayed awake while Claude was waiting for input"

echo "PASS: stayed awake while Claude's background task ran, slept once Claude was waiting for input"
