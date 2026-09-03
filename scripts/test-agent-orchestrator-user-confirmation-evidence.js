'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');
const controlStore = require('./agent-orchestrator/control-store');
const reportModule = require('./agent-orchestrator/acceptance-shadow-report');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');
const { CODEX_CONTROL_PREFIX, parseCodexControlEnvelope } = require('./codex-behavior-hook');
const { canonicalStringify, stableHash } = require('./lib/self-learning-canonical');

const HASH = `sha256:${'c'.repeat(64)}`;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-user-confirmation-evidence-'));
const workdir = path.join(sandbox, 'workspace');
const controlRoot = path.join(sandbox, 'control');
const runDir = path.join(workdir, '.agent-runs', 'user-confirmation');
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
      userConfirmationBrokerPath: broker,
    },
    subjectRef: subject.ref,
    subject,
    createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
    ...extra,
  });
}

function recordWithoutBroker(subjectValue) {
  const subject = { ref: `result:${subjectValue}`, value: subjectValue };
  return evaluator.recordShadowAcceptance({
    workdir,
    runDir,
    relativeDir: '.',
    controlStoreOptions: { providerRoot: workdir, controlRoot },
    subjectRef: subject.ref,
    subject,
    createProjection: executionEnvelopes.createAcceptanceReceiptProjection,
  });
}

