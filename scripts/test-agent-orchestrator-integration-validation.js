#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const validationPolicy = require('./agent-orchestrator/validation-command-policy');

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function hashText(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertRejected(decision, pattern) {
  assert.strictEqual(decision.ok, false, `expected policy rejection: ${decision.command}`);
  assert.match(decision.reason, pattern);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-integration-validation-'));

try {
  writeText(path.join(root, 'package.json'), `${JSON.stringify({
    scripts: {
      test: 'node scripts/safe-validation.js',
      'validation:check': 'node scripts/safe-validation.js --package-script',
      'validation:unsafe-body': 'node scripts/deploy.js',
      'validation:unsafe-shell': 'powershell -Command Get-ChildItem',
      'validation:nested-unsafe': 'npm run validation:unsafe-body',
      deploy: 'node scripts/safe-validation.js',
    },
  }, null, 2)}\n`);
  writeText(path.join(root, 'scripts', 'safe-validation.js'), "console.log('safe');\n");
  writeText(path.join(root, 'scripts', 'deploy.js'), "console.log('must not run');\n");

  const quoted = validationPolicy.validateGeneratedValidationCommand(
    'node "scripts/safe-validation.js" --label "value with spaces"',
    { workdir: root }
  );
  assert.strictEqual(quoted.ok, true);
  assert.deepStrictEqual(quoted.argv, [
    'node', 'scripts/safe-validation.js', '--label', 'value with spaces',
  ]);
  assert.strictEqual(quoted.kind, 'repo-node-script');

  assert.strictEqual(
    validationPolicy.validateGeneratedValidationCommand('npm test', { workdir: root }).ok,
    true
  );
  assert.strictEqual(
    validationPolicy.validateGeneratedValidationCommand(
      'pnpm run validation:check -- --focused',
      { workdir: root }
    ).ok,
    true
  );
  assert.strictEqual(
    validationPolicy.validateGeneratedValidationCommand('git diff --check', { workdir: root }).ok,
    true
  );

  assertRejected(
    validationPolicy.validateGeneratedValidationCommand('node scripts/deploy.js', { workdir: root }),
    /deploy|eligible|forbidden/i
  );
  assertRejected(
    validationPolicy.validateGeneratedValidationCommand(
      'npm run validation:unsafe-body',
      { workdir: root }
    ),
    /deploy|eligible|forbidden/i
  );
  assertRejected(
    validationPolicy.validateGeneratedValidationCommand(
      'npm run validation:unsafe-shell',
      { workdir: root }
    ),
    /allowlist|executable|eligible|forbidden/i
  );
  assertRejected(
    validationPolicy.validateGeneratedValidationCommand(
      'npm run validation:nested-unsafe',
      { workdir: root }
    ),
    /deploy|eligible|forbidden/i
  );
  assertRejected(
    validationPolicy.validateGeneratedValidationCommand('npm run deploy', { workdir: root }),
    /deploy|eligible|forbidden/i
  );
  assertRejected(
    validationPolicy.validateGeneratedValidationCommand(
      'node scripts/safe-validation.js --reset-cache',
      { workdir: root }
    ),
    /reset|eligible|forbidden/i
  );
  for (const action of ['publish', 'deploy', 'migrate', 'install', 'seed', 'reset']) {
    assertRejected(
      validationPolicy.validateGeneratedValidationCommand(
        `node scripts/${action}.js`,
        { workdir: root }
      ),
      new RegExp(`${action}|eligible|forbidden`, 'i')
    );
  }
  assertRejected(
    validationPolicy.validateGeneratedValidationCommand(
      'node scripts/safe-validation.js; node scripts/deploy.js',
      { workdir: root }
    ),
    /shell operators/i
  );
  assertRejected(
    validationPolicy.validateGeneratedValidationCommand(
      'node "scripts/safe-validation.js',
      { workdir: root }
    ),
    /quote/i
  );
  assertRejected(
    validationPolicy.validateGeneratedValidationCommand('node -e "process.exit(0)"', { workdir: root }),
    /repository script|allowlist/i
  );

  const validationRunner = require('./agent-orchestrator/validation-runner');

  let blockedSpawnCalls = 0;
  const blockedRunDir = path.join(root, '.agent-runs', 'blocked');
  const blocked = validationRunner.runValidationCommands([
    'node scripts/safe-validation.js',
    'node scripts/deploy.js',
  ], {
    workdir: root,
    runDir: blockedRunDir,
    attemptId: 'blocked',
    now: () => '2026-08-27T01:00:00.000Z',
    spawnSyncImpl: () => {
      blockedSpawnCalls += 1;
      return { status: 0, signal: null, stdout: '', stderr: '', error: null };
    },
  });
  assert.strictEqual(blocked.status, 'blocked');
  assert.strictEqual(blockedSpawnCalls, 0, 'policy rejection must prevent every command launch');
  assert.strictEqual(blocked.commands[0].status, 'not-run');
  assert.strictEqual(blocked.commands[1].status, 'blocked');
  assert.strictEqual(blocked.commands[1].policy.ok, false);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(blockedRunDir, 'integration-validation.json'), 'utf8')),
    blocked
  );

  let observedLaunch = null;
  const passedRunDir = path.join(root, '.agent-runs', 'passed');
  const passed = validationRunner.runValidationCommands([
    'node "scripts/safe-validation.js" --label "value with spaces"',
  ], {
    workdir: root,
    runDir: passedRunDir,
    attemptId: 'passed',
    timeoutMs: 1_234,
    now: () => '2026-08-27T01:01:00.000Z',
    spawnSyncImpl: (command, argv, options) => {
      observedLaunch = { command, argv, options };
      return {
        status: 0,
        signal: null,
        stdout: 'api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456\nvalidation ok\n',
        stderr: 'diagnostic\n',
        error: null,
      };
    },
  });
  assert.strictEqual(passed.status, 'passed');
  assert.strictEqual(observedLaunch.command, 'node');
  assert.deepStrictEqual(observedLaunch.argv, [
    'scripts/safe-validation.js', '--label', 'value with spaces',
  ]);
  assert.strictEqual(observedLaunch.options.shell, false);
  assert.strictEqual(observedLaunch.options.cwd, root);
  assert.strictEqual(observedLaunch.options.timeout, 1_234);
  assert.strictEqual(passed.commands[0].status, 'passed');
  assert.strictEqual(passed.commands[0].exitStatus, 0);
  assert.strictEqual(passed.commands[0].timedOut, false);
  assert.deepStrictEqual(passed.commands[0].argv, [
    'node', 'scripts/safe-validation.js', '--label', 'value with spaces',
  ]);

  const stdoutEvidence = passed.commands[0].stdout;
  const stderrEvidence = passed.commands[0].stderr;
  assert.strictEqual(stdoutEvidence.ref, 'logs/integration-validation-passed-0.stdout.log');
  assert.strictEqual(stderrEvidence.ref, 'logs/integration-validation-passed-0.stderr.log');
  const persistedStdout = fs.readFileSync(path.join(passedRunDir, stdoutEvidence.ref), 'utf8');
  const persistedStderr = fs.readFileSync(path.join(passedRunDir, stderrEvidence.ref), 'utf8');
  assert.doesNotMatch(persistedStdout, /sk-proj-/);
  assert.match(persistedStdout, /\[REDACTED\]/);
  assert.strictEqual(stdoutEvidence.hash, hashText(persistedStdout));
  assert.strictEqual(stderrEvidence.hash, hashText(persistedStderr));
  assert.strictEqual(stdoutEvidence.bytes, Buffer.byteLength(persistedStdout, 'utf8'));
  assert.strictEqual(stderrEvidence.bytes, Buffer.byteLength(persistedStderr, 'utf8'));

  const actualRunDir = path.join(root, '.agent-runs', 'actual');
  const actual = validationRunner.runValidationCommands([
    'node scripts/safe-validation.js',
  ], {
    workdir: root,
    runDir: actualRunDir,
    attemptId: 'actual',
  });
  if (actual.status === 'passed') {
    assert.strictEqual(actual.commands[0].exitStatus, 0);
    assert.match(
      fs.readFileSync(path.join(actualRunDir, actual.commands[0].stdout.ref), 'utf8'),
      /safe/
    );
  } else {
    assert.strictEqual(actual.status, 'failed');
    assert.strictEqual(actual.commands[0].status, 'launch-error');
    assert.match(actual.commands[0].error, /EPERM/);
  }

  const failedRunDir = path.join(root, '.agent-runs', 'failed');
  const failed = validationRunner.runValidationCommands([
    'node scripts/safe-validation.js',
  ], {
    workdir: root,
    runDir: failedRunDir,
    attemptId: 'failed',
    now: () => '2026-08-27T01:02:00.000Z',
    spawnSyncImpl: () => ({
      status: 2,
      signal: null,
      stdout: 'assertion failed\n',
      stderr: 'expected true\n',
      error: null,
    }),
  });
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.commands[0].status, 'failed');
  assert.strictEqual(failed.commands[0].exitStatus, 2);
  assert.strictEqual(failed.commands[0].timedOut, false);

  const timeoutError = new Error('spawnSync node ETIMEDOUT');
  timeoutError.code = 'ETIMEDOUT';
  const timedOut = validationRunner.runValidationCommands([
    'node scripts/safe-validation.js',
  ], {
    workdir: root,
    runDir: path.join(root, '.agent-runs', 'timeout'),
    attemptId: 'timeout',
    timeoutMs: 25,
    now: () => '2026-08-27T01:03:00.000Z',
    spawnSyncImpl: () => ({
      status: null,
      signal: 'SIGTERM',
      stdout: 'partial\n',
      stderr: '',
      error: timeoutError,
    }),
  });
  assert.strictEqual(timedOut.status, 'failed');
  assert.strictEqual(timedOut.commands[0].status, 'timeout');
  assert.strictEqual(timedOut.commands[0].exitStatus, null);
  assert.strictEqual(timedOut.commands[0].timedOut, true);
  assert.match(timedOut.commands[0].error, /ETIMEDOUT/);

  const launchError = new Error('spawnSync node ENOENT');
  launchError.code = 'ENOENT';
  const launchFailed = validationRunner.runValidationCommands([
    'node scripts/safe-validation.js',
  ], {
    workdir: root,
    runDir: path.join(root, '.agent-runs', 'launch-error'),
    attemptId: 'launch-error',
    now: () => '2026-08-27T01:04:00.000Z',
    spawnSyncImpl: () => ({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: launchError,
    }),
  });
  assert.strictEqual(launchFailed.status, 'failed');
  assert.strictEqual(launchFailed.commands[0].status, 'launch-error');
  assert.strictEqual(launchFailed.commands[0].timedOut, false);
  assert.match(launchFailed.commands[0].error, /ENOENT/);

  const skippedRunDir = path.join(root, '.agent-runs', 'skipped');
  const skipped = validationRunner.runValidationCommands([], {
    workdir: root,
    runDir: skippedRunDir,
    attemptId: 'skipped',
    now: () => '2026-08-27T01:05:00.000Z',
  });
  assert.strictEqual(skipped.status, 'skipped');
  assert.deepStrictEqual(skipped.commands, []);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(skippedRunDir, 'integration-validation.json'), 'utf8')),
    skipped
  );

  assert.throws(
    () => validationRunner.runValidationCommands(['node scripts/safe-validation.js'], {
      workdir: root,
    }),
    /runDir/
  );

  const invalidInputRunDir = path.join(root, '.agent-runs', 'invalid-input');
  assert.throws(
    () => validationRunner.runValidationCommands(['node scripts/safe-validation.js'], {
      workdir: root,
      runDir: invalidInputRunDir,
      attemptId: '../escape',
    }),
    /attemptId/
  );
  assert.strictEqual(
    fs.existsSync(invalidInputRunDir),
    false,
    'invalid pure inputs must be rejected before creating run artifacts'
  );

  console.log('agent-orchestrator-integration-validation: 55 passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
