#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const freezeReceipt = require('./agent-orchestrator/freeze-receipt');
const globalContract = require('./agent-orchestrator/global-contract');
const sliceNormalizer = require('./agent-orchestrator/slice-normalizer');
const { stableHash } = require('./lib/self-learning-canonical');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-freeze-integrity-'));
const providerRoot = path.join(sandbox, 'provider');
const runDir = path.join(providerRoot, '.runs', 'fixture');
const controlRoot = path.join(sandbox, 'control');
fs.mkdirSync(runDir, { recursive: true });

try {
  const options = { controlRoot, providerRoot };
  const payload = { risk: 'L3', questions: [], validationCommands: ['npm test'] };
  const contractHash = stableHash({ contract: 'fixture' });
  const first = freezeReceipt.recordFreezeReceipt(runDir, {
    scopeRef: 'classic', contractHash, frozenPayload: payload,
  }, options);
  assert.strictEqual(first.acceptanceProtocol, 'v1');
  assert.deepStrictEqual(
    freezeReceipt.verifyFreezeReceipt(runDir, {
      scopeRef: 'classic', contractHash, frozenPayload: payload,
    }, options),
    first
  );
  assert.throws(() => freezeReceipt.verifyFreezeReceipt(runDir, {
    scopeRef: 'classic', contractHash, frozenPayload: { ...payload, risk: 'L4' },
  }, options), /does not match/);
  assert.throws(() => freezeReceipt.recordFreezeReceipt(runDir, {
    scopeRef: 'classic', contractHash, frozenPayload: { ...payload, questions: ['changed'] },
  }, options), /conflicts/);

  const base = globalContract.normalizeGlobalContract({
    goal: 'g', nonGoals: [], globalAcceptance: ['a'], architectureConstraints: [],
    runtimeTargets: ['codex'], riskLevel: 'L2', blockingQuestions: [],
    integrationValidationCommands: ['npm test'],
  });
  for (const mutation of [
    { riskLevel: 'L4' },
    { blockingQuestions: ['q'] },
    { integrationValidationCommands: ['npm test', 'npm run lint'] },
  ]) {
    assert.notStrictEqual(
      globalContract.normalizeGlobalContract({ ...base, ...mutation }).contractHash,
      base.contractHash
    );
  }
  const slice = sliceNormalizer.normalizeSlice({
    id: 'slice-criterion-owner', title: 'criterion owner', dependsOn: [],
    ownedFiles: ['a.js'], readFiles: ['b.js'], criterionIds: ['ac-known'],
    risk: 'L2', acceptanceCriteria: ['a'], doneCriteria: ['a'],
    validationCommands: ['npm test'], questions: [],
  }, { globalContractHash: base.contractHash, allowedCriterionIds: ['ac-known'] });
  assert.deepStrictEqual(slice.criterionIds, ['ac-known']);
  const unknown = sliceNormalizer.normalizeSlice({
    ...slice, criterionIds: ['ac-unknown'], contractHash: undefined,
  }, { globalContractHash: base.contractHash, allowedCriterionIds: ['ac-known'] });
  assert.match(unknown.questions.join('\n'), /unknown criterionIds/);
  assert.notStrictEqual(
    slice.contractHash,
    sliceNormalizer.computeSliceHash({ ...slice, readFiles: ['changed.js'] }, base.contractHash)
  );
  console.log('[OK] freeze receipt is immutable and hashes all global behavior fields');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
