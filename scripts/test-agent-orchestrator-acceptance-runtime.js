'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const acceptance = require('./lib/acceptance-contract');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-runtime-'));
const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-runtime-control-'));
const controlStoreOptions = { providerRoot: workdir, controlRoot };
const runDir = path.join(workdir, '.agent-runs', 'run-1');
fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
const workspaceSnapshot = {
  headSha: 'sha256:test-head',
  changedFilesHash: digest('changed-files'),
  diffHash: digest('diff'),
};

const spec = {
  requirementSpec: {
    summary: '运行冻结验证命令',
    userValue: '避免未经验证的完成声明',
    scope: ['agent-loop'],
    acceptanceCriteria: ['验证命令成功完成'],
  },
  acceptanceContract: {
    criteria: [{
      id: 'ac-validation-command',
      statement: '验证命令成功完成',
      sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
      oracle: {
        type: 'command',
        procedure: 'git diff --check',
        expected: 'exit code is zero',
      },
    }],
  },
};

const contract = evaluator.writeAcceptanceContractForSpec(runDir, spec);
assert.deepStrictEqual(
  acceptance.assertAcceptanceContract(contract, { sourceRequirement: spec.requirementSpec }),
  contract
);
assert.strictEqual(
  JSON.parse(fs.readFileSync(path.join(runDir, 'acceptance-contract.json'), 'utf8')).contractHash,
  contract.contractHash
);

const defaultContract = evaluator.createAcceptanceContractFromCriteria({
  sourceRequirement: { acceptanceCriteria: ['用户能看到结果'] },
  criteria: ['用户能看到结果'],
  sourceRef: 'spec.json#/requirementSpec/acceptanceCriteria',
});
assert.strictEqual(defaultContract.criteria[0].oracle.type, 'independent-review');
assert.match(defaultContract.criteria[0].id, /^ac-[a-f0-9]{16}$/);
assert.throws(() => evaluator.createAcceptanceContractFromCriteria({
  sourceRequirement: { acceptanceCriteria: ['验证命令失败'] },
  sourceRef: 'spec.json#/requirementSpec/acceptanceCriteria',
  criteria: [{
    id: 'ac-invalid-command-expectation',
    statement: '验证命令失败',
    sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
    oracle: { type: 'command', procedure: 'git diff --check', expected: 'exit code is non-zero' },
  }],
}), /expected must be "exit code is zero"/);

const task = executionEnvelopes.createTaskEnvelope({
  ref: 'task:runtime-evidence',
  orchestrationOwner: 'tp',
  intent: 'read-only',
  requiredCapabilities: [],
  payload: { purpose: 'runtime-evidence' },
});
const result = executionEnvelopes.createResultEnvelope({
  ref: 'result:runtime-evidence',
  task,
  route: { decisionHash: digest('route') },
  providerRef: 'claude:review',
  status: 'succeeded',
  effects: { state: 'none', refs: [] },
  runtimeRefs: {},
  native: null,
  evidence: {},
  payload: { decision: 'approved' },
});
const subject = executionEnvelopes.acceptanceSubjectForResult(result);
const criterion = contract.criteria[0];
const forgedAssessment = {
  criterionId: criterion.id,
  observed: 'provider claims success',
  evidence: [{
    kind: 'command-execution',
    ref: 'provider:claim',
    binding: {
      contractHash: contract.contractHash,
      subjectHash: result.hash,
      criterionId: criterion.id,
      oracleHash: acceptance.oracleHash(criterion.oracle),
    },
    payload: {
      policyAllowed: true,
      skipped: false,
      exitCode: 0,
      commandHash: digest('git diff --check'),
      logDigests: [digest('forged')],
    },
  }],
};

const forgedReceipt = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  assessments: [forgedAssessment],
});
assert.strictEqual(forgedReceipt.overallStatus, 'unknown');
assert.strictEqual(forgedReceipt.results[0].evidenceRefs[0].assurance, 'claimed');

