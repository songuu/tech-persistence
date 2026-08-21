#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const builderPath = path.join(
  __dirname,
  '..',
  'plugins',
  'tech-persistence',
  'scripts',
  'build-codex-plugin.js'
);
const validatorPath = path.join(__dirname, 'validate-codex-plugin.js');

function extractRunHookSource() {
  const builder = fs.readFileSync(builderPath, 'utf8');
  const match = builder.match(/const runHookJs = (`[\s\S]*?`);\r?\n\r?\nconst runHookCmd/);
  assert(match, 'builder runHookJs template was not found');
  return vm.runInNewContext(match[1]);
}

function run(wrapper, args = []) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, TECH_PERSISTENCE_RUNTIME: 'claude' },
  });
}

function assertFailOpen(result) {
  assert.strictEqual(result.status, 0, result.error && result.error.message || result.stderr);
  assert.strictEqual(result.signal, null);
}

function validateWrapper(wrapper) {
  return spawnSync(process.execPath, [
    validatorPath,
    '--validate-run-hook-only',
    wrapper,
  ], { encoding: 'utf8', windowsHide: true });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-run-hook-wrapper-'));
try {
  const hookDir = path.join(root, 'hooks');
  fs.mkdirSync(hookDir);
  const wrapper = path.join(hookDir, 'run-hook.js');
  const safeWrapperSource = extractRunHookSource();
  fs.writeFileSync(wrapper, safeWrapperSource);

  const safeValidation = validateWrapper(wrapper);
  assert.strictEqual(
    safeValidation.status,
    0,
    safeValidation.error && safeValidation.error.message || safeValidation.stderr
  );

  const extraAllowlistWrapper = path.join(root, 'run-hook-extra-allowlist.js');
  fs.writeFileSync(
    extraAllowlistWrapper,
    safeWrapperSource.replace('"prompt-submit.js"]', '"prompt-submit.js","unknown.js"]')
  );
  const extraAllowlistValidation = validateWrapper(extraAllowlistWrapper);
  assert.strictEqual(extraAllowlistValidation.status, 1);
  assert.match(extraAllowlistValidation.stderr, /exact managed hook script allowlist/);

  const rawStderrWrapper = path.join(root, 'run-hook-raw-stderr.js');
  fs.writeFileSync(
    rawStderrWrapper,
    safeWrapperSource.replace(
      "stdio: ['inherit', 'pipe', 'pipe']",
      "stdio: 'inherit' // result.stderr"
    )
  );
  const rawStderrValidation = validateWrapper(rawStderrWrapper);
  assert.strictEqual(rawStderrValidation.status, 1);
  assert.match(rawStderrValidation.stderr, /capture child stdout\/stderr|never forward child raw stderr/);

  const escapedMarker = path.join(root, 'escaped-marker.txt');
  fs.writeFileSync(path.join(root, 'outside.js'), [
    "'use strict';",
    `require('fs').writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped');`,
  ].join('\n'));
  const traversal = run(wrapper, ['../outside.js']);
  assertFailOpen(traversal);
  assert.strictEqual(fs.existsSync(escapedMarker), false, 'path traversal executed outside the hook root');
  assert.strictEqual(traversal.stdout, '');
  assert.match(traversal.stderr, /^\[run-hook\] SCRIPT_NOT_ALLOWED\n$/);

  const unknownMarker = path.join(root, 'unknown-marker.txt');
  fs.writeFileSync(path.join(hookDir, 'unknown.js'), [
    "'use strict';",
    `require('fs').writeFileSync(${JSON.stringify(unknownMarker)}, 'unknown');`,
  ].join('\n'));
  const unknown = run(wrapper, ['unknown.js']);
  assertFailOpen(unknown);
  assert.strictEqual(fs.existsSync(unknownMarker), false, 'non-allowlisted sibling script executed');
  assert.match(unknown.stderr, /^\[run-hook\] SCRIPT_NOT_ALLOWED\n$/);

  const rawSecret = 'raw-child-secret-837492';
  fs.writeFileSync(path.join(hookDir, 'prompt-submit.js'), [
    "'use strict';",
    `process.stderr.write(${JSON.stringify(rawSecret)} + '\\n');`,
    "if (process.argv[2] === 'fail') { process.stdout.write('discard-me'); process.exit(9); }",
    "process.stdout.write('hook-ok');",
  ].join('\n'));

  const success = run(wrapper, ['prompt-submit.js', 'success']);
  assertFailOpen(success);
  assert.strictEqual(success.stdout, 'hook-ok');
  assert.strictEqual(success.stderr, '', 'successful child raw stderr must be discarded');

  const failed = run(wrapper, ['prompt-submit.js', 'fail']);
  assertFailOpen(failed);
  assert.strictEqual(failed.stdout, '', 'failed child stdout must not escape the wrapper');
  assert.match(failed.stderr, /^\[run-hook\] CHILD_FAILED\n$/);
  assert(!failed.stderr.includes(rawSecret));
  assert(Buffer.byteLength(failed.stderr, 'utf8') <= 128);

  const missingAllowed = run(wrapper, ['codex-lifecycle-evidence.js']);
  assertFailOpen(missingAllowed);
  assert.strictEqual(missingAllowed.stdout, '');
  assert.match(missingAllowed.stderr, /^\[run-hook\] CHILD_FAILED\n$/);
  assert(!missingAllowed.stderr.includes(hookDir));

  fs.writeFileSync(path.join(hookDir, 'observe.js'), [
    "'use strict';",
    "process.stderr.write('x'.repeat(1024 * 1024 + 1));",
  ].join('\n'));
  const overflow = run(wrapper, ['observe.js']);
  assertFailOpen(overflow);
  assert.strictEqual(overflow.stdout, '');
  assert.match(overflow.stderr, /^\[run-hook\] SPAWN_FAILED\n$/);
  assert(Buffer.byteLength(overflow.stderr, 'utf8') <= 128);

  const missing = run(wrapper);
  assertFailOpen(missing);
  assert.strictEqual(missing.stdout, '');
  assert.strictEqual(missing.stderr, '');

  console.log('run-hook wrapper tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
