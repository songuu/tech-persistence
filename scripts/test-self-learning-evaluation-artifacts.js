#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addCase, readCases, resolveCasesFile } = require('./lib/skill-eval-cases');
const { appendBehaviorEvent } = require('./lib/behavior-events');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { stableHash } = require('./lib/self-learning-canonical');
const { resolveStoreDir, tombstoneEntity } = require('./lib/self-learning-store');
const {
  assertEvaluationArtifactAuthority,
  readEvaluationArtifactAuthority,
  resolveEvaluationArtifactFile,
  stageEvaluationArtifactAuthority,
} = require('./lib/self-learning-evaluation-artifacts');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function baseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-evaluation-artifact-'));
}

function candidateId(label = '1') {
  return `lc-${String(label).padStart(32, '0')}`;
}

const TEST_CWD = path.resolve(__dirname, '..');
const TEST_PROJECT_ID = detectStableProjectIdentity(TEST_CWD).id;

function authorityOptions(home) {
  return { baseDir: home, projectId: TEST_PROJECT_ID, cwd: TEST_CWD };
}

function seedCase(home, name, id, input, index) {
  const storeDir = resolveStoreDir(home, TEST_PROJECT_ID);
  const append = appendBehaviorEvent(storeDir, {
    project_id: TEST_PROJECT_ID,
    session_id: `session-eval-case-${index}`,
    task_ref: `task-eval-case-${index}`,
    turn_ref: `turn-eval-case-${index}`,
    parent_event_id: null,
    actor: { kind: 'user', id: 'user:test', role: 'requester' },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: `task-eval-case-${index}` },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { fixture: id },
    input_value: input,
    output_value: null,
    evidence_refs: [],
    occurred_at: `2026-08-21T02:00:${String(index).padStart(2, '0')}.000Z`,
    source_event_id: `native-eval-case-${index}`,
  });
  addCase(name, {
    id,
    input,
    source_event_ref: append.event.event_id,
  }, authorityOptions(home));
  return { ...append, storeDir };
}

function seedCases(home, name = 'sprint') {
  return [
    seedCase(home, name, 'case-a', 'A', 1),
    seedCase(home, name, 'case-b', 'B', 2),
  ];
}

test('stage derives exact case authority and JSON clones cannot forge its process brand', () => {
  const home = baseDir();
  const id = candidateId('1');
  seedCases(home);
  const staged = stageEvaluationArtifactAuthority('sprint', id, [
    { case_id: 'case-b', passed: false },
    { case_id: 'case-a', passed: true },
  ], authorityOptions(home));
  assert.strictEqual(staged.changed, true);
  const authority = assertEvaluationArtifactAuthority(staged.authority);
  assert.strictEqual(authority.project_id, TEST_PROJECT_ID);
  assert.strictEqual(authority.case_count, 2);
  assert.strictEqual(authority.passed_count, 1);
  assert.strictEqual(authority.pass_rate, 0.5);
  assert.match(authority.case_set_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(authority.case_results_hash, /^sha256:[a-f0-9]{64}$/);
  const persisted = JSON.parse(fs.readFileSync(
    resolveEvaluationArtifactFile('sprint', id, home),
    'utf8'
  ));
  assert.strictEqual(persisted.schema_version, 'self-learning-evaluation-artifact-v2');
  assert.strictEqual(persisted.project_id, TEST_PROJECT_ID);
  assert.strictEqual(
    persisted.case_set_hash,
    stableHash({ project_id: TEST_PROJECT_ID, cases: readCases('sprint', { baseDir: home }) })
  );
  assert.throws(
    () => assertEvaluationArtifactAuthority(JSON.parse(JSON.stringify(authority))),
    /brand|authority/i
  );
  assert.deepStrictEqual(
    assertEvaluationArtifactAuthority(readEvaluationArtifactAuthority('sprint', id, authorityOptions(home))),
    authority
  );
});

test('stage requires results to cover every unique case id exactly once', () => {
  const home = baseDir();
  const id = candidateId('2');
  seedCases(home);
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', id, [{ case_id: 'case-a', passed: true }], authorityOptions(home)),
    /exactly cover|missing/i
  );
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', id, [
      { case_id: 'case-a', passed: true },
      { case_id: 'case-a', passed: false },
      { case_id: 'case-b', passed: true },
    ], authorityOptions(home)),
    /duplicate/i
  );
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', id, [
      { case_id: 'case-a', passed: true },
      { case_id: 'case-b', passed: true },
      { case_id: 'case-extra', passed: true },
    ], authorityOptions(home)),
    /exactly cover|extra/i
  );
});

