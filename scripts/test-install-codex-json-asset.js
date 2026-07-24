#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installJsonAsset } = require('./install-codex-json-asset');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-asset-'));
try {
  const source = path.join(root, 'template.json');
  const target = path.join(root, 'homunculus', 'config.json');
  const sourceText = `${JSON.stringify({ enabled: true, nested: { value: 1 } }, null, 2)}\n`;
  fs.writeFileSync(source, sourceText);

  const created = installJsonAsset({ target, source });
  assert.strictEqual(created.status, 'created');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), sourceText);
  assert.strictEqual(created.backupPath, null);

  const validUserText = '\uFEFF{"userOwned":true,"huge":9007199254740993}';
  fs.writeFileSync(target, validUserText);
  const unchanged = installJsonAsset({ target, source });
  assert.strictEqual(unchanged.status, 'existing-valid');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), validUserText);

  const damagedText = '{"partial":';
  fs.writeFileSync(target, damagedText);
  const repaired = installJsonAsset({ target, source });
  assert.strictEqual(repaired.status, 'repaired-invalid');
  assert.ok(repaired.backupPath);
  assert.strictEqual(fs.readFileSync(repaired.backupPath, 'utf8'), damagedText);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), sourceText);

  const secondDamagedText = '{"partial-again":';
  fs.writeFileSync(target, secondDamagedText);
  const repairedAgain = installJsonAsset({ target, source });
  assert.notStrictEqual(repairedAgain.backupPath, repaired.backupPath);
  assert.strictEqual(fs.readFileSync(repairedAgain.backupPath, 'utf8'), secondDamagedText);

  const beforeClaimTarget = path.join(root, 'homunculus', 'before-claim.json');
  const externalText = '{"external":"final-gap"}\n';
  fs.writeFileSync(beforeClaimTarget, '{"damaged":');
  assert.throws(
    () => installJsonAsset({
      target: beforeClaimTarget,
      source,
      testHooks: {
        beforeClaim() {
          fs.writeFileSync(beforeClaimTarget, externalText);
        },
      },
    }),
    /compare-and-swap|concurrent/i
  );
  assert.strictEqual(
    fs.readFileSync(beforeClaimTarget, 'utf8'),
    externalText,
    'concurrent external JSON must remain at the canonical path'
  );

  const afterClaimConflictTarget = path.join(root, 'homunculus', 'after-claim-conflict.json');
  const externalAfterClaim = '{"external":"after-claim"}\n';
  fs.writeFileSync(afterClaimConflictTarget, '{"damaged-after-claim":');
  assert.throws(
    () => installJsonAsset({
      target: afterClaimConflictTarget,
      source,
      testHooks: {
        beforePublish() {
          fs.writeFileSync(afterClaimConflictTarget, externalAfterClaim);
        },
      },
    }),
    /compare-and-swap|concurrent/i
  );
  assert.strictEqual(fs.readFileSync(afterClaimConflictTarget, 'utf8'), externalAfterClaim);

  const projects = path.join(root, 'homunculus', 'projects.json');
  const externallyCreated = '{"external":"created"}\n';
  assert.throws(
    () => installJsonAsset({
      target: projects,
      defaultJson: '{}',
      testHooks: {
        beforePublish() {
          fs.writeFileSync(projects, externallyCreated);
        },
      },
    }),
    /compare-and-swap|concurrent/i
  );
  assert.strictEqual(fs.readFileSync(projects, 'utf8'), externallyCreated);

  const hardExitTarget = path.join(root, 'homunculus', 'hard-exit.json');
  const hardExitDamaged = '{"hard-exit":';
  fs.writeFileSync(hardExitTarget, hardExitDamaged);
  const installerModule = path.resolve(__dirname, 'install-codex-json-asset.js');
  const hardExitScript = [
    "const installer = require(process.argv[1]);",
    "installer.installJsonAsset({",
    "  target: process.argv[2],",
    "  source: process.argv[3],",
    "  testHooks: { beforePublish() { process.exit(87); } },",
    "});",
  ].join('\n');
  const hardExit = spawnSync(process.execPath, [
    '-e',
    hardExitScript,
    installerModule,
    hardExitTarget,
    source,
  ], { encoding: 'utf8' });
  assert.strictEqual(hardExit.status, 87, hardExit.stderr);
  assert.strictEqual(fs.existsSync(hardExitTarget), false);
  const recoveredAsset = installJsonAsset({ target: hardExitTarget, source });
  assert.strictEqual(recoveredAsset.status, 'repaired-invalid');
  assert.ok(recoveredAsset.backupPath);
  assert.strictEqual(fs.readFileSync(recoveredAsset.backupPath, 'utf8'), hardExitDamaged);
  assert.strictEqual(fs.readFileSync(hardExitTarget, 'utf8'), sourceText);

  const afterPublishTarget = path.join(root, 'homunculus', 'hard-exit-after-publish.json');
  const afterPublishDamaged = '{"after-publish":';
  fs.writeFileSync(afterPublishTarget, afterPublishDamaged);
  const afterPublishScript = hardExitScript.replace('beforePublish', 'afterPublish').replace('87', '88');
  const afterPublishExit = spawnSync(process.execPath, [
    '-e',
    afterPublishScript,
    installerModule,
    afterPublishTarget,
    source,
  ], { encoding: 'utf8' });
  assert.strictEqual(afterPublishExit.status, 88, afterPublishExit.stderr);
  assert.strictEqual(fs.readFileSync(afterPublishTarget, 'utf8'), sourceText);
  const afterPublishRecovered = installJsonAsset({ target: afterPublishTarget, source });
  assert.strictEqual(afterPublishRecovered.status, 'existing-valid');
  assert.strictEqual(fs.readFileSync(afterPublishTarget, 'utf8'), sourceText);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('[OK] Codex homunculus JSON assets publish atomically and preserve invalid/concurrent data');
