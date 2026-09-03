#!/usr/bin/env node

'use strict';

const assert = require('node:assert');
const test = require('node:test');

const {
  collectSprintEvidence,
  formatSprintEvidence,
  inspectRuntimeTranscriptDefault,
  parseArgs,
} = require('./sprint-evidence');

test('inactive sprint does not inherit unbound host transcript evidence', async () => {
  const evidence = await collectSprintEvidence({}, {
    readActiveSprint: () => ({ active: false, reason: 'missing-pointer' }),
    inspectHostTranscript: async () => ({
      status: 'local-only',
      sessionId: 'session-1',
      eventCount: 4,
      lastSyncedAt: null,
      evidence: ['local-session'],
    }),
  });

  assert.equal(evidence.sprint.active, false);
  assert.equal(evidence.harness.status, 'not-used');
  assert.equal(evidence.transcript.status, 'unbound-local');
  assert.equal(evidence.verdict.harnessUsed, false);
  assert.equal(evidence.verdict.transcriptCaptured, true);
  assert.equal(evidence.verdict.transcriptSynced, false);
  assert.equal(evidence.verdict.sprintTranscriptBound, false);
});

test('accepted provider execution is Harness use while queued transcript is not synced', async () => {
  const evidence = await collectSprintEvidence({}, {
    readActiveSprint: () => ({
      active: true,
      plan: 'docs/plans/example.md',
      phase: 'work',
      status: 'in-progress',
      acceptanceProtocol: 'v1',
    }),
    normalizePlan: () => ({
      relative: 'docs/plans/example.md',
      resolved: 'C:/workspace/docs/plans/example.md',
    }),
    inspectHarness: () => ({
      status: 'external-execution',
      runLocator: 'run-1',
      contractHash: 'sha256:contract',
      bindingHash: 'sha256:binding',
      providerRunCount: 1,
      acceptedRunCount: 1,
      receiptCount: 1,
      receiptStatuses: ['passed'],
      errors: [],
      providerRuns: [{
        runtime: 'openai-compatible',
        taskEnvelopeHash: 'sha256:task',
        routeDecisionHash: 'sha256:route',
        resultEnvelopeHash: 'sha256:result',
        accepted: true,
        transcript: { status: 'queued', jobHash: 'sha256:job' },
      }],
    }),
    inspectRuntimeTranscript: () => ({
      status: 'queued',
      jobCount: 1,
      verifiedAckCount: 0,
      transcriptIds: [],
      evidence: ['sha256:job'],
    }),
    inspectHostTranscript: async () => ({
      status: 'not-found', sessionId: null, eventCount: 0, lastSyncedAt: null, evidence: [],
    }),
  });

  assert.equal(evidence.harness.status, 'external-execution');
  assert.equal(evidence.verdict.harnessUsed, true);
  assert.equal(evidence.transcript.status, 'queued');
  assert.equal(evidence.verdict.transcriptSynced, false);
  assert.equal(evidence.verdict.sprintTranscriptBound, true);
});

test('verified runtime acknowledgement makes the bound transcript synced', async () => {
  const evidence = await collectSprintEvidence({}, {
    readActiveSprint: () => ({
      active: true,
      plan: 'docs/plans/example.md',
      phase: 'review',
      status: 'in-progress',
      acceptanceProtocol: 'v1',
    }),
    normalizePlan: () => ({
      relative: 'docs/plans/example.md',
      resolved: 'C:/workspace/docs/plans/example.md',
    }),
    inspectHarness: () => ({
      status: 'external-execution',
      runLocator: 'run-1',
      contractHash: 'sha256:contract',
      bindingHash: 'sha256:binding',
      providerRunCount: 1,
      acceptedRunCount: 1,
      receiptCount: 1,
      receiptStatuses: ['passed'],
      errors: [],
      providerRuns: [{ transcript: { status: 'queued', jobHash: 'sha256:job' } }],
    }),
    inspectRuntimeTranscript: () => ({
      status: 'synced',
      jobCount: 1,
      verifiedAckCount: 1,
      transcriptIds: ['openai-compatible:session'],
      evidence: ['sha256:job'],
    }),
    inspectHostTranscript: async () => ({
      status: 'not-found', sessionId: null, eventCount: 0, lastSyncedAt: null, evidence: [],
    }),
  });

  assert.equal(evidence.transcript.status, 'synced');
  assert.equal(evidence.verdict.transcriptSynced, true);
  assert.equal(evidence.verdict.sprintTranscriptBound, true);
});

test('human summary exposes provenance states without secrets', async () => {
  const evidence = await collectSprintEvidence({}, {
    readActiveSprint: () => ({ active: false, reason: 'missing-pointer' }),
    inspectHostTranscript: async () => ({
      status: 'postgres-synced',
      sessionId: 'session-1',
      eventCount: 9,
      lastSyncedAt: '2026-09-03T00:00:00.000Z',
      evidence: ['postgres-readback'],
    }),
  });
  const output = formatSprintEvidence(evidence);
  assert.match(output, /Harness: not-used/);
  assert.match(output, /Transcript: unbound-synced/);
  assert.doesNotMatch(output, /password|postgresql:\/\/[^\s]+:[^@\s]+@/i);
});

test('argument parser accepts read-only evidence inputs and rejects unknown options', () => {
  assert.deepEqual(parseArgs([
    '--plan', 'docs/plans/example.md',
    '--control-root', 'C:/authority',
    '--transcript-spool', 'C:/spool',
    '--config', 'C:/config.json',
    '--json',
  ]), {
    plan: 'docs/plans/example.md',
    controlRoot: 'C:/authority',
    transcriptSpool: 'C:/spool',
    configPath: 'C:/config.json',
    json: true,
    help: false,
  });
  assert.throws(() => parseArgs(['--write']), /Unknown option/);
});

test('runtime transcript claims without a valid content hash fail closed', () => {
  const transcript = inspectRuntimeTranscriptDefault([{
    transcript: { status: 'queued', jobHash: 'not-a-content-hash' },
  }], null);
  assert.equal(transcript.status, 'capture-incomplete');
  assert.equal(transcript.jobCount, 0);
  assert.equal(transcript.verifiedAckCount, 0);
});

test('an explicitly selected historical plan does not inherit the active host session', async () => {
  const evidence = await collectSprintEvidence({ plan: 'docs/plans/history.md' }, {
    readActiveSprint: () => ({
      active: true,
      plan: 'docs/plans/current.md',
      phase: 'work',
      status: 'in-progress',
      acceptanceProtocol: 'v1',
    }),
    normalizePlan: () => ({
      relative: 'docs/plans/history.md',
      resolved: 'C:/workspace/docs/plans/history.md',
    }),
    inspectHarness: () => ({
      status: 'not-used', runLocator: null, contractHash: null, bindingHash: null,
      providerRunCount: 0, acceptedRunCount: 0, receiptCount: 0,
      receiptStatuses: [], errors: [], providerRuns: [],
    }),
    inspectHostTranscript: async () => ({
      status: 'postgres-synced', sessionId: 'active-session', eventCount: 2,
      lastSyncedAt: '2026-09-03T00:00:00.000Z', evidence: ['postgres-readback'],
    }),
  });

  assert.equal(evidence.sprint.active, false);
  assert.equal(evidence.sprint.reason, 'selected-plan-not-active');
  assert.equal(evidence.sprint.currentActivePlan, 'docs/plans/current.md');
  assert.equal(evidence.transcript.status, 'unbound-synced');
  assert.equal(evidence.verdict.sprintTranscriptBound, false);
});
