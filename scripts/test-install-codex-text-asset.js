#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');
const { installCodexTextAsset } = require('./install-codex-text-asset');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-text-asset-'));
  const source = path.join(root, 'source.md');
  fs.writeFileSync(source, 'Use Claude Code, CLAUDE.md, and .claude/commands.\n');
  return { root, source };
}

function backupsFor(target) {
  const directory = path.dirname(target);
  const prefix = `${path.basename(target)}.bak.`;
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(directory, name));
}

test('publishes converted bytes and retains the exact initial backup', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    fs.writeFileSync(target, 'initial bytes\n');
    const result = installCodexTextAsset({ allowedRoot: root, source, target, mode: 'backup' });
    assert.strictEqual(result.status, 'published');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'Use Codex, AGENTS.md, and .codex/commands.\n');
    assert.strictEqual(fs.readFileSync(result.backupPath, 'utf8'), 'initial bytes\n');
    assert.match(result.expectedSha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged and custom no-overwrite targets are non-mutating', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    const converted = 'Use Codex, AGENTS.md, and .codex/commands.\n';
    fs.writeFileSync(target, converted);
    assert.strictEqual(
      installCodexTextAsset({ allowedRoot: root, source, target, mode: 'backup' }).status,
      'unchanged'
    );
    assert.deepStrictEqual(backupsFor(target), []);

    fs.writeFileSync(target, 'custom bytes\n');
    assert.strictEqual(
      installCodexTextAsset({ allowedRoot: root, source, target, mode: 'no-overwrite' }).status,
      'skipped'
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'custom bytes\n');
    assert.deepStrictEqual(backupsFor(target), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing-target race fails closed and retains external bytes', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    fs.writeFileSync(target, 'initial bytes\n');
    assert.throws(
      () => installCodexTextAsset({
        allowedRoot: root,
        source,
        target,
        mode: 'backup',
        testHooks: {
          beforeClaim() {
            fs.writeFileSync(target, 'external-existing\n');
          },
        },
      }),
      /compare-and-swap|concurrent/i
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-existing\n');
    const backups = backupsFor(target);
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(backups[0], 'utf8'), 'initial bytes\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('absent-target race fails closed and retains the external file', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    assert.throws(
      () => installCodexTextAsset({
        allowedRoot: root,
        source,
        target,
        mode: 'backup',
        testHooks: {
          beforePublish() {
            fs.writeFileSync(target, 'external-created\n');
          },
        },
      }),
      /compare-and-swap|concurrent/i
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-created\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('absent-target durability unknown blocks published status and retains external bytes', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    let reportedResult = null;
    let unknown = null;
    try {
      reportedResult = installCodexTextAsset({
        allowedRoot: root,
        source,
        target,
        mode: 'backup',
        testHooks: {
          afterPublish() {
            fs.writeFileSync(target, 'external-during-sync-failure\n');
          },
          beforePublishSync() {
            const error = new Error('simulated text install sync EIO');
            error.code = 'EIO';
            throw error;
          },
        },
      });
    } catch (error) {
      unknown = error;
    }
    assert.strictEqual(reportedResult, null, 'unknown commit state must not report a published install');
    assert(unknown);
    assert.strictEqual(unknown.code, 'CODEX_PUBLISH_COMMIT_STATE_UNKNOWN');
    assert.strictEqual(unknown.commitState, 'unknown');
    assert.strictEqual(unknown.retryable, false);
    assert.strictEqual(unknown.preservedPath, target);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-during-sync-failure\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('absent-target afterPublish drift fails closed and retains external bytes', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    assert.throws(
      () => installCodexTextAsset({
        allowedRoot: root,
        source,
        target,
        mode: 'backup',
        testHooks: {
          afterPublish() {
            fs.writeFileSync(target, 'external-after-publish\n');
          },
        },
      }),
      /compare-and-swap|published target.*drift|concurrent/i
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-after-publish\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing-target afterPublish drift retains canonical external bytes and previous evidence', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    fs.writeFileSync(target, 'initial bytes\n');
    let conflict = null;
    try {
      installCodexTextAsset({
        allowedRoot: root,
        source,
        target,
        mode: 'overwrite',
        testHooks: {
          afterPublish() {
            fs.writeFileSync(target, 'external-after-publish\n');
          },
        },
      });
    } catch (error) {
      conflict = error;
    }
    assert(conflict);
    assert.match(conflict.message, /compare-and-swap|published target.*drift|concurrent/i);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-after-publish\n');
    assert(conflict.preservedPath && fs.existsSync(conflict.preservedPath));
    assert.strictEqual(fs.readFileSync(conflict.preservedPath, 'utf8'), 'initial bytes\n');
    assert.ok(fs.existsSync(path.join(
      root,
      `.${path.basename(target)}.tech-persistence-cas-recovery.json`
    )));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-claim collision retains both concurrent and expected bytes', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    fs.writeFileSync(target, 'initial bytes\n');
    let conflict = null;
    try {
      installCodexTextAsset({
        allowedRoot: root,
        source,
        target,
        mode: 'overwrite',
        testHooks: {
          beforePublish() {
            fs.writeFileSync(target, 'external-after-claim\n');
          },
        },
      });
    } catch (error) {
      conflict = error;
    }
    assert(conflict);
    assert.match(conflict.message, /compare-and-swap|concurrent/i);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'external-after-claim\n');
    assert(conflict.preservedPath && fs.existsSync(conflict.preservedPath));
    assert.strictEqual(fs.readFileSync(conflict.preservedPath, 'utf8'), 'initial bytes\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a target outside the explicit allowed root', () => {
  const { root, source } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-text-outside-'));
  try {
    assert.throws(
      () => installCodexTextAsset({
        allowedRoot: root,
        source,
        target: path.join(outside, 'target.md'),
        mode: 'backup',
      }),
      /escapes allowed root/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('CLI publishes through the same guarded implementation', () => {
  const { root, source } = fixture();
  try {
    const target = path.join(root, 'target.md');
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'install-codex-text-asset.js'),
      '--allowed-root', root,
      '--source', source,
      '--target', target,
      '--mode', 'backup',
    ], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.status, 'published');
    assert.strictEqual(payload.expectedExisted, false);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'Use Codex, AGENTS.md, and .codex/commands.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
