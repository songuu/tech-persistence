'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const acceptance = require('../lib/acceptance-contract');
const validationPolicy = require('./validation-command-policy');
const controlStore = require('./control-store');
const { appendPostgresAuthorityRecordSync } = require('../lib/acceptance-postgres-authority-client');
const {
  assertExactKeys,
  canonicalize,
  stableHash,
  validateHash,
} = require('../lib/self-learning-canonical');
const { redactSensitiveText } = require('../lib/redaction');
const { minimalAuthorityBrokerEnvironment } = require('../lib/private-runtime-env');

const EVALUATOR_REF = 'runtime:agent-loop';
const INTERNAL_RUNTIME_EVIDENCE = Symbol('internal-runtime-evidence');
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_AUTHORITY_BROKER_RESPONSE_BYTES = 1024 * 1024;
const USER_CONFIRMATION_AUTHORITY_REFS = new Set([
  'codex_cli:UserPromptSubmit',
  'claude_hook:UserPromptSubmit',
]);
const ARTIFACT_EXPECTED = 'artifact exists, is fresh, and matches its sealed digest';
const ORACLE_EVIDENCE_KIND = Object.freeze({
  command: 'command-execution',
  artifact: 'artifact-readback',
  readback: 'runtime-readback',
  'independent-review': 'independent-review',
  'user-confirmation': 'user-confirmation',
});

