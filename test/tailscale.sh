#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"

fail() { echo "FAIL: $*" >&2; exit 1; }
host_key() { ssh-keyscan -t ed25519 "$1" 2>/dev/null | awk '!/^#/ { print $2, $3 }'; }
private() { ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new andre@chimera "$@"; }
tailnet_ip() { tailscale status --json | jq -r '.Peer[] | select(.HostName == "chimera") | .TailscaleIPs[0]'; }

ip_before=$(tailnet_ip)
[ -n "$ip_before" ] || fail "no 'chimera' device on the tailnet. Log the server in first with 'sudo tailscale up'."

"$chimera" sleep
start=$(date +%s)
"$chimera" wake
public_seconds=$(( $(date +%s) - start ))

echo "Waiting for SSH over Tailscale..."
for _ in $(seq 40); do
  private true 2>/dev/null && break
  sleep 3
done
private true || fail "SSH to andre@chimera over Tailscale didn't answer within 2 minutes of waking"
private_seconds=$(( $(date +%s) - start ))

[ "$(tailnet_ip)" = "$ip_before" ] || fail "tailnet address changed from $ip_before to $(tailnet_ip), the server logged in as a new device"
[ "$(host_key chimera)" = "$(host_key "$(hcloud server ip chimera)")" ] || fail "host key over Tailscale differs from the public one"

echo "Wake timing: public SSH after ${public_seconds}s, Tailscale SSH after ${private_seconds}s"
private "sudo cloud-init analyze blame | head -5"
echo "PASS: after sleep and wake the server rejoined the tailnet as the same device, reachable as andre@chimera"
