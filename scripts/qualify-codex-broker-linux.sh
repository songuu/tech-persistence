#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 0 ]; then
  echo "qualification requires root and accepts no arguments" >&2
  exit 2
fi

stage=/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t
agent_env=/opt/agent-build/worker-runtimes/demo-runner-01123133/.env
codex_root=/var/lib/tech-persistence/runtime-candidates/codex-0.152.1
harness_runtime=/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3
broker_script="$stage/scripts/openai-responses-broker.js"
launcher=/usr/local/libexec/tech-persistence/provider-identity-launcher
provider_uid="$(id -u tp-provider)"
provider_gid="$(id -g tp-provider)"
fixture="$(mktemp -d /var/lib/tech-persistence/workspace/codex-broker-qual.XXXXXX)"
evidence="$(mktemp -d "$stage/native-writer-evidence.XXXXXX")"
install -d -o root -g root -m 0755 /run/tech-persistence-provider-broker
socket_root="$(mktemp -d /run/tech-persistence-provider-broker/qualification.XXXXXX)"
broker_pid=

cleanup() {
  if [ -n "$broker_pid" ]; then
    kill "$broker_pid" 2>/dev/null || true
    attempt=0
    while kill -0 "$broker_pid" 2>/dev/null && [ "$attempt" -lt 20 ]; do
      attempt=$((attempt + 1))
      sleep 0.05
    done
    kill -KILL "$broker_pid" 2>/dev/null || true
    wait "$broker_pid" 2>/dev/null || true
  fi
  case "$fixture" in
    /var/lib/tech-persistence/workspace/codex-broker-qual.*) rm -rf -- "$fixture" ;;
    *) echo "refusing unsafe fixture cleanup" >&2; exit 3 ;;
  esac
  case "$socket_root" in
    /run/tech-persistence-provider-broker/qualification.*) rm -rf -- "$socket_root" ;;
    *) echo "refusing unsafe socket cleanup" >&2; exit 3 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

chmod 0700 "$evidence"
chown root:tp-provider "$fixture"
chmod 0750 "$fixture"
chown root:tp-provider "$socket_root"
chmod 2750 "$socket_root"
install -d -o tp-provider -g tp-provider -m 0700 "$fixture/workspace"

set -a
. "$agent_env"
set +a
: "${OPENAI_BASE_URL:?missing model base URL}"
: "${OPENAI_API_KEY:?missing model credential}"
: "${OPENAI_MODEL:?missing model name}"

/usr/bin/env -i PATH=/usr/bin:/bin TP_BROKER_SCRIPT="$broker_script" TP_BROKER_SOCKET="$socket_root/responses.sock" \
  /usr/bin/node --env-file="$agent_env" -e \
  'const broker=require(process.env.TP_BROKER_SCRIPT); process.env.TP_UPSTREAM_BASE_URL=process.env.OPENAI_BASE_URL; process.env.TP_UPSTREAM_API_KEY=process.env.OPENAI_API_KEY; process.env.TP_UPSTREAM_MODEL=process.env.OPENAI_MODEL; broker.main()' broker-service \
  >"$evidence/broker.log" 2>&1 &
broker_pid=$!

attempt=0
while [ ! -S "$socket_root/responses.sock" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 100 ] || ! kill -0 "$broker_pid" 2>/dev/null; then
    echo "broker did not become ready" >&2
    exit 4
  fi
  sleep 0.05
done

config="model_providers.task_broker={ name = 'Task Broker', base_url = 'http://127.0.0.1:8080/v1', env_key = 'TP_BROKER_DUMMY_KEY', wire_api = 'responses', request_max_retries = 0, stream_max_retries = 0 }"
prompt="Create qualification.txt in the current workspace with exactly HARNESS_NATIVE_WRITER_OK followed by one newline. Do not modify any other file."

