#!/usr/bin/env node

/**
 * test-skill-eval-cases.js
 *
 * Self-contained tests for native-user-event → eval case sinking (lib level):
 * canonical journal authority, defense-in-depth redaction, path-escape defense,
 * strict corruption/link rejection, and repeatable source revalidation.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  addCase,
  readCases,
  resolveCasesFile,
  verifyCaseAuthority,
} = require('./lib/skill-eval-cases');
const {
  appendBehaviorEvent,
  createBehaviorEvent,
} = require('./lib/behavior-events');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const {
  appendRecord,
  resolveStoreDir,
  tombstoneEntity,
} = require('./lib/self-learning-store');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-eval-cases-'));
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-eval-cases-workspace-'));
}

let authoritySequence = 0;
function seedPromptAuthority({
  baseDir,
  cwd,
  input,
  actorOverride,
  source = 'codex_cli',
  sourceAssurance = 'explicit',
  runtime = 'codex',
} = {}) {
  authoritySequence += 1;
  const project = detectStableProjectIdentity(cwd);
  const event = createBehaviorEvent({
    source_event_id: `eval-case-prompt-${authoritySequence}`,
    project_id: project.id,
    session_id: `eval-case-session-${authoritySequence}`,
    task_ref: null,
    turn_ref: `eval-case-turn-${authoritySequence}`,
    parent_event_id: null,
    actor: { kind: 'user', id: 'user', role: null },
    runtime,
    source,
    source_assurance: sourceAssurance,
    scope: { level: 'session', id: `eval-case-session-${authoritySequence}` },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { fixture: 'skill-eval-case-authority' },
    input_value: input,
    output_value: null,
    evidence_refs: [],
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, authoritySequence)).toISOString(),
  });
  const storeDir = resolveStoreDir(baseDir, project.id);
  const write = actorOverride
    ? appendRecord(storeDir, {
      record_type: 'behavior_event',
      record_id: event.event_id,
      entity_id: event.event_id,
      actor: actorOverride,
      occurred_at: event.occurred_at,
      payload: event,
    })
    : appendBehaviorEvent(storeDir, event);
  return {
    cwd,
    event,
    project,
    record: write.record,
    storeDir,
    options: { baseDir, cwd, projectId: project.id },
  };
}

function addAuthorizedCase(name, input, context = {}) {
  const baseDir = context.baseDir || makeBaseDir();
  const cwd = context.cwd || makeWorkspace();
  const authority = seedPromptAuthority({ baseDir, cwd, input: input.input });
  return {
    ...addCase(name, {
      ...input,
      source_event_ref: authority.event.event_id,
    }, authority.options),
    authority,
  };
}

test('addCase writes schema v2 with only server-derived BehaviorEvent authority', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const authority = seedPromptAuthority({ baseDir, cwd, input: 'screenshot of dashboard' });
  const { record, casesFile } = addCase(
    'prototype',
    {
      input: 'screenshot of dashboard',
      expectation: 'asks <= 5 questions',
      source_event_ref: authority.event.event_id,
    },
    authority.options
  );
  assert.strictEqual(record.schema_version, '2.0');
  assert.strictEqual(record.name, 'prototype');
  assert.strictEqual(record.provenance, 'behavior_event');
  assert.strictEqual(record.input, 'screenshot of dashboard');
  assert.deepStrictEqual(record.source_trace, {
    schema_version: 'self-learning-eval-case-source-v1',
    source_event_ref: authority.event.event_id,
    journal_record_hash: authority.record.record_hash,
    input_digest: authority.event.input_digest,
    occurred_at: authority.event.occurred_at,
  });
  assert.strictEqual(casesFile, resolveCasesFile('prototype', baseDir));
  const lines = fs.readFileSync(casesFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const verified = verifyCaseAuthority(record, authority.options);
  assert.strictEqual(verified.source_event.event_id, authority.event.event_id);
  assert.strictEqual(verified.source_record.record_hash, authority.record.record_hash);
});

test('addCase rejects caller snapshots and requires explicit project-bound event ref', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const project = detectStableProjectIdentity(cwd);
  assert.throws(
    () => addCase('sprint', {
      input: 'x',
      source_trace: { caller: 'self-declared' },
    }, { baseDir, cwd, projectId: project.id }),
    /source_trace.*not accepted|caller.*source_trace/i
  );
  assert.throws(
    () => addCase('sprint', { input: 'x' }, { baseDir, cwd, projectId: project.id }),
    /source_event_ref required/
  );
  assert.throws(
    () => addCase('sprint', {
      input: 'x',
      source_event_ref: `behavior-event:${'0'.repeat(64)}`,
    }, { baseDir, cwd }),
    /projectId required/
  );
});

test('addCase rejects empty/absent input', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const project = detectStableProjectIdentity(cwd);
  assert.throws(() => addCase('plan', {}, { baseDir, cwd, projectId: project.id }), /input required/);
  assert.throws(() => addCase('plan', { input: '' }, { baseDir, cwd, projectId: project.id }), /input required/);
});

test('addCase redacts caller fields while source_trace remains journal-derived', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const rawInput = 'before <private>secret-input</private> after';
  const authority = seedPromptAuthority({ baseDir, cwd, input: rawInput });
  addCase(
    'work',
    {
      input: rawInput,
      expectation: '<system-private>token-exp</system-private>',
      id: '<private>secret-id</private>',
      tags: ['<private>secret-tag</private>'],
      source_event_ref: authority.event.event_id,
    },
    authority.options
  );
  const serialized = fs.readFileSync(resolveCasesFile('work', baseDir), 'utf8');
  assert.ok(!serialized.includes('secret-input'), serialized);
  assert.ok(!serialized.includes('token-exp'), serialized);
  assert.ok(!serialized.includes('secret-id'), serialized);
  assert.ok(!serialized.includes('secret-tag'), serialized);
  assert.ok(serialized.includes('[PRIVATE REDACTED]'));
  assert.ok(serialized.includes('[SYSTEM PRIVATE REDACTED]'));
});

test('readCases returns records in append order', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  addAuthorizedCase('evolve', { input: 'a', id: 'c1' }, { baseDir, cwd });
  addAuthorizedCase('evolve', { input: 'b', id: 'c2' }, { baseDir, cwd });
  const records = readCases('evolve', { baseDir });
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].input, 'a');
  assert.strictEqual(records[1].input, 'b');
});

test('readCases returns empty when no cases file exists', () => {
  const baseDir = makeBaseDir();
  assert.deepStrictEqual(readCases('think', { baseDir }), []);
});

test('readCases and addCase fail closed on malformed existing lines', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  addAuthorizedCase('compound', { input: 'a' }, { baseDir, cwd });
  fs.appendFileSync(resolveCasesFile('compound', baseDir), 'not-json\n');
  assert.throws(() => readCases('compound', { baseDir }), /malformed|corrupt/i);
  const authority = seedPromptAuthority({ baseDir, cwd, input: 'b' });
  assert.throws(
    () => addCase('compound', {
      input: 'b',
      source_event_ref: authority.event.event_id,
    }, authority.options),
    /malformed|corrupt/i
  );
});

test('case ids are unique and linked case artifacts are rejected', () => {
  const duplicateBase = makeBaseDir();
  const duplicateCwd = makeWorkspace();
  addAuthorizedCase('compound', { id: 'case-a', input: 'a' }, { baseDir: duplicateBase, cwd: duplicateCwd });
  const duplicateAuthority = seedPromptAuthority({ baseDir: duplicateBase, cwd: duplicateCwd, input: 'b' });
  assert.throws(
    () => addCase('compound', {
      id: 'case-a', input: 'b', source_event_ref: duplicateAuthority.event.event_id,
    }, duplicateAuthority.options),
    /duplicate case id/i
  );

  const linkedBase = makeBaseDir();
  const linkedCwd = makeWorkspace();
  addAuthorizedCase('compound', { id: 'case-a', input: 'a' }, { baseDir: linkedBase, cwd: linkedCwd });
  const casesFile = resolveCasesFile('compound', linkedBase);
  fs.linkSync(casesFile, path.join(linkedBase, 'external-cases.jsonl'));
  assert.throws(() => readCases('compound', { baseDir: linkedBase }), /nlink|hardlink|link count/i);
});

test('invalid skill name is rejected (path escape defense)', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const project = detectStableProjectIdentity(cwd);
  assert.throws(() => addCase('../escape', { input: 'x' }, { baseDir, cwd, projectId: project.id }));
  assert.throws(() => resolveCasesFile('A.B', baseDir));
});

test('authority verification rejects input drift, old schema, source-trace tampering, and project mismatch', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const { record, authority } = addAuthorizedCase('review', { input: 'review this change' }, { baseDir, cwd });
  assert.throws(
    () => addCase('review', {
      input: 'different input',
      source_event_ref: authority.event.event_id,
    }, authority.options),
    /input digest.*does not match/i
  );
  assert.throws(
    () => verifyCaseAuthority({ ...record, schema_version: '1.0' }, authority.options),
    /schema_version.*not authoritative/i
  );
  assert.throws(
    () => verifyCaseAuthority({
      ...record,
      source_trace: { ...record.source_trace, journal_record_hash: `sha256:${'0'.repeat(64)}` },
    }, authority.options),
    /source_trace.*does not match/i
  );
  const otherCwd = makeWorkspace();
  assert.throws(
    () => verifyCaseAuthority(record, { ...authority.options, cwd: otherCwd }),
    /project.*mismatch/i
  );
});

test('authority verification rejects tombstoned events and journal actor drift', () => {
  const baseDir = makeBaseDir();
  const cwd = makeWorkspace();
  const active = seedPromptAuthority({ baseDir, cwd, input: 'active input' });
  const { record } = addCase('sprint', {
    id: 'active-case',
    input: 'active input',
    source_event_ref: active.event.event_id,
  }, active.options);
  tombstoneEntity(active.storeDir, {
    record_id: `tombstone:${active.event.event_id}`,
    target_id: active.event.event_id,
    target_hash: active.record.record_hash,
    actor: { kind: 'user', id: 'user', runtime: 'codex', authority_ref: active.event.source_event_id },
    occurred_at: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    reason: 'fixture retirement',
  });
  assert.throws(() => verifyCaseAuthority(record, active.options), /not active|tombston/i);

  const forgedBase = makeBaseDir();
  const forgedCwd = makeWorkspace();
  const forged = seedPromptAuthority({
    baseDir: forgedBase,
    cwd: forgedCwd,
    input: 'forged actor input',
    actorOverride: { kind: 'agent', id: 'forged', runtime: 'codex', authority_ref: null },
  });
  assert.throws(
    () => addCase('work', {
      input: 'forged actor input',
      source_event_ref: forged.event.event_id,
    }, forged.options),
    /journal actor.*match|trusted.*actor/i
  );
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
