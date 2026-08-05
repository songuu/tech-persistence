#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const controlStore = require('./agent-orchestrator/control-store');
const runLock = require('./agent-orchestrator/run-lock');
const turnTransaction = require('./agent-orchestrator/turn-transaction');
const { stableHash } = require('./agent-orchestrator/runtime-capabilities');
const structuredOutput = require('./agent-orchestrator/structured-output');
const receiptSchema = require('../schemas/agent-loop/turn-receipt.schema.json');

const {
  TURN_PHASES,
  advanceTurnJournal,
  createTurnJournal,
  deriveTurnKey,
  listAuthoritativeTurnJournals,
  readAuthoritativeTurnJournal,
  readTurnJournal,
  recordAuthoritativeTurnPhase,
  recordTurnPhase,
  replayTurnJournal,
  writeTurnJournalAtomic,
} = turnTransaction;

const TURN_IDENTITY = {
  goalId: 'goal-transaction-contract',
  agentId: 'agent-codex',
  todoId: 'todo-turn-receipt',
  actionHash: `sha256:${'a'.repeat(64)}`,
};

const AT = {
  created: '2026-08-04T08:00:00.000Z',
  host: '2026-08-04T08:00:01.000Z',
  result: '2026-08-04T08:00:02.000Z',
  validation: '2026-08-04T08:00:03.000Z',
  writeback: '2026-08-04T08:00:04.000Z',
  apply: '2026-08-04T08:00:05.000Z',
  ack: '2026-08-04T08:00:06.000Z',
};

assert.deepStrictEqual(TURN_PHASES, [
  'host-execute',
  'typed-result',
  'validation',
  'durable-writeback',
  'scheduler-apply',
  'scheduler-ack',
]);

assert.strictEqual(
  deriveTurnKey({ b: 2, a: { y: true, x: 'stable' } }),
  deriveTurnKey({ a: { x: 'stable', y: true }, b: 2 }),
  'turnKey must be stable across object key order'
);
assert.match(deriveTurnKey(TURN_IDENTITY), /^sha256:[a-f0-9]{64}$/);
assert.throws(() => deriveTurnKey({}), /turn identity must not be empty/);

let transaction = {
  journal: createTurnJournal({ identity: TURN_IDENTITY, at: AT.created }),
};
assert.strictEqual(transaction.journal.turnKey, deriveTurnKey(TURN_IDENTITY));
assert.strictEqual(replayTurnJournal(transaction.journal).nextPhase, 'host-execute');

assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'typed-result',
    payload: { material: true, resultRef: 'result-1' },
    at: AT.result,
  }),
  /phase order violation.*expected host-execute before typed-result/
);

transaction = advanceTurnJournal(transaction.journal, {
  phase: 'host-execute',
  payload: { providerRef: 'codex:desktop', invocationRef: 'invocation-1' },
  at: AT.host,
});
assert.strictEqual(transaction.changed, true);
assert.strictEqual(transaction.receipt.currentPhase, 'host-execute');
assert.strictEqual(transaction.receipt.journalRevision, 1);

const idempotentHost = advanceTurnJournal(transaction.journal, {
  phase: 'host-execute',
  payload: { invocationRef: 'invocation-1', providerRef: 'codex:desktop' },
  at: '2026-08-04T09:00:00.000Z',
});
assert.strictEqual(idempotentHost.changed, false);
assert.deepStrictEqual(idempotentHost.journal, transaction.journal);
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'host-execute',
    payload: { providerRef: 'claude:cli', invocationRef: 'invocation-1' },
    at: AT.host,
  }),
  /phase host-execute conflict.*different payload/
);

transaction = advanceTurnJournal(transaction.journal, {
  phase: 'typed-result',
  payload: { material: true, resultRef: 'result-1' },
  at: AT.result,
});
assert.strictEqual(transaction.receipt.material, true);

assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'scheduler-apply',
    payload: { schedulerRef: 'schedule-1' },
    at: AT.apply,
  }),
  /phase order violation.*expected validation before scheduler-apply/
);
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'validation',
    payload: { status: 'skipped', validatorRef: 'validator-1' },
    at: AT.validation,
  }),
  /material typed result requires validation and cannot be skipped/
);

