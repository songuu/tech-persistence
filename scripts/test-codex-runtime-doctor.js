#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MANAGED_SKILL_EXCLUSIONS_BEGIN,
  MANAGED_SKILL_EXCLUSIONS_END,
  analyzeRuntime,
  applyRepairPlan,
  buildRepairPlan,
  formatCliFailure,
  hashPath,
  inspectPluginOwnerIntegrity,
  jsonReplacer,
  normalizePluginOwners,
  runDoctor,
  writeFileAtomically,
} = require('./codex-runtime-doctor');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function copyDir(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-owner-doctor-'));
  const codexHome = path.join(root, 'home', '.codex');
  const projectRoot = path.join(root, 'project');
  const pluginRoot = path.join(root, 'home', 'plugins', 'tech-persistence');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  write(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'tech-persistence',
    version: '1.0.6',
    skills: './codex-skills/',
    hooks: './hooks/codex-hooks.json',
  }));
  write(path.join(pluginRoot, 'codex-skills', 'work', 'SKILL.md'), '---\nname: work\n---\ncodex canonical\n');
  write(path.join(pluginRoot, 'codex-skills', 'review', 'SKILL.md'), '---\nname: review\n---\ncodex canonical\n');
  write(path.join(pluginRoot, 'skills', 'work', 'SKILL.md'), '---\nname: work\n---\nlegacy canonical\n');
  write(path.join(pluginRoot, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nlegacy canonical\n');
  write(path.join(pluginRoot, 'hooks', 'observe.js'), 'console.log("observe");\n');
  write(path.join(pluginRoot, 'hooks', 'run-hook.js'), 'console.log("run");\n');
  const legacyHooks = {
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.js" observe.js pre',
        }],
      }],
    },
  };
  write(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify(legacyHooks, null, 2));
  write(path.join(pluginRoot, 'hooks', 'codex-hooks.json'), JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: 'startup',
        hooks: [{
          type: 'command',
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.js" inject-context-codex.js',
        }],
      }],
    },
  }, null, 2));

  const canonical = {
    pluginId: 'tech-persistence@local-plugins',
    name: 'tech-persistence',
    marketplaceName: 'local-plugins',
    version: '1.0.6',
    installed: true,
    enabled: true,
    source: { source: 'local', path: pluginRoot },
  };
  const fixture = { root, codexHome, projectRoot, pluginRoot, canonical };
  for (const marketplaceName of ['local-plugins', 'tech-persistence-local', 'old-marketplace']) {
    ensureOwnerCache(fixture, {
      ...canonical,
      pluginId: `tech-persistence@${marketplaceName}`,
      marketplaceName,
    });
  }
  return fixture;
}

function ensureOwnerCache(fixture, owner) {
  const cacheRoot = path.join(
    fixture.codexHome,
    'plugins',
    'cache',
    owner.marketplaceName,
    owner.name,
    owner.version
  );
  if (!fs.existsSync(cacheRoot)) copyDir(fixture.pluginRoot, cacheRoot);
  return cacheRoot;
}

function analyze(fixture, installed) {
  for (const owner of installed) ensureOwnerCache(fixture, owner);
  return analyzeRuntime({
    pluginList: { installed },
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    canonicalPluginId: fixture.canonical.pluginId,
  });
}

function pluginOwner(fixture, pluginId) {
  const marketplaceName = pluginId.split('@').slice(1).join('@');
  return {
    ...fixture.canonical,
    pluginId,
    marketplaceName,
  };
}

function pluginListFromIds(fixture, pluginIds) {
  return {
    installed: [...pluginIds].sort().map((pluginId) => pluginOwner(fixture, pluginId)),
  };
}

function pluginListFromOwners(owners) {
  return {
    installed: [...owners.values()].sort((left, right) =>
      left.pluginId.localeCompare(right.pluginId)),
  };
}

