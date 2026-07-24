#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  hashPath,
  inspectManagedSkillExclusions,
  renderManagedSkillExclusions,
} = require('./codex-runtime-doctor');
const {
  inspectDisabledSkillPaths,
  installManagedProjectFallback,
} = require('./install-managed-project-fallback');
const { validateDirectFallback } = require('./validate-codex-install');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-codex-fallback-'));
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createSource(root, versions = { sprint: 'v2', work: 'v2' }) {
  for (const [name, version] of Object.entries(versions)) {
    write(path.join(root, name, 'SKILL.md'), `# ${name} ${version}\n`);
  }
}

function ownerManifest(sourceRoot, names) {
  return {
    schemaVersion: 1,
    owner: 'tech-persistence',
    mode: 'project-direct-fallback',
    managed: names.sort().map((name) => ({
      path: `skills/${name}`,
      sha256: hashPath(path.join(sourceRoot, name)),
    })),
  };
}

function symlinkDirectory(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

try {
  test('activation removes only current project fallback exclusions and validates visibility', () => {
    const root = path.join(tempRoot, 'activate');
    const sourceRoot = path.join(root, 'source');
    const codexRoot = path.join(root, 'project', '.codex');
    const userCodexHome = path.join(root, 'user', '.codex');
    const unrelatedSkill = path.join(root, 'user', '.agents', 'skills', 'unrelated', 'SKILL.md');
    createSource(sourceRoot);
    write(unrelatedSkill, '# unrelated\n');
    const fallbackPaths = ['sprint', 'work']
      .map((name) => path.join(codexRoot, 'skills', name, 'SKILL.md'));
    const originalConfig = [
      'model = "gpt-5.6-terra"',
      '',
      renderManagedSkillExclusions('', [...fallbackPaths, unrelatedSkill]).trimEnd(),
      '',
    ].join('\n');
    write(path.join(userCodexHome, 'config.toml'), originalConfig);

    const result = installManagedProjectFallback({ sourceRoot, codexRoot, userCodexHome });
    assert.deepStrictEqual(
      result.removedExclusions.map((value) => path.resolve(value)).sort(),
      fallbackPaths.map((value) => path.resolve(value)).sort()
    );
    assert.ok(result.configBackupRoot);
    assert.strictEqual(
      fs.readFileSync(path.join(result.configBackupRoot, 'config.toml'), 'utf8'),
      originalConfig
    );

    const managed = inspectManagedSkillExclusions(userCodexHome);
    assert.strictEqual(managed.invalid, null);
    assert.deepStrictEqual([...managed.paths.values()], [path.resolve(unrelatedSkill)]);
    const disabled = inspectDisabledSkillPaths(path.join(userCodexHome, 'config.toml'));
    assert.strictEqual(disabled.invalid, null);
    assert.ok(!fallbackPaths.some((skillFile) => {
      return [...disabled.paths.values()].some((configured) => path.resolve(configured) === path.resolve(skillFile));
    }));
    assert.strictEqual(
      validateDirectFallback({
        codexRoot,
        canonicalSkillsRoot: sourceRoot,
        userCodexRoot: userCodexHome,
        onFailure: (message) => { throw new Error(message); },
        onSuccess: () => {},
      }),
      true
    );
  });

  test('user-managed disabled fallback skill blocks activation without mutation', () => {
    const root = path.join(tempRoot, 'manual-disabled');
    const sourceRoot = path.join(root, 'source');
    const codexRoot = path.join(root, 'project', '.codex');
    const userCodexHome = path.join(root, 'user', '.codex');
    createSource(sourceRoot, { sprint: 'v2' });
    const skillFile = path.join(codexRoot, 'skills', 'sprint', 'SKILL.md');
    const config = [
      '[[skills.config]]',
      `path = ${JSON.stringify(skillFile.replace(/\\/g, '/'))}`,
      'enabled = false',
      '',
    ].join('\n');
    write(path.join(userCodexHome, 'config.toml'), config);

    assert.throws(
      () => installManagedProjectFallback({ sourceRoot, codexRoot, userCodexHome }),
      /user-managed disabled skills\.config/
    );
    assert.strictEqual(fs.existsSync(path.join(codexRoot, 'tech-persistence-owner.json')), false);
    assert.strictEqual(fs.existsSync(path.join(codexRoot, 'skills', 'sprint')), false);
    assert.strictEqual(fs.readFileSync(path.join(userCodexHome, 'config.toml'), 'utf8'), config);
  });

  test('failure after config activation restores config, owner manifest, and prior skills', () => {
    const root = path.join(tempRoot, 'rollback');
    const oldSource = path.join(root, 'old-source');
    const sourceRoot = path.join(root, 'source');
    const codexRoot = path.join(root, 'project', '.codex');
    const userCodexHome = path.join(root, 'user', '.codex');
    createSource(oldSource, { sprint: 'v1' });
    createSource(sourceRoot, { sprint: 'v2' });
    fs.cpSync(path.join(oldSource, 'sprint'), path.join(codexRoot, 'skills', 'sprint'), { recursive: true });
    const oldManifest = ownerManifest(oldSource, ['sprint']);
    writeJson(path.join(codexRoot, 'tech-persistence-owner.json'), oldManifest);
    const skillFile = path.join(codexRoot, 'skills', 'sprint', 'SKILL.md');
    const originalConfig = renderManagedSkillExclusions('model = "gpt-5.6-terra"\n', [skillFile]);
    write(path.join(userCodexHome, 'config.toml'), originalConfig);
    const oldSkillHash = hashPath(path.join(codexRoot, 'skills', 'sprint'));

    assert.throws(
      () => installManagedProjectFallback({
        sourceRoot,
        codexRoot,
        userCodexHome,
        failAt: 'after-config-write',
      }),
      /injected failure at after-config-write; rollback completed/
    );
    assert.strictEqual(hashPath(path.join(codexRoot, 'skills', 'sprint')), oldSkillHash);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(codexRoot, 'tech-persistence-owner.json'), 'utf8')),
      oldManifest
    );
    assert.strictEqual(fs.readFileSync(path.join(userCodexHome, 'config.toml'), 'utf8'), originalConfig);
    assert.strictEqual(
      fs.readdirSync(codexRoot).some((name) => name.startsWith('.tech-persistence-stage-')),
      false
    );
  });

  test('validator rejects a hash-correct fallback disabled by config', () => {
    const root = path.join(tempRoot, 'validator-disabled');
    const sourceRoot = path.join(root, 'source');
    const codexRoot = path.join(root, 'project', '.codex');
    const userCodexHome = path.join(root, 'user', '.codex');
    createSource(sourceRoot, { sprint: 'v2' });
    fs.cpSync(path.join(sourceRoot, 'sprint'), path.join(codexRoot, 'skills', 'sprint'), { recursive: true });
    writeJson(
      path.join(codexRoot, 'tech-persistence-owner.json'),
      ownerManifest(sourceRoot, ['sprint'])
    );
    write(
      path.join(userCodexHome, 'config.toml'),
      renderManagedSkillExclusions('', [path.join(codexRoot, 'skills', 'sprint', 'SKILL.md')])
    );
    const failures = [];
    assert.strictEqual(
      validateDirectFallback({
        codexRoot,
        canonicalSkillsRoot: sourceRoot,
        userCodexRoot: userCodexHome,
        onFailure: (message) => failures.push(message),
        onSuccess: () => {},
      }),
      false
    );
    assert.ok(failures.some((message) => message.includes('disabled by skills.config')));
  });

  test('symlinked skill target and backup ancestor fail closed', () => {
    const root = path.join(tempRoot, 'symlink');
    const sourceRoot = path.join(root, 'source');
    const codexRoot = path.join(root, 'project', '.codex');
    const userCodexHome = path.join(root, 'user', '.codex');
    const outsideTarget = path.join(root, 'outside-target');
    createSource(sourceRoot, { sprint: 'v2' });
    write(path.join(outsideTarget, 'SKILL.md'), '# outside\n');
    symlinkDirectory(outsideTarget, path.join(codexRoot, 'skills', 'sprint'));
    assert.throws(
      () => installManagedProjectFallback({ sourceRoot, codexRoot, userCodexHome }),
      /symlink\/junction\/reparse/
    );
    assert.strictEqual(fs.readFileSync(path.join(outsideTarget, 'SKILL.md'), 'utf8'), '# outside\n');

    const backupRoot = path.join(root, 'backup-link');
    fs.rmSync(codexRoot, { recursive: true, force: true });
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.mkdirSync(codexRoot, { recursive: true });
    symlinkDirectory(backupRoot, path.join(codexRoot, 'tech-persistence-backups'));
    assert.throws(
      () => installManagedProjectFallback({ sourceRoot, codexRoot, userCodexHome }),
      /backup root.*symlink\/junction\/reparse/
    );
  });

  test('nested source links cannot be copied into the managed fallback', () => {
    const root = path.join(tempRoot, 'nested-source-link');
    const sourceRoot = path.join(root, 'source');
    const codexRoot = path.join(root, 'project', '.codex');
    const userCodexHome = path.join(root, 'user', '.codex');
    const outsideTarget = path.join(root, 'outside');
    createSource(sourceRoot, { sprint: 'v2' });
    write(path.join(outsideTarget, 'secret.txt'), 'outside\n');
    symlinkDirectory(outsideTarget, path.join(sourceRoot, 'sprint', 'references'));

    assert.throws(
      () => installManagedProjectFallback({ sourceRoot, codexRoot, userCodexHome }),
      /fallback source.*symlink\/junction\/reparse/
    );
    assert.strictEqual(fs.existsSync(path.join(codexRoot, 'skills', 'sprint')), false);
    assert.strictEqual(fs.readFileSync(path.join(outsideTarget, 'secret.txt'), 'utf8'), 'outside\n');
  });

  test('target is revalidated immediately before rename', () => {
    const root = path.join(tempRoot, 'swap');
    const oldSource = path.join(root, 'old-source');
    const sourceRoot = path.join(root, 'source');
    const codexRoot = path.join(root, 'project', '.codex');
    const userCodexHome = path.join(root, 'user', '.codex');
    const outsideTarget = path.join(root, 'outside');
    createSource(oldSource, { sprint: 'v1' });
    createSource(sourceRoot, { sprint: 'v2' });
    write(path.join(outsideTarget, 'SKILL.md'), '# outside\n');
    const target = path.join(codexRoot, 'skills', 'sprint');
    fs.cpSync(path.join(oldSource, 'sprint'), target, { recursive: true });
    writeJson(
      path.join(codexRoot, 'tech-persistence-owner.json'),
      ownerManifest(oldSource, ['sprint'])
    );
    let swapped = false;
    assert.throws(
      () => installManagedProjectFallback({
        sourceRoot,
        codexRoot,
        userCodexHome,
        onStep(step) {
          if (step !== 'before-move-existing' || swapped) return;
          swapped = true;
          fs.renameSync(target, `${target}.attacker-hidden`);
          symlinkDirectory(outsideTarget, target);
        },
      }),
      /symlink\/junction\/reparse/
    );
    assert.strictEqual(swapped, true);
    assert.strictEqual(fs.readFileSync(path.join(outsideTarget, 'SKILL.md'), 'utf8'), '# outside\n');
  });

  console.log(`\n[OK] ${passed} managed project fallback tests passed`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