const failedValidation = advanceTurnJournal(transaction.journal, {
  phase: 'validation',
  payload: { status: 'failed', validatorRef: 'validator-1' },
  at: AT.validation,
});
assert.strictEqual(failedValidation.receipt.validationStatus, 'failed');
assert.throws(
  () => advanceTurnJournal(failedValidation.journal, {
    phase: 'durable-writeback',
    payload: { status: 'committed', stateRef: 'invalid-state-revision' },
    at: AT.writeback,
  }),
  /material typed result requires passed validation before durable-writeback/
);

transaction = advanceTurnJournal(transaction.journal, {
  phase: 'validation',
  payload: { status: 'passed', validatorRef: 'validator-1' },
  at: AT.validation,
});
assert.strictEqual(transaction.receipt.validationStatus, 'passed');
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'scheduler-apply',
    payload: { schedulerRef: 'schedule-1' },
    at: AT.apply,
  }),
  /phase order violation.*expected durable-writeback before scheduler-apply/
);

transaction = advanceTurnJournal(transaction.journal, {
  phase: 'durable-writeback',
  payload: { status: 'committed', stateRef: 'state-revision-2' },
  at: AT.writeback,
});
const schedulerHint = {
  schemaVersion: 'scheduler-hint-v1',
  permission: 'none',
  action: 'wait',
  reason: 'wait for the next host-owned turn',
  resetToken: 'reset:' + 'b'.repeat(64),
};
const appliedStateHash = 'sha256:' + 'c'.repeat(64);
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'scheduler-apply',
    payload: { schedulerRef: 'schedule-1' },
    at: AT.apply,
  }),
  /scheduler-apply payload.schedulerOwner must be a non-empty string/
);
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'scheduler-apply',
    payload: {
      schedulerOwner: 'tp',
      schedulerRef: 'schedule-1',
      hint: { ...schedulerHint, permission: 'execute' },
      hintHash: stableHash({ ...schedulerHint, permission: 'execute' }),
      appliedStateHash,
    },
    at: AT.apply,
  }),
  /scheduler-apply payload.hint.permission must be none/
);
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'scheduler-apply',
    payload: {
      schedulerOwner: 'tp',
      schedulerRef: 'schedule-1',
      hint: schedulerHint,
      hintHash: 'sha256:' + 'd'.repeat(64),
      appliedStateHash,
    },
    at: AT.apply,
  }),
  /scheduler-apply payload.hintHash does not match hint/
);
const schedulerApplyPayload = {
  schedulerOwner: 'tp',
  schedulerRef: 'schedule-1',
  hint: schedulerHint,
  hintHash: stableHash(schedulerHint),
  appliedStateHash,
};
transaction = advanceTurnJournal(transaction.journal, {
  phase: 'scheduler-apply',
  payload: schedulerApplyPayload,
  at: AT.apply,
});
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'scheduler-ack',
    payload: {
      status: 'acknowledged',
      schedulerRef: 'schedule-1',
      applyPayloadHash: stableHash(schedulerApplyPayload),
      observedStateHash: appliedStateHash,
    },
    at: AT.ack,
  }),
  /scheduler-ack payload.status must be confirmed/
);
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'scheduler-ack',
    payload: {
      status: 'confirmed',
      schedulerRef: 'schedule-other',
      applyPayloadHash: stableHash(schedulerApplyPayload),
      observedStateHash: appliedStateHash,
    },
    at: AT.ack,
  }),
  /scheduler-ack schedulerRef does not match scheduler-apply/
);
assert.throws(
  () => advanceTurnJournal(transaction.journal, {
    phase: 'scheduler-ack',
    payload: {
      status: 'confirmed',
      schedulerRef: 'schedule-1',
      applyPayloadHash: stableHash(schedulerApplyPayload),
      observedStateHash: 'sha256:' + 'e'.repeat(64),
    },
    at: AT.ack,
  }),
  /scheduler-ack observedStateHash does not match appliedStateHash/
);
transaction = advanceTurnJournal(transaction.journal, {
  phase: 'scheduler-ack',
  payload: {
    status: 'confirmed',
    schedulerRef: 'schedule-1',
    applyPayloadHash: stableHash(schedulerApplyPayload),
    observedStateHash: appliedStateHash,
  },
  at: AT.ack,
});

