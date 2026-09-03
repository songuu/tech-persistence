#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_HARNESS_WEB_INSTALL:-}" = "INSTALL-20260903-HARNESS-WEB" ] || { echo 'explicit install token required' >&2; exit 3; }

candidate=/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3
release=/opt/tech-persistence-harness/releases/20260903-harness-web-v1
config_root=/etc/tech-persistence/harness-web
worker_config_root=/etc/tech-persistence/harness-worker
postgres_container=tech-persistence-postgres
transcript_env=/var/lib/tech-persistence/authority/runtime-current/deploy/postgres/.env.transcripts

[ -d "$candidate" ] && [ -f "$candidate/scripts/harness-web-server.js" ] && [ -f "$candidate/deploy/harness-web/004-confirm-resume.sql" ]
[ -f "$transcript_env" ] && [ ! -e "$release" ]
collision=$(docker exec "$postgres_container" psql -U postgres -d tech_persistence -Atc "SELECT count(*) FROM pg_namespace WHERE nspname IN ('harness_web','harness_tasks')")
[ "$collision" = 0 ] || { echo 'production Harness schema collision' >&2; exit 4; }

if ! getent passwd tp-web >/dev/null; then
  useradd --system --home-dir /var/lib/tech-persistence/web --create-home --shell /usr/sbin/nologin tp-web
fi
web_group=$(id -gn tp-web)
install -d -o root -g root -m 0755 /opt/tech-persistence-harness /opt/tech-persistence-harness/releases
install -d -o root -g root -m 0755 "$release"
cp -a "$candidate/." "$release/"
chown -R root:root "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0444 {} +
find "$release" -type f -name '*.sh' -exec chmod 0555 {} +

for migration in 001-auth.sql 002-tasks.sql 003-execution.sql 004-confirm-resume.sql; do
  docker exec -i "$postgres_container" psql -v ON_ERROR_STOP=1 -U postgres -d tech_persistence < "$release/deploy/harness-web/$migration"
done

umask 077
auth_password=$(openssl rand -hex 32)
admin_password=$(openssl rand -hex 32)
task_password=$(openssl rand -hex 32)
authority_password=$(openssl rand -hex 32)
operator_password=$(openssl rand -base64 24 | tr -d '\n')
role_sql=$(mktemp)
trap 'rm -f -- "$role_sql"' EXIT HUP INT TERM
printf "ALTER ROLE tp_web_auth LOGIN PASSWORD '%s';\nALTER ROLE tp_web_account_admin LOGIN PASSWORD '%s';\nALTER ROLE tp_web_tasks LOGIN PASSWORD '%s';\nALTER ROLE tp_task_authority LOGIN PASSWORD '%s';\n" \
  "$auth_password" "$admin_password" "$task_password" "$authority_password" > "$role_sql"
docker exec -i "$postgres_container" psql -v ON_ERROR_STOP=1 -U postgres -d tech_persistence < "$role_sql"

install -d -o root -g "$web_group" -m 0750 "$config_root"
install -d -o root -g tp-authority -m 0750 "$worker_config_root"
install -d -o tp-authority -g tp-authority -m 0700 \
  /var/lib/tech-persistence/task-runtime/transcript-spool \
  /var/lib/tech-persistence/task-runtime/transcript-spool/sources \
  /var/lib/tech-persistence/task-runtime/transcript-spool/jobs \
  /var/lib/tech-persistence/task-runtime/transcript-spool/acks
auth_config="$config_root/auth.json"
task_config="$config_root/tasks.json"
admin_config="$config_root/admin.json"
worker_config="$worker_config_root/worker.json"
worker_env="$worker_config_root/worker.env"
printf '{"version":"harness-web-auth-config-v1","databaseUrl":"postgresql://tp_web_auth:%s@127.0.0.1:55433/tech_persistence","publicOrigin":"https://songuu.top","port":5183}\n' "$auth_password" > "$auth_config"
printf '{"version":"harness-web-auth-config-v1","databaseUrl":"postgresql://tp_web_account_admin:%s@127.0.0.1:55433/tech_persistence"}\n' "$admin_password" > "$admin_config"

