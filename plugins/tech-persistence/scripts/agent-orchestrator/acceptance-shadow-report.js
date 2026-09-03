'use strict';

const fs = require('fs');
const path = require('path');
const acceptance = require('../lib/acceptance-contract');
const { stableHash } = require('../lib/self-learning-canonical');
const controlStore = require('./control-store');
const acceptanceEvaluator = require('./acceptance-evaluator');

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function resolveSafe(root, relativePath) {
  const target = path.resolve(root, relativePath);
  if (!inside(root, target)) throw new Error(`path escapes run root: ${relativePath}`);
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`path contains symbolic link: ${cursor}`);
    }
  }
  return target;
}

function emptyCounts() {
  return { passed: 0, failed: 0, unknown: 0 };
}

function authoritySequence(authority) {
  const sequence = authority.evaluationSequence === undefined ? 1 : authority.evaluationSequence;
  const predecessor = authority.predecessorReceiptHash === undefined
    ? null
    : authority.predecessorReceiptHash;
  if (!Number.isSafeInteger(sequence) || sequence < 1
      || (sequence === 1) !== (predecessor === null)
      || (predecessor !== null && !/^sha256:[a-f0-9]{64}$/.test(predecessor))) {
    throw new Error('acceptance Receipt authority predecessor/sequence binding is invalid');
  }
  return { sequence, predecessor };
}

function assertReportSuccessor(contract, previous, next) {
  if (previous.results.length !== next.results.length) {
    throw new Error('acceptance Receipt successor coverage is invalid');
  }
  let changed = 0;
  for (let index = 0; index < previous.results.length; index += 1) {
    const before = previous.results[index];
    const after = next.results[index];
    const criterion = contract.criteria[index];
    if (before.criterionId !== after.criterionId || before.oracleHash !== after.oracleHash) {
      throw new Error('acceptance Receipt successor criterion binding is invalid');
    }
    if (stableHash(before) === stableHash(after)) continue;
    changed += 1;
    const beforeClaims = before.evidenceRefs.filter((ref) => ref.assurance === 'claimed');
    const afterClaims = after.evidenceRefs.filter((ref) => ref.assurance === 'claimed');
    const afterVerified = after.evidenceRefs.filter((ref) => ref.assurance === 'verified');
    if (criterion.oracle.type !== 'user-confirmation'
        || before.status !== 'unknown'
        || !['passed', 'failed'].includes(after.status)
        || before.evaluatorRef !== after.evaluatorRef
        || stableHash(beforeClaims) !== stableHash(afterClaims)
        || afterVerified.length !== 1
        || afterVerified[0].kind !== 'user-confirmation') {
      throw new Error('acceptance Receipt successor is not monotonic');
    }
  }
  if (changed === 0) throw new Error('acceptance Receipt successor makes no semantic progress');
}

