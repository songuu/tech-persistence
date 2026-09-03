#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_QUALIFY_ACTIVATE_V15:-}" = "QUALIFY-ACTIVATE-20260903-V15" ] || exit 3
runtime=/opt/tech-persistence-harness/releases/20260903-harness-web-v15
receipt=/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.json
receipt_backup=/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.pre-v15-20260903.json
completed=false
recover() {
  if [ "$completed" = false ]; then
    [ ! -f "$receipt_backup" ] || cp -a "$receipt_backup" "$receipt"
    systemctl start tech-persistence-harness-worker.service || true
  fi
}
trap recover EXIT HUP INT TERM
systemctl stop tech-persistence-harness-worker.service
# The immediately preceding v15 probe is persisted; the generator below revalidates every artifact and binary hash.
find /var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t -mindepth 2 -maxdepth 2 -type f -name workspace-proof.json -newer "$runtime/scripts/codex-task-provider.sh" -print -quit | grep -q .
TP_RUNTIME_CAPABILITY_COMMAND="$runtime/scripts/codex-task-provider.sh" \
  TP_REBIND_RUNTIME_CAPABILITY=REBIND-20260903-RELEASE-COMMAND /root/rebind-runtime-capability-linux.sh
TP_ACTIVATE_HARNESS_V15=ACTIVATE-20260903-HARNESS-V15 /root/activate-v15-linux.sh
completed=true
trap - EXIT HUP INT TERM
echo 'Harness v15 qualified and activated'
