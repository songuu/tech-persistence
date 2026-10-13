#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const orchestrator = require('./agent-orchestrator');
const { parseManagedInvocation } = require('./harness-managed-invocation');
const {
  managedInvocationPromptBlock,
  resolveManagedInvocation,
} = require('./agent-orchestrator/managed-invocation');

function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-managed-invocation-prompt-'));
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-managed-invocation-control-'));
  try {
    const requirement = '/sprint --auto\nimplement the frozen scope';
    const metadata = parseManagedInvocation(requirement);
    const metadataFile = path.join(temporary, 'managed-invocation.json');
    fs.writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`, { mode: 0o440 });

    assert.deepStrictEqual(resolveManagedInvocation(requirement, metadataFile), metadata);
    assert.deepStrictEqual(resolveManagedInvocation(requirement), metadata);
    assert.strictEqual(resolveManagedInvocation('ordinary requirement'), null);
    assert.match(managedInvocationPromptBlock(metadata), /\$tech-persistence:sprint --auto/);
    assert.match(managedInvocationPromptBlock(metadata), /must not rename, replace, or omit/i);

    const tampered = { ...metadata, name: 'work' };
    fs.chmodSync(metadataFile, 0o600);
    fs.writeFileSync(metadataFile, `${JSON.stringify(tampered)}\n`);
    assert.throws(() => resolveManagedInvocation(requirement, metadataFile), /does not match requirement/i);
    fs.writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`);

    const specPrompt = orchestrator.buildSpecPrompt(requirement, {
      workdir: temporary,
      managedInvocation: metadata,
    });
    assert.match(specPrompt, /Managed invocation authority/);
    assert.match(specPrompt, /\$tech-persistence:sprint --auto\nimplement the frozen scope/);

    const runDir = path.join(temporary, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'spec.json'), '{}\n');
    fs.writeFileSync(path.join(runDir, 'technical-design.md'), 'design\n');
    fs.writeFileSync(path.join(runDir, 'task-breakdown.json'), '[]\n');
    fs.writeFileSync(path.join(runDir, 'managed-invocation.json'), `${JSON.stringify(metadata)}\n`);
    const implementationPrompt = orchestrator.buildImplementationPrompt({
      runId: 'run-1',
      workdir: temporary,
      files: { managedInvocation: 'managed-invocation.json' },
    }, runDir);
    assert.match(implementationPrompt, /Managed invocation authority/);
    assert.match(implementationPrompt, /\$tech-persistence:sprint --auto\nimplement the frozen scope/);

    const requirementFile = path.join(temporary, 'requirement.txt');
    fs.writeFileSync(requirementFile, requirement);
    fs.chmodSync(metadataFile, 0o440);
    const cli = spawnSync(process.execPath, [
      path.join(__dirname, 'agent-orchestrator.js'),
      'run',
      '--requirement-file', requirementFile,
      '--managed-invocation-file', metadataFile,
      '--workdir', temporary,
      '--runs-dir', '.runs',
      '--run-id', 'managed-dry-run',
      '--dry-run',
      '--skip-git-repo-check',
      '--spec-command', process.execPath,
      '--implementation-command', process.execPath,
      '--review-command', process.execPath,
      '--capability-router', 'shadow',
      '--control-root', controlRoot,
    ], { cwd: temporary, encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
    const dryRun = path.join(temporary, '.runs', 'managed-dry-run');
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(dryRun, 'managed-invocation.json'), 'utf8')),
      metadata
    );
    assert.match(fs.readFileSync(path.join(dryRun, 'prompts', 'spec.md'), 'utf8'), /Managed invocation authority/);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(dryRun, 'state.json'), 'utf8')).files.managedInvocation,
      'managed-invocation.json'
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(controlRoot, { recursive: true, force: true });
  }

  console.log('[OK] agent orchestrator managed invocation tests passed');
}

main();
