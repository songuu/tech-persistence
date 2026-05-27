#!/usr/bin/env node

/**
 * test-redaction.js
 *
 * Self-contained tests for privacy tag stripping before observations persist.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { redactObservation, stripPrivateTags } = require('./lib/redaction');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-redaction-'));
}

function findObservationFile(root) {
  const projectsDir = path.join(root, 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  for (const projectId of fs.readdirSync(projectsDir)) {
    const obsPath = path.join(projectsDir, projectId, 'observations.jsonl');
    if (fs.existsSync(obsPath)) return obsPath;
  }
  return null;
}

test('stripPrivateTags redacts private and system-private blocks', () => {
  const input = [
    'before',
    '<private>launch-window-seven</private>',
    '<system-private>internal-policy</system-private>',
    'after',
  ].join(' ');
  const output = stripPrivateTags(input);
  assert.ok(!output.includes('launch-window-seven'));
  assert.ok(!output.includes('internal-policy'));
  assert.ok(output.includes('[PRIVATE REDACTED]'));
  assert.ok(output.includes('[SYSTEM PRIVATE REDACTED]'));
});

test('stripPrivateTags handles multiline claude-mem-context blocks', () => {
  const output = stripPrivateTags('a <claude-mem-context>\nsecret context\n</claude-mem-context> b');
  assert.ok(!output.includes('secret context'));
  assert.ok(output.includes('[CLAUDE MEM CONTEXT REDACTED]'));
});

test('stripPrivateTags redacts unclosed tags to end of string', () => {
  const output = stripPrivateTags('visible <private>hidden forever');
  assert.strictEqual(output, 'visible [PRIVATE REDACTED]');
});

test('redactObservation strips summaries, commands, and private paths', () => {
  const redacted = redactObservation({
    input_summary: 'run <private>secret arg</private>',
    output_summary: 'ok <system-private>policy</system-private>',
    command: 'echo <private>secret command</private>',
    input_paths: ['docs/readme.md', '<private>C:\\secret\\key.txt</private>'],
  });
  assert.ok(!JSON.stringify(redacted).includes('secret arg'));
  assert.ok(!JSON.stringify(redacted).includes('secret command'));
  assert.ok(!JSON.stringify(redacted).includes('C:\\secret'));
  assert.deepStrictEqual(redacted.input_paths, ['docs/readme.md']);
});

test('observe hook never persists private tag contents', () => {
  const home = makeTempHome();
  const privateText = 'launch-window-seven';
  const contextText = 'session archaeology context';
  const payload = {
    tool_name: 'functions.shell_command',
    input: {
      command: `echo before <private>${privateText}</private> after`,
      file: `<private>C:\\secret\\key.txt</private>`,
    },
    output: `done <claude-mem-context>${contextText}</claude-mem-context>`,
    statusCode: 0,
  };

  const result = spawnSync(process.execPath, [path.join(__dirname, 'observe.js'), 'post'], {
    cwd: path.resolve(__dirname, '..'),
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      TECH_PERSISTENCE_HOME: home,
      CLAUDE_SESSION_ID: 'test-redaction-session',
    },
  });

  assert.strictEqual(result.status, 0, result.stderr);
  const obsPath = findObservationFile(home);
  assert.ok(obsPath, 'expected observations.jsonl to be written');
  const line = fs.readFileSync(obsPath, 'utf-8').trim();
  const observation = JSON.parse(line);
  const serialized = JSON.stringify(observation);
  assert.ok(!serialized.includes(privateText), serialized);
  assert.ok(!serialized.includes(contextText), serialized);
  assert.ok(!serialized.includes('C:\\secret'), serialized);
  assert.ok(serialized.includes('[PRIVATE REDACTED]'));
  assert.ok(serialized.includes('[CLAUDE MEM CONTEXT REDACTED]'));
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${err.stack || err.message}`);
  });
  process.exit(1);
}
