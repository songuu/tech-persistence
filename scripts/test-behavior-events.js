#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashObject } = require('./lib/self-learning-canonical');

const {
  BEHAVIOR_EVENT_SCHEMA_VERSION,
  EVIDENCE_REF_SCHEMA_VERSION,
  adaptExplicitBehaviorEvent,
  appendBehaviorEvent,
  appendEvidenceRef,
  createBehaviorEvent,
  journalActorForEvent,
  normalizeEvidenceRef,
  verifyBehaviorEvent,
} = require('./lib/behavior-events');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-08-20T02:03:04.000Z';

function baseEvent(overrides = {}) {
  return {
    source_event_id: 'submission-001',
    project_id: 'project-abc',
    session_id: 'session-001',
    task_ref: 'task-001',
    turn_ref: 'turn-001',
    parent_event_id: null,
    actor: { kind: 'user', id: 'user', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: 'task-001' },
    event_type: 'user.correction',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'succeeded',
    final_disposition: 'superseded',
    occurred_at: NOW,
    details: { summary: 'Use the repository validator.' },
    input_value: { message: 'Use the repository validator.' },
    output_value: null,
    evidence_refs: [],
    ...overrides,
  };
}

test('EvidenceRef is content-bound, deterministic, and exact-shaped', () => {
  const left = normalizeEvidenceRef({
    source_type: 'document',
    source_ref: 'validation-result-001',
    immutable_ref: HASH_A,
    digest: HASH_A,
    uri: null,
    final_disposition: 'accepted',
    captured_at: NOW,
    scope: { level: 'task', id: 'task-001' },
    redaction_status: 'passed',
    assurance: 'verified',
    signal_strength: 'weak',
    fact_status: 'fact',
  });
  const right = normalizeEvidenceRef({
    fact_status: 'fact',
    signal_strength: 'weak',
    assurance: 'verified',
    redaction_status: 'passed',
    scope: { id: 'task-001', level: 'task' },
    captured_at: NOW,
    final_disposition: 'accepted',
    uri: null,
    digest: HASH_A,
    immutable_ref: HASH_A,
    source_ref: 'validation-result-001',
    source_type: 'document',
  });

  assert.strictEqual(left.schema_version, EVIDENCE_REF_SCHEMA_VERSION);
  assert.match(left.evidence_id, /^evidence:[a-f0-9]{64}$/);
  assert.deepStrictEqual(left, right);
  assert.deepStrictEqual(Object.keys(left).sort(), [
    'assurance', 'captured_at', 'digest', 'evidence_id', 'fact_status',
    'final_disposition', 'immutable_ref', 'redaction_status', 'schema_version',
    'scope', 'signal_strength', 'source_ref', 'source_type', 'uri',
  ].sort());
  assert.throws(
    () => normalizeEvidenceRef({ ...left, unexpected: true }),
    /unexpected|exact|key/i
  );
});

test('EvidenceRef accepts the unified provenance types and requires signal strength', () => {
  const sourceTypes = [
    'behavior_event', 'behavior_episode', 'trace', 'document', 'task_envelope',
    'result_envelope', 'acceptance_receipt', 'user_confirmation', 'test', 'log',
    'external', 'legacy_observation',
  ];
  sourceTypes.forEach((sourceType) => {
    const evidence = normalizeEvidenceRef({
      source_type: sourceType,
      source_ref: `${sourceType}-001`,
      immutable_ref: HASH_A,
      digest: HASH_A,
      uri: null,
      final_disposition: 'unknown',
      captured_at: NOW,
      scope: { level: 'task', id: 'task-001' },
      redaction_status: 'passed',
      assurance: 'observed',
      signal_strength: 'weak',
      fact_status: 'unknown',
    });
    assert.strictEqual(evidence.source_type, sourceType);
  });
  assert.throws(() => normalizeEvidenceRef({
    source_type: 'test', source_ref: 'test-001', immutable_ref: HASH_A,
    digest: HASH_A, uri: null, final_disposition: 'unknown', captured_at: NOW,
    scope: { level: 'task', id: 'task-001' }, redaction_status: 'passed',
    assurance: 'verified', fact_status: 'fact',
  }), /signal_strength/i);
  assert.throws(() => normalizeEvidenceRef({
    source_type: 'external',
    source_ref: `glpat-${'S'.repeat(24)}`,
    immutable_ref: HASH_A,
    digest: HASH_A,
    uri: null,
    final_disposition: 'unknown',
    captured_at: NOW,
    scope: { level: 'task', id: 'task-001' },
    redaction_status: 'passed',
    assurance: 'observed',
    signal_strength: 'weak',
    fact_status: 'unknown',
  }), /sensitive|redacted/i);
});

