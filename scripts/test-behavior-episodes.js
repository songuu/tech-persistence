#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendBehaviorEvent, createBehaviorEvent } = require('./lib/behavior-events');
const {
  BEHAVIOR_EPISODE_SCHEMA_VERSION,
  buildBehaviorEpisode,
  buildBehaviorMetrics,
  closeBehaviorEpisode,
  verifyBehaviorEpisode,
} = require('./lib/behavior-episodes');

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

const BASE_TIME = Date.parse('2026-08-20T03:00:00.000Z');
const EVIDENCE_ID = `evidence:${'c'.repeat(64)}`;

function event(index, overrides = {}) {
  const occurredAt = new Date(BASE_TIME + index * 1000).toISOString();
  return createBehaviorEvent({
    source_event_id: `episode-source-${index}`,
    project_id: 'project-abc',
    session_id: 'session-abc',
    task_ref: 'task-abc',
    turn_ref: `turn-${index}`,
    parent_event_id: null,
    actor: { kind: index === 0 ? 'user' : 'agent', id: index === 0 ? 'user' : 'codex', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'task', id: 'task-abc' },
    event_type: index === 0 ? 'user.prompt' : 'tool.request',
    signal_strength: index === 0 ? 'explicit' : 'weak',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    occurred_at: occurredAt,
    details: {},
    input_value: { index },
    output_value: null,
    evidence_refs: [],
    ...overrides,
  });
}

