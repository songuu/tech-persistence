#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const turnTransaction = require('./agent-orchestrator/turn-transaction');
const structuredOutput = require('./agent-orchestrator/structured-output');
const receiptSchema = require('../schemas/agent-loop/turn-receipt.schema.json');

const {
  TURN_PHASES,
  advanceTurnJournal,
  createTurnJournal,
  deriveTurnKey,
  readTurnJournal,
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
transaction = advanceTurnJournal(transaction.journal, {
  phase: 'scheduler-apply',
  payload: { schedulerRef: 'schedule-1', status: 'applied' },
  at: AT.apply,
});
transaction = advanceTurnJournal(transaction.journal, {
  phase: 'scheduler-ack',
  payload: { schedulerRef: 'schedule-1', status: 'acknowledged' },
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

console.log('turn-transaction: passed');