function selectAuthorityChainHeads(runDir, authorityFiles, controlOptions, contract) {
  const groups = new Map();
  const noncanonical = [];
  for (const authorityFile of authorityFiles) {
    controlStore.assertAuthoritativeControlPath(runDir, authorityFile, controlOptions);
    const authority = controlStore.readAuthoritativeJson(runDir, authorityFile, controlOptions);
    if (!authority || authority.schemaVersion !== 'acceptance-receipt-authority-v1'
        || typeof authority.receiptRef !== 'string'
        || authority.contractHash !== contract.contractHash
        || typeof authority.subjectHash !== 'string') {
      throw new Error('invalid authoritative acceptance Receipt record');
    }
    const receiptFile = resolveSafe(runDir, authority.receiptRef);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    acceptance.assertAcceptanceReceipt(receipt, { contract });
    if (authority.receiptHash !== receipt.receiptHash
        || authority.subjectRef !== receipt.subjectRef
        || authority.subjectHash !== receipt.subjectHash) {
      throw new Error('authority record does not match canonical Contract/Receipt');
    }
    const sequence = authoritySequence(authority);
    const identity = `${authority.contractHash}:${authority.subjectHash}`;
    const expectedName = `${authority.receiptHash.slice('sha256:'.length)}.json`;
    if (path.basename(authorityFile) !== expectedName) {
      noncanonical.push({ identity, authority });
      continue;
    }
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push({ authorityFile, authority, receipt, ...sequence });
  }
  const heads = [];
  for (const chain of groups.values()) {
    chain.sort((left, right) => left.sequence - right.sequence);
    chain.forEach((entry, index) => {
      if (entry.sequence !== index + 1
          || (index === 0 && entry.predecessor !== null)
          || (index > 0 && entry.predecessor !== chain[index - 1].authority.receiptHash)) {
        throw new Error('acceptance Receipt authority successor chain is invalid');
      }
      if (index > 0) assertReportSuccessor(contract, chain[index - 1].receipt, entry.receipt);
    });
    heads.push(chain[chain.length - 1].authorityFile);
  }
  const anomalies = noncanonical.map((entry) => {
    const canonical = groups.get(entry.identity) || [];
    const duplicate = canonical.some((candidate) => (
      candidate.authority.receiptHash === entry.authority.receiptHash
    ));
    return duplicate
      ? 'duplicate canonical acceptance Receipt authority'
      : 'conflicting authoritative acceptance Receipts for one contract subject';
  });
  return { heads: heads.sort(), anomalies };
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function discoverAuthorityRuns(runsDir, controlOptions, errors) {
  const discovered = new Map();
  const root = controlStore.resolveControlRoot(controlOptions);
  const controlRunsDir = path.join(root, 'runs');
  if (!fs.existsSync(controlRunsDir)) return discovered;
  for (const entry of fs.readdirSync(controlRunsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const controlDir = path.join(controlRunsDir, entry.name);
    const authorityDir = path.join(controlDir, 'acceptance-receipts');
    const markerFile = path.join(controlDir, 'acceptance-expected-sample.json');
    const markerDirectory = path.join(controlDir, 'acceptance-expected-samples');
    const tombstoneFile = path.join(controlDir, 'acceptance-cohort-tombstone.json');
    if (!fs.existsSync(authorityDir) && !fs.existsSync(markerFile) && !fs.existsSync(markerDirectory)
        && !fs.existsSync(tombstoneFile)) continue;
    try {
      const binding = JSON.parse(fs.readFileSync(
        path.join(controlDir, controlStore.CONTROL_BINDING_FILE),
        'utf8'
      ));
      if (!binding || typeof binding.runLocator !== 'string') {
        throw new Error('authority control binding lacks runLocator');
      }
      const runDir = path.resolve(binding.runLocator);
      if (!inside(runsDir, runDir)) continue;
      const verifiedBinding = controlStore.readControlRunBinding(runDir, controlOptions);
      if (verifiedBinding.controlKey !== entry.name) {
        throw new Error('authority control directory does not match validated run binding');
      }
      controlStore.assertAuthoritativeControlPath(runDir, authorityDir, controlOptions);
      let expectedMarker = null;
      if (fs.existsSync(markerFile)) {
        expectedMarker = controlStore.readAuthoritativeJson(runDir, markerFile, controlOptions);
        if (!expectedMarker
            || expectedMarker.schemaVersion !== 'acceptance-expected-sample-v1'
            || expectedMarker.runLocator !== controlStore.stableRunLocator(runDir)
            || typeof expectedMarker.contractHash !== 'string') {
          throw new Error('invalid authoritative acceptance expected-sample marker');
        }
      }
      discovered.set(pathKey(runDir), {
        runDir,
        name: path.basename(runDir),
        authorityDir,
        controlDir,
        expectedByAuthority: true,
        expectedMarker,
        tombstoneFile,
      });
    } catch (error) {
      errors.push({ authorityControl: entry.name, error: error.message });
    }
  }
  return discovered;
}

function collectAcceptanceShadowReport(runsDirValue, options = {}) {
  const runsDir = path.resolve(runsDirValue);
  const controlOptions = {
    providerRoot: path.resolve(options.providerRoot || path.dirname(runsDir)),
    ...(options.controlRoot ? { controlRoot: path.resolve(options.controlRoot) } : {}),
  };
  const report = {
    schemaVersion: 'acceptance-shadow-report-v1',
    runsDir,
    runsScanned: 0,
    receiptCount: 0,
    excludedCount: 0,
    exclusions: [],
    runs: [],
    counts: emptyCounts(),
    oracleCounts: {},
    unknownRate: null,
    sampleReady: false,
    gateStatus: 'insufficient-data',
    errors: [],
  };
  const candidates = discoverAuthorityRuns(runsDir, controlOptions, report.errors);
  if (fs.existsSync(runsDir)) {
    for (const runEntry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) continue;
      const runDir = path.join(runsDir, runEntry.name);
      const key = pathKey(runDir);
      if (!candidates.has(key)) {
        candidates.set(key, {
          runDir,
          name: runEntry.name,
          authorityDir: null,
          expectedByAuthority: false,
        });
      }
    }
  }
  const seenReceipts = new Map();
  for (const candidate of candidates.values()) {
    const { runDir } = candidate;
    report.runsScanned += 1;
    if (!fs.existsSync(runDir)) {
      report.errors.push({ run: candidate.name, error: 'authority-bound run directory is missing' });
      continue;
    }
    let contract;
    try {
      const contractFile = resolveSafe(runDir, 'acceptance-contract.json');
      if (!fs.existsSync(contractFile)) {
        if (candidate.expectedByAuthority) {
          throw new Error('authority-bound acceptance Contract is missing');
        }
        continue;
      }
      contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
      acceptance.assertAcceptanceContract(contract);
      const keyedMarkerFile = acceptanceEvaluator.expectedSampleMarkerFile(
        candidate.controlDir || controlStore.controlRunDir(runDir, controlOptions),
        contract.contractHash
      );
      if (fs.existsSync(keyedMarkerFile)) {
        candidate.expectedMarker = controlStore.readAuthoritativeJson(runDir, keyedMarkerFile, controlOptions);
      }
      if (candidate.expectedMarker && candidate.expectedMarker.contractHash !== contract.contractHash) {
        throw new Error('authority expected-sample marker does not match acceptance Contract');
      }
    } catch (error) {
      report.errors.push({ run: candidate.name, error: error.message });
      continue;
    }
    const criteria = new Map(contract.criteria.map((criterion) => [criterion.id, criterion]));
    let authorityDir = candidate.authorityDir;
    try {
      if (!authorityDir) {
        authorityDir = path.join(
          controlStore.controlRunDir(runDir, controlOptions),
          'acceptance-receipts'
        );
      }
      controlStore.assertAuthoritativeControlPath(runDir, authorityDir, controlOptions);
    } catch (error) {
      report.errors.push({ run: candidate.name, error: error.message });
      continue;
    }
    const tombstoneFile = candidate.tombstoneFile || path.join(
      path.dirname(authorityDir),
      'acceptance-cohort-tombstone.json'
    );
    if (fs.existsSync(tombstoneFile)) {
      try {
        if (!candidate.expectedMarker) {
          throw new Error('acceptance cohort tombstone lacks expected-sample authority');
        }
        const tombstone = acceptanceEvaluator.assertAcceptanceCohortTombstone(
          controlStore.readAuthoritativeJson(runDir, tombstoneFile, controlOptions),
          {
            runLocator: controlStore.stableRunLocator(runDir),
            contractHash: contract.contractHash,
            expectedMarkerHash: stableHash(candidate.expectedMarker),
          }
        );
        const receiptFiles = fs.existsSync(authorityDir)
          ? fs.readdirSync(authorityDir, { withFileTypes: true }).filter((entry) => (
            entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json')
          ))
          : [];
        if (receiptFiles.length > 0) {
          throw new Error('acceptance cohort tombstone conflicts with Receipt authority');
        }
        report.excludedCount += 1;
        report.exclusions.push({
          run: candidate.name,
          reason: tombstone.reason,
          tombstoneHash: tombstone.tombstoneHash,
        });
        continue;
      } catch (error) {
        report.errors.push({ run: candidate.name, error: error.message });
        continue;
      }
    }
    if (!fs.existsSync(authorityDir)) {
      if (candidate.expectedMarker) {
        report.errors.push({ run: candidate.name, error: 'authority-expected acceptance Receipt is missing' });
      }
      continue;
    }
    const authorityFiles = fs.readdirSync(authorityDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .map((entry) => path.join(authorityDir, entry.name))
      .sort();
    if (candidate.expectedMarker && authorityFiles.length === 0) {
      report.errors.push({
        run: candidate.name,
        error: 'authority-expected acceptance Receipt is missing',
      });
      continue;
    }
    let authorityHeadFiles;
    try {
      const selection = selectAuthorityChainHeads(
        runDir,
        authorityFiles,
        controlOptions,
        contract
      );
      authorityHeadFiles = selection.heads;
      selection.anomalies.forEach((error) => {
        report.errors.push({ run: candidate.name, error });
      });
    } catch (error) {
      report.errors.push({ run: candidate.name, error: error.message });
      continue;
    }
    const verifiedRunReceipts = [];
    for (const authorityFile of authorityHeadFiles) {
      try {
        controlStore.assertAuthoritativeControlPath(runDir, authorityFile, controlOptions);
        const authority = controlStore.readAuthoritativeJson(
          runDir,
          authorityFile,
          controlOptions
        );
        if (!authority || authority.schemaVersion !== 'acceptance-receipt-authority-v1'
            || typeof authority.receiptRef !== 'string') {
          throw new Error('invalid authoritative acceptance Receipt record');
        }
        const receiptFile = resolveSafe(runDir, authority.receiptRef);
        const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        acceptance.assertAcceptanceReceipt(receipt, { contract });
        if (authority.contractHash !== contract.contractHash
            || authority.receiptHash !== receipt.receiptHash
            || authority.subjectRef !== receipt.subjectRef
            || authority.subjectHash !== receipt.subjectHash) {
          throw new Error('authority record does not match canonical Contract/Receipt');
        }
        const verifiedRefs = receipt.results.flatMap((result) => result.evidenceRefs)
          .filter((ref) => ref.assurance === 'verified');
        const verifiedCommandRefs = verifiedRefs.filter((ref) => ref.kind === 'command-execution');
        const verifiedArtifactRefs = verifiedRefs.filter((ref) => ref.kind === 'artifact-readback');
        const verifiedReadbackRefs = verifiedRefs.filter((ref) => ref.kind === 'runtime-readback');
        const verifiedIndependentReviewRefs = verifiedRefs.filter(
          (ref) => ref.kind === 'independent-review'
        );
        const verifiedUserConfirmationRefs = verifiedRefs.filter(
          (ref) => ref.kind === 'user-confirmation'
        );
        if (verifiedRefs.length !== verifiedCommandRefs.length + verifiedArtifactRefs.length
            + verifiedReadbackRefs.length + verifiedIndependentReviewRefs.length
            + verifiedUserConfirmationRefs.length) {
          throw new Error('verified Receipt contains an unsupported authority evidence kind');
        }
        if (verifiedCommandRefs.length > 0) {
          if (typeof authority.validationSealHash !== 'string') {
            throw new Error('verified Receipt lacks an authoritative validation seal');
          }
          const sealFile = path.join(
            path.dirname(authorityDir),
            'acceptance-validation-seals',
            `${authority.validationSealHash.slice('sha256:'.length)}.json`
          );
          controlStore.assertAuthoritativeControlPath(runDir, sealFile, controlOptions);
          const seal = controlStore.readAuthoritativeJson(runDir, sealFile, controlOptions);
          const { sealHash, ...sealCore } = seal;
          if (sealHash !== authority.validationSealHash
              || stableHash(sealCore) !== sealHash
              || seal.contractHash !== contract.contractHash
              || verifiedCommandRefs.some((ref) => !ref.ref.includes(sealHash))) {
            throw new Error('verified Receipt validation seal binding is invalid');
          }
          const bindingFile = path.join(
            path.dirname(authorityDir),
            'acceptance-validation-bindings',
            `${sealHash.slice('sha256:'.length)}.json`
          );
          controlStore.assertAuthoritativeControlPath(runDir, bindingFile, controlOptions);
          const binding = controlStore.readAuthoritativeJson(runDir, bindingFile, controlOptions);
          if (binding.schemaVersion !== 'acceptance-validation-binding-v1'
              || binding.validationSealHash !== sealHash
              || binding.contractHash !== contract.contractHash
              || binding.subjectRef !== receipt.subjectRef
              || binding.subjectHash !== receipt.subjectHash) {
            throw new Error('verified Receipt subject binding is invalid');
          }
        }
        if (verifiedArtifactRefs.length > 0) {
          if (typeof authority.artifactSealHash !== 'string') {
            throw new Error('verified Receipt lacks an authoritative artifact seal');
          }
          const artifactSealFile = path.join(
            path.dirname(authorityDir),
            'acceptance-artifact-seals',
            `${authority.artifactSealHash.slice('sha256:'.length)}.json`
          );
          const artifactSeal = controlStore.readAuthoritativeJson(
            runDir,
            artifactSealFile,
            controlOptions
          );
          const { sealHash: artifactSealHash, ...artifactSealCore } = artifactSeal || {};
          if (artifactSealHash !== authority.artifactSealHash
              || stableHash(artifactSealCore) !== artifactSealHash
              || artifactSeal.schemaVersion !== 'acceptance-artifact-seal-v1'
              || artifactSeal.contractHash !== contract.contractHash
              || artifactSeal.subjectHash !== receipt.subjectHash
              || !Array.isArray(artifactSeal.artifacts)) {
            throw new Error('verified Receipt artifact seal binding is invalid');
          }
          const resolvedArtifactEvidence = acceptanceEvaluator.resolveSealedArtifactEvidence(
            contract,
            artifactSeal,
            receipt.subjectHash
          );
          const artifactEntries = new Map(
            artifactSeal.artifacts.map((entry) => [entry.criterionId, entry])
          );
          const artifactResults = receipt.results.filter((result) => (
            result.evidenceRefs.some((ref) => (
              ref.assurance === 'verified' && ref.kind === 'artifact-readback'
            ))
          ));
          for (const result of artifactResults) {
            const criterion = criteria.get(result.criterionId);
            const entry = artifactEntries.get(result.criterionId);
            const ref = result.evidenceRefs.find((candidateRef) => (
              candidateRef.assurance === 'verified' && candidateRef.kind === 'artifact-readback'
            ));
            const resolved = resolvedArtifactEvidence.get(result.criterionId);
            if (!criterion || criterion.oracle.type !== 'artifact' || !entry
                || entry.oracleHash !== acceptance.oracleHash(criterion.oracle)
                || entry.verdict !== result.status
                || !resolved || resolved.verdict !== result.status
                || ref.ref !== `authority:acceptance-artifact-seal/${artifactSealHash}#artifacts/${entry.index}`
                || ref.ref !== resolved.ref.ref || ref.digest !== resolved.ref.digest
                || ref.digest !== stableHash({
                  sealHash: artifactSealHash,
                  contractHash: contract.contractHash,
                  subjectHash: receipt.subjectHash,
                  criterionId: criterion.id,
                  oracleHash: acceptance.oracleHash(criterion.oracle),
                  artifact: entry,
                })) {
              throw new Error('verified Receipt artifact evidence binding is invalid');
            }
          }
        }
        if (verifiedReadbackRefs.length > 0) {
          if (typeof authority.readbackSealHash !== 'string') {
            throw new Error('verified Receipt lacks an authoritative readback seal');
          }
          const readbackSealFile = path.join(
            path.dirname(authorityDir),
            'acceptance-readback-seals',
            `${authority.readbackSealHash.slice('sha256:'.length)}.json`
          );
          const readbackSeal = controlStore.readAuthoritativeJson(
            runDir,
            readbackSealFile,
            controlOptions
          );
          const resolvedReadbackEvidence = acceptanceEvaluator.resolveSealedReadbackEvidence(
            contract,
            readbackSeal,
            receipt.subjectHash
          );
          const entries = new Map(readbackSeal.entries.map((entry) => [entry.criterionId, entry]));
          const readbackResults = receipt.results.filter((result) => result.evidenceRefs.some(
            (ref) => ref.assurance === 'verified' && ref.kind === 'runtime-readback'
          ));
          for (const result of readbackResults) {
            const criterion = criteria.get(result.criterionId);
            const entry = entries.get(result.criterionId);
            const ref = result.evidenceRefs.find(
              (candidateRef) => candidateRef.assurance === 'verified'
                && candidateRef.kind === 'runtime-readback'
            );
            const resolved = resolvedReadbackEvidence.get(result.criterionId);
            if (!criterion || criterion.oracle.type !== 'readback' || !entry || !resolved
                || entry.verdict !== result.status || resolved.verdict !== result.status
                || !resolved.ref || ref.ref !== resolved.ref.ref || ref.digest !== resolved.ref.digest) {
              throw new Error('verified Receipt readback evidence binding is invalid');
            }
          }
        }
        if (verifiedIndependentReviewRefs.length > 0) {
          if (typeof authority.independentReviewSealHash !== 'string') {
            throw new Error('verified Receipt lacks an authoritative independent review seal');
          }
          const independentReviewSealFile = path.join(
            path.dirname(authorityDir),
            'acceptance-independent-review-seals',
            `${authority.independentReviewSealHash.slice('sha256:'.length)}.json`
          );
          const independentReviewSeal = controlStore.readAuthoritativeJson(
            runDir,
            independentReviewSealFile,
            controlOptions
          );
          const resolvedIndependentReviewEvidence = acceptanceEvaluator
            .resolveSealedIndependentReviewEvidence(
              contract,
              independentReviewSeal,
              receipt.subjectHash
            );
          const entries = new Map(
            independentReviewSeal.entries.map((entry) => [entry.criterionId, entry])
          );
          const independentReviewResults = receipt.results.filter((result) => (
            result.evidenceRefs.some((ref) => (
              ref.assurance === 'verified' && ref.kind === 'independent-review'
            ))
          ));
          for (const result of independentReviewResults) {
            const criterion = criteria.get(result.criterionId);
            const entry = entries.get(result.criterionId);
            const ref = result.evidenceRefs.find((candidateRef) => (
              candidateRef.assurance === 'verified'
                && candidateRef.kind === 'independent-review'
            ));
            const resolved = resolvedIndependentReviewEvidence.get(result.criterionId);
            if (!criterion || criterion.oracle.type !== 'independent-review' || !entry
                || !resolved || entry.verdict !== result.status
                || resolved.verdict !== result.status || !resolved.ref
                || ref.ref !== resolved.ref.ref || ref.digest !== resolved.ref.digest) {
              throw new Error('verified Receipt independent review evidence binding is invalid');
            }
          }
        }
        if (verifiedUserConfirmationRefs.length > 0) {
          if (typeof authority.userConfirmationSealHash !== 'string') {
            throw new Error('verified Receipt lacks an authoritative user confirmation seal');
          }
          const userConfirmationSealFile = path.join(
            path.dirname(authorityDir),
            'acceptance-user-confirmation-seals',
            `${authority.userConfirmationSealHash.slice('sha256:'.length)}.json`
          );
          const userConfirmationSeal = controlStore.readAuthoritativeJson(
            runDir,
            userConfirmationSealFile,
            controlOptions
          );
          const resolvedUserConfirmationEvidence = acceptanceEvaluator
            .resolveSealedUserConfirmationEvidence(
              contract,
              userConfirmationSeal,
              receipt.subjectHash
            );
          const entries = new Map(
            userConfirmationSeal.entries.map((entry) => [entry.criterionId, entry])
          );
          const userConfirmationResults = receipt.results.filter((result) => (
            result.evidenceRefs.some((ref) => (
              ref.assurance === 'verified' && ref.kind === 'user-confirmation'
            ))
          ));
          for (const result of userConfirmationResults) {
            const criterion = criteria.get(result.criterionId);
            const entry = entries.get(result.criterionId);
            const ref = result.evidenceRefs.find((candidateRef) => (
              candidateRef.assurance === 'verified'
                && candidateRef.kind === 'user-confirmation'
            ));
            const resolved = resolvedUserConfirmationEvidence.get(result.criterionId);
            if (!criterion || criterion.oracle.type !== 'user-confirmation' || !entry
                || !resolved || entry.verdict !== result.status
                || resolved.verdict !== result.status || !resolved.ref
                || ref.ref !== resolved.ref.ref || ref.digest !== resolved.ref.digest) {
              throw new Error('verified Receipt user confirmation evidence binding is invalid');
            }
          }
        }
        const receiptIdentity = `${contract.contractHash}:${receipt.subjectHash}`;
        if (seenReceipts.has(receiptIdentity)) {
          const existingHash = seenReceipts.get(receiptIdentity);
          if (existingHash !== receipt.receiptHash) {
            throw new Error('conflicting authoritative acceptance Receipts for one contract subject');
          }
          throw new Error('duplicate canonical acceptance Receipt authority');
        }
        seenReceipts.set(receiptIdentity, receipt.receiptHash);
        verifiedRunReceipts.push({
          contractHash: receipt.contractHash,
          subjectRef: receipt.subjectRef,
          subjectHash: receipt.subjectHash,
          receiptHash: receipt.receiptHash,
          overallStatus: receipt.overallStatus,
          resultStatuses: receipt.results.map((result) => ({
            criterionId: result.criterionId,
            status: result.status,
          })),
          productionRecordHash: authority.postgresRecordHash || null,
        });
        report.receiptCount += 1;
        for (const result of receipt.results) {
          report.counts[result.status] += 1;
          const oracleType = criteria.get(result.criterionId).oracle.type;
          if (!report.oracleCounts[oracleType]) report.oracleCounts[oracleType] = emptyCounts();
          report.oracleCounts[oracleType][result.status] += 1;
        }
      } catch (error) {
        report.errors.push({
          run: candidate.name,
          authority: path.basename(authorityFile),
          error: error.message,
        });
      }
    }
    report.runs.push({
      run: candidate.name,
      runLocator: controlStore.stableRunLocator(runDir),
      contractHash: contract.contractHash,
      receipts: verifiedRunReceipts,
    });
  }
  const total = report.counts.passed + report.counts.failed + report.counts.unknown;
  report.unknownRate = total > 0 ? report.counts.unknown / total : null;
  report.sampleReady = report.receiptCount > 0 && report.errors.length === 0;
  report.gateStatus = report.sampleReady ? 'requires-review' : 'insufficient-data';
  return report;
}

function main(argv) {
  const index = argv.indexOf('--runs-dir');
  const runsDir = index >= 0 && argv[index + 1]
    ? argv[index + 1]
    : path.resolve(process.cwd(), '.agent-runs');
  const controlIndex = argv.indexOf('--control-root');
  const controlRoot = controlIndex >= 0 && argv[controlIndex + 1]
    ? argv[controlIndex + 1]
    : undefined;
  process.stdout.write(`${JSON.stringify(collectAcceptanceShadowReport(runsDir, {
    providerRoot: path.dirname(path.resolve(runsDir)),
    controlRoot,
  }), null, 2)}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { collectAcceptanceShadowReport };
