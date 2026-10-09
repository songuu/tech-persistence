#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const validator = path.join(__dirname, 'validate-codex-plugin.js');

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function run(root) {
  return spawnSync(
    process.execPath,
    [validator, '--validate-agent-orchestrator-parity-only', root],
    { encoding: 'utf8' }
  );
}

function assertFailed(result, pattern, label) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.strictEqual(result.status, 1, `${label}: expected exit 1, got ${result.status}\n${output}`);
  assert.match(output, pattern, `${label}: missing diagnostic\n${output}`);
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orchestrator-parity-'));
try {
  const source = 'scripts/agent-orchestrator/queue.js';
  const scriptsTarget = 'plugins/tech-persistence/scripts/agent-orchestrator/queue.js';
  const codexHooksTarget = 'plugins/tech-persistence/codex-hooks/agent-orchestrator/queue.js';
  write(fixture, source, '// queue\n');
  write(fixture, scriptsTarget, '// queue\n');
  write(fixture, codexHooksTarget, '// queue\n');

  const clean = run(fixture);
  assert.strictEqual(
    clean.status,
    0,
    `synced projections should pass\nstdout=${clean.stdout}\nstderr=${clean.stderr}`
  );

  write(fixture, source, '// queue\r\n');
  write(fixture, scriptsTarget, '// queue\n');
  write(fixture, codexHooksTarget, '// queue\n');
  const normalized = run(fixture);
  assert.strictEqual(
    normalized.status,
    0,
    `CRLF source and builder-normalized LF targets should pass\nstdout=${normalized.stdout}\nstderr=${normalized.stderr}`
  );
  write(fixture, source, '// queue\n');

  for (const relative of [
    'scripts/agent-orchestrator/notes.txt',
    'plugins/tech-persistence/scripts/agent-orchestrator/notes.txt',
    'plugins/tech-persistence/codex-hooks/agent-orchestrator/notes.txt',
  ]) write(fixture, relative, 'mirrored but not buildable\n');
  assertFailed(run(fixture), /source agent orchestrator.*flat.*\.js|unsupported source entry/s, 'mirrored non-JavaScript source');
  for (const relative of [
    'scripts/agent-orchestrator/notes.txt',
    'plugins/tech-persistence/scripts/agent-orchestrator/notes.txt',
    'plugins/tech-persistence/codex-hooks/agent-orchestrator/notes.txt',
  ]) fs.unlinkSync(path.join(fixture, relative));

  for (const relative of [
    'scripts/agent-orchestrator/providers/nested.js',
    'plugins/tech-persistence/scripts/agent-orchestrator/providers/nested.js',
    'plugins/tech-persistence/codex-hooks/agent-orchestrator/providers/nested.js',
  ]) write(fixture, relative, '// mirrored nested file\n');
  assertFailed(run(fixture), /source agent orchestrator.*flat.*\.js|nested source entry/s, 'mirrored nested source');
  for (const relative of [
    'scripts/agent-orchestrator/providers',
    'plugins/tech-persistence/scripts/agent-orchestrator/providers',
    'plugins/tech-persistence/codex-hooks/agent-orchestrator/providers',
  ]) fs.rmSync(path.join(fixture, relative), { recursive: true, force: true });

  write(fixture, scriptsTarget, '// scripts drift\n');
  assertFailed(run(fixture), /plugin scripts agent orchestrator.*byte mismatch: queue\.js/s, 'scripts drift');
  write(fixture, scriptsTarget, '// queue\n');

  write(fixture, codexHooksTarget, '// codex hooks drift\n');
  assertFailed(run(fixture), /Codex hooks agent orchestrator.*byte mismatch: queue\.js/s, 'Codex hooks drift');
  write(fixture, codexHooksTarget, '// queue\n');

  write(fixture, 'plugins/tech-persistence/scripts/agent-orchestrator/orphan.txt', 'orphan\n');
  assertFailed(run(fixture), /plugin scripts agent orchestrator.*unsupported entry: orphan\.txt/s, 'scripts orphan');
  fs.unlinkSync(path.join(fixture, 'plugins/tech-persistence/scripts/agent-orchestrator/orphan.txt'));

  write(fixture, 'plugins/tech-persistence/codex-hooks/agent-orchestrator/orphan.txt', 'orphan\n');
  assertFailed(run(fixture), /Codex hooks agent orchestrator.*unsupported entry: orphan\.txt/s, 'Codex hooks orphan');
  fs.unlinkSync(path.join(fixture, 'plugins/tech-persistence/codex-hooks/agent-orchestrator/orphan.txt'));

  const codexHooksDir = path.join(fixture, 'plugins/tech-persistence/codex-hooks/agent-orchestrator');
  fs.rmSync(codexHooksDir, { recursive: true, force: true });
  fs.symlinkSync(
    path.join(fixture, 'scripts/agent-orchestrator'),
    codexHooksDir,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assertFailed(run(fixture), /Codex hooks agent orchestrator.*real directory|unsupported.*entry/s, 'Codex hooks symlink');

  console.log('[PASS] Codex plugin validator enforces both agent-orchestrator projections');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