function hashText(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function hashBuffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function canonicalExistingFileOutsideProviderRoot(fileValue, providerRoot, label) {
  const file = path.resolve(requiredString(fileValue, label));
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (_error) {
    throw new Error(`${label} is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  const canonical = fs.realpathSync.native(file);
  if (providerRoot) {
    const root = fs.realpathSync.native(path.resolve(providerRoot));
    const relative = path.relative(root, canonical);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative))) {
      throw new Error(`${label} must be outside the provider workspace`);
    }
  }
  return canonical;
}

function artifactRefFromOracle(oracle) {
  if (!oracle || oracle.type !== 'artifact' || typeof oracle.procedure !== 'string') return null;
  if (oracle.expected !== ARTIFACT_EXPECTED) return null;
  if (!oracle.procedure.startsWith('artifact:')) return null;
  const normalized = oracle.procedure.slice('artifact:'.length).trim().replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (/^[A-Za-z]:/.test(normalized)) return null;
  return normalized;
}

function resolveArtifactPath(workdir, runDir, artifactRef) {
  const root = fs.realpathSync.native(path.resolve(workdir));
  const target = path.resolve(root, ...artifactRef.split('/'));
  if (!pathInside(root, target)) throw new Error('artifact path escaped workdir');
  const canonicalRunDir = fs.realpathSync.native(path.resolve(runDir));
  if (target === canonicalRunDir || pathInside(canonicalRunDir, target)) {
    throw new Error('artifact path overlaps harness run state');
  }
  let cursor = root;
  for (const segment of artifactRef.split('/')) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('artifact path contains a symbolic link');
    if (!pathInside(root, fs.realpathSync.native(cursor))) {
      throw new Error('artifact path resolves outside workdir');
    }
  }
  return { root, target };
}

function snapshotArtifact(workdir, runDir, artifactRef) {
  let resolved;
  try {
    resolved = resolveArtifactPath(workdir, runDir, artifactRef);
  } catch (_error) {
    return { status: 'unsafe' };
  }
  if (!fs.existsSync(resolved.target)) return { status: 'missing' };
  let descriptor;
  try {
    const pathStat = fs.lstatSync(resolved.target);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { status: 'unsafe' };
    if (pathStat.size > MAX_ARTIFACT_BYTES) return { status: 'unavailable' };
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(resolved.target, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_ARTIFACT_BYTES
        || pathStat.dev !== before.dev || pathStat.ino !== before.ino
        || pathStat.size !== before.size || pathStat.mtimeMs !== before.mtimeMs) {
      return { status: 'unavailable' };
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    const finalPathStat = fs.lstatSync(resolved.target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || offset !== after.size
        || finalPathStat.isSymbolicLink() || finalPathStat.dev !== after.dev
        || finalPathStat.ino !== after.ino) {
      return { status: 'unavailable' };
    }
    if (!pathInside(resolved.root, fs.realpathSync.native(resolved.target))) {
      return { status: 'unsafe' };
    }
    return {
      status: 'present',
      contentDigest: hashBuffer(content),
      bytes: content.length,
    };
  } catch (_error) {
    return { status: 'unavailable' };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (redactSensitiveText(normalized) !== normalized) {
    throw new Error(`${label} contains sensitive content`);
  }
  return normalized;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function integer(value, label) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function hashArray(value, label, options = {}) {
  if (!Array.isArray(value) || value.length < (options.minItems || 0)) {
    throw new Error(`${label} must be an array with at least ${options.minItems || 0} item(s)`);
  }
  return value.map((entry, index) => validateHash(entry, `${label}[${index}]`));
}

function assertAllowedKeys(value, required, optional, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(`${label}.${field} is required`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  const extras = Object.keys(value).filter((field) => !allowed.has(field));
  if (extras.length > 0) throw new Error(`${label} has unsupported field(s): ${extras.join(', ')}`);
}

function validateBinding(binding, criterion, contractHash, subjectHash, label) {
  assertExactKeys(
    binding,
    ['contractHash', 'subjectHash', 'criterionId', 'oracleHash'],
    label
  );
  const expectedOracleHash = acceptance.oracleHash(criterion.oracle);
  const valid = binding.contractHash === contractHash
    && binding.subjectHash === subjectHash
    && binding.criterionId === criterion.id
    && binding.oracleHash === expectedOracleHash;
  return {
    valid,
    canonical: {
      contractHash: validateHash(binding.contractHash, `${label}.contractHash`),
      subjectHash: validateHash(binding.subjectHash, `${label}.subjectHash`),
      criterionId: requiredString(binding.criterionId, `${label}.criterionId`),
      oracleHash: validateHash(binding.oracleHash, `${label}.oracleHash`),
    },
  };
}

function commandVerdict(payload) {
  if (!isPlainObject(payload)) throw new Error('command evidence payload must be an object');
  const policyAllowed = boolean(payload.policyAllowed, 'command evidence policyAllowed');
  const skipped = boolean(payload.skipped, 'command evidence skipped');
  const exitCode = integer(payload.exitCode, 'command evidence exitCode');
  validateHash(payload.commandHash, 'command evidence commandHash');
  hashArray(payload.logDigests, 'command evidence logDigests', { minItems: 1 });
  if (!policyAllowed || skipped) return 'unknown';
  return exitCode === 0 ? 'passed' : 'failed';
}

function artifactVerdict(payload) {
  if (!isPlainObject(payload)) throw new Error('artifact evidence payload must be an object');
  const withinRoot = boolean(payload.withinRoot, 'artifact evidence withinRoot');
  const exists = boolean(payload.exists, 'artifact evidence exists');
  const fresh = boolean(payload.fresh, 'artifact evidence fresh');
  const subjectBound = boolean(payload.subjectBound, 'artifact evidence subjectBound');
  if (!withinRoot || !fresh || !subjectBound) return 'unknown';
  if (!exists) return 'failed';
  validateHash(payload.contentDigest, 'artifact evidence contentDigest');
  return 'passed';
}

function readbackVerdict(payload) {
  if (!isPlainObject(payload)) throw new Error('readback evidence payload must be an object');
  const independent = boolean(payload.independent, 'readback evidence independent');
  const readerRef = requiredString(payload.readerRef, 'readback evidence readerRef');
  const writerRef = requiredString(payload.writerRef, 'readback evidence writerRef');
  const matched = boolean(payload.matched, 'readback evidence matched');
  validateHash(payload.resultDigest, 'readback evidence resultDigest');
  if (!independent || readerRef === writerRef) return 'unknown';
  return matched ? 'passed' : 'failed';
}

function independentReviewVerdict(payload) {
  if (!isPlainObject(payload)) throw new Error('independent review payload must be an object');
  const reviewerRef = requiredString(payload.reviewerRef, 'independent review reviewerRef');
  const writerRef = requiredString(payload.writerRef, 'independent review writerRef');
  const perCriterion = boolean(payload.perCriterion, 'independent review perCriterion');
  const decision = requiredString(payload.criterionDecision, 'independent review criterionDecision');
  if (!['passed', 'failed', 'unknown'].includes(decision)) {
    throw new Error('independent review criterionDecision is unsupported');
  }
  if (reviewerRef === writerRef || !perCriterion) return 'unknown';
  return decision;
}

function userConfirmationVerdict(payload) {
  if (!isPlainObject(payload)) throw new Error('user confirmation payload must be an object');
  requiredString(payload.authority, 'user confirmation authority');
  boolean(payload.explicit, 'user confirmation explicit');
  requiredString(payload.decision, 'user confirmation decision');
  validateHash(payload.controlEnvelopeDigest, 'user confirmation controlEnvelopeDigest');
  // P1-6 owns native authority verification. Until then, JSON supplied by a
  // provider is intentionally never upgraded beyond claimed evidence.
  return 'unknown';
}

function evidenceVerdict(oracleType, payload) {
  if (oracleType === 'command') return commandVerdict(payload);
  if (oracleType === 'artifact') return artifactVerdict(payload);
  if (oracleType === 'readback') return readbackVerdict(payload);
  if (oracleType === 'independent-review') return independentReviewVerdict(payload);
  if (oracleType === 'user-confirmation') return userConfirmationVerdict(payload);
  throw new Error(`unsupported Oracle type: ${oracleType}`);
}

function normalizeEvidenceCandidate(candidate, criterion, contractHash, subjectHash, label) {
  assertExactKeys(candidate, ['kind', 'ref', 'binding', 'payload'], label);
  const kind = requiredString(candidate.kind, `${label}.kind`);
  if (!acceptance.EVIDENCE_KINDS.has(kind)) throw new Error(`${label}.kind is unsupported: ${kind}`);
  const ref = requiredString(candidate.ref, `${label}.ref`);
  const binding = validateBinding(
    candidate.binding,
    criterion,
    contractHash,
    subjectHash,
    `${label}.binding`
  );
  const payload = canonicalize(candidate.payload, new Set(), `${label}.payload`);
  // acceptance-assessments.json is provider/reviewer writable. Validate its
  // shape and binding for auditability, but never upgrade a claim to verified.
  // Only resolveRuntimeEvidence() may produce a verified verdict.
  if (binding.valid && kind === ORACLE_EVIDENCE_KIND[criterion.oracle.type]) {
    evidenceVerdict(criterion.oracle.type, payload);
  }
  const verdict = 'unknown';
  return {
    verdict,
    ref: {
      kind,
      ref,
      digest: stableHash({ binding: binding.canonical, payload }),
      assurance: verdict === 'unknown' ? 'claimed' : 'verified',
    },
  };
}

function normalizeAssessments(assessments, contract) {
  if (!Array.isArray(assessments)) throw new Error('assessments must be an array');
  const criteria = new Map(contract.criteria.map((criterion) => [criterion.id, criterion]));
  const normalized = new Map();
  for (let index = 0; index < assessments.length; index += 1) {
    const assessment = assessments[index];
    const label = `assessments[${index}]`;
    assertAllowedKeys(assessment, ['criterionId', 'observed', 'evidence'], ['claimedStatus'], label);
    const criterionId = requiredString(assessment.criterionId, `${label}.criterionId`);
    if (normalized.has(criterionId)) throw new Error(`duplicate assessment ${criterionId}`);
    if (!criteria.has(criterionId)) throw new Error(`unknown assessment ${criterionId}`);
    if (!Array.isArray(assessment.evidence)) throw new Error(`${label}.evidence must be an array`);
    const refs = assessment.evidence.map((candidate, evidenceIndex) => (
      requiredString(candidate && candidate.ref, `${label}.evidence[${evidenceIndex}].ref`)
    ));
    if (new Set(refs).size !== refs.length) {
      throw new Error(`${label}.evidence contains duplicate refs`);
    }
    normalized.set(criterionId, assessment);
  }
  return normalized;
}

function resultForCriterion(criterion, assessment, runtimeEvidence, contractHash, subjectHash) {
  if (!assessment && !runtimeEvidence) {
    return {
      criterionId: criterion.id,
      oracleHash: acceptance.oracleHash(criterion.oracle),
      status: 'unknown',
      evaluatorRef: EVALUATOR_REF,
      evidenceRefs: [],
      observed: 'No criterion-bound assessment was supplied.',
    };
  }
  const evaluated = assessment ? assessment.evidence.map((candidate, index) => (
    normalizeEvidenceCandidate(
      candidate,
      criterion,
      contractHash,
      subjectHash,
      `assessment ${criterion.id} evidence[${index}]`
    )
  )) : [];
  if (runtimeEvidence && runtimeEvidence.ref) evaluated.unshift(runtimeEvidence);
  const status = evaluated.some((entry) => entry.verdict === 'failed')
    ? 'failed'
    : (evaluated.some((entry) => entry.verdict === 'passed') ? 'passed' : 'unknown');
  const observed = status === 'failed'
    ? 'Verified evidence demonstrates the criterion failed.'
    : (status === 'passed'
      ? 'Verified evidence satisfies the criterion Oracle.'
      : 'No verified evidence satisfies or disproves the criterion Oracle.');
  return {
    criterionId: criterion.id,
    oracleHash: acceptance.oracleHash(criterion.oracle),
    status,
    evaluatorRef: EVALUATOR_REF,
    evidenceRefs: evaluated.map((entry) => entry.ref),
    observed,
  };
}

function evaluateAcceptance(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  if (!Object.prototype.hasOwnProperty.call(input, 'subject')) throw new Error('subject is required');
  const subjectHash = stableHash(input.subject);
  const assessments = normalizeAssessments(input.assessments || [], contract);
  const runtimeEvidence = input[INTERNAL_RUNTIME_EVIDENCE] === true
    && input.runtimeEvidence instanceof Map
    ? input.runtimeEvidence
    : new Map();
  const results = contract.criteria.map((criterion) => resultForCriterion(
    criterion,
    assessments.get(criterion.id),
    runtimeEvidence.get(criterion.id),
    contract.contractHash,
    subjectHash
  ));
  return acceptance.createAcceptanceReceipt({
    contract,
    subjectRef: input.subjectRef,
    subject: input.subject,
    results,
  });
}

function criterionId(statement, sourceRef) {
  return `ac-${stableHash({ statement, sourceRef }).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

const COMMAND_EXPECTED_EXIT_ZERO = 'exit code is zero';

function createAcceptanceContractFromCriteria(input = {}) {
  if (!Object.prototype.hasOwnProperty.call(input, 'sourceRequirement')) {
    throw new Error('sourceRequirement is required');
  }
  if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
    throw new Error('criteria must contain at least one criterion');
  }
  const sourceRef = requiredString(input.sourceRef, 'sourceRef').replace(/\/$/, '');
  const criteria = input.criteria.map((entry, index) => {
    if (typeof entry === 'string') {
      const statement = requiredString(entry, `criteria[${index}]`);
      const itemSourceRef = `${sourceRef}/${index}`;
      const id = criterionId(statement, itemSourceRef);
      return {
        id,
        statement,
        sourceRefs: [itemSourceRef],
        oracle: {
          type: 'independent-review',
          procedure: `Review ${id} against the frozen requirement.`,
          expected: 'A criterion-bound independent reviewer decision is passed.',
        },
      };
    }
    if (!isPlainObject(entry)) throw new Error(`criteria[${index}] must be a string or object`);
    if (entry.oracle && entry.oracle.type === 'command'
        && entry.oracle.expected !== COMMAND_EXPECTED_EXIT_ZERO) {
      throw new Error(`criteria[${index}] command oracle expected must be "${COMMAND_EXPECTED_EXIT_ZERO}"`);
    }
    return entry;
  });
  return acceptance.createAcceptanceContract({
    sourceRequirement: input.sourceRequirement,
    criteria,
  });
}

function expectedSampleMarkerFile(controlDir, contractHash) {
  if (typeof contractHash !== 'string' || !acceptance.HASH_PATTERN.test(contractHash)) {
    throw new Error('acceptance contractHash is invalid');
  }
  const digest = contractHash.slice('sha256:'.length);
  return path.join(controlDir, 'acceptance-expected-samples', `${digest}.json`);
}

function writeAcceptanceContract(runDir, sourceRequirement, criteria, sourceRef, options = {}) {
  const contract = createAcceptanceContractFromCriteria({
    sourceRequirement,
    criteria,
    sourceRef,
  });
  const file = resolveRunRelative(runDir, '.', 'acceptance-contract.json');
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    acceptance.assertAcceptanceContract(existing);
    if (existing.contractHash !== contract.contractHash) {
      if (options.allowRevision !== true) {
        throw new Error('acceptance contract conflicts with existing frozen contract');
      }
      const historyDir = resolveRunRelative(runDir, '.', 'acceptance-contract-history');
      fs.mkdirSync(historyDir, { recursive: true });
      const historyFile = path.join(historyDir, `${existing.contractHash.slice('sha256:'.length)}.json`);
      if (!fs.existsSync(historyFile)) writeJson(historyFile, existing, { flag: 'wx' });
      else if (stableHash(JSON.parse(fs.readFileSync(historyFile, 'utf8'))) !== stableHash(existing)) {
        throw new Error('acceptance contract history conflicts with archived contract');
      }
      writeJson(file, contract);
      return contract;
    }
    acceptance.assertAcceptanceContract(existing, { sourceRequirement });
    return existing;
  }
  writeJson(file, contract, { flag: 'wx' });
  return contract;
}

function assertStructuredCriteriaAlign(criteria, statements, sourceRef) {
  if (!Array.isArray(criteria) || !Array.isArray(statements)
      || criteria.length !== statements.length) {
    throw new Error('structured acceptance criteria must exactly cover source statements');
  }
  criteria.forEach((criterion, index) => {
    const expectedRef = `${sourceRef.replace(/\/$/, '')}/${index}`;
    if (!isPlainObject(criterion)
        || criterion.statement !== statements[index]
        || !Array.isArray(criterion.sourceRefs)
        || criterion.sourceRefs.length !== 1
        || criterion.sourceRefs[0] !== expectedRef) {
      throw new Error(`structured acceptance criterion ${index} does not align with its source statement`);
    }
  });
}

function writeAcceptanceContractForSpec(runDir, spec) {
  if (!isPlainObject(spec) || !isPlainObject(spec.requirementSpec)) {
    throw new Error('spec.requirementSpec is required');
  }
  const explicit = isPlainObject(spec.acceptanceContract)
    ? spec.acceptanceContract.criteria
    : null;
  const criteria = Array.isArray(explicit)
    ? explicit
    : spec.requirementSpec.acceptanceCriteria;
  if (Array.isArray(explicit)) {
    assertStructuredCriteriaAlign(
      explicit,
      spec.requirementSpec.acceptanceCriteria,
      'spec.json#/requirementSpec/acceptanceCriteria'
    );
  }
  return writeAcceptanceContract(
    runDir,
    spec.requirementSpec,
    criteria,
    'spec.json#/requirementSpec/acceptanceCriteria'
  );
}

function createAcceptanceContractForGlobalContract(globalContract) {
  if (!isPlainObject(globalContract)) throw new Error('global contract is required');
  const sourceRequirement = {
    goal: globalContract.goal,
    globalAcceptance: globalContract.globalAcceptance,
  };
  const explicit = isPlainObject(globalContract.acceptanceContract)
    ? globalContract.acceptanceContract.criteria
    : null;
  const criteria = Array.isArray(explicit) ? explicit : globalContract.globalAcceptance;
  if (Array.isArray(explicit)) {
    assertStructuredCriteriaAlign(
      explicit,
      globalContract.globalAcceptance,
      'global-contract.json#/globalAcceptance'
    );
  }
  return createAcceptanceContractFromCriteria({
    sourceRequirement,
    criteria,
    sourceRef: 'global-contract.json#/globalAcceptance',
  });
}

function writeAcceptanceContractForGlobalContract(runDir, globalContract, options = {}) {
  const contract = createAcceptanceContractForGlobalContract(globalContract);
  const sourceRequirement = { goal: globalContract.goal, globalAcceptance: globalContract.globalAcceptance };
  return writeAcceptanceContract(runDir, sourceRequirement, contract.criteria,
    'global-contract.json#/globalAcceptance', options);
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertRunWithinWorkdir(workdirValue, runDirValue, controlStoreOptions = {}) {
  const workdir = path.resolve(requiredString(workdirValue, 'workdir'));
  const runDir = path.resolve(requiredString(runDirValue, 'runDir'));
  const realWorkdir = fs.realpathSync.native(workdir);
  const realRunDir = fs.realpathSync.native(runDir);
  if (!isContained(realWorkdir, realRunDir)) {
    const controlRoot = path.resolve(requiredString(controlStoreOptions.controlRoot, 'controlRoot'));
    const realControlRoot = fs.realpathSync.native(controlRoot);
    const realRunsRoot = fs.realpathSync.native(path.join(path.dirname(realControlRoot), 'runs'));
    if (path.basename(realControlRoot) !== 'control' || !isContained(realRunsRoot, realRunDir)) {
      throw new Error('acceptance runDir must stay inside workdir or the authority runs root');
    }
  }
  if (!fs.statSync(realRunDir).isDirectory()) {
    throw new Error('acceptance runDir must stay inside workdir');
  }
  return { workdir: realWorkdir, runDir: realRunDir };
}

function captureArtifactBaselines(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  const directories = assertRunWithinWorkdir(input.workdir, input.runDir, input.controlStoreOptions);
  if (!input.controlStoreOptions) {
    throw new Error('artifact baseline requires external control store options');
  }
  const artifactCriteria = contract.criteria.filter((criterion) => criterion.oracle.type === 'artifact');
  if (artifactCriteria.length === 0) return [];
  const controlDir = controlStore.ensureControlRunDir(
    directories.runDir,
    input.controlStoreOptions
  );
  const baselineDir = path.join(controlDir, 'acceptance-artifact-baselines');
  controlStore.assertAuthoritativeControlPath(
    directories.runDir,
    baselineDir,
    input.controlStoreOptions
  );
  fs.mkdirSync(baselineDir, { recursive: true });
  return artifactCriteria.map((criterion) => {
    const artifactRef = artifactRefFromOracle(criterion.oracle);
    const baseline = {
      schemaVersion: 'acceptance-artifact-baseline-v1',
      contractHash: contract.contractHash,
      criterionId: criterion.id,
      oracleHash: acceptance.oracleHash(criterion.oracle),
      artifactRef,
      snapshot: artifactRef
        ? snapshotArtifact(directories.workdir, directories.runDir, artifactRef)
        : { status: 'unsupported' },
    };
    const file = path.join(baselineDir, `${criterion.id}.json`);
    const recorded = controlStore.claimAuthoritativeJson(
      directories.runDir,
      file,
      baseline,
      input.controlStoreOptions
    );
    if (stableHash(recorded) !== stableHash(baseline)) {
      throw new Error(`authoritative artifact baseline conflicts for ${criterion.id}`);
    }
    return baseline;
  });
}

function artifactSnapshotVerdict(baseline, current, subjectEffect = true) {
  if (!subjectEffect) return 'unknown';
  if (!baseline || !current) return 'unknown';
  if (baseline.status === 'unsupported' || baseline.status === 'unsafe'
      || baseline.status === 'unavailable' || current.status === 'unsafe'
      || current.status === 'unavailable') return 'unknown';
  if (current.status === 'missing') return 'failed';
  if (current.status !== 'present') return 'unknown';
  if (baseline.status === 'missing') return 'passed';
  if (baseline.status !== 'present') return 'unknown';
  return baseline.contentDigest === current.contentDigest ? 'unknown' : 'passed';
}

function changedFilePath(entry) {
  if (typeof entry === 'string') return entry.replace(/\\/g, '/');
  if (isPlainObject(entry) && typeof entry.path === 'string') return entry.path.replace(/\\/g, '/');
  return null;
}

function artifactEffectRefs(runDir, relativeDir) {
  const candidates = [];
  const scopedFile = resolveRunRelative(runDir, relativeDir, 'changed-files.json');
  if (fs.existsSync(scopedFile)) candidates.push(scopedFile);
  if (relativeDir === '.' && candidates.length === 0) {
    const slicesDir = resolveRunRelative(runDir, '.', 'slices');
    if (fs.existsSync(slicesDir)) {
      for (const name of fs.readdirSync(slicesDir).sort()) {
        const file = path.join(slicesDir, name, 'changed-files.json');
        if (fs.existsSync(file)) candidates.push(file);
      }
    }
  }
  return [...new Set(candidates.flatMap((file) => {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(entries) ? entries.map(changedFilePath).filter(Boolean) : [];
  }))].sort();
}

function assertArtifactSnapshot(value) {
  if (!isPlainObject(value) || !['present', 'missing', 'unsafe', 'unavailable', 'unsupported'].includes(value.status)) {
    throw new Error('artifact snapshot is invalid');
  }
  const keys = Object.keys(value).sort();
  if (value.status === 'present') {
    if (keys.join(',') !== 'bytes,contentDigest,status'
        || !Number.isInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_ARTIFACT_BYTES) {
      throw new Error('present artifact snapshot is invalid');
    }
    validateHash(value.contentDigest, 'artifact contentDigest');
  } else if (keys.join(',') !== 'status') {
    throw new Error('non-present artifact snapshot is invalid');
  }
  return value;
}

function sealArtifactEvidence(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  const subjectHash = validateHash(input.subjectHash, 'subjectHash');
  const directories = assertRunWithinWorkdir(input.workdir, input.runDir, input.controlStoreOptions);
  if (!input.controlStoreOptions) {
    throw new Error('artifact seal requires external control store options');
  }
  const artifactCriteria = contract.criteria.filter((criterion) => criterion.oracle.type === 'artifact');
  if (artifactCriteria.length === 0) return null;
  const controlDir = controlStore.controlRunDir(
    directories.runDir,
    input.controlStoreOptions
  );
  const baselineDir = path.join(controlDir, 'acceptance-artifact-baselines');
  const effectRefs = Array.isArray(input.effectRefs)
    ? [...new Set(input.effectRefs)].sort()
    : artifactEffectRefs(directories.runDir, input.relativeDir || '.');
  const artifacts = artifactCriteria.map((criterion, index) => {
    const baselineFile = path.join(baselineDir, `${criterion.id}.json`);
    if (!fs.existsSync(baselineFile)) {
      throw new Error(`authoritative artifact baseline is missing for ${criterion.id}`);
    }
    const baseline = controlStore.readAuthoritativeJson(
      directories.runDir,
      baselineFile,
      input.controlStoreOptions
    );
    const artifactRef = artifactRefFromOracle(criterion.oracle);
    if (!baseline || baseline.schemaVersion !== 'acceptance-artifact-baseline-v1'
        || baseline.contractHash !== contract.contractHash
        || baseline.criterionId !== criterion.id
        || baseline.oracleHash !== acceptance.oracleHash(criterion.oracle)
        || baseline.artifactRef !== artifactRef) {
      throw new Error(`authoritative artifact baseline binding is invalid for ${criterion.id}`);
    }
    const current = artifactRef
      ? snapshotArtifact(directories.workdir, directories.runDir, artifactRef)
      : { status: 'unsupported' };
    const subjectEffect = artifactRef !== null && effectRefs.includes(artifactRef);
    return {
      index,
      criterionId: criterion.id,
      oracleHash: acceptance.oracleHash(criterion.oracle),
      artifactRef,
      baseline: canonicalize(baseline.snapshot),
      current: canonicalize(current),
      subjectEffect,
      verdict: artifactSnapshotVerdict(baseline.snapshot, current, subjectEffect),
    };
  });
  const core = {
    schemaVersion: 'acceptance-artifact-seal-v1',
    contractHash: contract.contractHash,
    subjectHash,
    effectRefs,
    effectRefsHash: stableHash(effectRefs),
    artifacts,
  };
  const seal = { ...core, sealHash: stableHash(core) };
  const sealDir = path.join(controlDir, 'acceptance-artifact-seals');
  controlStore.assertAuthoritativeControlPath(
    directories.runDir,
    sealDir,
    input.controlStoreOptions
  );
  fs.mkdirSync(sealDir, { recursive: true });
  const file = path.join(sealDir, `${seal.sealHash.slice('sha256:'.length)}.json`);
  const recorded = controlStore.claimAuthoritativeJson(
    directories.runDir,
    file,
    seal,
    input.controlStoreOptions
  );
  if (stableHash(recorded) !== stableHash(seal)) {
    throw new Error('authoritative artifact seal conflicts with existing record');
  }
  return seal;
}

function readbackRequest(contract, subjectHash, runLocator, criterion) {
  return {
    schemaVersion: 'acceptance-readback-request-v1',
    runLocator,
    binding: {
      contractHash: contract.contractHash,
      subjectHash,
      criterionId: criterion.id,
      oracleHash: acceptance.oracleHash(criterion.oracle),
    },
    oracle: canonicalize(criterion.oracle),
  };
}

function executeAuthorityBroker(broker, request, input, settings) {
  const runner = input.spawnSyncImpl || spawnSync;
  const result = runner(process.execPath, [broker], {
    cwd: path.dirname(broker),
    encoding: 'utf8',
    input: JSON.stringify(request),
    maxBuffer: MAX_AUTHORITY_BROKER_RESPONSE_BYTES,
    shell: false,
    timeout: input[settings.timeoutField] || 30_000,
    windowsHide: true,
    env: minimalAuthorityBrokerEnvironment(),
  });
  if (result.error || result.status !== 0) {
    const detail = redactSensitiveText(result.error && result.error.message
      ? result.error.message
      : String(result.stderr || result.stdout || `exit ${result.status}`).trim());
    throw new Error(`acceptance ${settings.label} broker failed: ${detail}`);
  }
  let response;
  try {
    response = JSON.parse(String(result.stdout || '').trim());
  } catch (_error) {
    throw new Error(`acceptance ${settings.label} broker returned invalid JSON`);
  }
  return response;
}

function executeReadbackBroker(broker, request, input = {}) {
  const response = executeAuthorityBroker(broker, request, input, {
    label: 'readback',
    timeoutField: 'readbackTimeoutMs',
  });
  assertExactKeys(
    response,
    [
      'schemaVersion', 'runLocator', 'binding', 'readerRef', 'writerRef',
      'matched', 'resultDigest',
    ],
    'readback response'
  );
  if (response.schemaVersion !== 'acceptance-readback-response-v1') {
    throw new Error('acceptance readback broker returned an unsupported response');
  }
  if (requiredString(response.runLocator, 'readback response.runLocator')
      !== request.runLocator) {
    throw new Error('acceptance readback response run locator is invalid');
  }
  const binding = validateBinding(
    response.binding,
    { id: request.binding.criterionId, oracle: request.oracle },
    request.binding.contractHash,
    request.binding.subjectHash,
    'readback response.binding'
  );
  if (!binding.valid) throw new Error('acceptance readback response binding is invalid');
  const readerRef = requiredString(response.readerRef, 'readback response.readerRef');
  const writerRef = requiredString(response.writerRef, 'readback response.writerRef');
  if (readerRef === writerRef) throw new Error('acceptance readback reader must be independent');
  return {
    binding: binding.canonical,
    readerRef,
    writerRef,
    matched: boolean(response.matched, 'readback response.matched'),
    resultDigest: validateHash(response.resultDigest, 'readback response.resultDigest'),
  };
}

function captureAuthorityBroker(broker) {
  const stat = fs.statSync(broker);
  return { stat, digest: hashBuffer(fs.readFileSync(broker)) };
}

function assertAuthorityBrokerStable(broker, before, label) {
  const after = fs.statSync(broker);
  if (before.stat.dev !== after.dev || before.stat.ino !== after.ino
      || before.stat.size !== after.size || before.stat.mtimeMs !== after.mtimeMs
      || hashBuffer(fs.readFileSync(broker)) !== before.digest) {
    throw new Error(`Acceptance ${label} broker changed during execution`);
  }
}

function sealReadbackEvidence(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  const subjectHash = validateHash(input.subjectHash, 'subjectHash');
  const criteria = contract.criteria.filter((criterion) => criterion.oracle.type === 'readback');
  if (criteria.length === 0 || !input.controlStoreOptions
      || !input.controlStoreOptions.readbackBrokerPath) return null;
  const directories = assertRunWithinWorkdir(input.workdir, input.runDir, input.controlStoreOptions);
  const broker = canonicalExistingFileOutsideProviderRoot(
    input.controlStoreOptions.readbackBrokerPath,
    input.controlStoreOptions.providerRoot || directories.workdir,
    'Acceptance readback broker'
  );
  const brokerSnapshot = captureAuthorityBroker(broker);
  const runLocator = controlStore.stableRunLocator(directories.runDir);
  const entries = criteria.map((criterion, index) => {
    const request = readbackRequest(contract, subjectHash, runLocator, criterion);
    try {
      const response = executeReadbackBroker(broker, request, input.controlStoreOptions);
      return {
        index,
        criterionId: criterion.id,
        oracleHash: request.binding.oracleHash,
        readerRef: response.readerRef,
        writerRef: response.writerRef,
        matched: response.matched,
        resultDigest: response.resultDigest,
        verdict: response.matched ? 'passed' : 'failed',
      };
    } catch (error) {
      return {
        index,
        criterionId: criterion.id,
        oracleHash: request.binding.oracleHash,
        errorDigest: hashText(redactSensitiveText(error.message)),
        verdict: 'unknown',
      };
    }
  });
  assertAuthorityBrokerStable(broker, brokerSnapshot, 'readback');
  const core = {
    schemaVersion: 'acceptance-readback-seal-v1',
    contractHash: contract.contractHash,
    subjectHash,
    runLocator,
    brokerDigest: brokerSnapshot.digest,
    entries,
  };
  const seal = { ...core, sealHash: stableHash(core) };
  const controlDir = controlStore.ensureControlRunDir(directories.runDir, input.controlStoreOptions);
  const directory = path.join(controlDir, 'acceptance-readback-seals');
  controlStore.assertAuthoritativeControlPath(directories.runDir, directory, input.controlStoreOptions);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${seal.sealHash.slice('sha256:'.length)}.json`);
  const recorded = controlStore.claimAuthoritativeJson(
    directories.runDir,
    file,
    seal,
    input.controlStoreOptions
  );
  if (stableHash(recorded) !== stableHash(seal)) {
    throw new Error('authoritative readback seal conflicts with existing record');
  }
  return seal;
}

function independentReviewRequest(contract, subjectHash, runLocator, criterion) {
  return {
    schemaVersion: 'acceptance-independent-review-request-v1',
    runLocator,
    binding: {
      contractHash: contract.contractHash,
      subjectHash,
      criterionId: criterion.id,
      oracleHash: acceptance.oracleHash(criterion.oracle),
    },
    oracle: canonicalize(criterion.oracle),
  };
}

function executeIndependentReviewBroker(broker, request, input = {}) {
  const response = executeAuthorityBroker(broker, request, input, {
    label: 'independent review',
    timeoutField: 'independentReviewTimeoutMs',
  });
  assertExactKeys(response, [
    'schemaVersion', 'runLocator', 'binding', 'reviewerRef', 'writerRef',
    'criterionDecision', 'resultDigest',
  ], 'independent review response');
  if (response.schemaVersion !== 'acceptance-independent-review-response-v1') {
    throw new Error('acceptance independent review broker returned an unsupported response');
  }
  if (requiredString(response.runLocator, 'independent review response.runLocator')
      !== request.runLocator) {
    throw new Error('acceptance independent review response run locator is invalid');
  }
  const binding = validateBinding(
    response.binding,
    { id: request.binding.criterionId, oracle: request.oracle },
    request.binding.contractHash,
    request.binding.subjectHash,
    'independent review response.binding'
  );
  if (!binding.valid) throw new Error('acceptance independent review response binding is invalid');
  const reviewerRef = requiredString(response.reviewerRef, 'independent review response.reviewerRef');
  const writerRef = requiredString(response.writerRef, 'independent review response.writerRef');
  if (reviewerRef === writerRef) {
    throw new Error('acceptance independent reviewer must differ from writer');
  }
  const criterionDecision = requiredString(
    response.criterionDecision,
    'independent review response.criterionDecision'
  );
  if (!['passed', 'failed', 'unknown'].includes(criterionDecision)) {
    throw new Error('acceptance independent review decision is unsupported');
  }
  return {
    binding: binding.canonical,
    reviewerRef,
    writerRef,
    criterionDecision,
    resultDigest: validateHash(response.resultDigest, 'independent review response.resultDigest'),
  };
}

function sealIndependentReviewEvidence(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  const subjectHash = validateHash(input.subjectHash, 'subjectHash');
  const criteria = contract.criteria.filter(
    (criterion) => criterion.oracle.type === 'independent-review'
  );
  if (criteria.length === 0 || !input.controlStoreOptions
      || !input.controlStoreOptions.independentReviewBrokerPath) return null;
  const directories = assertRunWithinWorkdir(input.workdir, input.runDir, input.controlStoreOptions);
  const broker = canonicalExistingFileOutsideProviderRoot(
    input.controlStoreOptions.independentReviewBrokerPath,
    input.controlStoreOptions.providerRoot || directories.workdir,
    'Acceptance independent review broker'
  );
  const brokerSnapshot = captureAuthorityBroker(broker);
  const runLocator = controlStore.stableRunLocator(directories.runDir);
  const entries = criteria.map((criterion, index) => {
    const request = independentReviewRequest(contract, subjectHash, runLocator, criterion);
    try {
      const response = executeIndependentReviewBroker(
        broker,
        request,
        input.controlStoreOptions
      );
      return {
        index,
        criterionId: criterion.id,
        oracleHash: request.binding.oracleHash,
        reviewerRef: response.reviewerRef,
        writerRef: response.writerRef,
        criterionDecision: response.criterionDecision,
        resultDigest: response.resultDigest,
        verdict: response.criterionDecision,
      };
    } catch (error) {
      return {
        index,
        criterionId: criterion.id,
        oracleHash: request.binding.oracleHash,
        errorDigest: hashText(redactSensitiveText(error.message)),
        verdict: 'unknown',
      };
    }
  });
  assertAuthorityBrokerStable(broker, brokerSnapshot, 'independent review');
  const core = {
    schemaVersion: 'acceptance-independent-review-seal-v1',
    contractHash: contract.contractHash,
    subjectHash,
    runLocator,
    brokerDigest: brokerSnapshot.digest,
    entries,
  };
  const seal = { ...core, sealHash: stableHash(core) };
  const controlDir = controlStore.ensureControlRunDir(directories.runDir, input.controlStoreOptions);
  const directory = path.join(controlDir, 'acceptance-independent-review-seals');
  controlStore.assertAuthoritativeControlPath(directories.runDir, directory, input.controlStoreOptions);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${seal.sealHash.slice('sha256:'.length)}.json`);
  const recorded = controlStore.claimAuthoritativeJson(
    directories.runDir,
    file,
    seal,
    input.controlStoreOptions
  );
  if (stableHash(recorded) !== stableHash(seal)) {
    throw new Error('authoritative independent review seal conflicts with existing record');
  }
  return seal;
}

function userConfirmationRequest(contract, subjectHash, runLocator, criterion) {
  return {
    schemaVersion: 'acceptance-user-confirmation-request-v1',
    runLocator,
    binding: {
      contractHash: contract.contractHash,
      subjectHash,
      criterionId: criterion.id,
      oracleHash: acceptance.oracleHash(criterion.oracle),
    },
  };
}

function executeUserConfirmationBroker(broker, request, input = {}) {
  const response = executeAuthorityBroker(broker, request, input, {
    label: 'user confirmation',
    timeoutField: 'userConfirmationTimeoutMs',
  });
  assertExactKeys(response, [
    'schemaVersion', 'runLocator', 'binding', 'authorityRef', 'eventRef',
    'decision', 'controlEnvelopeDigest',
  ], 'user confirmation response');
  if (response.schemaVersion !== 'acceptance-user-confirmation-response-v1') {
    throw new Error('acceptance user confirmation broker returned an unsupported response');
  }
  if (requiredString(response.runLocator, 'user confirmation response.runLocator')
      !== request.runLocator) {
    throw new Error('acceptance user confirmation response run locator is invalid');
  }
  assertExactKeys(
    response.binding,
    ['contractHash', 'subjectHash', 'criterionId', 'oracleHash'],
    'user confirmation response.binding'
  );
  const binding = {
    contractHash: validateHash(
      response.binding.contractHash,
      'user confirmation response.binding.contractHash'
    ),
    subjectHash: validateHash(
      response.binding.subjectHash,
      'user confirmation response.binding.subjectHash'
    ),
    criterionId: requiredString(
      response.binding.criterionId,
      'user confirmation response.binding.criterionId'
    ),
    oracleHash: validateHash(
      response.binding.oracleHash,
      'user confirmation response.binding.oracleHash'
    ),
  };
  if (binding.oracleHash !== request.binding.oracleHash
      || binding.contractHash !== request.binding.contractHash
      || binding.subjectHash !== request.binding.subjectHash
      || binding.criterionId !== request.binding.criterionId) {
    throw new Error('acceptance user confirmation response binding is invalid');
  }
  const authorityRef = requiredString(
    response.authorityRef,
    'user confirmation response.authorityRef'
  );
  if (!USER_CONFIRMATION_AUTHORITY_REFS.has(authorityRef)) {
    throw new Error('acceptance user confirmation authority is unsupported');
  }
  const decision = requiredString(response.decision, 'user confirmation response.decision');
  if (!['accepted', 'rejected'].includes(decision)) {
    throw new Error('acceptance user confirmation decision is unsupported');
  }
  return {
    binding,
    authorityRef,
    eventRef: requiredString(response.eventRef, 'user confirmation response.eventRef'),
    decision,
    controlEnvelopeDigest: validateHash(
      response.controlEnvelopeDigest,
      'user confirmation response.controlEnvelopeDigest'
    ),
  };
}

function sealUserConfirmationEvidence(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  const subjectHash = validateHash(input.subjectHash, 'subjectHash');
  const criteria = contract.criteria.filter(
    (criterion) => criterion.oracle.type === 'user-confirmation'
  );
  if (criteria.length === 0 || !input.controlStoreOptions
      || !input.controlStoreOptions.userConfirmationBrokerPath) return null;
  const directories = assertRunWithinWorkdir(input.workdir, input.runDir, input.controlStoreOptions);
  const broker = canonicalExistingFileOutsideProviderRoot(
    input.controlStoreOptions.userConfirmationBrokerPath,
    input.controlStoreOptions.providerRoot || directories.workdir,
    'Acceptance user confirmation broker'
  );
  const brokerSnapshot = captureAuthorityBroker(broker);
  const runLocator = controlStore.stableRunLocator(directories.runDir);
  const entries = criteria.map((criterion, index) => {
    const request = userConfirmationRequest(contract, subjectHash, runLocator, criterion);
    try {
      const response = executeUserConfirmationBroker(
        broker,
        request,
        input.controlStoreOptions
      );
      return {
        index,
        criterionId: criterion.id,
        oracleHash: request.binding.oracleHash,
        authorityRef: response.authorityRef,
        eventRef: response.eventRef,
        decision: response.decision,
        controlEnvelopeDigest: response.controlEnvelopeDigest,
        verdict: response.decision === 'accepted' ? 'passed' : 'failed',
      };
    } catch (error) {
      return {
        index,
        criterionId: criterion.id,
        oracleHash: request.binding.oracleHash,
        errorDigest: hashText(redactSensitiveText(error.message)),
        verdict: 'unknown',
      };
    }
  });
  assertAuthorityBrokerStable(broker, brokerSnapshot, 'user confirmation');
  const core = {
    schemaVersion: 'acceptance-user-confirmation-seal-v1',
    contractHash: contract.contractHash,
    subjectHash,
    runLocator,
    brokerDigest: brokerSnapshot.digest,
    entries,
  };
  const seal = { ...core, sealHash: stableHash(core) };
  const controlDir = controlStore.ensureControlRunDir(directories.runDir, input.controlStoreOptions);
  const directory = path.join(controlDir, 'acceptance-user-confirmation-seals');
  controlStore.assertAuthoritativeControlPath(directories.runDir, directory, input.controlStoreOptions);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${seal.sealHash.slice('sha256:'.length)}.json`);
  const recorded = controlStore.claimAuthoritativeJson(
    directories.runDir,
    file,
    seal,
    input.controlStoreOptions
  );
  if (stableHash(recorded) !== stableHash(seal)) {
    throw new Error('authoritative user confirmation seal conflicts with existing record');
  }
  return seal;
}

const COHORT_TOMBSTONE_REASONS = new Set([
  'operator-abandoned',
  'superseded-before-evaluation',
]);

function assertAcceptanceCohortTombstone(value, expected = {}) {
  assertExactKeys(value, [
    'schemaVersion', 'runLocator', 'contractHash', 'expectedMarkerHash', 'reason',
    'authorityRef', 'eventRef', 'controlEnvelopeDigest', 'brokerDigest', 'tombstoneHash',
  ], 'acceptance cohort tombstone');
  if (value.schemaVersion !== 'acceptance-cohort-tombstone-v1') {
    throw new Error('acceptance cohort tombstone schema is unsupported');
  }
  const { tombstoneHash, ...core } = value;
  validateHash(tombstoneHash, 'acceptance cohort tombstone hash');
  validateHash(value.contractHash, 'acceptance cohort tombstone contractHash');
  validateHash(value.expectedMarkerHash, 'acceptance cohort tombstone expectedMarkerHash');
  validateHash(value.controlEnvelopeDigest, 'acceptance cohort tombstone controlEnvelopeDigest');
  validateHash(value.brokerDigest, 'acceptance cohort tombstone brokerDigest');
  requiredString(value.runLocator, 'acceptance cohort tombstone runLocator');
  requiredString(value.eventRef, 'acceptance cohort tombstone eventRef');
  if (!COHORT_TOMBSTONE_REASONS.has(value.reason)) {
    throw new Error('acceptance cohort tombstone reason is unsupported');
  }
  if (value.authorityRef !== 'operator:lifecycle-control') {
    throw new Error('acceptance cohort tombstone authority is unsupported');
  }
  if (stableHash(core) !== tombstoneHash) {
    throw new Error('acceptance cohort tombstone hash is invalid');
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[field] !== expectedValue) {
      throw new Error(`acceptance cohort tombstone ${field} binding is invalid`);
    }
  }
  return value;
}

function receiptAuthorityFiles(runDir, options) {
  const directory = receiptAuthorityDirectory(runDir, options);
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'));
}

function recordAcceptanceCohortTombstone(input = {}) {
  const runDir = path.resolve(input.runDir || '');
  try {
    const directories = assertRunWithinWorkdir(input.workdir, runDir, input.controlStoreOptions);
    if (!input.controlStoreOptions || !input.controlStoreOptions.cohortTombstoneBrokerPath) {
      throw new Error('acceptance cohort tombstone requires an external lifecycle broker');
    }
    const contractFile = resolveRunRelative(runDir, '.', 'acceptance-contract.json');
    const contract = acceptance.assertAcceptanceContract(
      JSON.parse(fs.readFileSync(contractFile, 'utf8'))
    );
    const controlDir = controlStore.ensureControlRunDir(runDir, input.controlStoreOptions);
    const keyedMarkerFile = expectedSampleMarkerFile(controlDir, contract.contractHash);
    const markerFile = fs.existsSync(keyedMarkerFile)
      ? keyedMarkerFile
      : path.join(controlDir, 'acceptance-expected-sample.json');
    const marker = controlStore.readAuthoritativeJson(
      runDir,
      markerFile,
      input.controlStoreOptions
    );
    if (!marker || marker.schemaVersion !== 'acceptance-expected-sample-v1'
        || marker.runLocator !== controlStore.stableRunLocator(runDir)
        || marker.contractHash !== contract.contractHash) {
      throw new Error('acceptance cohort tombstone expected-sample binding is invalid');
    }
    if (receiptAuthorityFiles(runDir, input.controlStoreOptions).length > 0) {
      throw new Error('acceptance Receipt authority already exists');
    }
    const requestedReason = requiredString(input.reason, 'acceptance cohort tombstone reason');
    if (!COHORT_TOMBSTONE_REASONS.has(requestedReason)) {
      throw new Error('acceptance cohort tombstone reason is unsupported');
    }
    const tombstoneFile = path.join(controlDir, 'acceptance-cohort-tombstone.json');
    if (fs.existsSync(tombstoneFile)) {
      return {
        status: 'written',
        tombstone: assertAcceptanceCohortTombstone(
          controlStore.readAuthoritativeJson(runDir, tombstoneFile, input.controlStoreOptions),
          {
            runLocator: marker.runLocator,
            contractHash: contract.contractHash,
            expectedMarkerHash: stableHash(marker),
            reason: requestedReason,
          }
        ),
      };
    }
    const broker = canonicalExistingFileOutsideProviderRoot(
      input.controlStoreOptions.cohortTombstoneBrokerPath,
      input.controlStoreOptions.providerRoot || directories.workdir,
      'Acceptance cohort tombstone broker'
    );
    const brokerSnapshot = captureAuthorityBroker(broker);
    const request = {
      schemaVersion: 'acceptance-cohort-tombstone-request-v1',
      runLocator: marker.runLocator,
      contractHash: contract.contractHash,
      expectedMarkerHash: stableHash(marker),
      requestedReason,
    };
    const response = executeAuthorityBroker(broker, request, input.controlStoreOptions, {
      label: 'cohort tombstone',
      timeoutField: 'cohortTombstoneTimeoutMs',
    });
    assertExactKeys(response, [
      'schemaVersion', 'runLocator', 'contractHash', 'expectedMarkerHash', 'reason',
      'authorityRef', 'eventRef', 'controlEnvelopeDigest',
    ], 'cohort tombstone response');
    if (response.schemaVersion !== 'acceptance-cohort-tombstone-response-v1'
        || response.runLocator !== request.runLocator
        || response.contractHash !== request.contractHash
        || response.expectedMarkerHash !== request.expectedMarkerHash
        || response.reason !== requestedReason
        || response.authorityRef !== 'operator:lifecycle-control') {
      throw new Error('acceptance cohort tombstone response binding is invalid');
    }
    requiredString(response.eventRef, 'cohort tombstone response.eventRef');
    validateHash(
      response.controlEnvelopeDigest,
      'cohort tombstone response.controlEnvelopeDigest'
    );
    assertAuthorityBrokerStable(broker, brokerSnapshot, 'cohort tombstone');
    if (receiptAuthorityFiles(runDir, input.controlStoreOptions).length > 0) {
      throw new Error('acceptance Receipt authority appeared during tombstone authorization');
    }
    const core = {
      schemaVersion: 'acceptance-cohort-tombstone-v1',
      runLocator: request.runLocator,
      contractHash: request.contractHash,
      expectedMarkerHash: request.expectedMarkerHash,
      reason: response.reason,
      authorityRef: response.authorityRef,
      eventRef: response.eventRef,
      controlEnvelopeDigest: response.controlEnvelopeDigest,
      brokerDigest: brokerSnapshot.digest,
    };
    const tombstone = { ...core, tombstoneHash: stableHash(core) };
    const recorded = controlStore.claimAuthoritativeJson(
      runDir,
      tombstoneFile,
      tombstone,
      input.controlStoreOptions
    );
    assertAcceptanceCohortTombstone(recorded, {
      runLocator: request.runLocator,
      contractHash: request.contractHash,
      expectedMarkerHash: request.expectedMarkerHash,
      reason: requestedReason,
    });
    if (receiptAuthorityFiles(runDir, input.controlStoreOptions).length > 0) {
      throw new Error('acceptance Receipt authority conflicts with cohort tombstone');
    }
    return { status: 'written', tombstone: recorded };
  } catch (error) {
    return { status: 'error', error: redactSensitiveText(error.message) };
  }
}

function recordAcceptanceContract(input = {}) {
  const runDir = path.resolve(requiredString(input.runDir, 'runDir'));
  let errorFile = null;
  try {
    if (input.workdir) assertRunWithinWorkdir(input.workdir, runDir, input.controlStoreOptions);
    errorFile = resolveRunRelative(runDir, '.', 'acceptance-contract.error.json');
    const contract = input.kind === 'global-contract'
      ? writeAcceptanceContractForGlobalContract(runDir, input.source, { allowRevision: input.allowRevision === true })
      : writeAcceptanceContractForSpec(runDir, input.source);
    if (input.controlStoreOptions) {
      if (contract.criteria.some((criterion) => criterion.oracle.type === 'artifact')) {
        captureArtifactBaselines({
          workdir: input.workdir,
          runDir,
          contract,
          controlStoreOptions: input.controlStoreOptions,
        });
      }
      const controlDir = controlStore.ensureControlRunDir(runDir, input.controlStoreOptions);
      const markerFile = expectedSampleMarkerFile(controlDir, contract.contractHash);
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      const marker = {
        schemaVersion: 'acceptance-expected-sample-v1',
        runLocator: controlStore.stableRunLocator(runDir),
        contractHash: contract.contractHash,
      };
      const recorded = controlStore.claimAuthoritativeJson(
        runDir,
        markerFile,
        marker,
        input.controlStoreOptions
      );
      if (stableHash(recorded) !== stableHash(marker)) {
        throw new Error('authoritative acceptance expected-sample marker conflicts');
      }
      const legacyMarkerFile = path.join(controlDir, 'acceptance-expected-sample.json');
      if (!fs.existsSync(legacyMarkerFile)) {
        controlStore.claimAuthoritativeJson(runDir, legacyMarkerFile, marker, input.controlStoreOptions);
      }
    }
    return { status: 'written', contract };
  } catch (error) {
    try {
      if (errorFile) writeShadowError(errorFile, error);
    } catch (_writeError) {
      // Contract production is shadow-only in P1 batch 1.
    }
    return {
      status: 'error',
      error: redactSensitiveText(error && error.message ? error.message : String(error)),
    };
  }
}

function verifiedLogEvidence(runDir, descriptor) {
  if (!isPlainObject(descriptor)
      || typeof descriptor.ref !== 'string'
      || typeof descriptor.hash !== 'string'
      || !Number.isInteger(descriptor.bytes)) return null;
  const file = resolveRunRelative(runDir, '.', descriptor.ref);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return null;
  const content = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(content, 'utf8') !== descriptor.bytes) return null;
  if (hashText(content) !== descriptor.hash) return null;
  return { ref: descriptor.ref.replace(/\\/g, '/'), hash: descriptor.hash };
}

function commandRuntimeEvidence(input, criterion) {
  if (input.relativeDir !== '.') return null;
  const artifactFile = resolveRunRelative(input.runDir, '.', 'integration-validation.json');
  if (!fs.existsSync(artifactFile)) return null;
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  } catch (_error) {
    return null;
  }
  if (!artifact || artifact.schemaVersion !== 'integration-validation-v1'
      || !Array.isArray(artifact.commands)) return null;
  const index = artifact.commands.findIndex((entry) => (
    entry && entry.command === criterion.oracle.procedure
  ));
  if (index < 0) return null;
  const command = artifact.commands[index];
  const policy = validationPolicy.validateGeneratedValidationCommand(command.command, {
    workdir: input.workdir,
  });
  const stdout = verifiedLogEvidence(input.runDir, command.stdout);
  const stderr = verifiedLogEvidence(input.runDir, command.stderr);
  const verified = policy.ok
    && command.timedOut === false
    && !command.error
    && stdout
    && stderr;
  const observedVerdict = verified
    ? (command.status === 'passed' && command.exitStatus === 0 ? 'passed'
      : (Number.isInteger(command.exitStatus) && command.exitStatus !== 0 ? 'failed' : 'unknown'))
    : 'unknown';
  return {
    // The validation artifact is still provider-writable. Hashes detect
    // corruption, but cannot prove provenance or freshness. Keep it claim-only
    // until a pre-provider snapshot is sealed in the external control store.
    verdict: 'unknown',
    ref: {
      kind: 'command-execution',
      ref: `integration-validation.json#commands/${index}`,
      digest: stableHash({
        contractHash: input.contract.contractHash,
        subjectHash: input.subjectHash,
        criterionId: criterion.id,
        oracleHash: acceptance.oracleHash(criterion.oracle),
        command: command.command,
        status: command.status,
        exitStatus: command.exitStatus,
        stdoutHash: stdout && stdout.hash,
        stderrHash: stderr && stderr.hash,
        observedVerdict,
      }),
      assurance: 'claimed',
    },
  };
}

function sealValidationEvidence(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  const directories = assertRunWithinWorkdir(input.workdir, input.runDir, input.controlStoreOptions);
  const validation = input.validation;
  const workspaceSnapshot = input.workspaceSnapshot;
  if (!isPlainObject(workspaceSnapshot)
      || typeof workspaceSnapshot.headSha !== 'string'
      || typeof workspaceSnapshot.changedFilesHash !== 'string'
      || typeof workspaceSnapshot.diffHash !== 'string') {
    throw new Error('validation seal requires a canonical workspace snapshot');
  }
  if (!isPlainObject(validation)
      || validation.schemaVersion !== 'integration-validation-v1'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(validation.attemptId || ''))
      || !Array.isArray(validation.commands)
      || validation.commands.length === 0) {
    throw new Error('validation evidence is not a sealable integration attempt');
  }
  const commands = validation.commands.map((command, index) => {
    if (!isPlainObject(command) || command.index !== index || typeof command.command !== 'string') {
      throw new Error(`validation command ${index} is not canonical`);
    }
    const policy = validationPolicy.validateGeneratedValidationCommand(command.command, {
      workdir: directories.workdir,
    });
    if (!policy.ok) throw new Error(`validation command ${index} cannot be sealed`);
    if (command.status === 'not-run') {
      if (command.exitStatus !== null || command.stdout !== null || command.stderr !== null) {
        throw new Error(`validation command ${index} not-run record is inconsistent`);
      }
      return {
        index,
        command: command.command,
        status: 'not-run',
        exitStatus: null,
        stdout: null,
        stderr: null,
      };
    }
    const stdout = verifiedLogEvidence(directories.runDir, command.stdout);
    const stderr = verifiedLogEvidence(directories.runDir, command.stderr);
    if (!stdout || !stderr || command.timedOut !== false || command.error) {
      throw new Error(`validation command ${index} cannot be sealed`);
    }
    const expectedStatus = command.exitStatus === 0 ? 'passed'
      : (Number.isInteger(command.exitStatus) ? 'failed' : null);
    if (!expectedStatus || command.status !== expectedStatus) {
      throw new Error(`validation command ${index} status is inconsistent`);
    }
    return {
      index,
      command: command.command,
      status: command.status,
      exitStatus: command.exitStatus,
      stdout,
      stderr,
    };
  });
  const aggregateStatus = commands.some((command) => command.status === 'failed')
    ? 'failed'
    : (commands.every((command) => command.status === 'passed') ? 'passed' : null);
  if (!aggregateStatus) throw new Error('validation aggregate has no terminal command result');
  if (validation.status !== aggregateStatus) {
    throw new Error('validation aggregate status is inconsistent');
  }
  const core = {
    schemaVersion: 'acceptance-validation-seal-v1',
    contractHash: contract.contractHash,
    attemptId: validation.attemptId,
    artifactHash: stableHash(validation),
    workspaceSnapshot: {
      headSha: workspaceSnapshot.headSha,
      changedFilesHash: workspaceSnapshot.changedFilesHash,
      diffHash: workspaceSnapshot.diffHash,
    },
    commands,
  };
  const seal = { ...core, sealHash: stableHash(core) };
  const options = input.controlStoreOptions;
  if (!options) throw new Error('validation seal requires external control store options');
  const controlDir = controlStore.ensureControlRunDir(directories.runDir, options);
  const directory = path.join(controlDir, 'acceptance-validation-seals');
  controlStore.assertAuthoritativeControlPath(directories.runDir, directory, options);
  fs.mkdirSync(directory, { recursive: true });
  controlStore.assertAuthoritativeControlPath(directories.runDir, directory, options);
  const file = path.join(directory, `${seal.sealHash.slice('sha256:'.length)}.json`);
  controlStore.assertAuthoritativeControlPath(directories.runDir, file, options);
  const serialized = `${JSON.stringify(seal, null, 2)}\n`;
  try {
    fs.writeFileSync(file, serialized, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fs.readFileSync(file, 'utf8') !== serialized) {
      throw new Error('authoritative validation seal conflicts with existing record');
    }
  }
  return seal;
}

