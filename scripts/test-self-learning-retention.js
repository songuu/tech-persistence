#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyRetention,
  resolveLearningContext,
  verifyDomainJournal,
} = require('./lib/self-learning-service');
const {
  appendBehaviorEvent,
  appendEvidenceRef,
  normalizeEvidenceRef,
} = require('./lib/behavior-events');
const { inspectCandidateStore, proposeCandidate } = require('./lib/learning-candidates');
const { projectJournal, readJournal } = require('./lib/self-learning-store');

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-retention-'));

try {
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    self_learning: { retention_days: 30 },
  }));
  const context = resolveLearningContext({ base_dir: baseDir, project_id: 'project-retention' });
  const original = appendBehaviorEvent(context.store_dir, {
    source_event_id: 'event-old-source',
    project_id: 'project-retention',
    session_id: 'session-retention',
    task_ref: null,
    turn_ref: null,
    parent_event_id: null,
    actor: { kind: 'user', id: 'user:owner', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'project', id: 'project-retention' },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { summary: 'old event' },
    input_value: 'old event',
    output_value: null,
    evidence_refs: [],
    occurred_at: '2026-01-01T00:00:00.000Z',
  });
  const evidence = normalizeEvidenceRef({
    schema_version: 'self-learning-evidence-ref-v1',
    source_type: 'document',
    source_ref: 'retention-policy-fixture',
    immutable_ref: 'fixture:retention-policy-fixture',
    digest: `sha256:${'1'.repeat(64)}`,
    uri: null,
    final_disposition: 'accepted',
    captured_at: '2026-01-01T00:00:00.000Z',
    scope: { level: 'project', id: 'project-retention' },
    redaction_status: 'passed',
    assurance: 'verified',
    signal_strength: 'inferred',
    fact_status: 'fact',
  });
  appendEvidenceRef(context.store_dir, evidence, {
    actor: { kind: 'system', id: 'retention-fixture', role: null },
    occurred_at: '2026-08-19T00:00:00.000Z',
  });
  const proposed = proposeCandidate(context.store_dir, {
    project_id: 'project-retention',
    kind: 'environment_fact',
    statement: { text: 'old candidate', fact_status: 'fact' },
    target: {
      key: 'retention.old',
      source_path: 'docs/retention-old.md',
      source_hash: `sha256:${'2'.repeat(64)}`,
    },
    scope: { level: 'project', id: 'project-retention' },
    proposer: { kind: 'agent', id: 'agent:proposer', authority_ref: 'local:proposal' },
    owner: { kind: 'user', id: 'user:owner', authority_ref: 'local:owner' },
    evidence_refs: [evidence],
    counterexamples: [],
    occurred_at: '2026-01-01T00:00:00.000Z',
  });

  assert.throws(
    () => applyRetention(context, {
      now: '2026-08-20T00:00:00.000Z',
      retention_days: 90,
      actor: { kind: 'agent', id: 'agent:auto' },
    }),
    /user\/operator actor/i
  );

  const result = applyRetention(context, {
    now: '2026-08-20T00:00:00.000Z',
    actor: { kind: 'operator', id: 'operator:owner', authority_ref: 'local:retention-review' },
  });
  assert.strictEqual(result.tombstoned_count, 1);
  assert.strictEqual(result.expired_candidate_count, 1);
  assert.strictEqual(result.retention_days, 30);
  assert.strictEqual(result.physical_purge_performed, false);

  const journal = readJournal(context.store_dir);
  assert.strictEqual(journal.records.length, 5);
  assert.strictEqual(journal.records[0].record_hash, original.record.record_hash);
  assert.strictEqual(journal.records[0].entity_id, original.event.event_id);
  assert.strictEqual(journal.records[3].record_type, 'candidate_transition');
  assert.strictEqual(journal.records[3].payload.candidate.status, 'expired');
  assert.strictEqual(journal.records[3].actor.kind, 'system');
  assert.strictEqual(journal.records[4].record_type, 'tombstone');
  assert.strictEqual(projectJournal(context.store_dir).active.some(
    (record) => record.entity_id === original.event.event_id
  ), false);
  assert.strictEqual(projectJournal(context.store_dir).tombstoned.length, 1);
  assert.strictEqual(
    inspectCandidateStore(context.store_dir).candidates.find(
      (candidate) => candidate.candidate_id === proposed.candidate.candidate_id
    ).status,
    'expired'
  );
  assert.strictEqual(verifyDomainJournal(context).domain_verified, true);

  const replay = applyRetention(context, {
    now: '2026-08-20T00:00:00.000Z',
    actor: { kind: 'operator', id: 'operator:owner', authority_ref: 'local:retention-review' },
  });
  assert.strictEqual(replay.tombstoned_count, 0);
  assert.strictEqual(replay.expired_candidate_count, 0);
  assert.strictEqual(readJournal(context.store_dir).records.length, 5);
} finally {
  fs.rmSync(baseDir, { recursive: true, force: true });
}

console.log('self-learning retention tests passed');