function assertOwnerMutationPreflightBlocked(plan) {
  let cliCalls = 0;
  let failure;
  try {
    applyRepairPlan(plan, {
      runCodex() {
        cliCalls += 1;
        throw new Error('owner CLI must not run after fail-closed preflight');
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.strictEqual(failure.code, 'CODEX_OWNER_MUTATION_REQUIRES_MANUAL');
  assert.match(failure.message, /automatic plugin owner add\/remove is disabled/i);
  assert.strictEqual(failure.manualRecovery.required, true);
  assert.strictEqual(failure.manualRecovery.automaticExecutionForbidden, true);
  assert.ok(failure.manualRecovery.proposedCommands.length > 0);
  assert.strictEqual(cliCalls, 0);
  assert.strictEqual(fs.existsSync(plan.backupRoot), false);
  return failure;
}

function verifiedRepair() {
  return { verified: true, verification: { healthy: true } };
}

test('normalizes only enabled installed tech-persistence plugins', () => {
  const fixture = createFixture();
  const owners = normalizePluginOwners({
    installed: [
      fixture.canonical,
      { ...fixture.canonical, pluginId: 'tech-persistence@disabled', enabled: false },
      { ...fixture.canonical, pluginId: 'other@local', name: 'other' },
    ],
  });
  assert.deepStrictEqual(owners.map((owner) => owner.pluginId), [fixture.canonical.pluginId]);
});

test('one plugin and no direct copies yields ownerCount one', () => {
  const fixture = createFixture();
  const report = analyze(fixture, [fixture.canonical]);
  assert.strictEqual(report.ownerCount, 1);
  assert.strictEqual(report.healthy, true);
  assert.deepStrictEqual(report.duplicateSkills, []);
  assert.deepStrictEqual(report.duplicateHooks, []);
});

test('owner integrity requires owner, source manifest, cache manifest, and cache bytes to agree', () => {
  const fixture = createFixture();
  const cacheRoot = ensureOwnerCache(fixture, fixture.canonical);
  const integrity = inspectPluginOwnerIntegrity(fixture.codexHome, fixture.canonical);
  assert.strictEqual(integrity.valid, true);
  assert.strictEqual(integrity.sourceVersion, '1.0.6');
  assert.strictEqual(integrity.cacheVersion, '1.0.6');
  assert.strictEqual(integrity.sourceHash, integrity.cacheHash);

  write(path.join(fixture.pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'tech-persistence',
    version: '1.0.7',
    skills: './codex-skills/',
    hooks: './hooks/codex-hooks.json',
  }));
  const stale = analyzeRuntime({
    pluginList: { installed: [fixture.canonical] },
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    canonicalPluginId: fixture.canonical.pluginId,
  });
  assert.strictEqual(stale.healthy, false);
  assert.ok(stale.analysisErrors.some((error) => /owner\.version=1\.0\.6 differs from source manifest version=1\.0\.7/.test(error)));
  assert.strictEqual(fs.existsSync(cacheRoot), true);
});

test('owner integrity rejects a cache whose bytes drift from the source', () => {
  const fixture = createFixture();
  const cacheRoot = ensureOwnerCache(fixture, fixture.canonical);
  write(path.join(cacheRoot, 'codex-skills', 'work', 'SKILL.md'), 'tampered cache\n');
  const report = analyzeRuntime({
    pluginList: { installed: [fixture.canonical] },
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    canonicalPluginId: fixture.canonical.pluginId,
  });
  assert.strictEqual(report.healthy, false);
  assert.ok(report.analysisErrors.some((error) => /cache content hash differs from source/.test(error)));
});

test('two enabled plugin registrations are duplicate owners', () => {
  const fixture = createFixture();
  const duplicate = {
    ...fixture.canonical,
    pluginId: 'tech-persistence@tech-persistence-local',
    marketplaceName: 'tech-persistence-local',
  };
  const report = analyze(fixture, [fixture.canonical, duplicate]);
  assert.strictEqual(report.ownerCount, 2);
  assert.strictEqual(report.healthy, false);
  assert.ok(report.duplicateSkills.includes('work'));
  assert.ok(report.duplicateHooks.some((id) => id.includes('SessionStart')));
});

test('project direct assets with standalone hooks remain active and block unsafe repair', () => {
  const fixture = createFixture();
  copyDir(path.join(fixture.pluginRoot, 'skills'), path.join(fixture.projectRoot, '.codex', 'skills'));
  copyDir(path.join(fixture.pluginRoot, 'hooks'), path.join(fixture.projectRoot, '.codex', 'tech-persistence-hooks'));
  fs.copyFileSync(
    path.join(fixture.pluginRoot, 'hooks', 'hooks.json'),
    path.join(fixture.projectRoot, '.codex', 'hooks.json')
  );
  const report = analyze(fixture, []);
  assert.strictEqual(report.ownerCount, 1);
  assert.strictEqual(report.directOwners.length, 1);
  assert.strictEqual(report.directOwners[0].scope, 'project');
  assert.strictEqual(report.healthy, false);
  assert.ok(report.standaloneDirectHookArtifacts.length > 0);
  assert.throws(() => buildRepairPlan(report), /standalone direct hooks/i);
});

test('exact user skill copy is managed stale state beside a plugin owner', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const report = analyze(fixture, [fixture.canonical]);
  assert.strictEqual(report.ownerCount, 2);
  assert.strictEqual(report.managedCopies.length, 1);
  assert.strictEqual(report.managedCopies[0].logicalType, 'skill');
  assert.strictEqual(report.divergedCopies.length, 0);
});

test('diverged direct skill is preserved and planned as a managed exclusion', () => {
  const fixture = createFixture();
  write(path.join(fixture.codexHome, 'skills', 'work', 'SKILL.md'), 'user customization\n');
  const report = analyze(fixture, [fixture.canonical]);
  assert.strictEqual(report.managedCopies.length, 0);
  assert.strictEqual(report.divergedCopies.length, 1);
  assert.strictEqual(report.divergedCopies[0].logicalName, 'work');
  const plan = buildRepairPlan(report, { backupRoot: path.join(fixture.root, 'backup') });
  assert.strictEqual(plan.moves.length, 0);
  assert.deepStrictEqual(plan.configUpdate.managedPaths, [
    path.join(fixture.codexHome, 'skills', 'work', 'SKILL.md'),
  ]);
});

test('matching direct hook config and directory are detected as managed duplicates', () => {
  const fixture = createFixture();
  const directRoot = path.join(fixture.projectRoot, '.codex');
  copyDir(path.join(fixture.pluginRoot, 'hooks'), path.join(directRoot, 'tech-persistence-hooks'));
  fs.copyFileSync(path.join(fixture.pluginRoot, 'hooks', 'hooks.json'), path.join(directRoot, 'hooks.json'));
  const report = analyze(fixture, [fixture.canonical]);
  assert.ok(report.directOwners[0].hooks.size > 0);
  assert.ok(report.managedCopies.some((copy) => copy.logicalType === 'hooks'));
  assert.strictEqual(report.divergedCopies.length, 0);
});

test('repair plan excludes direct skills and records manual owner removal', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const duplicate = {
    ...fixture.canonical,
    pluginId: 'tech-persistence@tech-persistence-local',
    marketplaceName: 'tech-persistence-local',
  };
  const report = analyze(fixture, [fixture.canonical, duplicate]);
  const plan = buildRepairPlan(report, { backupRoot: path.join(fixture.root, 'backup') });
  assert.strictEqual(plan.moves.length, 0);
  assert.deepStrictEqual(plan.configUpdate.managedPaths, [
    path.join(fixture.codexHome, 'skills', 'work', 'SKILL.md'),
  ]);
  assert.deepStrictEqual(plan.pluginRemovals, [duplicate.pluginId]);
  assert.strictEqual(plan.pluginAdd, null);
  assert.ok(plan.proposedOwnerCommands.every((command) => command[0] === 'plugin'));
  assert.ok(plan.proposedOwnerCommands.some((command) => command[1] === 'remove'));
  assert.ok(!JSON.stringify(plan).toLowerCase().includes('cache'));
});

test('repair execution writes manifest and config without moving direct skills', () => {
  const fixture = createFixture();
  const directSkill = path.join(fixture.codexHome, 'skills', 'work');
  copyDir(path.join(fixture.pluginRoot, 'skills', 'work'), directSkill);
  const report = analyze(fixture, [fixture.canonical]);
  const backupRoot = path.join(fixture.root, 'backup');
  const plan = buildRepairPlan(report, { backupRoot });
  const calls = [];
  const result = applyRepairPlan(plan, {
    runCodex(args) {
      calls.push(args);
      return { status: 0, stdout: '{}', stderr: '' };
    },
    verify: verifiedRepair,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fs.existsSync(directSkill), true);
  assert.strictEqual(fs.existsSync(result.manifestPath), true);
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.strictEqual(manifest.state, 'completed');
  assert.deepStrictEqual(manifest.moves, []);
  assert.ok(fs.readFileSync(path.join(fixture.codexHome, 'config.toml'), 'utf8')
    .includes(path.join(directSkill, 'SKILL.md').replace(/\\/g, '/')));
  assert.deepStrictEqual(calls, []);
});

test('direct skill content changes after analysis are preserved and still safely excluded', () => {
  const fixture = createFixture();
  const directSkill = path.join(fixture.codexHome, 'skills', 'work');
  copyDir(path.join(fixture.pluginRoot, 'skills', 'work'), directSkill);
  const report = analyze(fixture, [fixture.canonical]);
  const backupRoot = path.join(fixture.root, 'backup');
  const plan = buildRepairPlan(report, { backupRoot });
  write(path.join(directSkill, 'SKILL.md'), 'changed after analysis\n');
  const changedHash = hashPath(directSkill);
  applyRepairPlan(plan, {
    runCodex() { throw new Error('must not run'); },
    verify: verifiedRepair,
  });
  assert.strictEqual(fs.existsSync(directSkill), true);
  assert.strictEqual(hashPath(directSkill), changedHash);
  assert.strictEqual(fs.existsSync(backupRoot), true);
});

test('missing canonical plugin records a manual add proposal', () => {
  const fixture = createFixture();
  const report = analyze(fixture, []);
  const plan = buildRepairPlan(report, {
    backupRoot: path.join(fixture.root, 'backup'),
    installCanonical: true,
  });
  assert.strictEqual(plan.pluginAdd, fixture.canonical.pluginId);
  assert.deepStrictEqual(plan.proposedOwnerCommands, [
    ['plugin', 'add', fixture.canonical.pluginId, '--json'],
  ]);
});

test('zero-owner default and direct fallback remain unchanged without explicit owner intent', () => {
  const emptyFixture = createFixture();
  const emptyPlan = buildRepairPlan(analyze(emptyFixture, []), {
    backupRoot: path.join(emptyFixture.root, 'backup'),
  });
  assert.strictEqual(emptyPlan.pluginAdd, null);
  assert.deepStrictEqual(emptyPlan.proposedOwnerCommands, []);
  let emptyFailure;
  try { applyRepairPlan(emptyPlan); } catch (error) { emptyFailure = error; }
  assert.strictEqual(emptyFailure.code, 'CODEX_REPAIR_REQUIRES_MANUAL');
  assert.strictEqual(fs.existsSync(emptyPlan.backupRoot), false);

  const fallbackFixture = createFixture();
  const fallbackSkill = path.join(
    fallbackFixture.projectRoot, '.codex', 'skills', 'work'
  );
  copyDir(path.join(fallbackFixture.pluginRoot, 'skills', 'work'), fallbackSkill);
  const fallbackReport = analyze(fallbackFixture, []);
  assert.strictEqual(fallbackReport.pluginOwners.length, 0);
  assert.strictEqual(fallbackReport.directOwners.length, 1);
  const fallbackPlan = buildRepairPlan(fallbackReport, {
    backupRoot: path.join(fallbackFixture.root, 'backup'),
  });
  assert.strictEqual(fallbackPlan.configUpdate, null);
  assert.deepStrictEqual(fallbackPlan.proposedOwnerCommands, []);
  const fallbackHash = hashPath(fallbackSkill);
  let fallbackFailure;
  try { applyRepairPlan(fallbackPlan); } catch (error) { fallbackFailure = error; }
  assert.strictEqual(fallbackFailure.code, 'CODEX_REPAIR_REQUIRES_MANUAL');
  assert.strictEqual(hashPath(fallbackSkill), fallbackHash);
  assert.strictEqual(fs.existsSync(path.join(fallbackFixture.codexHome, 'config.toml')), false);
  assert.strictEqual(fs.existsSync(fallbackPlan.backupRoot), false);
});

test('config repair requires a verifier before backup or mutation', () => {
  const fixture = createFixture();
  const directSkill = path.join(fixture.codexHome, 'skills', 'work');
  copyDir(path.join(fixture.pluginRoot, 'skills', 'work'), directSkill);
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "gpt-5.6"\n';
  write(configPath, originalConfig);
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), {
    backupRoot: path.join(fixture.root, 'backup'),
  });
  let failure;
  try { applyRepairPlan(plan); } catch (error) { failure = error; }
  assert.strictEqual(failure.code, 'CODEX_REPAIR_VERIFIER_REQUIRED');
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
  assert.strictEqual(fs.existsSync(plan.backupRoot), false);
});

