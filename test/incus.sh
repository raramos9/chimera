#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "$@" </dev/null; }
state() { remote "incus info $1" | awk '/^Status:/{print $2}'; }
online() { remote "incus exec $1 -- timeout 5 bash -c '</dev/tcp/1.1.1.1/443'" 2>/dev/null; }

wake_until_incus() {
  local start=$(date +%s)
  "$chimera" wake
  for _ in $(seq 60); do
    remote incus storage show default >/dev/null 2>&1 && break
    sleep 3
  done
  remote incus storage show default >/dev/null || fail "incus didn't answer for andre within 3 minutes of SSH coming up"
  incus_seconds=$(( $(date +%s) - start ))
}

"$chimera" sleep
wake_until_incus

[ "$(remote "findmnt -n -o LABEL /home")" = chimera-home ] || fail "/home isn't the disk labelled chimera-home"
pool=$(remote 'readlink -f "$(blkid -U "$(incus storage get default source)")"')
[ "$pool" = "$(remote 'readlink -f "$(cat /run/chimera/machines-disk)"')" ] || fail "the storage pool is on $pool, not the machines disk"
[ "$(remote "findmnt -n -o FSTYPE /var/lib/incus/storage-pools/default")" = btrfs ] || fail "the storage pool isn't btrfs"

remote "incus delete -f chimera-test chimera-test-fork >/dev/null 2>&1; true"
token="incus-$(date +%s)-$RANDOM"
remote "incus launch images:ubuntu/24.04 chimera-test >/dev/null && incus exec chimera-test -- sh -c 'echo $token > /root/token'"
remote "incus copy chimera-test chimera-test-fork && incus start chimera-test-fork"
remote "incus exec chimera-test-fork -- sh -c 'echo fork > /root/only-in-fork'"
for c in chimera-test chimera-test-fork; do
  for _ in $(seq 20); do online "$c" && break; sleep 1; done
  online "$c" || fail "$c can't reach the internet"
done
remote "docker run --rm alpine nc -z -w 5 1.1.1.1 443" || fail "a Docker container on the host can't reach the internet"

"$chimera" sleep
[ "$("$chimera" status | head -1)" = asleep ] || fail "computer is not asleep after sleep"
wake_until_incus

for c in chimera-test chimera-test-fork; do
  for _ in $(seq 30); do [ "$(state "$c")" = RUNNING ] && break; sleep 1; done
  [ "$(state "$c")" = RUNNING ] || fail "$c didn't start again after wake"
  [ "$(remote "incus exec $c -- cat /root/token")" = "$token" ] || fail "the file in $c didn't survive sleep"
  for _ in $(seq 20); do online "$c" && break; sleep 1; done
  online "$c" || fail "$c can't reach the internet after wake"
done
remote "incus exec chimera-test -- test ! -e /root/only-in-fork" || fail "a change in the fork showed up in the original"

boot=$(remote "cat /proc/sys/kernel/random/boot_id")
remote "sudo systemctl reboot" || true
for _ in $(seq 60); do
  now=$(remote "cat /proc/sys/kernel/random/boot_id" 2>/dev/null || true)
  [ -n "$now" ] && [ "$now" != "$boot" ] && break
  sleep 5
done
[ -n "$now" ] && [ "$now" != "$boot" ] || fail "the computer didn't come back from a reboot within 5 minutes"
for _ in $(seq 30); do [ "$(state chimera-test 2>/dev/null)" = RUNNING ] && break; sleep 2; done
[ "$(state chimera-test)" = RUNNING ] || fail "Incus didn't come back after a reboot"

backup=$(remote "sudo chimera-restic ls --recursive latest /home/.chimera/incus /home/.chimera/docker/volumes")
grep -q '^/home/.chimera/incus/database' <<<"$backup" || fail "the shutdown backup is missing Incus's records"
! grep -q '^/home/.chimera/incus/storage-pools/default/' <<<"$backup" || fail "the shutdown backup copied the containers"
grep -q '^/home/.chimera/docker/volumes' <<<"$backup" || fail "the shutdown backup is missing Docker volumes"

remote "incus delete -f chimera-test chimera-test-fork"

echo "Wake timing: incus answered ${incus_seconds}s after wake started"
echo "PASS: containers on chimera-machines survived sleep, wake and reboot, restarted, kept their files and internet, and stayed out of the backup"
