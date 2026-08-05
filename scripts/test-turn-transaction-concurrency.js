#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const turnTransaction = require('./agent-orchestrator/turn-transaction');

const worker = path.join(__dirname, 'fixtures', 'turn-journal-race-worker.js');

function childAttempt(payload, startAt) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const child = spawn(process.execPath, [worker, encoded, String(startAt)], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function race(payloads) {
  const startAt = Date.now() + 500;
  return Promise.all(payloads.map((payload) => childAttempt(payload, startAt)));
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-turn-race-'));
  const providerRoot = path.join(tempRoot, 'workspace');
  const runDir = path.join(providerRoot, '.agent-runs', 'race-run');
  const controlRoot = path.join(tempRoot, 'control');
  fs.mkdirSync(runDir, { recursive: true });
  const options = { controlRoot, providerRoot };

  try {
    const identity = {
      runId: 'race-run',
      stage: 'race-different-payload',
      taskRef: 'task:race-different',
      providerRef: 'codex:race',
    };
    const turnKey = turnTransaction.deriveTurnKey(identity);
    const base = {
      runDir,
      options,
      input: {
        identity,
        turnKey,
        phase: 'host-execute',
        expectedRevision: 0,
        expectedJournalHash: null,
      },
    };
    const different = await race([
      { ...base, input: { ...base.input, payload: { attempt: 'left' } } },
      { ...base, input: { ...base.input, payload: { attempt: 'right' } } },
    ]);
    assert.strictEqual(different.filter((result) => result.code === 0).length, 1);
    assert.strictEqual(different.filter((result) => result.code !== 0).length, 1);
    assert.match(
      different.find((result) => result.code !== 0).stderr,
      /turn-journal-update lock is active|different payload/
    );
    const persisted = turnTransaction.readAuthoritativeTurnJournal(
      runDir,
      turnKey,
      { ...options, legacyFiles: [] }
    );
    assert.strictEqual(persisted.receipt.journalRevision, 1);
    const loserPayload = persisted.journal.entries[0].payload.attempt === 'left'
      ? { attempt: 'right' }
      : { attempt: 'left' };
    assert.throws(() => turnTransaction.recordAuthoritativeTurnPhase(
      runDir,
      null,
      { ...base.input, payload: loserPayload },
      options
    ), /different payload/);

    const sameIdentity = {
      ...identity,
      stage: 'race-same-payload',
      taskRef: 'task:race-same',
    };
    const sameTurnKey = turnTransaction.deriveTurnKey(sameIdentity);
    const same = {
      runDir,
      options,
      input: {
        identity: sameIdentity,
        turnKey: sameTurnKey,
        phase: 'host-execute',
        payload: { attempt: 'same' },
        expectedRevision: 0,
        expectedJournalHash: null,
      },
    };
    const sameResults = await race([same, same]);
    assert(sameResults.some((result) => result.code === 0));
    const retry = turnTransaction.recordAuthoritativeTurnPhase(
      runDir,
      null,
      same.input,
      options
    );
    assert.strictEqual(retry.changed, false);
    assert.strictEqual(retry.receipt.journalRevision, 1);

    console.log('turn-transaction concurrency tests passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
