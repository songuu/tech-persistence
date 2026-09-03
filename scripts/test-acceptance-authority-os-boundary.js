'use strict';

const assert = require('assert');
const boundary = require('./acceptance-authority-os-boundary');

function baseSnapshot(overrides = {}) {
  return {
    schemaVersion: 'tech-persistence.acceptance-os-boundary-audit.v1',
    observedAt: '2026-09-01T08:00:00.000Z',
    platform: 'linux',
    currentUid: 2101,
    accounts: {
      authority: { name: 'tp-authority', uid: 2101, gid: 2101, groups: [2101], home: '/var/lib/tech-persistence/authority', shell: '/usr/sbin/nologin' },
      provider: { name: 'tp-provider', uid: 2102, gid: 2102, groups: [2102], home: '/var/lib/tech-persistence/provider', shell: '/usr/sbin/nologin' },
    },
    paths: {
      launcher: {
        path: '/usr/local/libexec/tech-persistence/provider-identity-launcher',
        realpath: '/usr/local/libexec/tech-persistence/provider-identity-launcher',
        type: 'file', uid: 0, gid: 2101, mode: 0o750, nlink: 1, symbolicLink: false, extendedAcl: false,
        ancestry: [
          { path: '/', type: 'directory', uid: 0, mode: 0o755, symbolicLink: false, extendedAcl: false },
          { path: '/usr', type: 'directory', uid: 0, mode: 0o755, symbolicLink: false, extendedAcl: false },
          { path: '/usr/local', type: 'directory', uid: 0, mode: 0o755, symbolicLink: false, extendedAcl: false },
          { path: '/usr/local/libexec', type: 'directory', uid: 0, mode: 0o755, symbolicLink: false, extendedAcl: false },
          { path: '/usr/local/libexec/tech-persistence', type: 'directory', uid: 0, mode: 0o755, symbolicLink: false, extendedAcl: false },
        ],
      },
      authorityHome: { path: '/var/lib/tech-persistence/authority', realpath: '/var/lib/tech-persistence/authority', type: 'directory', uid: 2101, gid: 2101, mode: 0o700, symbolicLink: false, extendedAcl: false },
      providerHome: { path: '/var/lib/tech-persistence/provider', realpath: '/var/lib/tech-persistence/provider', type: 'directory', uid: 2102, gid: 2102, mode: 0o700, symbolicLink: false, extendedAcl: false },
      providerWorkspace: { path: '/var/lib/tech-persistence/workspace', realpath: '/var/lib/tech-persistence/workspace', type: 'directory', uid: 2101, gid: 2102, mode: 0o770, symbolicLink: false, extendedAcl: false },
      controlRoot: { path: '/var/lib/tech-persistence/authority/control', realpath: '/var/lib/tech-persistence/authority/control', type: 'directory', uid: 2101, gid: 2101, mode: 0o700, symbolicLink: false, extendedAcl: false },
      secretEnv: { path: '/var/lib/tech-persistence/authority/acceptance.env', realpath: '/var/lib/tech-persistence/authority/acceptance.env', type: 'file', uid: 2101, gid: 2101, mode: 0o600, nlink: 1, symbolicLink: false, extendedAcl: false },
    },
    launcherCapabilities: ['cap_kill', 'cap_setgid', 'cap_setuid'],
    digests: { auditor: `sha256:${'a'.repeat(64)}`, launcher: `sha256:${'b'.repeat(64)}` },
    probes: {
      providerUid: 2102,
      providerGid: 2102,
      providerGroups: [2102],
      canReadSecret: false,
      canReadControlRoot: false,
      canWriteControlRoot: false,
      canWriteProviderWorkspace: true,
      canExecuteLauncher: false,
      rejectsAuthorityIdentity: true,
      rejectsRootIdentity: true,
      rejectsRelativeCommand: true,
    },
    ...overrides,
  };
}

function audit(snapshot = baseSnapshot()) {
  return boundary.evaluateBoundarySnapshot(snapshot);
}

