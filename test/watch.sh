#!/usr/bin/env bash
set -euo pipefail

chimera="$(dirname "$0")/../bin/chimera"
site=https://chimera.tailed8053.ts.net:8443

fail() { echo "FAIL: $*" >&2; exit 1; }
c() { "$chimera" "$@" </dev/null; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=5 -o ProxyCommand=none andre@chimera "$@" </dev/null; }

# Usage: [COLS=N] [SECONDS_OPEN=N] [PREFS=1] terminal ARG ORIGIN TYPED. Prints what the Watch page's terminal shows within 2+SECONDS_OPEN seconds (default 6), plus its settings with PREFS=1, or "refused CODE".
terminal() {
  python3 - "$site" "$@" <<'EOF'
import json, os, sys, time
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect
site, arg, origin, typed = sys.argv[1:]
seen = b""
try:
    ws = connect(f"wss://{site.split('://')[1]}/ws?arg={arg}", subprotocols=["tty"], origin=origin, open_timeout=10)
except InvalidStatus as refused:
    sys.exit(f"refused {refused.response.status_code}")
with ws:
    ws.send(json.dumps({"AuthToken": "", "columns": int(os.environ.get("COLS", 100)), "rows": 30}).encode())
    time.sleep(2)
    if typed:
        ws.send(b"0" + typed.encode() + b"\r")
    end = time.time() + int(os.environ.get("SECONDS_OPEN", 6))
    while time.time() < end:
        try:
            message = ws.recv(timeout=end - time.time())
        except Exception:
            break
        if isinstance(message, bytes) and message[:1] == b"0":
            seen += message[1:]
        elif isinstance(message, bytes) and message[:1] == b"2" and os.environ.get("PREFS"):
            seen += message[1:]
print(seen.decode(errors="replace"))
EOF
}

"$chimera" sleep
"$chimera" wake
for _ in $(seq 60); do remote "incus list" >/dev/null 2>&1 && break; sleep 3; done
remote "incus list" >/dev/null || fail "chimera didn't answer within 3 minutes of waking"

remote "systemctl is-active chimera-watch.service" >/dev/null || fail "chimera-watch.service isn't running"
! remote "systemctl is-active ttyd.service" >/dev/null || fail "Ubuntu's read-only ttyd login page is running"
remote "ss -ltnH 'sport = 7681'" | grep -q '127.0.0.1:7681' || fail "ttyd isn't listening on 127.0.0.1:7681"
! remote "ss -ltnH 'sport = 7681'" | grep -vq '127.0.0.1:7681' || fail "ttyd listens on more than loopback"

c rm c-watch --yes >/dev/null 2>&1 || true
c new c-watch >/dev/null
remote "incus exec c-watch -- sudo -iu andre sh -c 'tmux has-session -t main 2>/dev/null || tmux new-session -d -s main; tmux new-window -t main -n claude bash -l'"

a=$((RANDOM % 900 + 100)) b=$((RANDOM % 900 + 100))
answer=$((a * b))
[ "$(curl -fsS --max-time 10 -o /dev/null -w '%{http_code}' "$site/")" = 200 ] || fail "$site/ didn't load"
terminal c-watch "$site" "echo \$(($a*$b))watched" | grep -q "${answer}watched" \
  || fail "typing into the Watch page didn't run in c-watch's claude window"
width() { remote "incus exec c-watch -- sudo -iu andre tmux display -p -t main:claude '#{window_width}'"; }
COLS=100 SECONDS_OPEN=16 terminal c-watch "$site" "" >/dev/null &
watcher=$!
sleep 5
before=$(width)
[ "$before" = 100 ] || fail "the full Watch page didn't size c-watch's claude window to 100 columns, got $before"
COLS=60 terminal "c-watch&arg=view" "$site" "echo viewonly\$((1+1))" | grep -q "${answer}watched" \
  || fail "the preview didn't show c-watch's claude window"
! remote "incus exec c-watch -- sudo -iu andre tmux capture-pane -p -t main:claude" | grep -q viewonly \
  || fail "typing into the preview reached c-watch's claude window"
[ "$(width)" = "$before" ] || fail "the preview resized c-watch's claude window from $before to $(width) columns"
wait "$watcher"
PREFS=1 terminal nope "$site" "" | grep -q '"background": *"#09090b"' || fail "the Watch page doesn't get the dashboard's dark terminal colours"
refused_nope() { for _ in 1 2 3; do terminal nope "$site" "" | grep -q "No such container: nope" && return; done; return 1; }
refused_nope || fail "the Watch page didn't refuse an unknown container"
refusal=$(terminal c-watch https://example.com "" 2>&1 || true)
[[ $refusal == "refused "* ]] || fail "the Watch page let in a connection from another website: $refusal"
remote "journalctl -q -u chimera-watch --since -1min" | grep -q "refuse to serve WS client from different origin" \
  || fail "the Watch page turned away another website, but not for being another website: $refusal"

remote "incus exec c-watch -- curl -fsS --max-time 5 -o /dev/null https://1.1.1.1/" || fail "c-watch can't reach the internet, so the next check would prove nothing"
ip=$(remote "tailscale ip -4")
! remote "incus exec c-watch -- curl -sk --max-time 5 -o /dev/null https://$ip:8443/" || fail "a container reached the Watch page"
! remote "incus exec c-watch -- curl -s --max-time 5 -o /dev/null http://10.171.245.1:7681/" || fail "a container reached ttyd directly"

c rm c-watch --yes >/dev/null
"$chimera" sleep
[ "$("$chimera" status | head -1)" = asleep ] || fail "computer is not asleep after sleep"

echo "PASS: the Watch page types into a container's claude window, the preview only looks, and only the tailnet can open it"
