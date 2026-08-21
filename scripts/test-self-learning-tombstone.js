#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./lib/self-learning-store');
const { executeLearningAction } = require('./lib/self-learning-service');

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-tombstone-'));
const actor = { kind: 'operator', id: 'operator-local', runtime: null, authority_ref: 'approval-1' };
try {
  const storeDir = store.resolveStoreDir(baseDir, 'project-tombstone');
  const first = store.appendRecord(storeDir, {
    record_type: 'learning_candidate',
    record_id: 'candidate-1-rev-1',
    entity_id: 'candidate-1',
    actor,
    occurred_at: '2026-08-20T01:00:00.000Z',
    payload: { lifecycle: 'shadow', statement: 'Prefer explicit verification.' },
  });
  const second = store.appendRecord(storeDir, {
    record_type: 'candidate_transition',
    record_id: 'candidate-1-rev-2',
    entity_id: 'candidate-1',
    actor,
    occurred_at: '2026-08-20T01:01:00.000Z',
    payload: { lifecycle: 'rejected', reason: 'counterexample' },
  });
  assert.strictEqual(store.projectJournal(storeDir).active[0].record_hash, second.record.record_hash);

  assert.throws(
    () => store.tombstoneEntity(storeDir, {
      record_id: 'tombstone-bad-hash',
      target_id: 'candidate-1',
      target_hash: first.record.record_hash,
      actor,
      occurred_at: '2026-08-20T01:02:00.000Z',
      reason: 'delete requested',
    }),
    /target hash/i
  );
  assert.throws(
    () => store.tombstoneEntity(storeDir, {
      record_id: 'tombstone-unknown',
      target_id: 'missing-candidate',
      target_hash: 'sha256:' + '0'.repeat(64),
      actor,
      occurred_at: '2026-08-20T01:02:00.000Z',
      reason: 'delete requested',
    }),
    /unknown target/i
  );

  const tombstoneInput = {
    record_id: 'tombstone-candidate-1',
    target_id: 'candidate-1',
    target_hash: second.record.record_hash,
    actor,
    occurred_at: '2026-08-20T01:03:00.000Z',
    reason: 'delete requested',
  };
  const tombstone = store.tombstoneEntity(storeDir, tombstoneInput);
  assert.strictEqual(tombstone.changed, true);
  assert.strictEqual(tombstone.record.record_type, 'tombstone');
  assert.strictEqual(store.projectJournal(storeDir).active.length, 0);
  assert.strictEqual(store.projectJournal(storeDir).tombstoned.length, 1);
  assert.strictEqual(store.tombstoneEntity(storeDir, tombstoneInput).changed, false);

  assert.throws(
    () => store.appendRecord(storeDir, {
      record_type: 'candidate_transition',
      record_id: 'candidate-1-revive',
      entity_id: 'candidate-1',
      actor,
      occurred_at: '2026-08-20T01:04:00.000Z',
      payload: { lifecycle: 'shadow' },
    }),
    /tombstoned|resurrect/i
  );
} finally {
  fs.rmSync(baseDir, { recursive: true, force: true });
}

const episodeBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-episode-tombstone-'));
try {
  const common = { base_dir: episodeBaseDir, project_id: 'project-episode-tombstone' };
  const baseEvent = {
    project_id: common.project_id,
    session_id: 'session-episode-tombstone',
    task_ref: 'task-episode-tombstone',
    turn_ref: null,
    parent_event_id: null,
    runtime: 'codex',
    source: 'codex_cli',
    scope: { level: 'task', id: 'task-episode-tombstone' },
    fact_status: 'fact',
    evidence_refs: [],
    output_value: null,
  };
  const events = [
    {
      ...baseEvent,
      source_event_id: 'episode-tombstone-prompt',
      actor: { kind: 'user', id: 'user-owner', role: null },
      source_assurance: 'explicit',
      event_type: 'user.prompt',
      signal_strength: 'explicit',
      status: 'observed',
      final_disposition: 'unknown',
      details: {}, input_value: 'do the task',
      occurred_at: '2026-08-20T02:00:00.000Z',
    },
    {
      ...baseEvent,
      source_event_id: 'episode-tombstone-tool',
      actor: { kind: 'agent', id: 'codex', role: null },
      source_assurance: 'observed',
      event_type: 'tool.request',
      signal_strength: 'weak',
      status: 'observed',
      final_disposition: 'unknown',
      details: {}, input_value: { tool: 'test' },
      occurred_at: '2026-08-20T02:00:01.000Z',
    },
    {
      ...baseEvent,
      source_event_id: 'episode-tombstone-result',
      actor: { kind: 'agent', id: 'codex', role: null },
      source: 'agent_loop',
      source_assurance: 'verified',
      event_type: 'task.result',
      signal_strength: 'weak',
      status: 'succeeded',
      final_disposition: 'accepted',
      details: { verification_status: 'verified' }, input_value: null,
      evidence_refs: [`evidence:${'d'.repeat(64)}`],
      occurred_at: '2026-08-20T02:00:02.000Z',
    },
    {
      ...baseEvent,
      source_event_id: 'episode-tombstone-feedback',
      actor: { kind: 'user', id: 'user-owner', role: null },
      source_assurance: 'explicit',
      event_type: 'user.feedback',
      signal_strength: 'explicit',
      status: 'observed',
      final_disposition: 'accepted',
      details: {}, input_value: 'accepted',
      occurred_at: '2026-08-20T02:00:03.000Z',
    },
  ];
  const written = events.map((input) => executeLearningAction(
    'record',
    { ...common, input },
    { require_explicit_base_dir: true }
  ).result);
  executeLearningAction('close', {
    ...common,
    input: {
      project_id: common.project_id,
      session_id: baseEvent.session_id,
      task_ref: baseEvent.task_ref,
      created_at: '2026-08-20T02:00:04.000Z',
      actor: { kind: 'system', id: 'episode-builder', runtime: 'codex', authority_ref: null },
    },
  });
  const before = executeLearningAction('metrics', { ...common, input: {} }).result;
  assert.strictEqual(before.behavior.quality.task_verification_rate.value, 1);

  const resultRecord = written[2].record;
  executeLearningAction('govern', {
    ...common,
    input: {
      entity_id: resultRecord.entity_id,
      expected_record_hash: resultRecord.record_hash,
      actor: { kind: 'user', id: 'user-owner', runtime: 'codex', authority_ref: 'local:user' },
      occurred_at: '2026-08-20T02:01:00.000Z',
      reason: 'withdraw invalid result event',
    },
  });
  const inspection = executeLearningAction('inspect', { ...common, input: {} }).result;
  assert.strictEqual(inspection.episodes[0].effective_status, 'needs_review');
  assert.deepStrictEqual(inspection.episodes[0].invalidated_event_ids, [resultRecord.entity_id]);
  const after = executeLearningAction('metrics', { ...common, input: {} }).result;
  assert.strictEqual(after.behavior.usage.episodes_total, 1);
  assert.strictEqual(after.behavior.quality.excluded_episode_count, 1);
  assert.strictEqual(after.behavior.quality.task_verification_rate.status, 'unknown');
  assert.strictEqual(after.behavior.quality.task_verification_rate.denominator, 0);
  assert.throws(
    () => executeLearningAction('verify-store', { ...common, input: {} }),
    /episode.*tombstoned|tombstoned.*event|domain.*invalid/i,
    'verify-store must fail closed when an active Episode depends on a tombstoned Event'
  );
} finally {
  fs.rmSync(episodeBaseDir, { recursive: true, force: true });
}

console.log('self-learning tombstone tests passed');
