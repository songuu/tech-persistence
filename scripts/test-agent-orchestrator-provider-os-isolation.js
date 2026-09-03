'use strict';

const assert = require('assert');
const orchestrator = require('./agent-orchestrator');

const HASH = `sha256:${'a'.repeat(64)}`;
const launch = {
  command: '/usr/local/bin/codex',
  argsPrefix: ['exec'],
  shell: false,
};

function deps(overrides = {}) {
  const records = {
    '/': { file: false, directory: true, symbolicLink: false, uid: 0, mode: 0o40755 },
    '/usr': { file: false, directory: true, symbolicLink: false, uid: 0, mode: 0o40755 },
    '/usr/bin': { file: false, directory: true, symbolicLink: false, uid: 0, mode: 0o40755 },
    '/usr/bin/setpriv': { file: true, directory: false, symbolicLink: false, uid: 0, mode: 0o100755 },
    '/srv/tp-provider': { file: false, directory: true, symbolicLink: false, uid: 2002, mode: 0o40700 },
  };
  return {
    platform: 'linux',
    currentUid: 2001,
    lstatSync(file) {
      const record = records[file];
      if (!record) throw new Error(`missing fixture: ${file}`);
      return {
        uid: record.uid,
        mode: record.mode,
        isFile: () => record.file,
        isDirectory: () => record.directory,
        isSymbolicLink: () => record.symbolicLink,
      };
    },
    realpathSync: (file) => file,
    hashFile: () => HASH,
    ...overrides,
  };
}

assert.strictEqual(
  orchestrator.resolveProviderOsIsolation({}, launch, ['--json'], deps()).enabled,
  false
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'require-provider-os-isolation': true,
  }, launch, [], deps()),
  /required.*not configured/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({ 'provider-uid': '2002' }, launch, [], deps()),
  /uid and.*gid/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({ 'provider-gid': '2002' }, launch, [], deps()),
  /uid and.*gid/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2002', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
  }, launch, [], deps({ platform: 'win32' })),
  /not supported on Windows/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': 'nope', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
  }, launch, [], deps()),
  /positive integer/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2001', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
  }, launch, [], deps()),
  /must differ from the harness/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2002', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
    'provider-setpriv-path': 'setpriv',
  }, launch, [], deps()),
  /absolute/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2002', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
  }, launch, [], deps({
    lstatSync(file) {
      if (file === '/usr/bin/setpriv') return {
        uid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false,
        isSymbolicLink: () => true,
      };
      return deps().lstatSync(file);
    },
  })),
  /regular non-link/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2002', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
  }, launch, [], deps({
    lstatSync(file) {
      const stat = deps().lstatSync(file);
      return file === '/usr/bin/setpriv' ? { ...stat, uid: 2002 } : stat;
    },
  })),
  /root-owned/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2002', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
  }, launch, [], deps({
    lstatSync(file) {
      const stat = deps().lstatSync(file);
      return file === '/usr/bin/setpriv' ? { ...stat, mode: 0o100777 } : stat;
    },
  })),
  /must not be writable/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2002', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
  }, launch, [], deps({
    lstatSync(file) {
      const stat = deps().lstatSync(file);
      return file === '/usr/bin' ? { ...stat, mode: 0o40777 } : stat;
    },
  })),
  /launcher path.*writable/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2002', 'provider-gid': '2002',
  }, launch, [], deps()),
  /provider-home/i
);
assert.throws(
  () => orchestrator.resolveProviderOsIsolation({
    'provider-uid': '2002', 'provider-gid': '2002', 'provider-home': '/srv/tp-provider',
  }, launch, [], deps({
    lstatSync(file) {
      const stat = deps().lstatSync(file);
      return file === '/srv/tp-provider' ? { ...stat, uid: 2003 } : stat;
    },
  })),
  /owned by provider uid/i
);

const isolated = orchestrator.resolveProviderOsIsolation({
  'provider-uid': '2002',
  'provider-gid': '2002',
  'provider-home': '/srv/tp-provider',
}, launch, ['--json'], deps());
assert.strictEqual(isolated.enabled, true);
assert.strictEqual(isolated.launch.command, '/usr/bin/setpriv');
assert.deepStrictEqual(isolated.args, [
  '--reuid', '2002', '--regid', '2002', '--clear-groups', '--',
  '/usr/local/bin/codex', 'exec', '--json',
]);
assert.deepStrictEqual(isolated.identity, {
  uid: 2002,
  gid: 2002,
  home: '/srv/tp-provider',
  launcher: '/usr/bin/setpriv',
  launcherDigest: HASH,
});

const environment = orchestrator.providerProcessEnv(
  { TP_AGENT_RUN_DIR: '/repo/.agent-runs/run-1' },
  {
    HOME: '/root',
    USERPROFILE: 'C:\\Users\\authority',
    SUDO_USER: 'authority',
    ACCEPTANCE_POSTGRES_WRITE_URL: 'secret',
    PATH: '/usr/bin',
  },
  isolated
);
assert.strictEqual(environment.HOME, '/srv/tp-provider');
assert.strictEqual(environment.PATH, '/usr/bin');
assert.strictEqual(environment.TP_AGENT_RUN_DIR, '/repo/.agent-runs/run-1');
assert.strictEqual(environment.USERPROFILE, undefined);
assert.strictEqual(environment.SUDO_USER, undefined);
assert.strictEqual(environment.ACCEPTANCE_POSTGRES_WRITE_URL, undefined);

let capturedInvocation = null;
const integrated = orchestrator.runProcess('isolated provider', launch, ['--json'], {
  cwd: '/repo',
  options: {
    'provider-uid': '2002',
    'provider-gid': '2002',
    'provider-home': '/srv/tp-provider',
  },
  env: { TP_AGENT_RUN_DIR: '/repo/.agent-runs/run-1' },
  osIsolationDependencies: deps(),
  spawnSyncImpl(command, args, settings) {
    capturedInvocation = { command, args, settings };
    return { status: 0, signal: null, error: null, stdout: '{}', stderr: '' };
  },
});
assert.strictEqual(capturedInvocation.command, '/usr/bin/setpriv');
assert.deepStrictEqual(capturedInvocation.args, isolated.args);
assert.strictEqual(capturedInvocation.settings.shell, false);
assert.strictEqual(capturedInvocation.settings.env.HOME, '/srv/tp-provider');
assert.strictEqual(integrated.record.providerOsIsolation.uid, 2002);
assert.strictEqual(integrated.record.providerOsIsolation.verifiedAfterExecution, true);
assert.strictEqual(integrated.record.command, '/usr/local/bin/codex');

let launcherHash = HASH;
assert.throws(
  () => orchestrator.runProcess('mutated isolation launcher', launch, ['--json'], {
    cwd: '/repo',
    options: {
      'provider-uid': '2002',
      'provider-gid': '2002',
      'provider-home': '/srv/tp-provider',
    },
    osIsolationDependencies: deps({ hashFile: () => launcherHash }),
    spawnSyncImpl() {
      launcherHash = `sha256:${'b'.repeat(64)}`;
      return { status: 0, signal: null, error: null, stdout: '{}', stderr: '' };
    },
  }),
  /changed during provider execution/i
);

console.log('agent-orchestrator-provider-os-isolation: all assertions passed');
