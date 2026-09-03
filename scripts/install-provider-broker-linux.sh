#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
stage=/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t
source_env=/opt/agent-build/worker-runtimes/demo-runner-01123133/.env
install -d -o root -g root -m 0755 /usr/local/libexec/tech-persistence /etc/tech-persistence
getent passwd tp-broker >/dev/null || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin --no-create-home tp-broker
install -d -o root -g tp-broker -m 0750 /etc/tech-persistence/task-runtime
install -o root -g tp-broker -m 0640 "$stage/openai-responses-broker.js" /usr/local/libexec/tech-persistence/openai-responses-broker.js
/usr/bin/env -i PATH=/usr/bin:/bin SOURCE_ENV="$source_env" OUTPUT_ROOT=/etc/tech-persistence/task-runtime \
  /usr/bin/node --env-file="$source_env" -e '
    const fs = require("node:fs");
    const values = [process.env.OPENAI_BASE_URL, process.env.OPENAI_MODEL, process.env.OPENAI_API_KEY];
    if (values.some(value => !value || /[\r\n\0]/.test(value))) throw new Error("invalid broker source configuration");
    new URL(values[0]);
    fs.writeFileSync(`${process.env.OUTPUT_ROOT}/broker.env`, `TP_BROKER_SOCKET=/run/tech-persistence-provider-broker/provider/responses.sock\nTP_UPSTREAM_BASE_URL=${values[0]}\nTP_UPSTREAM_MODEL=${values[1]}\nTP_UPSTREAM_API_KEY=${values[2]}\n`, { mode: 0o640 });
    fs.writeFileSync(`/etc/tech-persistence/provider-model`, `${values[1]}\n`, { mode: 0o440 });
  '
chown root:tp-broker /etc/tech-persistence/task-runtime/broker.env
chmod 0640 /etc/tech-persistence/task-runtime/broker.env
chown root:tp-provider /etc/tech-persistence/provider-model
chmod 0440 /etc/tech-persistence/provider-model
install -o root -g root -m 0644 "$stage/tech-persistence-provider-broker.service" /etc/systemd/system/tech-persistence-provider-broker.service
systemctl daemon-reload
systemctl enable --now tech-persistence-provider-broker.service
attempt=0
while [ ! -S /run/tech-persistence-provider-broker/provider/responses.sock ]; do
  attempt=$((attempt + 1)); [ "$attempt" -le 100 ] || exit 3
  systemctl is-active --quiet tech-persistence-provider-broker.service || exit 4
  sleep 0.05
done
test "$(stat -c %U:%G:%a /run/tech-persistence-provider-broker/provider/responses.sock)" = tp-broker:tp-provider:660
printf '{"brokerActive":true,"socketMode":"660"}\n'
