#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
[ "${TP_HARNESS_WEB_PUBLISH:-}" = "PUBLISH-20260903-HARNESS-WEB" ] || exit 3
stage=/var/lib/tech-persistence/site-candidate-20260903
release=/opt/tech-persistence/releases/20260903-harness-web-v1
snippet=/etc/nginx/snippets/tech-persistence.location.conf
snippet_candidate=/var/lib/tech-persistence/tech-persistence.location.conf.20260903
snippet_backup=/etc/nginx/snippets/tech-persistence.location.conf.pre-harness-web-20260903
current=/opt/tech-persistence/current
old=$(readlink -f "$current")
[ -f "$stage/build-manifest.json" ] && [ -f "$stage/tasks/index.html" ] && [ -f "$stage/assets/tasks.js" ]
[ -f "$snippet_candidate" ] && [ ! -e "$release" ] && [ ! -e "$snippet_backup" ]
install -d -o root -g root -m 0755 "$release"
cp -a "$stage/." "$release/"
chown -R root:root "$release"; find "$release" -type d -exec chmod 0755 {} +; find "$release" -type f -exec chmod 0444 {} +
cp -a "$snippet" "$snippet_backup"
install -o root -g root -m 0644 "$snippet_candidate" "$snippet"
rollback() {
  install -o root -g root -m 0644 "$snippet_backup" "$snippet"
  ln -s "$old" /opt/tech-persistence/.current-rollback
  mv -Tf /opt/tech-persistence/.current-rollback "$current"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
}
trap rollback HUP INT TERM
nginx -t
ln -s "$release" /opt/tech-persistence/.current-harness-web
mv -Tf /opt/tech-persistence/.current-harness-web "$current"
systemctl reload nginx
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: songuu.top' http://127.0.0.1:5183/tech-persistence/api/v1/auth/session)
[ "$code" = 401 ]
code=$(curl -sS -o /dev/null -w '%{http_code}' https://songuu.top/tech-persistence/tasks/)
[ "$code" = 200 ]
code=$(curl -sS -o /dev/null -w '%{http_code}' https://songuu.top/tech-persistence/api/v1/auth/session)
[ "$code" = 401 ]
trap - HUP INT TERM
echo 'Harness web site and API route published'
