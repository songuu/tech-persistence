#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_STAGE_HARNESS_V15:-}" = "STAGE-20260903-HARNESS-V15" ] || exit 3
old=/opt/tech-persistence-harness/releases/20260903-harness-web-v14
new=/opt/tech-persistence-harness/releases/20260903-harness-web-v15
candidate=/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3
[ "$(readlink -f /opt/tech-persistence-harness/current)" = "$old" ] && [ ! -e "$new" ]
install -d -o root -g root -m 0755 "$new"
cp -a "$old/." "$new/"
install -o root -g root -m 0444 "$candidate/scripts/harness-task-worker.js" "$new/scripts/harness-task-worker.js"
install -o root -g root -m 0555 "$candidate/scripts/codex-task-provider.sh" "$new/scripts/codex-task-provider.sh"
/usr/bin/node --check "$new/scripts/harness-task-worker.js"
/bin/sh -n "$new/scripts/codex-task-provider.sh"
echo 'Harness v15 staged without traffic switch'
