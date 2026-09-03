#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_HARNESS_WORKER_PROMOTE:-}" = "PROMOTE-20260903-RESUME-RAW-CONFIG" ] || exit 3
old=/opt/tech-persistence-harness/releases/20260903-harness-web-v13
new=/opt/tech-persistence-harness/releases/20260903-harness-web-v14
candidate=/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3/scripts/harness-task-worker.js
[ "$(readlink -f /opt/tech-persistence-harness/current)" = "$old" ] && [ ! -e "$new" ] && [ -f "$candidate" ]
install -d -o root -g root -m 0755 "$new"
cp -a "$old/." "$new/"
install -o root -g root -m 0444 "$candidate" "$new/scripts/harness-task-worker.js"
/usr/bin/node --check "$new/scripts/harness-task-worker.js"
sed "s#${old}#${new}#g" /etc/systemd/system/tech-persistence-harness-web.service > /etc/systemd/system/.tech-persistence-harness-web.service.v2
grep -q '^SupplementaryGroups=tp-provider$' /etc/systemd/system/tech-persistence-harness-worker.service
grep -q '^NoNewPrivileges=no$' /etc/systemd/system/tech-persistence-harness-worker.service
sed "s#${old}#${new}#g" /etc/systemd/system/tech-persistence-harness-worker.service > /etc/systemd/system/.tech-persistence-harness-worker.service.v2
install -o root -g root -m 0644 /etc/systemd/system/.tech-persistence-harness-web.service.v2 /etc/systemd/system/tech-persistence-harness-web.service
install -o root -g root -m 0644 /etc/systemd/system/.tech-persistence-harness-worker.service.v2 /etc/systemd/system/tech-persistence-harness-worker.service
rm -f -- /etc/systemd/system/.tech-persistence-harness-web.service.v2 /etc/systemd/system/.tech-persistence-harness-worker.service.v2
ln -s "$new" /opt/tech-persistence-harness/.current-v2
mv -Tf /opt/tech-persistence-harness/.current-v2 /opt/tech-persistence-harness/current
systemctl daemon-reload
systemctl restart tech-persistence-harness-worker.service tech-persistence-harness-web.service
systemctl is-active --quiet tech-persistence-harness-worker.service
systemctl is-active --quiet tech-persistence-harness-web.service
test "$(systemctl show tech-persistence-harness-worker.service -p UMask --value)" = 0077
test "$(systemctl show tech-persistence-harness-worker.service -p SupplementaryGroups --value)" = tp-provider
worker_pid=$(systemctl show tech-persistence-harness-worker.service -p MainPID --value)
test "$(awk '/^NoNewPrivs:/{print $2}' /proc/$worker_pid/status)" = 0
test "$(awk '/^CapEff:/{print $2}' /proc/$worker_pid/status)" = 0000000000000000
sha256sum "$new/scripts/harness-task-worker.js" > "$new/worker-umask-fix.sha256"
chmod 0444 "$new/worker-umask-fix.sha256"
echo 'Worker resume raw-config boundary promoted atomically'
