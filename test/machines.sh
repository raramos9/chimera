#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }

"$chimera" sleep
"$chimera" wake
for _ in $(seq 60); do c ls >/dev/null 2>&1 && break; sleep 3; done

c rm m-test --yes >/dev/null 2>&1 || true
c rm m-test-fork --yes >/dev/null 2>&1 || true

start=$(date +%s)
c base >/dev/null
base_seconds=$(( $(date +%s) - start ))

c new m-test "the machines test" >/dev/null
c fork m-test m-test-fork >/dev/null
listing=$(c ls -f csv)
grep -q '^m-test-fork,RUNNING,m-test,,' <<<"$listing" || fail "ls doesn't show m-test-fork forked from m-test: $listing"
grep -q '^m-test,RUNNING,base,the machines test,' <<<"$listing" || fail "ls doesn't show m-test's origin and task: $listing"

c run m-test -- sh -c 'printf "%s|" "$@" > ~/args' x 'a b' "it's" '$HOME' >/dev/null
for _ in $(seq 20); do c shell m-test test -e args && break; sleep 0.5; done
[ "$(c shell m-test cat args)" = "a b|it's|\$HOME|" ] || fail "run didn't pass its arguments through unchanged"
! c shell m-test-fork test -e args || fail "a file made in m-test showed up in its fork"

[ "$(c shell m-test whoami)" = andre ] || fail "shell isn't andre inside the container"
c shell m-test claude --version >/dev/null || fail "Claude Code isn't installed in the container"
c shell m-test gh --version >/dev/null || fail "gh isn't installed in the container"
[ "$(c shell m-test git config user.email)" = ralphandrer04@gmail.com ] || fail "git has no identity in the container"
[ "$(c shell m-test sh -c "free -m | awk '/Mem/{print \$2}'")" = 1536 ] || fail "the container isn't capped at 1536 MB"
c shell m-test docker run --rm hello-world | grep -q 'Hello from Docker' || fail "Docker doesn't work inside the container"

! c shell base true 2>/dev/null || fail "shell was allowed to change base"
! c rm m-test 2>/dev/null || fail "rm deleted without --yes or a terminal"

c rm m-test-fork --yes >/dev/null
c rm m-test --yes >/dev/null
! grep -q m-test <<<"$(c ls)" || fail "rm left a container behind"

echo "Timing: chimera base took ${base_seconds}s"
echo "PASS: base, new, fork, ls, run, shell and rm work from the laptop after a wake"
