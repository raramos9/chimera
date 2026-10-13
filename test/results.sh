#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"
repo=raramos9/chimera-test

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }
drop_branch() { gh api -X DELETE "repos/$repo/git/refs/heads/chimera/$1" >/dev/null 2>&1 || true; }

cleanup() {
  c rm c-res --force >/dev/null 2>&1 || true
  c rm c-res-fork --force >/dev/null 2>&1 || true
  c rm c-bad --force >/dev/null 2>&1 || true
  drop_branch c-res
  drop_branch c-res-fork
}
trap cleanup EXIT

"$chimera" sleep
"$chimera" wake
for _ in $(seq 60); do c ls >/dev/null 2>&1 && break; sleep 3; done

cleanup

! c new c-bad "x" --repo raramos9/does-not-exist-xyz >/dev/null 2>&1 || fail "new succeeded for a repo that doesn't exist"
! grep -q c-bad <<<"$(c ls)" || fail "a failed new left c-bad behind"

c new c-res "results test" --repo "$repo" >/dev/null
listing=$(c ls -f csv)
grep -q "^c-res,RUNNING,base,results test,$repo,chimera/c-res," <<<"$listing" || fail "ls doesn't show c-res with its repo and branch: $listing"

[ "$(c shell c-res pwd)" = /home/andre/chimera-test ] || fail "shell doesn't start in the repo checkout"
[ "$(c shell c-res git branch --show-current)" = chimera/c-res ] || fail "new didn't put c-res on its own branch"

out=$(c results c-res)
grep -q "nothing uncommitted" <<<"$out" || fail "results doesn't say a clean checkout has nothing uncommitted: $out"
grep -q "no commits yet" <<<"$out" || fail "results doesn't say a new branch has no commits: $out"

c shell c-res sh -c 'echo hello > note.txt'
grep -q note.txt <<<"$(c results c-res)" || fail "results doesn't list an uncommitted file"
! c rm c-res --yes >/dev/null 2>&1 || fail "rm deleted a container with an uncommitted file"
c shell c-res true || fail "rm with an uncommitted file removed the container anyway"

c shell c-res sh -c 'git add note.txt && git commit -qm "add note"'
out=$(c results c-res)
grep -q "add note" <<<"$out" || fail "results doesn't list the new commit: $out"
grep -q "not on GitHub" <<<"$out" || fail "results doesn't say the commit is missing from GitHub: $out"
grep -q '+hello' <<<"$(c results c-res --diff)" || fail "results --diff doesn't show the change"
! c rm c-res --yes >/dev/null 2>&1 || fail "rm deleted a container with an unpushed commit"
c shell c-res true || fail "rm with an unpushed commit removed the container anyway"

c fork c-res c-res-fork >/dev/null
[ "$(c shell c-res-fork git branch --show-current)" = chimera/c-res-fork ] || fail "fork didn't put the copy on its own branch"
grep -q "^c-res-fork,RUNNING,c-res,,$repo,chimera/c-res-fork," <<<"$(c ls -f csv)" || fail "ls doesn't show the fork's repo and branch"
[ "$(c shell c-res-fork git log -1 --format=%s)" = "add note" ] || fail "the fork didn't keep the parent's commit"

c shell c-res git push -q -u origin chimera/c-res
grep -q "everything is pushed" <<<"$(c results c-res)" || fail "results doesn't say everything is pushed after a push"
c rm c-res --yes >/dev/null || fail "rm refused a container whose work is all pushed"

c shell c-res-fork sh -c 'echo more >> note.txt'
! c rm c-res-fork --yes >/dev/null 2>&1 || fail "rm deleted a fork with uncommitted changes"
c rm c-res-fork --force >/dev/null || fail "rm --force didn't delete a dirty fork"

listing=$(c ls)
! grep -q 'c-res' <<<"$listing" || fail "a container is still listed: $listing"
drop_branch c-res

echo "PASS: new --repo, fork, results and rm protect unpushed work"
