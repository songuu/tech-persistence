#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { normalizeTurnValidation } = require('./agent-orchestrator');

const passed = normalizeTurnValidation(
  { status: 'passed', source: 'validation.json', evidenceRef: 'validation.json' },
  { accepted: true }
);
assert.deepStrictEqual(
  { status: passed.status, sourceStatus: passed.sourceStatus },
  { status: 'passed', sourceStatus: 'passed' }
);
assert.match(passed.validationHash, /^sha256:[a-f0-9]{64}$/);

for (const status of ['skipped', 'failed']) {
  const gated = normalizeTurnValidation(
    { status, source: 'validation.json', evidenceRef: 'validation.json' },
    { accepted: true }
  );
  assert.strictEqual(gated.sourceStatus, status);
  assert.strictEqual(gated.status, 'failed');
}

const rejected = normalizeTurnValidation(
  { status: 'passed', source: 'structured-output' },
  { accepted: false }
);
assert.strictEqual(rejected.sourceStatus, 'passed');
assert.strictEqual(rejected.status, 'failed');

assert.throws(
  () => normalizeTurnValidation(null, { accepted: true }),
  /turn validation is required/
);
assert.throws(
  () => normalizeTurnValidation({ status: 'unknown' }, { accepted: true }),
  /status must be passed, failed, or skipped/
);


console.log('provider-turn-validation: passed');