try {
  const semantic = {
    action: 'confirm-acceptance',
    contract_hash: HASH,
    criterion_id: 'ac-user-confirmation',
    decision: 'accepted',
    oracle_hash: HASH,
    subject_hash: HASH,
  };
  const parsed = parseCodexControlEnvelope(
    `${CODEX_CONTROL_PREFIX}${canonicalStringify(semantic)}`
  );
  assert.strictEqual(parsed.status, 'control');
  assert.strictEqual(parsed.event_type, 'user.approval');
  assert.strictEqual(parsed.final_disposition, 'accepted');
  assert.strictEqual(parseCodexControlEnvelope(
    `${CODEX_CONTROL_PREFIX}${JSON.stringify(semantic)} trailing`
  ).status, 'invalid');
  assert.strictEqual(parseCodexControlEnvelope('请确认验收通过').status, 'ordinary');

  const recorded = evaluator.recordAcceptanceContract({
    kind: 'spec',
    workdir,
    runDir,
    controlStoreOptions: { providerRoot: workdir, controlRoot },
    source: {
      requirementSpec: {
        summary: 'native user confirmation authority',
        userValue: 'only an explicit bound native control can authorize acceptance',
        scope: ['user-confirmation-adapter'],
        acceptanceCriteria: ['user explicitly confirms the bound result'],
      },
      acceptanceContract: { criteria: [{
        id: 'ac-user-confirmation',
        statement: 'user explicitly confirms the bound result',
        sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
        oracle: {
          type: 'user-confirmation',
          procedure: 'read a native canonical UserPromptSubmit control',
          expected: 'the control explicitly accepts the bound contract subject criterion',
        },
      }] },
    },
  });
  assert.strictEqual(recorded.status, 'written');

  const acceptedBroker = writeBroker('accepted.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-user-confirmation-response-v1',runLocator:request.runLocator,binding:request.binding,authorityRef:'codex_cli:UserPromptSubmit',eventRef:'behavior-event:user-confirmation',decision:'accepted',controlEnvelopeDigest:'" + HASH + "'}));");
  const accepted = recordWithBroker(acceptedBroker, 'accepted');
  assert.strictEqual(accepted.status, 'written');
  assert.strictEqual(accepted.receipt.overallStatus, 'passed');
  assert.strictEqual(accepted.receipt.results[0].evidenceRefs[0].kind, 'user-confirmation');
  assert.strictEqual(accepted.receipt.results[0].evidenceRefs[0].assurance, 'verified');

  const claudeAcceptedBroker = writeBroker('claude-accepted.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-user-confirmation-response-v1',runLocator:request.runLocator,binding:request.binding,authorityRef:'claude_hook:UserPromptSubmit',eventRef:'behavior-event:claude-user-confirmation',decision:'accepted',controlEnvelopeDigest:'" + HASH + "'}));");
  const claudeAccepted = recordWithBroker(claudeAcceptedBroker, 'claude-accepted');
  assert.strictEqual(claudeAccepted.receipt.overallStatus, 'passed');
  assert.strictEqual(
    claudeAccepted.receipt.results[0].evidenceRefs[0].kind,
    'user-confirmation'
  );

  const rejectedBroker = writeBroker('rejected.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-user-confirmation-response-v1',runLocator:request.runLocator,binding:request.binding,authorityRef:'codex_cli:UserPromptSubmit',eventRef:'behavior-event:user-confirmation-rejected',decision:'rejected',controlEnvelopeDigest:'" + HASH + "'}));");
  const rejected = recordWithBroker(rejectedBroker, 'rejected');
  assert.strictEqual(rejected.receipt.overallStatus, 'failed');

  const lateUnknown = recordWithoutBroker('late-confirmation');
  assert.strictEqual(lateUnknown.status, 'written');
  assert.strictEqual(lateUnknown.receipt.overallStatus, 'unknown');
  const lateAccepted = recordWithBroker(acceptedBroker, 'late-confirmation');
  assert.strictEqual(lateAccepted.status, 'written');
  assert.strictEqual(lateAccepted.receipt.overallStatus, 'passed');
  assert.strictEqual(lateAccepted.authority.evaluationSequence, 2);
  assert.strictEqual(
    lateAccepted.authority.predecessorReceiptHash,
    lateUnknown.receipt.receiptHash
  );
  const replayedLate = recordWithBroker(acceptedBroker, 'late-confirmation');
  assert.strictEqual(replayedLate.status, 'written');
  assert.strictEqual(replayedLate.receipt.receiptHash, lateAccepted.receipt.receiptHash);
  const lateConflict = recordWithBroker(rejectedBroker, 'late-confirmation');
  assert.strictEqual(lateConflict.status, 'error');
  assert.match(lateConflict.error, /terminal|successor|monotonic/i);

  const driftUnknown = recordWithoutBroker('late-claim-drift');
  assert.strictEqual(driftUnknown.receipt.overallStatus, 'unknown');
  const driftSubject = { ref: 'result:late-claim-drift', value: 'late-claim-drift' };
  fs.writeFileSync(path.join(runDir, 'acceptance-assessments.json'), `${JSON.stringify([{
    criterionId: 'ac-user-confirmation',
    observed: 'provider changed its claim after the immutable genesis Receipt',
    evidence: [{
      kind: 'user-confirmation',
      ref: 'provider:late-claim',
      binding: {
        contractHash: recorded.contract.contractHash,
        subjectHash: stableHash(driftSubject),
        criterionId: 'ac-user-confirmation',
        oracleHash: driftUnknown.receipt.results[0].oracleHash,
      },
      payload: {
        authority: 'provider:self-report',
        explicit: true,
        decision: 'accepted',
        controlEnvelopeDigest: HASH,
      },
    }],
  }], null, 2)}\n`);
  const driftedSuccessor = recordWithBroker(acceptedBroker, 'late-claim-drift');
  assert.strictEqual(driftedSuccessor.status, 'error');
  assert.match(driftedSuccessor.error, /monotonic user confirmation/i);
  fs.unlinkSync(path.join(runDir, 'acceptance-assessments.json'));

  const wrongAuthorityBroker = writeBroker('wrong-authority.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-user-confirmation-response-v1',runLocator:request.runLocator,binding:request.binding,authorityRef:'provider:self-report',eventRef:'forged',decision:'accepted',controlEnvelopeDigest:'" + HASH + "'}));");
  assert.strictEqual(recordWithBroker(wrongAuthorityBroker, 'wrong-authority').receipt.overallStatus, 'unknown');

  const wrongRunBroker = writeBroker('wrong-run.js', "process.stdout.write(JSON.stringify({schemaVersion:'acceptance-user-confirmation-response-v1',runLocator:'run:wrong',binding:request.binding,authorityRef:'codex_cli:UserPromptSubmit',eventRef:'forged',decision:'accepted',controlEnvelopeDigest:'" + HASH + "'}));");
  assert.strictEqual(recordWithBroker(wrongRunBroker, 'wrong-run').receipt.overallStatus, 'unknown');

  const forgedBroker = writeBroker('forged.js', "request.binding.subjectHash='" + HASH + "';process.stdout.write(JSON.stringify({schemaVersion:'acceptance-user-confirmation-response-v1',runLocator:request.runLocator,binding:request.binding,authorityRef:'codex_cli:UserPromptSubmit',eventRef:'forged',decision:'accepted',controlEnvelopeDigest:'" + HASH + "'}));");
  assert.strictEqual(recordWithBroker(forgedBroker, 'forged').receipt.overallStatus, 'unknown');

  const injected = recordWithBroker(acceptedBroker, 'injected', { userConfirmationSeal: {} });
  assert.strictEqual(injected.status, 'error');
  assert.match(injected.error, /runtime-owned/i);

  const insideBroker = path.join(workdir, 'provider-confirmation-broker.js');
  fs.writeFileSync(insideBroker, fs.readFileSync(acceptedBroker));
  const inside = recordWithBroker(insideBroker, 'inside');
  assert.strictEqual(inside.status, 'error');
  assert.match(inside.error, /outside the provider workspace/i);

  const report = reportModule.collectAcceptanceShadowReport(path.dirname(runDir), {
    providerRoot: workdir,
    controlRoot,
  });
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(report.receiptCount, 8);
  assert.deepStrictEqual(report.oracleCounts['user-confirmation'], {
    passed: 3,
    failed: 1,
    unknown: 4,
  });

  const controlDir = controlStore.controlRunDir(runDir, { providerRoot: workdir, controlRoot });
  const authorityDir = path.join(controlDir, 'acceptance-receipts');
  const authorityRecords = fs.readdirSync(authorityDir)
    .map((name) => ({
      name,
      authority: JSON.parse(fs.readFileSync(path.join(authorityDir, name), 'utf8')),
    }));
  const lateChain = authorityRecords.filter(
    ({ authority }) => authority.subjectRef === 'result:late-confirmation'
  ).sort((left, right) => left.authority.evaluationSequence - right.authority.evaluationSequence);
  assert.strictEqual(lateChain.length, 2);
  assert.strictEqual(lateChain[0].authority.predecessorReceiptHash, null);
  assert.strictEqual(
    lateChain[1].authority.predecessorReceiptHash,
    lateChain[0].authority.receiptHash
  );
  const successorAuthorityFile = path.join(authorityDir, lateChain[1].name);
  const successorAuthorityBytes = fs.readFileSync(successorAuthorityFile, 'utf8');
  const brokenChain = JSON.parse(successorAuthorityBytes);
  brokenChain.predecessorReceiptHash = HASH;
  fs.writeFileSync(successorAuthorityFile, `${JSON.stringify(brokenChain)}\n`);
  const brokenChainReport = reportModule.collectAcceptanceShadowReport(path.dirname(runDir), {
    providerRoot: workdir,
    controlRoot,
  });
  assert(brokenChainReport.errors.some((entry) => /successor chain/i.test(entry.error)));
  fs.writeFileSync(successorAuthorityFile, successorAuthorityBytes);

  const acceptedAuthority = authorityRecords
    .map(({ authority }) => authority)
    .find((authority) => authority.subjectRef === 'result:accepted');
  const sealFile = path.join(
    controlDir,
    'acceptance-user-confirmation-seals',
    `${acceptedAuthority.userConfirmationSealHash.slice('sha256:'.length)}.json`
  );
  const tampered = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
  tampered.entries[0].decision = 'rejected';
  fs.writeFileSync(sealFile, `${JSON.stringify(tampered)}\n`);
  const tamperedReport = reportModule.collectAcceptanceShadowReport(path.dirname(runDir), {
    providerRoot: workdir,
    controlRoot,
  });
  assert(tamperedReport.errors.some((entry) => /user confirmation seal binding/i.test(entry.error)));

  console.log('[OK] native user confirmation control, broker binding, seal, and report authority');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
