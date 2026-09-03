#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_HARNESS_WEB_RECOVER:-}" = "RECOVER-20260903-HARNESS-WEB" ] || exit 3
release=/opt/tech-persistence-harness/releases/20260903-harness-web-v1
config_root=/etc/tech-persistence/harness-web
worker_root=/etc/tech-persistence/harness-worker
credential_file=/root/tech-persistence-initial-login.txt
transcript_env=/var/lib/tech-persistence/authority/runtime-current/deploy/postgres/.env.transcripts
[ -d "$release" ] && [ -f "$release/scripts/harness-web-account.js" ] && [ -f "$release/scripts/harness-web-server.js" ]
[ -f "$config_root/auth.json" ] && [ -f "$config_root/tasks.json" ] && [ -f "$config_root/admin.json" ]
[ -f "$worker_root/worker.json" ] && [ -f "$worker_root/worker.env" ] && [ -f "$worker_root/git-system.config" ]
[ -f "$transcript_env" ]
[ ! -e "$credential_file" ] && [ ! -e /opt/tech-persistence-harness/current ] && [ ! -L /opt/tech-persistence-harness/current ]
[ "$(docker exec tech-persistence-postgres psql -U postgres -d tech_persistence -Atc "SELECT count(*) FROM harness_web.accounts")" = 0 ]
[ "$(docker exec tech-persistence-postgres psql -U postgres -d tech_persistence -Atc "SELECT count(*) FROM harness_tasks.projects")" = 0 ]

umask 077
operator_password=$(openssl rand -base64 24 | tr -d '\n')
printf '{"username":"operator","password":"%s"}\n' "$operator_password" | /usr/bin/node "$release/scripts/harness-web-account.js" --config "$config_root/admin.json" --action create >/dev/null
docker exec tech-persistence-postgres psql -v ON_ERROR_STOP=1 -U postgres -d tech_persistence -c "INSERT INTO harness_tasks.projects(id,name,enabled,execution_enabled) VALUES ('qualification-project','Harness qualification project',true,true); INSERT INTO harness_tasks.members(account_id,project_id,can_create,can_execute) SELECT id,'qualification-project',true,true FROM harness_web.accounts WHERE username='operator';" >/dev/null
printf 'URL=https://songuu.top/tech-persistence/tasks/\nUSERNAME=operator\nPASSWORD=%s\n' "$operator_password" > "$credential_file"
chmod 0600 "$credential_file"

web_group=$(id -gn tp-web)
printf '%s\n' '[Unit]' 'Description=Tech Persistence authenticated Harness web API' 'After=network-online.target docker.service' '' '[Service]' 'Type=simple' 'User=tp-web' "Group=$web_group" "WorkingDirectory=$release" "ExecStart=/usr/bin/node $release/scripts/harness-web-server.js --auth-config $config_root/auth.json --task-config $config_root/tasks.json" 'Restart=on-failure' 'RestartSec=3' 'NoNewPrivileges=yes' 'PrivateTmp=yes' 'ProtectSystem=strict' 'ProtectHome=yes' 'MemoryMax=512M' 'MemorySwapMax=0' 'TasksMax=32' 'LimitNOFILE=256' 'CPUQuota=50%' 'UMask=0077' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' '' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/tech-persistence-harness-web.service
printf '%s\n' '[Unit]' 'Description=Tech Persistence authenticated Harness task worker' 'After=network-online.target docker.service tech-persistence-provider-broker.service' 'Requires=tech-persistence-provider-broker.service' '' '[Service]' 'Type=simple' 'User=tp-authority' 'Group=tp-authority' 'SupplementaryGroups=tp-provider' "WorkingDirectory=$release" "Environment=TP_TASK_WORKER_CONFIG=$worker_root/worker.json" "EnvironmentFile=$worker_root/worker.env" "ExecStart=/usr/bin/node $release/scripts/harness-task-worker.js" 'Restart=on-failure' 'RestartSec=5' 'PrivateTmp=yes' 'ProtectSystem=strict' 'ProtectHome=yes' 'ReadWritePaths=/var/lib/tech-persistence/task-sandboxes /var/lib/tech-persistence/task-runtime/transcript-spool' 'MemoryMax=768M' 'MemorySwapMax=0' 'TasksMax=96' 'LimitNOFILE=512' 'CPUQuota=100%' 'UMask=0077' 'NoNewPrivileges=no' '' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/tech-persistence-harness-worker.service
install -d -o tp-authority -g tp-authority -m 0700 \
  /var/lib/tech-persistence/task-runtime/transcript-spool \
  /var/lib/tech-persistence/task-runtime/transcript-spool/sources \
  /var/lib/tech-persistence/task-runtime/transcript-spool/jobs \
  /var/lib/tech-persistence/task-runtime/transcript-spool/acks
printf '%s\n' '[Unit]' 'Description=Tech Persistence Harness task transcript synchronization' 'After=network-online.target docker.service' '' '[Service]' 'Type=oneshot' 'User=tp-authority' 'Group=tp-authority' "WorkingDirectory=$release" "ExecStart=/usr/bin/node scripts/sync-runtime-transcripts.js --outbox /var/lib/tech-persistence/task-runtime/transcript-spool --env-file $transcript_env" 'NoNewPrivileges=yes' 'PrivateTmp=yes' 'ProtectSystem=strict' 'ProtectHome=yes' 'ReadWritePaths=/var/lib/tech-persistence/task-runtime/transcript-spool' 'UMask=0077' 'MemoryMax=192M' 'TasksMax=32' 'TimeoutStartSec=120' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' > /etc/systemd/system/tech-persistence-harness-transcripts.service
printf '%s\n' '[Unit]' 'Description=Retry Harness task transcript outbox' '' '[Timer]' 'OnBootSec=5s' 'OnUnitInactiveSec=15s' 'RandomizedDelaySec=2s' 'Unit=tech-persistence-harness-transcripts.service' '' '[Install]' 'WantedBy=timers.target' > /etc/systemd/system/tech-persistence-harness-transcripts.timer
chmod 0644 /etc/systemd/system/tech-persistence-harness-web.service /etc/systemd/system/tech-persistence-harness-worker.service \
  /etc/systemd/system/tech-persistence-harness-transcripts.service /etc/systemd/system/tech-persistence-harness-transcripts.timer
ln -s "$release" /opt/tech-persistence-harness/current
systemctl daemon-reload
systemctl enable --now tech-persistence-harness-web.service tech-persistence-harness-worker.service tech-persistence-harness-transcripts.timer
systemctl start tech-persistence-harness-transcripts.service
echo 'Harness web production installation recovered'
