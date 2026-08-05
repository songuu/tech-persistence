#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const controlStore = require('./agent-orchestrator/control-store');
const runLock = require('./agent-orchestrator/run-lock');
const { stableHash } = require('./agent-orchestrator/runtime-capabilities');
const turnTransaction = require('./agent-orchestrator/turn-transaction');
const turnBudget = require('./agent-orchestrator/turn-budget');
const structuredOutput = require('./agent-orchestrator/structured-output');
const turnBudgetSchema = require('../schemas/agent-loop/turn-budget.schema.json');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

const RUN_ID = 'run-budget';
function workspace(label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tp-turn-budget-${label}-`));
  const runDir = path.join(base, 'run');
  const controlRoot = path.join(base, 'control');
  fs.mkdirSync(runDir);
  return { base, runDir, controlRoot };
}

function cleanup(value) {
  fs.rmSync(value.base, { recursive: true, force: true });
}
function storeOptions(value) {
  return { controlRoot: value.controlRoot };
}

function assertLedgerSchema(ledger) {
  structuredOutput.assertStructuredOutput(ledger, {
    schemaRoot: path.resolve(__dirname, '..', 'schemas', 'agent-loop'),
    schemaName: 'turn-budget.schema.json',
    label: 'turn budget ledger',
  });
}

function receiptFor(label, options = {}) {
  const acceptedResultHash = options.acceptedResultHash || HASH_A;
  const identity = { taskRef: 'task:' + label };
  if (options.omitRunId !== true) {
    identity.runId = options.runId || 'run-budget';
  }
  let journal = turnTransaction.createTurnJournal({
    identity,
    at: '2026-08-05T00:00:00.000Z',
  });
  journal = turnTransaction.advanceTurnJournal(journal, {
    phase: 'host-execute',
    payload: { status: 'success', providerRef: 'codex:desktop' },
    at: '2026-08-05T00:00:01.000Z',
  }).journal;
  journal = turnTransaction.advanceTurnJournal(journal, {
    phase: 'typed-result',
    payload: {
      material: options.material !== false,
      resultHash: acceptedResultHash,
    },
    at: '2026-08-05T00:00:02.000Z',
  }).journal;
  journal = turnTransaction.advanceTurnJournal(journal, {
    phase: 'validation',
    payload: {
      status: options.validationStatus || 'passed',
      validatorRef: 'validator:1',
    },
    at: '2026-08-05T00:00:03.000Z',
  }).journal;
  if (options.durable === false) {
    return turnTransaction.replayTurnJournal(journal);
  }
  journal = turnTransaction.advanceTurnJournal(journal, {
    phase: 'durable-writeback',
    payload: {
      status: 'committed',
      acceptedResultHash,
      acceptanceHash: options.acceptanceHash || HASH_B,
    },
    at: '2026-08-05T00:00:04.000Z',
  }).journal;
  return turnTransaction.replayTurnJournal(journal);
}

assert.strictEqual(turnBudget.normalizeRunId(' run-budget '), RUN_ID);
assert.throws(() => turnBudget.normalizeRunId('  '), /non-empty string/);
assert.strictEqual(turnBudget.normalizeMaxSlots(undefined), null);
assert.strictEqual(turnBudget.normalizeMaxSlots(false), null);
assert.strictEqual(turnBudget.normalizeMaxSlots(false), null);
assert.strictEqual(turnBudget.normalizeMaxSlots('3'), 3);
assert.deepStrictEqual(turnBudget.normalizePolicy(), {
  enabled: false,
  maxSlots: null,
});
assert.deepStrictEqual(turnBudget.normalizePolicy({ maxSlots: '3' }), {
  enabled: true,
  maxSlots: 3,
});
assert.deepStrictEqual(turnBudget.normalizePolicy(2), {
  enabled: true,
  maxSlots: 2,
});
assert.throws(() => turnBudget.normalizeMaxSlots(0), /positive integer/);
assert.throws(() => turnBudget.normalizeMaxSlots(1.5), /positive integer/);
assert.throws(
  () => turnBudget.normalizeMaxSlots(turnBudget.MAX_TURN_BUDGET_SLOTS + 1),
  /must not exceed/
);
assert.throws(
  () => turnBudget.normalizePolicy({ enabled: false, maxSlots: 1 }),
  /disabled.*maxSlots/
);

const empty = workspace('empty');
try {
  assert.strictEqual(
    turnBudget.readTurnBudgetLedger(empty.runDir, storeOptions(empty)),
    null
  );
  assert.deepStrictEqual(turnBudget.turnBudgetProjection(null, undefined), {
    schemaVersion: 'agent-loop-turn-budget-projection-v1',
    authority: 'legacy-disabled-default',
    enabled: false,
    max: null,
    used: 0,
    remaining: null,
    exhausted: false,
    revision: 0,
  });
  assert.throws(
    () => turnBudget.turnBudgetProjection(
      null,
      { enabled: false, maxSlots: null }
    ),
    /missing for a persisted policy/
  );
  assert.throws(
    () => turnBudget.assertCanRun(
      empty.runDir,
      RUN_ID,
      storeOptions(empty)
    ),
    /authoritative turn budget ledger is missing/
  );
  assert.throws(
    () => turnBudget.ensureTurnBudgetForResume(
      empty.runDir,
      RUN_ID,
      { maxSlots: 2 },
      storeOptions(empty)
    ),
    /missing for persisted policy/
  );
  assert.throws(
    () => turnBudget.ensureTurnBudgetForResume(
      empty.runDir,
      RUN_ID,
      { enabled: false, maxSlots: null },
      storeOptions(empty)
    ),
    /missing for persisted policy/
  );
  assert.strictEqual(
    fs.existsSync(empty.controlRoot),
    false,
    'read-only legacy status and failed gates must not initialize authority'
  );

  const migrated = turnBudget.ensureTurnBudgetForResume(
    empty.runDir,
    RUN_ID,
    undefined,
    storeOptions(empty)
  );
  assert.strictEqual(migrated.changed, true);
  assert.strictEqual(migrated.ledger.runId, RUN_ID);
  assert.strictEqual(migrated.ledger.enabled, false);
  assert.strictEqual(migrated.ledger.maxSlots, null);
  assert.strictEqual(migrated.ledger.revision, 0);
  assert.deepStrictEqual(migrated.ledger.spends, []);
  assert.strictEqual(migrated.projection.authority, 'external-control-store');
  assert.strictEqual(migrated.projection.enabled, false);
  assertLedgerSchema(migrated.ledger);

  const migratedRetry = turnBudget.ensureTurnBudgetForResume(
    empty.runDir,
    RUN_ID,
    undefined,
    storeOptions(empty)
  );
  assert.strictEqual(migratedRetry.changed, false);
  assert.deepStrictEqual(migratedRetry.ledger, migrated.ledger);
  assert.strictEqual(
    turnBudget.assertCanRun(empty.runDir, RUN_ID, storeOptions(empty)).enabled,
    false
  );
  assert.throws(
    () => turnBudget.ensureTurnBudgetForResume(
      empty.runDir,
      'run-foreign',
      undefined,
      storeOptions(empty)
    ),
    /runId conflict/
  );
} finally {
  cleanup(empty);
}

const invalid = workspace('invalid-before-init');
try {
  const firstReceipt = receiptFor('invalid-first');
  assert.throws(
    () => turnBudget.spendSlot(invalid.runDir, {
      durableReceipt: firstReceipt,
      acceptedResultHash: HASH_A,
    }, storeOptions(invalid)),
    /runId must be a non-empty string/
  );
  assert.throws(
    () => turnBudget.spendSlot(invalid.runDir, {
      runId: RUN_ID,
      acceptedResultHash: HASH_A,
    }, storeOptions(invalid)),
    /durable receipt is required/
  );
  assert.throws(
    () => turnBudget.spendSlot(invalid.runDir, {
      runId: RUN_ID,
      durableReceipt: receiptFor('not-durable', { durable: false }),
      acceptedResultHash: HASH_A,
    }, storeOptions(invalid)),
    /durable-writeback/
  );
  assert.throws(
    () => turnBudget.spendSlot(invalid.runDir, {
      runId: RUN_ID,
      durableReceipt: receiptFor('failed', {
        material: false,
        validationStatus: 'failed',
      }),
      acceptedResultHash: HASH_A,
    }, storeOptions(invalid)),
    /failed validation/
  );
  assert.throws(
    () => turnBudget.spendSlot(invalid.runDir, {
      runId: RUN_ID,
      durableReceipt: { ...firstReceipt, receiptHash: HASH_B },
      acceptedResultHash: HASH_A,
    }, storeOptions(invalid)),
    /receipt hash does not match/
  );
  assert.throws(
    () => turnBudget.spendSlot(invalid.runDir, {
      runId: RUN_ID,
      durableReceipt: firstReceipt,
      acceptedResultHash: HASH_B,
    }, storeOptions(invalid)),
    /accepted result hash conflict/
  );
  assert.throws(
    () => turnBudget.spendSlot(invalid.runDir, {
      runId: RUN_ID,
      durableReceipt: receiptFor('missing-run-id', { omitRunId: true }),
      acceptedResultHash: HASH_A,
    }, storeOptions(invalid)),
    /identity.runId must be a non-empty string/
  );
  assert.strictEqual(
    fs.existsSync(invalid.controlRoot),
    false,
    'invalid evidence must be rejected before authority initialization'
  );
} finally {
  cleanup(invalid);
}
const budgeted = workspace('budgeted');
try {
  const firstReceipt = receiptFor('first');
  const secondReceipt = receiptFor('second', { acceptedResultHash: HASH_B });
  const thirdReceipt = receiptFor('third');

  const initialized = turnBudget.initializeTurnBudget(
    budgeted.runDir,
    RUN_ID,
    { maxSlots: 2 },
    storeOptions(budgeted)
  );
  assert.strictEqual(initialized.changed, true);
  assert.strictEqual(initialized.ledger.runId, RUN_ID);
  assert.strictEqual(initialized.ledger.enabled, true);
  assert.strictEqual(initialized.ledger.maxSlots, 2);
  assert.strictEqual(initialized.ledger.revision, 0);
  assert.deepStrictEqual(initialized.ledger.spends, []);
  assert.strictEqual(initialized.projection.remaining, 2);
  assertLedgerSchema(initialized.ledger);

  const initRetry = turnBudget.initializeTurnBudget(
    budgeted.runDir,
    RUN_ID,
    { maxSlots: 2 },
    storeOptions(budgeted)
  );
  assert.strictEqual(initRetry.changed, false);
  assert.deepStrictEqual(initRetry.ledger, initialized.ledger);
  assert.throws(
    () => turnBudget.initializeTurnBudget(
      budgeted.runDir,
      RUN_ID,
      { maxSlots: 3 },
      storeOptions(budgeted)
    ),
    /policy conflict/
  );
  assert.throws(
    () => turnBudget.initializeTurnBudget(
      budgeted.runDir,
      'run-foreign',
      { maxSlots: 2 },
      storeOptions(budgeted)
    ),
    /runId conflict/
  );
  assert.throws(
    () => turnBudget.assertCanRun(
      budgeted.runDir,
      'run-foreign',
      storeOptions(budgeted)
    ),
    /runId conflict/
  );

  fs.writeFileSync(
    path.join(budgeted.runDir, 'state.json'),
    JSON.stringify({
      runId: RUN_ID,
      turnBudgetPolicy: { enabled: false, maxSlots: null },
    }, null, 2) + '\n'
  );
  const gateAfterStateTamper = turnBudget.assertCanRun(
    budgeted.runDir,
    RUN_ID,
    storeOptions(budgeted)
  );
  assert.strictEqual(gateAfterStateTamper.enabled, true);
  assert.strictEqual(gateAfterStateTamper.max, 2);
  assert.strictEqual(gateAfterStateTamper.remaining, 2);

  const foreignReceipt = receiptFor('foreign', { runId: 'run-foreign' });
  assert.throws(
    () => turnBudget.spendSlot(budgeted.runDir, {
      runId: RUN_ID,
      durableReceipt: foreignReceipt,
      acceptedResultHash: HASH_A,
    }, storeOptions(budgeted)),
    /receipt runId conflict/
  );
  assert.throws(
    () => turnBudget.spendSlot(budgeted.runDir, {
      runId: 'run-foreign',
      durableReceipt: foreignReceipt,
      acceptedResultHash: HASH_A,
    }, storeOptions(budgeted)),
    /runId conflict/
  );

  const firstSpend = turnBudget.spendSlot(budgeted.runDir, {
    runId: RUN_ID,
    policy: { enabled: false, maxSlots: null },
    durableReceipt: firstReceipt,
    acceptedResultHash: HASH_A,
    spentAt: '2026-08-05T00:10:00.000Z',
  }, storeOptions(budgeted));
  assert.strictEqual(firstSpend.changed, true);
  assert.strictEqual(firstSpend.ledger.revision, 1);
  assert.strictEqual(firstSpend.ledger.spends.length, 1);
  assert.strictEqual(firstSpend.spend.turnKey, firstReceipt.turnKey);
  assert.strictEqual(
    firstSpend.spend.durableReceiptHash,
    firstReceipt.receiptHash
  );
  assert.strictEqual(firstSpend.projection.used, 1);
  assert.strictEqual(firstSpend.projection.remaining, 1);
  assert.strictEqual(firstSpend.projection.authority, 'external-control-store');
  assert.strictEqual(
    JSON.stringify(firstSpend.projection).includes(budgeted.base),
    false
  );

  const ledgerPath = turnBudget.turnBudgetPath(
    budgeted.runDir,
    storeOptions(budgeted)
  );
  assert.strictEqual(ledgerPath.startsWith(path.resolve(budgeted.runDir)), false);
  assert.strictEqual(
    ledgerPath.toLowerCase().startsWith(
      path.resolve(budgeted.controlRoot).toLowerCase()
    ),
    true
  );
  const ledger = turnBudget.readTurnBudgetLedger(
    budgeted.runDir,
    storeOptions(budgeted)
  );
  assert.deepStrictEqual(ledger, firstSpend.ledger);
  assertLedgerSchema(ledger);
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(ledgerPath)).filter(
      (name) => name.endsWith('.tmp')
    ),
    []
  );

  const retry = turnBudget.spendSlot(budgeted.runDir, {
    runId: RUN_ID,
    durableReceipt: firstReceipt,
    acceptedResultHash: HASH_A,
    spentAt: '2026-08-05T00:11:00.000Z',
  }, storeOptions(budgeted));
  assert.strictEqual(retry.changed, false);
  assert.deepStrictEqual(retry.spend, firstSpend.spend);

  const conflictingReceipt = receiptFor('first', { acceptanceHash: HASH_A });
  assert.strictEqual(conflictingReceipt.turnKey, firstReceipt.turnKey);
  assert.notStrictEqual(conflictingReceipt.receiptHash, firstReceipt.receiptHash);
  assert.throws(
    () => turnBudget.spendSlot(budgeted.runDir, {
      runId: RUN_ID,
      durableReceipt: conflictingReceipt,
      acceptedResultHash: HASH_A,
    }, storeOptions(budgeted)),
    /turn budget spend conflict/
  );

  const secondSpend = turnBudget.spendSlot(budgeted.runDir, {
    runId: RUN_ID,
    durableReceipt: secondReceipt,
    acceptedResultHash: HASH_B,
    spentAt: '2026-08-05T00:12:00.000Z',
  }, storeOptions(budgeted));
  assert.strictEqual(secondSpend.changed, true);
  assert.strictEqual(secondSpend.ledger.revision, 2);
  assert.strictEqual(secondSpend.projection.exhausted, true);
  assert.strictEqual(secondSpend.projection.remaining, 0);
  assert.throws(
    () => turnBudget.assertCanRun(
      budgeted.runDir,
      RUN_ID,
      storeOptions(budgeted)
    ),
    (error) => error.code === 'TURN_BUDGET_EXHAUSTED'
      && error.projection.exhausted === true
  );
  assert.throws(
    () => turnBudget.spendSlot(budgeted.runDir, {
      runId: RUN_ID,
      durableReceipt: thirdReceipt,
      acceptedResultHash: HASH_A,
    }, storeOptions(budgeted)),
    /turn budget exhausted/
  );
  const exhaustedRetry = turnBudget.spendSlot(budgeted.runDir, {
    runId: RUN_ID,
    durableReceipt: secondReceipt,
    acceptedResultHash: HASH_B,
  }, storeOptions(budgeted));
  assert.strictEqual(exhaustedRetry.changed, false);
  assert.strictEqual(exhaustedRetry.ledger.revision, 2);

  const originalLedgerText = fs.readFileSync(ledgerPath, 'utf8');
  const runIdTampered = JSON.parse(originalLedgerText);
  runIdTampered.runId = 'run-foreign';
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify(runIdTampered, null, 2) + '\n'
  );
  assert.throws(
    () => turnBudget.readTurnBudgetLedger(
      budgeted.runDir,
      storeOptions(budgeted)
    ),
    /ledger hash does not match/
  );
  fs.writeFileSync(ledgerPath, originalLedgerText);

  const spendTampered = JSON.parse(originalLedgerText);
  spendTampered.spends[0].acceptedResultHash = HASH_B;
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify(spendTampered, null, 2) + '\n'
  );
  assert.throws(
    () => turnBudget.readTurnBudgetLedger(
      budgeted.runDir,
      storeOptions(budgeted)
    ),
    /spend hash does not match/
  );
} finally {
  cleanup(budgeted);
}

const disabled = workspace('disabled');
try {
  const initialized = turnBudget.initializeTurnBudget(
    disabled.runDir,
    RUN_ID,
    { enabled: false, maxSlots: null },
    storeOptions(disabled)
  );
  assert.strictEqual(initialized.ledger.enabled, false);
  assert.strictEqual(initialized.ledger.maxSlots, null);
  assertLedgerSchema(initialized.ledger);
  assert.strictEqual(
    turnBudget.assertCanRun(
      disabled.runDir,
      RUN_ID,
      storeOptions(disabled)
    ).enabled,
    false
  );
  assert.throws(
    () => turnBudget.spendSlot(disabled.runDir, {
      runId: RUN_ID,
      durableReceipt: receiptFor('disabled'),
      acceptedResultHash: HASH_A,
    }, storeOptions(disabled)),
    /turn budget is disabled/
  );
} finally {
  cleanup(disabled);
}
const liveLocked = workspace('live-lock');
try {
  const receipt = receiptFor('live-lock');
  turnBudget.initializeTurnBudget(
    liveLocked.runDir,
    RUN_ID,
    { maxSlots: 1 },
    storeOptions(liveLocked)
  );
  const lock = runLock.acquireRunLock(
    liveLocked.runDir,
    'turn-budget-update',
    { command: 'test-live-lock' },
    storeOptions(liveLocked)
  );
  try {
    assert.throws(
      () => turnBudget.spendSlot(liveLocked.runDir, {
        runId: RUN_ID,
        durableReceipt: receipt,
        acceptedResultHash: HASH_A,
      }, storeOptions(liveLocked)),
      /turn-budget-update lock is active/
    );
    assert.strictEqual(
      turnBudget.readTurnBudgetLedger(
        liveLocked.runDir,
        storeOptions(liveLocked)
      ).revision,
      0
    );
  } finally {
    lock.release();
  }
} finally {
  cleanup(liveLocked);
}

const deadLocked = workspace('dead-lock');
try {
  const receipt = receiptFor('dead-lock');
  turnBudget.initializeTurnBudget(
    deadLocked.runDir,
    RUN_ID,
    { maxSlots: 1 },
    storeOptions(deadLocked)
  );
  runLock.acquireRunLock(
    deadLocked.runDir,
    'turn-budget-update',
    { command: 'test-dead-lock', pid: 999999 },
    storeOptions(deadLocked)
  );
  const recovered = turnBudget.spendSlot(deadLocked.runDir, {
    runId: RUN_ID,
    durableReceipt: receipt,
    acceptedResultHash: HASH_A,
  }, {
    controlRoot: deadLocked.controlRoot,
    lockOptions: { isProcessAlive: () => false },
  });
  assert.strictEqual(recovered.changed, true);
} finally {
  cleanup(deadLocked);
}

const staleLocked = workspace('stale-lock');
try {
  const receipt = receiptFor('stale-lock');
  turnBudget.initializeTurnBudget(
    staleLocked.runDir,
    RUN_ID,
    { maxSlots: 1 },
    storeOptions(staleLocked)
  );
  const controlDir = controlStore.ensureControlRunDir(
    staleLocked.runDir,
    storeOptions(staleLocked)
  );
  const lockDir = path.join(controlDir, '.turn-budget-update.lock');
  fs.mkdirSync(lockDir);
  const old = new Date('2026-08-04T00:00:00.000Z');
  fs.utimesSync(lockDir, old, old);
  const recovered = turnBudget.spendSlot(staleLocked.runDir, {
    runId: RUN_ID,
    durableReceipt: receipt,
    acceptedResultHash: HASH_A,
  }, {
    controlRoot: staleLocked.controlRoot,
    lockOptions: {
      unknownOwnerStaleMs: 1_000,
      nowMs: new Date('2026-08-05T00:00:00.000Z').getTime(),
    },
  });
  assert.strictEqual(recovered.changed, true);
} finally {
  cleanup(staleLocked);
}
console.log('turn-budget tests passed');
