'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');
const reportModule = require('./agent-orchestrator/acceptance-shadow-report');
const controlStore = require('./agent-orchestrator/control-store');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');
const { stableHash } = require('./lib/self-learning-canonical');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-artifact-evidence-'));
const workdir = path.join(sandbox, 'workspace');
const runsDir = path.join(workdir, '.agent-runs');
const controlRoot = path.join(sandbox, 'control');
fs.mkdirSync(runsDir, { recursive: true });
const controlStoreOptions = { providerRoot: workdir, controlRoot };

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function freezeArtifactRun(name, artifactProcedure, beforeFreeze, expected = 'artifact exists, is fresh, and matches its sealed digest') {
  const runDir = path.join(runsDir, name);
  fs.mkdirSync(runDir, { recursive: true });
  if (beforeFreeze) beforeFreeze(runDir);
  const recorded = evaluator.recordAcceptanceContract({
    kind: 'spec',
    workdir,
    runDir,
    controlStoreOptions,
    source: {
      requirementSpec: {
        summary: name,
        userValue: 'artifact evidence is harness verified',
        scope: ['artifact-adapter'],
        acceptanceCriteria: ['artifact is fresh and readable'],
      },
      acceptanceContract: {
        criteria: [{
          id: 'ac-artifact',
          statement: 'artifact is fresh and readable',
          sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
          oracle: {
            type: 'artifact',
            procedure: artifactProcedure,
            expected,
          },
        }],
      },
    },
  });
  assert.strictEqual(recorded.status, 'written');
  return { runDir, contract: recorded.contract };
}

function recordArtifactReceipt(runDir, suffix, extra = {}) {
  const contract = JSON.parse(fs.readFileSync(path.join(runDir, 'acceptance-contract.json'), 'utf8'));
  const procedure = contract.criteria[0].oracle.procedure;
  const artifactRef = procedure.startsWith('artifact:')
    ? procedure.slice('artifact:'.length).replace(/\\/g, '/')
    : null;
  const changedFiles = Object.prototype.hasOwnProperty.call(extra, 'changedFiles')
    ? extra.changedFiles
    : (artifactRef ? [artifactRef] : []);
  const subjectEffectRefs = Object.prototype.hasOwnProperty.call(extra, 'subjectEffectRefs')
    ? extra.subjectEffectRefs
    : changedFiles;
  const {
    changedFiles: _changedFiles,
    subjectEffectRefs: _subjectEffectRefs,
    ...recordOptions
  } = extra;
  fs.writeFileSync(path.join(runDir, 'changed-files.json'), `${JSON.stringify(changedFiles)}\n`);
  const subject = {
    ref: `result:${suffix}`,
    value: suffix,
    evidence: {
      artifactEffectRefsHash: stableHash(subjectEffectRefs),
      artifactReviewStable: recordOptions.artifactReviewStable !== false,
    },
  };
  return evaluator.recordShadowAcceptance({
    workdir,
    runDir,
    relativeDir: '.',
    controlStoreOptions,
    subjectRef: subject.ref,
    subject,
    ...recordOptions,
    createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
  });
}

const fresh = freezeArtifactRun('fresh', 'artifact:outputs/result.txt');
fs.mkdirSync(path.join(workdir, 'outputs'));
fs.writeFileSync(path.join(workdir, 'outputs', 'result.txt'), 'fresh result\n');
const freshReceipt = recordArtifactReceipt(fresh.runDir, 'fresh');
assert.strictEqual(freshReceipt.status, 'written');
assert.strictEqual(freshReceipt.receipt.overallStatus, 'passed');
assert.strictEqual(freshReceipt.receipt.results[0].evidenceRefs[0].kind, 'artifact-readback');
assert.strictEqual(freshReceipt.receipt.results[0].evidenceRefs[0].assurance, 'verified');
const freshAuthorityDir = path.join(
  controlStore.controlRunDir(fresh.runDir, controlStoreOptions),
  'acceptance-receipts'
);
const freshAuthority = JSON.parse(fs.readFileSync(
  path.join(freshAuthorityDir, fs.readdirSync(freshAuthorityDir)[0]),
  'utf8'
));
assert.match(freshAuthority.artifactSealHash, /^sha256:[a-f0-9]{64}$/);
const freshRetry = recordArtifactReceipt(fresh.runDir, 'fresh');
assert.strictEqual(freshRetry.status, 'written');
assert.strictEqual(freshRetry.receipt.receiptHash, freshReceipt.receipt.receiptHash);