function sealClassicValidationEvidence(input = {}) {
  const validation = input.validation;
  if (!isPlainObject(validation) || !Array.isArray(validation.commands)
      || validation.commands.length === 0) {
    throw new Error('classic validation evidence has no commands to seal');
  }
  const runDir = path.resolve(input.runDir);
  const commands = validation.commands.map((command, index) => {
    if (!isPlainObject(command) || typeof command.command !== 'string'
        || !Number.isInteger(command.exitCode)
        || typeof command.stdoutFile !== 'string'
        || typeof command.stderrFile !== 'string') {
      throw new Error(`classic validation command ${index} is not canonical`);
    }
    const descriptor = (ref) => {
      const file = resolveRunRelative(runDir, '.', ref);
      const content = fs.readFileSync(file, 'utf8');
      return {
        ref: ref.replace(/\\/g, '/'),
        hash: hashText(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        redacted: true,
      };
    };
    return {
      index,
      command: command.command,
      status: command.exitCode === 0 ? 'passed' : 'failed',
      exitStatus: command.exitCode,
      timedOut: false,
      error: null,
      stdout: descriptor(command.stdoutFile),
      stderr: descriptor(command.stderrFile),
    };
  });
  const normalized = {
    schemaVersion: 'integration-validation-v1',
    attemptId: `classic-${stableHash(validation).slice('sha256:'.length, 'sha256:'.length + 24)}`,
    status: commands.every((command) => command.status === 'passed') ? 'passed' : 'failed',
    artifactRef: input.artifactRef || 'validation.json',
    commands,
  };
  return sealValidationEvidence({ ...input, validation: normalized });
}

function resolveSealedRuntimeEvidence(contract, seal) {
  const resolved = new Map();
  const { sealHash, ...core } = seal || {};
  if (stableHash(core) !== sealHash || core.contractHash !== contract.contractHash) {
    throw new Error('validation seal binding is invalid');
  }
  for (const criterion of contract.criteria) {
    let evidence = null;
    if (criterion.oracle.type === 'command'
        && criterion.oracle.expected === COMMAND_EXPECTED_EXIT_ZERO) {
      const command = core.commands.find((entry) => entry.command === criterion.oracle.procedure);
      if (command && (command.status === 'passed' || command.status === 'failed')) {
        const verdict = command.status === 'passed' ? 'passed' : 'failed';
        evidence = {
          verdict,
          ref: {
            kind: 'command-execution',
            ref: `authority:acceptance-validation-seal/${sealHash}#commands/${command.index}`,
            digest: stableHash({
              sealHash,
              contractHash: contract.contractHash,
              criterionId: criterion.id,
              oracleHash: acceptance.oracleHash(criterion.oracle),
              command,
            }),
            assurance: 'verified',
          },
        };
      }
    }
    resolved.set(criterion.id, evidence || { verdict: 'unknown', ref: null });
  }
  return resolved;
}

function resolveSealedArtifactEvidence(contractValue, seal, subjectHashValue) {
  const contract = acceptance.assertAcceptanceContract(contractValue);
  const subjectHash = validateHash(subjectHashValue, 'subjectHash');
  const { sealHash, ...core } = seal || {};
  if (!sealHash || stableHash(core) !== sealHash
      || core.schemaVersion !== 'acceptance-artifact-seal-v1'
      || core.contractHash !== contract.contractHash
      || core.subjectHash !== subjectHash
      || !Array.isArray(core.artifacts) || !Array.isArray(core.effectRefs)
      || core.effectRefs.some((ref) => typeof ref !== 'string')
      || core.effectRefsHash !== stableHash(core.effectRefs)) {
    throw new Error('artifact seal binding is invalid');
  }
  const artifactCriteria = contract.criteria.filter((criterion) => criterion.oracle.type === 'artifact');
  if (core.artifacts.length !== artifactCriteria.length) {
    throw new Error('artifact seal criterion coverage is invalid');
  }
  const entries = new Map();
  for (const entry of core.artifacts) {
    if (!isPlainObject(entry) || entries.has(entry.criterionId)
        || !Number.isInteger(entry.index)
        || entry.index < 0 || entry.index >= core.artifacts.length
        || typeof entry.subjectEffect !== 'boolean'
        || !['passed', 'failed', 'unknown'].includes(entry.verdict)) {
      throw new Error('artifact seal entry is invalid');
    }
    assertArtifactSnapshot(entry.baseline);
    assertArtifactSnapshot(entry.current);
    entries.set(entry.criterionId, entry);
  }
  if (new Set(core.artifacts.map((entry) => entry.index)).size !== core.artifacts.length) {
    throw new Error('artifact seal entry indexes are invalid');
  }
  const resolved = new Map();
  for (const criterion of contract.criteria) {
    if (criterion.oracle.type !== 'artifact') {
      resolved.set(criterion.id, { verdict: 'unknown', ref: null });
      continue;
    }
    const entry = entries.get(criterion.id);
    const expectedRef = artifactRefFromOracle(criterion.oracle);
    const expectedSubjectEffect = expectedRef !== null && core.effectRefs.includes(expectedRef);
    if (!entry || entry.oracleHash !== acceptance.oracleHash(criterion.oracle)
        || entry.artifactRef !== expectedRef
        || entry.subjectEffect !== expectedSubjectEffect
        || entry.verdict !== artifactSnapshotVerdict(
          entry.baseline,
          entry.current,
          expectedSubjectEffect
        )) {
      throw new Error(`artifact seal entry binding is invalid for ${criterion.id}`);
    }
    resolved.set(criterion.id, {
      verdict: entry.verdict,
      ref: {
        kind: 'artifact-readback',
        ref: `authority:acceptance-artifact-seal/${sealHash}#artifacts/${entry.index}`,
        digest: stableHash({
          sealHash,
          contractHash: contract.contractHash,
          subjectHash,
          criterionId: criterion.id,
          oracleHash: acceptance.oracleHash(criterion.oracle),
          artifact: entry,
        }),
        assurance: 'verified',
      },
    });
  }
  return resolved;
}

function resolveSealedReadbackEvidence(contractValue, seal, subjectHashValue) {
  const contract = acceptance.assertAcceptanceContract(contractValue);
  const subjectHash = validateHash(subjectHashValue, 'subjectHash');
  const { sealHash, ...core } = seal || {};
  if (!sealHash || stableHash(core) !== sealHash
      || core.schemaVersion !== 'acceptance-readback-seal-v1'
      || core.contractHash !== contract.contractHash
      || core.subjectHash !== subjectHash
      || !Array.isArray(core.entries)) {
    throw new Error('readback seal binding is invalid');
  }
  validateHash(core.brokerDigest, 'readback seal brokerDigest');
  requiredString(core.runLocator, 'readback seal runLocator');
  const criteria = contract.criteria.filter((criterion) => criterion.oracle.type === 'readback');
  if (core.entries.length !== criteria.length) {
    throw new Error('readback seal criterion coverage is invalid');
  }
  const entries = new Map();
  for (const entry of core.entries) {
    if (!isPlainObject(entry) || entries.has(entry.criterionId)
        || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= criteria.length
        || !['passed', 'failed', 'unknown'].includes(entry.verdict)) {
      throw new Error('readback seal entry is invalid');
    }
    if (entry.verdict === 'unknown') {
      assertExactKeys(entry, ['index', 'criterionId', 'oracleHash', 'errorDigest', 'verdict'], 'readback seal entry');
      validateHash(entry.errorDigest, 'readback seal errorDigest');
    } else {
      assertExactKeys(entry, [
        'index', 'criterionId', 'oracleHash', 'readerRef', 'writerRef',
        'matched', 'resultDigest', 'verdict',
      ], 'readback seal entry');
      requiredString(entry.readerRef, 'readback seal readerRef');
      requiredString(entry.writerRef, 'readback seal writerRef');
      validateHash(entry.resultDigest, 'readback seal resultDigest');
      if (entry.readerRef === entry.writerRef
          || entry.verdict !== (entry.matched === true ? 'passed' : 'failed')) {
        throw new Error('readback seal entry verdict is invalid');
      }
    }
    validateHash(entry.oracleHash, 'readback seal oracleHash');
    entries.set(entry.criterionId, entry);
  }
  if (new Set(core.entries.map((entry) => entry.index)).size !== core.entries.length) {
    throw new Error('readback seal entry indexes are invalid');
  }
  const resolved = new Map();
  for (const criterion of contract.criteria) {
    if (criterion.oracle.type !== 'readback') {
      resolved.set(criterion.id, { verdict: 'unknown', ref: null });
      continue;
    }
    const entry = entries.get(criterion.id);
    if (!entry || entry.oracleHash !== acceptance.oracleHash(criterion.oracle)) {
      throw new Error(`readback seal entry binding is invalid for ${criterion.id}`);
    }
    resolved.set(criterion.id, {
      verdict: entry.verdict,
      ref: entry.verdict === 'unknown' ? null : {
        kind: 'runtime-readback',
        ref: `authority:acceptance-readback-seal/${sealHash}#entries/${entry.index}`,
        digest: stableHash({
          sealHash,
          contractHash: contract.contractHash,
          subjectHash,
          criterionId: criterion.id,
          oracleHash: acceptance.oracleHash(criterion.oracle),
          entry,
        }),
        assurance: 'verified',
      },
    });
  }
  return resolved;
}

function resolveSealedIndependentReviewEvidence(contractValue, seal, subjectHashValue) {
  const contract = acceptance.assertAcceptanceContract(contractValue);
  const subjectHash = validateHash(subjectHashValue, 'subjectHash');
  const { sealHash, ...core } = seal || {};
  if (!sealHash || stableHash(core) !== sealHash
      || core.schemaVersion !== 'acceptance-independent-review-seal-v1'
      || core.contractHash !== contract.contractHash
      || core.subjectHash !== subjectHash
      || !Array.isArray(core.entries)) {
    throw new Error('independent review seal binding is invalid');
  }
  requiredString(core.runLocator, 'independent review seal runLocator');
  validateHash(core.brokerDigest, 'independent review seal brokerDigest');
  const criteria = contract.criteria.filter(
    (criterion) => criterion.oracle.type === 'independent-review'
  );
  if (core.entries.length !== criteria.length) {
    throw new Error('independent review seal criterion coverage is invalid');
  }
  const entries = new Map();
  for (const entry of core.entries) {
    if (!isPlainObject(entry) || entries.has(entry.criterionId)
        || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= criteria.length
        || !['passed', 'failed', 'unknown'].includes(entry.verdict)) {
      throw new Error('independent review seal entry is invalid');
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'errorDigest')) {
      assertExactKeys(entry, [
        'index', 'criterionId', 'oracleHash', 'errorDigest', 'verdict',
      ], 'independent review seal entry');
      if (entry.verdict !== 'unknown') {
        throw new Error('independent review error entry must remain unknown');
      }
      validateHash(entry.errorDigest, 'independent review seal errorDigest');
    } else {
      assertExactKeys(entry, [
        'index', 'criterionId', 'oracleHash', 'reviewerRef', 'writerRef',
        'criterionDecision', 'resultDigest', 'verdict',
      ], 'independent review seal entry');
      requiredString(entry.reviewerRef, 'independent review seal reviewerRef');
      requiredString(entry.writerRef, 'independent review seal writerRef');
      validateHash(entry.resultDigest, 'independent review seal resultDigest');
      if (entry.reviewerRef === entry.writerRef
          || entry.verdict !== entry.criterionDecision
          || !['passed', 'failed', 'unknown'].includes(entry.criterionDecision)) {
        throw new Error('independent review seal entry verdict is invalid');
      }
    }
    validateHash(entry.oracleHash, 'independent review seal oracleHash');
    entries.set(entry.criterionId, entry);
  }
  if (new Set(core.entries.map((entry) => entry.index)).size !== core.entries.length) {
    throw new Error('independent review seal entry indexes are invalid');
  }
  const resolved = new Map();
  for (const criterion of contract.criteria) {
    if (criterion.oracle.type !== 'independent-review') {
      resolved.set(criterion.id, { verdict: 'unknown', ref: null });
      continue;
    }
    const entry = entries.get(criterion.id);
    if (!entry || entry.oracleHash !== acceptance.oracleHash(criterion.oracle)) {
      throw new Error(`independent review seal entry binding is invalid for ${criterion.id}`);
    }
    resolved.set(criterion.id, {
      verdict: entry.verdict,
      ref: entry.verdict === 'unknown' ? null : {
        kind: 'independent-review',
        ref: `authority:acceptance-independent-review-seal/${sealHash}#entries/${entry.index}`,
        digest: stableHash({
          sealHash,
          contractHash: contract.contractHash,
          subjectHash,
          criterionId: criterion.id,
          oracleHash: acceptance.oracleHash(criterion.oracle),
          entry,
        }),
        assurance: 'verified',
      },
    });
  }
  return resolved;
}

