'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');
const reportModule = require('./agent-orchestrator/acceptance-shadow-report');
const controlStore = require('./agent-orchestrator/control-store');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-cohort-tombstone-'));
const workspace = path.join(sandbox, 'workspace');
const runsDir = path.join(workspace, '.agent-runs');
const controlRoot = path.join(sandbox, 'control');
const broker = path.join(sandbox, 'cohort-broker.js');
fs.mkdirSync(runsDir, { recursive: true });
fs.writeFileSync(broker, `'use strict';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    schemaVersion: 'acceptance-cohort-tombstone-response-v1',
    runLocator: request.runLocator,
    contractHash: request.contractHash,
    expectedMarkerHash: request.expectedMarkerHash,
    reason: request.requestedReason,
    authorityRef: 'operator:lifecycle-control',
    eventRef: 'operator-event:abandoned-before-evaluation',
    controlEnvelopeDigest: 'sha256:${'7'.repeat(64)}'
  }));
});
`);

const controlOptions = {
  providerRoot: workspace,
  controlRoot,
  cohortTombstoneBrokerPath: broker,
};

function createExpectedRun(name) {
  const runDir = path.join(runsDir, name);
  fs.mkdirSync(runDir);
  const recorded = evaluator.recordAcceptanceContract({
    kind: 'spec',
    workdir: workspace,
    runDir,
    controlStoreOptions: controlOptions,
    source: {
      requirementSpec: {
        summary: 'cohort lifecycle',
        userValue: 'govern abandoned samples',
        scope: ['report'],
        acceptanceCriteria: ['receipt exists'],
      },
    },
  });
  assert.strictEqual(recorded.status, 'written');
  return { runDir, contract: recorded.contract };
}

const abandoned = createExpectedRun('run-abandoned');
const before = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert(before.errors.some((entry) => (
  entry.run === 'run-abandoned' && /Receipt is missing/.test(entry.error)
)));

const tombstoned = evaluator.recordAcceptanceCohortTombstone({
  workdir: workspace,
  runDir: abandoned.runDir,
  controlStoreOptions: controlOptions,
  reason: 'operator-abandoned',
});
assert.strictEqual(tombstoned.status, 'written');
assert.strictEqual(tombstoned.tombstone.reason, 'operator-abandoned');
assert.strictEqual(tombstoned.tombstone.contractHash, abandoned.contract.contractHash);

const replay = evaluator.recordAcceptanceCohortTombstone({
  workdir: workspace,
  runDir: abandoned.runDir,
  controlStoreOptions: controlOptions,
  reason: 'operator-abandoned',
});
assert.strictEqual(replay.status, 'written');
assert.strictEqual(replay.tombstone.tombstoneHash, tombstoned.tombstone.tombstoneHash);

const excluded = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert.strictEqual(excluded.excludedCount, 1);
assert.deepStrictEqual(excluded.exclusions, [{
  run: 'run-abandoned',
  reason: 'operator-abandoned',
  tombstoneHash: tombstoned.tombstone.tombstoneHash,
}]);
assert(!excluded.errors.some((entry) => entry.run === 'run-abandoned'));
assert.strictEqual(excluded.receiptCount, 0);
assert.strictEqual(excluded.sampleReady, false);

const receiptAfterTombstone = evaluator.recordShadowAcceptance({
  workdir: workspace,
  runDir: abandoned.runDir,
  relativeDir: '.',
  controlStoreOptions: controlOptions,
  subjectRef: 'result:late',
  subject: { ref: 'result:late', value: 'late' },
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(receiptAfterTombstone.status, 'error');
assert.match(receiptAfterTombstone.error, /cohort tombstone/);

const completed = createExpectedRun('run-completed');
const receipt = evaluator.recordShadowAcceptance({
  workdir: workspace,
  runDir: completed.runDir,
  relativeDir: '.',
  controlStoreOptions: controlOptions,
  subjectRef: 'result:complete',
  subject: { ref: 'result:complete', value: 'complete' },
  createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
});
assert.strictEqual(receipt.status, 'written');
const lateTombstone = evaluator.recordAcceptanceCohortTombstone({
  workdir: workspace,
  runDir: completed.runDir,
  controlStoreOptions: controlOptions,
  reason: 'operator-abandoned',
});
assert.strictEqual(lateTombstone.status, 'error');
assert.match(lateTombstone.error, /Receipt authority already exists/);

const healthyMixedCohort = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert.strictEqual(healthyMixedCohort.receiptCount, 1);
assert.strictEqual(healthyMixedCohort.excludedCount, 1);
assert.strictEqual(healthyMixedCohort.sampleReady, true);
assert.deepStrictEqual(healthyMixedCohort.errors, []);

const invalidReasonRun = createExpectedRun('run-invalid-reason');
const invalidReason = evaluator.recordAcceptanceCohortTombstone({
  workdir: workspace,
  runDir: invalidReasonRun.runDir,
  controlStoreOptions: controlOptions,
  reason: 'failed-after-evaluation',
});
assert.strictEqual(invalidReason.status, 'error');
assert.match(invalidReason.error, /reason is unsupported/);

const workspaceBroker = path.join(workspace, 'provider-controlled-broker.js');
fs.copyFileSync(broker, workspaceBroker);
const unsafeBrokerRun = createExpectedRun('run-unsafe-broker');
const unsafeBroker = evaluator.recordAcceptanceCohortTombstone({
  workdir: workspace,
  runDir: unsafeBrokerRun.runDir,
  controlStoreOptions: {
    ...controlOptions,
    cohortTombstoneBrokerPath: workspaceBroker,
  },
  reason: 'operator-abandoned',
});
assert.strictEqual(unsafeBroker.status, 'error');
assert.match(unsafeBroker.error, /outside the provider workspace/);

const tombstoneFile = path.join(
  controlStore.controlRunDir(abandoned.runDir, controlOptions),
  'acceptance-cohort-tombstone.json'
);
const tampered = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8'));
tampered.reason = 'superseded-before-evaluation';
fs.writeFileSync(tombstoneFile, `${JSON.stringify(tampered, null, 2)}\n`);
const tamperReport = reportModule.collectAcceptanceShadowReport(runsDir, controlOptions);
assert.strictEqual(tamperReport.excludedCount, 0);
assert(tamperReport.errors.some((entry) => (
  entry.run === 'run-abandoned' && /tombstone hash/.test(entry.error)
)));

console.log('agent-orchestrator-cohort-tombstone: all assertions passed');