test('BehaviorEvent derives stable identity only from stable source identity', () => {
  const left = createBehaviorEvent(baseEvent());
  const right = createBehaviorEvent(baseEvent({
    details: { summary: 'Use the repository validator.' },
  }));

  assert.strictEqual(left.schema_version, BEHAVIOR_EVENT_SCHEMA_VERSION);
  assert.match(left.event_id, /^behavior-event:[a-f0-9]{64}$/);
  assert.match(left.idempotency_key, /^idem:[a-f0-9]{64}$/);
  assert.deepStrictEqual(left, right);
  assert.deepStrictEqual(verifyBehaviorEvent(left), { valid: true, errors: [] });
});

test('same source identity with changed payload keeps entity id but changes content hash', () => {
  const original = createBehaviorEvent(baseEvent());
  const changed = createBehaviorEvent(baseEvent({
    details: { summary: 'Use a different validator.' },
    input_value: { message: 'Use a different validator.' },
  }));

  assert.strictEqual(original.event_id, changed.event_id);
  assert.strictEqual(original.idempotency_key, changed.idempotency_key);
  assert.notStrictEqual(hashObject(original), hashObject(changed));
});

test('missing stable source id or timestamp fails closed', () => {
  assert.throws(
    () => createBehaviorEvent(baseEvent({ source_event_id: '' })),
    /source_event_id/i
  );
  assert.throws(
    () => createBehaviorEvent(baseEvent({ occurred_at: undefined })),
    /occurred_at|timestamp/i
  );
});