const stdout = 'clean diff\n';
const stderr = '';
fs.writeFileSync(path.join(runDir, 'logs', 'command.stdout.log'), stdout);
fs.writeFileSync(path.join(runDir, 'logs', 'command.stderr.log'), stderr);
fs.writeFileSync(path.join(runDir, 'integration-validation.json'), `${JSON.stringify({
  schemaVersion: 'integration-validation-v1',
  attemptId: 'attempt-1',
  status: 'passed',
  artifactRef: 'integration-validation.json',
  commands: [{
    index: 0,
    command: 'git diff --check',
    status: 'passed',
    exitStatus: 0,
    timedOut: false,
    error: null,
    stdout: { ref: 'logs/command.stdout.log', hash: digest(stdout), bytes: Buffer.byteLength(stdout), redacted: true },
    stderr: { ref: 'logs/command.stderr.log', hash: digest(stderr), bytes: 0, redacted: true },
  }],
}, null, 2)}\n`);

const injectedReceipt = evaluator.evaluateAcceptance({
  contract,
  subjectRef: result.ref,
  subject,
  runtimeEvidence: new Map([[criterion.id, {
    verdict: 'passed',
    ref: {
      kind: 'command-execution',
      ref: 'forged:runtime-map',
      digest: digest('forged runtime evidence'),
      assurance: 'verified',
    },
  }]]),
});
assert.strictEqual(injectedReceipt.overallStatus, 'unknown');
assert.deepStrictEqual(injectedReceipt.results[0].evidenceRefs, []);

