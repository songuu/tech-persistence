#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_INSTALL_HARNESS_TRANSCRIPT_SYNC:-}" = "INSTALL-20260903-HARNESS-TRANSCRIPT-SYNC" ] || exit 3

runtime=/opt/tech-persistence-harness/releases/20260903-harness-web-v15
spool=/var/lib/tech-persistence/task-runtime/transcript-spool
env_file=/var/lib/tech-persistence/authority/runtime-current/deploy/postgres/.env.transcripts
service=/etc/systemd/system/tech-persistence-harness-transcripts.service
timer=/etc/systemd/system/tech-persistence-harness-transcripts.timer

[ "$(readlink -f /opt/tech-persistence-harness/current)" = "$runtime" ]
[ -f "$runtime/scripts/sync-runtime-transcripts.js" ]
[ -f "$env_file" ]
[ -d "$spool/sources" ] && [ -d "$spool/jobs" ]
[ ! -e "$service" ] && [ ! -e "$timer" ]

service_tmp=/etc/systemd/system/.tech-persistence-harness-transcripts.service.new
timer_tmp=/etc/systemd/system/.tech-persistence-harness-transcripts.timer.new
cleanup() { rm -f -- "$service_tmp" "$timer_tmp"; }
trap cleanup EXIT HUP INT TERM

printf '%s\n' \
  '[Unit]' \
  'Description=Tech Persistence Harness task transcript synchronization' \
  'After=network-online.target docker.service' \
  '' \
  '[Service]' \
  'Type=oneshot' \
  'User=tp-authority' \
  'Group=tp-authority' \
  "WorkingDirectory=$runtime" \
  "ExecStart=/usr/bin/node scripts/sync-runtime-transcripts.js --outbox $spool --env-file $env_file" \
  'NoNewPrivileges=yes' \
  'PrivateTmp=yes' \
  'ProtectSystem=strict' \
  'ProtectHome=yes' \
  "ReadWritePaths=$spool" \
  'UMask=0077' \
  'MemoryMax=192M' \
  'TasksMax=32' \
  'TimeoutStartSec=120' \
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' > "$service_tmp"

printf '%s\n' \
  '[Unit]' \
  'Description=Retry Harness task transcript outbox' \
  '' \
  '[Timer]' \
  'OnBootSec=5s' \
  'OnUnitInactiveSec=15s' \
  'RandomizedDelaySec=2s' \
  'Unit=tech-persistence-harness-transcripts.service' \
  '' \
  '[Install]' \
  'WantedBy=timers.target' > "$timer_tmp"

install -o root -g root -m 0644 "$service_tmp" "$service"
install -o root -g root -m 0644 "$timer_tmp" "$timer"
systemctl daemon-reload
systemctl enable --now tech-persistence-harness-transcripts.timer
systemctl start tech-persistence-harness-transcripts.service
systemctl is-active --quiet tech-persistence-harness-transcripts.timer
test "$(systemctl show tech-persistence-harness-transcripts.service -p Result --value)" = success
echo 'Harness transcript synchronization installed and verified'
