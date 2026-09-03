#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_CREATE_QUALIFICATION_ACCOUNT:-}" = "CREATE-20260903-QUALIFICATION-E2E" ] || exit 3
credential_file=/root/tech-persistence-qualification-login.txt
release=$(readlink -f /opt/tech-persistence-harness/current)
[ -d "$release" ] && [ ! -e "$credential_file" ]
umask 077
password=$(openssl rand -base64 24 | tr -d '\n')
printf '{"username":"qualification-e2e","password":"%s"}\n' "$password" \
  | /usr/bin/node "$release/scripts/harness-web-account.js" --config /etc/tech-persistence/harness-web/admin.json --action create >/dev/null
docker exec tech-persistence-postgres psql -U postgres -d tech_persistence -X -v ON_ERROR_STOP=1 -c \
  "INSERT INTO harness_tasks.members(project_id, account_id, can_create, can_execute)
   SELECT 'qualification-project', id, true, true FROM harness_web.accounts WHERE username = 'qualification-e2e';" >/dev/null
printf 'URL=https://songuu.top/tech-persistence/tasks/\nUSERNAME=qualification-e2e\nPASSWORD=%s\n' "$password" > "$credential_file"
chmod 0600 "$credential_file"
echo 'Dedicated qualification account created'
