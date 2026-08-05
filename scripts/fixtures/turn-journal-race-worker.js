#!/usr/bin/env node
'use strict';

const turnTransaction = require('../agent-orchestrator/turn-transaction');

const payload = JSON.parse(
  Buffer.from(process.argv[2], 'base64url').toString('utf8')
);
const startAt = Number(process.argv[3]);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < startAt) {
  Atomics.wait(waitCell, 0, 0, Math.min(10, startAt - Date.now()));
}

try {
  const result = turnTransaction.recordAuthoritativeTurnPhase(
    payload.runDir,
    null,
    payload.input,
    payload.options
  );
  process.stdout.write(`${JSON.stringify({
    changed: result.changed,
    receiptHash: result.receipt.receiptHash,
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
