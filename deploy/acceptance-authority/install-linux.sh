#!/bin/sh
set -eu

MODE="${1:-plan}"
CONFIRMATION="${2:-}"
CONFIRM_TOKEN='APPLY_TECH_PERSISTENCE_OS_BOUNDARY_V1'

AUTHORITY_USER='tp-authority'
AUTHORITY_GROUP='tp-authority'
PROVIDER_USER='tp-provider'
PROVIDER_GROUP='tp-provider'
BASE_ROOT='/var/lib/tech-persistence'
AUTHORITY_HOME="${BASE_ROOT}/authority"
CONTROL_ROOT="${AUTHORITY_HOME}/control"
SECRET_ENV="${AUTHORITY_HOME}/acceptance.env"
PROVIDER_HOME="${BASE_ROOT}/provider"
PROVIDER_WORKSPACE="${BASE_ROOT}/workspace"
INSTALL_ROOT='/usr/local/libexec/tech-persistence'
LAUNCHER="${INSTALL_ROOT}/provider-identity-launcher"
AUDITOR="${INSTALL_ROOT}/acceptance-authority-os-boundary.js"
NODE_BIN='/usr/bin/node'
RUNUSER_BIN='/usr/sbin/runuser'
SETCAP_BIN='/usr/sbin/setcap'
SETFACL_BIN='/usr/bin/setfacl'
CC_BIN='/usr/bin/cc'

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
AUDITOR_SOURCE="${SCRIPT_DIR}/../../scripts/acceptance-authority-os-boundary.js"
LAUNCHER_SOURCE="${SCRIPT_DIR}/provider-identity-launcher.c"

print_plan() {
  printf '%s\n' \
    'Tech Persistence acceptance OS boundary plan v1' \
    "  accounts: ${AUTHORITY_USER}:${AUTHORITY_GROUP}, ${PROVIDER_USER}:${PROVIDER_GROUP}" \
    "  authority: ${AUTHORITY_HOME} (0700), ${CONTROL_ROOT} (0700), ${SECRET_ENV} (0600)" \
    "  provider home: ${PROVIDER_HOME} provider:provider 0700" \
    "  shared workdir: ${PROVIDER_WORKSPACE} authority:provider 0770" \
    "  launcher: ${LAUNCHER} root:${AUTHORITY_GROUP} 0750 cap_setuid,cap_setgid,cap_kill=ep (compiled fixed identities and bounded supervisor)" \
    "  auditor: ${AUDITOR} root:root 0755" \
    '  postcondition: provider cannot read secret or write control root; provider can write workspace' \
    "Apply only on the target Linux host as root:" \
    "  $0 apply ${CONFIRM_TOKEN}"
}

require_tool() {
  if [ ! -x "$1" ]; then
    printf '[fail] required executable missing: %s\n' "$1" >&2
    exit 1
  fi
}

assert_secure_existing_directory() {
  directory="$1"
  if [ -L "$directory" ]; then
    printf '[fail] protected path ancestor must not be a symbolic link: %s\n' "$directory" >&2
    exit 1
  fi
  if [ ! -e "$directory" ]; then
    return
  fi
  if [ ! -d "$directory" ]; then
    printf '[fail] protected path ancestor must be a regular non-link directory: %s\n' "$directory" >&2
    exit 1
  fi
  if [ "$(/usr/bin/stat -c %u "$directory")" != '0' ]; then
    printf '[fail] protected path ancestor must be root-owned: %s\n' "$directory" >&2
    exit 1
  fi
  write_bits=$(/usr/bin/stat -c %A "$directory" | /usr/bin/cut -c6,9)
  if [ "$write_bits" != '--' ]; then
    printf '[fail] protected path ancestor must not be group/other writable: %s\n' "$directory" >&2
    exit 1
  fi
  if /usr/bin/getfacl -cp "$directory" | /usr/bin/grep -E '^(default:|mask::|user:[^:]+:|group:[^:]+:)' >/dev/null 2>&1; then
    printf '[fail] protected path ancestor must not carry extended ACLs: %s\n' "$directory" >&2
    exit 1
  fi
}

assert_regular_single_link_or_absent() {
  target="$1"
  label="$2"
  if [ -L "$target" ]; then
    printf '[fail] %s must not be a symbolic link\n' "$label" >&2
    exit 1
  fi
  if [ ! -e "$target" ]; then
    return
  fi
  if [ ! -f "$target" ] || [ "$(/usr/bin/stat -c %h "$target")" != '1' ]; then
    printf '[fail] %s must be a regular single-link file\n' "$label" >&2
    exit 1
  fi
}