test('doctor defaults to dry-run and does not mutate fixture files', () => {
  const fixture = createFixture();
  const directSkill = path.join(fixture.codexHome, 'skills', 'work');
  copyDir(path.join(fixture.pluginRoot, 'skills', 'work'), directSkill);
  let codexCalls = 0;
  const result = runDoctor({
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    canonicalPluginId: fixture.canonical.pluginId,
    readPluginList() { return { installed: [fixture.canonical] }; },
    runCodex() { codexCalls += 1; throw new Error('dry-run must not call mutations'); },
  });
  assert.strictEqual(result.mode, 'dry-run');
  assert.strictEqual(fs.existsSync(directSkill), true);
  assert.strictEqual(codexCalls, 0);
});

test('canonical and legacy skill hashes are accepted but owner manifests cannot authorize drift', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'codex-skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'review'),
    path.join(fixture.projectRoot, '.codex', 'skills', 'review')
  );
  let report = analyze(fixture, [fixture.canonical]);
  assert.strictEqual(report.managedCopies.filter((copy) => copy.logicalType === 'skill').length, 2);
  assert.strictEqual(report.divergedCopies.length, 0);

  write(path.join(fixture.codexHome, 'skills', 'work', 'SKILL.md'), 'locally diverged\n');
  write(path.join(fixture.codexHome, 'tech-persistence-owner.json'), JSON.stringify({
    schemaVersion: 1,
    owner: 'tech-persistence',
    managed: [{
      path: 'skills/work',
      sha256: hashPath(path.join(fixture.codexHome, 'skills', 'work')),
    }],
  }));
  report = analyze(fixture, [fixture.canonical]);
  assert.ok(report.divergedCopies.some((copy) => copy.path.endsWith(path.join('skills', 'work'))));
  const plan = buildRepairPlan(report);
  assert.strictEqual(plan.moves.length, 0);
  assert.ok(plan.configUpdate.managedPaths.some((skillPath) => skillPath.endsWith(path.join('skills', 'work', 'SKILL.md'))));
});