test('stage is LF-stable, idempotent, and refuses a conflicting no-clobber retry', () => {
  const home = baseDir();
  const id = candidateId('3');
  seedCases(home);
  const results = [
    { case_id: 'case-a', passed: true },
    { case_id: 'case-b', passed: true },
  ];
  const first = stageEvaluationArtifactAuthority('sprint', id, results, authorityOptions(home));
  const retry = stageEvaluationArtifactAuthority('sprint', id, [...results].reverse(), authorityOptions(home));
  assert.strictEqual(first.changed, true);
  assert.strictEqual(retry.changed, false);
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', id, [
      { case_id: 'case-a', passed: false },
      { case_id: 'case-b', passed: true },
    ], authorityOptions(home)),
    /overwrite|different/i
  );
});

test('strict case and result readers reject corrupt, linked, and externally hardlinked artifacts', () => {
  const corruptHome = baseDir();
  seedCases(corruptHome);
  const corruptFile = resolveCasesFile('sprint', corruptHome);
  fs.appendFileSync(corruptFile, 'not-json\n');
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', candidateId('4'), [], authorityOptions(corruptHome)),
    /malformed|corrupt/i
  );

  const linkedHome = baseDir();
  seedCases(linkedHome);
  const casesFile = resolveCasesFile('sprint', linkedHome);
  const externalLink = path.join(linkedHome, 'cases-hardlink.jsonl');
  fs.linkSync(casesFile, externalLink);
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', candidateId('5'), [], authorityOptions(linkedHome)),
    /link count|hardlink|nlink/i
  );

  const resultHome = baseDir();
  seedCases(resultHome);
  const id = candidateId('6');
  stageEvaluationArtifactAuthority('sprint', id, [
    { case_id: 'case-a', passed: true },
    { case_id: 'case-b', passed: false },
  ], authorityOptions(resultHome));
  const resultFile = resolveEvaluationArtifactFile('sprint', id, resultHome);
  fs.linkSync(resultFile, path.join(resultHome, 'result-hardlink.json'));
  assert.throws(
    () => readEvaluationArtifactAuthority('sprint', id, authorityOptions(resultHome)),
    /link count|hardlink|nlink/i
  );
});

test('case file must be nonempty and case ids must be unique', () => {
  const emptyHome = baseDir();
  const emptyFile = resolveCasesFile('sprint', emptyHome);
  fs.mkdirSync(path.dirname(emptyFile), { recursive: true });
  fs.writeFileSync(emptyFile, '');
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', candidateId('7'), [], authorityOptions(emptyHome)),
    /nonempty|empty/i
  );

  const duplicateHome = baseDir();
  seedCase(duplicateHome, 'sprint', 'case-a', 'A', 3);
  const duplicateFile = resolveCasesFile('sprint', duplicateHome);
  const first = fs.readFileSync(duplicateFile, 'utf8');
  fs.appendFileSync(duplicateFile, first);
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', candidateId('8'), [
      { case_id: 'case-a', passed: true },
    ], authorityOptions(duplicateHome)),
    /duplicate case id/i
  );
});

test('stage and read require an explicit project id for journal revalidation', () => {
  const home = baseDir();
  const id = candidateId('9');
  seedCases(home);
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', id, [
      { case_id: 'case-a', passed: true },
      { case_id: 'case-b', passed: true },
    ], { baseDir: home }),
    /projectId|required|project/i
  );
});

test('stage rejects a case whose input was edited after journal-bound creation', () => {
  const home = baseDir();
  const id = candidateId('10');
  seedCases(home);
  const casesFile = resolveCasesFile('sprint', home);
  const records = fs.readFileSync(casesFile, 'utf8').trimEnd().split('\n').map(JSON.parse);
  records[0].input = 'caller-edited input';
  fs.writeFileSync(casesFile, `${records.map(JSON.stringify).join('\n')}\n`);
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', id, [
      { case_id: 'case-a', passed: true },
      { case_id: 'case-b', passed: true },
    ], authorityOptions(home)),
    /input[_ ]digest|source.*event|authority|journal/i
  );
});