ensure_group() {
  group_name="$1"
  if ! /usr/bin/getent group "$group_name" >/dev/null 2>&1; then
    /usr/sbin/groupadd --system "$group_name"
  fi
}

validate_existing_user() {
  user_name="$1"
  expected_group="$2"
  expected_home="$3"
  passwd_record=$(/usr/bin/getent passwd "$user_name")
  actual_group=$(/usr/bin/id -gn "$user_name")
  actual_home=$(printf '%s' "$passwd_record" | /usr/bin/cut -d: -f6)
  actual_shell=$(printf '%s' "$passwd_record" | /usr/bin/cut -d: -f7)
  if [ "$actual_group" != "$expected_group" ] || [ "$actual_home" != "$expected_home" ] || [ "$actual_shell" != '/usr/sbin/nologin' ]; then
    printf '[fail] existing user %s does not match required primary group/home/nologin shell\n' "$user_name" >&2
    exit 1
  fi
}

ensure_user() {
  user_name="$1"
  group_name="$2"
  home_dir="$3"
  if /usr/bin/getent passwd "$user_name" >/dev/null 2>&1; then
    validate_existing_user "$user_name" "$group_name" "$home_dir"
    return
  fi
  /usr/sbin/useradd --system --gid "$group_name" --home-dir "$home_dir" --create-home --shell /usr/sbin/nologin "$user_name"
}

if [ "$MODE" = 'plan' ]; then
  print_plan
  exit 0
fi

if [ "$MODE" != 'apply' ]; then
  printf '[fail] mode must be plan or apply\n' >&2
  exit 2
fi
if [ "$CONFIRMATION" != "$CONFIRM_TOKEN" ]; then
  printf '[fail] apply requires the exact confirmation token shown by plan\n' >&2
  exit 2
fi
if [ "$(/usr/bin/uname -s)" != 'Linux' ]; then
  printf '[fail] apply is supported only on Linux\n' >&2
  exit 1
fi
if [ "$(/usr/bin/id -u)" != '0' ]; then
  printf '[fail] apply must run as root\n' >&2
  exit 1
fi

for tool in /usr/bin/getent /usr/bin/id /usr/bin/install /usr/bin/cut /usr/bin/stat /usr/bin/getfacl /usr/bin/mktemp /usr/bin/rm /usr/sbin/groupadd /usr/sbin/useradd "$NODE_BIN" "$RUNUSER_BIN" "$SETCAP_BIN" "$SETFACL_BIN" "$CC_BIN"; do
  require_tool "$tool"
done
if [ ! -f "$AUDITOR_SOURCE" ] || [ -L "$AUDITOR_SOURCE" ]; then
  printf '[fail] auditor source must be a regular non-link file\n' >&2
  exit 1
fi
if [ ! -f "$LAUNCHER_SOURCE" ] || [ -L "$LAUNCHER_SOURCE" ]; then
  printf '[fail] launcher source must be a regular non-link file\n' >&2
  exit 1
fi

for ancestor in /usr /usr/local /usr/local/libexec /usr/local/libexec/tech-persistence /var /var/lib /var/lib/tech-persistence; do
  assert_secure_existing_directory "$ancestor"
done
assert_regular_single_link_or_absent "$LAUNCHER" 'installed launcher'
assert_regular_single_link_or_absent "$AUDITOR" 'installed auditor'
assert_regular_single_link_or_absent "$SECRET_ENV" 'authority env'

# RHEL-family useradd creates the final home directory but not a missing
# multi-level parent. Establish only the root-owned parents before accounts;
# the service-owned homes are still created and tightened below.
/usr/bin/install -d -o root -g root -m 0755 "$BASE_ROOT" "$INSTALL_ROOT"

ensure_group "$AUTHORITY_GROUP"
ensure_group "$PROVIDER_GROUP"
ensure_user "$AUTHORITY_USER" "$AUTHORITY_GROUP" "$AUTHORITY_HOME"
ensure_user "$PROVIDER_USER" "$PROVIDER_GROUP" "$PROVIDER_HOME"

authority_gid=$(/usr/bin/id -g "$AUTHORITY_USER")
authority_uid=$(/usr/bin/id -u "$AUTHORITY_USER")
provider_gid=$(/usr/bin/id -g "$PROVIDER_USER")
provider_uid=$(/usr/bin/id -u "$PROVIDER_USER")
if [ "$authority_uid" = '0' ] || [ "$provider_uid" = '0' ] || [ "$authority_gid" = '0' ] || [ "$provider_gid" = '0' ]; then
  printf '[fail] authority/provider UID and primary GID must be non-root\n' >&2
  exit 1
