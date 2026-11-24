'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recoverPendingPromptReceipts } = require('./inject-context');
const { resolveStoreDir } = require('./lib/self-learning-store');
const { reportPromptReceiptWorkerFailure } = require('./lib/prompt-receipt-outbox');

test('session startup launches recovery only for an existing project outbox', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-session-recovery-'));
  try {
    const project = 'project-test';
    const calls = [];
    const launch = (dir, id) => { calls.push([dir, id]); return { status: 'started' }; };
    assert.equal(recoverPendingPromptReceipts(base, project, launch).status, 'absent');
    fs.mkdirSync(path.join(resolveStoreDir(base, project), 'prompt-outbox'), { recursive: true });
    assert.equal(recoverPendingPromptReceipts(base, project, launch).status, 'started');
    assert.deepEqual(calls, [[base, project]]);
    reportPromptReceiptWorkerFailure(path.join(resolveStoreDir(base, project), 'prompt-outbox'));
    assert.equal(recoverPendingPromptReceipts(base, project, launch).pending, true);
    assert.equal(recoverPendingPromptReceipts(base, project, () => ({ status: 'failed' })).status, 'failed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
