'use strict';

const assert = require('assert');
const path = require('path');
const acceptance = require('./lib/acceptance-contract');
const structuredOutput = require('./agent-orchestrator/structured-output');

const requirement = {
  requirement: '用户刷新页面后仍能恢复草稿，并能看到保存时间。',
  source: 'user-request',
};

const criteria = [
  {
    id: 'ac-user-can-save-draft',
    statement: '用户刷新页面后仍能恢复草稿',
    sourceRefs: ['requirement:user-request'],
    oracle: {
      type: 'readback',
      procedure: '重新加载目标并读取草稿内容',
      expected: '读回内容与保存值完全一致',
    },
  },
  {
    id: 'ac-user-sees-save-time',
    statement: '用户能看到最近一次草稿保存时间',
    sourceRefs: ['requirement:user-request', 'requirement:save-time'],
    oracle: {
      type: 'artifact',
      procedure: '读取保存后的草稿 artifact',
      expected: 'artifact 包含规范化保存时间',
    },
  },
];

const contract = acceptance.createAcceptanceContract({ sourceRequirement: requirement, criteria });
assert.strictEqual(contract.schemaVersion, 'acceptance-contract-v1');
assert.match(contract.sourceRequirementHash, /^sha256:[a-f0-9]{64}$/);
assert.match(contract.contractHash, /^sha256:[a-f0-9]{64}$/);
assert.deepStrictEqual(contract.criteria.map((criterion) => criterion.id), [
  'ac-user-can-save-draft',
  'ac-user-sees-save-time',
]);
assert.deepStrictEqual(acceptance.assertAcceptanceContract(contract, { sourceRequirement: requirement }), contract);

const reorderedContract = acceptance.createAcceptanceContract({
  sourceRequirement: { source: 'user-request', requirement: requirement.requirement },
  criteria: [
    { ...criteria[1], sourceRefs: [...criteria[1].sourceRefs].reverse() },
    criteria[0],
  ],
});
assert.strictEqual(reorderedContract.contractHash, contract.contractHash);
assert.deepStrictEqual(reorderedContract, contract);

assert.throws(
  () => acceptance.createAcceptanceContract({ sourceRequirement: requirement, criteria: [criteria[0], criteria[0]] }),
  /duplicate criterion id ac-user-can-save-draft/
);
assert.throws(
  () => acceptance.createAcceptanceContract({
    sourceRequirement: requirement,
    criteria: [{ ...criteria[0], sourceRefs: [] }],
  }),
  /sourceRefs must contain at least one entry/
);
assert.throws(
  () => acceptance.createAcceptanceContract({
    sourceRequirement: requirement,
    criteria: [{ ...criteria[0], id: 'invented' }],
  }),
  /criterion id must match/
);
assert.throws(
  () => acceptance.createAcceptanceContract({
    sourceRequirement: requirement,
    criteria: [{ ...criteria[0], sourceRefs: ['requirement:user-request', 'requirement:user-request'] }],
  }),
  /sourceRefs must not contain duplicates/
);
assert.throws(
  () => acceptance.createAcceptanceContract({
    sourceRequirement: requirement,
    criteria: [{
      ...criteria[0],
      oracle: {
        type: 'command',
        procedure: 'git diff --check',
        expected: 'exit zero',
      },
    }],
  }),
  /expected must be "exit code is zero"/
);
assert.throws(
  () => acceptance.assertAcceptanceContract({ ...contract, contractHash: `sha256:${'0'.repeat(64)}` }),
  /contractHash does not match canonical contract payload/
);
assert.throws(
  () => acceptance.assertAcceptanceContract({
    ...contract,
    criteria: contract.criteria.map((criterion, index) => index === 0
      ? { ...criterion, statement: '被篡改的验收语义' }
      : criterion),
  }),
  /contractHash does not match canonical contract payload/
);
assert.throws(
  () => acceptance.assertAcceptanceContract(contract, { sourceRequirement: { ...requirement, source: 'other' } }),
  /sourceRequirementHash does not match source requirement/
);

const subject = {
  ref: 'result:run-123',
  runId: 'run-123',
  resultHash: `sha256:${'1'.repeat(64)}`,
};
const passedResults = contract.criteria.map((criterion) => ({
  criterionId: criterion.id,
  oracleHash: acceptance.oracleHash(criterion.oracle),
  status: 'passed',
  evaluatorRef: 'runtime:agent-loop',
  evidenceRefs: [{
    kind: criterion.oracle.type === 'artifact' ? 'artifact-readback' : 'runtime-readback',
    ref: `validation:${criterion.id}`,
    digest: `sha256:${criterion.id === 'ac-user-can-save-draft' ? '2' : '3'}`.padEnd(71, criterion.id === 'ac-user-can-save-draft' ? '2' : '3'),
    assurance: 'verified',
  }],
  observed: `observed:${criterion.id}`,
}));

