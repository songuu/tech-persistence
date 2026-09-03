'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const acceptance = require('./lib/acceptance-contract');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');
const pipelineProviders = require('./agent-orchestrator/pipeline-providers');

const hash = (character) => `sha256:${character.repeat(64)}`;

const contract = acceptance.createAcceptanceContract({
  sourceRequirement: { requirement: '系统必须用不同 Oracle 验收结果。' },
  criteria: [
    {
      id: 'ac-command-passes',
      statement: '验证命令成功完成',
      sourceRefs: ['requirement:command'],
      oracle: { type: 'command', procedure: '运行冻结命令', expected: 'exit code is zero' },
    },
    {
      id: 'ac-artifact-exists',
      statement: '产物可从安全根目录读回',
      sourceRefs: ['requirement:artifact'],
      oracle: { type: 'artifact', procedure: 'artifact:artifacts/result.json', expected: '产物新鲜且摘要匹配' },
    },
    {
      id: 'ac-readback-matches',
      statement: '独立读回结果与目标一致',
      sourceRefs: ['requirement:readback'],
      oracle: { type: 'readback', procedure: '由独立 reader 读回', expected: '读回值匹配' },
    },
    {
      id: 'ac-review-is-independent',
      statement: '独立 reviewer 逐条确认结果',
      sourceRefs: ['requirement:review'],
      oracle: { type: 'independent-review', procedure: '逐 criterion 复审', expected: '独立 reviewer 通过' },
    },
    {
      id: 'ac-user-confirms',
      statement: '用户显式确认结果',
      sourceRefs: ['requirement:user'],
      oracle: { type: 'user-confirmation', procedure: '读取原生用户批准', expected: '批准绑定当前合同与结果' },
    },
  ],
});

const task = executionEnvelopes.createTaskEnvelope({
  ref: 'task:acceptance-test',
  orchestrationOwner: 'tp',
  intent: 'read-only',
  requiredCapabilities: [],
  payload: { purpose: 'acceptance-test' },
});
const route = { decisionHash: hash('a') };
const result = executionEnvelopes.createResultEnvelope({
  ref: 'result:acceptance-test',
  task,
  route,
  providerRef: 'claude:print',
  status: 'succeeded',
  effects: { state: 'none', refs: [] },
  runtimeRefs: {},
  native: null,
  evidence: { source: 'fixture' },
  payload: { value: 'done' },
});
const subject = executionEnvelopes.acceptanceSubjectForResult(result);
assert.strictEqual(acceptance.createAcceptanceReceipt({
  contract,
  subjectRef: result.ref,
  subject,
  results: contract.criteria.map((criterion) => ({
    criterionId: criterion.id,
    oracleHash: acceptance.oracleHash(criterion.oracle),
    status: 'unknown',
    evaluatorRef: 'runtime:agent-loop',
    evidenceRefs: [],
    observed: 'fixture',
  })),
}).subjectHash, result.hash);

function binding(criterionId, overrides = {}) {
  const criterion = contract.criteria.find((entry) => entry.id === criterionId);
  return {
    contractHash: contract.contractHash,
    subjectHash: result.hash,
    criterionId,
    oracleHash: acceptance.oracleHash(criterion.oracle),
    ...overrides,
  };
}

function assessment(criterionId, kind, payload, overrides = {}) {
  return {
    criterionId,
    observed: `assessment:${criterionId}`,
    evidence: [{
      kind,
      ref: `evidence:${criterionId}`,
      binding: binding(criterionId, overrides.binding),
      payload,
      ...overrides.evidence,
    }],
  };
}

const successfulAssessments = [
  assessment('ac-command-passes', 'command-execution', {
    policyAllowed: true,
    skipped: false,
    exitCode: 0,
    commandHash: hash('b'),
    logDigests: [hash('c')],
  }),
  assessment('ac-artifact-exists', 'artifact-readback', {
    withinRoot: true,
    exists: true,
    fresh: true,
    subjectBound: true,
    contentDigest: hash('d'),
  }),
  assessment('ac-readback-matches', 'runtime-readback', {
    independent: true,
    readerRef: 'runtime:reader',
    writerRef: 'runtime:writer',
    matched: true,
    resultDigest: hash('e'),
  }),
  assessment('ac-review-is-independent', 'independent-review', {
    reviewerRef: 'runtime:reviewer',
    writerRef: 'runtime:writer',
    criterionDecision: 'passed',
    perCriterion: true,
  }),
  assessment('ac-user-confirms', 'user-confirmation', {
    authority: 'native-user',
    explicit: true,
    decision: 'confirmed',
    controlEnvelopeDigest: hash('f'),
  }),
];