test('unexcluded shared user and project skills make dry-run unhealthy without becoming move candidates', () => {
  const fixture = createFixture();
  const userSkill = path.join(path.dirname(fixture.codexHome), '.agents', 'skills', 'work', 'SKILL.md');
  const projectSkill = path.join(fixture.projectRoot, '.agents', 'skills', 'review', 'SKILL.md');
  write(userSkill, 'shared user work\n');
  write(projectSkill, 'shared project review\n');
  const report = analyze(fixture, [fixture.canonical]);
  assert.strictEqual(report.healthy, false);
  assert.strictEqual(report.sharedSkillConflicts.length, 2);
  assert.strictEqual(report.unmanagedSharedSkillConflicts.length, 2);
  assert.ok(report.duplicateSkills.includes('work'));
  assert.ok(report.duplicateSkills.includes('review'));
  assert.ok(report.managedCopies.every((copy) => !copy.path.includes(`${path.sep}.agents${path.sep}`)));
  const plan = buildRepairPlan(report, { backupRoot: path.join(fixture.root, 'backup') });
  assert.strictEqual(plan.moves.length, 0);
  assert.deepStrictEqual(plan.configUpdate.managedPaths, [projectSkill, userSkill].sort((left, right) => {
    const normalizedLeft = left.replace(/\\/g, '/').toLowerCase();
    const normalizedRight = right.replace(/\\/g, '/').toLowerCase();
    return normalizedLeft.localeCompare(normalizedRight);
  }));
});

test('fix backs up config, preserves bytes outside markers, and never mutates shared skills', () => {
  const fixture = createFixture();
  const sharedSkill = path.join(path.dirname(fixture.codexHome), '.agents', 'skills', 'work', 'SKILL.md');
  write(sharedSkill, 'shared custom work\n');
  const sharedHash = hashPath(sharedSkill);
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "gpt-5.6"\r\n# user-owned bytes\r\n';
  write(configPath, originalConfig);
  if (process.platform !== 'win32') fs.chmodSync(configPath, 0o640);
  const backupRoot = path.join(fixture.root, 'backup');
  const result = runDoctor({
    fix: true,
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    backupRoot,
    canonicalPluginId: fixture.canonical.pluginId,
    readPluginList() { return { installed: [fixture.canonical] }; },
    runCodex() { throw new Error('no plugin command expected'); },
  });
  const updatedConfig = fs.readFileSync(configPath, 'utf8');
  assert.ok(updatedConfig.startsWith(originalConfig));
  assert.ok(updatedConfig.includes(MANAGED_SKILL_EXCLUSIONS_BEGIN));
  assert.ok(updatedConfig.includes(MANAGED_SKILL_EXCLUSIONS_END));
  assert.ok(updatedConfig.includes(sharedSkill.replace(/\\/g, '/')));
  assert.strictEqual(hashPath(sharedSkill), sharedHash);
  assert.strictEqual(result.finalReport.healthy, true);
  assert.strictEqual(result.verification.canonicalPluginOwners.length, 1);
  assert.deepStrictEqual(result.verification.directOwners, []);
  assert.deepStrictEqual(result.verification.unmanagedSharedSkillConflicts, []);
  const manifest = JSON.parse(fs.readFileSync(result.repair.manifestPath, 'utf8'));
  assert.strictEqual(manifest.configBackup.sha256, hashPath(path.join(backupRoot, 'codex-config', 'config.toml')));
  assert.strictEqual(fs.readFileSync(manifest.configBackup.backup, 'utf8'), originalConfig);
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o640);
    assert.strictEqual(manifest.configBackup.posixMode, 0o640);
  } else {
    assert.strictEqual(manifest.configBackup.posixMode, null);
  }
});

test('new config is created with POSIX mode 0600', () => {
  const fixture = createFixture();
  const directSkill = path.join(fixture.codexHome, 'skills', 'work');
  copyDir(path.join(fixture.pluginRoot, 'skills', 'work'), directSkill);
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), {
    backupRoot: path.join(fixture.root, 'backup'),
  });
  applyRepairPlan(plan, {
    runCodex() { throw new Error('no plugin command expected'); },
    verify: verifiedRepair,
  });
  const configPath = path.join(fixture.codexHome, 'config.toml');
  assert.strictEqual(fs.existsSync(configPath), true);
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600);
  }
});

test('no-replace claim CAS preserves a concurrent write injected immediately before claim rename', () => {
  const fixture = createFixture();
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "original"\n';
  const concurrentConfig = 'model = "concurrent-before-claim"\n';
  write(configPath, originalConfig);
  let injected = false;
  let failure;
  try {
    writeFileAtomically(configPath, 'model = "doctor"\n', {
      expectedExisted: true,
      expectedSha256: hashPath(configPath),
      context: 'deterministic pre-claim test',
      beforeClaim() {
        injected = true;
        write(configPath, concurrentConfig);
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.strictEqual(injected, true);
  assert.ok(failure);
  assert.strictEqual(failure.code, 'CODEX_CONFIG_CAS_CONFLICT');
  assert.match(failure.message, /CAS claim captured hash/i);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), concurrentConfig);
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(configPath)).filter((name) =>
      name.includes('tech-persistence-claim') || name.includes('tech-persistence-staged')),
    []
  );
});

