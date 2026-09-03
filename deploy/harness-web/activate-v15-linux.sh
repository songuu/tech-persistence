#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_ACTIVATE_HARNESS_V15:-}" = "ACTIVATE-20260903-HARNESS-V15" ] || exit 3
old=/opt/tech-persistence-harness/releases/20260903-harness-web-v14
old_config_runtime=/opt/tech-persistence-harness/releases/20260903-harness-web-v1
new=/opt/tech-persistence-harness/releases/20260903-harness-web-v15
config=/etc/tech-persistence/harness-worker/worker.json
backup=/etc/tech-persistence/harness-worker/worker.pre-v15.json
web_unit=/etc/systemd/system/tech-persistence-harness-web.service
worker_unit=/etc/systemd/system/tech-persistence-harness-worker.service
web_unit_backup=/etc/systemd/system/tech-persistence-harness-web.pre-v15.service
worker_unit_backup=/etc/systemd/system/tech-persistence-harness-worker.pre-v15.service
receipt=/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.json
receipt_backup=/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.pre-v15-20260903.json
[ "$(readlink -f /opt/tech-persistence-harness/current)" = "$old" ] && [ -d "$new" ] && [ -f "$receipt_backup" ] \
  && [ ! -e /opt/tech-persistence-harness/.current-v15 ]
[ ! -e "$backup" ] || cmp -s "$config" "$backup"
[ ! -e "$web_unit_backup" ] || cmp -s "$web_unit" "$web_unit_backup"
[ ! -e "$worker_unit_backup" ] || cmp -s "$worker_unit" "$worker_unit_backup"
completed=false
rollback() {
  if [ "$completed" = false ]; then
    [ ! -e "$backup" ] || cp -a "$backup" "$config"
    [ ! -e "$web_unit_backup" ] || cp -a "$web_unit_backup" "$web_unit"
    [ ! -e "$worker_unit_backup" ] || cp -a "$worker_unit_backup" "$worker_unit"
    cp -a "$receipt_backup" "$receipt"
    ln -sfn "$old" /opt/tech-persistence-harness/current
    systemctl daemon-reload
    systemctl restart tech-persistence-harness-worker.service tech-persistence-harness-web.service || true
  fi
}
trap rollback EXIT HUP INT TERM
grep -q "^NoNewPrivileges=no$" /etc/systemd/system/tech-persistence-harness-worker.service
[ -e "$backup" ] || cp -a "$config" "$backup"
[ -e "$web_unit_backup" ] || cp -a "$web_unit" "$web_unit_backup"
[ -e "$worker_unit_backup" ] || cp -a "$worker_unit" "$worker_unit_backup"
echo 'v15 activation backups verified'
jq --arg old "$old_config_runtime" --arg new "$new" '
  if .runtimeRoot != $old or .codexCommandPath != ($old + "/scripts/codex-task-provider.sh") or .orchestratorPath != ($old + "/scripts/agent-orchestrator.js") then error("unexpected worker runtime")
  else .runtimeRoot = $new | .codexCommandPath = ($new + "/scripts/codex-task-provider.sh") | .orchestratorPath = ($new + "/scripts/agent-orchestrator.js") end
' "$config" > /etc/tech-persistence/harness-worker/.worker.v15.json
install -o tp-authority -g tp-authority -m 0600 /etc/tech-persistence/harness-worker/.worker.v15.json "$config"
rm -f -- /etc/tech-persistence/harness-worker/.worker.v15.json
echo 'v15 worker config installed'
sed "s#${old}#${new}#g" /etc/systemd/system/tech-persistence-harness-web.service > /etc/systemd/system/.tech-persistence-harness-web.service.v15
sed "s#${old}#${new}#g" /etc/systemd/system/tech-persistence-harness-worker.service > /etc/systemd/system/.tech-persistence-harness-worker.service.v15
install -o root -g root -m 0644 /etc/systemd/system/.tech-persistence-harness-web.service.v15 /etc/systemd/system/tech-persistence-harness-web.service
install -o root -g root -m 0644 /etc/systemd/system/.tech-persistence-harness-worker.service.v15 /etc/systemd/system/tech-persistence-harness-worker.service
rm -f -- /etc/systemd/system/.tech-persistence-harness-web.service.v15 /etc/systemd/system/.tech-persistence-harness-worker.service.v15
echo 'v15 units installed'
ln -s "$new" /opt/tech-persistence-harness/.current-v15
mv -Tf /opt/tech-persistence-harness/.current-v15 /opt/tech-persistence-harness/current
echo 'v15 current pointer switched'
systemctl daemon-reload
systemctl restart tech-persistence-harness-worker.service tech-persistence-harness-web.service
echo 'v15 services restart requested'
attempt=0
while [ "$attempt" -lt 10 ] && { ! systemctl is-active --quiet tech-persistence-harness-worker.service \
  || ! systemctl is-active --quiet tech-persistence-harness-web.service; }; do
  sleep 0.5
  attempt=$((attempt + 1))
done
systemctl is-active --quiet tech-persistence-harness-worker.service
systemctl is-active --quiet tech-persistence-harness-web.service
# A restarting unit can briefly report active before its process exits. Require a
# stable non-zero PID across two observations before inspecting process limits.
worker_pid=$(systemctl show tech-persistence-harness-worker.service -p MainPID --value)
test "$worker_pid" -gt 0
sleep 1
test "$(systemctl show tech-persistence-harness-worker.service -p MainPID --value)" = "$worker_pid"
systemctl is-active --quiet tech-persistence-harness-worker.service
echo 'v15 services stable'
test "$(systemctl show tech-persistence-harness-worker.service -p UMask --value)" = 0077
echo 'v15 worker umask verified'
test "$(systemctl show tech-persistence-harness-worker.service -p SupplementaryGroups --value)" = tp-provider
echo 'v15 worker supplementary group verified'
test "$(awk '/^NoNewPrivs:/{print $2}' /proc/$worker_pid/status)" = 0
echo 'v15 worker no-new-privileges boundary verified'
test "$(awk '/^CapEff:/{print $2}' /proc/$worker_pid/status)" = 0000000000000000
echo 'v15 worker effective capabilities verified'
test "$(jq -r .codexCommandPath "$config")" = "$new/scripts/codex-task-provider.sh"
echo 'v15 worker command path verified'
echo 'Harness v15 activated atomically'
completed=true
trap - EXIT HUP INT TERM