const authorityPendingReceipt = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: successfulAssessments,
});
assert.strictEqual(authorityPendingReceipt.overallStatus, 'unknown');
assert.deepStrictEqual(authorityPendingReceipt.results.map((entry) => entry.status), [
  'unknown', 'unknown', 'unknown', 'unknown', 'unknown',
]);
assert(authorityPendingReceipt.results.every((entry) => (
  entry.evidenceRefs.length === 1 && entry.evidenceRefs[0].assurance === 'claimed'
)));

const deterministicContract = acceptance.createAcceptanceContract({
  sourceRequirement: { requirement: '确定性 Oracle 子集' },
  criteria: contract.criteria.filter((criterion) => criterion.oracle.type !== 'user-confirmation'),
});
const deterministicAssessments = successfulAssessments.slice(0, 4).map((entry) => ({
  ...entry,
  evidence: entry.evidence.map((candidate) => {
    const criterion = deterministicContract.criteria.find((item) => item.id === entry.criterionId);
    return {
      ...candidate,
      binding: {
        ...candidate.binding,
        contractHash: deterministicContract.contractHash,
        oracleHash: acceptance.oracleHash(criterion.oracle),
      },
    };
  }),
}));
const passedReceipt = evaluator.evaluateAcceptance({
  contract: deterministicContract,
  subjectRef: result.ref,
  subject,
  assessments: deterministicAssessments,
});
assert.strictEqual(passedReceipt.overallStatus, 'unknown');

const commandSkipped = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: successfulAssessments.map((entry) => entry.criterionId === 'ac-command-passes'
    ? assessment('ac-command-passes', 'command-execution', {
      policyAllowed: true,
      skipped: true,
      exitCode: 0,
      commandHash: hash('b'),
      logDigests: [hash('c')],
    })
    : entry),
});
assert.strictEqual(commandSkipped.overallStatus, 'unknown');
assert.strictEqual(
  commandSkipped.results.find((entry) => entry.criterionId === 'ac-command-passes')
    .evidenceRefs[0].assurance,
  'claimed'
);

const summaryOnlyReview = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: successfulAssessments.map((entry) => entry.criterionId === 'ac-review-is-independent'
    ? assessment('ac-review-is-independent', 'independent-review', {
      reviewerRef: 'runtime:reviewer',
      writerRef: 'runtime:writer',
      criterionDecision: 'passed',
      perCriterion: false,
    })
    : entry),
});
assert.strictEqual(
  summaryOnlyReview.results.find((entry) => entry.criterionId === 'ac-review-is-independent').status,
  'unknown'
);

const staleEvidence = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: successfulAssessments.map((entry) => entry.criterionId === 'ac-readback-matches'
    ? assessment('ac-readback-matches', 'runtime-readback', {
      independent: true,
      readerRef: 'runtime:reader',
      writerRef: 'runtime:writer',
      matched: true,
      resultDigest: hash('e'),
    }, { binding: { subjectHash: hash('9') } })
    : entry),
});
assert.strictEqual(
  staleEvidence.results.find((entry) => entry.criterionId === 'ac-readback-matches').status,
  'unknown'
);

const wrongEvidenceType = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: successfulAssessments.map((entry) => entry.criterionId === 'ac-artifact-exists'
    ? assessment('ac-artifact-exists', 'runtime-readback', {
      independent: true,
      readerRef: 'runtime:reader',
      writerRef: 'runtime:writer',
      matched: true,
      resultDigest: hash('e'),
    })
    : entry),
});
assert.strictEqual(
  wrongEvidenceType.results.find((entry) => entry.criterionId === 'ac-artifact-exists').status,
  'unknown'
);