TASK_CONFIG="$task_config" TASK_URL="postgresql://tp_web_tasks:$task_password@127.0.0.1:55433/tech_persistence" \
TRANSCRIPT_ENV="$transcript_env" RELEASE="$release" /usr/bin/node -e '
  const fs=require("node:fs"); const values={};
  require(process.env.RELEASE+"/scripts/sync-codex-transcripts.js").loadEnvFile(process.env.TRANSCRIPT_ENV, values);
  const read=values.TRANSCRIPTS_POSTGRES_READ_URL;
  if(typeof read!=="string"||!/^postgres(?:ql)?:\/\/transcript_reader:/.test(read)) throw new Error("transcript reader credential unavailable");
  fs.writeFileSync(process.env.TASK_CONFIG,JSON.stringify({version:"harness-web-task-config-v1",databaseUrl:process.env.TASK_URL,transcriptDatabaseUrl:read})+"\n",{mode:0o600});
'
printf 'TP_TASK_DATABASE_URL=postgresql://tp_task_authority:%s@127.0.0.1:55433/tech_persistence\n' "$authority_password" > "$worker_env"
printf '{"version":"harness-task-worker-v1","workerId":"production-1","sandboxRoot":"/var/lib/tech-persistence/task-sandboxes","runtimeRoot":"%s","externalRuntimeConfigPath":"/var/lib/tech-persistence/task-runtime/external-runtime.json","runtimeCapabilityEvidencePath":"/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.json","codexCommandPath":"%s/scripts/codex-task-provider.sh","launcherPath":"/usr/local/libexec/tech-persistence/provider-identity-launcher","gitPath":"/usr/bin/git","gitConfigPath":"%s/git-system.config","duPath":"/usr/bin/du","mkdirPath":"/usr/bin/mkdir","chmodPath":"/usr/bin/chmod","nodePath":"/usr/bin/node","orchestratorPath":"%s/scripts/agent-orchestrator.js","providerUid":986,"providerGid":986,"heartbeatMs":1000,"maxLogBytes":4194304,"maxWorkspaceBytes":67108864,"minimumFreeBytes":268435456,"idleMs":1000,"projects":{"qualification-project":{"sourceRoot":"/var/lib/tech-persistence/qualification-projects/full-harness-20260902","timeoutMs":1200000,"validationCommands":["node test.js"]}}}\n' \
  "$release" "$release" "$worker_config_root" "$release" > "$worker_config"
printf '[safe]\n\tdirectory = "/var/lib/tech-persistence/qualification-projects/full-harness-20260902"\n\tdirectory = "/var/lib/tech-persistence/qualification-projects/full-harness-20260902/.git"\n' > "$worker_config_root/git-system.config"

chown tp-web:"$web_group" "$auth_config" "$task_config"
chmod 0600 "$auth_config" "$task_config"
chown root:root "$admin_config"; chmod 0600 "$admin_config"
chown tp-authority:tp-authority "$worker_config" "$worker_env"; chmod 0600 "$worker_config" "$worker_env"
chown root:root "$worker_config_root/git-system.config"; chmod 0444 "$worker_config_root/git-system.config"

printf '{"username":"operator","password":"%s"}\n' "$operator_password" | /usr/bin/node "$release/scripts/harness-web-account.js" --config "$admin_config" --action create >/dev/null
docker exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U postgres -d tech_persistence -c "INSERT INTO harness_tasks.projects(id,name,enabled,execution_enabled) VALUES ('qualification-project','Harness qualification project',true,true); INSERT INTO harness_tasks.members(account_id,project_id,can_create,can_execute) SELECT id,'qualification-project',true,true FROM harness_web.accounts WHERE username='operator';" >/dev/null
credential_file=/root/tech-persistence-initial-login.txt
printf 'URL=https://songuu.top/tech-persistence/tasks/\nUSERNAME=operator\nPASSWORD=%s\n' "$operator_password" > "$credential_file"
chmod 0600 "$credential_file"