function resolveSealedUserConfirmationEvidence(contractValue, seal, subjectHashValue) {
  const contract = acceptance.assertAcceptanceContract(contractValue);
  const subjectHash = validateHash(subjectHashValue, 'subjectHash');
  const { sealHash, ...core } = seal || {};
  if (!sealHash || stableHash(core) !== sealHash
      || core.schemaVersion !== 'acceptance-user-confirmation-seal-v1'
      || core.contractHash !== contract.contractHash
      || core.subjectHash !== subjectHash
      || !Array.isArray(core.entries)) {
    throw new Error('user confirmation seal binding is invalid');
  }
  requiredString(core.runLocator, 'user confirmation seal runLocator');
  validateHash(core.brokerDigest, 'user confirmation seal brokerDigest');
  const criteria = contract.criteria.filter(
    (criterion) => criterion.oracle.type === 'user-confirmation'
  );
  if (core.entries.length !== criteria.length) {
    throw new Error('user confirmation seal criterion coverage is invalid');
  }
  const entries = new Map();
  for (const entry of core.entries) {
    if (!isPlainObject(entry) || entries.has(entry.criterionId)
        || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= criteria.length
        || !['passed', 'failed', 'unknown'].includes(entry.verdict)) {
      throw new Error('user confirmation seal entry is invalid');
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'errorDigest')) {
      assertExactKeys(entry, [
        'index', 'criterionId', 'oracleHash', 'errorDigest', 'verdict',
      ], 'user confirmation seal entry');
      if (entry.verdict !== 'unknown') {
        throw new Error('user confirmation error entry must remain unknown');
      }
      validateHash(entry.errorDigest, 'user confirmation seal errorDigest');
    } else {
      assertExactKeys(entry, [
        'index', 'criterionId', 'oracleHash', 'authorityRef', 'eventRef',
        'decision', 'controlEnvelopeDigest', 'verdict',
      ], 'user confirmation seal entry');
      if (!USER_CONFIRMATION_AUTHORITY_REFS.has(
        requiredString(entry.authorityRef, 'user confirmation seal authorityRef')
      )) {
        throw new Error('user confirmation seal authority is invalid');
      }
      requiredString(entry.eventRef, 'user confirmation seal eventRef');
      validateHash(entry.controlEnvelopeDigest, 'user confirmation seal controlEnvelopeDigest');
      if (!['accepted', 'rejected'].includes(entry.decision)
          || entry.verdict !== (entry.decision === 'accepted' ? 'passed' : 'failed')) {
        throw new Error('user confirmation seal entry verdict is invalid');
      }
    }
    validateHash(entry.oracleHash, 'user confirmation seal oracleHash');
    entries.set(entry.criterionId, entry);
  }
  if (new Set(core.entries.map((entry) => entry.index)).size !== core.entries.length) {
    throw new Error('user confirmation seal entry indexes are invalid');
  }
  const resolved = new Map();
  for (const criterion of contract.criteria) {
    if (criterion.oracle.type !== 'user-confirmation') {
      resolved.set(criterion.id, { verdict: 'unknown', ref: null });
      continue;
    }
    const entry = entries.get(criterion.id);
    if (!entry || entry.oracleHash !== acceptance.oracleHash(criterion.oracle)) {
      throw new Error(`user confirmation seal entry binding is invalid for ${criterion.id}`);
    }
    resolved.set(criterion.id, {
      verdict: entry.verdict,
      ref: entry.verdict === 'unknown' ? null : {
        kind: 'user-confirmation',
        ref: `authority:acceptance-user-confirmation-seal/${sealHash}#entries/${entry.index}`,
        digest: stableHash({
          sealHash,
          contractHash: contract.contractHash,
          subjectHash,
          criterionId: criterion.id,
          oracleHash: acceptance.oracleHash(criterion.oracle),
          entry,
        }),
        assurance: 'verified',
      },
    });
  }
  return resolved;
}

