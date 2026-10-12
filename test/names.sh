#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 andre@chimera "$@" </dev/null; }
fetch() { curl -fsS --max-time 5 "$1" 2>/dev/null; }
resolves() {
  if command -v dscacheutil >/dev/null; then dscacheutil -q host -a name "$1" | grep -q ip_address
  else [ -n "$(dig +short "$1")" ]; fi
}

"$chimera" sleep
"$chimera" wake
for _ in $(seq 60); do c ls >/dev/null 2>&1 && break; sleep 3; done
c ls >/dev/null || fail "chimera didn't answer within 3 minutes of waking"

c rm c-names --yes >/dev/null 2>&1 || true
c new c-names >/dev/null

token="names-$(date +%s)-$RANDOM"
c shell c-names bash -c "mkdir -p /tmp/web && echo $token > /tmp/web/index.html && cd /tmp/web && setsid -f python3 -m http.server 8000 </dev/null >/dev/null 2>&1"

url=http://c-names.ws:8000/
for _ in $(seq 30); do
  [ "$(fetch "$url")" = "$token" ] && break
  sleep 2
done
if [ "$(fetch "$url")" != "$token" ]; then
  resolves c-names.ws || fail "c-names.ws doesn't resolve. Do the one-time Tailscale setup in the README ('Opening an app running in a container')"
  fail "$url didn't return the test page within a minute"
fi

[ "$(remote "incus network get incusbr0 dns.domain")" = ws ] || fail "the container network's DNS domain isn't ws"
remote "systemctl is-active chimera-firewall.service" >/dev/null || fail "the container firewall isn't loaded"

laptop_ip=$(tailscale ip -4)
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])')
mkdir -p "${TMPDIR:-/tmp}/chimera-names"
dir=$(mktemp -d "${TMPDIR:-/tmp}/chimera-names/XXXXXX")
echo "$token" > "$dir/index.html"
python3 -m http.server "$port" --bind "$laptop_ip" --directory "$dir" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null; rm -rf "$dir"' EXIT

for _ in $(seq 10); do
  [ "$(fetch "http://$laptop_ip:$port/")" = "$token" ] && break
  sleep 1
done
[ "$(fetch "http://$laptop_ip:$port/")" = "$token" ] || fail "the laptop can't fetch its own test page at $laptop_ip:$port"
c shell c-names curl -fsS --max-time 5 -o /dev/null https://1.1.1.1/ || fail "c-names can't reach the internet, so the next check would prove nothing"
! c shell c-names curl -s --max-time 5 "http://$laptop_ip:$port/" >/dev/null || fail "a container reached the laptop over the tailnet"

c rm c-names --yes >/dev/null
"$chimera" sleep
[ "$("$chimera" status)" = asleep ] || fail "computer is not asleep after sleep"

echo "PASS: names resolve from the laptop, containers can't reach tailnet devices"
