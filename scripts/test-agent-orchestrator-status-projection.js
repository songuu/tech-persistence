#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const turnTransaction = require('./agent-orchestrator/turn-transaction');

const orchestrator = path.join(__dirname, 'agent-orchestrator.js');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshotTree(root) {
  const result = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const relative = path.relative(root, full).replace(/\\/g, '/');
        result[relative] = { link: fs.readlinkSync(full) };
        continue;
      }

      const relative = path.relative(root, full).replace(/\\/g, '/');
      const stat = fs.statSync(full);
      result[relative] = {
        content: fs.readFileSync(full, 'utf8'),
        mtimeMs: stat.mtimeMs,
      };
    }
  };
  walk(root);
  return result;
}

function runStatusProjection(workdir, runId) {
  const result = spawnSync(process.execPath, [
    orchestrator, 'status', '--run', runId, '--workdir', workdir, '--json',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.strictEqual(
    result.status,
    0,
    `status command failed: ${result.stderr || result.stdout}`
  );
  return JSON.parse(result.stdout);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-status-projection-'));
const runId = 'run-status-projection';
const runDir = path.join(root, '.agent-runs', runId);

try {
  writeJson(path.join(runDir, 'state.json'), {
    runId,
    runDir,
    workdir: root,
    mode: 'pipeline',
    status: 'blocked',
    createdAt: '2026-08-04T01:00:00.000Z',
    updatedAt: '2026-08-04T02:00:00.000Z',
    files: {
      review: 'review.json',
      validation: 'validation.json',
    },
    providerRuns: [],
  });
  writeJson(path.join(runDir, 'queue.json'), {
    pending: [],
    ready: [],
    running: [],
    completed: [],
    blocked: [{ sliceId: 'slice-1', reason: 'requires operator decision' }],
    rejected: [],
    abandoned: [],
  });
  writeJson(path.join(runDir, 'review.json'), {
    decision: 'changes-requested',
    summary: 'operator decision is required',
    findings: [],
    followUpTasks: ['resolve the recorded blocker'],
  });
  writeJson(path.join(runDir, 'validation.json'), {
    status: 'passed',
    commands: [],
    generatedAt: '2026-08-04T01:55:00.000Z',
  });
  const turnIdentity = {
    runId,
    stage: 'slice-implementation',
    taskRef: 'task:status-projection',
    providerRef: 'codex:desktop',
  };
  const journalFile = path.join(
    runDir,
    'contracts',
    'slice-implementation.turn-journal.json'
  );
  [
    ['host-execute', { status: 'completed', providerRef: 'codex:desktop' }],
    ['typed-result', { material: true, resultRef: 'result:status-projection' }],
    ['validation', { status: 'passed', validatorRef: 'local-test' }],
    ['durable-writeback', { status: 'committed', stateRef: 'accepted-result' }],
  ].forEach(([phase, payload], index) => {
    turnTransaction.recordTurnPhase(journalFile, {
      identity: turnIdentity,
      phase,
      payload,
      createdAt: '2026-08-04T01:56:00.000Z',
      at: `2026-08-04T01:56:0${index + 1}.000Z`,
    });
  });


  const before = snapshotTree(runDir);
  const result = spawnSync(process.execPath, [
    orchestrator,
    'status',
    '--run',
    runId,
    '--workdir',
    root,
    '--json',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.strictEqual(
    result.status,
    0,
    `status command failed: ${result.stderr || result.stdout}`
  );
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.schemaVersion, 'agent-loop-status-v1');
  assert.deepStrictEqual(output.run, {
    runId,
    mode: 'pipeline',
    status: 'blocked',
    createdAt: '2026-08-04T01:00:00.000Z',
    updatedAt: '2026-08-04T02:00:00.000Z',
  });
  assert.strictEqual(output.operatorReviewPacket.permission, 'none');
  assert.strictEqual(output.operatorReviewPacket.schedulerHint.permission, 'none');
  assert.strictEqual(output.operatorReviewPacket.schedulerHint.action, 'wait');
  assert.strictEqual(output.operatorReviewPacket.boundary.writeAllowed, false);
  assert.strictEqual(output.operatorReviewPacket.boundary.intent, 'read-only');
  assert(output.operatorReviewPacket.evidenceRefs.includes('review.json'));
  assert(output.operatorReviewPacket.evidenceRefs.includes('validation.json'));
  assert(output.operatorReviewPacket.evidenceRefs.includes(
    'contracts/slice-implementation.turn-journal.json'
  ), JSON.stringify(output.operatorReviewPacket.evidenceRefs));
  assert.strictEqual(output.turnReceipt.status, 'in-progress');
  assert.strictEqual(output.turnReceipt.currentPhase, 'durable-writeback');
  assert.strictEqual(output.turnReceipt.nextPhase, 'scheduler-apply');
  assert.deepStrictEqual(output.turnReceipt.completedPhases, [
    'host-execute', 'typed-result', 'validation', 'durable-writeback',
  ]);
  assert.match(output.operatorReviewPacket.nextSafeAction, /resume|resolve|inspect/i);

  const after = snapshotTree(runDir);
  assert.deepStrictEqual(after, before, 'status projection must not modify run files');

  const externalStatusDir = path.join(root, 'external-status');
  const escapedMarker = 'outside-run-review-must-not-be-read';
  writeJson(path.join(externalStatusDir, 'review.json'), {
    decision: 'approved',
    summary: escapedMarker,
  });
  fs.symlinkSync(externalStatusDir, path.join(runDir, 'linked-review'), 'junction');
  const hardenedState = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  hardenedState.files.review = 'linked-review/review.json';
  writeJson(path.join(runDir, 'state.json'), hardenedState);
  const beforeLinkedRead = snapshotTree(runDir);
  const linkedOutput = runStatusProjection(root, runId);
  assert(!JSON.stringify(linkedOutput.operatorReviewPacket).includes(escapedMarker));
  assert.deepStrictEqual(
    snapshotTree(runDir), beforeLinkedRead, 'linked status artifact must remain unread and untouched'
  );

  const oversizedMarker = 'oversized-review-must-not-be-read';
  writeJson(path.join(runDir, 'oversized-review.json'), {
    decision: 'approved',
    summary: `${oversizedMarker}:${'x'.repeat(300 * 1024)}`,
  });
  hardenedState.files.review = 'oversized-review.json';
  writeJson(path.join(runDir, 'state.json'), hardenedState);
  const beforeOversizedRead = snapshotTree(runDir);
  const oversizedOutput = runStatusProjection(root, runId);
  assert(!JSON.stringify(oversizedOutput.operatorReviewPacket).includes(oversizedMarker));
  assert.match(oversizedOutput.operatorReviewPacket.reason, /latest validation status is passed/);
  assert.deepStrictEqual(
    snapshotTree(runDir), beforeOversizedRead, 'oversized status artifact must remain unread and untouched'
  );

  const contractsDir = path.join(runDir, 'contracts');
  const preservedContractsDir = path.join(runDir, 'contracts-preserved');
  const externalContractsDir = path.join(root, 'external-contracts');
  const escapedTurnMarker = 'outside-run-turn-journal-must-not-be-read';
  const externalJournalFile = path.join(
    externalContractsDir, 'escaped.turn-journal.json'
  );
  turnTransaction.recordTurnPhase(externalJournalFile, {
    identity: {
      runId: 'external-run',
      stage: 'external-stage',
      taskRef: escapedTurnMarker,
      providerRef: 'external:provider',
    },
    phase: 'host-execute',
    payload: { providerRef: 'external:provider', status: 'completed' },
    createdAt: '2026-08-04T02:10:00.000Z',
    at: '2026-08-04T02:10:01.000Z',
  });
  fs.renameSync(contractsDir, preservedContractsDir);
  fs.symlinkSync(externalContractsDir, contractsDir, 'junction');
  const beforeLinkedContractsRead = snapshotTree(runDir);
  const linkedContractsOutput = runStatusProjection(root, runId);
  assert.strictEqual(linkedContractsOutput.turnReceipt, null);
  assert(!JSON.stringify(linkedContractsOutput).includes(escapedTurnMarker));
  assert.deepStrictEqual(
    snapshotTree(runDir),
    beforeLinkedContractsRead,
    'linked contracts directory must remain unread and untouched'
  );
  fs.unlinkSync(contractsDir);
  fs.renameSync(preservedContractsDir, contractsDir);

  const corruptJournal = path.join(contractsDir, 'latest-corrupt.turn-journal.json');
  fs.writeFileSync(corruptJournal, '{not-json}\n');
  const future = new Date('2099-01-01T00:00:00.000Z');
  fs.utimesSync(corruptJournal, future, future);
  const oversizedJournal = path.join(contractsDir, 'oversized.turn-journal.json');
  fs.writeFileSync(oversizedJournal, 'x'.repeat(300 * 1024));
  fs.utimesSync(oversizedJournal, future, future);
  const beforeCorruptRead = snapshotTree(runDir);
  const corruptOutput = runStatusProjection(root, runId);
  assert.strictEqual(corruptOutput.turnReceipt.currentPhase, 'durable-writeback');
  assert(!corruptOutput.operatorReviewPacket.evidenceRefs.includes(
    'contracts/latest-corrupt.turn-journal.json'
  ));
  assert(!corruptOutput.operatorReviewPacket.evidenceRefs.includes(
    'contracts/oversized.turn-journal.json'
  ));
  assert.deepStrictEqual(
    snapshotTree(runDir),
    beforeCorruptRead,
    'unsafe latest journals must degrade without mutating run files'
  );
  console.log('[OK] status --json exposes a read-only operator control projection');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