assert.strictEqual(audit().ok, true);
assert.strictEqual(audit().checks.length >= 20, true);
assert.deepStrictEqual(boundary.failedCheckIds(audit()), []);

for (const [name, mutate, expected] of [
  ['platform', (s) => { s.platform = 'win32'; }, 'linux-platform'],
  ['invalid-observed-at', (s) => { s.observedAt = 'yesterday'; }, 'observed-at-valid'],
  ['invalid-digest', (s) => { s.digests.launcher = 'sha256:nope'; }, 'artifact-digests-valid'],
  ['authority-current-user', (s) => { s.currentUid = 0; }, 'authority-current-uid'],
  ['shared-uid', (s) => { s.accounts.provider.uid = 2101; }, 'distinct-account-uids'],
  ['shared-gid', (s) => { s.accounts.provider.gid = 2101; }, 'distinct-primary-gids'],
  ['root-authority', (s) => { s.accounts.authority.uid = 0; s.currentUid = 0; }, 'non-root-service-identities'],
  ['provider-authority-group', (s) => { s.accounts.provider.groups.push(2101); }, 'provider-excluded-from-authority-group'],
  ['authority-extra-group', (s) => { s.accounts.authority.groups.push(27); }, 'authority-no-supplementary-groups'],
  ['provider-extra-group', (s) => { s.accounts.provider.groups.push(44); }, 'provider-no-supplementary-groups'],
  ['authority-login-shell', (s) => { s.accounts.authority.shell = '/bin/bash'; }, 'accounts-nologin'],
  ['provider-account-home', (s) => { s.accounts.provider.home = '/tmp/provider'; }, 'account-homes-bound'],
  ['launcher-link', (s) => { s.paths.launcher.symbolicLink = true; }, 'launcher-regular-non-link'],
  ['launcher-owner', (s) => { s.paths.launcher.uid = 2101; }, 'launcher-root-owned'],
  ['launcher-group', (s) => { s.paths.launcher.gid = 2102; }, 'launcher-authority-group'],
  ['launcher-mode', (s) => { s.paths.launcher.mode = 0o770; }, 'launcher-mode-0750'],
  ['launcher-hardlink', (s) => { s.paths.launcher.nlink = 2; }, 'launcher-single-link'],
  ['launcher-acl', (s) => { s.paths.launcher.extendedAcl = true; }, 'launcher-no-extended-acl'],
  ['writable-ancestor', (s) => { s.paths.launcher.ancestry[3].mode = 0o777; }, 'launcher-ancestry-protected'],
  ['ancestor-acl', (s) => { s.paths.launcher.ancestry[3].extendedAcl = true; }, 'launcher-ancestry-no-extended-acl'],
  ['missing-capability', (s) => { s.launcherCapabilities = ['cap_setuid']; }, 'launcher-minimal-capabilities'],
  ['extra-capability', (s) => { s.launcherCapabilities.push('cap_dac_override'); }, 'launcher-minimal-capabilities'],
  ['home-owner', (s) => { s.paths.providerHome.uid = 2101; }, 'provider-home-owner'],
  ['home-mode', (s) => { s.paths.providerHome.mode = 0o755; }, 'provider-home-mode-0700'],
  ['workspace-owner', (s) => { s.paths.providerWorkspace.uid = 2102; }, 'provider-workspace-authority-owner'],
  ['workspace-mode', (s) => { s.paths.providerWorkspace.mode = 0o700; }, 'provider-workspace-mode-0770'],
  ['control-owner', (s) => { s.paths.controlRoot.uid = 0; }, 'control-root-authority-owner'],
  ['authority-home-mode', (s) => { s.paths.authorityHome.mode = 0o750; }, 'authority-home-mode-0700'],
  ['control-mode', (s) => { s.paths.controlRoot.mode = 0o750; }, 'control-root-mode-0700'],
  ['secret-owner', (s) => { s.paths.secretEnv.uid = 0; }, 'secret-env-authority-owner'],
  ['secret-mode', (s) => { s.paths.secretEnv.mode = 0o640; }, 'secret-env-mode-0600'],
  ['secret-hardlink', (s) => { s.paths.secretEnv.nlink = 2; }, 'secret-env-single-link'],
  ['secret-acl', (s) => { s.paths.secretEnv.extendedAcl = true; }, 'sensitive-paths-no-extended-acl'],
  ['workspace-overlap', (s) => { s.paths.controlRoot.realpath = '/var/lib/tech-persistence/workspace/control'; }, 'authority-paths-outside-provider-workspace'],
  ['authority-escape', (s) => { s.paths.secretEnv.realpath = '/etc/acceptance.env'; }, 'authority-assets-contained'],
  ['uid-probe', (s) => { s.probes.providerUid = 2101; }, 'probe-provider-uid'],
  ['gid-probe', (s) => { s.probes.providerGid = 2101; }, 'probe-provider-gid'],
  ['groups-probe', (s) => { s.probes.providerGroups = [2102, 2101]; }, 'probe-cleared-supplementary-groups'],
  ['secret-readable', (s) => { s.probes.canReadSecret = true; }, 'probe-secret-unreadable'],
  ['control-readable', (s) => { s.probes.canReadControlRoot = true; }, 'probe-control-root-unreadable'],
  ['control-writable', (s) => { s.probes.canWriteControlRoot = true; }, 'probe-control-root-unwritable'],
  ['workspace-unwritable', (s) => { s.probes.canWriteProviderWorkspace = false; }, 'probe-workspace-writable'],
  ['launcher-executable', (s) => { s.probes.canExecuteLauncher = true; }, 'probe-launcher-unexecutable'],
  ['authority-identity-accepted', (s) => { s.probes.rejectsAuthorityIdentity = false; }, 'probe-authority-identity-rejected'],
  ['root-identity-accepted', (s) => { s.probes.rejectsRootIdentity = false; }, 'probe-root-identity-rejected'],
  ['relative-command-accepted', (s) => { s.probes.rejectsRelativeCommand = false; }, 'probe-relative-command-rejected'],
]) {
  const snapshot = baseSnapshot();
  mutate(snapshot);
  const result = audit(snapshot);
  assert.strictEqual(result.ok, false, name);
  assert(boundary.failedCheckIds(result).includes(expected), `${name}: expected ${expected}`);
}