test('task-bound Episode is deterministic and separates goal/action/result', () => {
  const goal = event(0);
  const action = event(1);
  const result = event(2, {
    event_type: 'task.result',
    source: 'agent_loop',
    source_assurance: 'verified',
    status: 'succeeded',
    final_disposition: 'accepted',
    evidence_refs: [EVIDENCE_ID],
  });

  const left = buildBehaviorEpisode([result, goal, action]);
  const right = buildBehaviorEpisode([goal, action, result]);

  assert.strictEqual(left.schema_version, BEHAVIOR_EPISODE_SCHEMA_VERSION);
  assert.deepStrictEqual(left, right);
  assert.match(left.episode_id, /^behavior-episode:[a-f0-9]{64}$/);
  assert.match(left.event_set_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepStrictEqual(left.goals.map((ref) => ref.event_id), [goal.event_id]);
  assert.deepStrictEqual(left.actions.map((ref) => ref.event_id), [action.event_id]);
  assert.deepStrictEqual(left.results.map((ref) => ref.event_id), [result.event_id]);
  assert.strictEqual(left.completeness, 'complete');
  assert.strictEqual(left.status, 'closed');
  assert.strictEqual(left.final_disposition, 'accepted');
  assert.strictEqual(left.verification_status, 'verified');
  assert.deepStrictEqual(verifyBehaviorEpisode(left), { valid: true, errors: [] });
});

test('events without task identity remain unassigned and needs_review', () => {
  const prompt = event(0, {
    task_ref: null,
    scope: { level: 'session', id: 'session-abc' },
  });
  const episode = buildBehaviorEpisode([prompt]);

  assert.strictEqual(episode.task_ref, null);
  assert.strictEqual(episode.completeness, 'unassigned');
  assert.strictEqual(episode.status, 'needs_review');
  assert.strictEqual(episode.final_disposition, 'unknown');
});

test('tool success is not promoted to final task disposition', () => {
  const prompt = event(0);
  const toolSuccess = event(1, {
    event_type: 'tool.result',
    status: 'succeeded',
    final_disposition: 'unknown',
  });
  const episode = buildBehaviorEpisode([prompt, toolSuccess]);

  assert.strictEqual(episode.final_disposition, 'unknown');
  assert.strictEqual(episode.completeness, 'incomplete');
  assert.strictEqual(episode.status, 'needs_review');
});

test('explicit feedback and weak signals are kept in separate collections', () => {
  const prompt = event(0);
  const weak = event(1, {
    event_type: 'tool.result',
    signal_strength: 'weak',
    fact_status: 'inference',
    status: 'failed',
    details: { retry: true },
  });
  const feedback = event(2, {
    actor: { kind: 'user', id: 'user', role: null },
    event_type: 'user.correction',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'superseded',
    details: { counterexample: true },
  });
  const episode = buildBehaviorEpisode([prompt, weak, feedback]);

  assert.deepStrictEqual(episode.explicit_feedback, [feedback.event_id]);
  assert(episode.weak_signals.includes(weak.event_id));
  assert.deepStrictEqual(episode.counterexamples, [feedback.event_id]);
  assert.strictEqual(episode.final_disposition, 'superseded');
  assert.strictEqual(episode.status, 'needs_review');
});

test('Episode rejects mixed project, session, or task identities', () => {
  assert.throws(
    () => buildBehaviorEpisode([event(0), event(1, { project_id: 'other-project' })]),
    /project/i
  );
  assert.throws(
    () => buildBehaviorEpisode([event(0), event(1, { session_id: 'other-session' })]),
    /session/i
  );
  assert.throws(
    () => buildBehaviorEpisode([event(0), event(1, {
      task_ref: 'other-task', scope: { level: 'task', id: 'other-task' },
    })]),
    /task/i
  );
});

test('new event set creates a new content hash while episode identity remains task-stable', () => {
  const first = buildBehaviorEpisode([event(0), event(1)], { revision: 1 });
  const second = buildBehaviorEpisode([event(0), event(1), event(2, {
    event_type: 'task.result', status: 'failed', final_disposition: 'rejected',
  })], { revision: 2 });

  assert.strictEqual(first.episode_id, second.episode_id);
  assert.notStrictEqual(first.event_set_hash, second.event_set_hash);
  assert.strictEqual(second.revision, 2);
});

test('Behavior metrics separate usage from quality and preserve unknown denominators', () => {
  const unassigned = buildBehaviorEpisode([event(0, {
    task_ref: null,
    scope: { level: 'session', id: 'session-abc' },
  })]);
  const noQuality = buildBehaviorMetrics([unassigned]);

  assert.strictEqual(noQuality.usage.episodes_total, 1);
  assert.strictEqual(noQuality.quality.task_verification_rate.status, 'unknown');
  assert.strictEqual(noQuality.quality.task_verification_rate.value, null);

  const completed = buildBehaviorEpisode([
    event(10),
    event(11),
    event(12, {
      event_type: 'task.result',
      source: 'agent_loop',
      source_assurance: 'verified',
      status: 'succeeded',
      final_disposition: 'accepted',
      evidence_refs: [EVIDENCE_ID],
    }),
  ]);
  const measured = buildBehaviorMetrics([completed]);

  assert.strictEqual(measured.quality.task_verification_rate.status, 'measured');
  assert.strictEqual(measured.quality.task_verification_rate.value, 1);
  assert.strictEqual(measured.quality.unknown_outcome_count, 0);

  const firstRevision = buildBehaviorEpisode([event(20)], { revision: 1 });
  const secondRevision = buildBehaviorEpisode([event(20), event(21)], { revision: 2 });
  const latestOnly = buildBehaviorMetrics([secondRevision, firstRevision]);
  assert.strictEqual(latestOnly.usage.episodes_total, 1);
  assert.strictEqual(latestOnly.usage.event_count, 2);
});

test('tampered Episode event set hash and derived collections fail strict verification', () => {
  const episode = buildBehaviorEpisode([event(0)]);
  assert.strictEqual(verifyBehaviorEpisode({
    ...episode,
    event_set_hash: `sha256:${'e'.repeat(64)}`,
  }).valid, false);
  assert.strictEqual(verifyBehaviorEpisode({
    ...episode,
    explicit_feedback: [episode.event_refs[0].event_id],
  }).valid, false);
  assert.strictEqual(verifyBehaviorEpisode({
    ...episode,
    event_refs: [{ ...episode.event_refs[0], source: 'invented_runtime' }],
  }).valid, false);
  assert.throws(() => buildBehaviorEpisode([event(1)], {
    created_at: '2026-08-20T02:59:59.000Z',
  }), /created_at|latest/i);
});

test('closeBehaviorEpisode reads matching journal events and increments revision transactionally', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-episode-store-'));
  const actor = {
    kind: 'system', id: 'episode-closer', runtime: 'codex', authority_ref: null,
  };
  try {
    appendBehaviorEvent(storeDir, event(0));
    appendBehaviorEvent(storeDir, event(1));
    const first = closeBehaviorEpisode(storeDir, {
      project_id: 'project-abc',
      session_id: 'session-abc',
      task_ref: 'task-abc',
      created_at: '2026-08-20T03:00:02.000Z',
      actor,
    });
    assert.strictEqual(first.changed, true);
    assert.strictEqual(first.episode.revision, 1);
    assert.strictEqual(first.episode.event_refs.length, 2);

    appendBehaviorEvent(storeDir, event(2, {
      event_type: 'task.result',
      source: 'agent_loop',
      source_assurance: 'verified',
      status: 'succeeded',
      final_disposition: 'accepted',
      evidence_refs: [EVIDENCE_ID],
    }));
    const second = closeBehaviorEpisode(storeDir, {
      project_id: 'project-abc',
      session_id: 'session-abc',
      task_ref: 'task-abc',
      created_at: '2026-08-20T03:00:03.000Z',
      actor,
    });
    assert.strictEqual(second.episode.revision, 2);
    assert.strictEqual(second.episode.event_refs.length, 3);
    assert.notStrictEqual(second.episode.event_set_hash, first.episode.event_set_hash);

    assert.throws(() => closeBehaviorEpisode(storeDir, {
      project_id: 'project-abc',
      session_id: 'session-abc',
      task_ref: 'missing-task',
      created_at: '2026-08-20T03:00:04.000Z',
      actor,
    }), /no BehaviorEvent/i);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
