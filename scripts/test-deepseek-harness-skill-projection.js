'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { CODEX_SKILL_NAMES, INVENTORY_SHA256 } = require('./lib/managed-plugin-inventory');
const {
  DeepSeekHarnessSkillProjectionError,
  inspectDeepSeekHarnessSkillProjection,
  installDeepSeekHarnessSkillProjection,
  verifyDeepSeekHarnessSkillProjection,
} = require('./deepseek-harness-skill-projection');

const repoRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(repoRoot, 'plugins', 'tech-persistence', 'codex-skills');
const pluginManifestPath = path.join(
  repoRoot,
  'plugins',
  'tech-persistence',
  '.codex-plugin',
  'plugin.json'
);

function withTempRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-dsh-skills-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function projectionOptions(root) {
  return {
    sourceRoot,
    pluginManifestPath,
    targetRoot: path.join(root, '.dsh', 'skills'),
    now: '2026-10-12T00:00:00.000Z',
  };
}

test('inspect accepts the canonical 33-skill DeepSeek Harness projection source', () => {
  withTempRoot((root) => {
    const result = inspectDeepSeekHarnessSkillProjection(projectionOptions(root));
    assert.strictEqual(result.status, 'install-required');
    assert.strictEqual(result.inventorySha256, INVENTORY_SHA256);
    assert.deepStrictEqual(result.skillNames, [...CODEX_SKILL_NAMES]);
    assert.deepStrictEqual(result.collisions, []);
  });
});

test('install projects complete skill bundles and preserves unrelated DeepSeek skills', () => {
  withTempRoot((root) => {
    const options = projectionOptions(root);
    const unrelated = path.join(options.targetRoot, 'user-owned', 'SKILL.md');
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, '---\nname: user-owned\ndescription: keep me\n---\n', 'utf8');

    const installed = installDeepSeekHarnessSkillProjection(options);
    assert.strictEqual(installed.status, 'installed');
    assert.strictEqual(installed.skillCount, 33);
    assert.strictEqual(fs.readFileSync(unrelated, 'utf8').includes('keep me'), true);
    for (const name of CODEX_SKILL_NAMES) {
      assert.strictEqual(fs.existsSync(path.join(options.targetRoot, name, 'SKILL.md')), true, name);
    }
    assert.strictEqual(
      fs.existsSync(path.join(options.targetRoot, 'sprint', 'runtime', 'codex-active-sprint-state.js')),
      true,
      'skill bundle resources must be projected with SKILL.md'
    );

    const verified = verifyDeepSeekHarnessSkillProjection(options);
    assert.strictEqual(verified.status, 'verified');
    assert.strictEqual(verified.skillCount, 33);
  });
});

test('install is idempotent when the managed projection is unchanged', () => {
  withTempRoot((root) => {
    const options = projectionOptions(root);
    installDeepSeekHarnessSkillProjection(options);
    const second = installDeepSeekHarnessSkillProjection(options);
    assert.strictEqual(second.status, 'unchanged');
    assert.strictEqual(second.skillCount, 33);
  });
});

test('install refuses to overwrite an unmanaged skill collision', () => {
  withTempRoot((root) => {
    const options = projectionOptions(root);
    const collision = path.join(options.targetRoot, 'sprint', 'SKILL.md');
    fs.mkdirSync(path.dirname(collision), { recursive: true });
    fs.writeFileSync(collision, '---\nname: sprint\ndescription: user copy\n---\n', 'utf8');

    assert.throws(
      () => installDeepSeekHarnessSkillProjection(options),
      (error) => error instanceof DeepSeekHarnessSkillProjectionError
        && error.code === 'DEEPSEEK_SKILL_COLLISION'
        && /sprint/.test(error.message)
    );
    assert.strictEqual(fs.readFileSync(collision, 'utf8').includes('user copy'), true);
  });
});

test('verify and update fail closed after a managed skill is edited externally', () => {
  withTempRoot((root) => {
    const options = projectionOptions(root);
    installDeepSeekHarnessSkillProjection(options);
    fs.appendFileSync(path.join(options.targetRoot, 'work', 'SKILL.md'), '\nexternal edit\n', 'utf8');

    for (const operation of [
      () => verifyDeepSeekHarnessSkillProjection(options),
      () => installDeepSeekHarnessSkillProjection(options),
    ]) {
      assert.throws(
        operation,
        (error) => error instanceof DeepSeekHarnessSkillProjectionError
          && error.code === 'DEEPSEEK_SKILL_DRIFT'
          && /work/.test(error.message)
      );
    }
  });
});

test('canonical skills satisfy DeepSeek Harness frontmatter and top-level inventory rules', () => {
  const result = inspectDeepSeekHarnessSkillProjection({
    sourceRoot,
    pluginManifestPath,
    targetRoot: path.join(os.tmpdir(), 'tp-dsh-skills-frontmatter-only'),
  });
  assert.deepStrictEqual(result.skillNames, [...CODEX_SKILL_NAMES]);
  assert.strictEqual(result.sourceVersion, '1.0.8');
});
