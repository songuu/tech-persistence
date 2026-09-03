'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'deploy', 'acceptance-authority', 'install-linux.sh');
const source = fs.readFileSync(script, 'utf8');

assert(source.startsWith('#!/bin/sh\nset -eu\n'));
assert(source.includes("MODE=\"${1:-plan}\""));
assert(source.includes("CONFIRM_TOKEN='APPLY_TECH_PERSISTENCE_OS_BOUNDARY_V1'"));
assert(source.includes("if [ \"$MODE\" = 'plan' ]"));
assert(source.includes("if [ \"$CONFIRMATION\" != \"$CONFIRM_TOKEN\" ]"));
assert(source.includes("if [ \"$(/usr/bin/id -u)\" != '0' ]"));
assert(source.includes("AUTHORITY_USER='tp-authority'"));
assert(source.includes("PROVIDER_USER='tp-provider'"));
assert(source.includes('PROVIDER_WORKSPACE="${BASE_ROOT}/workspace"'));
assert(source.includes('-o "$AUTHORITY_USER" -g "$PROVIDER_GROUP" -m 0770 "$PROVIDER_WORKSPACE"'));
assert(source.includes("LAUNCHER=\"${INSTALL_ROOT}/provider-identity-launcher\""));
assert(source.includes('cap_setuid,cap_setgid,cap_kill=ep'));
assert(source.includes("SETFACL_BIN='/usr/bin/setfacl'"));
assert(source.includes('"$SETFACL_BIN" -b'));
assert(source.includes('"$SETFACL_BIN" -k'));
assert(source.includes('provider is a member of the authority group'));
assert(source.includes('assert_secure_existing_directory'));
assert(source.includes('protected path ancestor must not be group/other writable'));
assert(source.includes('protected path ancestor must not carry extended ACLs'));
assert(source.includes('assert_regular_single_link_or_absent'));
assert(source.includes('must be a regular single-link file'));
assert(source.includes('if [ -e "$SECRET_ENV" ] || [ -L "$SECRET_ENV" ]'));
assert(source.includes('authority account must not have supplementary groups'));
assert(source.includes('provider account must not have supplementary groups'));
assert(source.includes('primary group/home/nologin shell'));
assert(source.includes('UID and primary GID must be non-root'));
assert(source.includes('UID and primary GID must be distinct'));
assert(source.indexOf('assert_secure_existing_directory "$ancestor"') < source.indexOf('ensure_group "$AUTHORITY_GROUP"'));
assert(
  source.indexOf('/usr/bin/install -d -o root -g root -m 0755 "$BASE_ROOT" "$INSTALL_ROOT"')
    < source.indexOf('ensure_user "$AUTHORITY_USER" "$AUTHORITY_GROUP" "$AUTHORITY_HOME"'),
  'root-owned multi-level parents must exist before RHEL-family useradd creates service homes'
);
assert(source.includes("[ ! -f \"$SECRET_ENV\" ] || [ -L \"$SECRET_ENV\" ]"));
assert(!source.includes('install -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0600 "$AUDITOR_SOURCE"'));
assert(!source.includes('sudo '));
assert(!source.includes('eval '));
assert(!source.includes("SETPRIV_SOURCE='/usr/bin/setpriv'"));
assert(source.includes('-DTP_AUTHORITY_UID="$authority_uid"'));
assert(source.includes('-DTP_PROVIDER_UID="$provider_uid"'));
assert(source.includes('-DTP_PROVIDER_GID="$provider_gid"'));
assert(source.includes('"$RUNUSER_BIN" -u "$AUTHORITY_USER"'));
assert(source.includes('audit --json'));
assert(source.includes('--require-provider-os-isolation'));

const launcherSource = fs.readFileSync(path.join(path.dirname(script), 'provider-identity-launcher.c'), 'utf8');
assert(launcherSource.includes('getuid() != (uid_t)TP_AUTHORITY_UID'));
assert(launcherSource.includes('requested identity differs from the compiled provider identity'));
assert(launcherSource.includes("*cursor < '0' || *cursor > '9'"));
assert(launcherSource.includes('setgroups(0, NULL)'));
assert(launcherSource.includes('setresgid'));
assert(launcherSource.includes('setresuid'));
assert(launcherSource.includes('SYS_capset'));
assert(launcherSource.includes('PR_SET_NO_NEW_PRIVS'));
assert(launcherSource.includes('argv[7][0] !='));
assert(launcherSource.includes('execv(argv[7], &argv[7])'));
assert(!launcherSource.includes('system('));
assert(!launcherSource.includes('execvp('));

const bash = spawnSync('bash', ['--version'], { encoding: 'utf8', shell: false });
if (bash.status === 0) {
  const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8', shell: false });
  assert.strictEqual(syntax.status, 0, syntax.stderr);
  const plan = spawnSync('bash', [script, 'plan'], { encoding: 'utf8', shell: false });
  assert.strictEqual(plan.status, 0, plan.stderr);
  assert(plan.stdout.includes('acceptance OS boundary plan v1'));
  assert(plan.stdout.includes('APPLY_TECH_PERSISTENCE_OS_BOUNDARY_V1'));
  assert(!plan.stdout.includes('[pass] acceptance OS boundary installed'));
}

console.log('acceptance-authority-os-boundary-install: all assertions passed');
