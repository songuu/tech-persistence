#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  activationGate,
  claimAndRemoveLock,
  checkpointTransaction,
  commitTransaction,
  defaultRunCodex,
  markActivated,
  ownerSnapshot,
  prepareTransaction,
  reconcileTransaction,
  resolveCodexInvocation,
  rollbackTransaction,
} = require('./codex-user-install-transaction');
const {
  transformMarketplaceText,
  updateMarketplaceFile,
} = require('./update-codex-marketplace');

{
  const userProfile = path.join('C:\\', 'Users', 'tester');
  const appserverCli = path.join(
    userProfile,
    '.codex',
    'plugins',
    '.plugin-appserver',
    'codex.exe'
  );
  const appserver = resolveCodexInvocation({
    platform: 'win32',
    env: { USERPROFILE: userProfile, APPDATA: path.join(userProfile, 'AppData', 'Roaming') },
    existsSync: (candidate) => candidate === appserverCli,
  });
  assert.deepStrictEqual(appserver, {
    command: appserverCli,
    argsPrefix: [],
    source: 'windows-plugin-appserver-cli',
  });

  const appData = path.join('C:\\', 'Users', 'tester', 'AppData', 'Roaming');
  const expectedCli = path.join(
    appData,
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js'
  );
  const direct = resolveCodexInvocation({
    platform: 'win32',
    env: { APPDATA: appData },
    execPath: 'C:\\node.exe',
    existsSync: (candidate) => candidate === expectedCli,
  });
  assert.deepStrictEqual(direct, {
    command: 'C:\\node.exe',
    argsPrefix: [expectedCli],
    source: 'windows-npm-cli',
  });

  const calls = [];
  const result = defaultRunCodex(['plugin', 'list', '--json'], {
    platform: 'win32',
    env: { APPDATA: appData },
    execPath: 'C:\\node.exe',
    existsSync: (candidate) => candidate === expectedCli,
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '{"installed":[]}', stderr: '' };
    },
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].command, 'C:\\node.exe');
  assert.deepStrictEqual(calls[0].args, [expectedCli, 'plugin', 'list', '--json']);
  assert.deepStrictEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);

  const fallback = resolveCodexInvocation({
    platform: 'win32',
    env: { APPDATA: appData },
    existsSync: () => false,
  });
  assert.deepStrictEqual(fallback, { command: 'codex', argsPrefix: [], source: 'path-fallback' });

  assert.throws(
    () => ownerSnapshot({ installed: [{ name: 'tech-persistence', pluginId: 'other@unsafe' }] }),
    /unsafe plugin id/
  );
  assert.throws(
    () => ownerSnapshot({ installed: [
      { name: 'tech-persistence', pluginId: 'tech-persistence@same' },
      { name: 'tech-persistence', pluginId: 'tech-persistence@same' },
    ] }),
    /duplicate plugin ids/
  );
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writePlugin(root, version, marker, withLegacyCommands = false) {
  write(
    path.join(root, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'tech-persistence', version }, null, 2)}\n`
  );
  write(path.join(root, 'codex-skills', 'sprint', 'SKILL.md'), `# ${marker}\n`);
  write(path.join(root, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks: {} })}\n`);
  if (withLegacyCommands) write(path.join(root, 'commands', 'sprint.md'), '# legacy source only\n');
}

function readPluginVersion(root) {
  return JSON.parse(
    fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8')
  ).version;
}

function activateSource(source, target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  fs.rmSync(path.join(target, 'commands'), { recursive: true, force: true });
}

function canonicalMarketplace(existingText) {
  return transformMarketplaceText(existingText, {
    marketplaceName: 'local-plugins',
    marketplaceDisplayName: 'Local Plugins',
  });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-user-install-tx-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  const source = path.join(root, 'repo', 'plugins', 'tech-persistence');
  const target = path.join(home, 'plugins', 'tech-persistence');
  const marketplacePath = path.join(home, '.agents', 'plugins', 'marketplace.json');
  const oldMarketplaceRoot = path.join(root, 'old-marketplace-root');
  const evidenceRoot = path.join(codexHome, 'installer-transactions');
  const oldCache = path.join(
    codexHome,
    'plugins',
    'cache',
    'local-plugins',
    'tech-persistence',
    '0.9.0'
  );
  const canonicalCache = path.join(
    codexHome,
    'plugins',
    'cache',
    'local-plugins',
    'tech-persistence',
    '1.0.5'
  );
  fs.mkdirSync(oldMarketplaceRoot, { recursive: true });
  writePlugin(source, '1.0.5', 'new', true);
  writePlugin(target, '0.9.0', 'old');
  writePlugin(oldCache, '0.9.0', 'old');
  const oldMarketplaceText = `${JSON.stringify({
    name: 'local-plugins',
    interface: { displayName: 'Old Local Plugins' },
    metadata: {
      owner: 'keep-me',
      futureSchema: { enabled: true, revision: 7 },
    },
    extensionField: ['preserve', { nested: 'value' }],
    plugins: [{
      name: 'unrelated',
      source: { source: 'local', path: './plugins/unrelated' },
      customPolicy: { preserve: true },
    }],
  }, null, 2)}\n`;
  write(marketplacePath, oldMarketplaceText);

  const state = {
    owners: new Map([['tech-persistence@local-plugins', '0.9.0']]),
    marketplaces: new Map([['local-plugins', oldMarketplaceRoot]]),
    fail: new Set(),
    commands: [],
  };

  function runCodex(args) {
    const signature = args.join(' ');
    state.commands.push([...args]);
    if (state.fail.has(signature)) {
      return { status: 23, stdout: '', stderr: `injected ${signature}` };
    }
    if (signature === 'plugin list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({
          installed: [...state.owners.entries()].map(([pluginId, version]) => ({
            pluginId,
            name: 'tech-persistence',
            marketplaceName: pluginId.split('@')[1],
            version,
            installed: true,
            enabled: true,
            source: { source: 'local', path: target },
          })),
        }),
        stderr: '',
      };
    }
    if (signature === 'plugin marketplace list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({
          marketplaces: [...state.marketplaces.entries()].map(([name, marketplaceRoot]) => ({
            name,
            root: marketplaceRoot,
          })),
        }),
        stderr: '',
      };
    }
    if (args[0] === 'plugin' && args[1] === 'remove') {
      const pluginId = args[2];
      const version = state.owners.get(pluginId);
      state.owners.delete(pluginId);
      if (version) {
        const marketplace = pluginId.split('@')[1];
        fs.rmSync(
          path.join(codexHome, 'plugins', 'cache', marketplace, 'tech-persistence', version),
          { recursive: true, force: true }
        );
      }
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'add') {
      const pluginId = args[2];
      const version = pluginId === 'tech-persistence@local-plugins'
        ? readPluginVersion(target)
        : '0.9.0';
      state.owners.set(pluginId, version);
      const marketplace = pluginId.split('@')[1];
      const cachePath = path.join(
        codexHome,
        'plugins',
        'cache',
        marketplace,
        'tech-persistence',
        version
      );
      activateSource(target, cachePath);
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
      state.marketplaces.delete(args[3]);
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
      state.marketplaces.set('local-plugins', path.resolve(args[3]));
      return { status: 0, stdout: '{}', stderr: '' };
    }
    return { status: 99, stdout: '', stderr: `unexpected command: ${signature}` };
  }

  const options = {
    pluginTarget: target,
    pluginSource: source,
    marketplacePath,
    marketplaceRoot: home,
    marketplaceName: 'local-plugins',
    canonicalOwner: 'tech-persistence@local-plugins',
    codexHome,
    evidenceRoot,
    runCodex,
  };
  return {
    root,
    home,
    source,
    target,
    marketplacePath,
    oldMarketplaceRoot,
    oldMarketplaceText,
    oldCache,
    canonicalCache,
    codexHome,
    evidenceRoot,
    state,
    runCodex,
    options,
  };
}

if (process.argv[2] === '--rollback-hard-exit-child') {
  const childState = JSON.parse(process.env.CODEX_TX_CHILD_STATE);
  const manifest = JSON.parse(fs.readFileSync(childState.manifestPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(manifest.lockPath, 'utf8'));
  lock.pid = process.pid;
  manifest.ownerPid = process.pid;
  fs.writeFileSync(manifest.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  fs.writeFileSync(childState.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const childRunCodex = (args) => {
    const signature = args.join(' ');
    if (signature === 'plugin list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({
          installed: [{
            pluginId: 'tech-persistence@local-plugins',
            name: 'tech-persistence',
            marketplaceName: 'local-plugins',
            version: '0.9.0',
            installed: true,
            enabled: true,
            source: { source: 'local', path: childState.target },
          }],
        }),
        stderr: '',
      };
    }
    if (signature === 'plugin marketplace list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({
          marketplaces: [{
            name: 'local-plugins',
            root: childState.oldMarketplaceRoot,
          }],
        }),
        stderr: '',
      };
    }
    return { status: 99, stdout: '', stderr: `unexpected child command: ${signature}` };
  };
  rollbackTransaction(childState.manifestPath, {
    runCodex: childRunCodex,
    reason: `real child hard-exit at ${childState.crashPoint}`,
    afterRestoreClaim(step) {
      if (childState.crashPoint === 'target-claim' && step === 'restore-plugin-target') {
        process.exit(91);
      }
    },
    afterRestorePublish(step) {
      if (
        childState.crashPoint === 'marketplace-publish'
        && step === 'restore-marketplace-file'
      ) {
        process.exit(91);
      }
    },
    afterRestoreComplete(step) {
      if (
        childState.crashPoint === 'marketplace-complete'
        && step === 'restore-marketplace-file'
      ) {
        process.exit(91);
      }
    },
  });
  process.exit(92);
}

function deadChildPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    windowsHide: true,
  });
  assert.strictEqual(child.status, 0);
  return child.pid;
}

function withFixture(test) {
  const fixture = createFixture();
  try {
    test(fixture);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function prepareAndActivate(fixture) {
  const prepared = prepareTransaction(fixture.options);
  activateSource(fixture.source, fixture.target);
  markActivated(prepared.manifestPath, { runCodex: fixture.runCodex });
  return prepared.manifestPath;
}

function completeInstallCheckpoints(fixture, manifestPath) {
  completeMarketplaceFileCheckpoint(fixture, manifestPath);

  fixture.state.marketplaces = new Map([['local-plugins', fixture.home]]);
  checkpointTransaction(manifestPath, 'marketplace', { runCodex: fixture.runCodex });

  activateSource(fixture.target, fixture.canonicalCache);
  fixture.state.owners = new Map([['tech-persistence@local-plugins', '1.0.5']]);
  checkpointTransaction(manifestPath, 'cache', { runCodex: fixture.runCodex });

  fixture.state.owners = new Map([['tech-persistence@local-plugins', '1.0.5']]);
  checkpointTransaction(manifestPath, 'doctor', { runCodex: fixture.runCodex });
}

function completeMarketplaceCheckpoints(fixture, manifestPath) {
  completeMarketplaceFileCheckpoint(fixture, manifestPath);
  fixture.state.marketplaces = new Map([['local-plugins', fixture.home]]);
  checkpointTransaction(manifestPath, 'marketplace', { runCodex: fixture.runCodex });
}

function completeMarketplaceFileCheckpoint(fixture, manifestPath) {
  updateMarketplaceFile({
    marketplacePath: fixture.marketplacePath,
    marketplaceName: 'local-plugins',
    marketplaceDisplayName: 'Local Plugins',
    manifestPath,
  });
  checkpointTransaction(manifestPath, 'marketplace-file', { runCodex: fixture.runCodex });
}

function mutatingCommandCount(fixture) {
  return fixture.state.commands.filter((args) => !args.includes('list')).length;
}

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  const before = JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8'));
  assert.strictEqual(before.state, 'prepared');
  assert.strictEqual(before.pre.pluginTarget.sha256.length, 64);
  assert.strictEqual(before.pre.marketplaceFile.sha256.length, 64);
  assert.strictEqual(
    Buffer.from(before.pre.marketplaceFile.rawBase64, 'base64').toString('utf8'),
    fixture.oldMarketplaceText
  );
  assert.ok(fs.existsSync(before.pre.pluginTarget.backup));
  assert.ok(fs.existsSync(before.pre.marketplaceFile.backup));
  assert.strictEqual(before.ownerPid, process.pid);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(before.lockPath, 'utf8')).pid,
    process.pid
  );

  activateSource(fixture.source, fixture.target);
  markActivated(prepared.manifestPath, { runCodex: fixture.runCodex });
  const activated = JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8'));
  assert.strictEqual(activated.state, 'activated');
  assert.strictEqual(activated.afterActivation.target.version, '1.0.5');
  assert.strictEqual(activated.afterActivation.target.sha256.length, 64);
  assert.strictEqual(activated.pre.cacheSnapshots.length, 2);
  assert.strictEqual(activated.pre.owners[0].cacheSha256.length, 64);
});

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  assert.throws(
    () => reconcileTransaction(prepared.manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'must not reconcile a live outer installer',
    }),
    new RegExp(`active Codex user install pid=${process.pid}`)
  );
  rollbackTransaction(prepared.manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'cleanup after live-owner lease test',
  });
});

withFixture((fixture) => {
  const outerInstaller = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', windowsHide: true }
  );
  assert.ok(Number.isSafeInteger(outerInstaller.pid) && outerInstaller.pid > 0);
  try {
    const prepared = prepareTransaction({ ...fixture.options, ownerPid: outerInstaller.pid });
    const lock = JSON.parse(fs.readFileSync(prepared.manifest.lockPath, 'utf8'));
    assert.strictEqual(lock.pid, outerInstaller.pid);
    assert.strictEqual(prepared.manifest.ownerPid, outerInstaller.pid);
    assert.throws(
      () => reconcileTransaction(prepared.manifestPath, {
        runCodex: fixture.runCodex,
        reason: 'must not reconcile a distinct live outer installer',
      }),
      new RegExp(`active Codex user install pid=${outerInstaller.pid}`)
    );
    rollbackTransaction(prepared.manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'cleanup distinct live outer installer test',
    });
  } finally {
    outerInstaller.kill();
  }
});

withFixture((fixture) => {
  assert.throws(
    () => prepareTransaction({ ...fixture.options, ownerPid: deadChildPid() }),
    /owner PID is not a live process/
  );
});

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  const beforeGate = activationGate(prepared.manifestPath, 'before-claim', {
    runCodex: fixture.runCodex,
  });
  assert.strictEqual(beforeGate.manifest.activationGates.at(-1).phase, 'before-claim');
  const claimedPath = `${fixture.target}.activation-claim`;
  fs.renameSync(fixture.target, claimedPath);
  const claimedGate = activationGate(prepared.manifestPath, 'claimed', {
    runCodex: fixture.runCodex,
    claimedPath,
  });
  assert.strictEqual(claimedGate.manifest.activationGates.at(-1).phase, 'claimed');
  assert.strictEqual(claimedGate.manifest.activationGates.at(-1).claimedPath, claimedPath);
  rollbackTransaction(prepared.manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'cleanup after activation gate success',
  });
  assert.strictEqual(readPluginVersion(fixture.target), '0.9.0');
});

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  write(
    path.join(fixture.target, 'codex-skills', 'sprint', 'SKILL.md'),
    '# external-before-claim\n'
  );
  assert.throws(
    () => activationGate(prepared.manifestPath, 'before-claim', {
      runCodex: fixture.runCodex,
    }),
    /before-claim target differs/
  );
  assert.strictEqual(
    fs.readFileSync(path.join(fixture.target, 'codex-skills', 'sprint', 'SKILL.md'), 'utf8'),
    '# external-before-claim\n'
  );
});

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  activationGate(prepared.manifestPath, 'before-claim', { runCodex: fixture.runCodex });
  const claimedPath = `${fixture.target}.activation-claim`;
  fs.renameSync(fixture.target, claimedPath);
  write(
    path.join(claimedPath, 'codex-skills', 'sprint', 'SKILL.md'),
    '# external-claimed-payload\n'
  );
  assert.throws(
    () => activationGate(prepared.manifestPath, 'claimed', {
      runCodex: fixture.runCodex,
      claimedPath,
    }),
    /claimed payload differs/
  );
  assert.ok(!fs.existsSync(fixture.target));
  assert.strictEqual(
    fs.readFileSync(path.join(claimedPath, 'codex-skills', 'sprint', 'SKILL.md'), 'utf8'),
    '# external-claimed-payload\n'
  );
});

for (const failureStep of ['target', 'marketplace-file']) {
  withFixture((fixture) => {
    const manifestPath = prepareAndActivate(fixture);
    if (failureStep === 'marketplace-file') completeMarketplaceFileCheckpoint(fixture, manifestPath);
    const result = rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: `injected ${failureStep} failure`,
    });
    assert.strictEqual(result.manifest.state, 'rolled-back', failureStep);
    assert.strictEqual(readPluginVersion(fixture.target), '0.9.0', failureStep);
    assert.strictEqual(fs.readFileSync(fixture.marketplacePath, 'utf8'), fixture.oldMarketplaceText, failureStep);
    assert.deepStrictEqual([...fixture.state.owners.entries()], [['tech-persistence@local-plugins', '0.9.0']], failureStep);
    assert.strictEqual(fixture.state.marketplaces.get('local-plugins'), fixture.oldMarketplaceRoot, failureStep);
    assert.strictEqual(readPluginVersion(fixture.oldCache), '0.9.0', failureStep);
    assert.strictEqual(
      fs.readFileSync(path.join(fixture.oldCache, 'codex-skills', 'sprint', 'SKILL.md'), 'utf8'),
      '# old\n',
      failureStep
    );
    assert.ok(!fs.existsSync(fixture.canonicalCache), failureStep);
    assert.ok(
      !fixture.state.commands.some((args) => args[0] === 'plugin' && ['add', 'remove'].includes(args[1])),
      `${failureStep}: rollback must never issue owner add/remove without CAS`
    );
    assert.ok(!fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')), failureStep);
  });
}

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceFileCheckpoint(fixture, manifestPath);
  const marketplaceAwareRunCodex = (args) => {
    if (fs.existsSync(fixture.marketplacePath)) return fixture.runCodex(args);
    fixture.state.commands.push([...args]);
    if (args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: JSON.stringify({ installed: [] }), stderr: '' };
    }
    if (args.join(' ') === 'plugin marketplace list --json') {
      return { status: 0, stdout: JSON.stringify({ marketplaces: [] }), stderr: '' };
    }
    return { status: 99, stdout: '', stderr: `unexpected command while marketplace is claimed: ${args.join(' ')}` };
  };
  const result = rollbackTransaction(manifestPath, {
    runCodex: marketplaceAwareRunCodex,
    reason: 'marketplace-backed owner temporarily disappears during atomic file restore',
  });
  assert.strictEqual(result.manifest.state, 'rolled-back');
  assert.strictEqual(readPluginVersion(fixture.target), '0.9.0');
  assert.strictEqual(fs.readFileSync(fixture.marketplacePath, 'utf8'), fixture.oldMarketplaceText);
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceFileCheckpoint(fixture, manifestPath);
  const marketplaceAwareRunCodex = (args) => {
    if (fs.existsSync(fixture.marketplacePath)) return fixture.runCodex(args);
    fixture.state.commands.push([...args]);
    if (args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: JSON.stringify({ installed: [] }), stderr: '' };
    }
    if (args.join(' ') === 'plugin marketplace list --json') {
      return { status: 0, stdout: JSON.stringify({ marketplaces: [] }), stderr: '' };
    }
    return { status: 99, stdout: '', stderr: `unexpected command while marketplace is claimed: ${args.join(' ')}` };
  };
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: marketplaceAwareRunCodex,
      reason: 'interrupt marketplace restore after its durable claim',
      afterRestoreClaim(step) {
        if (step === 'restore-marketplace-file') throw new Error('injected marketplace claim interruption');
      },
    }),
    /rollback failed closed/
  );
  const interrupted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(interrupted.rollbackPlan.operations[0].operation.status, 'complete');
  assert.strictEqual(interrupted.rollbackPlan.operations[1].operation.status, 'claimed');
  const abandonedPid = deadChildPid();
  const interruptedLock = JSON.parse(fs.readFileSync(interrupted.lockPath, 'utf8'));
  interrupted.ownerPid = abandonedPid;
  interruptedLock.pid = abandonedPid;
  fs.writeFileSync(manifestPath, `${JSON.stringify(interrupted, null, 2)}\n`);
  fs.writeFileSync(interrupted.lockPath, `${JSON.stringify(interruptedLock, null, 2)}\n`);
  const resumed = reconcileTransaction(manifestPath, {
    runCodex: marketplaceAwareRunCodex,
    reason: 'resume a later claimed operation after earlier operations completed',
  });
  assert.strictEqual(resumed.manifest.state, 'rolled-back');
  assert.strictEqual(fs.readFileSync(fixture.marketplacePath, 'utf8'), fixture.oldMarketplaceText);
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceCheckpoints(fixture, manifestPath);
  const beforeRollback = mutatingCommandCount(fixture);
  const recovery = rollbackTransaction(manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'marketplace registration changed before failure',
  });
  assert.strictEqual(recovery.disposition, 'recovery-required');
  assert.strictEqual(recovery.manifest.state, 'recovery-required');
  assert.match(recovery.manifest.recovery.instruction, /rerun/i);
  assert.strictEqual(mutatingCommandCount(fixture), beforeRollback);
  assert.strictEqual(readPluginVersion(fixture.target), '1.0.5');
  assert.strictEqual(fixture.state.marketplaces.get('local-plugins'), fixture.home);
  assert.ok(!fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
  const retry = prepareTransaction(fixture.options);
  assert.strictEqual(retry.manifest.state, 'prepared');
  const retryAbort = rollbackTransaction(retry.manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'prove recovery state permits an idempotent rerun',
  });
  assert.strictEqual(retryAbort.disposition, 'rolled-back');
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeInstallCheckpoints(fixture, manifestPath);
  const committed = commitTransaction(manifestPath, { runCodex: fixture.runCodex });
  assert.strictEqual(committed.manifest.state, 'committed');
  assert.strictEqual(committed.manifest.post.target.version, '1.0.5');
  assert.deepStrictEqual(
    committed.manifest.post.owners.map((owner) => owner.pluginId),
    ['tech-persistence@local-plugins']
  );
  assert.strictEqual(committed.manifest.post.caches.length, 2);
  assert.ok(!fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeInstallCheckpoints(fixture, manifestPath);
  const lockPath = path.join(fixture.evidenceRoot, 'active-user-install.json');
  const committed = commitTransaction(manifestPath, {
    runCodex: fixture.runCodex,
    unlinkLock() {
      throw new Error('injected lock unlink failure');
    },
  });
  assert.strictEqual(committed.manifest.state, 'committed');
  assert.strictEqual(committed.disposition, 'committed-lock-release-failed');
  assert.match(committed.manifest.lockReleaseError, /injected lock unlink failure/);
  assert.strictEqual(committed.manifest.terminalDisposition, committed.disposition);
  assert.ok(fs.existsSync(lockPath), 'failed lock release must retain the active lock');
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'must not rollback a committed transaction',
    }),
    /cannot roll back terminal transaction|state=committed/i
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  const rolledBack = rollbackTransaction(manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'injected pre-commit failure',
    unlinkLock() {
      throw new Error('injected rollback lock unlink failure');
    },
  });
  assert.strictEqual(rolledBack.manifest.state, 'rolled-back');
  assert.strictEqual(rolledBack.disposition, 'rolled-back-lock-release-failed');
  assert.match(rolledBack.manifest.lockReleaseError, /injected rollback lock unlink failure/);
  assert.ok(fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceCheckpoints(fixture, manifestPath);
  const recovery = rollbackTransaction(manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'injected irreversible failure',
    unlinkLock() {
      throw new Error('injected recovery lock unlink failure');
    },
  });
  assert.strictEqual(recovery.manifest.state, 'recovery-required');
  assert.strictEqual(recovery.disposition, 'recovery-required-lock-release-failed');
  assert.match(recovery.manifest.lockReleaseError, /injected recovery lock unlink failure/);
  assert.ok(fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
});

withFixture((fixture) => {
  const bomText = `\uFEFF${fixture.oldMarketplaceText}`;
  fs.writeFileSync(fixture.marketplacePath, bomText);
  fixture.oldMarketplaceText = bomText;
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceFileCheckpoint(fixture, manifestPath);
  assert.ok(
    fs.readFileSync(fixture.marketplacePath, 'utf8').startsWith('\uFEFF'),
    'transaction-bound marketplace update must retain a valid BOM'
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  const externalText = `${JSON.stringify({ external: 'manifest-final-gap' })}\n`;
  assert.throws(
    () => updateMarketplaceFile({
      marketplacePath: fixture.marketplacePath,
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
      manifestPath,
      testHooks: {
        beforePublish() {
          fs.writeFileSync(fixture.marketplacePath, externalText);
        },
      },
    }),
    /compare-and-swap|concurrent/i
  );
  assert.strictEqual(fs.readFileSync(fixture.marketplacePath, 'utf8'), externalText);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.state, 'activated');
});

for (const failureStep of ['cache', 'doctor']) {
  withFixture((fixture) => {
    const manifestPath = prepareAndActivate(fixture);
    completeInstallCheckpoints(fixture, manifestPath);
    const beforeRollback = mutatingCommandCount(fixture);
    const recovery = rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: `injected ${failureStep} failure`,
    });
    assert.strictEqual(recovery.disposition, 'recovery-required');
    const failed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(failed.state, 'recovery-required');
    assert.match(failed.recovery.reason, new RegExp(failureStep));
    assert.strictEqual(mutatingCommandCount(fixture), beforeRollback);
    assert.ok(!fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
    assert.strictEqual(readPluginVersion(fixture.target), '1.0.5');
    assert.strictEqual(readPluginVersion(fixture.canonicalCache), '1.0.5');
  });
}

withFixture((fixture) => {
  fixture.state.owners = new Map([['tech-persistence@legacy-marketplace', '0.9.0']]);
  assert.throws(
    () => prepareTransaction(fixture.options),
    /automatic owner cleanup is disabled.*no version\/source CAS/
  );
  assert.strictEqual(readPluginVersion(fixture.target), '0.9.0');
  assert.ok(!fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
});

withFixture((fixture) => {
  fixture.state.owners.set('tech-persistence@concurrent', '0.9.0');
  assert.throws(
    () => prepareTransaction(fixture.options),
    /automatic owner cleanup is disabled.*no version\/source CAS/
  );
  assert.strictEqual(readPluginVersion(fixture.target), '0.9.0');
});

withFixture((fixture) => {
  fixture.state.owners.set('tech-persistence@concurrent', '0.9.0');
  assert.throws(
    () => prepareTransaction({
      ...fixture.options,
      unlinkLock() {
        throw new Error('injected prepare lock unlink failure');
      },
    }),
    /automatic owner cleanup is disabled/
  );
  const transactionDirectory = fs.readdirSync(fixture.evidenceRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory());
  assert.ok(transactionDirectory);
  const failed = JSON.parse(fs.readFileSync(
    path.join(fixture.evidenceRoot, transactionDirectory.name, 'manifest.json'),
    'utf8'
  ));
  assert.strictEqual(failed.state, 'prepare-failed');
  assert.strictEqual(failed.terminalDisposition, 'prepare-failed-lock-release-failed');
  assert.match(failed.lockReleaseError, /injected prepare lock unlink failure/);
  assert.ok(fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
});

withFixture((fixture) => {
  assert.throws(
    () => prepareTransaction({
      ...fixture.options,
      canonicalOwner: 'tech-persistence@different-marketplace',
    }),
    /invalid canonical owner id/
  );
});

withFixture((fixture) => {
  let marketplaceProbeCount = 0;
  const concurrentRunCodex = (args) => {
    if (args.join(' ') === 'plugin marketplace list --json') {
      marketplaceProbeCount += 1;
      if (marketplaceProbeCount === 1) {
        write(
          path.join(fixture.target, 'codex-skills', 'sprint', 'SKILL.md'),
          '# concurrent-preparation-write\n'
        );
      }
    }
    return fixture.runCodex(args);
  };
  assert.throws(
    () => prepareTransaction({ ...fixture.options, runCodex: concurrentRunCodex }),
    /pre-install runtime changed while its verified snapshots were captured/
  );
  assert.strictEqual(
    fs.readFileSync(path.join(fixture.target, 'codex-skills', 'sprint', 'SKILL.md'), 'utf8'),
    '# concurrent-preparation-write\n'
  );
  assert.ok(!fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
});

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  const realManifest = `${prepared.manifestPath}.real`;
  fs.renameSync(prepared.manifestPath, realManifest);
  try {
    fs.symlinkSync(realManifest, prepared.manifestPath, 'file');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error && error.code)) throw error;
    fs.mkdirSync(prepared.manifestPath);
  }
  assert.throws(
    () => markActivated(prepared.manifestPath, { runCodex: fixture.runCodex }),
    /transaction manifest must be a plain file/
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.inputs.marketplaceRoot = path.join(fixture.root, 'tampered-marketplace-root');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'tampered canonical layout',
    }),
    /canonical user-home layout/
  );
  assert.strictEqual(readPluginVersion(fixture.target), '1.0.5');
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  let ownerProbeCount = 0;
  const failDuringPlanMaterialization = (args) => {
    if (args.join(' ') === 'plugin list --json') {
      ownerProbeCount += 1;
      if (ownerProbeCount === 2) {
        return { status: 37, stdout: '', stderr: 'injected plan-materialization probe failure' };
      }
    }
    return fixture.runCodex(args);
  };
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: failDuringPlanMaterialization,
      reason: 'persist a planning-phase rollback descriptor',
    }),
    /rollback failed closed/
  );
  const failed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(failed.rollbackPlan.phase, 'planning');
  assert.ok(failed.rollbackPlan.operations.length > 0);
  failed.rollbackPlan.operations[0].operation.stage = fixture.target;
  fs.writeFileSync(manifestPath, `${JSON.stringify(failed, null, 2)}\n`);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'reject a stage path outside the transaction namespace',
    }),
    /rollback failed closed.*restore operation is invalid/
  );
  assert.strictEqual(
    readPluginVersion(fixture.target),
    '1.0.5',
    'invalid durable stage paths must be rejected before moving the canonical target'
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  let ownerProbeCount = 0;
  const failDuringPlanMaterialization = (args) => {
    if (args.join(' ') === 'plugin list --json') {
      ownerProbeCount += 1;
      if (ownerProbeCount === 2) {
        return { status: 38, stdout: '', stderr: 'injected preserve-binding probe failure' };
      }
    }
    return fixture.runCodex(args);
  };
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: failDuringPlanMaterialization,
      reason: 'persist a preserve-path rollback descriptor',
    }),
    /rollback failed closed/
  );
  const failed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const operation = failed.rollbackPlan.operations[0].operation;
  operation.preserveRoot = path.join(failed.transactionRoot, 'rollback-preserved', 'other');
  operation.preserved = path.join(operation.preserveRoot, 'unbound-evidence');
  fs.writeFileSync(manifestPath, `${JSON.stringify(failed, null, 2)}\n`);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'reject a preserve path outside its bound rollback group',
    }),
    /rollback failed closed.*restore operation is invalid/
  );
  assert.strictEqual(
    readPluginVersion(fixture.target),
    '1.0.5',
    'invalid preserve paths must be rejected before moving the canonical target'
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceFileCheckpoint(fixture, manifestPath);
  const prepared = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.rmSync(prepared.pre.marketplaceFile.backup, { force: true });
  const mutatingCommandsBeforeRollback = mutatingCommandCount(fixture);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'verified snapshot disappeared',
    }),
    /rollback failed closed/
  );
  const failed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(failed.state, 'rollback-failed');
  assert.ok(failed.rollbackResults.some((result) => (
    result.step === 'preflight-restore-marketplace-file'
    && result.ok === false
    && /missing/.test(result.error)
  )));
  assert.ok(!failed.rollbackPlan, 'no canonical rollback plan may start with a missing snapshot');
  assert.strictEqual(
    mutatingCommandCount(fixture),
    mutatingCommandsBeforeRollback
  );
  assert.strictEqual(readPluginVersion(fixture.target), '1.0.5');
  assert.strictEqual(
    fs.readFileSync(fixture.marketplacePath, 'utf8'),
    canonicalMarketplace(fixture.oldMarketplaceText)
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  fs.writeFileSync(fixture.marketplacePath, canonicalMarketplace(fixture.oldMarketplaceText));
  checkpointTransaction(manifestPath, 'marketplace-file', { runCodex: fixture.runCodex });
  fixture.state.marketplaces = new Map([['local-plugins', fixture.home]]);
  checkpointTransaction(manifestPath, 'marketplace', { runCodex: fixture.runCodex });
  writePlugin(fixture.canonicalCache, '1.0.5', 'same-version-corruption');
  fixture.state.owners = new Map([['tech-persistence@local-plugins', '1.0.5']]);
  assert.throws(
    () => checkpointTransaction(manifestPath, 'cache', { runCodex: fixture.runCodex }),
    /cache checkpoint byte mismatch/
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceCheckpoints(fixture, manifestPath);
  fs.rmSync(fixture.oldCache, { recursive: true, force: true });
  activateSource(fixture.target, fixture.canonicalCache);
  fixture.state.owners = new Map([['tech-persistence@local-plugins', '1.0.5']]);
  checkpointTransaction(manifestPath, 'cache', { runCodex: fixture.runCodex });
  checkpointTransaction(manifestPath, 'doctor', { runCodex: fixture.runCodex });
  const committed = commitTransaction(manifestPath, { runCodex: fixture.runCodex });
  assert.strictEqual(committed.manifest.post.caches.length, 1);
  assert.strictEqual(committed.manifest.post.caches[0].version, '1.0.5');
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceCheckpoints(fixture, manifestPath);
  activateSource(fixture.target, fixture.canonicalCache);
  fixture.state.owners = new Map([['tech-persistence@local-plugins', '1.0.5']]);
  checkpointTransaction(manifestPath, 'cache', { runCodex: fixture.runCodex });
  fs.rmSync(fixture.oldCache, { recursive: true, force: true });
  assert.throws(
    () => checkpointTransaction(manifestPath, 'doctor', { runCodex: fixture.runCodex }),
    /doctor checkpoint changed plugin-cache inventory or bytes/
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeInstallCheckpoints(fixture, manifestPath);
  write(
    path.join(fixture.canonicalCache, 'codex-skills', 'sprint', 'SKILL.md'),
    '# corrupted after doctor checkpoint\n'
  );
  assert.throws(
    () => commitTransaction(manifestPath, { runCodex: fixture.runCodex }),
    /runtime\/cache bytes changed/
  );
  const beforeRollback = mutatingCommandCount(fixture);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'same-version cache content drift',
    }),
    /rollback ownership gate/
  );
  assert.strictEqual(mutatingCommandCount(fixture), beforeRollback);
  assert.strictEqual(readPluginVersion(fixture.target), '1.0.5');
  assert.match(
    fs.readFileSync(path.join(fixture.canonicalCache, 'codex-skills', 'sprint', 'SKILL.md'), 'utf8'),
    /corrupted/
  );
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeInstallCheckpoints(fixture, manifestPath);
  const concurrentCache = path.join(
    fixture.codexHome,
    'plugins',
    'cache',
    'concurrent',
    'tech-persistence',
    '1.0.5'
  );
  writePlugin(concurrentCache, '1.0.5', 'concurrent-owner');
  fixture.state.owners.set('tech-persistence@concurrent', '1.0.5');
  const beforeRollback = mutatingCommandCount(fixture);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'concurrent owner appeared',
    }),
    /rollback ownership gate/
  );
  assert.strictEqual(mutatingCommandCount(fixture), beforeRollback);
  assert.ok(fixture.state.owners.has('tech-persistence@concurrent'));
  assert.ok(fs.existsSync(concurrentCache));
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceFileCheckpoint(fixture, manifestPath);
  fixture.state.marketplaces.set('local-plugins', path.join(fixture.root, 'concurrent-marketplace'));
  const beforeRollback = mutatingCommandCount(fixture);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'concurrent marketplace registration changed',
    }),
    /rollback ownership gate/
  );
  assert.strictEqual(mutatingCommandCount(fixture), beforeRollback);
  assert.match(fixture.state.marketplaces.get('local-plugins'), /concurrent-marketplace/);
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceFileCheckpoint(fixture, manifestPath);
  const concurrentMarketplace = JSON.parse(fs.readFileSync(fixture.marketplacePath, 'utf8'));
  concurrentMarketplace.plugins.unshift({
    name: 'concurrent-plugin',
    source: { source: 'local', path: './plugins/concurrent-plugin' },
  });
  fs.writeFileSync(fixture.marketplacePath, `${JSON.stringify(concurrentMarketplace, null, 2)}\n`);
  const beforeRollback = mutatingCommandCount(fixture);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'concurrent marketplace file changed',
    }),
    /rollback ownership gate/
  );
  assert.strictEqual(mutatingCommandCount(fixture), beforeRollback);
  assert.match(fs.readFileSync(fixture.marketplacePath, 'utf8'), /concurrent-plugin/);
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeMarketplaceFileCheckpoint(fixture, manifestPath);
  const prepared = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const existingCacheSnapshot = prepared.pre.cacheSnapshots
    .map((entry) => entry.snapshot)
    .find((snapshot) => snapshot.existed);
  fs.rmSync(existingCacheSnapshot.backup, { recursive: true, force: true });
  const beforeRollback = mutatingCommandCount(fixture);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'verified cache snapshot disappeared',
    }),
    /rollback failed closed/
  );
  assert.strictEqual(mutatingCommandCount(fixture), beforeRollback);
  assert.strictEqual(readPluginVersion(fixture.target), '1.0.5');
  assert.strictEqual(readPluginVersion(fixture.oldCache), '0.9.0');
});

for (const crashPoint of [
  'target-claim',
  'marketplace-publish',
  'marketplace-complete',
]) {
  withFixture((fixture) => {
    const manifestPath = prepareAndActivate(fixture);
    if (crashPoint !== 'target-claim') {
      completeMarketplaceFileCheckpoint(fixture, manifestPath);
    }
    const child = spawnSync(
      process.execPath,
      [__filename, '--rollback-hard-exit-child'],
      {
        env: {
          ...process.env,
          CODEX_TX_CHILD_STATE: JSON.stringify({
            crashPoint,
            manifestPath,
            target: fixture.target,
            oldMarketplaceRoot: fixture.oldMarketplaceRoot,
          }),
        },
        encoding: 'utf8',
        windowsHide: true,
      }
    );
    assert.strictEqual(child.status, 91, `${crashPoint}: ${child.stderr}`);
    const interrupted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(interrupted.state, 'rolling-back', crashPoint);
    const lock = JSON.parse(fs.readFileSync(interrupted.lockPath, 'utf8'));
    assert.strictEqual(lock.pid, child.pid, crashPoint);
    const resumed = reconcileTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: `resume ${crashPoint}`,
    });
    assert.strictEqual(resumed.manifest.state, 'rolled-back', crashPoint);
    assert.strictEqual(readPluginVersion(fixture.target), '0.9.0', crashPoint);
    assert.strictEqual(
      fs.readFileSync(fixture.marketplacePath, 'utf8'),
      fixture.oldMarketplaceText,
      crashPoint
    );
  });
}

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  const manifest = JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8'));
  manifest.state = 'committed';
  fs.writeFileSync(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => prepareTransaction(fixture.options), /active Codex user install/);
  assert.ok(fs.existsSync(path.join(fixture.evidenceRoot, 'active-user-install.json')));
});

withFixture((fixture) => {
  const transactionId = `20260723123456789-${deadChildPid()}-deadbeef`;
  const transactionRoot = path.join(fixture.evidenceRoot, transactionId);
  const manifestPath = path.join(transactionRoot, 'manifest.json');
  const lockPath = path.join(fixture.evidenceRoot, 'active-user-install.json');
  fs.mkdirSync(transactionRoot, { recursive: true });
  const lock = {
    schemaVersion: 1,
    manifestPath,
    token: 'a'.repeat(32),
    pid: deadChildPid(),
    createdAt: new Date().toISOString(),
  };
  const lockRaw = `${JSON.stringify(lock, null, 2)}\n`;
  fs.writeFileSync(lockPath, lockRaw);
  const next = prepareTransaction(fixture.options);
  const abandoned = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(abandoned.state, 'prepare-abandoned');
  assert.strictEqual(
    Buffer.from(abandoned.abandonedLockRawBase64, 'base64').toString('utf8'),
    lockRaw
  );
  rollbackTransaction(next.manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'cleanup after missing-manifest recovery',
  });
});

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  const stale = JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8'));
  stale.state = 'preparing';
  stale.ownerPid = deadChildPid();
  fs.writeFileSync(prepared.manifestPath, `${JSON.stringify(stale, null, 2)}\n`);
  const lock = JSON.parse(fs.readFileSync(stale.lockPath, 'utf8'));
  lock.pid = stale.ownerPid;
  fs.writeFileSync(stale.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const next = prepareTransaction(fixture.options);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8')).state,
    'prepare-abandoned'
  );
  rollbackTransaction(next.manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'cleanup after stale preparing recovery',
  });
});

withFixture((fixture) => {
  const prepared = prepareTransaction(fixture.options);
  const manifest = JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(prepared.manifest.lockPath, 'utf8'));
  lock.pid = deadChildPid();
  manifest.ownerPid = lock.pid;
  fs.writeFileSync(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(prepared.manifest.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const result = reconcileTransaction(prepared.manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'dead prepared owner',
  });
  assert.strictEqual(result.manifest.state, 'rolled-back');
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(manifest.lockPath, 'utf8'));
  lock.pid = deadChildPid();
  manifest.ownerPid = lock.pid;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(manifest.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const result = reconcileTransaction(manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'dead activated owner',
  });
  assert.strictEqual(result.manifest.state, 'rolled-back');
  assert.strictEqual(readPluginVersion(fixture.target), '0.9.0');
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  assert.throws(
    () => rollbackTransaction(manifestPath, {
      runCodex: fixture.runCodex,
      reason: 'owner changes between claim and publish',
      afterRestoreClaim(step) {
        if (step === 'restore-plugin-target') {
          fixture.state.owners.set('tech-persistence@concurrent', '0.9.0');
        }
      },
    }),
    /failed closed/
  );
  const failed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(failed.state, 'rollback-failed');
  assert.ok(!fs.existsSync(fixture.target), 'publish must not run after control drift');
  fixture.state.owners.delete('tech-persistence@concurrent');
  const resumed = rollbackTransaction(manifestPath, {
    runCodex: fixture.runCodex,
    reason: 'external owner drift removed',
  });
  assert.strictEqual(resumed.manifest.state, 'rolled-back');
});

withFixture((fixture) => {
  const manifestPath = prepareAndActivate(fixture);
  completeInstallCheckpoints(fixture, manifestPath);
  const lockPath = path.join(fixture.evidenceRoot, 'active-user-install.json');
  const ownedRaw = fs.readFileSync(lockPath);
  const replacementRaw = Buffer.from(
    `${JSON.stringify({ replacement: true, token: 'b'.repeat(32) })}\n`
  );
  const committed = commitTransaction(manifestPath, {
    runCodex: fixture.runCodex,
    unlinkLock() {
      fs.writeFileSync(lockPath, replacementRaw);
      throw new Error('injected replacement lock during terminal release');
    },
  });
  assert.strictEqual(committed.manifest.state, 'committed');
  assert.strictEqual(committed.disposition, 'committed-lock-release-failed');
  assert.deepStrictEqual(
    fs.readFileSync(lockPath),
    replacementRaw,
    'terminal release must not delete a replacement lock'
  );
  const claims = fs.readdirSync(fixture.evidenceRoot)
    .filter((name) => name.startsWith('active-user-install.json.release-claim.'));
  assert.strictEqual(claims.length, 1);
  assert.deepStrictEqual(fs.readFileSync(path.join(fixture.evidenceRoot, claims[0])), ownedRaw);
  assert.throws(() => claimAndRemoveLock(lockPath, ownedRaw), /changed before atomic claim/);
  assert.deepStrictEqual(
    fs.readFileSync(lockPath),
    replacementRaw,
    'a second reclaimer must restore, not delete, replacement bytes'
  );
});

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lock-claim-'));
  try {
    const lockPath = path.join(root, 'active-user-install.json');
    const original = Buffer.from('original-lock');
    const replacement = Buffer.from('replacement-lock');
    fs.writeFileSync(lockPath, original);
    claimAndRemoveLock(lockPath, original, (claimPath) => {
      fs.writeFileSync(lockPath, replacement);
      fs.unlinkSync(claimPath);
    });
    assert.deepStrictEqual(fs.readFileSync(lockPath), replacement);
    assert.throws(() => claimAndRemoveLock(lockPath, original), /changed before atomic claim/);
    assert.deepStrictEqual(fs.readFileSync(lockPath), replacement);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('[OK] Codex user-install transaction rolls back pre-commit and records post-commit recovery');
