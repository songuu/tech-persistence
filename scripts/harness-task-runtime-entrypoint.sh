#!/bin/sh
set -eu

if [ "$#" -lt 3 ] || [ "$1" != /usr/bin/node ] || [ "$2" != /runtime/scripts/agent-orchestrator.js ] || [ "$3" != run ]; then
  echo "invalid task runtime invocation" >&2
  exit 2
fi
install -d -m 0700 "$HOME/.codex"
/usr/bin/socat TCP-LISTEN:8080,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/broker/responses.sock &
bridge_pid=$!
cleanup() {
  kill "$bridge_pid" 2>/dev/null || true
  wait "$bridge_pid" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
sleep 0.05
if ! kill -0 "$bridge_pid" 2>/dev/null; then
  echo "task broker bridge failed" >&2
  exit 3
fi
"$@"