set +e
/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/timeout --signal=TERM --kill-after=5 300 \
  /usr/sbin/runuser -u tp-authority -- "$launcher" --reuid "$provider_uid" --regid "$provider_gid" --clear-groups -- \
  /usr/bin/bwrap --die-with-parent --unshare-all \
    --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
    --ro-bind "$codex_root" /codex --ro-bind "$socket_root" /broker \
    --bind "$fixture/workspace" /workspace --proc /proc --dev /dev --tmpfs /tmp \
    --setenv HOME /workspace/home --setenv CODEX_HOME /workspace/home/.codex \
    --setenv PATH /usr/bin:/bin --setenv TP_BROKER_DUMMY_KEY qualification-only \
    --dir /workspace/home --dir /workspace/home/.codex --chdir /workspace \
    /usr/bin/sh -c '/usr/bin/socat TCP-LISTEN:8080,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/broker/responses.sock & bridge=$!; trap "kill $bridge 2>/dev/null || true" EXIT HUP INT TERM; /usr/bin/node /codex/node_modules/@openai/codex/bin/codex.js exec --ignore-user-config --ignore-rules --strict-config --ephemeral --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never --json -m "$1" -c "model_provider=\"task_broker\"" -c "$2" "$3"; status=$?; kill "$bridge" 2>/dev/null || true; wait "$bridge" 2>/dev/null || true; trap - EXIT HUP INT TERM; exit "$status"' sh "$OPENAI_MODEL" "$config" "$prompt" \
  </dev/null >"$evidence/codex.jsonl" 2>"$evidence/codex.stderr"
status=$?
set -e

chmod 0600 "$evidence"/*
if [ "$status" -ne 0 ]; then
  printf '{"nativeWriter":false,"exitCode":%s,"evidence":"%s"}\n' "$status" "$evidence"
  exit 5
fi
if [ "$(find "$fixture/workspace" -mindepth 1 -maxdepth 1 ! -name home -printf '%f\n')" != qualification.txt ]; then
  echo "native writer changed an unexpected workspace entry" >&2
  exit 6
fi
if [ "$(cat "$fixture/workspace/qualification.txt")" != HARNESS_NATIVE_WRITER_OK ]; then
  echo "native writer output mismatch" >&2
  exit 7
fi
if [ "$(stat -c %u "$fixture/workspace/qualification.txt")" -ne "$provider_uid" ]; then
  echo "native writer used the wrong identity" >&2
  exit 8
fi
if ! kill -0 "$broker_pid" 2>/dev/null; then
  echo "broker exited after native writer" >&2
  exit 12
fi
/usr/bin/node "$stage/scripts/probe-broker-unix-health.js" "$socket_root/responses.sock"

install -d -o tp-provider -g tp-provider -m 0700 "$fixture/canary"
set +e
/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/timeout --signal=TERM --kill-after=5 180 \
  /usr/sbin/runuser -u tp-authority -- "$launcher" --reuid "$provider_uid" --regid "$provider_gid" --clear-groups -- \
  /usr/bin/bwrap --die-with-parent --unshare-all \
    --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
    --ro-bind "$harness_runtime" /runtime --ro-bind "$socket_root" /broker \
    --bind "$fixture/canary" /workspace --proc /proc --dev /dev --tmpfs /tmp \
    --setenv HOME /workspace --setenv PATH /usr/bin:/bin --chdir /workspace \
    /runtime/scripts/harness-broker-canary-entrypoint.sh "$OPENAI_MODEL" \
  </dev/null >"$evidence/canary-command.log" 2>"$evidence/canary-command.stderr"
canary_status=$?
set -e
if [ -f "$fixture/canary/canary.json" ]; then
  install -o root -g root -m 0600 "$fixture/canary/canary.json" "$evidence/canary.json"
fi
if [ "$canary_status" -ne 0 ] || [ ! -f "$evidence/canary.json" ]; then
  printf '{"nativeWriter":true,"externalCanary":false,"exitCode":%s,"evidence":"%s"}\n' "$canary_status" "$evidence"
  exit 9
fi
/usr/bin/node "$harness_runtime/scripts/promote-external-runtime.js" \
  --canary "$evidence/canary.json" --output "$evidence/promotion.json" \
  --descriptor openai-compatible-chat-v1 --explicit-promotion \
  >"$evidence/promotion-command.log" 2>"$evidence/promotion-command.stderr"
chmod 0600 "$evidence"/*

workspace_hash="$(sha256sum "$fixture/workspace/qualification.txt" | cut -d ' ' -f 1)"
transcript_hash="$(sha256sum "$evidence/codex.jsonl" | cut -d ' ' -f 1)"
canary_hash="$(sha256sum "$evidence/canary.json" | cut -d ' ' -f 1)"
promotion_hash="$(sha256sum "$evidence/promotion.json" | cut -d ' ' -f 1)"
printf '{"nativeWriter":true,"externalCanary":true,"providerUid":%s,"workspaceHash":"%s","transcriptHash":"%s","canaryHash":"%s","promotionHash":"%s","evidence":"%s"}\n' \
  "$provider_uid" "$workspace_hash" "$transcript_hash" "$canary_hash" "$promotion_hash" "$evidence"