printf '%s\n' '[Unit]' 'Description=Tech Persistence authenticated Harness web API' 'After=network-online.target docker.service' '' '[Service]' 'Type=simple' 'User=tp-web' "Group=$web_group" "WorkingDirectory=$release" "ExecStart=/usr/bin/node $release/scripts/harness-web-server.js --auth-config $auth_config --task-config $task_config" 'Restart=on-failure' 'RestartSec=3' 'NoNewPrivileges=yes' 'PrivateTmp=yes' 'ProtectSystem=strict' 'ProtectHome=yes' 'MemoryMax=512M' 'MemorySwapMax=0' 'TasksMax=32' 'LimitNOFILE=256' 'CPUQuota=50%' 'UMask=0077' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' '' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/tech-persistence-harness-web.service
printf '%s\n' '[Unit]' 'Description=Tech Persistence authenticated Harness task worker' 'After=network-online.target docker.service tech-persistence-provider-broker.service' 'Requires=tech-persistence-provider-broker.service' '' '[Service]' 'Type=simple' 'User=tp-authority' 'Group=tp-authority' 'SupplementaryGroups=tp-provider' "WorkingDirectory=$release" "Environment=TP_TASK_WORKER_CONFIG=$worker_config" "EnvironmentFile=$worker_env" "ExecStart=/usr/bin/node $release/scripts/harness-task-worker.js" 'Restart=on-failure' 'RestartSec=5' 'PrivateTmp=yes' 'ProtectSystem=strict' 'ProtectHome=yes' 'ReadWritePaths=/var/lib/tech-persistence/task-sandboxes /var/lib/tech-persistence/task-runtime/transcript-spool' 'MemoryMax=768M' 'MemorySwapMax=0' 'TasksMax=96' 'LimitNOFILE=512' 'CPUQuota=100%' 'UMask=0077' 'NoNewPrivileges=no' '' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/tech-persistence-harness-worker.service
printf '%s\n' '[Unit]' 'Description=Tech Persistence Harness task transcript synchronization' 'After=network-online.target docker.service' '' '[Service]' 'Type=oneshot' 'User=tp-authority' 'Group=tp-authority' "WorkingDirectory=$release" "ExecStart=/usr/bin/node scripts/sync-runtime-transcripts.js --outbox /var/lib/tech-persistence/task-runtime/transcript-spool --env-file $transcript_env" 'NoNewPrivileges=yes' 'PrivateTmp=yes' 'ProtectSystem=strict' 'ProtectHome=yes' 'ReadWritePaths=/var/lib/tech-persistence/task-runtime/transcript-spool' 'UMask=0077' 'MemoryMax=192M' 'TasksMax=32' 'TimeoutStartSec=120' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' > /etc/systemd/system/tech-persistence-harness-transcripts.service
printf '%s\n' '[Unit]' 'Description=Retry Harness task transcript outbox' '' '[Timer]' 'OnBootSec=5s' 'OnUnitInactiveSec=15s' 'RandomizedDelaySec=2s' 'Unit=tech-persistence-harness-transcripts.service' '' '[Install]' 'WantedBy=timers.target' > /etc/systemd/system/tech-persistence-harness-transcripts.timer
chmod 0644 /etc/systemd/system/tech-persistence-harness-web.service /etc/systemd/system/tech-persistence-harness-worker.service \
  /etc/systemd/system/tech-persistence-harness-transcripts.service /etc/systemd/system/tech-persistence-harness-transcripts.timer
systemctl daemon-reload
systemctl enable --now tech-persistence-harness-web.service tech-persistence-harness-worker.service tech-persistence-harness-transcripts.timer
systemctl start tech-persistence-harness-transcripts.service
ln -s "$release" /opt/tech-persistence-harness/current
rm -f -- "$role_sql"; trap - EXIT HUP INT TERM
echo 'Harness web production services installed'
