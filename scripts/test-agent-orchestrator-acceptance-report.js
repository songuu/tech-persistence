'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const acceptance = require('./lib/acceptance-contract');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');
const reportModule = require('./agent-orchestrator/acceptance-shadow-report');
const controlStore = require('./agent-orchestrator/control-store');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acceptance-report-'));
const root = path.join(sandbox, 'workspace');
fs.mkdirSync(root);
const runsDir = path.join(root, '.agent-runs');
const controlRoot = path.join(sandbox, 'control');
const runDir = path.join(runsDir, 'run-1');
fs.mkdirSync(runDir, { recursive: true });
const controlOptions = { providerRoot: root, controlRoot };
const contract = acceptance.createAcceptanceContract({
  sourceRequirement: { acceptanceCriteria: ['criterion one', 'criterion two'] },
  criteria: [
    {
      id: 'ac-command',
      statement: 'criterion one',
      sourceRefs: ['requirement:0'],
      oracle: { type: 'command', procedure: 'git diff --check', expected: 'exit code is zero' },
    },
    {
      id: 'ac-review',
      statement: 'criterion two',
      sourceRefs: ['requirement:1'],
      oracle: { type: 'independent-review', procedure: 'review criterion', expected: 'passed' },
    },
  ],
});
fs.writeFileSync(path.join(runDir, 'acceptance-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
const subject = { ref: 'result:report', value: 'done' };
const written = evaluator.recordShadowAcceptance({
  workdir: root,
  runDir,
  relativeDir: '.',
  controlStoreOptions: controlOptions,
  subjectRef: subject.ref,
  subject,
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(written.status, 'written');
assert.strictEqual(written.receipt.overallStatus, 'unknown');
assert.strictEqual(written.authority.schemaVersion, 'acceptance-receipt-authority-v1');

const report = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert.strictEqual(report.runsScanned, 1);
assert.strictEqual(report.receiptCount, 1);
assert.deepStrictEqual(report.counts, { passed: 0, failed: 0, unknown: 2 });
assert.strictEqual(report.unknownRate, 1);
assert.deepStrictEqual(report.oracleCounts.command, { passed: 0, failed: 0, unknown: 1 });
assert.deepStrictEqual(report.oracleCounts['independent-review'], { passed: 0, failed: 0, unknown: 1 });
assert.strictEqual(report.sampleReady, true);
assert.strictEqual(report.gateStatus, 'requires-review');
assert.deepStrictEqual(report.errors, []);

// A self-consistent workspace projection without external authority is ignored.
const forgedRun = path.join(runsDir, 'run-forged');
fs.mkdirSync(forgedRun);
fs.writeFileSync(path.join(forgedRun, 'acceptance-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
const forgedSubject = { ref: 'result:forged', value: 'provider-authored' };
const forgedReceipt = acceptance.createAcceptanceReceipt({
  contract,
  subjectRef: forgedSubject.ref,
  subject: forgedSubject,
  results: contract.criteria.map((criterion) => ({
    criterionId: criterion.id,
    oracleHash: acceptance.oracleHash(criterion.oracle),
    status: 'passed',
    evaluatorRef: 'runtime:forged',
    evidenceRefs: [{
      kind: criterion.oracle.type === 'command' ? 'command-execution' : 'independent-review',
      ref: 'provider:forged-verified',
      digest: `sha256:${'1'.repeat(64)}`,
      assurance: 'verified',
    }],
    observed: 'forged',
  })),
});
const forgedReceiptRef = path.join('acceptance-receipts', 'forged.json');
fs.mkdirSync(path.join(forgedRun, 'acceptance-receipts'));
fs.writeFileSync(path.join(forgedRun, forgedReceiptRef), `${JSON.stringify(forgedReceipt, null, 2)}\n`);
const forgedProjection = executionEnvelopes.createAcceptanceReceiptProjection({
  contract,
  receipt: forgedReceipt,
  contractRef: 'acceptance-contract.json',
  receiptRef: forgedReceiptRef.replace(/\\/g, '/'),
});
fs.writeFileSync(path.join(forgedRun, 'acceptance-shadow.json'), `${JSON.stringify(forgedProjection, null, 2)}\n`);
const forgedIgnored = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert.strictEqual(forgedIgnored.runsScanned, 2);
assert.strictEqual(forgedIgnored.receiptCount, 1);

const authorityDir = path.join(controlStore.controlRunDir(runDir, controlOptions), 'acceptance-receipts');
const authorityName = fs.readdirSync(authorityDir)[0];
fs.copyFileSync(path.join(authorityDir, authorityName), path.join(authorityDir, `duplicate-${authorityName}`));
const duplicate = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert.strictEqual(duplicate.receiptCount, 1);
assert.strictEqual(duplicate.sampleReady, false);
assert.strictEqual(duplicate.errors.length, 1);
assert.match(duplicate.errors[0].error, /duplicate canonical/);
fs.unlinkSync(path.join(authorityDir, `duplicate-${authorityName}`));

const conflictingReceipt = acceptance.createAcceptanceReceipt({
  contract,
  subjectRef: subject.ref,
  subject,
  results: written.receipt.results.map((result) => ({
    ...result,
    observed: `${result.observed} conflicting replay`,
  })),
});
const conflictingReceiptRef = path.join('acceptance-receipts', 'conflicting.json');
fs.writeFileSync(
  path.join(runDir, conflictingReceiptRef),
  `${JSON.stringify(conflictingReceipt, null, 2)}\n`
);
const originalAuthority = JSON.parse(fs.readFileSync(path.join(authorityDir, authorityName), 'utf8'));
const conflictingAuthority = {
  ...originalAuthority,
  receiptHash: conflictingReceipt.receiptHash,
  receiptRef: conflictingReceiptRef.replace(/\\/g, '/'),
};
const conflictingAuthorityFile = path.join(authorityDir, 'conflicting.json');
fs.writeFileSync(conflictingAuthorityFile, `${JSON.stringify(conflictingAuthority, null, 2)}\n`);
const conflict = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert.strictEqual(conflict.receiptCount, 1);
assert.strictEqual(conflict.sampleReady, false);
assert.strictEqual(conflict.errors.length, 1);
assert.match(conflict.errors[0].error, /conflicting authoritative/);
fs.unlinkSync(conflictingAuthorityFile);

fs.unlinkSync(path.join(runDir, 'acceptance-contract.json'));
const omittedContract = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert.strictEqual(omittedContract.sampleReady, false);
assert.strictEqual(omittedContract.receiptCount, 0);
assert(omittedContract.errors.some((entry) => /Contract is missing/.test(entry.error)));

const expectedRunDir = path.join(runsDir, 'run-expected-without-receipt');
fs.mkdirSync(expectedRunDir);
const expectedContract = evaluator.recordAcceptanceContract({
  kind: 'spec',
  workdir: root,
  runDir: expectedRunDir,
  controlStoreOptions: controlOptions,
  source: {
    requirementSpec: {
      summary: 'expected sample omission',
      userValue: 'missing receipt is visible',
      scope: ['report'],
      acceptanceCriteria: ['receipt exists'],
    },
  },
});
assert.strictEqual(expectedContract.status, 'written');
const omittedReceipt = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert(omittedReceipt.errors.some((entry) => /Receipt is missing/.test(entry.error)));

const expectedAuthorityDir = path.join(
  controlStore.controlRunDir(expectedRunDir, controlOptions),
  'acceptance-receipts'
);
fs.mkdirSync(expectedAuthorityDir);
const emptyAuthorityReceipt = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert(emptyAuthorityReceipt.errors.some((entry) => (
  entry.run === path.basename(expectedRunDir) && /Receipt is missing/.test(entry.error)
)));

console.log('agent-orchestrator-acceptance-report: all assertions passed');