const missing = freezeArtifactRun('missing', 'artifact:outputs/missing.txt');
const missingReceipt = recordArtifactReceipt(missing.runDir, 'missing');
assert.strictEqual(missingReceipt.receipt.overallStatus, 'failed');

const stalePath = path.join(workdir, 'outputs', 'stale.txt');
fs.writeFileSync(stalePath, 'unchanged\n');
const stale = freezeArtifactRun('stale', 'artifact:outputs/stale.txt');
const staleReceipt = recordArtifactReceipt(stale.runDir, 'stale');
assert.strictEqual(staleReceipt.receipt.overallStatus, 'unknown');

const changedPath = path.join(workdir, 'outputs', 'changed.txt');
fs.writeFileSync(changedPath, 'before\n');
const changed = freezeArtifactRun('changed', 'artifact:outputs/changed.txt');
fs.writeFileSync(changedPath, 'after\n');
const changedReceipt = recordArtifactReceipt(changed.runDir, 'changed');
assert.strictEqual(changedReceipt.receipt.overallStatus, 'passed');

const unrelatedPath = path.join(workdir, 'outputs', 'unrelated.txt');
const unrelated = freezeArtifactRun('unrelated', 'artifact:outputs/unrelated.txt');
fs.writeFileSync(unrelatedPath, 'not part of the accepted subject effects\n');
assert.strictEqual(
  recordArtifactReceipt(unrelated.runDir, 'unrelated', { changedFiles: ['other.txt'] }).receipt.overallStatus,
  'unknown'
);

const forgedEffect = freezeArtifactRun('forged-effect', 'artifact:outputs/forged-effect.txt');
fs.writeFileSync(path.join(workdir, 'outputs', 'forged-effect.txt'), 'forged effect\n');
assert.strictEqual(recordArtifactReceipt(forgedEffect.runDir, 'forged-effect', {
  changedFiles: ['outputs/forged-effect.txt'],
  subjectEffectRefs: ['other.txt'],
}).receipt.overallStatus, 'unknown');

const reviewMutated = freezeArtifactRun('review-mutated', 'artifact:outputs/review-mutated.txt');
fs.writeFileSync(path.join(workdir, 'outputs', 'review-mutated.txt'), 'reviewer mutation\n');
assert.strictEqual(recordArtifactReceipt(reviewMutated.runDir, 'review-mutated', {
  artifactReviewStable: false,
}).receipt.overallStatus, 'unknown');

const oversized = freezeArtifactRun('oversized', 'artifact:outputs/oversized.bin');
fs.writeFileSync(path.join(workdir, 'outputs', 'oversized.bin'), Buffer.alloc((16 * 1024 * 1024) + 1));
assert.strictEqual(recordArtifactReceipt(oversized.runDir, 'oversized').receipt.overallStatus, 'unknown');

const boundary = freezeArtifactRun('boundary', 'artifact:outputs/boundary.bin');
fs.writeFileSync(path.join(workdir, 'outputs', 'boundary.bin'), Buffer.alloc(16 * 1024 * 1024));
assert.strictEqual(recordArtifactReceipt(boundary.runDir, 'boundary').receipt.overallStatus, 'passed');

const replaced = freezeArtifactRun('replaced', 'artifact:outputs/replaced.txt');
const replacedPath = path.join(workdir, 'outputs', 'replaced.txt');
fs.writeFileSync(replacedPath, 'original\n');
const originalFstatSync = fs.fstatSync;
let identityMismatchInjected = false;
fs.fstatSync = function patchedFstatSync(descriptor) {
  const stat = originalFstatSync.call(fs, descriptor);
  if (!identityMismatchInjected) {
    identityMismatchInjected = true;
    return { ...stat, size: stat.size + 1, isFile: () => true };
  }
  return stat;
};
try {
  assert.strictEqual(recordArtifactReceipt(replaced.runDir, 'replaced').receipt.overallStatus, 'unknown');
} finally {
  fs.fstatSync = originalFstatSync;
}

