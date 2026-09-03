'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pipeline = require('./agent-orchestrator/pipeline');
const state = require('./agent-orchestrator/pipeline-state');
const slicePlanner = require('./agent-orchestrator/slice-planner');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-contract-revision-'));
const runDir = path.join(root, '.runs', 'revision');
const authorityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-contract-authority-'));
const controlRoot = path.join(authorityRoot, '.control');
fs.mkdirSync(runDir, { recursive: true });
const slice = (id, criterionIds, dependsOn = []) => ({ id, title: id, dependsOn, ownedFiles: [], readFiles: [],
  criterionIds, risk: 'L2', acceptanceCriteria: [], doneCriteria: [], validationCommands: [], questions: [] });
slicePlanner.writeSliceArtifacts(runDir, slice('slice-a', ['ac-a']));
slicePlanner.writeSliceArtifacts(runDir, slice('slice-b', ['ac-b'], ['slice-a']));
slicePlanner.writeSliceArtifacts(runDir, slice('slice-c', ['ac-c']));
assert.deepEqual(pipeline.criterionImpact(runDir, { integrationCriterionIds: [] }, ['ac-a']), ['slice-a', 'slice-b']);
assert.throws(() => pipeline.criterionImpact(runDir, { integrationCriterionIds: [] }, ['ac-missing']), /full run replan/);

const baseState = { pipeline: { sliceStates: { 'slice-a': state.SLICE_STATES.COMPLETED } } };
assert.equal(state.reopenCompletedSlice(baseState, 'slice-a', 'revision-1').pipeline.sliceStates['slice-a'], state.SLICE_STATES.PENDING);

function globalContract(statement) {
  return { goal: 'revision test', globalAcceptance: [statement], acceptanceContract: { criteria: [{
    id: 'ac-a', statement, sourceRefs: ['global-contract.json#/globalAcceptance/0'],
    oracle: { type: 'independent-review', procedure: 'review', expected: 'passed' },
  }] } };
}
const options = { providerRoot: root, controlRoot };
const first = evaluator.recordAcceptanceContract({ kind: 'global-contract', workdir: root, runDir,
  source: globalContract('first'), controlStoreOptions: options });
assert.equal(first.status, 'written', first.error);
const second = evaluator.recordAcceptanceContract({ kind: 'global-contract', workdir: root, runDir,
  source: globalContract('second'), allowRevision: true, controlStoreOptions: options });
assert.equal(second.status, 'written', second.error);
assert.notEqual(first.contract.contractHash, second.contract.contractHash);
assert.ok(fs.existsSync(path.join(runDir, 'acceptance-contract-history', `${first.contract.contractHash.slice(7)}.json`)));
// Both immutable keyed markers are discoverable under the authority run, regardless of opaque control key.
const markers = [];
for (const entry of fs.readdirSync(path.join(controlRoot, 'runs'))) {
  const directory = path.join(controlRoot, 'runs', entry, 'acceptance-expected-samples');
  if (fs.existsSync(directory)) markers.push(...fs.readdirSync(directory));
}
assert.equal(markers.length, 2);
process.stdout.write('contract revision: passed\n');
