#!/usr/bin/env node

/**
 * test-skill-eval-cases-cli.js
 *
 * End-to-end tests for the skill-eval-cases CLI (add + list), focused on
 * canonical journal authority, exit-code policy, and process-boundary redaction.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'skill-eval-cases.js');
const { resolveCasesFile } = require('./lib/skill-eval-cases');
const { appendBehaviorEvent, createBehaviorEvent } = require('./lib/behavior-events');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { resolveStoreDir } = require('./lib/self-learning-store');

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

function makeBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-eval-cases-cli-'));
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-eval-cases-cli-workspace-'));
}

let authoritySequence = 0;
function seedPromptAuthority(baseDir, cwd, input) {
  authoritySequence += 1;
  const project = detectStableProjectIdentity(cwd);
  const sessionId = `eval-case-cli-session-${authoritySequence}`;
  const event = createBehaviorEvent({
    source_event_id: `eval-case-cli-prompt-${authoritySequence}`,
    project_id: project.id,
    session_id: sessionId,
    task_ref: null,
    turn_ref: `eval-case-cli-turn-${authoritySequence}`,
    parent_event_id: null,
    actor: { kind: 'user', id: 'user', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'session', id: sessionId },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { fixture: 'skill-eval-case-cli-authority' },
    input_value: input,
    output_value: null,
    evidence_refs: [],
    occurred_at: new Date(Date.UTC(2026, 0, 3, 0, 0, authoritySequence)).toISOString(),
  });
  appendBehaviorEvent(resolveStoreDir(baseDir, project.id), event);
  return event;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
  });
}

test('add writes a case and exits 0', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const event = seedPromptAuthority(baseDir, cwd, 'dashboard mockup');
  const r = runCli([
    'add', '--name', 'prototype', '--input', 'dashboard mockup',
    '--expectation', 'asks <=5 questions', '--source-event-ref', event.event_id, '--base-dir', baseDir,
  ], { cwd });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('added'));
  assert.ok(fs.existsSync(resolveCasesFile('prototype', baseDir)));
});

test('add exits 2 (usage) without --source-event-ref', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const r = runCli(['add', '--name', 'sprint', '--input', 'x', '--base-dir', baseDir], { cwd });
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(r.stderr.includes('source-event-ref'));
});

test('add rejects --from-trace even when a valid source event is also supplied', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const event = seedPromptAuthority(baseDir, cwd, 'x');
  const r = runCli([
    'add', '--name', 'work', '--input', 'x',
    '--source-event-ref', event.event_id,
    '--from-trace', JSON.stringify({ caller: 'self-declared' }),
    '--base-dir', baseDir,
  ], { cwd });
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.includes('from-trace'));
  assert.ok(!fs.existsSync(resolveCasesFile('work', baseDir)));
});

test('add exits 2 (usage) on missing --input', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const event = seedPromptAuthority(baseDir, cwd, 'unused');
  assert.strictEqual(
    runCli([
      'add', '--name', 'plan', '--source-event-ref', event.event_id, '--base-dir', baseDir,
    ], { cwd }).status,
    2
  );
});

test('add exits 2 (usage) on missing --name', () => {
  assert.strictEqual(runCli(['add', '--input', 'x', '--source-event-ref', 'behavior-event:missing']).status, 2);
});

test('add redacts private tags across the process boundary', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const input = 'before <private>input-secret</private> after';
  const event = seedPromptAuthority(baseDir, cwd, input);
  const r = runCli([
    'add', '--name', 'evolve', '--input', input,
    '--source-event-ref', event.event_id, '--base-dir', baseDir,
  ], { cwd });
  assert.strictEqual(r.status, 0, r.stderr);
  const serialized = fs.readFileSync(resolveCasesFile('evolve', baseDir), 'utf8');
  assert.ok(!serialized.includes('input-secret'), serialized);
  assert.ok(serialized.includes('[PRIVATE REDACTED]'));
});

test('add rejects an event whose redacted input digest differs', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const event = seedPromptAuthority(baseDir, cwd, 'original input');
  const r = runCli([
    'add', '--name', 'work', '--input', 'substituted input',
    '--source-event-ref', event.event_id, '--base-dir', baseDir,
  ], { cwd });
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(/input digest.*does not match/i.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(resolveCasesFile('work', baseDir)));
});

test('add exits 2 (usage) on invalid name (path escape)', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const event = seedPromptAuthority(baseDir, cwd, 'x');
  assert.strictEqual(
    runCli([
      'add', '--name', '../escape', '--input', 'x',
      '--source-event-ref', event.event_id, '--base-dir', baseDir,
    ], { cwd }).status,
    2
  );
});

test('list shows case count and exits 0', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const eventA = seedPromptAuthority(baseDir, cwd, 'a');
  const eventB = seedPromptAuthority(baseDir, cwd, 'b');
  runCli([
    'add', '--name', 'review', '--input', 'a', '--id', 'c1',
    '--source-event-ref', eventA.event_id, '--base-dir', baseDir,
  ], { cwd });
  runCli([
    'add', '--name', 'review', '--input', 'b', '--id', 'c2',
    '--source-event-ref', eventB.event_id, '--base-dir', baseDir,
  ], { cwd });
  const r = runCli(['list', 'review', '--base-dir', baseDir], { cwd });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('2 case(s)'));
});

test('list exits 0 with 0 cases when none exist', () => {
  const baseDir = makeBaseDir();
  const r = runCli(['list', 'think', '--base-dir', baseDir], { cwd: makeWorkspace() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('0 case(s)'));
});

test('unknown subcommand exits 2', () => {
  assert.strictEqual(runCli(['bogus']).status, 2);
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