const receipt = acceptance.createAcceptanceReceipt({
  contract,
  subjectRef: 'result:run-123',
  subject,
  results: passedResults,
});
assert.strictEqual(receipt.overallStatus, 'passed');
assert.match(receipt.receiptHash, /^sha256:[a-f0-9]{64}$/);
assert.deepStrictEqual(acceptance.assertAcceptanceReceipt(receipt, { contract, subject }), receipt);

assert.throws(
  () => acceptance.createAcceptanceReceipt({
    contract,
    subjectRef: 'result:other',
    subject,
    results: passedResults,
  }),
  /subjectRef does not match subject.ref/
);
assert.throws(
  () => acceptance.createAcceptanceReceipt({
    contract,
    subjectRef: 'result:run-123',
    subject,
    results: passedResults.map((result, index) => index === 0
      ? { ...result, evidenceRefs: [] }
      : result),
  }),
  /passed result requires verified evidence matching the criterion Oracle/
);
assert.throws(
  () => acceptance.createAcceptanceReceipt({
    contract,
    subjectRef: 'result:run-123',
    subject,
    results: passedResults.map((result, index) => index === 0
      ? {
        ...result,
        evidenceRefs: result.evidenceRefs.map((evidenceRef) => ({
          ...evidenceRef,
          assurance: 'claimed',
        })),
      }
      : result),
  }),
  /passed result requires verified evidence matching the criterion Oracle/
);

const reorderedReceipt = acceptance.createAcceptanceReceipt({
  contract,
  subjectRef: 'result:run-123',
  subject: { resultHash: subject.resultHash, runId: subject.runId, ref: subject.ref },
  results: [...passedResults].reverse(),
});
assert.deepStrictEqual(reorderedReceipt, receipt);

assert.throws(
  () => acceptance.createAcceptanceReceipt({
    contract,
    subjectRef: 'result:run-123',
    subject,
    results: passedResults.slice(0, 1),
  }),
  /missing criterion result ac-user-sees-save-time/
);
assert.throws(
  () => acceptance.createAcceptanceReceipt({
    contract,
    subjectRef: 'result:run-123',
    subject,
    results: [...passedResults, { ...passedResults[0], criterionId: 'ac-extra' }],
  }),
  /unknown criterion result ac-extra/
);
assert.throws(
  () => acceptance.createAcceptanceReceipt({
    contract,
    subjectRef: 'result:run-123',
    subject,
    results: [...passedResults, passedResults[0]],
  }),
  /duplicate criterion result ac-user-can-save-draft/
);
assert.throws(
  () => acceptance.createAcceptanceReceipt({
    contract,
    subjectRef: 'result:run-123',
    subject,
    results: passedResults.map((result, index) => index === 0
      ? { ...result, oracleHash: `sha256:${'4'.repeat(64)}` }
      : result),
  }),
  /oracleHash does not match contract criterion ac-user-can-save-draft/
);

const failedReceipt = acceptance.createAcceptanceReceipt({
  contract,
  subjectRef: 'result:run-123',
  subject,
  results: passedResults.map((result, index) => index === 0
    ? { ...result, status: 'failed', evidenceRefs: [], observed: 'readback mismatched' }
    : result),
});
assert.strictEqual(failedReceipt.overallStatus, 'failed');

const unknownReceipt = acceptance.createAcceptanceReceipt({
  contract,
  subjectRef: 'result:run-123',
  subject,
  results: passedResults.map((result, index) => index === 0
    ? { ...result, status: 'unknown', evidenceRefs: [], observed: 'no independent readback' }
    : result),
});
assert.strictEqual(unknownReceipt.overallStatus, 'unknown');

assert.throws(
  () => acceptance.assertAcceptanceReceipt({ ...receipt, contractHash: `sha256:${'5'.repeat(64)}` }, { contract }),
  /receipt contractHash does not match contract/
);
assert.throws(
  () => acceptance.assertAcceptanceReceipt({ ...receipt, receiptHash: `sha256:${'6'.repeat(64)}` }, { contract }),
  /receiptHash does not match canonical receipt payload/
);
assert.throws(
  () => acceptance.assertAcceptanceReceipt(receipt, { contract, subject: { ...subject, runId: 'tampered' } }),
  /subjectHash does not match subject/
);
assert.throws(
  () => acceptance.assertAcceptanceReceipt({ ...receipt, overallStatus: 'unknown' }, { contract }),
  /overallStatus does not match result statuses/
);

for (const schemaRoot of [
  path.resolve(__dirname, '..', 'schemas', 'agent-loop'),
  path.resolve(__dirname, '..', 'plugins', 'tech-persistence', 'schemas', 'agent-loop'),
]) {
  structuredOutput.assertStructuredOutput(contract, {
    schemaRoot,
    schemaName: 'acceptance-contract.schema.json',
    label: `acceptance contract schema ${schemaRoot}`,
  });
  structuredOutput.assertStructuredOutput(receipt, {
    schemaRoot,
    schemaName: 'acceptance-receipt.schema.json',
    label: `acceptance receipt schema ${schemaRoot}`,
  });
}

console.log('acceptance-contract: all assertions passed');