test('event details are recursively redacted and digests do not retain raw input/output', () => {
  const secret = `glpat-${'S'.repeat(24)}`;
  const event = createBehaviorEvent(baseEvent({
    details: {
      nested: { message: `<private>internal note</private> ${secret}` },
    },
    input_value: { token: secret, message: '<private>input secret</private>' },
    output_value: { value: '<system-private>output secret</system-private>' },
  }));
  const serialized = JSON.stringify(event);

  assert(!serialized.includes(secret), serialized);
  assert(!serialized.includes('internal note'), serialized);
  assert(!serialized.includes('input secret'), serialized);
  assert(!serialized.includes('output secret'), serialized);
  assert.match(event.input_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(event.output_digest, /^sha256:[a-f0-9]{64}$/);
  assert(!Object.prototype.hasOwnProperty.call(event, 'input_value'));
  assert(!Object.prototype.hasOwnProperty.call(event, 'output_value'));
});

test('secret assignments across structured key styles are redacted from free text and actor identities fail closed', () => {
  const event = createBehaviorEvent(baseEvent({
    details: {
      summary: [
        'dbPassword=database-password-value',
        'githubToken=github-token-value',
        'slackBotToken=slack-token-value',
        'awsSecretAccessKey=aws-secret-access-key-value',
        'db_password="snake-db-secret"',
        'github_token="snake-github,secret"',
        'service-password=shell,comma-secret',
        'tenant.github_token="dot-key-secret"',
        'DB_PASSWORD=x',
        'clientSecret = "x"',
        "apiKey : 'q,\\'z'",
        '{ "refreshToken" : "tiny,escaped\\\"value", password : y, safe: visible }',
        'escaped={\\"clientSecret\\":\\"x\\",\\"safe\\":\\"visible\\"}',
        'nested={\\"apiKey\\":\\"q,\\\\\\"z\\",\\"safe\\":\\"visible\\"}',
      ].join(' '),
    },
  }));
  const serialized = JSON.stringify(event);
  for (const secret of [
    'database-password-value',
    'github-token-value',
    'slack-token-value',
    'aws-secret-access-key-value',
    'snake-db-secret',
    'snake-github,secret',
    'shell,comma-secret',
    'dot-key-secret',
    'tiny,escaped',
  ]) assert(!serialized.includes(secret), serialized);
  assert(!serialized.includes('clientSecret = \\"x\\"'), serialized);
  assert(!serialized.includes("apiKey : 'q,\\'z'"), serialized);
  assert(!serialized.includes('password : y'), serialized);
  assert(!event.details.summary.includes('\\"clientSecret\\":\\"x\\"'), event.details.summary);
  assert(!event.details.summary.includes('\\"apiKey\\":\\"q,'), event.details.summary);
  assert(serialized.includes('safe: visible'), serialized);
  assert(event.details.summary.includes('DB_PASSWORD=[REDACTED]'), event.details.summary);

  assert.throws(() => createBehaviorEvent(baseEvent({
    actor: { kind: 'user', id: 'githubToken=github-token-value', role: null },
  })), /sensitive|secret|redact|identifier/i);
  assert.throws(() => createBehaviorEvent(baseEvent({
    actor: { kind: 'user', id: `ghp_${'A'.repeat(36)}`, role: null },
  })), /sensitive|secret|redact/i);
  assert.throws(() => createBehaviorEvent(baseEvent({
    actor: { kind: 'user', id: 'githubToken=x', role: null },
  })), /sensitive|secret|redact|identifier/i);
});

test('redacted assignment values, not raw details, are persisted to the journal', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-event-redaction-store-'));
  try {
    const rawSecrets = [
      'journal-db-secret',
      'journal-github,secret',
      'journal-shell,secret',
      'journal-dot-secret',
      'journal-escaped',
      'journal-basic-credential',
      'journal-bearer-credential',
      'journal-postgres-password',
      'journal-http-password',
      'journal-https-password',
      'journal-quoted-bearer',
      'journal-bang-secret',
      'journal-escaped-postgres-password',
    ];
    const event = createBehaviorEvent(baseEvent({
      source_event_id: 'submission-redaction-journal-001',
      details: {
        summary: [
          `db_password="${rawSecrets[0]}"`,
          `github_token="${rawSecrets[1]}"`,
          `service-password=${rawSecrets[2]}`,
          `tenant.github_token="${rawSecrets[3]}"`,
          `encoded={\\"service_password\\":\\"${rawSecrets[4]},\\\\\\"secret\\",\\"safe\\":\\"visible\\"}`,
          `Authorization: Basic ${rawSecrets[5]}`,
          `Authorization Bearer ${rawSecrets[6]}`,
          `postgresql://db-user:${rawSecrets[7]}@db.example.test/app`,
          `http://api-user:${rawSecrets[8]}@api.example.test/v1`,
          `https://web-user:${rawSecrets[9]}@web.example.test/path`,
          `Authorization: Bearer "${rawSecrets[10]}"`,
          `Authorization: Bearer abc!${rawSecrets[11]}`,
          `postgresql:\\/\\/db-user:${rawSecrets[12]}@escaped.example.test/app`,
          'The password policy remains visible.',
        ].join(' '),
      },
    }));
    const write = appendBehaviorEvent(storeDir, event);
    const persisted = fs.readFileSync(write.file, 'utf8');

    rawSecrets.forEach((secret) => assert(!persisted.includes(secret), persisted));
    assert(persisted.includes('[REDACTED]'), persisted);
    assert(persisted.includes('The password policy remains visible.'), persisted);
    assert(persisted.includes('postgresql://[REDACTED]@db.example.test/app'), persisted);
    assert(persisted.includes('http://[REDACTED]@api.example.test/v1'), persisted);
    assert(persisted.includes('https://[REDACTED]@web.example.test/path'), persisted);
    const readback = JSON.parse(persisted.trim()).payload.details.summary;
    assert(readback.includes('Authorization: [REDACTED]'), readback);
    assert(readback.includes('postgresql:\\/\\/[REDACTED]@escaped.example.test/app'), readback);
    assert(event.details.summary.includes('encoded={\\"service_password\\":\\"[REDACTED]\\"'), event.details.summary);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test('an agent cannot self-report an explicit user feedback or correction event', () => {
  for (const eventType of ['user.feedback', 'user.correction']) {
    assert.throws(() => createBehaviorEvent(baseEvent({
      actor: { kind: 'agent', id: 'codex', role: null },
      event_type: eventType,
      signal_strength: 'explicit',
      source_assurance: 'explicit',
    })), /user event|user actor|actor.*user/i);
  }
  assert.throws(() => createBehaviorEvent(baseEvent({
    source: 'codex_mcp',
    event_type: 'user.feedback',
    actor: { kind: 'user', id: 'user', role: null },
    source_assurance: 'explicit',
    signal_strength: 'explicit',
  })), /mcp|self-report|explicit/i);
  assert.throws(() => createBehaviorEvent(baseEvent({
    source: 'claude_hook',
    event_type: 'user.correction',
    actor: { kind: 'user', id: 'user', role: null },
    source_assurance: 'explicit',
    signal_strength: 'explicit',
  })), /claude_hook|self-report|trusted/i);
});

test('explicit adapter is reported evidence and does not turn system acceptance into user approval', () => {
  const event = adaptExplicitBehaviorEvent({
    source_event_id: 'codex-report-1',
    occurred_at: NOW,
    project_id: 'project-abc',
    session_id: 'session-001',
    task_ref: 'task-001',
    actor: { kind: 'agent', id: 'codex', role: null },
    runtime: 'codex',
    event_type: 'task.result',
    status: 'succeeded',
    final_disposition: 'accepted',
    fact_status: 'unknown',
    details: { system_accepted: true },
    evidence_refs: [{
      source_type: 'result_envelope',
      source_ref: 'result-001',
      immutable_ref: HASH_B,
      digest: HASH_B,
      uri: null,
      final_disposition: 'unknown',
      captured_at: NOW,
      scope: { level: 'task', id: 'task-001' },
      redaction_status: 'passed',
      assurance: 'observed',
      signal_strength: 'weak',
      fact_status: 'unknown',
    }],
  });

  assert.strictEqual(event.source_assurance, 'explicit');
  assert.strictEqual(event.event_type, 'task.result');
  assert.notStrictEqual(event.event_type, 'user.approval');
  assert.strictEqual(event.fact_status, 'unknown');
});

test('normalized contract rejects tampered event hashes and extra persisted fields', () => {
  const event = createBehaviorEvent(baseEvent());
  const tampered = { ...event, idempotency_key: `idem:${'b'.repeat(64)}` };
  const extra = { ...event, raw_prompt: 'must not persist' };

  assert.strictEqual(verifyBehaviorEvent(tampered).valid, false);
  assert.strictEqual(verifyBehaviorEvent(extra).valid, false);
});

test('journal wrappers map actors and EvidenceRef append is idempotent but conflict-safe', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-event-store-'));
  try {
    const event = createBehaviorEvent(baseEvent());
    const eventWrite = appendBehaviorEvent(storeDir, event);
    assert.strictEqual(eventWrite.changed, true);
    assert.deepStrictEqual(eventWrite.record.actor, {
      authority_ref: event.source_event_id,
      id: 'user',
      kind: 'user',
      runtime: 'codex',
    });
    assert.deepStrictEqual(journalActorForEvent(createBehaviorEvent(baseEvent({
      source_event_id: 'tool-source-001',
      actor: { kind: 'tool', id: 'codex-tool', role: null },
      event_type: 'tool.result',
      source_assurance: 'observed',
      signal_strength: 'weak',
    }))), {
      kind: 'hook', id: 'codex-tool', runtime: 'codex', authority_ref: null,
    });

    const evidence = normalizeEvidenceRef({
      source_type: 'user_confirmation',
      source_ref: 'confirmation-001',
      immutable_ref: HASH_A,
      digest: HASH_A,
      uri: null,
      final_disposition: 'accepted',
      captured_at: NOW,
      scope: { level: 'task', id: 'task-001' },
      redaction_status: 'passed',
      assurance: 'explicit',
      signal_strength: 'explicit',
      fact_status: 'fact',
    });
    const options = {
      actor: { kind: 'user', id: 'user', role: null },
      occurred_at: NOW,
    };
    const first = appendEvidenceRef(storeDir, evidence, options);
    const second = appendEvidenceRef(storeDir, evidence, options);
    assert.strictEqual(first.changed, true);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(first.record.actor.authority_ref, null);
    assert.throws(() => appendEvidenceRef(storeDir, {
      ...evidence,
      final_disposition: 'rejected',
    }, options), /conflict|differs/i);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
