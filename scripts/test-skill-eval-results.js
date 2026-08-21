#!/usr/bin/env node

/**
 * Self-contained tests for hash-bound skill eval results and publish guard.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { stableHash } = require('./lib/self-learning-canonical');

const {
  EVAL_RESULTS_SCHEMA_VERSION,
  LEGACY_HASH_BOUND_SCHEMA_VERSION,
  readResults,
  readLatestTwo,
  checkRegression,
  resolveResultsFile,
  resultHash,
} = require('./lib/skill-eval-results');

const CLI = path.join(__dirname, 'skill-eval-results.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-eval-results-'));
}

function digest(label) {
  return stableHash({ label });
}

function resultInput(name, version, passRate, baseDir, overrides = {}) {
  return {
    version,
    passRate,
    baseDir,
    skillHash: digest(`${name}-skill-${version}`),
    candidateId: `lc-${digest(`${name}-candidate-id-${version}`).slice(7, 39)}`,
    candidateHash: digest(`${name}-candidate-${version}`),
    target: {
      key: `skill:${name}`,
      source_path: `codex-native/skills/${name}/SKILL.md`,
      source_hash: version === 1
        ? digest(`${name}-source-0`)
        : digest(`${name}-skill-${version - 1}`),
    },
    scope: { level: 'project', id: 'project:eval-results-test' },
    baselineHash: version === 1 ? null : digest(`${name}-skill-${version - 1}`),
    caseSetHash: digest(`${name}-cases-v1`),
    evaluatorRef: 'evaluator:test-rubric-v1',
    evaluatorHash: digest(`${name}-evaluator-v1`),
    evaluationId: `eval-${digest(`${name}-evaluation-id-${version}`).slice(7, 39)}`,
    evaluationHash: digest(`${name}-evaluation-${version}`),
    approvalReceiptId: `approval-${digest(`${name}-approval-id-${version}`).slice(7, 39)}`,
    approvalReceiptHash: digest(`${name}-approval-${version}`),
    cases: {
      case_results_hash: digest(`${name}-case-results-${version}`),
      case_count: 100,
      passed_count: Math.round(passRate * 100),
    },
    ...overrides,
  };
}

function appendVersion(name, version, passRate, baseDir, overrides = {}) {
  const input = resultInput(name, version, passRate, baseDir, overrides);
  const record = {
    schema_version: EVAL_RESULTS_SCHEMA_VERSION,
    timestamp: '2026-08-01T00:00:00.000Z',
    name,
    version: Number(input.version),
    pass_rate: Number(input.passRate),
    skill_hash: input.skillHash,
    candidate_id: input.candidateId,
    candidate_hash: input.candidateHash,
    target: input.target,
    scope: input.scope,
    baseline_hash: input.baselineHash,
    case_set_hash: input.caseSetHash,
    evaluator_ref: input.evaluatorRef,
    evaluator_hash: input.evaluatorHash,
    evaluation_id: input.evaluationId,
    evaluation_hash: input.evaluationHash,
    approval_receipt_id: input.approvalReceiptId,
    approval_receipt_hash: input.approvalReceiptHash,
    cases: input.cases,
    source: 'skill-eval-test',
  };
  record.result_hash = resultHash(record);
  const resultsFile = resolveResultsFile(name, baseDir);
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
  fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
  return { record, resultsFile };
}

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || path.resolve(__dirname, '..'),
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) throw result.error;
  return result;
}

function runGuardCli(args, baseDir) {
  return runCli(args, { env: { TECH_PERSISTENCE_HOME: baseDir } });
}

test('strict reader accepts a complete authority-shaped v3 identity', () => {
  const baseDir = makeBaseDir();
  const { record, resultsFile } = appendVersion('prototype', 1, 0.8, baseDir);
  assert.strictEqual(EVAL_RESULTS_SCHEMA_VERSION, '3.0');
  assert.strictEqual(record.name, 'prototype');
  assert.strictEqual(record.pass_rate, 0.8);
  assert.match(record.skill_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(record.candidate_id, /^lc-[a-f0-9]{32}$/);
  assert.match(record.candidate_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepStrictEqual(record.scope, { level: 'project', id: 'project:eval-results-test' });
  assert.strictEqual(record.baseline_hash, null);
  assert.match(record.case_set_hash, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(record.evaluator_ref, 'evaluator:test-rubric-v1');
  assert.match(record.evaluator_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(record.evaluation_id, /^eval-[a-f0-9]{32}$/);
  assert.match(record.evaluation_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(record.approval_receipt_id, /^approval-[a-f0-9]{32}$/);
  assert.match(record.approval_receipt_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(record.result_hash, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(resultsFile, resolveResultsFile('prototype', baseDir));
  assert.deepStrictEqual(readResults('prototype', { baseDir }), [record]);
});

test('v3 reader rejects caller-shaped case details instead of treating them as authority', () => {
  const baseDir = makeBaseDir();
  appendVersion('review', 1, 0.8, baseDir, {
    cases: {
      api_key: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      nested: [{ note: '<private>do-not-persist</private>' }],
    },
  });
  assert.throws(() => readResults('review', { baseDir }), /case summary|fields/i);
});

test('strict reader rejects malformed authoritative identity hashes', () => {
  const baseDir = makeBaseDir();
  const { resultsFile, record } = appendVersion('think', 1, 0.5, baseDir);
  const malformed = { ...record, evaluator_hash: 'not-a-hash' };
  malformed.result_hash = resultHash(malformed);
  fs.writeFileSync(resultsFile, `${JSON.stringify(malformed)}\n`);
  assert.throws(() => readResults('think', { baseDir }), /evaluator_hash/);
});

test('readLatestTwo returns strict prev/curr in append order', () => {
  const baseDir = makeBaseDir();
  appendVersion('sprint', 1, 0.6, baseDir);
  appendVersion('sprint', 2, 0.9, baseDir);
  const { prev, curr } = readLatestTwo('sprint', { baseDir });
  assert.strictEqual(prev.version, 1);
  assert.strictEqual(curr.version, 2);
});

test('checkRegression blocks zero or one record as no-baseline', () => {
  const baseDir = makeBaseDir();
  let result = checkRegression('work', { baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'no-baseline');
  appendVersion('work', 1, 0.7, baseDir);
  result = checkRegression('work', { baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'no-baseline');
});

test('checkRegression returns ok only for comparable non-regressing v3 records', () => {
  const baseDir = makeBaseDir();
  appendVersion('evolve', 1, 0.67, baseDir);
  appendVersion('evolve', 2, 0.93, baseDir);
  const result = checkRegression('evolve', { baseDir });
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.publish_authorized, false, 'regression-only result must not authorize publish');
});

test('checkRegression returns regression when comparable new version drops', () => {
  const baseDir = makeBaseDir();
  appendVersion('review', 1, 0.9, baseDir);
  appendVersion('review', 2, 0.6, baseDir);
  const result = checkRegression('review', { baseDir });
  assert.strictEqual(result.status, 'regression');
  assert.ok(result.reason.includes('60.0%'));
  assert.ok(result.reason.includes('90.0%'));
});

test('checkRegression tolerance absorbs only a comparable small drop', () => {
  const baseDir = makeBaseDir();
  appendVersion('plan', 1, 0.9, baseDir);
  appendVersion('plan', 2, 0.88, baseDir);
  assert.strictEqual(checkRegression('plan', { baseDir }).status, 'regression');
  assert.strictEqual(checkRegression('plan', { baseDir, tolerance: 0.05 }).status, 'ok');
  assert.throws(() => checkRegression('plan', { baseDir, tolerance: Number.NaN }), /tolerance/);
});

test('identity mismatch blocks comparison even when pass rate improves', () => {
  const scenarios = [
    ['baseline-hash-mismatch', { baselineHash: digest('wrong-baseline') }],
    ['case-set-hash-mismatch', { caseSetHash: digest('different-cases') }],
    ['evaluator-ref-mismatch', { evaluatorRef: 'evaluator:other-rubric' }],
    ['evaluator-hash-mismatch', { evaluatorHash: digest('different-evaluator') }],
    ['target-type-mismatch', {
      target: {
        key: 'command:skill',
        source_path: 'user-level/commands/skill.md',
        source_hash: digest('skill-skill-1'),
      },
    }],
    ['target-path-mismatch', {
      target: {
        key: 'skill:skill',
        source_path: 'user-level/skills/skill/SKILL.md',
        source_hash: digest('skill-skill-1'),
      },
    }],
    ['project-scope-mismatch', {
      scope: { level: 'project', id: 'project:other' },
    }],
  ];
  scenarios.forEach(([label, overrides]) => {
    const baseDir = makeBaseDir();
    appendVersion('skill', 1, 0.5, baseDir);
    appendVersion('skill', 2, 0.99, baseDir, overrides);
    const result = checkRegression('skill', { baseDir });
    assert.strictEqual(result.status, 'blocked', label);
    assert.strictEqual(result.reason_code, 'identity-mismatch', label);
  });
});

test('invalid skill name, pass rate, version, and cases are rejected', () => {
  const baseDir = makeBaseDir();
  assert.throws(() => appendVersion('../escape', 1, 0.5, baseDir));
  assert.throws(() => resolveResultsFile('A_B', baseDir));
  for (const [version, passRate, expected] of [
    [0, 0.5, /version/],
    [1, 1.5, /passRate/],
    [1, -0.1, /passRate/],
  ]) {
    const invalidBase = makeBaseDir();
    appendVersion('think', version, passRate, invalidBase);
    assert.throws(() => readResults('think', { baseDir: invalidBase }), expected);
  }
  const casesBase = makeBaseDir();
  appendVersion('think', 1, 0.5, casesBase, { cases: 'not-an-object' });
  assert.throws(() => readResults('think', { baseDir: casesBase }), /case summary/i);
});

test('strict reader throws on malformed JSON and unknown schema', () => {
  const malformedBase = makeBaseDir();
  appendVersion('compound', 1, 0.8, malformedBase);
  fs.appendFileSync(resolveResultsFile('compound', malformedBase), 'not-json\n');
  assert.throws(() => readResults('compound', { baseDir: malformedBase }), /malformed line 2/);

  const unknownBase = makeBaseDir();
  const file = resolveResultsFile('compound', unknownBase);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: '999.0' })}\n`);
  assert.throws(() => readResults('compound', { baseDir: unknownBase }), /unknown schema/);
});

test('strict reader detects result hash tampering and unexpected fields', () => {
  const tamperedBase = makeBaseDir();
  const { resultsFile } = appendVersion('prototype', 1, 0.8, tamperedBase);
  const tampered = JSON.parse(fs.readFileSync(resultsFile, 'utf8').trim());
  tampered.source = 'tampered-without-rehash';
  fs.writeFileSync(resultsFile, `${JSON.stringify(tampered)}\n`);
  assert.throws(() => readResults('prototype', { baseDir: tamperedBase }), /result hash mismatch/);

  const extraBase = makeBaseDir();
  const written = appendVersion('prototype', 1, 0.8, extraBase);
  const extra = { ...written.record, unexpected: true };
  fs.writeFileSync(written.resultsFile, `${JSON.stringify(extra)}\n`);
  assert.throws(() => readResults('prototype', { baseDir: extraBase }), /fields do not match/);
});

test('known v1 records remain readable but can never authorize guard', () => {
  const baseDir = makeBaseDir();
  const file = resolveResultsFile('legacy', baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = (version, passRate) => ({
    schema_version: '1.0',
    timestamp: new Date(`2026-08-${String(version).padStart(2, '0')}T00:00:00.000Z`).toISOString(),
    name: 'legacy',
    version,
    pass_rate: passRate,
    source: 'skill-eval',
  });
  fs.writeFileSync(file, `${JSON.stringify(legacy(1, 0.7))}\n${JSON.stringify(legacy(2, 0.9))}\n`);
  assert.strictEqual(readResults('legacy', { baseDir }).length, 2);
  const result = checkRegression('legacy', { baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'legacy-unbound');
});

test('known hash-bound v2 records remain readable but can never authorize publish', () => {
  const baseDir = makeBaseDir();
  const file = resolveResultsFile('legacy-v2', baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = (version, passRate) => {
    const record = {
      schema_version: LEGACY_HASH_BOUND_SCHEMA_VERSION,
      timestamp: `2026-08-0${version}T00:00:00.000Z`,
      name: 'legacy-v2',
      version,
      pass_rate: passRate,
      skill_hash: digest(`legacy-v2-skill-${version}`),
      candidate_hash: digest(`legacy-v2-candidate-${version}`),
      baseline_hash: version === 1 ? null : digest(`legacy-v2-skill-${version - 1}`),
      case_set_hash: digest('legacy-v2-cases'),
      evaluator_ref: 'evaluator:legacy-v2',
      evaluator_hash: digest('legacy-v2-evaluator'),
      cases: null,
      source: 'skill-eval',
    };
    record.result_hash = resultHash(record);
    return record;
  };
  fs.writeFileSync(
    file,
    `${JSON.stringify(legacy(1, 0.7))}\n${JSON.stringify(legacy(2, 0.9))}\n`
  );
  assert.strictEqual(readResults('legacy-v2', { baseDir }).length, 2);
  const result = checkRegression('legacy-v2', { baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'legacy-unbound');
});

test('any legacy record poisons a later hand-appended v3 publish history', () => {
  const baseDir = makeBaseDir();
  const file = resolveResultsFile('mixed-history', baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schema_version: '1.0',
    timestamp: '2026-08-01T00:00:00.000Z',
    name: 'mixed-history',
    version: 1,
    pass_rate: 0.5,
    source: 'legacy',
  })}\n`);
  appendVersion('mixed-history', 2, 0.8, baseDir, {
    baselineHash: digest('mixed-history-skill-1'),
  });
  appendVersion('mixed-history', 3, 0.9, baseDir);
  const result = checkRegression('mixed-history', { baseDir });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.reason_code, 'legacy-unbound');
});

test('CLI record rejects caller-supplied eval identity and requires promoted authority', () => {
  const baseDir = makeBaseDir();
  const injected = runCli([
    'record', '--name', 'prototype', '--version', '1', '--pass-rate', '0.8',
    '--candidate-id', `lc-${digest('cli-candidate-id-1').slice(7, 39)}`,
  ]);
  assert.notStrictEqual(injected.status, 0);
  assert.match(injected.stderr, /unknown flag.*pass-rate/i);

  const missingAuthority = runCli([
    'record', '--name', 'prototype', '--version', '1',
    '--candidate-id', `lc-${digest('cli-candidate-id-1').slice(7, 39)}`,
  ], { env: { TECH_PERSISTENCE_HOME: baseDir } });
  assert.notStrictEqual(missingAuthority.status, 0);
  assert.match(missingAuthority.stderr, /candidate.*missing/i);
});

test('CLI record checks canonical writer policy before the authoritative result writer', () => {
  const scenarios = [
    ['disabled', { enabled: false }],
    ['writer-disabled', { writer_enabled: false }],
    ['mode-off', { mode: 'off' }],
  ];
  scenarios.forEach(([suffix, policy]) => {
    const baseDir = makeBaseDir();
    fs.writeFileSync(
      path.join(baseDir, 'config.json'),
      `${JSON.stringify({ self_learning: policy })}\n`
    );
    const name = `policy-${suffix}`;
    const result = runCli([
      'record', '--name', name, '--version', '1',
      '--candidate-id', `lc-${digest(`policy-${suffix}`).slice(7, 39)}`,
    ], { env: { TECH_PERSISTENCE_HOME: baseDir } });
    assert.notStrictEqual(result.status, 0, suffix);
    assert.match(result.stderr, /write action "result-record" is disabled by policy/i, suffix);
    assert.strictEqual(fs.existsSync(resolveResultsFile(name, baseDir)), false, suffix);
  });
});

test('CLI guard returns nonzero for no baseline and internal corruption', () => {
  const noBaselineDir = makeBaseDir();
  appendVersion('prototype', 1, 0.8, noBaselineDir);
  const noBaseline = runGuardCli(['guard', 'prototype'], noBaselineDir);
  assert.notStrictEqual(noBaseline.status, 0);
  assert.match(noBaseline.stderr, /BLOCKED.*no-baseline|no-baseline.*BLOCKED/s);

  const corruptDir = makeBaseDir();
  const { resultsFile } = appendVersion('prototype', 1, 0.8, corruptDir);
  fs.appendFileSync(resultsFile, '{"truncated":');
  const corrupt = runGuardCli(['guard', 'prototype'], corruptDir);
  assert.notStrictEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /ERROR|BLOCKED/);
});

test('CLI publish guard remains blocked without authoritative journal even when regression passes', () => {
  const baseDir = makeBaseDir();
  appendVersion('prototype', 1, 0.9, baseDir);
  appendVersion('prototype', 2, 0.6, baseDir);
  const regression = runGuardCli(['guard', 'prototype'], baseDir);
  assert.notStrictEqual(regression.status, 0);

  const tolerance = runGuardCli(['guard', 'prototype', '--tolerance', '0.4'], baseDir);
  assert.notStrictEqual(tolerance.status, 0);
  assert.match(tolerance.stderr, /candidate-missing|authority/i);

  appendVersion('prototype', 3, 0.95, baseDir);
  const ok = runGuardCli(['guard', 'prototype'], baseDir);
  assert.notStrictEqual(ok.status, 0);
  assert.match(ok.stderr, /candidate-missing|authority/i);
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
