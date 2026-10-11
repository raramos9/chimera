#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "$@"; }
provider_status() { hcloud server list -o json | jq -r '(. // [])[] | select(.name == "chimera") | .status'; }
latest_file() { remote "sudo chimera-restic dump latest /home/andre/backup-test"; }

"$chimera" sleep
"$chimera" wake
remote "command -v restic chimera-backup" >/dev/null || fail "restic or chimera-backup isn't installed"
remote "systemctl is-enabled chimera-backup.timer" >/dev/null || fail "hourly backup timer isn't enabled"
remote "systemctl is-active chimera-backup-on-shutdown.service" >/dev/null || fail "backup on shutdown isn't armed"
"$chimera" backup-keys

token="backup-$(date +%s)-$RANDOM"
remote "echo $token > backup-test"
remote "sudo chimera-backup" >/dev/null
remote "rm backup-test"
remote "sudo rm -rf /tmp/restore && sudo chimera-restic restore latest --include /home/andre/backup-test --target /tmp/restore" >/dev/null
[ "$(remote "sudo cat /tmp/restore/home/andre/backup-test")" = "$token" ] || fail "restored file doesn't match what was backed up"

snapshot=$(remote "sudo chimera-restic snapshots --latest 1 --json" | jq -r '.[0].id')
remote "sudo chimera-restic forget $snapshot" >/dev/null 2>&1 || true
remote "sudo chimera-restic snapshots --no-cache --json" | jq -e --arg id "$snapshot" 'any(.[]; .id == $id)' >/dev/null \
  || fail "a backup was deleted from the computer, so the R2 lock isn't protecting it"

token="backup-$(date +%s)-$RANDOM"
remote "echo $token > backup-test && sudo sh -c 'echo 2 > /run/chimera-idle/minutes'"
echo "Waiting for the computer to back up and power off on its own..."
off=
for _ in $(seq 60); do
  if [ "$(provider_status)" = off ]; then off=1; break; fi
  sleep 10
done
[ -n "$off" ] || fail "did not power off within 10 minutes of going idle"

"$chimera" sleep
"$chimera" wake
[ "$(latest_file)" = "$token" ] || fail "the backup before idle sleep didn't include the newest file"

token="backup-$(date +%s)-$RANDOM"
remote "echo $token > backup-test"
"$chimera" sleep
"$chimera" wake
[ "$(latest_file)" = "$token" ] || fail "the backup before 'chimera sleep' didn't include the newest file"
remote "rm backup-test"

"$chimera" sleep
[ "$("$chimera" status)" = asleep ] || fail "computer is not asleep after sleep"

echo "PASS: restored a deleted file, R2 refused to delete a backup, backed up before idle sleep and before chimera sleep"