const growing = freezeArtifactRun('growing', 'artifact:outputs/growing.txt');
const growingPath = path.join(workdir, 'outputs', 'growing.txt');
fs.writeFileSync(growingPath, 'initial\n');
const originalReadSync = fs.readSync;
let grewOnce = false;
fs.readSync = function patchedReadSync(descriptor, buffer, offset, length, position) {
  const bytesRead = originalReadSync.call(fs, descriptor, buffer, offset, length, position);
  if (!grewOnce) {
    grewOnce = true;
    fs.appendFileSync(growingPath, 'growth\n');
  }
  return bytesRead;
};
try {
  assert.strictEqual(recordArtifactReceipt(growing.runDir, 'growing').receipt.overallStatus, 'unknown');
} finally {
  fs.readSync = originalReadSync;
}

const escaped = freezeArtifactRun('escaped', 'artifact:../outside.txt');
fs.writeFileSync(path.join(sandbox, 'outside.txt'), 'outside\n');
const escapedReceipt = recordArtifactReceipt(escaped.runDir, 'escaped');
assert.strictEqual(escapedReceipt.receipt.overallStatus, 'unknown');

const unsupportedExpected = freezeArtifactRun(
  'unsupported-expected',
  'artifact:outputs/arbitrary.txt',
  null,
  'artifact content satisfies a business-specific schema'
);
fs.writeFileSync(path.join(workdir, 'outputs', 'arbitrary.txt'), 'arbitrary\n');
assert.strictEqual(
  recordArtifactReceipt(unsupportedExpected.runDir, 'unsupported-expected').receipt.overallStatus,
  'unknown'
);

const selfReferential = freezeArtifactRun(
  'self-referential',
  'artifact:.agent-runs/self-referential/acceptance-shadow.json'
);
assert.strictEqual(
  recordArtifactReceipt(selfReferential.runDir, 'self-referential').receipt.overallStatus,
  'unknown'
);

const injectedSeal = recordArtifactReceipt(fresh.runDir, 'injected', { artifactSeal: {} });
assert.strictEqual(injectedSeal.status, 'error');
assert.match(injectedSeal.error, /runtime-owned/);

