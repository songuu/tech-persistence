#!/bin/sh
set -eu

fail() { echo "invalid task Codex invocation" >&2; exit 2; }
[ "$#" -ge 8 ] && [ "$1" = exec ] && [ "$2" = -C ] || fail
workspace="$3"; shift 3
[ "$1" = --json ] && [ "$2" = --output-last-message ] || fail
last_message="$3"; shift 3
skip_git=''
if [ "${1:-}" = --skip-git-repo-check ]; then skip_git=--skip-git-repo-check; shift; fi
[ "${1:-}" = --output-schema ] || fail
schema="$2"; shift 2
resume_id=''
if [ "${1:-}" = resume ]; then
  resume_id="$2"; shift 2
  printf '%s' "$resume_id" | /usr/bin/grep -Eq '^[A-Za-z0-9_-]{8,200}$' || fail
fi
[ "$#" -eq 1 ] && [ "$1" = - ] || fail

script_path="$(/usr/bin/readlink -f "$0")"
runtime_root="$(/usr/bin/dirname "$(/usr/bin/dirname "$script_path")")"
case "$runtime_root" in
  /var/lib/tech-persistence/runtime-candidates/harness-*|/opt/tech-persistence-harness/releases/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-harness-web-v[0-9]*) ;;
  *) fail ;;
esac
[ "$(/usr/bin/stat -c %u "$runtime_root")" -eq 0 ] || fail
[ ! -w "$runtime_root" ] || fail
case "$workspace" in /var/lib/tech-persistence/task-sandboxes/*/*/output/workspace) ;; *) fail ;; esac
case "$last_message" in /var/lib/tech-persistence/task-sandboxes/*/*/output/provider-output/*.json) ;; *) fail ;; esac
[ "$schema" = "$runtime_root/schemas/agent-loop/agent-handoff.schema.json" ] || fail
[ "$(/usr/bin/readlink -f "$workspace")" = "$workspace" ] || fail
provider_output="$(/usr/bin/dirname "$last_message")"
[ "$(/usr/bin/readlink -f "$provider_output")" = "$provider_output" ] || fail
[ "$(/usr/bin/readlink -f "$HOME")" = "$HOME" ] || fail
case "$HOME" in /var/lib/tech-persistence/task-sandboxes/*/*/output/provider-home) ;; *) fail ;; esac
codex_root=/var/lib/tech-persistence/runtime-candidates/codex-0.152.1
bootstrap_receipt="$provider_output/plugin-bootstrap.json"
/usr/bin/bwrap --die-with-parent --unshare-all --unshare-user --uid 0 --gid 0 --cap-drop ALL \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
  --ro-bind "$runtime_root" /runtime --ro-bind "$codex_root" /codex \
  --bind "$provider_output" /provider-output --bind "$HOME" /home \
  --proc /proc --dev /dev --tmpfs /tmp --setenv HOME /home --setenv PATH /usr/bin:/bin \
  /bin/sh /runtime/scripts/codex-task-plugin-bootstrap-entrypoint.sh </dev/null
[ -f "$HOME/.codex/config.toml" ] && [ -d "$HOME/.codex/plugins" ] \
  && [ -f "$HOME/.codex/tech-persistence-bootstrap.json" ] && [ -f "$bootstrap_receipt" ] || fail

set -- exec -C /workspace --json --output-last-message "/provider-output/$(/usr/bin/basename "$last_message")"
[ -z "$skip_git" ] || set -- "$@" "$skip_git"
set -- "$@" --output-schema /runtime/schemas/agent-loop/agent-handoff.schema.json
[ -z "$resume_id" ] || set -- "$@" resume "$resume_id"
set -- "$@" -
exec /usr/bin/bwrap --die-with-parent --unshare-all --unshare-user --uid 0 --gid 0 \
  --cap-drop ALL --cap-add CAP_NET_ADMIN --cap-add CAP_SETPCAP \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
  --ro-bind "$runtime_root" /runtime \
  --ro-bind "$codex_root" /codex \
  --ro-bind /run/tech-persistence-provider-broker/provider /broker \
  --ro-bind /etc/tech-persistence/provider-model /task-model \
  --bind "$workspace" /workspace --bind "$provider_output" /provider-output --bind "$HOME" /home \
  --ro-bind "$HOME/.codex/plugins" /home/.codex/plugins \
  --ro-bind "$HOME/.codex/config.toml" /home/.codex/config.toml \
  --ro-bind "$HOME/.codex/tech-persistence-bootstrap.json" /home/.codex/tech-persistence-bootstrap.json \
  --ro-bind "$bootstrap_receipt" /provider-output/plugin-bootstrap.json \
  --proc /proc --dev /dev --tmpfs /tmp --setenv HOME /home --setenv PATH /usr/bin:/bin --chdir /workspace \
  /runtime/scripts/codex-task-bwrap-entrypoint.sh "$@"
