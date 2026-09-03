#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "canary entrypoint requires one model identifier" >&2
  exit 2
fi

/usr/bin/socat TCP-LISTEN:8080,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/broker/responses.sock &
bridge_pid=$!
cleanup() {
  kill "$bridge_pid" 2>/dev/null || true
  wait "$bridge_pid" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
sleep 0.05
if ! kill -0 "$bridge_pid" 2>/dev/null; then
  echo "bridge_exited" >&2
  exit 11
fi

/usr/bin/node -e '
const http = require("node:http");
let count = 0;
let status = null;
(async () => {
  while (++count <= 20) {
    const ok = await new Promise(resolve => {
      const request = http.get("http://127.0.0.1:8080/health", response => {
        status = response.statusCode; response.resume(); response.on("end", () => resolve(status === 200));
      });
      request.on("error", () => resolve(false)); request.setTimeout(500, () => request.destroy());
    });
    if (ok) process.exit(0);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  process.stderr.write(status === null ? "health_connect_failed\n" : `health_status_${status}\n`);
  process.exit(10);
})();
'

/usr/bin/node /runtime/scripts/native-runtime-canary.js \
  --base-url http://127.0.0.1:8080 \
  --model "$1" \
  --repo-probe /runtime/scripts/agent-orchestrator.js \
  --output /workspace/canary.json
