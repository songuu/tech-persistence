#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -le 1 ] || exit 2
runtime=${1:-/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3}
case "$runtime" in
  /var/lib/tech-persistence/runtime-candidates/harness-*|/opt/tech-persistence-harness/releases/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-harness-web-v[0-9]*) ;;
  *) exit 2 ;;
esac
[ "$(readlink -f "$runtime")" = "$runtime" ] && [ -f "$runtime/scripts/codex-task-provider.sh" ]
task="$(cat /proc/sys/kernel/random/uuid)"
claim="$(cat /proc/sys/kernel/random/uuid)"
task_root="/var/lib/tech-persistence/task-sandboxes/$task/$claim"
workspace="$task_root/output/workspace"
provider_output="$task_root/output/provider-output"
provider_home="$task_root/output/provider-home"
evidence="$(mktemp -d /var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t/native-writer-evidence.XXXXXX)"
install -d -o tp-authority -g tp-provider -m 2710 "/var/lib/tech-persistence/task-sandboxes/$task" "$task_root"
install -d -o tp-provider -g tp-provider -m 2770 "$task_root/output" "$workspace" "$provider_output"
install -d -o tp-provider -g tp-provider -m 0700 "$provider_home"
install -o root -g tp-provider -m 0440 /dev/null "$evidence/prompt.txt"
printf '%s\n' 'Create /workspace/qualification.txt containing exactly HARNESS_NATIVE_WRITER_OK followed by one newline. The finished file must be exactly 25 bytes. Then return only this JSON shape with no prose or Markdown: {"summary":"...","changedFiles":["qualification.txt"],"validation":["..."],"risks":[],"followUp":[]}.' > "$evidence/prompt.txt"
chmod 0440 "$evidence/prompt.txt"
set +e
/usr/sbin/runuser -u tp-authority -- env HOME="$provider_home" PATH=/usr/bin:/bin timeout 300 \
  /usr/local/libexec/tech-persistence/provider-identity-launcher --reuid 986 --regid 986 --clear-groups -- \
  "$runtime/scripts/codex-task-provider.sh" exec -C "$workspace" --json --output-last-message "$provider_output/handoff.json" \
  --skip-git-repo-check --output-schema "$runtime/schemas/agent-loop/agent-handoff.schema.json" - \
  < "$evidence/prompt.txt" > "$evidence/codex.jsonl" 2> "$evidence/codex.stderr"
status=$?
set -e
[ "$status" -eq 0 ] || { echo "native writer canary failed" >&2; exit 1; }
[ -f "$workspace/qualification.txt" ] || { echo "native writer did not create qualification.txt" >&2; exit 1; }
[ "$(stat -c %u "$workspace/qualification.txt")" -eq 986 ]
expected_hash="$(printf '%s\n' 'HARNESS_NATIVE_WRITER_OK' | sha256sum | awk '{print $1}')"
[ "$(sha256sum "$workspace/qualification.txt" | awk '{print $1}')" = "$expected_hash" ]
/usr/bin/node -e 'const fs=require("node:fs"); const p=process.argv[1]; const events=fs.readFileSync(p,"utf8").split("\n").filter(Boolean).map(JSON.parse); if(!events.some(e=>e.type==="turn.completed")) process.exit(1)' "$evidence/codex.jsonl"
/usr/bin/node -e 'const fs=require("node:fs"),path=require("node:path"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); require(process.argv[3]).assertStructuredOutput(value,{schemaRoot:path.dirname(process.argv[2]),schemaName:path.basename(process.argv[2]),label:"writer capability handoff"})' "$provider_output/handoff.json" "$runtime/schemas/agent-loop/agent-handoff.schema.json" "$runtime/scripts/agent-orchestrator/structured-output.js"
/usr/bin/install -o root -g root -m 0600 "$provider_output/handoff.json" "$evidence/handoff.json"
/usr/bin/node -e 'const c=require("node:crypto"),fs=require("node:fs"); const p=process.argv[1],o=process.argv[2],s=fs.lstatSync(p); fs.writeFileSync(o,JSON.stringify({workspacePath:p,uid:s.uid,contentHash:`sha256:${c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`})+"\n",{mode:0o600})' "$workspace/qualification.txt" "$evidence/workspace-proof.json"
chown -R root:root "$evidence"
chmod 0700 "$evidence"
find "$evidence" -type f -exec chmod 0600 {} +
printf '%s\n' "$evidence"