assert.strictEqual(transaction.receipt.status, 'committed');
assert.strictEqual(transaction.receipt.nextPhase, null);
assert.deepStrictEqual(transaction.receipt.completedPhases, TURN_PHASES);
assert.deepStrictEqual(replayTurnJournal(transaction.journal), transaction.receipt);
assert.match(transaction.receipt.receiptHash, /^sha256:[a-f0-9]{64}$/);
const schemaRoot = path.resolve(__dirname, '..', 'schemas', 'agent-loop');
structuredOutput.assertStructuredOutput(transaction.receipt, {
  schemaRoot,
  schemaName: 'turn-receipt.schema.json',
  label: 'turn receipt',
});
assert.throws(() => structuredOutput.assertStructuredOutput(
  { ...transaction.receipt, receiptHash: 'invalid' },
  {
    schemaRoot,
    schemaName: 'turn-receipt.schema.json',
    label: 'turn receipt',
  }
), /receiptHash.*pattern/);
const committedDuplicate = advanceTurnJournal(transaction.journal, {
  phase: 'host-execute',
  payload: { invocationRef: 'invocation-1', providerRef: 'codex:desktop' },
  at: '2026-08-04T11:00:00.000Z',
});
assert.strictEqual(committedDuplicate.changed, false);
assert.strictEqual(committedDuplicate.receipt.status, 'committed');

const nonMaterial = advanceTurnJournal(
  advanceTurnJournal(
    advanceTurnJournal(
      createTurnJournal({
        identity: { ...TURN_IDENTITY, todoId: 'todo-non-material' },
        at: AT.created,
      }),
      {
        phase: 'host-execute',
        payload: { providerRef: 'codex:desktop' },
        at: AT.host,
      }
    ).journal,
    {
      phase: 'typed-result',
      payload: { material: false, resultRef: 'quiet-observation' },
      at: AT.result,
    }
  ).journal,
  {
    phase: 'validation',
    payload: { status: 'skipped', reason: 'no material transition' },
    at: AT.validation,
  }
);
assert.strictEqual(nonMaterial.receipt.validationStatus, 'skipped');

const tampered = JSON.parse(JSON.stringify(transaction.journal));
tampered.entries[0].payload.providerRef = 'tampered:provider';
assert.throws(
  () => replayTurnJournal(tampered),
  /turn journal hash does not match/
);