test('no-replace publish preserves both a concurrent target and the claimed original', () => {
  const fixture = createFixture();
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "original"\n';
  const concurrentConfig = 'model = "concurrent-after-claim"\n';
  write(configPath, originalConfig);
  let failure;
  try {
    writeFileAtomically(configPath, 'model = "doctor"\n', {
      expectedExisted: true,
      expectedSha256: hashPath(configPath),
      context: 'deterministic publish-race test',
      beforePublish() {
        write(configPath, concurrentConfig);
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.strictEqual(failure.code, 'CODEX_CONFIG_CAS_CONFLICT');
  assert.match(failure.message, /no-replace publish failed/i);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), concurrentConfig);
  assert.strictEqual(failure.recoveryPaths.length, 1);
  assert.strictEqual(fs.readFileSync(failure.recoveryPaths[0], 'utf8'), originalConfig);
  assert.strictEqual(fs.lstatSync(failure.recoveryPaths[0]).isFile(), true);
});

test('no-replace creation preserves a concurrent config when the original target was absent', () => {
  const fixture = createFixture();
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const concurrentConfig = 'model = "concurrent-create"\n';
  let failure;
  try {
    writeFileAtomically(configPath, 'model = "doctor"\n', {
      expectedExisted: false,
      expectedSha256: null,
      context: 'deterministic absent-target race test',
      beforePublish() {
        write(configPath, concurrentConfig);
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.strictEqual(failure.code, 'CODEX_CONFIG_CAS_CONFLICT');
  assert.match(failure.message, /no-replace publish failed/i);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), concurrentConfig);
  assert.deepStrictEqual(failure.recoveryPaths, []);
});

test('owner mutations are blocked before config, backup, or CLI changes', () => {
  const fixture = createFixture();
  const duplicateId = 'tech-persistence@old-marketplace';
  const duplicate = pluginOwner(fixture, duplicateId);
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "gpt-5.6"\n';
  write(configPath, originalConfig);
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical, duplicate]), {
    backupRoot: path.join(fixture.root, 'backup'),
  });

  const failure = assertOwnerMutationPreflightBlocked(plan);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
  assert.deepStrictEqual(failure.manualRecovery.proposedCommands, [
    ['codex', 'plugin', 'remove', duplicateId, '--json'],
  ]);
  assert.deepStrictEqual(
    failure.manualRecovery.originalOwners.map((owner) => owner.pluginId).sort(),
    [duplicateId, fixture.canonical.pluginId].sort()
  );
  const textFailure = formatCliFailure(failure, false);
  assert.match(textFailure, /CODEX_OWNER_MUTATION_REQUIRES_MANUAL/);
  assert.ok(textFailure.includes(`codex","plugin","remove","${duplicateId}"`));
  assert.ok(textFailure.includes(failure.manualRecovery.originalOwners[0].fingerprint));
  const jsonFailure = JSON.parse(formatCliFailure(failure, true));
  assert.deepStrictEqual(jsonFailure.manualRecovery, failure.manualRecovery);
});

test('owner mutation guidance takes precedence over a pre-existing backup root', () => {
  const fixture = createFixture();
  const duplicateId = 'tech-persistence@old-marketplace';
  const duplicate = pluginOwner(fixture, duplicateId);
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "gpt-5.6"\n';
  const backupRoot = path.join(fixture.root, 'backup');
  const backupSentinel = path.join(backupRoot, 'preserve.txt');
  write(configPath, originalConfig);
  write(backupSentinel, 'do-not-touch\n');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical, duplicate]), {
    backupRoot,
  });
  let cliCalls = 0;
  let failure;
  try {
    applyRepairPlan(plan, {
      runCodex() {
        cliCalls += 1;
        throw new Error('CLI must not run');
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.strictEqual(failure.code, 'CODEX_OWNER_MUTATION_REQUIRES_MANUAL');
  assert.deepStrictEqual(failure.manualRecovery.proposedCommands, [
    ['codex', 'plugin', 'remove', duplicateId, '--json'],
  ]);
  assert.strictEqual(cliCalls, 0);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
  assert.strictEqual(fs.readFileSync(backupSentinel, 'utf8'), 'do-not-touch\n');
  assert.deepStrictEqual(fs.readdirSync(backupRoot), ['preserve.txt']);
});

test('missing canonical owner requires explicit manual actions before any write', () => {
  const fixture = createFixture();
  const oldId = 'tech-persistence@old-marketplace';
  const oldOwner = pluginOwner(fixture, oldId);
  const plan = buildRepairPlan(analyze(fixture, [oldOwner]), {
    backupRoot: path.join(fixture.root, 'backup'),
    installCanonical: true,
  });

  const failure = assertOwnerMutationPreflightBlocked(plan);
  assert.deepStrictEqual(failure.manualRecovery.proposedCommands, [
    ['codex', 'plugin', 'remove', oldId, '--json'],
    ['codex', 'plugin', 'add', fixture.canonical.pluginId, '--json'],
  ]);
});

test('tampered original owner fingerprint is rejected before CLI or backup mutation', () => {
  const fixture = createFixture();
  const duplicate = pluginOwner(fixture, 'tech-persistence@old-marketplace');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical, duplicate]), {
    backupRoot: path.join(fixture.root, 'backup'),
  });
  plan.pluginStateBefore[0].fingerprint = '0'.repeat(64);
  let cliCalls = 0;

  assert.throws(() => applyRepairPlan(plan, {
    runCodex() {
      cliCalls += 1;
      throw new Error('must not run');
    },
  }), /invalid original owner fingerprint/i);
  assert.strictEqual(cliCalls, 0);
  assert.strictEqual(fs.existsSync(plan.backupRoot), false);
});

test('caller cannot inject an owner command after the immutable plan snapshot', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const configPath = path.join(fixture.codexHome, 'config.toml');
  write(configPath, 'model = "gpt-5.6"\n');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), {
    backupRoot: path.join(fixture.root, 'backup'),
  });
  assert.deepStrictEqual(plan.proposedOwnerCommands, []);
  let cliCalls = 0;

  const result = applyRepairPlan(plan, {
    beforeBackupClaim() {
      plan.proposedOwnerCommands.push(['plugin', 'remove', fixture.canonical.pluginId, '--json']);
    },
    runCodex() {
      cliCalls += 1;
      throw new Error('owner CLI must not run');
    },
    verify() {
      return { verified: true, verification: { healthy: true } };
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(cliCalls, 0);
  assert.ok(fs.readFileSync(configPath, 'utf8').includes(MANAGED_SKILL_EXCLUSIONS_BEGIN));
});

test('config rollback CAS preserves a concurrent config change and exposes evidence', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const configPath = path.join(fixture.codexHome, 'config.toml');
  write(configPath, 'model = "gpt-5.6"\n');
  const concurrentConfig = 'model = "gpt-5.6"\nconcurrent_change = true\n';
  const backupRoot = path.join(fixture.root, 'backup');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), { backupRoot });
  let failure;
  try {
    applyRepairPlan(plan, {
      runCodex(args) {
        assert.deepStrictEqual(args, ['plugin', 'list', '--json']);
        return {
          status: 0,
          stdout: JSON.stringify({ installed: [fixture.canonical] }),
          stderr: '',
        };
      },
      verify() {
        write(configPath, concurrentConfig);
        throw new Error('injected verification failure after concurrent config edit');
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.strictEqual(failure.rollbackFailed, true);
  assert.strictEqual(failure.rollbackRecoveryFailed, true);
  assert.strictEqual(failure.evidencePath, path.join(backupRoot, 'manifest.json'));
  assert.match(failure.message, /config rollback CAS failed.*recovery evidence:/i);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), concurrentConfig);
  const manifest = JSON.parse(fs.readFileSync(failure.evidencePath, 'utf8'));
  assert.strictEqual(manifest.state, 'rollback-failed');
  const configRollback = manifest.rollbackResults.find((entry) => entry.step === 'restore-config');
  assert.strictEqual(configRollback.ok, false);
  assert.match(configRollback.error, /CAS failed.*current hash/i);
  assert.ok(manifest.rollbackResults.some((entry) =>
    entry.step === 'verify-original-plugin-owner-fingerprints' && entry.ok));
});
test('exclusive backup-root claim rejects a preflight race to a junction without writing through it', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const backupRoot = path.join(fixture.root, 'backup');
  const externalRoot = path.join(fixture.root, 'external-backup-target');
  write(path.join(externalRoot, 'sentinel.txt'), 'external-content\n');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), { backupRoot });
  let linkCreated = false;

  assert.throws(() => applyRepairPlan(plan, {
    beforeBackupClaim() {
      try {
        fs.symlinkSync(externalRoot, backupRoot, process.platform === 'win32' ? 'junction' : 'dir');
        linkCreated = true;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
        fs.mkdirSync(backupRoot, { recursive: false });
      }
    },
    runCodex() { throw new Error('backup claim must fail before runtime commands'); },
    verify: verifiedRepair,
  }), linkCreated ? /backup root exclusive claim failed/i : /backup root exclusive claim failed|backup root claim validation failed/i);

  if (linkCreated) assert.strictEqual(fs.lstatSync(backupRoot).isSymbolicLink(), true);
  assert.strictEqual(fs.readFileSync(path.join(externalRoot, 'sentinel.txt'), 'utf8'), 'external-content\n');
  assert.strictEqual(fs.existsSync(path.join(externalRoot, 'manifest.json')), false);
});