function mergeRuntimeEvidence(contract, evidenceMaps) {
  const merged = new Map();
  for (const criterion of contract.criteria) {
    const candidates = evidenceMaps.map((entries) => entries.get(criterion.id))
      .filter((entry) => entry && entry.ref);
    const selected = candidates.find((entry) => entry.verdict === 'failed')
      || candidates.find((entry) => entry.verdict === 'passed')
      || candidates[0]
      || { verdict: 'unknown', ref: null };
    merged.set(criterion.id, selected);
  }
  return merged;
}

function resolveRuntimeEvidence(input = {}) {
  const contract = acceptance.assertAcceptanceContract(input.contract);
  validateHash(input.subjectHash, 'subjectHash');
  const directories = assertRunWithinWorkdir(input.workdir, input.runDir, input.controlStoreOptions);
  const workdir = directories.workdir;
  const runDir = directories.runDir;
  const relativeDir = input.relativeDir || '.';
  const resolved = new Map();
  for (const criterion of contract.criteria) {
    let evidence = null;
    if (criterion.oracle.type === 'command') {
      evidence = commandRuntimeEvidence({
        workdir,
        runDir,
        relativeDir,
        contract,
        subjectHash: input.subjectHash,
      }, criterion);
    }
    resolved.set(criterion.id, evidence || { verdict: 'unknown', ref: null });
  }
  return resolved;
}

