#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LEGACY_GENERATED_HASHES,
  MANAGED_MARKERS,
  classifyExistingAgents,
  installCodexAgents,
  legacyClaudeToCodex,
  normalizedSha256,
} = require('./install-codex-agents');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agents-install-'));
try {
  const productionUserTemplate = fs.readFileSync(path.join(__dirname, '..', 'codex-native', 'agents', 'user.md'), 'utf8');
  for (const preference of [
    'TDD', 'YAGNI', 'DRY', '有意义的上下文', 'WHY', '业务语义命名', 'Conventional Commits', '中文优先',
  ]) {
    assert(productionUserTemplate.includes(preference), `lean user template lost preference: ${preference}`);
  }

  const allowedRoot = path.join(root, '.codex');
  const target = path.join(allowedRoot, 'AGENTS.md');
  const template = path.join(root, 'native-user.md');
  const legacy = path.join(root, 'CLAUDE.md');
  const templateText = `${MANAGED_MARKERS.user}\n# Native\n\nphase-local only\n`;
  const legacyText = '# Legacy\n\nUse Claude Code and ~/.claude/CLAUDE.md.\n';
  write(template, templateText);
  write(legacy, legacyText);

  const created = installCodexAgents({
    kind: 'user', allowedRoot, target, template, legacySource: legacy,
  });
  assert.strictEqual(created.status, 'created');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), templateText);

  const unchanged = installCodexAgents({
    kind: 'user', allowedRoot, target, template, legacySource: legacy,
  });
  assert.strictEqual(unchanged.status, 'unchanged');
  assert.strictEqual(unchanged.backupPath, null);

  const managedEdited = `${MANAGED_MARKERS.user}\r\n# locally old managed copy\r\n`;
  fs.writeFileSync(target, managedEdited);
  const updated = installCodexAgents({
    kind: 'user', allowedRoot, target, template, legacySource: legacy,
  });
  assert.strictEqual(updated.status, 'updated-managed');
  assert.strictEqual(fs.readFileSync(updated.backupPath, 'utf8'), managedEdited);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), templateText);

  const legacyProjection = legacyClaudeToCodex(legacyText).replace(/\n/g, '\r\n');
  fs.writeFileSync(target, `\uFEFF${legacyProjection}`);
  const migrated = installCodexAgents({
    kind: 'user', allowedRoot, target, template, legacySource: legacy,
  });
  assert.strictEqual(migrated.status, 'migrated-legacy');
  assert.strictEqual(fs.readFileSync(migrated.backupPath, 'utf8'), `\uFEFF${legacyProjection}`);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), templateText);
  assert.notStrictEqual(updated.backupPath, migrated.backupPath, 'each migration must retain a unique backup');

  const custom = '# User-owned instructions\n\nDo not replace me.\n';
  fs.writeFileSync(target, custom);
  const preserved = installCodexAgents({
    kind: 'user', allowedRoot, target, template, legacySource: legacy,
  });
  assert.strictEqual(preserved.status, 'preserved-custom');
  assert.strictEqual(preserved.optimized, false);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), custom);

  const cli = spawnSync(process.execPath, [
    path.join(__dirname, 'install-codex-agents.js'),
    '--kind', 'user',
    '--allowed-root', allowedRoot,
    '--target', target,
    '--template', template,
    '--legacy-source', legacy,
  ], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(cli.status, 2, cli.stderr);
  assert.strictEqual(JSON.parse(cli.stdout.trim()).status, 'preserved-custom');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), custom);

  const historical = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'legacy-generated-codex-agents-v1.md')
  );
  assert.strictEqual(
    normalizedSha256(historical.toString('utf8')),
    '2f2de24b4eed8d8af8ef95214f067e8968d137e895eae888bc9e63b1c2ba8eb3'
  );
  assert.strictEqual(LEGACY_GENERATED_HASHES.user.includes(normalizedSha256(historical.toString('utf8'))), true);
  const historicalBomCrlf = Buffer.from(`\uFEFF${historical.toString('utf8').replace(/\n/g, '\r\n')}`);
  assert.strictEqual(normalizedSha256(historicalBomCrlf.toString('utf8')), normalizedSha256(historical.toString('utf8')));
  assert.strictEqual(classifyExistingAgents({
    raw: historicalBomCrlf,
    templateRaw: Buffer.from(templateText),
    legacyRaw: null,
    kind: 'user',
  }), 'legacy-generated');
  fs.writeFileSync(target, historical);
  const historicalMigration = installCodexAgents({
    kind: 'user', allowedRoot, target, template,
  });
  assert.strictEqual(historicalMigration.status, 'migrated-legacy');
  assert(fs.readFileSync(historicalMigration.backupPath).equals(historical));
  assert.strictEqual(fs.readFileSync(target, 'utf8'), templateText);

  const editedHistorical = Buffer.from(historical);
  const editOffset = editedHistorical.indexOf(Buffer.from('TDD'));
  assert(editOffset >= 0);
  editedHistorical[editOffset] = 't'.charCodeAt(0);
  assert.notStrictEqual(normalizedSha256(editedHistorical.toString('utf8')), normalizedSha256(historical.toString('utf8')));
  assert.strictEqual(classifyExistingAgents({
    raw: editedHistorical,
    templateRaw: Buffer.from(templateText),
    legacyRaw: null,
    kind: 'user',
  }), 'custom');
  fs.writeFileSync(target, editedHistorical);
  const editedPreserved = installCodexAgents({ kind: 'user', allowedRoot, target, template });
  assert.strictEqual(editedPreserved.status, 'preserved-custom');
  assert(fs.readFileSync(target).equals(editedHistorical));

  const concurrent = '# concurrent user edit\n';
  fs.writeFileSync(target, legacyClaudeToCodex(legacyText));
  assert.throws(
    () => installCodexAgents({
      kind: 'user',
      allowedRoot,
      target,
      template,
      legacySource: legacy,
      testHooks: {
        beforeClaim() {
          fs.writeFileSync(target, concurrent);
        },
      },
    }),
    /compare-and-swap|concurrent/i
  );
  assert.strictEqual(fs.readFileSync(target, 'utf8'), concurrent);

  const projectRoot = path.join(root, 'project');
  const projectTemplate = path.join(root, 'native-project.md');
  const projectTarget = path.join(projectRoot, 'AGENTS.md');
  write(projectTemplate, `${MANAGED_MARKERS.project}\n# Project\n`);
  const projectCreated = installCodexAgents({
    kind: 'project',
    allowedRoot: projectRoot,
    target: projectTarget,
    template: projectTemplate,
    legacySource: legacy,
  });
  assert.strictEqual(projectCreated.status, 'created');

  if (process.platform !== 'win32') {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const linkedRoot = path.join(root, 'linked-root');
    fs.symlinkSync(outside, linkedRoot, 'dir');
    assert.throws(
      () => installCodexAgents({
        kind: 'project',
        allowedRoot: linkedRoot,
        target: path.join(linkedRoot, 'AGENTS.md'),
        template: projectTemplate,
        legacySource: legacy,
      }),
      /symbolic link|junction/i
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('[OK] Codex-native AGENTS install is ownership-gated, backed up, and no-clobber');