test('claimed backup root rejects a linked config-backup child without writing through it', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "gpt-5.6"\n';
  write(configPath, originalConfig);
  const backupRoot = path.join(fixture.root, 'backup');
  const externalRoot = path.join(fixture.root, 'external-config-backup');
  fs.mkdirSync(externalRoot, { recursive: true });
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), { backupRoot });
  let linkCreated = false;
  let injected = false;

  assert.throws(() => applyRepairPlan(plan, {
    manifestWriteHook({ phase }) {
      if (phase !== 'prepared' || injected) return;
      injected = true;
      try {
        fs.symlinkSync(
          externalRoot,
          path.join(backupRoot, 'codex-config'),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
        linkCreated = true;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
        fs.mkdirSync(path.join(backupRoot, 'codex-config'), { recursive: false });
      }
    },
    runCodex(args) {
      if (args[1] === 'list') {
        return { status: 0, stdout: JSON.stringify({ installed: [fixture.canonical] }), stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
    verify: verifiedRepair,
  }), linkCreated ? /backup subdirectory already exists before claim.*compensating rollback completed/i : /compensating rollback completed/i);

  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
  assert.strictEqual(fs.existsSync(path.join(externalRoot, 'config.toml')), false);
  if (linkCreated) assert.strictEqual(fs.lstatSync(path.join(backupRoot, 'codex-config')).isSymbolicLink(), true);
});

test('manifest I/O failures are journaled but cannot stop config and owner compensation', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "gpt-5.6"\n';
  write(configPath, originalConfig);
  const backupRoot = path.join(fixture.root, 'backup');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), { backupRoot });
  let failure;
  try {
    applyRepairPlan(plan, {
      manifestWriteHook({ phase }) {
        if (phase === 'config-updated' || phase.startsWith('rollback-')) {
          throw new Error(`injected journal failure at ${phase}`);
        }
      },
      runCodex(args) {
        if (args[1] === 'list') {
          return { status: 0, stdout: JSON.stringify({ installed: [fixture.canonical] }), stderr: '' };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      verify: verifiedRepair,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.strictEqual(failure.rollbackRecoveryFailed, false);
  assert.strictEqual(failure.rollbackJournalFailed, true);
  assert.strictEqual(failure.rollbackFailed, true);
  assert.match(failure.message, /recovery=completed.*journal=.*injected journal failure/i);
  assert.ok(failure.rollbackJournalErrors.some((error) => error.includes('rollback-restore-config')));
  assert.ok(failure.rollbackJournalErrors.some((error) => error.includes('rollback-verify-original-plugin-owner-fingerprints')));
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
  assert.strictEqual(fs.existsSync(path.join(backupRoot, 'manifest.json')), true);
});

test('missing recovery manifest is never reported as a persisted evidence path', () => {
  const fixture = createFixture();
  copyDir(
    path.join(fixture.pluginRoot, 'skills', 'work'),
    path.join(fixture.codexHome, 'skills', 'work')
  );
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "gpt-5.6"\n';
  write(configPath, originalConfig);
  const backupRoot = path.join(fixture.root, 'backup');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), { backupRoot });
  let failure;
  try {
    applyRepairPlan(plan, {
      manifestWriteHook({ phase }) {
        throw new Error(`injected manifest persistence failure at ${phase}`);
      },
      runCodex(args) {
        assert.deepStrictEqual(args, ['plugin', 'list', '--json']);
        return {
          status: 0,
          stdout: JSON.stringify({ installed: [fixture.canonical] }),
          stderr: '',
        };
      },
      verify: verifiedRepair,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.strictEqual(failure.evidencePath, null);
  assert.strictEqual(failure.manifestPath, path.join(backupRoot, 'manifest.json'));
  assert.match(failure.evidencePersistenceError, /could not be persisted/i);
  assert.match(failure.message, /recovery evidence unavailable/i);
  assert.doesNotMatch(failure.message,
    new RegExp(`recovery evidence: ${failure.manifestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.strictEqual(failure.recoveryState.state, 'rollback-failed');
  assert.ok(failure.recoveryState.rollbackJournalErrors.some((entry) =>
    entry.includes('prepared: injected manifest persistence failure')));
  assert.strictEqual(fs.existsSync(failure.manifestPath), false);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig);
  const output = formatCliFailure(failure, false);
  assert.match(output, /recoveryState=/);
  assert.doesNotMatch(output, / evidence=C:/i);
});

test('preflight rejects a config.toml symbolic link without replacing its target', () => {
  const fixture = createFixture();
  const directSkill = path.join(fixture.codexHome, 'skills', 'work');
  copyDir(path.join(fixture.pluginRoot, 'skills', 'work'), directSkill);
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const linkTarget = path.join(fixture.root, 'external-config.toml');
  const originalTarget = 'model = "external"\n';
  write(linkTarget, originalTarget);
  try {
    fs.symlinkSync(linkTarget, configPath, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      const source = fs.readFileSync(require.resolve('./codex-runtime-doctor'), 'utf8');
      assert.match(source, /lstatSync\(target\)/);
      assert.match(source, /isSymbolicLink\(\)/);
      assert.match(source, /symbolic link, junction, or reparse point/);
      return;
    }
    throw error;
  }
  const backupRoot = path.join(fixture.root, 'backup');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), { backupRoot });

  assert.throws(() => applyRepairPlan(plan, {
    runCodex() { throw new Error('preflight must reject before commands'); },
  }), /preflight failed.*config\.toml.*(?:symbolic link|junction|reparse)/i);
  assert.strictEqual(fs.lstatSync(configPath).isSymbolicLink(), true);
  assert.strictEqual(fs.readFileSync(linkTarget, 'utf8'), originalTarget);
  assert.strictEqual(fs.existsSync(backupRoot), false);
});

test('managed exclusion fix is idempotent and uses the complete absolute SKILL.md path', () => {
  const fixture = createFixture();
  const sharedSkill = path.join(fixture.projectRoot, '.agents', 'skills', 'review', 'SKILL.md');
  write(sharedSkill, 'shared review\n');
  const common = {
    fix: true,
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    canonicalPluginId: fixture.canonical.pluginId,
    readPluginList() { return { installed: [fixture.canonical] }; },
    runCodex() { throw new Error('no plugin command expected'); },
  };
  runDoctor({ ...common, backupRoot: path.join(fixture.root, 'first-backup') });
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const firstHash = hashPath(configPath);
  const secondBackup = path.join(fixture.root, 'second-backup');
  const second = runDoctor({ ...common, backupRoot: secondBackup });
  assert.strictEqual(second.repair.noop, true);
  assert.strictEqual(second.repair.manifestPath, null);
  assert.strictEqual(hashPath(configPath), firstHash);
  assert.strictEqual(fs.existsSync(secondBackup), false);
  const config = fs.readFileSync(configPath, 'utf8');
  assert.ok(config.includes(`path = ${JSON.stringify(sharedSkill.replace(/\\/g, '/'))}`));
  assert.ok(!config.includes(`path = ${JSON.stringify(path.dirname(sharedSkill).replace(/\\/g, '/'))}\n`));
  assert.strictEqual((config.match(/BEGIN tech-persistence managed Codex skill exclusions/g) || []).length, 1);
});

test('final repair preserves exact and diverged direct skills, excludes nested hooks, and is idempotent', () => {
  const fixture = createFixture();
  const userSkillRoot = path.join(fixture.codexHome, 'skills', 'work');
  const projectSkillRoot = path.join(fixture.projectRoot, '.codex', 'skills', 'review');
  copyDir(path.join(fixture.pluginRoot, 'skills', 'work'), userSkillRoot);
  write(path.join(projectSkillRoot, 'SKILL.md'), 'project-owned diverged review\n');
  copyDir(path.join(fixture.pluginRoot, 'hooks'), path.join(projectSkillRoot, 'hooks'));
  const userHash = hashPath(userSkillRoot);
  const projectHash = hashPath(projectSkillRoot);
  const common = {
    fix: true,
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    canonicalPluginId: fixture.canonical.pluginId,
    readPluginList() { return { installed: [fixture.canonical] }; },
    runCodex() { throw new Error('no plugin command expected'); },
  };
  const first = runDoctor({ ...common, backupRoot: path.join(fixture.root, 'first-backup') });
  assert.strictEqual(hashPath(userSkillRoot), userHash);
  assert.strictEqual(hashPath(projectSkillRoot), projectHash);
  assert.strictEqual(first.finalReport.healthy, true);
  assert.strictEqual(first.finalReport.ownerCount, 1);
  assert.deepStrictEqual(first.finalReport.directOwners, []);
  assert.strictEqual(first.finalReport.directSkillConflicts.length, 2);
  assert.ok(first.finalReport.directSkillConflicts.every((conflict) => conflict.managedExcluded));
  assert.deepStrictEqual(first.finalReport.unmanagedDirectSkillConflicts, []);
  assert.deepStrictEqual(first.finalReport.standaloneDirectHookArtifacts, []);
  assert.ok(first.verification.preservedDirectSkills.some((skill) => skill.exact === false));

  const configPath = path.join(fixture.codexHome, 'config.toml');
  const firstConfigHash = hashPath(configPath);
  const config = fs.readFileSync(configPath, 'utf8');
  assert.ok(config.includes(path.join(userSkillRoot, 'SKILL.md').replace(/\\/g, '/')));
  assert.ok(config.includes(path.join(projectSkillRoot, 'SKILL.md').replace(/\\/g, '/')));
  const secondBackup = path.join(fixture.root, 'second-backup');
  const second = runDoctor({ ...common, backupRoot: secondBackup });
  assert.strictEqual(second.repair.noop, true);
  assert.strictEqual(hashPath(configPath), firstConfigHash);
  assert.strictEqual(hashPath(userSkillRoot), userHash);
  assert.strictEqual(hashPath(projectSkillRoot), projectHash);
  assert.strictEqual(fs.existsSync(secondBackup), false);
});

test('directory-valued or malformed managed exclusions fail closed', () => {
  const fixture = createFixture();
  const sharedSkillRoot = path.join(path.dirname(fixture.codexHome), '.agents', 'skills', 'work');
  write(path.join(sharedSkillRoot, 'SKILL.md'), 'shared\n');
  write(path.join(fixture.codexHome, 'config.toml'), [
    MANAGED_SKILL_EXCLUSIONS_BEGIN,
    '[[skills.config]]',
    `path = ${JSON.stringify(sharedSkillRoot.replace(/\\/g, '/'))}`,
    'enabled = false',
    MANAGED_SKILL_EXCLUSIONS_END,
    '',
  ].join('\n'));
  const report = analyze(fixture, [fixture.canonical]);
  assert.ok(report.analysisErrors.some((error) => error.includes('absolute SKILL.md')));
  assert.strictEqual(report.healthy, false);
  assert.throws(() => buildRepairPlan(report), /incomplete analysis/i);
});

test('existing managed exclusions cover shared conflicts without moving shared files', () => {
  const fixture = createFixture();
  const sharedSkill = path.join(path.dirname(fixture.codexHome), '.agents', 'skills', 'work', 'SKILL.md');
  write(sharedSkill, 'shared\n');
  write(path.join(fixture.codexHome, 'config.toml'), [
    '# outside-before',
    MANAGED_SKILL_EXCLUSIONS_BEGIN,
    '# Managed by test',
    '',
    '[[skills.config]]',
    `path = ${JSON.stringify(sharedSkill.replace(/\\/g, '/'))}`,
    'enabled = false',
    MANAGED_SKILL_EXCLUSIONS_END,
    '# outside-after',
    '',
  ].join('\n'));
  const report = analyze(fixture, [fixture.canonical]);
  assert.strictEqual(report.sharedSkillConflicts.length, 1);
  assert.strictEqual(report.sharedSkillConflicts[0].managedExcluded, true);
  assert.deepStrictEqual(report.unmanagedSharedSkillConflicts, []);
  assert.strictEqual(report.healthy, true);
  assert.strictEqual(buildRepairPlan(report).configUpdate, null);
});

test('JSON serialization emits deterministic arrays for Map and Set values', () => {
  const fixture = createFixture();
  const report = analyze(fixture, [fixture.canonical]);
  const first = JSON.stringify(report, jsonReplacer, 2);
  const second = JSON.stringify(report, jsonReplacer, 2);
  assert.strictEqual(first, second);
  const parsed = JSON.parse(first);
  assert.ok(Array.isArray(parsed.pluginProviders[0].skills));
  assert.ok(Array.isArray(parsed.pluginProviders[0].hooks));
  assert.ok(Array.isArray(parsed.pluginProviders[0].acceptedSkills));
  assert.ok(!first.includes('"skills": {}'));
});

test('non-canonical sole plugin owner is blocked before automatic mutation', () => {
  const fixture = createFixture();
  const nonCanonical = {
    ...fixture.canonical,
    pluginId: 'tech-persistence@old-marketplace',
    marketplaceName: 'old-marketplace',
  };
  assert.throws(() => runDoctor({
    fix: true,
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    backupRoot: path.join(fixture.root, 'backup'),
    canonicalPluginId: fixture.canonical.pluginId,
    readPluginList() { return { installed: [nonCanonical] }; },
    runCodex() { return { status: 0, stdout: '{}', stderr: '' }; },
  }), /automatic plugin owner add\/remove is disabled/i);
  assert.strictEqual(fs.existsSync(path.join(fixture.root, 'backup')), false);
});

test('missing manifest-owned Codex surfaces make analysis fail closed', () => {
  const fixture = createFixture();
  fs.rmSync(path.join(fixture.pluginRoot, 'codex-skills'), { recursive: true });
  const report = analyze(fixture, [fixture.canonical]);
  assert.strictEqual(report.healthy, false);
  assert.ok(report.analysisErrors.some((error) => error.includes('plugin skills root missing')));
  assert.throws(() => buildRepairPlan(report), /incomplete analysis/i);
});

test('preflight rejects owner proposals outside immutable owner metadata', () => {
  const fixture = createFixture();
  const duplicate = {
    ...fixture.canonical,
    pluginId: 'tech-persistence@old-marketplace',
    marketplaceName: 'old-marketplace',
  };
  const backupRoot = path.join(fixture.root, 'backup');
  const plan = buildRepairPlan(analyze(fixture, [fixture.canonical, duplicate]), { backupRoot });
  plan.proposedOwnerCommands[0] = ['plugin', 'remove', 'unrelated@marketplace', '--json'];
  assert.throws(() => applyRepairPlan(plan, {
    runCodex() { throw new Error('preflight must run first'); },
  }), /proposedOwnerCommands do not match owner metadata/i);
  assert.strictEqual(fs.existsSync(backupRoot), false);
});

test('preflight cannot be bypassed by clearing owner proposals or needsRepair', () => {
  const fixture = createFixture();
  const duplicate = {
    ...fixture.canonical,
    pluginId: 'tech-persistence@old-marketplace',
    marketplaceName: 'old-marketplace',
  };
  let planSequence = 0;
  const makePlan = () => buildRepairPlan(
    analyze(fixture, [fixture.canonical, duplicate]),
    { backupRoot: path.join(fixture.root, `backup-${planSequence++}`) }
  );

  const withoutProposals = makePlan();
  withoutProposals.proposedOwnerCommands = [];
  assert.throws(() => applyRepairPlan(withoutProposals),
    /proposedOwnerCommands do not match owner metadata/i);
  assert.strictEqual(fs.existsSync(withoutProposals.backupRoot), false);

  const falseNoop = makePlan();
  falseNoop.needsRepair = false;
  assert.throws(() => applyRepairPlan(falseNoop),
    /needsRepair does not match immutable repair inputs/i);
  assert.strictEqual(fs.existsSync(falseNoop.backupRoot), false);

  const missingRemoval = makePlan();
  missingRemoval.pluginRemovals = [];
  assert.throws(() => applyRepairPlan(missingRemoval),
    /pluginRemovals do not match the immutable original owner snapshots/i);
  assert.strictEqual(fs.existsSync(missingRemoval.backupRoot), false);
});

test('preflight rejects forged health metadata before any mutation', () => {
  const fixture = createFixture();
  const configPath = path.join(fixture.codexHome, 'config.toml');
  const originalConfig = 'model = "gpt-5.6"\n';
  write(configPath, originalConfig);
  let sequence = 0;
  const cases = [
    ['negative count', (preflight) => {
      preflight.pluginOwnerCount = -1;
      preflight.directOwnerCount = 2;
      preflight.ownerCount = 1;
    }, /non-negative safe integers/i],
    ['fractional count', (preflight) => {
      preflight.pluginOwnerCount = 0.5;
      preflight.directOwnerCount = 0.5;
      preflight.ownerCount = 1;
    }, /non-negative safe integers/i],
    ['owner snapshot mismatch', (preflight) => {
      preflight.pluginOwnerCount = 0;
      preflight.directOwnerCount = 1;
      preflight.ownerCount = 1;
    }, /pluginOwnerCount does not match immutable owner snapshots/i],
    ['owner total mismatch', (preflight) => {
      preflight.ownerCount = 2;
    }, /ownerCount does not match plugin and direct owner counts/i],
    ['canonical flag mismatch', (preflight) => {
      preflight.canonicalOwnerPresent = false;
    }, /canonicalOwnerPresent does not match immutable owner snapshots/i],
    ['non-boolean health', (preflight) => {
      preflight.reportHealthy = 1;
    }, /reportHealthy must be boolean/i],
    ['analysis error injection', (preflight) => {
      preflight.analysisErrors = ['incomplete analysis'];
    }, /analysisErrors must be an empty array/i],
  ];

  for (const [name, mutate, expected] of cases) {
    const backupRoot = path.join(fixture.root, `forged-health-${sequence++}`);
    const plan = buildRepairPlan(analyze(fixture, [fixture.canonical]), { backupRoot });
    mutate(plan.preflight);
    let cliCalls = 0;
    assert.throws(() => applyRepairPlan(plan, {
      runCodex() {
        cliCalls += 1;
        throw new Error('CLI must not run');
      },
    }), expected, name);
    assert.strictEqual(cliCalls, 0, name);
    assert.strictEqual(fs.existsSync(backupRoot), false, name);
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), originalConfig, name);
  }
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, error }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${error.stack || error.message}`);
  });
  process.exit(1);
}
