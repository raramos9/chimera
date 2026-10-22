#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 dev@chimera "$@"; }
fetch() { curl -fsS --max-time 5 "$1" 2>/dev/null; }
https_url="https://$(tailscale status --json | jq -r '.Peer[] | select(.HostName == "chimera") | .DNSName | rtrimstr(".")')/"

wait_for() {
  local url=$1 want=$2
  for _ in $(seq 30); do
    [ "$(fetch "$url")" = "$want" ] && return
    sleep 2
  done
  fail "$url didn't return the test page within a minute"
}

wake_until_docker() {
  "$chimera" wake
  for _ in $(seq 60); do
    remote docker info >/dev/null 2>&1 && return
    sleep 3
  done
  fail "docker didn't answer within 3 minutes of SSH coming up"
}

wake_until_docker
remote "docker rm -f chimera-web >/dev/null 2>&1; sudo tailscale serve reset"

token="serve-$(date +%s)-$RANDOM"
remote "docker run -d --name chimera-web --restart=always -p 8080:80 -p 127.0.0.1:8081:80 nginx:alpine \
  sh -c 'echo $token > /usr/share/nginx/html/index.html && exec nginx -g \"daemon off;\"'" >/dev/null
remote "sudo tailscale serve --bg 8081" >/dev/null

wait_for http://chimera:8080/ "$token"
! fetch http://chimera:8081/ >/dev/null || fail "port 8081 should only answer on the server itself"
wait_for "$https_url" "$token"

public_ip=$(hcloud server ip chimera)
! fetch "http://$public_ip:8080/" >/dev/null || fail "port 8080 is open on the public address"
! curl -ksS --max-time 5 "https://$public_ip/" >/dev/null 2>&1 || fail "port 443 is open on the public address"

"$chimera" sleep
[ "$("$chimera" status | head -1)" = asleep ] || fail "computer is not asleep after sleep"
wake_until_docker

wait_for http://chimera:8080/ "$token"
wait_for "$https_url" "$token"

remote "sudo tailscale serve reset && docker rm -f chimera-web >/dev/null && docker image rm nginx:alpine >/dev/null"

echo "PASS: the app answered at http://chimera:8080 and $https_url from this laptop, not on $public_ip, and both came back after sleep and wake"
