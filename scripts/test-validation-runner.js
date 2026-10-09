#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const validationRunner = require('./agent-orchestrator/validation-runner');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-validation-runner-'));

try {
  const workdir = path.join(root, 'workdir');
  const runDir = path.join(workdir, '.agent-runs', 'post-review');
  const authorityRunsRoot = path.join(root, 'control-root', 'runs');
  fs.mkdirSync(workdir, { recursive: true });

  assert.strictEqual(fs.existsSync(authorityRunsRoot), false);
  const result = validationRunner.runValidationCommands([], {
    workdir,
    runDir,
    authorityRunsRoot,
    attemptId: 'workdir-local-run',
    now: () => '2026-09-13T00:00:00.000Z',
  });

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(fs.existsSync(authorityRunsRoot), false);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(runDir, 'integration-validation.json'), 'utf8')),
    result
  );

  console.log('validation-runner: 3 passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
