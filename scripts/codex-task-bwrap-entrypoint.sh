#!/bin/sh
set -eu

if [ "${1:-}" != '--network-ready' ]; then
  [ "$(id -u)" -eq 0 ] || { echo "private network setup requires namespace root" >&2; exit 6; }
  /usr/sbin/ip link set lo up
  exec /usr/bin/setpriv --bounding-set=-net_admin,-setpcap --inh-caps=-all --ambient-caps=-all -- \
    /bin/sh "$0" --network-ready "$@"
fi
shift
/usr/bin/grep -Eq '^CapEff:[[:space:]]*0+$' /proc/self/status || { echo "provider capabilities were not cleared" >&2; exit 7; }

model="$(cat /task-model)"
if ! printf '%s' "$model" | /usr/bin/grep -Eq '^[A-Za-z0-9._/-]{1,200}$'; then
  echo "invalid task model identifier" >&2
  exit 3
fi
install -d -m 0700 "$HOME/.codex"
/usr/bin/socat TCP-LISTEN:8080,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/broker/responses.sock &
bridge_pid=$!
cleanup() { kill "$bridge_pid" 2>/dev/null || true; wait "$bridge_pid" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
sleep 0.05
kill -0 "$bridge_pid" 2>/dev/null || { echo "task broker bridge failed" >&2; exit 4; }
export TP_BROKER_DUMMY_KEY=task-local-placeholder
umask 0002
[ "$#" -ge 1 ] && [ "$1" = exec ] || exit 5
shift
set +e
/usr/bin/node /codex/node_modules/@openai/codex/bin/codex.js exec \
  --ignore-user-config --ignore-rules --strict-config --ephemeral \
  --dangerously-bypass-approvals-and-sandbox --color never \
  -m "$model" \
  -c 'model_provider="task_broker"' \
  -c 'model_providers.task_broker={ name = "Task Broker", base_url = "http://127.0.0.1:8080/v1", env_key = "TP_BROKER_DUMMY_KEY", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0 }' \
  "$@"
status=$?
set -e
for output in /provider-output/*.json; do [ -f "$output" ] && /usr/bin/chmod 0644 "$output"; done
exit "$status"