const verifiedFailure = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: successfulAssessments.map((entry) => entry.criterionId === 'ac-readback-matches'
    ? assessment('ac-readback-matches', 'runtime-readback', {
      independent: true,
      readerRef: 'runtime:reader',
      writerRef: 'runtime:writer',
      matched: false,
      resultDigest: hash('e'),
    })
    : entry),
});
assert.strictEqual(verifiedFailure.overallStatus, 'unknown');

const missingAssessment = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: successfulAssessments.slice(1),
});
assert.strictEqual(missingAssessment.results.length, contract.criteria.length);
assert.strictEqual(
  missingAssessment.results.find((entry) => entry.criterionId === 'ac-command-passes').status,
  'unknown'
);

assert.throws(() => evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: [...successfulAssessments, successfulAssessments[0]],
}), /duplicate assessment ac-command-passes/);
assert.throws(() => evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: [...successfulAssessments, { criterionId: 'ac-extra', observed: 'extra', evidence: [] }],
}), /unknown assessment ac-extra/);

const projection = executionEnvelopes.createAcceptanceReceiptProjection({
  contract: deterministicContract,
  receipt: passedReceipt,
  contractRef: 'acceptance-contract.json',
  receiptRef: 'acceptance-receipt.json',
});
assert.deepStrictEqual(projection.counts, { passed: 0, failed: 0, unknown: 4 });
assert.strictEqual(projection.mode, 'shadow');
assert.strictEqual(result.status, 'succeeded');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-shadow-'));
fs.writeFileSync(path.join(tempRoot, 'acceptance-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
fs.mkdirSync(path.join(tempRoot, 'slices', 'slice-1'), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, 'slices', 'slice-1', 'acceptance-assessments.json'),
  `${JSON.stringify(successfulAssessments, null, 2)}\n`
);
const shadow = pipelineProviders.recordShadowAcceptance({
  runDir: tempRoot,
  relativeDir: path.join('slices', 'slice-1'),
  subjectRef: result.ref,
  subject,
});
assert.strictEqual(shadow.status, 'written');
assert.strictEqual(shadow.projection.overallStatus, 'unknown');
assert(fs.existsSync(path.join(
  tempRoot,
  'slices',
  'slice-1',
  'acceptance-receipts',
  `contract-${shadow.receipt.contractHash.slice('sha256:'.length)}`,
  `subject-${shadow.receipt.subjectHash.slice('sha256:'.length)}.json`
)));

const changedAssessments = successfulAssessments.map((entry) => entry.criterionId === 'ac-command-passes'
  ? {
    ...entry,
    evidence: entry.evidence.map((candidate) => ({ ...candidate, ref: 'evidence:command-rerun' })),
  }
  : entry);
fs.writeFileSync(
  path.join(tempRoot, 'slices', 'slice-1', 'acceptance-assessments.json'),
  `${JSON.stringify(changedAssessments, null, 2)}\n`
);
const conflictingShadow = pipelineProviders.recordShadowAcceptance({
  runDir: tempRoot,
  relativeDir: path.join('slices', 'slice-1'),
  subjectRef: result.ref,
  subject,
});
assert.strictEqual(conflictingShadow.status, 'error');
assert.match(conflictingShadow.error, /immutable acceptance Receipt conflicts/);

const absentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-shadow-absent-'));
assert.deepStrictEqual(pipelineProviders.recordShadowAcceptance({
  runDir: absentRoot,
  relativeDir: '.',
  subjectRef: result.ref,
  subject,
}), { status: 'absent' });

fs.writeFileSync(
  path.join(tempRoot, 'slices', 'slice-1', 'acceptance-assessments.json'),
  `${JSON.stringify([...successfulAssessments, successfulAssessments[0]], null, 2)}\n`
);
const invalidShadow = pipelineProviders.recordShadowAcceptance({
  runDir: tempRoot,
  relativeDir: path.join('slices', 'slice-1'),
  subjectRef: result.ref,
  subject,
});
assert.strictEqual(invalidShadow.status, 'error');
assert(fs.existsSync(path.join(tempRoot, 'slices', 'slice-1', 'acceptance-shadow.error.json')));

console.log('agent-orchestrator-acceptance: all assertions passed');