function resolveRunRelative(runDir, relativeDir, filename) {
  const root = path.resolve(runDir);
  const target = path.resolve(root, relativeDir || '.', filename);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`acceptance shadow path escapes run directory: ${target}`);
  }
  const segments = relative.split(path.sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`acceptance shadow path contains symbolic link: ${cursor}`);
    }
    const resolved = fs.realpathSync.native(cursor);
    const resolvedRelative = path.relative(fs.realpathSync.native(root), resolved);
    if (resolvedRelative === '..'
        || resolvedRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(resolvedRelative)) {
      throw new Error(`acceptance shadow path resolves outside run directory: ${cursor}`);
    }
  }
  return target;
}

function writeJson(file, value, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (redactSensitiveText(serialized) !== serialized) {
    throw new Error(`acceptance artifact contains sensitive content: ${file}`);
  }
  if (options.flag === 'wx') {
    fs.writeFileSync(file, serialized, options);
    return;
  }
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, serialized, { flag: 'wx' });
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeShadowError(file, error) {
  const artifact = {
    schemaVersion: 'acceptance-shadow-error-v1',
    status: 'error',
    message: redactSensitiveText(error && error.message ? error.message : String(error)),
  };
  writeJson(file, artifact);
}

function receiptAuthorityDirectory(runDir, options) {
  if (!options) return null;
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  const directory = path.join(controlDir, 'acceptance-receipts');
  controlStore.assertAuthoritativeControlPath(runDir, directory, options);
  return directory;
}

