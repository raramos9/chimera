#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"
repo=raramos9/chimera-test
name=c-agent

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "$@" </dev/null; }
drop_branch() { gh api -X DELETE "repos/$repo/git/refs/heads/chimera/$name" >/dev/null 2>&1 || true; }
agent_file() { remote "incus exec $name -- cat /home/andre/.config/chimera/agent" 2>/dev/null || true; }
reported_agent() { remote "chimera report" | jq -r --arg n "$name" '.workspaces[] | select(.name == $n) | .agent // "none"'; }
pushed_hello() { gh api "repos/$repo/contents/HELLO.md?ref=chimera/$name" --jq .content 2>/dev/null | base64 -d 2>/dev/null; }

cleanup() {
  c rm "$name" --force >/dev/null 2>&1 || true
  drop_branch
}
trap cleanup EXIT

cleanup
"$chimera" sleep

out=$(c new "$name" "Add a file HELLO.md containing the single word hello." --repo "$repo")
grep -q "$name is ready" <<<"$out" || fail "new didn't report success: $out"
remote "incus exec $name -- sudo -iu andre tmux list-windows -t main -F '#W'" | grep -qx claude \
  || fail "there's no tmux window called claude in $name, so Claude wasn't started"
echo "PASS: new with a task and repo opened Claude in a tmux window"

saw_working=
for _ in $(seq 90); do
  [ "$(agent_file)" = working ] && { saw_working=1; break; }
  [ -n "$(pushed_hello)" ] && break
  sleep 2
done
[ -n "$saw_working" ] || fail "Claude never reported working. A startup screen may be waiting for a click: run 'chimera shell $name' and look at the claude window"

for _ in $(seq 60); do
  [ "$(pushed_hello)" = hello ] && break
  sleep 5
done
[ "$(pushed_hello)" = hello ] || fail "chimera/$name on GitHub has no HELLO.md saying hello after 5 minutes. Look at the claude window with 'chimera shell $name'"
echo "PASS: Claude worked without asking and pushed HELLO.md to chimera/$name"

for _ in $(seq 30); do
  [ "$(reported_agent)" = waiting ] && break
  sleep 2
done
[ "$(reported_agent)" = waiting ] || fail "the computer's report says agent '$(reported_agent)' after Claude finished, not waiting"
for _ in $(seq 40); do
  grep -q "^$name .*waiting" <<<"$(c ls)" && break
  sleep 5
done
grep -q "^$name .*waiting" <<<"$(c ls)" || fail "chimera ls never showed $name's agent as waiting"
echo "PASS: the report and chimera ls show the agent as waiting once done"

c rm "$name" --yes | grep -q "deleted $name" || fail "rm refused although Claude pushed everything"
drop_branch
"$chimera" sleep
echo "PASS: Claude started on create, worked unattended, pushed its branch, and ls tracked it"