test('read rejects authority when a case source event is tombstoned after staging', () => {
  const home = baseDir();
  const id = candidateId('11');
  const [source] = seedCases(home);
  stageEvaluationArtifactAuthority('sprint', id, [
    { case_id: 'case-a', passed: true },
    { case_id: 'case-b', passed: false },
  ], authorityOptions(home));
  tombstoneEntity(source.storeDir, {
    record_id: `tombstone:${source.event.event_id}`,
    target_id: source.event.event_id,
    target_hash: source.record.record_hash,
    actor: { kind: 'system', id: 'test', runtime: 'codex', authority_ref: null },
    occurred_at: '2026-08-21T03:00:00.000Z',
    reason: 'test source withdrawn',
  });
  assert.throws(
    () => readEvaluationArtifactAuthority('sprint', id, authorityOptions(home)),
    /tombstone|active|source.*event|authority|journal/i
  );
});

test('legacy self-declared v1 cases cannot authorize an evaluation artifact', () => {
  const home = baseDir();
  const casesFile = resolveCasesFile('sprint', home);
  fs.mkdirSync(path.dirname(casesFile), { recursive: true });
  fs.writeFileSync(casesFile, `${JSON.stringify({
    schema_version: '1.0',
    timestamp: '2026-08-21T00:00:00.000Z',
    name: 'sprint',
    id: 'legacy-case',
    input: 'caller supplied',
    provenance: 'trace',
    source_trace: { caller_claim: true },
  })}\n`);
  assert.throws(
    () => stageEvaluationArtifactAuthority('sprint', candidateId('12'), [
      { case_id: 'legacy-case', passed: true },
    ], authorityOptions(home)),
    /schema_version|legacy|authority/i
  );
});

test('fd identity recheck rejects a path replacement between lstat and open', () => {
  const home = baseDir();
  seedCases(home);
  const id = candidateId('9');
  stageEvaluationArtifactAuthority('sprint', id, [
    { case_id: 'case-a', passed: true },
    { case_id: 'case-b', passed: false },
  ], authorityOptions(home));
  const resultFile = resolveEvaluationArtifactFile('sprint', id, home);
  const replacement = path.join(path.dirname(resultFile), 'replacement.json');
  fs.copyFileSync(resultFile, replacement);
  const displaced = path.join(path.dirname(resultFile), 'displaced.json');
  const originalOpenSync = fs.openSync;
  let replaced = false;
  fs.openSync = function replaceBeforeOpen(file, ...args) {
    if (!replaced && path.resolve(file) === path.resolve(resultFile)) {
      replaced = true;
      fs.renameSync(resultFile, displaced);
      fs.renameSync(replacement, resultFile);
    }
    return originalOpenSync.call(fs, file, ...args);
  };
  try {
    assert.throws(
      () => readEvaluationArtifactAuthority('sprint', id, authorityOptions(home)),
      /identity changed|metadata changed|replaced/i
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test('secure read rejects same-inode same-length mutation during the fd read', () => {
  const home = baseDir();
  seedCases(home);
  const id = candidateId('10');
  stageEvaluationArtifactAuthority('sprint', id, [
    { case_id: 'case-a', passed: true },
    { case_id: 'case-b', passed: false },
  ], authorityOptions(home));
  const resultFile = resolveEvaluationArtifactFile('sprint', id, home);
  const resultIdentity = fs.statSync(resultFile, { bigint: true });
  const originalReadFileSync = fs.readFileSync;
  let mutated = false;
  fs.readFileSync = function mutateAfterDescriptorRead(file, ...args) {
    const buffer = originalReadFileSync.call(fs, file, ...args);
    const openedIdentity = typeof file === 'number'
      ? fs.fstatSync(file, { bigint: true })
      : null;
    if (!mutated
        && openedIdentity
        && openedIdentity.dev === resultIdentity.dev
        && openedIdentity.ino === resultIdentity.ino) {
      mutated = true;
      const replacement = Buffer.from(buffer);
      replacement[0] = replacement[0] === 0x7b ? 0x5b : 0x7b;
      fs.writeFileSync(resultFile, replacement);
    }
    return buffer;
  };
  try {
    assert.throws(
      () => readEvaluationArtifactAuthority('sprint', id, authorityOptions(home)),
      /changed while being read|metadata changed|content changed/i
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, error }) => console.error(`\n[${name}]\n${error.stack || error.message}`));
  process.exit(1);
}