function receiptAuthoritySequence(record) {
  const sequence = record.evaluationSequence === undefined ? 1 : record.evaluationSequence;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('acceptance Receipt authority evaluationSequence is invalid');
  }
  const predecessor = record.predecessorReceiptHash === undefined
    ? null
    : record.predecessorReceiptHash;
  if (predecessor !== null) validateHash(
    predecessor,
    'acceptance Receipt authority predecessorReceiptHash'
  );
  if ((sequence === 1) !== (predecessor === null)) {
    throw new Error('acceptance Receipt authority predecessor/sequence binding is invalid');
  }
  return { sequence, predecessor };
}

function readReceiptAuthorityHead(runDir, options, contractHash, subjectHash) {
  const directory = receiptAuthorityDirectory(runDir, options);
  if (!directory || !fs.existsSync(directory)) return null;
  const records = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
    .map((entry) => controlStore.readAuthoritativeJson(
      runDir,
      path.join(directory, entry.name),
      options
    ))
    .filter((record) => record.contractHash === contractHash && record.subjectHash === subjectHash)
    .map((record) => {
      if (!isPlainObject(record)
          || record.schemaVersion !== 'acceptance-receipt-authority-v1') {
        throw new Error('acceptance Receipt authority record is invalid');
      }
      validateHash(record.receiptHash, 'acceptance Receipt authority receiptHash');
      requiredString(record.receiptRef, 'acceptance Receipt authority receiptRef');
      requiredString(record.subjectRef, 'acceptance Receipt authority subjectRef');
      return { record, ...receiptAuthoritySequence(record) };
    })
    .sort((left, right) => left.sequence - right.sequence);
  if (records.length === 0) return null;
  records.forEach((entry, index) => {
    if (entry.sequence !== index + 1
        || (index === 0 && entry.predecessor !== null)
        || (index > 0 && entry.predecessor !== records[index - 1].record.receiptHash)) {
      throw new Error('acceptance Receipt authority successor chain is invalid');
    }
  });
  return records[records.length - 1].record;
}

function assertUserConfirmationSuccessor(contract, previous, next) {
  acceptance.assertAcceptanceReceipt(previous, { contract });
  acceptance.assertAcceptanceReceipt(next, { contract });
  if (previous.contractHash !== next.contractHash
      || previous.subjectRef !== next.subjectRef
      || previous.subjectHash !== next.subjectHash
      || previous.results.length !== next.results.length) {
    throw new Error('acceptance Receipt successor identity is invalid');
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
    const confirmationRef = after.evidenceRefs.find((ref) => (
      ref.kind === 'user-confirmation' && ref.assurance === 'verified'
    ));
    const beforeClaims = before.evidenceRefs.filter((ref) => ref.assurance === 'claimed');
    const afterClaims = after.evidenceRefs.filter((ref) => ref.assurance === 'claimed');
    const afterVerified = after.evidenceRefs.filter((ref) => ref.assurance === 'verified');
    if (criterion.oracle.type !== 'user-confirmation'
        || before.status !== 'unknown'
        || !['passed', 'failed'].includes(after.status)
        || before.evaluatorRef !== after.evaluatorRef
        || stableHash(beforeClaims) !== stableHash(afterClaims)
        || afterVerified.length !== 1
        || afterVerified[0] !== confirmationRef) {
      throw new Error('acceptance Receipt successor is not a monotonic user confirmation');
    }
  }
  if (changed === 0) return false;
  return true;
}