const validationSeal = evaluator.sealValidationEvidence({
  workdir,
  runDir,
  contract,
  validation: JSON.parse(fs.readFileSync(path.join(runDir, 'integration-validation.json'), 'utf8')),
  workspaceSnapshot,
  controlStoreOptions,
});
const authoritySiblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-authority-'));
const authoritySiblingRunDir = path.join(authoritySiblingRoot, 'runs', 'run-authority');
const authoritySiblingControlRoot = path.join(authoritySiblingRoot, 'control');
fs.mkdirSync(path.join(authoritySiblingRunDir, 'logs'), { recursive: true });
fs.mkdirSync(authoritySiblingControlRoot, { recursive: true });
for (const name of ['command.stdout.log', 'command.stderr.log']) {
  fs.copyFileSync(path.join(runDir, 'logs', name), path.join(authoritySiblingRunDir, 'logs', name));
}
fs.writeFileSync(path.join(authoritySiblingRunDir, 'acceptance-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
const authorityControlStoreOptions = { providerRoot: workdir, controlRoot: authoritySiblingControlRoot };
const authorityValidationSeal = evaluator.sealValidationEvidence({
  workdir,
  runDir: authoritySiblingRunDir,
  contract,
  validation: JSON.parse(fs.readFileSync(path.join(runDir, 'integration-validation.json'), 'utf8')),
  workspaceSnapshot,
  controlStoreOptions: authorityControlStoreOptions,
});
const authorityShadow = evaluator.recordShadowAcceptance({
  workdir,
  runDir: authoritySiblingRunDir,
  relativeDir: '.',
  controlStoreOptions: authorityControlStoreOptions,
  validationSeal: authorityValidationSeal,
  subjectRef: subject.ref,
  subject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(authorityShadow.status, 'written', authorityShadow.error);
assert.strictEqual(authorityShadow.receipt.overallStatus, 'passed');
assert.throws(() => evaluator.sealValidationEvidence({
  workdir,
  runDir,
  contract,
  validation: JSON.parse(fs.readFileSync(path.join(runDir, 'integration-validation.json'), 'utf8')),
  workspaceSnapshot: { headSha: 'missing-digests' },
  controlStoreOptions,
}), /canonical workspace snapshot/);
const revisedContract = evaluator.createAcceptanceContractFromCriteria({
  sourceRequirement: { acceptanceCriteria: ['验证命令成功完成（修订）'] },
  sourceRef: 'spec.json#/requirementSpec/acceptanceCriteria',
  criteria: [{
    id: 'ac-validation-command',
    statement: '验证命令成功完成（修订）',
    sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
    oracle: { type: 'command', procedure: 'git diff --check', expected: 'exit code is zero' },
  }],
});
const revisedRunDir = path.join(workdir, '.agent-runs', 'run-revised');
fs.mkdirSync(revisedRunDir, { recursive: true });
fs.writeFileSync(
  path.join(revisedRunDir, 'acceptance-contract.json'),
  `${JSON.stringify(revisedContract, null, 2)}\n`
);
const staleSealResult = evaluator.recordShadowAcceptance({
  workdir,
  runDir: revisedRunDir,
  relativeDir: '.',
  controlStoreOptions,
  validationSeal,
  subjectRef: 'result:stale-contract',
  subject: { ...subject, ref: 'result:stale-contract' },
});
assert.strictEqual(staleSealResult.status, 'error');
assert.match(staleSealResult.error, /validation seal binding is invalid/);
const sealedSubject = { ...subject, ref: 'result:sealed-runtime-evidence' };
const sealedShadow = evaluator.recordShadowAcceptance({
  workdir,
  runDir,
  relativeDir: '.',
  controlStoreOptions,
  validationSeal,
  subjectRef: sealedSubject.ref,
  subject: sealedSubject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(sealedShadow.status, 'written');
assert.strictEqual(sealedShadow.receipt.overallStatus, 'passed');
assert.strictEqual(sealedShadow.receipt.results[0].evidenceRefs[0].assurance, 'verified');
const postgresEnvFile = path.join(controlRoot, 'acceptance-postgres.env');
fs.writeFileSync(postgresEnvFile, 'ACCEPTANCE_POSTGRES_SSL=false\n');
let postgresBrokerCall;
const postgresMirroredShadow = evaluator.recordShadowAcceptance({
  workdir,
  runDir,
  relativeDir: '.',
  controlStoreOptions: {
    ...controlStoreOptions,
    postgresEnvFile,
    spawnSyncImpl(command, args, options) {
      const record = JSON.parse(options.input);
      postgresBrokerCall = { command, args, options, record };
      return {
        status: 0,
        stdout: `${JSON.stringify({ verified: true, recordHash: record.recordHash })}\n`,
        stderr: '',
      };
    },
  },
  validationSeal,
  subjectRef: sealedSubject.ref,
  subject: sealedSubject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(postgresMirroredShadow.status, 'written');
assert.strictEqual(
  postgresMirroredShadow.authority.postgresRecordHash,
  postgresBrokerCall.record.recordHash
);
assert.strictEqual(postgresBrokerCall.record.recordKind, 'acceptance-receipt');
assert.strictEqual(postgresBrokerCall.record.payload.receiptHash, sealedShadow.receipt.receiptHash);
const replayedSeal = evaluator.recordShadowAcceptance({
  workdir,
  runDir,
  relativeDir: '.',
  controlStoreOptions,
  validationSeal,
  subjectRef: 'result:replayed-seal',
  subject: { ...subject, ref: 'result:replayed-seal' },
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(replayedSeal.status, 'error');
assert.match(replayedSeal.error, /already bound/);

const shadowWithWorkspaceValidation = evaluator.recordShadowAcceptance({
  workdir,
  runDir,
  relativeDir: '.',
  subjectRef: result.ref,
  subject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(shadowWithWorkspaceValidation.status, 'written');
assert.strictEqual(shadowWithWorkspaceValidation.receipt.overallStatus, 'unknown');
assert.strictEqual(shadowWithWorkspaceValidation.receipt.results[0].evidenceRefs[0].assurance, 'claimed');

const failedArtifact = JSON.parse(fs.readFileSync(path.join(runDir, 'integration-validation.json'), 'utf8'));
failedArtifact.status = 'failed';
failedArtifact.commands[0].status = 'failed';
failedArtifact.commands[0].exitStatus = 1;
fs.writeFileSync(
  path.join(runDir, 'integration-validation.json'),
  `${JSON.stringify(failedArtifact, null, 2)}\n`
);
const failedSeal = evaluator.sealValidationEvidence({
  workdir,
  runDir,
  contract,
  validation: failedArtifact,
  workspaceSnapshot,
  controlStoreOptions,
});
const failedSubject = { ...subject, ref: 'result:sealed-failed-evidence' };
const sealedFailure = evaluator.recordShadowAcceptance({
  workdir,
  runDir,
  relativeDir: '.',
  controlStoreOptions,
  validationSeal: failedSeal,
  subjectRef: failedSubject.ref,
  subject: failedSubject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(sealedFailure.status, 'written');
assert.strictEqual(sealedFailure.receipt.overallStatus, 'failed');
assert.strictEqual(sealedFailure.receipt.results[0].evidenceRefs[0].assurance, 'verified');
const claimedFailure = evaluator.recordShadowAcceptance({
  workdir,
  runDir,
  relativeDir: '.',
  contract,
  subjectRef: result.ref,
  subject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(claimedFailure.status, 'error');
assert.match(claimedFailure.error, /conflicts with existing receipt/);
const staleProjection = JSON.parse(fs.readFileSync(path.join(runDir, 'acceptance-shadow.json'), 'utf8'));
assert.strictEqual(staleProjection.status, 'error');

fs.writeFileSync(path.join(runDir, 'logs', 'command.stdout.log'), 'tampered\n');
const tamperedEvidence = evaluator.resolveRuntimeEvidence({
  workdir,
  runDir,
  relativeDir: '.',
  contract,
  subjectHash: result.hash,
});
assert.strictEqual(tamperedEvidence.get(criterion.id).verdict, 'unknown');

const authorityEvidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-authority-evidence-'));
const authorityControlRoot = path.join(authorityEvidenceRoot, 'control');
const authorityRunDir = path.join(authorityEvidenceRoot, 'runs', 'run-1');
fs.mkdirSync(authorityControlRoot, { recursive: true });
fs.mkdirSync(authorityRunDir, { recursive: true });
const authorityContract = evaluator.recordAcceptanceContract({
  kind: 'spec',
  workdir,
  runDir: authorityRunDir,
  controlStoreOptions: { providerRoot: workdir, controlRoot: authorityControlRoot },
  source: { requirementSpec: { acceptanceCriteria: ['authority evidence remains isolated'] } },
});
assert.strictEqual(authorityContract.status, 'written');
const unboundContract = evaluator.recordAcceptanceContract({
  kind: 'spec',
  workdir,
  runDir: path.join(authorityEvidenceRoot, 'unbound-run'),
  controlStoreOptions: { providerRoot: workdir, controlRoot: authorityControlRoot },
  source: { requirementSpec: { acceptanceCriteria: ['unbound evidence is rejected'] } },
});
assert.strictEqual(unboundContract.status, 'error');
fs.rmSync(authorityEvidenceRoot, { recursive: true, force: true });

const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-outside-'));
const linkedScope = path.join(runDir, 'linked-scope');
fs.symlinkSync(outsideRoot, linkedScope, process.platform === 'win32' ? 'junction' : 'dir');
const escapedShadow = evaluator.recordShadowAcceptance({
  workdir,
  runDir,
  relativeDir: 'linked-scope',
  subjectRef: result.ref,
  subject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(escapedShadow.status, 'error');
assert.match(escapedShadow.error, /symbolic link|outside run directory/);
assert.strictEqual(fs.existsSync(path.join(outsideRoot, 'acceptance-shadow.json')), false);

const linkedRun = path.join(workdir, 'linked-run');
fs.symlinkSync(outsideRoot, linkedRun, process.platform === 'win32' ? 'junction' : 'dir');
const escapedContract = evaluator.recordAcceptanceContract({
  kind: 'spec',
  workdir,
  runDir: linkedRun,
  source: {
    requirementSpec: { acceptanceCriteria: ['must stay contained'] },
  },
});
assert.strictEqual(escapedContract.status, 'error');
assert.strictEqual(fs.existsSync(path.join(outsideRoot, 'acceptance-contract.error.json')), false);

console.log('agent-orchestrator-acceptance-runtime: all assertions passed');
