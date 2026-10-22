#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 dev@chimera "$@" </dev/null; }

"$chimera" sleep
"$chimera" wake
for _ in $(seq 60); do remote "incus list" >/dev/null 2>&1 && break; sleep 3; done

c rm m-test --yes >/dev/null 2>&1 || true
c rm m-test-fork --yes >/dev/null 2>&1 || true

start=$(date +%s)
c base >/dev/null
base_seconds=$(( $(date +%s) - start ))

c new m-test "the machines test" >/dev/null
c fork m-test m-test-fork >/dev/null
listing=$(remote "chimera ls -f csv")
grep -q '^m-test-fork,RUNNING,m-test,,' <<<"$listing" || fail "ls doesn't show m-test-fork forked from m-test: $listing"
grep -q '^m-test,RUNNING,base,the machines test,' <<<"$listing" || fail "ls doesn't show m-test's origin and task: $listing"

c run m-test -- sh -c 'printf "%s|" "$@" > ~/args' x 'a b' "it's" '$HOME' >/dev/null
for _ in $(seq 20); do c shell m-test test -e args && break; sleep 0.5; done
[ "$(c shell m-test cat args)" = "a b|it's|\$HOME|" ] || fail "run didn't pass its arguments through unchanged"
! c shell m-test-fork test -e args || fail "a file made in m-test showed up in its fork"

[ "$(c shell m-test whoami)" = dev ] || fail "shell isn't dev inside the container"
c shell m-test claude --version >/dev/null || fail "Claude Code isn't installed in the container"
c shell m-test gh --version >/dev/null || fail "gh isn't installed in the container"
c shell m-test test -e .claude/skills/poteto-mode/SKILL.md || fail "the container doesn't have the skills from raramos9/ack"
c shell m-test test -e .claude/CLAUDE.md || fail "the container doesn't have CLAUDE.md from raramos9/ack"
c shell m-test claude plugin list | grep -q 'code-review@claude-plugins-official' || fail "the container doesn't have the enabled plugins"
c shell m-test bun --version >/dev/null || fail "bun isn't on the container's PATH"
[ "$(c shell m-test git config user.email)" = ralphandrer04@gmail.com ] || fail "git has no identity in the container"
cap=$(( $(remote "awk '/^MemTotal:/ { print int(\$2 / 1024) }' /proc/meminfo") - 512 ))
[ "$cap" -ge 1536 ] || cap=1536
[ "$(c shell m-test sh -c "free -m | awk '/Mem/{print \$2}'")" = "$cap" ] || fail "the container isn't capped at $cap MB, 512 MB under the computer's memory"
c shell m-test docker run --rm hello-world | grep -q 'Hello from Docker' || fail "Docker doesn't work inside the container"

! c shell base true 2>/dev/null || fail "shell was allowed to change base"
! c rm m-test 2>/dev/null || fail "rm deleted without --yes or a terminal"

c rm m-test-fork --yes >/dev/null
c rm m-test --yes >/dev/null
! grep -q m-test <<<"$(remote "chimera ls")" || fail "rm left a container behind"

echo "Timing: chimera base took ${base_seconds}s"
echo "PASS: base, new, fork, ls, run, shell and rm work from the laptop after a wake"
