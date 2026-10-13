#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "plugin bootstrap requires namespace root" >&2; exit 9; }
[ -d /home ] && [ -d /runtime ] && [ -d /provider-output ] || exit 9
umask 0077
/usr/bin/node /runtime/scripts/harness-provider-plugin-bootstrap.js \
  --provider-home /home \
  --runtime-root /runtime \
  --codex-cli /codex/node_modules/@openai/codex/bin/codex.js \
  --require-immutable-runtime true \
  --output-receipt /provider-output/plugin-bootstrap.json \
  >/dev/null
