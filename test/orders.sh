#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"
repo=raramos9/chimera-test

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "$@" </dev/null; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }
drop_branch() { gh api -X DELETE "repos/$repo/git/refs/heads/chimera/$1" >/dev/null 2>&1 || true; }
state_of() { remote "incus list '^$1\$' -c s -f csv"; }

cleanup() {
  for name in c-ord c-ord2; do
    c rm "$name" --force >/dev/null 2>&1 || true
    drop_branch "$name"
  done
  ssh -o ProxyCommand=none -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "incus delete -f c-hand" </dev/null >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
"$chimera" sleep
[ -z "$(provider_status)" ] || fail "the computer didn't go to sleep"

out=$(c new c-ord --repo "$repo")
grep -q "^Waking the computer" <<<"$out" || fail "new didn't say it was waking the computer: $out"
grep -q "c-ord is ready, on branch chimera/c-ord of $repo" <<<"$out" || fail "new didn't report success: $out"
[ "$(c shell c-ord git branch --show-current)" = chimera/c-ord ] || fail "c-ord isn't on its own branch"
echo "PASS: new while asleep wakes the computer and makes the container"

start=$SECONDS
c stop c-ord | grep -q "c-ord is stopped" || fail "stop didn't report success"
took=$((SECONDS - start))
[ "$took" -le 15 ] || fail "stop took ${took}s on an awake computer, so the Worker's nudge didn't arrive"
c stop c-ord | grep -q "c-ord is stopped" || fail "a second stop didn't report success"
[ "$(state_of c-ord)" = STOPPED ] || fail "c-ord isn't stopped"
echo "PASS: stop took ${took}s on an awake computer, and stopping twice is harmless"

c start c-ord | grep -q "c-ord is running" || fail "start didn't report success"
[ "$(state_of c-ord)" = RUNNING ] || fail "c-ord isn't running after start"

c shell c-ord git commit -q --allow-empty -m "orders test work"
if out=$(c rm c-ord --yes 2>&1); then fail "rm --yes deleted a container with an unpushed commit"; fi
grep -q "orders test work" <<<"$out" || fail "rm didn't show the unpushed commit: $out"
[ "$(state_of c-ord)" = RUNNING ] || fail "the refused rm changed c-ord"
c rm c-ord --force | grep -q "deleted c-ord" || fail "rm --force didn't report success"
[ -z "$(state_of c-ord)" ] || fail "rm --force left c-ord behind"
! grep -q '^c-ord ' <<<"$(c ls)" || fail "ls still shows c-ord"
echo "PASS: start, and rm refuses unpushed work until --force"

out=$(remote "chimera new c-ord2") || fail "host-side new failed: $out"
grep -q "c-ord2 is ready" <<<"$out" || fail "host-side new didn't report success: $out"
[ "$(state_of c-ord2)" = RUNNING ] || fail "host-side new didn't make c-ord2"
grep -q '^c-ord2 .*running *running' <<<"$(c ls)" || fail "ls doesn't show the host-made c-ord2 as wanted running"
echo "PASS: chimera new on the computer orders through the Worker"

remote "incus copy base c-hand"
c rm c-ord2 --yes >/dev/null
grep -q '^c-hand .*not managed' <<<"$(c ls)" || fail "ls doesn't show c-hand as not managed"
[ "$(state_of c-hand)" = STOPPED ] || fail "a round touched c-hand"
echo "PASS: a container made by hand shows as not managed and is left alone"