assert.throws(() => boundary.evaluateBoundarySnapshot({}), /schema version/i);
assert.throws(() => boundary.parseArgs(['node', 'script', 'audit', '--authority-user']), /missing value/i);
assert.throws(() => boundary.parseArgs(['node', 'script', 'apply']), /unknown command/i);
assert.deepStrictEqual(
  boundary.parseCapabilities('/path = cap_setuid,cap_setgid,cap_kill+ep'),
  ['cap_kill', 'cap_setgid', 'cap_setuid']
);
assert.deepStrictEqual(boundary.parseNumericList('2102 2103\n'), [2102, 2103]);
assert.throws(
  () => boundary.validateOptions({ ...boundary.DEFAULTS, launcher: 'relative-launcher' }),
  /canonical absolute Linux path/i
);
assert.throws(
  () => boundary.validateOptions({ ...boundary.DEFAULTS, providerUser: 'tp-authority' }),
  /must differ/i
);

const runtimeRecords = Object.fromEntries([
  ['/', 'directory', 0, 0, 0o755],
  ['/usr', 'directory', 0, 0, 0o755],
  ['/usr/local', 'directory', 0, 0, 0o755],
  ['/usr/local/libexec', 'directory', 0, 0, 0o755],
  ['/usr/local/libexec/tech-persistence', 'directory', 0, 0, 0o755],
  ['/usr/local/libexec/tech-persistence/provider-identity-launcher', 'file', 0, 2101, 0o750],
  ['/var/lib/tech-persistence/authority', 'directory', 2101, 2101, 0o700],
  ['/var/lib/tech-persistence/provider', 'directory', 2102, 2102, 0o700],
  ['/var/lib/tech-persistence/workspace', 'directory', 2101, 2102, 0o770],
  ['/var/lib/tech-persistence/authority/control', 'directory', 2101, 2101, 0o700],
  ['/var/lib/tech-persistence/authority/acceptance.env', 'file', 2101, 2101, 0o600],
].map(([file, type, uid, gid, mode]) => [file, { type, uid, gid, mode }]));

