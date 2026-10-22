#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 dev@chimera "$@"; }

wake_until_docker() {
  local start=$(date +%s)
  "$chimera" wake
  for _ in $(seq 60); do
    remote docker info >/dev/null 2>&1 && break
    sleep 3
  done
  remote docker info >/dev/null || fail "docker didn't answer for dev within 3 minutes of SSH coming up"
  docker_seconds=$(( $(date +%s) - start ))
}

"$chimera" sleep
wake_until_docker

size_gb=$(remote "df -BG --output=size /home | tail -1 | tr -dc 0-9")
[ "$size_gb" -ge 19 ] || fail "/home is ${size_gb}G, it didn't grow to the 20 GB volume"

remote "docker rm -f chimera-test >/dev/null 2>&1; true"
token="docker-$(date +%s)-$RANDOM"
remote "docker run --rm -v chimera-test:/data alpine sh -c 'echo $token > /data/token'"
remote "docker run -d --name chimera-test --restart=always alpine sleep infinity" >/dev/null
image_before=$(remote "docker image inspect -f '{{.Id}}' alpine")

"$chimera" sleep
[ "$("$chimera" status | head -1)" = asleep ] || fail "computer is not asleep after sleep"
wake_until_docker

[ "$(remote "docker image inspect -f '{{.Id}}' alpine")" = "$image_before" ] || fail "alpine image didn't survive sleep"
[ "$(remote "docker run --rm --pull=never -v chimera-test:/data alpine cat /data/token")" = "$token" ] \
  || fail "file in the docker volume didn't survive sleep"
for _ in $(seq 10); do
  [ "$(remote "docker inspect -f '{{.State.Running}}' chimera-test")" = true ] && break
  sleep 1
done
[ "$(remote "docker inspect -f '{{.State.Running}}' chimera-test")" = true ] || fail "restart=always container didn't come back after wake"

remote "docker rm -f chimera-test >/dev/null && docker volume rm chimera-test >/dev/null && docker image rm alpine >/dev/null"

echo "Wake timing: docker answered ${docker_seconds}s after wake started"
remote "sudo cloud-init analyze blame | head -5"
echo "PASS: /home is ${size_gb}G, and the image, volume data, and restart=always container survived sleep and wake"
