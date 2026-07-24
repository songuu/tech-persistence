#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPath, renderManagedSkillExclusions } = require('./codex-runtime-doctor');
const {
  findDirectCollisions,
  hasActiveManagedFallback,
  inspectMarketplace,
  ownerProbe,
  stripManagedSolutionIndex,
  validateDirectFallback,
  validateNativeAgents,
  validateNativeCommands,
  validateOwnerIntegrity,
} = require('./validate-codex-install');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-codex-install-'));
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

try {
  test('managed solution indexes are excluded from AGENTS cross-runtime validation', () => {
    const block = [
      '<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->',
      'mentions CLAUDE.md and Claude Code inside generated history',
      '<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->',
    ].join('\n');
    const stripped = stripManagedSolutionIndex(`# AGENTS\n${block}\nCurrent\n${block}\n`);
    assert.ok(!stripped.includes('CLAUDE.md'));
    assert.ok(!stripped.includes('Claude Code'));
    assert.ok(stripped.includes('# AGENTS'));
    assert.ok(stripped.includes('Current'));
    assert.strictEqual(stripManagedSolutionIndex('unchanged\n'), 'unchanged\n');
  });

  test('user marketplace requires one canonical local-plugins entry', () => {
    const marketplacePath = path.join(tempRoot, 'marketplace.json');
    writeJson(marketplacePath, {
      name: 'local-plugins',
      plugins: [{
        name: 'tech-persistence',
        source: { source: 'local', path: './plugins/tech-persistence' },
      }],
    });
    assert.strictEqual(inspectMarketplace(marketplacePath).valid, true);

    const duplicate = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    duplicate.plugins.push(duplicate.plugins[0]);
    writeJson(marketplacePath, duplicate);
    assert.strictEqual(inspectMarketplace(marketplacePath).valid, false);
  });

  test('installed native commands must byte-match Codex-native sources', () => {
    const commandRoot = path.join(tempRoot, 'commands');
    fs.mkdirSync(commandRoot, { recursive: true });
    for (const name of ['compound.md', 'plan.md', 'review.md', 'sprint.md', 'think.md', 'work.md']) {
      fs.copyFileSync(path.join(__dirname, '..', 'codex-native', 'commands', name), path.join(commandRoot, name));
    }
    assert.strictEqual(validateNativeCommands(commandRoot, 'fixture', () => {}, () => {}), true);
    fs.appendFileSync(path.join(commandRoot, 'sprint.md'), 'legacy payload\n');
    assert.strictEqual(validateNativeCommands(commandRoot, 'fixture', () => {}, () => {}), false);
  });

  test('owner probe distinguishes zero, one, and duplicate plugin owners', () => {
    const fixture = path.join(tempRoot, 'plugins.json');
    writeJson(fixture, []);
    assert.strictEqual(ownerProbe({ pluginListFile: fixture }).ownerCount, 0);
    writeJson(fixture, [{ name: 'tech-persistence', marketplaceName: 'local-plugins', enabled: true }]);
    const one = ownerProbe({ pluginListFile: fixture });
    assert.strictEqual(one.ownerCount, 1);
    assert.deepStrictEqual(one.pluginIds, ['tech-persistence@local-plugins']);
    assert.strictEqual(ownerProbe({
      pluginListJson: JSON.stringify([{ name: 'tech-persistence', marketplaceName: 'local-plugins' }]),
    }).ownerCount, 1);
    writeJson(fixture, [
      { name: 'tech-persistence', marketplaceName: 'local-plugins', enabled: true },
      { name: 'tech-persistence', marketplaceName: 'repo-local', enabled: true },
    ]);
    assert.strictEqual(ownerProbe({ pluginListFile: fixture }).ownerCount, 2);
  });

  test('owner probe and validator require matching owner/source/cache version and bytes', () => {
    const codexHome = path.join(tempRoot, 'integrity-home', '.codex');
    const pluginRoot = path.join(tempRoot, 'integrity-home', 'plugins', 'tech-persistence');
    const manifest = {
      name: 'tech-persistence', version: '1.0.6', skills: './codex-skills/', hooks: './codex-hooks/hooks.json',
    };
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), manifest);
    fs.mkdirSync(path.join(pluginRoot, 'codex-skills', 'work'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'codex-skills', 'work', 'SKILL.md'), '# work\n');
    const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'local-plugins', 'tech-persistence', '1.0.6');
    fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
    fs.cpSync(pluginRoot, cacheRoot, { recursive: true });
    const fixture = path.join(tempRoot, 'integrity-plugins.json');
    writeJson(fixture, [{
      name: 'tech-persistence',
      marketplaceName: 'local-plugins',
      version: '1.0.6',
      enabled: true,
      source: { source: 'local', path: pluginRoot },
    }]);
    const owner = ownerProbe({ pluginListFile: fixture, codexHome });
    assert.strictEqual(owner.integrity[0].valid, true);
    const failures = [];
    assert.strictEqual(validateOwnerIntegrity(owner, pluginRoot, (message) => failures.push(message), () => {}), true);
    assert.deepStrictEqual(failures, []);

    manifest.version = '1.0.7';
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), manifest);
    const stale = ownerProbe({ pluginListFile: fixture, codexHome });
    assert.strictEqual(stale.integrity[0].valid, false);
    assert.strictEqual(validateOwnerIntegrity(stale, pluginRoot, () => {}, () => {}), false);
  });

  test('native AGENTS validator accepts only the exact lean template and preserves custom detection', () => {
    const target = path.join(tempRoot, 'AGENTS.md');
    const template = path.join(__dirname, '..', 'codex-native', 'agents', 'user.md');
    fs.copyFileSync(template, target);
    assert.strictEqual(validateNativeAgents(target, 'user', 'fixture', () => {}, () => {}), true);
    fs.appendFileSync(target, 'user edit\n');
    assert.strictEqual(validateNativeAgents(target, 'user', 'fixture', () => {}, () => {}), false);
  });

  test('managed project fallback verifies inventory and SHA256 hashes', () => {
    const canonicalRoot = path.join(tempRoot, 'canonical');
    const codexRoot = path.join(tempRoot, 'project', '.codex');
    for (const name of ['sprint', 'work']) {
      const canonicalSkill = path.join(canonicalRoot, name);
      const directSkill = path.join(codexRoot, 'skills', name);
      fs.mkdirSync(canonicalSkill, { recursive: true });
      fs.writeFileSync(path.join(canonicalSkill, 'SKILL.md'), `# ${name}\n`);
      fs.cpSync(canonicalSkill, directSkill, { recursive: true });
    }
    const managed = ['sprint', 'work'].map((name) => ({
      path: `skills/${name}`,
      sha256: hashPath(path.join(canonicalRoot, name)),
    }));
    writeJson(path.join(codexRoot, 'tech-persistence-owner.json'), {
      schemaVersion: 1,
      owner: 'tech-persistence',
      mode: 'project-direct-fallback',
      managed,
    });
    const failures = [];
    assert.strictEqual(validateDirectFallback({
      codexRoot,
      canonicalSkillsRoot: canonicalRoot,
      onFailure: (message) => failures.push(message),
      onSuccess: () => {},
    }), true);
    assert.deepStrictEqual(failures, []);
    assert.strictEqual(hasActiveManagedFallback(codexRoot), true);

    fs.appendFileSync(path.join(codexRoot, 'skills', 'sprint', 'SKILL.md'), 'tampered\n');
    assert.strictEqual(validateDirectFallback({
      codexRoot,
      canonicalSkillsRoot: canonicalRoot,
      onFailure: () => {},
      onSuccess: () => {},
    }), false);
  });

  test('stale owner manifest is not an active fallback after managed files are absent', () => {
    const codexRoot = path.join(tempRoot, 'stale', '.codex');
    writeJson(path.join(codexRoot, 'tech-persistence-owner.json'), {
      schemaVersion: 1,
      owner: 'tech-persistence',
      mode: 'project-direct-fallback',
      managed: [{ path: 'skills/sprint', sha256: '0'.repeat(64) }],
    });
    assert.strictEqual(hasActiveManagedFallback(codexRoot), false);
  });

  test('direct skill collision is detected even without an owner manifest', () => {
    const pluginRoot = path.join(tempRoot, 'plugin');
    const codexRoot = path.join(tempRoot, 'collision', '.codex');
    fs.mkdirSync(path.join(pluginRoot, 'codex-skills', 'sprint'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'codex-skills', 'sprint', 'SKILL.md'), '# sprint\n');
    fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name: 'tech-persistence',
      hooks: './codex-hooks/hooks.json',
    });
    fs.mkdirSync(path.join(pluginRoot, 'codex-hooks'), { recursive: true });
    writeJson(path.join(pluginRoot, 'codex-hooks', 'hooks.json'), { hooks: {} });
    fs.mkdirSync(path.join(codexRoot, 'skills', 'sprint'), { recursive: true });
    fs.writeFileSync(path.join(codexRoot, 'skills', 'sprint', 'SKILL.md'), '# local\n');
    assert.deepStrictEqual(findDirectCollisions(codexRoot, pluginRoot), ['skill:sprint']);
    fs.writeFileSync(
      path.join(codexRoot, 'config.toml'),
      renderManagedSkillExclusions('', [path.join(codexRoot, 'skills', 'sprint', 'SKILL.md')])
    );
    assert.deepStrictEqual(findDirectCollisions(codexRoot, pluginRoot), []);
  });

  console.log(`\n[OK] ${passed} Codex install validator tests passed`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