assert.strictEqual(receiptSchema.properties.schemaVersion.const, 'turn-receipt-v1');
assert.strictEqual(receiptSchema.additionalProperties, false);
assert.deepStrictEqual(
  receiptSchema.properties.completedPhases.items.enum,
  TURN_PHASES
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-turn-transaction-'));
try {
  const journalFile = path.join(tempRoot, 'turn-journal.json');
  const firstWrite = recordTurnPhase(journalFile, {
    identity: TURN_IDENTITY,
    phase: 'host-execute',
    payload: { providerRef: 'codex:desktop', invocationRef: 'persisted-1' },
    at: AT.host,
    createdAt: AT.created,
  });
  assert.strictEqual(firstWrite.changed, true);
  assert.strictEqual(fs.existsSync(journalFile), true);
  assert.strictEqual(
    fs.readdirSync(tempRoot).some((name) => name.endsWith('.tmp')),
    false,
    'atomic write must not leave a temporary file behind'
  );
  assert.throws(
    () => recordTurnPhase(journalFile, {
      identity: TURN_IDENTITY,
      turnKey: `sha256:${'b'.repeat(64)}`,
      phase: 'host-execute',
      payload: { providerRef: 'codex:desktop', invocationRef: 'persisted-1' },
      at: AT.host,
    }),
    /provided turnKey does not match turn identity/
  );

  const replayed = replayTurnJournal(readTurnJournal(journalFile));
  assert.deepStrictEqual(replayed, firstWrite.receipt);

  const duplicateWrite = recordTurnPhase(journalFile, {
    identity: { ...TURN_IDENTITY },
    phase: 'host-execute',
    payload: { invocationRef: 'persisted-1', providerRef: 'codex:desktop' },
    at: '2026-08-04T10:00:00.000Z',
  });
  assert.strictEqual(duplicateWrite.changed, false);
  assert.strictEqual(duplicateWrite.receipt.journalRevision, 1);

  const replacementWrite = recordTurnPhase(journalFile, {
    identity: TURN_IDENTITY,
    phase: 'typed-result',
    payload: { material: false, resultRef: 'persisted-result-1' },
    at: AT.result,
  });
  assert.strictEqual(replacementWrite.changed, true);
  assert.strictEqual(replacementWrite.receipt.journalRevision, 2);
  assert.strictEqual(
    replayTurnJournal(readTurnJournal(journalFile)).currentPhase,
    'typed-result',
    'atomic replacement must persist the next journal revision'
  );
  assert.strictEqual(
    fs.readdirSync(tempRoot).some((name) => name.endsWith('.tmp')),
    false,
    'atomic replacement must clean its temporary file'
  );

  assert.throws(
    () => recordTurnPhase(journalFile, {
      identity: TURN_IDENTITY,
      phase: 'host-execute',
      payload: { providerRef: 'claude:cli', invocationRef: 'persisted-1' },
      at: AT.host,
    }),
    /phase host-execute conflict.*different payload/
  );

  const corruptFile = path.join(tempRoot, 'corrupt-journal.json');
  fs.writeFileSync(corruptFile, '{not-json}\n');
  assert.throws(
    () => readTurnJournal(corruptFile),
    new RegExp(`failed to read turn journal.*${path.basename(corruptFile)}`)
  );

  const blockedParent = path.join(tempRoot, 'blocked-parent');
  fs.writeFileSync(blockedParent, 'not a directory\n');
  assert.throws(
    () => writeTurnJournalAtomic(
      path.join(blockedParent, 'journal.json'),
      createTurnJournal({
        identity: { ...TURN_IDENTITY, todoId: 'todo-write-failure' },
        at: AT.created,
      })
    ),
    /failed to atomically write turn journal.*blocked-parent/
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const readOnlyFixture = fs.mkdtempSync(
  path.join(os.tmpdir(), 'tp-turn-authority-read-only-')
);
try {
  const readOnlyRunDir = path.join(readOnlyFixture, 'provider-run');
  const absentControlRoot = path.join(readOnlyFixture, 'absent-control');
  fs.mkdirSync(readOnlyRunDir, { recursive: true });
  assert.strictEqual(
    readAuthoritativeTurnJournal(
      readOnlyRunDir,
      deriveTurnKey({ ...TURN_IDENTITY, todoId: 'todo-read-only' }),
      { controlRoot: absentControlRoot }
    ),
    null
  );
  assert.deepStrictEqual(
    listAuthoritativeTurnJournals(readOnlyRunDir, {
      controlRoot: absentControlRoot,
      legacyFiles: [],
    }),
    []
  );
  assert.strictEqual(
    fs.existsSync(absentControlRoot),
    false,
    'read/list must not create an external control store'
  );
} finally {
  fs.rmSync(readOnlyFixture, { recursive: true, force: true });
}

const authorityFixture = fs.mkdtempSync(
  path.join(os.tmpdir(), 'tp-turn-authority-')
);
try {
  const runDir = path.join(authorityFixture, 'provider-run');
  const controlRoot = path.join(authorityFixture, 'external-control');
  const contractsDir = path.join(runDir, 'contracts');
  fs.mkdirSync(contractsDir, { recursive: true });

  const identityA = { ...TURN_IDENTITY, todoId: 'todo-authority-a' };
  const turnKeyA = deriveTurnKey(identityA);
  const legacyA = path.join(contractsDir, 'misleading-name.turn-journal.json');
  const hostPayloadA = {
    providerRef: 'codex:desktop',
    invocationRef: 'authority-a',
  };
  const firstAuthority = recordAuthoritativeTurnPhase(
    runDir,
    legacyA,
    {
      identity: identityA,
      turnKey: turnKeyA,
      phase: 'host-execute',
      payload: hostPayloadA,
      at: AT.host,
      createdAt: AT.created,
      expectedRevision: 0,
      expectedJournalHash: null,
    },
    { controlRoot }
  );
  assert.strictEqual(firstAuthority.changed, true);
  assert.strictEqual(firstAuthority.receipt.journalRevision, 1);
  assert.strictEqual(fs.existsSync(legacyA), false);
  assert.strictEqual(fs.existsSync(firstAuthority.authorityFile), true);
  assert.strictEqual(
    firstAuthority.authorityFile,
    path.join(
      controlStore.controlRunDir(runDir, { controlRoot }),
      'turn-journals',
      turnKeyA.slice('sha256:'.length) + '.json'
    ),
    'legacy projection names must not influence the authority path'
  );
  assert.strictEqual(
    firstAuthority.authorityRef,
    'control:turn-journals/' + turnKeyA.slice('sha256:'.length) + '.json'
  );
  assert.strictEqual(
    firstAuthority.authorityRef.includes(path.resolve(controlRoot)),
    false,
    'authorityRef must not disclose the absolute controlRoot'
  );

  const readFirst = readAuthoritativeTurnJournal(
    runDir,
    turnKeyA,
    { controlRoot, legacyFiles: [legacyA] }
  );
  assert.deepStrictEqual(readFirst.journal, firstAuthority.journal);
  assert.deepStrictEqual(readFirst.receipt, firstAuthority.receipt);
  assert.strictEqual(readFirst.changed, false);

  const staleIdempotent = recordAuthoritativeTurnPhase(
    runDir,
    path.join(contractsDir, 'different-legacy-path.turn-journal.json'),
    {
      identity: identityA,
      phase: 'host-execute',
      payload: { invocationRef: 'authority-a', providerRef: 'codex:desktop' },
      at: '2026-08-04T12:00:00.000Z',
      expectedRevision: 99,
      expectedJournalHash: 'sha256:' + 'f'.repeat(64),
    },
    { controlRoot }
  );
  assert.strictEqual(staleIdempotent.changed, false);
  assert.strictEqual(staleIdempotent.authorityFile, firstAuthority.authorityFile);
  assert.throws(
    () => recordAuthoritativeTurnPhase(
      runDir,
      legacyA,
      {
        identity: identityA,
        phase: 'host-execute',
        payload: { providerRef: 'claude:cli', invocationRef: 'authority-a' },
        expectedRevision: 99,
        expectedJournalHash: 'sha256:' + 'f'.repeat(64),
      },
      { controlRoot }
    ),
    /phase host-execute conflict.*different payload/
  );

  const typedPayloadA = { material: false, resultRef: 'authority-result-a' };
  assert.throws(
    () => recordAuthoritativeTurnPhase(
      runDir,
      legacyA,
      {
        identity: identityA,
        phase: 'typed-result',
        payload: typedPayloadA,
        at: AT.result,
        expectedRevision: 0,
        expectedJournalHash: firstAuthority.journal.journalHash,
      },
      { controlRoot }
    ),
    /journal revision conflict: expected 0, current 1/
  );
  assert.throws(
    () => recordAuthoritativeTurnPhase(
      runDir,
      legacyA,
      {
        identity: identityA,
        phase: 'typed-result',
        payload: typedPayloadA,
        at: AT.result,
        expectedRevision: 1,
        expectedJournalHash: 'sha256:' + '0'.repeat(64),
      },
      { controlRoot }
    ),
    /journal hash conflict: expected .* current/
  );
  const typedAuthority = recordAuthoritativeTurnPhase(
    runDir,
    legacyA,
    {
      identity: identityA,
      phase: 'typed-result',
      payload: typedPayloadA,
      at: AT.result,
      expectedRevision: firstAuthority.journal.revision,
      expectedJournalHash: firstAuthority.journal.journalHash,
    },
    { controlRoot }
  );
  assert.strictEqual(typedAuthority.receipt.journalRevision, 2);

  const liveLock = runLock.acquireRunLock(
    runDir,
    'turn-journal-update',
    { command: 'test-live-journal-lock', pid: process.pid },
    { controlRoot }
  );
  try {
    assert.throws(
      () => recordAuthoritativeTurnPhase(
        runDir,
        legacyA,
        {
          identity: identityA,
          phase: 'validation',
          payload: { status: 'skipped', reason: 'non-material turn' },
          at: AT.validation,
          expectedRevision: typedAuthority.journal.revision,
          expectedJournalHash: typedAuthority.journal.journalHash,
        },
        { controlRoot }
      ),
      /turn-journal-update lock is active/
    );
  } finally {
    liveLock.release();
  }
  assert.strictEqual(
    readAuthoritativeTurnJournal(runDir, turnKeyA, { controlRoot })
      .journal.revision,
    2
  );

  const deadLockDir = runLock.lockPath(
    runDir,
    'turn-journal-update',
    { controlRoot }
  );
  fs.mkdirSync(deadLockDir);
  fs.writeFileSync(
    path.join(deadLockDir, 'owner.json'),
    JSON.stringify({
      schemaVersion: 'run-lock-v1',
      name: 'turn-journal-update',
      token: 'dead-turn-journal-owner',
      pid: 2147483647,
      acquiredAt: '2020-01-01T00:00:00.000Z',
    }) + String.fromCharCode(10)
  );
  const validatedAuthority = recordAuthoritativeTurnPhase(
    runDir,
    legacyA,
    {
      identity: identityA,
      phase: 'validation',
      payload: { status: 'skipped', reason: 'non-material turn' },
      at: AT.validation,
      expectedRevision: typedAuthority.journal.revision,
      expectedJournalHash: typedAuthority.journal.journalHash,
    },
    { controlRoot }
  );
  assert.strictEqual(validatedAuthority.receipt.journalRevision, 3);
  assert.strictEqual(fs.existsSync(deadLockDir), false);

  fs.writeFileSync(
    legacyA,
    '{corrupt legacy projection}' + String.fromCharCode(10)
  );
  const ignoresLegacyAfterAuthority = recordAuthoritativeTurnPhase(
    runDir,
    legacyA,
    {
      identity: identityA,
      phase: 'validation',
      payload: { reason: 'non-material turn', status: 'skipped' },
      expectedRevision: 0,
      expectedJournalHash: 'sha256:' + '1'.repeat(64),
    },
    { controlRoot }
  );
  assert.strictEqual(ignoresLegacyAfterAuthority.changed, false);
  assert.strictEqual(
    ignoresLegacyAfterAuthority.authorityFile,
    firstAuthority.authorityFile
  );

  const oldRunDir = path.join(authorityFixture, 'old-provider-run');
  const oldControlRoot = path.join(authorityFixture, 'old-external-control');
  const oldContractsDir = path.join(oldRunDir, 'contracts');
  fs.mkdirSync(oldContractsDir, { recursive: true });
  const oldControlDir = controlStore.ensureControlRunDir(
    oldRunDir,
    { controlRoot: oldControlRoot }
  );
  const oldJournalsDir = path.join(oldControlDir, 'turn-journals');
  fs.mkdirSync(oldJournalsDir);
  const identityB = { ...TURN_IDENTITY, todoId: 'todo-authority-migration' };
  const legacyB = path.join(oldContractsDir, 'migration.turn-journal.json');
  const legacyHostB = recordTurnPhase(legacyB, {
    identity: identityB,
    phase: 'host-execute',
    payload: { providerRef: 'codex:desktop', invocationRef: 'legacy-b' },
    at: '2026-08-04T08:00:04.000Z',
    createdAt: AT.created,
  });
  assert.strictEqual(
    readAuthoritativeTurnJournal(
      oldRunDir,
      deriveTurnKey(identityB),
      { controlRoot: oldControlRoot, legacyFiles: [legacyB] }
    ).source,
    'legacy',
    'an old run may read legacy journals before authority is enabled'
  );
  assert.strictEqual(
    listAuthoritativeTurnJournals(oldRunDir, {
      controlRoot: oldControlRoot,
      legacyFiles: [legacyB],
    })[0].source,
    'legacy',
    'an empty authoritative directory must not enable the gate'
  );
  fs.writeFileSync(
    path.join(oldJournalsDir, 'orphan-write.123.tmp'),
    '{partial authoritative write'
  );
  assert.strictEqual(
    readAuthoritativeTurnJournal(
      oldRunDir,
      deriveTurnKey(identityB),
      { controlRoot: oldControlRoot, legacyFiles: [legacyB] }
    ).source,
    'legacy',
    'an orphan tmp file must not enable the authority gate'
  );
  assert.strictEqual(
    listAuthoritativeTurnJournals(oldRunDir, {
      controlRoot: oldControlRoot,
      legacyFiles: [legacyB],
    })[0].source,
    'legacy'
  );
  const migratedDuplicate = recordAuthoritativeTurnPhase(
    oldRunDir,
    legacyB,
    {
      identity: identityB,
      phase: 'host-execute',
      payload: { invocationRef: 'legacy-b', providerRef: 'codex:desktop' },
      expectedRevision: 999,
      expectedJournalHash: 'sha256:' + '2'.repeat(64),
    },
    { controlRoot: oldControlRoot }
  );
  assert.strictEqual(migratedDuplicate.changed, false);
  assert.strictEqual(fs.existsSync(migratedDuplicate.authorityFile), true);
  const migratedNext = recordAuthoritativeTurnPhase(
    oldRunDir,
    legacyB,
    {
      identity: identityB,
      phase: 'typed-result',
      payload: { material: false, resultRef: 'migrated-b' },
      at: '2026-08-04T08:00:05.000Z',
      expectedRevision: migratedDuplicate.journal.revision,
      expectedJournalHash: migratedDuplicate.journal.journalHash,
    },
    { controlRoot: oldControlRoot }
  );
  assert.strictEqual(migratedNext.journal.revision, 2);
  assert.strictEqual(
    readTurnJournal(legacyB).revision,
    legacyHostB.journal.revision,
    'authoritative updates must not write back to the legacy projection'
  );

  const corruptRunDir = path.join(authorityFixture, 'corrupt-provider-run');
  const corruptControlRoot = path.join(authorityFixture, 'corrupt-external-control');
  const corruptContractsDir = path.join(corruptRunDir, 'contracts');
  fs.mkdirSync(corruptContractsDir, { recursive: true });
  const corruptIdentity = {
    ...TURN_IDENTITY,
    todoId: 'todo-corrupt-authority-gate',
  };
  const corruptLegacy = path.join(
    corruptContractsDir,
    'valid-legacy.turn-journal.json'
  );
  recordTurnPhase(corruptLegacy, {
    identity: corruptIdentity,
    phase: 'host-execute',
    payload: { providerRef: 'codex:desktop', invocationRef: 'legacy-corrupt-run' },
    at: '2026-08-04T08:00:06.000Z',
    createdAt: AT.created,
  });
  const corruptControlDir = controlStore.ensureControlRunDir(
    corruptRunDir,
    { controlRoot: corruptControlRoot }
  );
  const corruptJournalsDir = path.join(corruptControlDir, 'turn-journals');
  fs.mkdirSync(corruptJournalsDir);
  const unrelatedTurnKey = deriveTurnKey({
    ...corruptIdentity,
    todoId: 'todo-corrupt-unrelated-authority',
  });
  fs.writeFileSync(
    path.join(
      corruptJournalsDir,
      unrelatedTurnKey.slice('sha256:'.length) + '.json'
    ),
    '{corrupt authoritative journal'
  );
  assert.throws(
    () => readAuthoritativeTurnJournal(
      corruptRunDir,
      deriveTurnKey(corruptIdentity),
      { controlRoot: corruptControlRoot, legacyFiles: [corruptLegacy] }
    ),
    /failed to read turn journal/,
    'any corrupt authoritative JSON must fail closed during read'
  );
  assert.throws(
    () => listAuthoritativeTurnJournals(corruptRunDir, {
      controlRoot: corruptControlRoot,
      legacyFiles: [corruptLegacy],
    }),
    /failed to read turn journal/,
    'any corrupt authoritative JSON must fail closed during list'
  );
  assert.throws(
    () => recordAuthoritativeTurnPhase(
      corruptRunDir,
      corruptLegacy,
      {
        identity: corruptIdentity,
        phase: 'host-execute',
        payload: {
          providerRef: 'codex:desktop',
          invocationRef: 'legacy-corrupt-run',
        },
        expectedRevision: 0,
        expectedJournalHash: null,
      },
      { controlRoot: corruptControlRoot }
    ),
    /failed to read turn journal/,
    'a corrupt authority directory must not admit another migration'
  );

  const identityC = { ...TURN_IDENTITY, todoId: 'todo-forged-legacy-after-authority' };
  const legacyC = path.join(contractsDir, 'forged-after-authority.turn-journal.json');
  const forgedLegacyC = recordTurnPhase(legacyC, {
    identity: identityC,
    phase: 'host-execute',
    payload: { providerRef: 'provider-visible', invocationRef: 'forged-c' },
    at: '2026-08-04T08:00:06.000Z',
    createdAt: AT.created,
  });
  assert.strictEqual(
    readAuthoritativeTurnJournal(
      runDir,
      deriveTurnKey(identityC),
      { controlRoot, legacyFiles: [legacyC] }
    ),
    null,
    'authority-enabled runs must not read a new legacy turnKey'
  );
  assert.strictEqual(
    listAuthoritativeTurnJournals(runDir, {
      controlRoot,
      legacyFiles: [legacyC],
    }).some((item) => item.journal.turnKey === deriveTurnKey(identityC)),
    false,
    'authority-enabled runs must not list a new legacy turnKey'
  );
  assert.throws(
    () => recordAuthoritativeTurnPhase(
      runDir,
      legacyC,
      {
        identity: identityC,
        phase: 'typed-result',
        payload: { material: false, resultRef: 'must-not-migrate' },
        at: '2026-08-04T08:00:07.000Z',
        expectedRevision: forgedLegacyC.journal.revision,
        expectedJournalHash: forgedLegacyC.journal.journalHash,
      },
      { controlRoot }
    ),
    /journal revision conflict: expected 1, current 0/,
    'authority-enabled runs must not migrate a new provider-visible legacy turn'
  );
  assert.strictEqual(
    readAuthoritativeTurnJournal(
      runDir,
      deriveTurnKey(identityC),
      { controlRoot, legacyFiles: [legacyC] }
    ),
    null
  );

  const identityD = { ...TURN_IDENTITY, todoId: 'todo-authority-latest' };
  const latestAuthority = recordAuthoritativeTurnPhase(
    runDir,
    null,
    {
      identity: identityD,
      phase: 'host-execute',
      payload: { providerRef: 'codex:desktop', invocationRef: 'authority-d' },
      at: '2026-08-04T08:00:07.000Z',
      createdAt: AT.created,
      expectedRevision: 0,
    },
    { controlRoot }
  );
  fs.utimesSync(
    validatedAuthority.authorityFile,
    new Date('2030-01-01T00:00:00.000Z'),
    new Date('2030-01-01T00:00:00.000Z')
  );
  fs.utimesSync(
    latestAuthority.authorityFile,
    new Date('2020-01-01T00:00:00.000Z'),
    new Date('2020-01-01T00:00:00.000Z')
  );

  const listed = listAuthoritativeTurnJournals(runDir, {
    controlRoot,
    legacyFiles: [legacyA, legacyC],
  });
  assert.strictEqual(
    listed.some((item) => item.journal.turnKey === deriveTurnKey(identityC)),
    false,
    'authority-enabled list must ignore all provider-visible legacy-only turns'
  );
  const listedAuthorities = listed.filter((item) => item.source === 'authority');
  assert.strictEqual(
    listedAuthorities[0].journal.turnKey,
    latestAuthority.journal.turnKey,
    'journal order must use phase recordedAt instead of file mtime'
  );
  for (let index = 1; index < listed.length; index += 1) {
    const previous = listed[index - 1];
    const current = listed[index];
    assert(
      previous.recordedAt > current.recordedAt
        || (previous.recordedAt === current.recordedAt
          && previous.journal.turnKey <= current.journal.turnKey),
      'journal list order must be deterministic by recordedAt and turnKey'
    );
  }
  assert.strictEqual(
    readAuthoritativeTurnJournal(
      oldRunDir,
      deriveTurnKey(identityB),
      { controlRoot: oldControlRoot, legacyFiles: [legacyB] }
    ).source,
    'authority'
  );
  assert.strictEqual(
    readAuthoritativeTurnJournal(
      runDir,
      deriveTurnKey(identityC),
      { controlRoot, legacyFiles: [legacyC] }
    ),
    null
  );
} finally {
  fs.rmSync(authorityFixture, { recursive: true, force: true });
}
console.log('turn-transaction: passed');