fi
if [ "$authority_uid" = "$provider_uid" ] || [ "$authority_gid" = "$provider_gid" ]; then
  printf '[fail] authority/provider UID and primary GID must be distinct\n' >&2
  exit 1
fi
if [ "$(/usr/bin/id -G "$AUTHORITY_USER")" != "$authority_gid" ]; then
  printf '[fail] authority account must not have supplementary groups\n' >&2
  exit 1
fi
if [ "$(/usr/bin/id -G "$PROVIDER_USER")" != "$provider_gid" ]; then
  printf '[fail] provider account must not have supplementary groups\n' >&2
  exit 1
fi
if /usr/bin/id -G "$PROVIDER_USER" | /usr/bin/tr ' ' '\n' | /usr/bin/grep -Fx "$authority_gid" >/dev/null 2>&1; then
  printf '[fail] provider is a member of the authority group; remove that membership manually\n' >&2
  exit 1
fi

/usr/bin/install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0700 "$AUTHORITY_HOME" "$CONTROL_ROOT"
/usr/bin/install -d -o "$PROVIDER_USER" -g "$PROVIDER_GROUP" -m 0700 "$PROVIDER_HOME"
/usr/bin/install -d -o "$AUTHORITY_USER" -g "$PROVIDER_GROUP" -m 0770 "$PROVIDER_WORKSPACE"

if [ -e "$SECRET_ENV" ] || [ -L "$SECRET_ENV" ]; then
  if [ ! -f "$SECRET_ENV" ] || [ -L "$SECRET_ENV" ]; then
    printf '[fail] existing authority env must be a regular non-link file\n' >&2
    exit 1
  fi
  /usr/bin/chown "$AUTHORITY_USER:$AUTHORITY_GROUP" "$SECRET_ENV"
  /usr/bin/chmod 0600 "$SECRET_ENV"
else
  /usr/bin/install -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0600 /dev/null "$SECRET_ENV"
fi

launcher_build=$(/usr/bin/mktemp /tmp/tech-persistence-provider-launcher.XXXXXX)
cleanup_launcher_build() {
  /usr/bin/rm -f -- "$launcher_build"
}
trap cleanup_launcher_build 0
trap 'exit 1' HUP INT TERM
"$CC_BIN" -std=c11 -O2 -Wall -Wextra -Werror \
  -DTP_AUTHORITY_UID="$authority_uid" -DTP_PROVIDER_UID="$provider_uid" -DTP_PROVIDER_GID="$provider_gid" \
  "$LAUNCHER_SOURCE" -o "$launcher_build"
if [ ! -f "$launcher_build" ] || [ -L "$launcher_build" ]; then
  printf '[fail] compiled launcher must be a regular non-link file\n' >&2
  exit 1
fi
/usr/bin/install -o root -g "$AUTHORITY_GROUP" -m 0750 "$launcher_build" "$LAUNCHER"
"$SETCAP_BIN" cap_setuid,cap_setgid,cap_kill=ep "$LAUNCHER"
/usr/bin/install -o root -g root -m 0755 "$AUDITOR_SOURCE" "$AUDITOR"
"$SETFACL_BIN" -b "$BASE_ROOT" "$INSTALL_ROOT" "$LAUNCHER" "$PROVIDER_HOME" "$PROVIDER_WORKSPACE" "$AUTHORITY_HOME" "$CONTROL_ROOT" "$SECRET_ENV"
"$SETFACL_BIN" -k "$PROVIDER_HOME" "$PROVIDER_WORKSPACE" "$AUTHORITY_HOME" "$CONTROL_ROOT"

"$RUNUSER_BIN" -u "$AUTHORITY_USER" -- "$NODE_BIN" "$AUDITOR" audit --json

printf '%s\n' \
  '[pass] acceptance OS boundary installed and independently probed' \
  "provider UID: $(/usr/bin/id -u "$PROVIDER_USER")" \
  "provider GID: $(/usr/bin/id -g "$PROVIDER_USER")" \
  "orchestrator flags: --provider-uid $(/usr/bin/id -u "$PROVIDER_USER") --provider-gid $(/usr/bin/id -g "$PROVIDER_USER") --provider-home ${PROVIDER_HOME} --provider-setpriv-path ${LAUNCHER} --require-provider-os-isolation"
