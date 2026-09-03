#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 0 ]; then
  echo "canary qualification requires root and accepts no arguments" >&2
  exit 2
fi

stage=/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t
agent_env=/opt/agent-build/worker-runtimes/demo-runner-01123133/.env
harness_runtime=/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3
launcher=/usr/local/libexec/tech-persistence/provider-identity-launcher
provider_uid="$(id -u tp-provider)"
provider_gid="$(id -g tp-provider)"
fixture="$(mktemp -d /var/lib/tech-persistence/workspace/broker-canary-qual.XXXXXX)"
evidence="$(mktemp -d "$stage/broker-canary-evidence.XXXXXX")"
install -d -o root -g root -m 0755 /run/tech-persistence-provider-broker
socket_root="$(mktemp -d /run/tech-persistence-provider-broker/canary.XXXXXX)"
broker_pid=

cleanup() {
  if [ -n "$broker_pid" ]; then
    kill "$broker_pid" 2>/dev/null || true
    sleep 0.1
    kill -KILL "$broker_pid" 2>/dev/null || true
    wait "$broker_pid" 2>/dev/null || true
  fi
  case "$fixture" in /var/lib/tech-persistence/workspace/broker-canary-qual.*) rm -rf -- "$fixture" ;; *) exit 3 ;; esac
  case "$socket_root" in /run/tech-persistence-provider-broker/canary.*) rm -rf -- "$socket_root" ;; *) exit 3 ;; esac
}
trap cleanup EXIT HUP INT TERM

chmod 0700 "$evidence"
chown root:tp-provider "$fixture" "$socket_root"
chmod 0750 "$fixture"
chmod 2750 "$socket_root"
install -d -o tp-provider -g tp-provider -m 0700 "$fixture/workspace"

set -a
. "$agent_env"
set +a
: "${OPENAI_BASE_URL:?missing model base URL}"
: "${OPENAI_API_KEY:?missing model credential}"
: "${OPENAI_MODEL:?missing model name}"

/usr/bin/env -i PATH=/usr/bin:/bin TP_BROKER_SCRIPT="$stage/scripts/openai-responses-broker.js" \
  TP_BROKER_SOCKET="$socket_root/responses.sock" /usr/bin/node --env-file="$agent_env" -e \
  'const broker=require(process.env.TP_BROKER_SCRIPT); process.env.TP_UPSTREAM_BASE_URL=process.env.OPENAI_BASE_URL; process.env.TP_UPSTREAM_API_KEY=process.env.OPENAI_API_KEY; process.env.TP_UPSTREAM_MODEL=process.env.OPENAI_MODEL; broker.main()' broker-service \
  >"$evidence/broker.log" 2>&1 &
broker_pid=$!
attempt=0
while [ ! -S "$socket_root/responses.sock" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 100 ] || ! kill -0 "$broker_pid" 2>/dev/null; then exit 4; fi
  sleep 0.05
done

set +e
/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/timeout --signal=TERM --kill-after=5 180 \
  /usr/sbin/runuser -u tp-authority -- "$launcher" --reuid "$provider_uid" --regid "$provider_gid" --clear-groups -- \
  /usr/bin/bwrap --die-with-parent --unshare-all \
    --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
    --ro-bind "$harness_runtime" /runtime --ro-bind "$socket_root" /broker \
    --bind "$fixture/workspace" /workspace --proc /proc --dev /dev --tmpfs /tmp \
    --setenv HOME /workspace --setenv PATH /usr/bin:/bin --chdir /workspace \
    /runtime/scripts/harness-broker-canary-entrypoint.sh "$OPENAI_MODEL" \
  </dev/null >"$evidence/canary-command.log" 2>"$evidence/canary-command.stderr"
status=$?
set -e
if [ -f "$fixture/workspace/canary.json" ]; then
  install -o root -g root -m 0600 "$fixture/workspace/canary.json" "$evidence/canary.json"
fi
if [ "$status" -ne 0 ] || [ ! -f "$evidence/canary.json" ]; then
  printf '{"externalCanary":false,"exitCode":%s,"evidence":"%s"}\n' "$status" "$evidence"
  exit 5
fi
/usr/bin/node "$harness_runtime/scripts/promote-external-runtime.js" --canary "$evidence/canary.json" \
  --output "$evidence/promotion.json" --descriptor openai-compatible-chat-v1 --explicit-promotion \
  >"$evidence/promotion-command.log" 2>"$evidence/promotion-command.stderr"
chmod 0600 "$evidence"/*
printf '{"externalCanary":true,"providerUid":%s,"canaryHash":"%s","promotionHash":"%s","evidence":"%s"}\n' \
  "$provider_uid" "$(sha256sum "$evidence/canary.json" | cut -d ' ' -f 1)" \
  "$(sha256sum "$evidence/promotion.json" | cut -d ' ' -f 1)" "$evidence"
