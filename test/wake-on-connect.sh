#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
connect() { ssh -o BatchMode=yes chimera "$@"; }
boot_id() { connect cat /proc/sys/kernel/random/boot_id; }

ssh -G chimera | grep -q '^proxycommand .*chimera connect$' || fail "~/.ssh/config doesn't send chimera through 'chimera connect'"

"$chimera" sleep
start=$SECONDS
first_boot=$(boot_id) || fail "ssh chimera didn't wake the sleeping computer"
echo "asleep to connected: $((SECONDS - start))s"

start=$SECONDS
[ "$(boot_id)" = "$first_boot" ] || fail "connecting to an awake computer rebooted it"
[ $((SECONDS - start)) -le 5 ] || fail "connecting to an awake computer took $((SECONDS - start))s"
echo "awake to connected: $((SECONDS - start))s"

connect "sudo systemctl poweroff" || true
sleep 5
start=$SECONDS
second_boot=$(boot_id) || fail "ssh chimera didn't wake a computer that was going to sleep"
[ "$second_boot" != "$first_boot" ] || fail "connected to the computer that was shutting down"
echo "going to sleep to connected: $((SECONDS - start))s"

"$chimera" sleep
echo "PASS: ssh chimera wakes a sleeping computer, connects quickly to an awake one, and waits out a shutdown"
