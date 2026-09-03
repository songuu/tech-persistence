#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
stage=/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t
runtime=/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3
model_file=/var/lib/tech-persistence/task-runtime/read-model.candidate
broker_env=/etc/tech-persistence/task-runtime/broker.env
launcher=/usr/local/libexec/tech-persistence/provider-identity-launcher
evidence="$(mktemp -d "$stage/read-model-evidence.XXXXXX")"
fixture="$(mktemp -d /var/lib/tech-persistence/workspace/read-model-canary.XXXXXX)"
backup="$(mktemp "$stage/broker-env-backup.XXXXXX")"
cp --preserve=mode,ownership,timestamps "$broker_env" "$backup"
cleanup() { case "$fixture" in /var/lib/tech-persistence/workspace/read-model-canary.*) rm -rf -- "$fixture";; *) exit 3;; esac; }
rollback() { cp --preserve=mode,ownership,timestamps "$backup" "$broker_env"; systemctl restart tech-persistence-provider-broker.service; }
trap 'rollback; cleanup' HUP INT TERM
model="$(tr -d '\r\n' <"$model_file")"
MODEL="$model" FILE="$broker_env" /usr/bin/node -e '
  const fs=require("node:fs"),f=process.env.FILE,m=process.env.MODEL;
  if(!m||/[\r\n\0]/.test(m))throw new Error("invalid read model");
  const lines=fs.readFileSync(f,"utf8").split(/\n/).filter(Boolean).filter(x=>!x.startsWith("TP_UPSTREAM_CHAT_MODEL="));
  lines.push(`TP_UPSTREAM_CHAT_MODEL=${m}`);fs.writeFileSync(f,lines.join("\n")+"\n",{mode:0o640});
'
chown root:tp-broker "$broker_env"; chmod 0640 "$broker_env"
systemctl restart tech-persistence-provider-broker.service
systemctl is-active --quiet tech-persistence-provider-broker.service
chown root:tp-provider "$fixture"; chmod 0750 "$fixture"
install -d -o tp-provider -g tp-provider -m 0700 "$fixture/workspace"
set +e
/usr/bin/timeout --signal=TERM --kill-after=5 180 /usr/sbin/runuser -u tp-authority -- \
  "$launcher" --reuid 986 --regid 986 --clear-groups -- /usr/bin/bwrap --die-with-parent --unshare-all \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
  --ro-bind "$runtime" /runtime --ro-bind /run/tech-persistence-provider-broker/provider /broker \
  --bind "$fixture/workspace" /workspace --proc /proc --dev /dev --tmpfs /tmp \
  --setenv HOME /workspace --setenv PATH /usr/bin:/bin --chdir /workspace \
  /runtime/scripts/harness-broker-canary-entrypoint.sh "$model" >"$evidence/canary-command.log" 2>"$evidence/canary-command.stderr"
status=$?
set -e
if [ "$status" -ne 0 ] || [ ! -f "$fixture/workspace/canary.json" ]; then rollback; cleanup; trap - HUP INT TERM; exit 4; fi
install -o root -g root -m 0600 "$fixture/workspace/canary.json" "$evidence/canary.json"
/usr/bin/node "$runtime/scripts/promote-external-runtime.js" --canary "$evidence/canary.json" --output "$evidence/promotion.json" \
  --descriptor openai-compatible-chat-v1 --explicit-promotion >"$evidence/promotion-command.log" 2>"$evidence/promotion-command.stderr"
chmod 0600 "$evidence"/*
install -o root -g tp-authority -m 0440 "$evidence/canary.json" /var/lib/tech-persistence/task-runtime/canary.json
install -o root -g tp-authority -m 0440 "$evidence/promotion.json" /var/lib/tech-persistence/task-runtime/promotion.json
MODEL="$model" FILE=/var/lib/tech-persistence/task-runtime/external-runtime.json /usr/bin/node -e '
  const fs=require("node:fs"),f=process.env.FILE,v=JSON.parse(fs.readFileSync(f));v.model=process.env.MODEL;
  v.canaryFile="/var/lib/tech-persistence/task-runtime/canary.json";v.promotionFile="/var/lib/tech-persistence/task-runtime/promotion.json";
  fs.writeFileSync(f,JSON.stringify(v)+"\n",{mode:0o440});
'
chown root:tp-authority /var/lib/tech-persistence/task-runtime/external-runtime.json
chmod 0440 /var/lib/tech-persistence/task-runtime/external-runtime.json
/usr/sbin/runuser -u tp-authority -- /usr/bin/node -e 'require("/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3/scripts/agent-orchestrator/external-runtime-config.js").loadExternalConfig("/var/lib/tech-persistence/task-runtime/external-runtime.json","/var/lib/tech-persistence/workspace")'
rm -f -- "$backup"; cleanup; trap - HUP INT TERM
printf '{"readModelPromoted":true,"canaryHash":"%s","promotionHash":"%s","evidence":"%s"}\n' \
  "$(sha256sum "$evidence/canary.json" | cut -d ' ' -f 1)" "$(sha256sum "$evidence/promotion.json" | cut -d ' ' -f 1)" "$evidence"
