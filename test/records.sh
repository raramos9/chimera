#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"
config="$HOME/.config/chimera"
repo=raramos9/chimera-test

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "$@" </dev/null; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }
drop_branch() { gh api -X DELETE "repos/$repo/git/refs/heads/chimera/$1" >/dev/null 2>&1 || true; }
state() {
  local url
  url=$(cat "$config/wake-url")
  printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$config/wake-token")" | curl -fsS --max-time 10 -H @- "${url%/wake}/state"
}

remove() {
  c rm c-rec --force >/dev/null 2>&1 || true
  drop_branch c-rec
}
cleanup() {
  remove
  "$chimera" sleep >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$chimera" sleep
"$chimera" wake
for _ in $(seq 60); do remote "incus list" >/dev/null 2>&1 && break; sleep 3; done

remove

c new c-rec --repo "$repo" >/dev/null
subject="c-rec unpushed $RANDOM"
c shell c-rec git commit --allow-empty -m "$subject" >/dev/null

out=$(remote "sudo chimera-agent" 2>&1) || fail "the report didn't reach the Worker: $out"
! grep -q "no token yet" <<<"$out" || fail "the computer has no agent token. Run 'chimera agent-key' and set AGENT_TOKEN on the Worker (see the README)"
listing=$(c ls)
grep -q '^c-rec ' <<<"$listing" || fail "ls doesn't show c-rec after a report: $listing"
grep -q "$subject" <<<"$listing" || fail "ls doesn't show c-rec's unpushed commit: $listing"
[ "$(c status | head -1)" = awake ] || fail "status isn't awake after a report"

remote "sudo sh -c 'echo 1 > /run/chimera-idle/minutes'"
gone=
for _ in $(seq 90); do
  if [ -z "$(provider_status)" ]; then gone=1; break; fi
  sleep 10
done
[ -n "$gone" ] || fail "the server was still there 15 minutes after going idle"

status=$(c status)
[ "$(head -1 <<<"$status")" = asleep ] || fail "status isn't asleep with no server: $status"
sed -n 2p <<<"$status" | grep -q 'Last report' || fail "status doesn't say how old the last report is: $status"
listing=$(c ls)
grep -q '^c-rec ' <<<"$listing" || fail "ls doesn't show c-rec while asleep: $listing"
grep -q "$subject" <<<"$listing" || fail "ls doesn't show c-rec's unpushed commit while asleep: $listing"
[ -z "$(provider_status)" ] || fail "status or ls woke the computer"

reset=
for _ in $(seq 40); do
  if [ "$(state | jq -r .want)" = asleep ]; then reset=1; break; fi
  sleep 10
done
[ -n "$reset" ] || fail "the Worker still wants the computer awake after an idle sleep"

echo "PASS: status and ls work from the Worker while the computer sleeps, and an idle sleep resets want"