const runtimeFs = {
  lstatSync(file) {
    const record = runtimeRecords[file];
    if (!record) throw new Error(`missing stat fixture: ${file}`);
    return {
      uid: record.uid, gid: record.gid, mode: record.mode, nlink: record.type === 'file' ? 1 : 2,
      isFile: () => record.type === 'file',
      isDirectory: () => record.type === 'directory',
      isSymbolicLink: () => false,
    };
  },
  realpathSync: (file) => file,
  readFileSync: (file) => Buffer.from(`fixture:${file}`),
};

function runtimeSpawn(command, args) {
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: null });
  if (command === '/usr/bin/getent' && args[0] === 'passwd') {
    return ok(args[1] === 'tp-authority'
      ? 'tp-authority:x:2101:2101::/var/lib/tech-persistence/authority:/usr/sbin/nologin\n'
      : 'tp-provider:x:2102:2102::/var/lib/tech-persistence/provider:/usr/sbin/nologin\n');
  }
  if (command === '/usr/bin/id' && args[0] === '-G') return ok(args[1] === 'tp-authority' ? '2101\n' : '2102\n');
  if (command === '/usr/sbin/getcap') return ok(`${args[0]} cap_setuid,cap_setgid,cap_kill=ep\n`);
  if (command === '/usr/bin/getfacl') return ok('user::rwx\ngroup::r-x\nother::---\n');
  if (command.endsWith('/provider-identity-launcher')) {
    const requestedUid = Number(args[1]);
    const requestedGid = Number(args[3]);
    const separator = args.indexOf('--');
    const child = args.slice(separator + 1);
    if (requestedUid !== 2102 || requestedGid !== 2102 || !child[0].startsWith('/')) {
      return { status: 126, stdout: '', stderr: 'rejected', error: null };
    }
    if (child[0] === '/usr/bin/id' && child[1] === '-u') return ok('2102\n');
    if (child[0] === '/usr/bin/id' && child[1] === '-g') return ok('2102\n');
    if (child[0] === '/usr/bin/id' && child[1] === '-G') return ok('2102\n');
    if (child[0] === '/usr/bin/test' && child[1] === '-w' && child[2].endsWith('/workspace')) return ok();
    if (child[0] === '/usr/bin/test') return { status: 1, stdout: '', stderr: '', error: null };
  }
  return { status: 127, stdout: '', stderr: 'unexpected command', error: null };
}

const collected = boundary.collectBoundarySnapshot(
  { ...boundary.DEFAULTS },
  { platform: 'linux', currentUid: 2101, fs: runtimeFs, spawnSync: runtimeSpawn, auditorPath: '/auditor.js', now: () => new Date('2026-09-01T08:00:00.000Z') }
);
assert.strictEqual(boundary.evaluateBoundarySnapshot(collected).ok, true);
assert(/^sha256:[a-f0-9]{64}$/.test(collected.digests.auditor));
assert(/^sha256:[a-f0-9]{64}$/.test(collected.digests.launcher));
assert.strictEqual(collected.probes.canReadSecret, false);
assert.strictEqual(collected.probes.canReadControlRoot, false);
assert.strictEqual(collected.probes.canWriteControlRoot, false);
assert.strictEqual(collected.probes.canWriteProviderWorkspace, true);
assert.strictEqual(collected.probes.canExecuteLauncher, false);
assert.strictEqual(collected.probes.rejectsAuthorityIdentity, true);
assert.strictEqual(collected.probes.rejectsRootIdentity, true);
assert.strictEqual(collected.probes.rejectsRelativeCommand, true);
assert.throws(
  () => boundary.collectBoundarySnapshot({ ...boundary.DEFAULTS }, { platform: 'win32' }),
  /requires Linux/i
);

console.log('acceptance-authority-os-boundary: all assertions passed');
