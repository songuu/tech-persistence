'use strict';

const fs = require('fs');
const path = require('path');
const { collectAcceptanceShadowReport } = require('../agent-orchestrator/acceptance-shadow-report');
const acceptance = require('./acceptance-contract');
const behavior = require('./behavior-events');
const skillEvalCases = require('./skill-eval-cases');
const { readJournal, resolveStoreDir } = require('./self-learning-store');
const { stableHash } = require('./self-learning-canonical');

const FEEDBACK_SCHEMA_VERSION = 'acceptance-feedback-candidate-v1';

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function targetEvidence(input) {
  const workspace = path.resolve(input.cwd || process.cwd());
  const runDir = path.resolve(input.runDir || '');
  const runsDir = path.dirname(runDir);
  const report = collectAcceptanceShadowReport(runsDir, {
    providerRoot: workspace,
    controlRoot: path.resolve(input.controlRoot || ''),
  });
  const targetName = path.basename(runDir);
  const targetErrors = report.errors.filter((entry) => entry.run === targetName);
  if (targetErrors.length > 0) {
    throw new Error(`acceptance feedback authority readback failed: ${targetErrors[0].error}`);
  }
  const run = report.runs.find((entry) => pathKey(entry.runLocator) === pathKey(runDir));
  if (!run) throw new Error('acceptance feedback requires a durable authority Receipt readback');
  const failedReceipts = run.receipts.filter((receipt) => receipt.overallStatus === 'failed');
  if (failedReceipts.length === 0) throw new Error('acceptance feedback requires a failed Receipt');
  const requestedHash = input.receiptHash;
  const receipt = requestedHash
    ? failedReceipts.find((entry) => entry.receiptHash === requestedHash)
    : failedReceipts[failedReceipts.length - 1];
  if (!receipt) throw new Error('requested failed Receipt is not authoritative for this run');
  const contractFile = path.join(runDir, 'acceptance-contract.json');
  const stat = fs.lstatSync(contractFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('acceptance feedback Contract is unsafe');
  }
  const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
  acceptance.assertAcceptanceContract(contract);
  if (contract.contractHash !== receipt.contractHash) {
    throw new Error('acceptance feedback Receipt is stale for the frozen Contract');
  }
  const statusByCriterion = new Map(
    receipt.resultStatuses.map((entry) => [entry.criterionId, entry.status])
  );
  const failedCriteria = contract.criteria.filter(
    (criterion) => statusByCriterion.get(criterion.id) === 'failed'
  );
  if (failedCriteria.length === 0) throw new Error('failed Receipt has no failed frozen criterion');
  return { workspace, runDir, contract, receipt, failedCriteria };
}

function expectationFromCriteria(criteria) {
  return criteria.map((criterion) => (
    `${criterion.id}: ${criterion.statement} => ${criterion.oracle.expected}`
  )).join('\n');
}

function feedbackEventInput(input, evidence, occurredAt) {
  const promptInput = String(input.input || '');
  if (!promptInput.trim()) throw new Error('acceptance feedback requires the original task input');
  const expectation = expectationFromCriteria(evidence.failedCriteria);
  const sourceId = `acceptance-feedback-${evidence.receipt.receiptHash.slice('sha256:'.length)}`;
  return behavior.createBehaviorEvent({
    source_event_id: sourceId,
    project_id: input.projectId,
    session_id: `acceptance-${path.basename(evidence.runDir)}`,
    task_ref: `acceptance-task-${evidence.receipt.subjectHash.slice('sha256:'.length)}`,
    turn_ref: null,
    parent_event_id: input.sourcePromptEventRef || null,
    actor: { kind: 'system', id: 'acceptance-evaluator', role: null },
    runtime: 'unknown',
    source: 'agent_loop',
    source_assurance: 'verified',
    scope: { level: 'project', id: input.projectId },
    event_type: 'task.result',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'failed',
    final_disposition: 'rejected',
    details: {
      schema_version: FEEDBACK_SCHEMA_VERSION,
      contract_hash: evidence.contract.contractHash,
      receipt_hash: evidence.receipt.receiptHash,
      subject_hash: evidence.receipt.subjectHash,
      failed_criterion_ids: evidence.failedCriteria.map((criterion) => criterion.id),
      expectation_hash: stableHash(expectation),
      evaluation_account: 'acceptance-eval',
    },
    input_value: promptInput,
    output_value: expectation,
    evidence_refs: [],
    occurred_at: occurredAt,
  });
}

function findEvent(storeDir, eventId) {
  const journal = readJournal(storeDir);
  const tombstoned = new Set(journal.records
    .filter((record) => record.record_type === 'tombstone')
    .map((record) => record.entity_id));
  if (tombstoned.has(eventId)) throw new Error('acceptance feedback event is tombstoned');
  const record = journal.records.find((entry) => (
    entry.record_type === 'behavior_event' && entry.record_id === eventId
  ));
  return record ? behavior.normalizeBehaviorEvent(record.payload) : null;
}

function recordAcceptanceFeedback(input = {}) {
  const evidence = targetEvidence(input);
  const storeDir = resolveStoreDir(input.baseDir, input.projectId);
  const seed = feedbackEventInput(input, evidence, '2000-01-01T00:00:00.000Z');
  const existing = findEvent(storeDir, seed.event_id);
  if (existing) return { event: existing, replayed: true };
  const event = feedbackEventInput(input, evidence, new Date().toISOString());
  const written = behavior.appendBehaviorEvent(storeDir, event);
  return {
    event: written.event,
    replayed: false,
    expectation: expectationFromCriteria(evidence.failedCriteria),
  };
}

function promoteAcceptanceFeedbackCase(input = {}) {
  if (input.promote !== true) throw new Error('acceptance feedback case requires explicit promotion');
  const evidence = targetEvidence(input);
  const storeDir = resolveStoreDir(input.baseDir, input.projectId);
  const feedback = findEvent(storeDir, input.feedbackEventRef);
  if (!feedback || feedback.event_type !== 'task.result'
      || feedback.source !== 'agent_loop'
      || feedback.source_assurance !== 'verified'
      || feedback.status !== 'failed'
      || feedback.project_id !== input.projectId
      || feedback.details.contract_hash !== evidence.contract.contractHash
      || feedback.details.receipt_hash !== evidence.receipt.receiptHash) {
    throw new Error('acceptance feedback event does not match durable Receipt authority');
  }
  const expectation = expectationFromCriteria(evidence.failedCriteria);
  if (feedback.details.expectation_hash !== stableHash(expectation)) {
    throw new Error('acceptance feedback expectation binding is invalid');
  }
  return skillEvalCases.addCase(input.skillName, {
    id: input.caseId,
    input: input.input,
    expectation,
    source_event_ref: input.sourcePromptEventRef,
    tags: [
      'acceptance-eval',
      `feedback-${feedback.event_id.slice('behavior-event:'.length, 'behavior-event:'.length + 16)}`,
    ],
  }, {
    baseDir: input.baseDir,
    projectId: input.projectId,
    cwd: input.cwd,
  });
}

module.exports = {
  FEEDBACK_SCHEMA_VERSION,
  expectationFromCriteria,
  promoteAcceptanceFeedbackCase,
  recordAcceptanceFeedback,
  targetEvidence,
};