const outsideDir = path.join(sandbox, 'outside-dir');
fs.mkdirSync(outsideDir);
fs.writeFileSync(path.join(outsideDir, 'linked.txt'), 'linked\n');
const linkedDir = path.join(workdir, 'linked-output');
fs.symlinkSync(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
const linked = freezeArtifactRun('linked', 'artifact:linked-output/linked.txt');
const linkedReceipt = recordArtifactReceipt(linked.runDir, 'linked');
assert.strictEqual(linkedReceipt.receipt.overallStatus, 'unknown');

const mixedRunDir = path.join(runsDir, 'mixed');
fs.mkdirSync(path.join(mixedRunDir, 'logs'), { recursive: true });
const mixedRecorded = evaluator.recordAcceptanceContract({
  kind: 'spec',
  workdir,
  runDir: mixedRunDir,
  controlStoreOptions,
  source: {
    requirementSpec: {
      summary: 'mixed command and artifact evidence',
      userValue: 'both authorities are required',
      scope: ['artifact-adapter'],
      acceptanceCriteria: ['command passes', 'artifact is fresh'],
    },
    acceptanceContract: { criteria: [{
      id: 'ac-command', statement: 'command passes',
      sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
      oracle: { type: 'command', procedure: 'git diff --check', expected: 'exit code is zero' },
    }, {
      id: 'ac-artifact', statement: 'artifact is fresh',
      sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/1'],
      oracle: {
        type: 'artifact', procedure: 'artifact:outputs/mixed.txt',
        expected: 'artifact exists, is fresh, and matches its sealed digest',
      },
    }] },
  },
});
fs.writeFileSync(path.join(workdir, 'outputs', 'mixed.txt'), 'mixed artifact\n');
fs.writeFileSync(path.join(mixedRunDir, 'changed-files.json'), '["outputs/mixed.txt"]\n');
const stdout = 'clean\n';
const stderr = '';
fs.writeFileSync(path.join(mixedRunDir, 'logs', 'mixed.stdout.log'), stdout);
fs.writeFileSync(path.join(mixedRunDir, 'logs', 'mixed.stderr.log'), stderr);
const mixedValidation = {
  schemaVersion: 'integration-validation-v1', attemptId: 'mixed-attempt', status: 'passed',
  artifactRef: 'integration-validation.json', commands: [{
    index: 0, command: 'git diff --check', status: 'passed', exitStatus: 0,
    timedOut: false, error: null,
    stdout: { ref: 'logs/mixed.stdout.log', hash: digest(stdout), bytes: Buffer.byteLength(stdout), redacted: true },
    stderr: { ref: 'logs/mixed.stderr.log', hash: digest(stderr), bytes: 0, redacted: true },
  }],
};
fs.writeFileSync(
  path.join(mixedRunDir, 'integration-validation.json'),
  `${JSON.stringify(mixedValidation, null, 2)}\n`
);
const mixedSeal = evaluator.sealValidationEvidence({
  workdir, runDir: mixedRunDir, contract: mixedRecorded.contract,
  validation: mixedValidation,
  workspaceSnapshot: {
    headSha: 'sha256:mixed-head',
    changedFilesHash: digest('mixed-changed-files'),
    diffHash: digest('mixed-diff'),
  },
  controlStoreOptions,
});
const mixedSubject = {
  ref: 'result:mixed', value: 'mixed',
  evidence: {
    artifactEffectRefsHash: stableHash(['outputs/mixed.txt']),
    artifactReviewStable: true,
  },
};
const mixedReceipt = evaluator.recordShadowAcceptance({
  workdir, runDir: mixedRunDir, relativeDir: '.', controlStoreOptions,
  validationSeal: mixedSeal, subjectRef: mixedSubject.ref, subject: mixedSubject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(mixedReceipt.status, 'written');
assert.strictEqual(mixedReceipt.receipt.overallStatus, 'passed');
assert.deepStrictEqual(
  mixedReceipt.receipt.results.map((result) => result.evidenceRefs[0].kind).sort(),
  ['artifact-readback', 'command-execution']
);

const report = reportModule.collectAcceptanceShadowReport(runsDir, controlStoreOptions);
assert.strictEqual(report.sampleReady, true);
assert.deepStrictEqual(report.oracleCounts.artifact, { passed: 4, failed: 1, unknown: 11 });
assert.deepStrictEqual(report.oracleCounts.command, { passed: 1, failed: 0, unknown: 0 });

const sealFile = path.join(
  controlStore.controlRunDir(fresh.runDir, controlStoreOptions),
  'acceptance-artifact-seals',
  `${freshAuthority.artifactSealHash.slice('sha256:'.length)}.json`
);
const tamperedSeal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
const forgedSeal = JSON.parse(JSON.stringify(tamperedSeal));
forgedSeal.artifacts.push({ ...forgedSeal.artifacts[0] });
const forgedCore = { ...forgedSeal };
delete forgedCore.sealHash;
forgedSeal.sealHash = stableHash(forgedCore);
assert.throws(
  () => evaluator.resolveSealedArtifactEvidence(fresh.contract, forgedSeal, forgedSeal.subjectHash),
  /criterion coverage|entry/
);
tamperedSeal.subjectHash = `sha256:${'0'.repeat(64)}`;
fs.writeFileSync(sealFile, `${JSON.stringify(tamperedSeal, null, 2)}\n`);
const tamperedReport = reportModule.collectAcceptanceShadowReport(runsDir, controlStoreOptions);
assert.strictEqual(tamperedReport.sampleReady, false);
assert(tamperedReport.errors.some((entry) => /artifact seal binding is invalid/.test(entry.error)));

console.log('agent-orchestrator-artifact-evidence: all assertions passed');
