#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_REBIND_RUNTIME_CAPABILITY:-}" = "REBIND-20260903-RELEASE-COMMAND" ] || exit 3
runtime=/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3
evidence_root=/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t
receipt=/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.json
backup=/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.pre-v15-20260903.json
command=${TP_RUNTIME_CAPABILITY_COMMAND:-$(jq -r .codexCommandPath /etc/tech-persistence/harness-worker/worker.json)}
[ -f "$runtime/scripts/create-runtime-capability-evidence-linux.js" ] && [ -f "$receipt" ]
if [ -e "$backup" ]; then cmp -s "$receipt" "$backup"; else cp -a "$receipt" "$backup"; fi
evidence=$(find "$evidence_root" -mindepth 2 -maxdepth 2 -type f -name workspace-proof.json -printf '%T@ %h\n' | sort -n | tail -1 | cut -d' ' -f2-)
case "$evidence" in "$evidence_root"/native-writer-evidence.*) [ -d "$evidence" ] ;; *) exit 4 ;; esac
/usr/bin/node "$runtime/scripts/create-runtime-capability-evidence-linux.js" "$evidence" "$command"
/usr/bin/node -e "require('$runtime/scripts/agent-orchestrator/runtime-capability-evidence').load('$receipt', '$command')"
chmod 0440 "$receipt" "$backup"
echo 'Runtime capability receipt rebound to immutable release command'