function recordReceiptAuthority(runDir, options, record) {
  if (!options) return null;
  const controlDir = controlStore.ensureControlRunDir(runDir, options);
  const directory = receiptAuthorityDirectory(runDir, options);
  fs.mkdirSync(directory, { recursive: true });
  controlStore.assertAuthoritativeControlPath(runDir, directory, options);
  if (record.validationSealHash) {
    const bindingsDir = path.join(controlDir, 'acceptance-validation-bindings');
    controlStore.assertAuthoritativeControlPath(runDir, bindingsDir, options);
    fs.mkdirSync(bindingsDir, { recursive: true });
    controlStore.assertAuthoritativeControlPath(runDir, bindingsDir, options);
    const bindingFile = path.join(
      bindingsDir,
      `${record.validationSealHash.slice('sha256:'.length)}.json`
    );
    controlStore.assertAuthoritativeControlPath(runDir, bindingFile, options);
    const binding = {
      schemaVersion: 'acceptance-validation-binding-v1',
      validationSealHash: record.validationSealHash,
      contractHash: record.contractHash,
      subjectRef: record.subjectRef,
      subjectHash: record.subjectHash,
    };
    const serializedBinding = `${JSON.stringify(binding, null, 2)}\n`;
    try {
      fs.writeFileSync(bindingFile, serializedBinding, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (fs.readFileSync(bindingFile, 'utf8') !== serializedBinding) {
        throw new Error('validation seal is already bound to a different acceptance subject');
      }
    }
  }
  const file = path.join(directory, `${record.receiptHash.slice('sha256:'.length)}.json`);
  controlStore.assertAuthoritativeControlPath(runDir, file, options);
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  try {
    fs.writeFileSync(file, serialized, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fs.readFileSync(file, 'utf8') !== serialized) {
      throw new Error('authoritative acceptance Receipt record conflicts with existing record');
    }
  }
  controlStore.assertAuthoritativeControlPath(runDir, file, options);
  const binding = controlStore.readControlRunBinding(runDir, options);
  const postgresRecord = {
    authorityScope: stableHash({
      schemaVersion: 'acceptance-postgres-run-scope-v1',
      runIdentity: binding.runIdentity,
      runLocator: binding.runLocator,
    }),
    recordKind: 'acceptance-receipt',
    recordKey: record.receiptHash,
    contractHash: record.contractHash,
    subjectHash: record.subjectHash,
    payload: record,
  };
  const normalizedPostgresRecord = require('../lib/acceptance-postgres-authority')
    .normalizeAuthorityRecord(postgresRecord);
  const postgres = appendPostgresAuthorityRecordSync(normalizedPostgresRecord, options);
  return {
    ...record,
    ...(postgres ? { postgresRecordHash: postgres.recordHash } : {}),
  };
}

function recordShadowAcceptance(input = {}) {
  const runDir = path.resolve(input.runDir || '');
  const relativeDir = input.relativeDir || '.';
  if (input.workdir) {
    try {
      assertRunWithinWorkdir(input.workdir, runDir, input.controlStoreOptions);
    } catch (error) {
      return { status: 'error', error: redactSensitiveText(error.message) };
    }
  }
  let errorFile = null;
  let projectionFile = null;
  try {
    const contractFile = resolveRunRelative(runDir, '.', 'acceptance-contract.json');
    if (!fs.existsSync(contractFile)) return { status: 'absent' };
    projectionFile = resolveRunRelative(runDir, relativeDir, 'acceptance-shadow.json');
    errorFile = resolveRunRelative(runDir, relativeDir, 'acceptance-shadow.error.json');
    writeJson(projectionFile, {
      schemaVersion: 'acceptance-shadow-projection-v1',
      mode: 'shadow',
      status: 'pending',
    });
    const contract = acceptance.assertAcceptanceContract(
      JSON.parse(fs.readFileSync(contractFile, 'utf8'))
    );
    if (input.controlStoreOptions) {
      const tombstoneFile = path.join(
        controlStore.controlRunDir(runDir, input.controlStoreOptions),
        'acceptance-cohort-tombstone.json'
      );
      if (fs.existsSync(tombstoneFile)) {
        assertAcceptanceCohortTombstone(
          controlStore.readAuthoritativeJson(runDir, tombstoneFile, input.controlStoreOptions),
          {
            runLocator: controlStore.stableRunLocator(runDir),
            contractHash: contract.contractHash,
          }
        );
        throw new Error('acceptance cohort tombstone prevents Receipt creation');
      }
    }
    const assessmentFile = resolveRunRelative(
      runDir,
      relativeDir,
      'acceptance-assessments.json'
    );
    const assessments = fs.existsSync(assessmentFile)
      ? JSON.parse(fs.readFileSync(assessmentFile, 'utf8'))
      : [];
    const artifactCriteriaPresent = contract.criteria.some(
      (criterion) => criterion.oracle.type === 'artifact'
    );
    const observedEffectRefs = artifactCriteriaPresent
      ? artifactEffectRefs(runDir, relativeDir)
      : [];
    const effectScopeBound = isPlainObject(input.subject)
      && isPlainObject(input.subject.evidence)
      && input.subject.evidence.artifactEffectRefsHash === stableHash(observedEffectRefs)
      && input.subject.evidence.artifactReviewStable === true;
    const effectRefs = effectScopeBound ? observedEffectRefs : [];
    const receiptSubject = input.subject;
    const subjectHash = stableHash(receiptSubject);
    const evidenceMaps = [];
    if (input.validationSeal) {
      evidenceMaps.push(resolveSealedRuntimeEvidence(contract, input.validationSeal));
    } else if (input.workdir) {
      evidenceMaps.push(resolveRuntimeEvidence({
        workdir: input.workdir,
        runDir,
        relativeDir,
        contract,
        subjectHash,
      }));
    }
    if (Object.prototype.hasOwnProperty.call(input, 'artifactSeal')) {
      throw new Error('artifactSeal is runtime-owned and cannot be injected');
    }
    let artifactSeal = null;
    if (input.workdir && input.controlStoreOptions
        && contract.criteria.some((criterion) => criterion.oracle.type === 'artifact')) {
      artifactSeal = sealArtifactEvidence({
        workdir: input.workdir,
        runDir,
        relativeDir,
        contract,
        subjectHash,
        effectRefs,
        controlStoreOptions: input.controlStoreOptions,
      });
    }
    if (artifactSeal) {
      evidenceMaps.push(resolveSealedArtifactEvidence(contract, artifactSeal, subjectHash));
    }
    if (Object.prototype.hasOwnProperty.call(input, 'readbackSeal')) {
      throw new Error('readbackSeal is runtime-owned and cannot be injected');
    }
    const readbackSeal = input.workdir && input.controlStoreOptions
      ? sealReadbackEvidence({
        workdir: input.workdir,
        runDir,
        contract,
        subjectHash,
        controlStoreOptions: input.controlStoreOptions,
      })
      : null;
    if (readbackSeal) {
      evidenceMaps.push(resolveSealedReadbackEvidence(contract, readbackSeal, subjectHash));
    }
    if (Object.prototype.hasOwnProperty.call(input, 'independentReviewSeal')) {
      throw new Error('independentReviewSeal is runtime-owned and cannot be injected');
    }
    const independentReviewSeal = input.workdir && input.controlStoreOptions
      ? sealIndependentReviewEvidence({
        workdir: input.workdir,
        runDir,
        contract,
        subjectHash,
        controlStoreOptions: input.controlStoreOptions,
      })
      : null;
    if (independentReviewSeal) {
      evidenceMaps.push(resolveSealedIndependentReviewEvidence(
        contract,
        independentReviewSeal,
        subjectHash
      ));
    }
    if (Object.prototype.hasOwnProperty.call(input, 'userConfirmationSeal')) {
      throw new Error('userConfirmationSeal is runtime-owned and cannot be injected');
    }
    const userConfirmationSeal = input.workdir && input.controlStoreOptions
      ? sealUserConfirmationEvidence({
        workdir: input.workdir,
        runDir,
        contract,
        subjectHash,
        controlStoreOptions: input.controlStoreOptions,
      })
      : null;
    if (userConfirmationSeal) {
      evidenceMaps.push(resolveSealedUserConfirmationEvidence(
        contract,
        userConfirmationSeal,
        subjectHash
      ));
    }
    const runtimeEvidence = mergeRuntimeEvidence(contract, evidenceMaps);
    const evidenceIndex = {
      schemaVersion: 'acceptance-evidence-index-v1',
      contractHash: contract.contractHash,
      subjectHash,
      entries: contract.criteria.map((criterion) => {
        const evidence = runtimeEvidence.get(criterion.id) || { verdict: 'unknown', ref: null };
        return {
          criterionId: criterion.id,
          oracleHash: acceptance.oracleHash(criterion.oracle),
          verdict: evidence.verdict,
          evidenceRef: evidence.ref || null,
        };
      }),
    };
    const receipt = evaluateAcceptance({
      contract,
      subjectRef: input.subjectRef,
      subject: receiptSubject,
      assessments,
      runtimeEvidence,
      [INTERNAL_RUNTIME_EVIDENCE]: true,
    });
    const initialReceiptFile = resolveRunRelative(
      runDir,
      relativeDir,
      path.join(
        'acceptance-receipts',
        `contract-${receipt.contractHash.slice('sha256:'.length)}`,
        `subject-${receipt.subjectHash.slice('sha256:'.length)}.json`
      )
    );
    const priorAuthority = readReceiptAuthorityHead(
      runDir,
      input.controlStoreOptions,
      contract.contractHash,
      receipt.subjectHash
    );
    let receiptFile = initialReceiptFile;
    let evaluationSequence = 1;
    let predecessorReceiptHash = null;
    let authorityReplay = false;
    if (priorAuthority) {
      const priorReceiptFile = resolveRunRelative(runDir, '.', priorAuthority.receiptRef);
      const priorReceipt = JSON.parse(fs.readFileSync(priorReceiptFile, 'utf8'));
      acceptance.assertAcceptanceReceipt(priorReceipt, { contract, subject: input.subject });
      const priorSequence = receiptAuthoritySequence(priorAuthority);
      if (priorReceipt.receiptHash === receipt.receiptHash) {
        receiptFile = priorReceiptFile;
        evaluationSequence = priorSequence.sequence;
        predecessorReceiptHash = priorSequence.predecessor;
        authorityReplay = true;
      } else {
        assertUserConfirmationSuccessor(contract, priorReceipt, receipt);
        evaluationSequence = priorSequence.sequence + 1;
        predecessorReceiptHash = priorReceipt.receiptHash;
        receiptFile = resolveRunRelative(
          runDir,
          relativeDir,
          path.join(
            'acceptance-receipts',
            `contract-${receipt.contractHash.slice('sha256:'.length)}`,
            `subject-${receipt.subjectHash.slice('sha256:'.length)}`,
            `receipt-${receipt.receiptHash.slice('sha256:'.length)}.json`
          )
        );
      }
    }
    if (fs.existsSync(receiptFile)) {
      const existing = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      acceptance.assertAcceptanceReceipt(existing, { contract, subject: input.subject });
      if (existing.receiptHash !== receipt.receiptHash) {
        throw new Error('immutable acceptance Receipt conflicts with existing receipt');
      }
    } else {
      writeJson(receiptFile, receipt, { flag: 'wx' });
    }
    const projection = input.createProjection({
      contract,
      receipt,
      contractRef: 'acceptance-contract.json',
      receiptRef: path.relative(runDir, receiptFile).replace(/\\/g, '/'),
    });
    const authorityRecord = {
      schemaVersion: 'acceptance-receipt-authority-v1',
      contractHash: contract.contractHash,
      subjectRef: receipt.subjectRef,
      subjectHash: receipt.subjectHash,
      receiptHash: receipt.receiptHash,
      receiptRef: path.relative(runDir, receiptFile).replace(/\\/g, '/'),
      scopeRef: relativeDir.replace(/\\/g, '/'),
      evidenceIndexHash: stableHash(evidenceIndex),
      validationSealHash: input.validationSeal ? input.validationSeal.sealHash : null,
      artifactSealHash: artifactSeal ? artifactSeal.sealHash : null,
      readbackSealHash: readbackSeal ? readbackSeal.sealHash : null,
      independentReviewSealHash: independentReviewSeal ? independentReviewSeal.sealHash : null,
      userConfirmationSealHash: userConfirmationSeal ? userConfirmationSeal.sealHash : null,
      evaluationSequence,
      predecessorReceiptHash,
    };
    const authority = recordReceiptAuthority(
      runDir,
      input.controlStoreOptions,
      authorityReplay ? priorAuthority : authorityRecord
    );
    writeJson(resolveRunRelative(
      runDir,
      relativeDir,
      'acceptance-evidence-index.json'
    ), evidenceIndex);
    writeJson(projectionFile, projection);
    if (fs.existsSync(errorFile)) fs.unlinkSync(errorFile);
    return { status: 'written', receipt, projection, authority };
  } catch (error) {
    try {
      if (errorFile) writeShadowError(errorFile, error);
      if (projectionFile) {
        writeJson(projectionFile, {
          schemaVersion: 'acceptance-shadow-projection-v1',
          mode: 'shadow',
          status: 'error',
        });
      }
    } catch (_writeError) {
      // Shadow diagnostics are best-effort and must never affect authoritative state.
    }
    return { status: 'error', error: redactSensitiveText(error.message) };
  }
}

module.exports = {
  EVALUATOR_REF,
  ORACLE_EVIDENCE_KIND,
  createAcceptanceContractFromCriteria,
  evaluateAcceptance,
  assertAcceptanceCohortTombstone,
  recordAcceptanceContract,
  recordAcceptanceCohortTombstone,
  recordShadowAcceptance,
  artifactEffectRefs,
  resolveRuntimeEvidence,
  resolveSealedArtifactEvidence,
  resolveSealedIndependentReviewEvidence,
  resolveSealedReadbackEvidence,
  resolveSealedUserConfirmationEvidence,
  sealArtifactEvidence,
  sealIndependentReviewEvidence,
  sealReadbackEvidence,
  sealUserConfirmationEvidence,
  sealClassicValidationEvidence,
  sealValidationEvidence,
  writeAcceptanceContractForGlobalContract,
  createAcceptanceContractForGlobalContract,
  expectedSampleMarkerFile,
  writeAcceptanceContractForSpec,
};
