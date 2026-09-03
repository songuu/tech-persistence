'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');
const controlStore = require('./agent-orchestrator/control-store');
const reportModule = require('./agent-orchestrator/acceptance-shadow-report');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');

const HASH = `sha256:${'b'.repeat(64)}`;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-independent-review-evidence-'));
const workdir = path.join(sandbox, 'workspace');
const controlRoot = path.join(sandbox, 'control');
const runDir = path.join(workdir, '.agent-runs', 'independent-review');
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(controlRoot, { recursive: true });

function writeBroker(name, body) {
  const file = path.join(controlRoot, name);
  fs.writeFileSync(file, `'use strict';\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const request=JSON.parse(input);${body}});\n`);
  return file;
}

function recordWithBroker(broker, subjectValue, extra = {}) {
  const subject = { ref: `result:${subjectValue}`, value: subjectValue };
  return evaluator.recordShadowAcceptance({
    workdir,
    runDir,
    relativeDir: '.',
    controlStoreOptions: {
      providerRoot: workdir,
      controlRoot,
      independentReviewBrokerPath: broker,
    },
    subjectRef: subject.ref,
    subject,
    createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
    ...extra,
  });
}

try {
  const recorded = evaluator.recordAcceptanceContract({
    kind: 'spec',
    workdir,
    runDir,
    controlStoreOptions: { providerRoot: workdir, controlRoot },
    source: {
      requirementSpec: {
        summary: 'independent review authority',
        userValue: 'criterion decisions come from an independent reviewer',
        scope: ['independent-review-adapter'],
        acceptanceCriteria: ['criterion one reviewed', 'criterion two reviewed'],
      },
      acceptanceContract: { criteria: [
        {
          id: 'ac-review-one',
          statement: 'criterion one reviewed',
          sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
          oracle: {
            type: 'independent-review',
            procedure: 'review criterion one',
            expected: 'independent reviewer passes criterion one',
          },
        },
        {
          id: 'ac-review-two',
          statement: 'criterion two reviewed',
          sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/1'],
          oracle: {
            type: 'independent-review',
            procedure: 'review criterion two',
            expected: 'independent reviewer passes criterion two',
          },
        },
      ] },
    },
  });
  assert.strictEqual(recorded.status, 'written');

  const passBroker = writeBroker('pass.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-independent-review-response-v1',runLocator:request.runLocator,binding:request.binding,reviewerRef:'reviewer:external',writerRef:'writer:implementation',criterionDecision:'passed',resultDigest:'" + HASH + "'}));");
  const passed = recordWithBroker(passBroker, 'passed');
  assert.strictEqual(passed.status, 'written');
  assert.strictEqual(passed.receipt.overallStatus, 'passed');
  assert.strictEqual(passed.receipt.results.length, 2);
  assert(passed.receipt.results.every((result) => (
    result.evidenceRefs.length === 1
      && result.evidenceRefs[0].kind === 'independent-review'
      && result.evidenceRefs[0].assurance === 'verified'
  )));

  const mixedBroker = writeBroker('mixed.js', "const decision=request.binding.criterionId==='ac-review-two'?'failed':'passed';process.stdout.write(JSON.stringify({schemaVersion:'acceptance-independent-review-response-v1',runLocator:request.runLocator,binding:request.binding,reviewerRef:'reviewer:external',writerRef:'writer:implementation',criterionDecision:decision,resultDigest:'" + HASH + "'}));");
  const mixed = recordWithBroker(mixedBroker, 'mixed');
  assert.strictEqual(mixed.receipt.overallStatus, 'failed');
  assert.deepStrictEqual(mixed.receipt.results.map((result) => result.status), ['passed', 'failed']);

  const sameIdentityBroker = writeBroker('same-identity.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-independent-review-response-v1',runLocator:request.runLocator,binding:request.binding,reviewerRef:'actor:same',writerRef:'actor:same',criterionDecision:'passed',resultDigest:'" + HASH + "'}));");
  const sameIdentity = recordWithBroker(sameIdentityBroker, 'same-identity');
  assert.strictEqual(sameIdentity.receipt.overallStatus, 'unknown');
  assert(sameIdentity.receipt.results.every((result) => result.evidenceRefs.length === 0));

  const forgedBroker = writeBroker('forged.js', "request.binding.contractHash='" + HASH + "';process.stdout.write(JSON.stringify({schemaVersion:'acceptance-independent-review-response-v1',runLocator:request.runLocator,binding:request.binding,reviewerRef:'reviewer:external',writerRef:'writer:implementation',criterionDecision:'passed',resultDigest:'" + HASH + "'}));");
  const forged = recordWithBroker(forgedBroker, 'forged');
  assert.strictEqual(forged.receipt.overallStatus, 'unknown');

  const wrongRunBroker = writeBroker('wrong-run.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-independent-review-response-v1',runLocator:'run:wrong',binding:request.binding,reviewerRef:'reviewer:external',writerRef:'writer:implementation',criterionDecision:'passed',resultDigest:'" + HASH + "'}));");
  const wrongRun = recordWithBroker(wrongRunBroker, 'wrong-run');
  assert.strictEqual(wrongRun.receipt.overallStatus, 'unknown');

  const injected = recordWithBroker(passBroker, 'injected', { independentReviewSeal: {} });
  assert.strictEqual(injected.status, 'error');
  assert.match(injected.error, /runtime-owned/i);

  const insideBroker = path.join(workdir, 'provider-review-broker.js');
  fs.writeFileSync(insideBroker, fs.readFileSync(passBroker));
  const rejected = recordWithBroker(insideBroker, 'inside');
  assert.strictEqual(rejected.status, 'error');
  assert.match(rejected.error, /outside the provider workspace/i);

  const report = reportModule.collectAcceptanceShadowReport(path.dirname(runDir), {
    providerRoot: workdir,
    controlRoot,
  });
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(report.receiptCount, 5);
  assert.deepStrictEqual(report.oracleCounts['independent-review'], {
    passed: 3,
    failed: 1,
    unknown: 6,
  });

  const controlDir = controlStore.controlRunDir(runDir, { providerRoot: workdir, controlRoot });
  const sealDir = path.join(controlDir, 'acceptance-independent-review-seals');
  const authorityDir = path.join(controlDir, 'acceptance-receipts');
  const passAuthority = fs.readdirSync(authorityDir)
    .map((name) => JSON.parse(fs.readFileSync(path.join(authorityDir, name), 'utf8')))
    .find((authority) => authority.subjectRef === 'result:passed');
  const sealFile = path.join(
    sealDir,
    `${passAuthority.independentReviewSealHash.slice('sha256:'.length)}.json`
  );
  const tampered = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
  tampered.entries[0].criterionDecision = 'failed';
  fs.writeFileSync(sealFile, `${JSON.stringify(tampered)}\n`);
  const tamperedReport = reportModule.collectAcceptanceShadowReport(path.dirname(runDir), {
    providerRoot: workdir,
    controlRoot,
  });
  assert(tamperedReport.errors.some((entry) => /independent review seal binding/i.test(entry.error)));

  console.log('[OK] independent review broker coverage, identity, binding, seal, and report authority');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
