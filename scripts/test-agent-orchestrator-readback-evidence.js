'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');
const controlStore = require('./agent-orchestrator/control-store');
const reportModule = require('./agent-orchestrator/acceptance-shadow-report');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');

const HASH = `sha256:${'a'.repeat(64)}`;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-readback-evidence-'));
const workdir = path.join(sandbox, 'workspace');
const controlRoot = path.join(sandbox, 'control');
const runDir = path.join(workdir, '.agent-runs', 'readback');
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(controlRoot, { recursive: true });

function writeBroker(name, body) {
  const file = path.join(controlRoot, name);
  fs.writeFileSync(file, `'use strict';\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const request=JSON.parse(input);${body}});\n`);
  return file;
}

function recordWithBroker(broker, subjectValue) {
  const subject = { ref: `result:${subjectValue}`, value: subjectValue };
  return evaluator.recordShadowAcceptance({
    workdir,
    runDir,
    relativeDir: '.',
    controlStoreOptions: { providerRoot: workdir, controlRoot, readbackBrokerPath: broker },
    subjectRef: subject.ref,
    subject,
    createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
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
        summary: 'readback authority',
        userValue: 'independent runtime state is verified',
        scope: ['readback-adapter'],
        acceptanceCriteria: ['saved state matches expected state'],
      },
      acceptanceContract: { criteria: [{
        id: 'ac-readback',
        statement: 'saved state matches expected state',
        sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
        oracle: { type: 'readback', procedure: 'reload saved state', expected: 'saved value' },
      }] },
    },
  });
  assert.strictEqual(recorded.status, 'written');

  const passBroker = writeBroker('pass.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-readback-response-v1',runLocator:request.runLocator,binding:request.binding,readerRef:'service:reader',writerRef:'service:writer',matched:true,resultDigest:'" + HASH + "'}));");
  const passed = recordWithBroker(passBroker, 'passed');
  assert.strictEqual(passed.status, 'written');
  assert.strictEqual(passed.receipt.overallStatus, 'passed');
  assert.strictEqual(passed.receipt.results[0].evidenceRefs[0].kind, 'runtime-readback');
  assert.strictEqual(passed.receipt.results[0].evidenceRefs[0].assurance, 'verified');
  const receiptAuthorityDir = path.join(
    controlStore.controlRunDir(runDir, { providerRoot: workdir, controlRoot }),
    'acceptance-receipts'
  );
  const receiptAuthority = JSON.parse(fs.readFileSync(
    path.join(receiptAuthorityDir, fs.readdirSync(receiptAuthorityDir)[0]),
    'utf8'
  ));
  assert.match(receiptAuthority.readbackSealHash, /^sha256:[a-f0-9]{64}$/);

  const failBroker = writeBroker('fail.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-readback-response-v1',runLocator:request.runLocator,binding:request.binding,readerRef:'service:reader',writerRef:'service:writer',matched:false,resultDigest:'" + HASH + "'}));");
  const failed = recordWithBroker(failBroker, 'failed');
  assert.strictEqual(failed.receipt.overallStatus, 'failed');

  const forgedBroker = writeBroker('forged.js', "request.binding.subjectHash='" + HASH + "';process.stdout.write(JSON.stringify({schemaVersion:'acceptance-readback-response-v1',runLocator:request.runLocator,binding:request.binding,readerRef:'service:same',writerRef:'service:same',matched:true,resultDigest:'" + HASH + "'}));");
  const unknown = recordWithBroker(forgedBroker, 'unknown');
  assert.strictEqual(unknown.receipt.overallStatus, 'unknown');
  assert.deepStrictEqual(unknown.receipt.results[0].evidenceRefs, []);

  const wrongRunBroker = writeBroker('wrong-run.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-readback-response-v1',runLocator:'run:wrong',binding:request.binding,readerRef:'service:reader',writerRef:'service:writer',matched:true,resultDigest:'" + HASH + "'}));");
  const wrongRun = recordWithBroker(wrongRunBroker, 'wrong-run');
  assert.strictEqual(wrongRun.receipt.overallStatus, 'unknown');

  const insideBroker = path.join(workdir, 'provider-broker.js');
  fs.writeFileSync(insideBroker, fs.readFileSync(passBroker));
  const rejected = recordWithBroker(insideBroker, 'inside');
  assert.strictEqual(rejected.status, 'error');
  assert.match(rejected.error, /outside the provider workspace/i);

  const report = reportModule.collectAcceptanceShadowReport(path.dirname(runDir), {
    providerRoot: workdir,
    controlRoot,
  });
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(report.receiptCount, 4);
  assert.deepStrictEqual(report.oracleCounts.readback, { passed: 1, failed: 1, unknown: 2 });

  console.log('[OK] criterion readback broker binding, independent identity, verdict, and isolation');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
