'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactSensitiveText } = require('./redaction');
const {
  assertCandidateNotExpiredAt,
  inspectCandidateStore,
} = require('./learning-candidates');
const { resolveStoreDir } = require('./self-learning-store');
const {
  atomicStageNoClobber,
  secureReadFile,
} = require('./self-learning-evaluation-artifacts');
const {
  assertExactKeys,
  canonicalStringify,
  isPlainObject,
  normalizeTimestamp,
  redactCanonicalValue,
  stableHash,
  validateHash,
} = require('./self-learning-canonical');

const EVAL_RESULTS_SCHEMA_VERSION = '3.0';
const LEGACY_HASH_BOUND_SCHEMA_VERSION = '2.0';
const LEGACY_EVAL_RESULTS_SCHEMA_VERSION = '1.0';
const EVALS_DIR_NAME = 'skill-evals';
const RESULTS_DIR_NAME = 'results';
const RESULTS_FILE_NAME = 'results.jsonl';
const CANDIDATES_DIR_NAME = 'candidates';
const ARTIFACT_FILE_NAME = 'artifact.md';
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const V3_FIELDS = Object.freeze([
  'schema_version',
  'timestamp',
  'name',
  'version',
  'pass_rate',
  'skill_hash',
  'candidate_id',
  'candidate_hash',
  'target',
  'scope',
  'baseline_hash',
  'case_set_hash',
  'evaluator_ref',
  'evaluator_hash',
  'evaluation_id',
  'evaluation_hash',
  'approval_receipt_id',
  'approval_receipt_hash',
  'cases',
  'source',
  'result_hash',
]);
const V2_FIELDS = Object.freeze([
  'schema_version',
  'timestamp',
  'name',
  'version',
  'pass_rate',
  'skill_hash',
  'candidate_hash',
  'baseline_hash',
  'case_set_hash',
  'evaluator_ref',
  'evaluator_hash',
  'cases',
  'source',
  'result_hash',
]);
const V1_REQUIRED_FIELDS = Object.freeze([
  'schema_version',
  'timestamp',
  'name',
  'version',
  'pass_rate',
  'source',
]);
const CASE_SUMMARY_FIELDS = Object.freeze([
  'case_results_hash',
  'case_count',
  'passed_count',
]);
const TARGET_FIELDS = Object.freeze(['key', 'source_path', 'source_hash']);
const SCOPE_FIELDS = Object.freeze(['level', 'id']);

function fail(message, code = 'SKILL_EVAL_RESULTS_INVALID') {
  const error = new Error(`skill-eval-results: ${message}`);
  error.code = code;
  throw error;
}

function assertValidName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    fail(`invalid skill name "${name}" (need ${SKILL_NAME_RE})`);
  }
}

function resolveResultsFile(name, baseDir) {
  assertValidName(name);
  if (typeof baseDir !== 'string' || !baseDir.trim()) fail('baseDir required');
  return path.join(baseDir, EVALS_DIR_NAME, name, RESULTS_DIR_NAME, RESULTS_FILE_NAME);
}

function sameResolvedPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function resolveCandidateArtifactFile(name, candidateId, baseDir) {
  assertValidName(name);
  const normalizedCandidateId = normalizeBoundId(
    candidateId,
    'candidateId',
    /^lc-[a-f0-9]{32}$/
  );
  if (typeof baseDir !== 'string' || !baseDir.trim()) fail('baseDir required');
  return path.join(
    path.resolve(baseDir),
    EVALS_DIR_NAME,
    name,
    CANDIDATES_DIR_NAME,
    normalizedCandidateId,
    ARTIFACT_FILE_NAME
  );
}

function artifactContentHash(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (buffer.length > MAX_ARTIFACT_BYTES) {
    fail(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) fail('artifact must be valid UTF-8 text');
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.includes('\u0000')) fail('artifact must be plain UTF-8 text without NUL bytes');
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex')}`;
}

function normalizeArtifactContent(value) {
  if (typeof value !== 'string') fail('artifact content must be a UTF-8 string');
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.toString('utf8') !== value) fail('artifact content must be valid UTF-8 text');
  const normalized = value.replace(/\r\n?/g, '\n');
  const buffer = Buffer.from(normalized, 'utf8');
  artifactContentHash(buffer);
  return { text: normalized, buffer, hash: artifactContentHash(buffer) };
}

function normalizeTarget(value, expectedName) {
  try {
    assertExactKeys(value, TARGET_FIELDS, 'target');
  } catch (error) {
    fail(error.message);
  }
  const match = /^(skill|command):([a-z][a-z0-9-]{0,63})$/.exec(value.key);
  if (!match) fail('target.key must be an exact skill:<name> or command:<name> key');
  if (expectedName !== undefined && match[2] !== expectedName) {
    fail(`target.key is not bound to "${expectedName}"`);
  }
  if (typeof value.source_path !== 'string'
      || !value.source_path
      || value.source_path.includes('\\')
      || value.source_path.includes('\u0000')
      || path.posix.isAbsolute(value.source_path)
      || /^[a-zA-Z]:/.test(value.source_path)
      || path.posix.normalize(value.source_path) !== value.source_path
      || value.source_path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('target.source_path must be a canonical repo-relative POSIX path');
  }
  const allowedPaths = match[1] === 'command'
    ? new Set([`user-level/commands/${match[2]}.md`])
    : new Set([
      `codex-native/skills/${match[2]}/SKILL.md`,
      `user-level/skills/${match[2]}/SKILL.md`,
    ]);
  if (!allowedPaths.has(value.source_path)) {
    fail(`target.source_path is not in the exact ${match[1]} source allowlist`);
  }
  return {
    key: value.key,
    source_path: value.source_path,
    source_hash: normalizeHash(value.source_hash, 'target.source_hash'),
  };
}

function normalizeProjectScope(value, expectedProjectId) {
  try {
    assertExactKeys(value, SCOPE_FIELDS, 'scope');
  } catch (error) {
    fail(error.message);
  }
  if (value.level !== 'project') {
    fail('repo skill/command publishing requires project scope');
  }
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256) {
    fail('scope.id must be a nonempty project identity <=256 characters');
  }
  if (expectedProjectId !== undefined && value.id !== expectedProjectId) {
    fail('project scope.id does not match the authoritative project_id');
  }
  return { level: 'project', id: value.id };
}

function operationTimestamp(options = {}, label = 'operation') {
  if (Object.prototype.hasOwnProperty.call(options, 'now')) {
    fail(`${label} does not accept caller-supplied now; use the server clock`);
  }
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    fail(`${label} internal clock must be a function`);
  }
  const sampled = options.clock === undefined ? new Date() : options.clock();
  const date = sampled instanceof Date ? new Date(sampled.getTime()) : new Date(sampled);
  if (Number.isNaN(date.getTime())) fail(`${label} server clock returned an invalid date-time`);
  return date.toISOString();
}

function configuredRetentionDays(baseDir) {
  if (typeof baseDir !== 'string' || !baseDir.trim()) fail('baseDir required');
  // Lazy loading avoids coupling module initialization to the service entry point.
  const { loadSelfLearningPolicy } = require('./self-learning-service');
  const days = loadSelfLearningPolicy(path.resolve(baseDir)).retention_days;
  if (!Number.isInteger(days) || days < 1) fail('retention_days must be an integer >= 1');
  return days;
}

function readCandidateArtifactContent(name, candidateId, baseDir) {
  const file = resolveCandidateArtifactFile(name, candidateId, baseDir);
  let readback;
  try {
    readback = secureReadFile(file, {
      label: 'canonical candidate artifact',
      maxBytes: MAX_ARTIFACT_BYTES,
      requireNonEmpty: true,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') fail(`canonical candidate artifact is missing: ${file}`);
    throw error;
  }
  return {
    artifact: {
      file,
      hash: artifactContentHash(readback.buffer),
      bytes: readback.bytes,
    },
    buffer: readback.buffer,
  };
}

function readCandidateArtifact(name, candidateId, baseDir) {
  return readCandidateArtifactContent(name, candidateId, baseDir).artifact;
}

function findActiveCandidate(name, candidateId, baseDir, projectId, options = {}) {
  if (typeof projectId !== 'string' || !projectId.trim()) fail('projectId required');
  const projection = inspectCandidateStore(resolveStoreDir(baseDir, projectId));
  const candidate = projection.candidates.find((item) => item.candidate_id === candidateId);
  if (!candidate) {
    const tombstone = projection.tombstoned.find((item) => item.entity_id === candidateId);
    fail(`candidate ${candidateId} is ${tombstone ? 'tombstoned' : 'missing'} in the authoritative journal`);
  }
  if (candidate.project_id !== projectId) fail('candidate project_id does not match authority context');
  normalizeTarget(candidate.target, name);
  if (options.requirePromoted === true
      && (candidate.status !== 'promoted' || candidate.effective_status !== 'promoted')) {
    fail(`candidate is not currently promoted (status=${candidate.status}, effective=${candidate.effective_status})`);
  }
  return { candidate, projection };
}

function stageCandidateArtifact(name, candidateId, content, options = {}) {
  assertValidName(name);
  const baseDir = options.baseDir;
  const projectId = options.projectId;
  const normalizedId = normalizeBoundId(candidateId, 'candidateId', /^lc-[a-f0-9]{32}$/);
  const staged = normalizeArtifactContent(content);
  const before = findActiveCandidate(name, normalizedId, baseDir, projectId);
  const artifactFile = resolveCandidateArtifactFile(name, normalizedId, baseDir);
  if (options.artifactPath !== undefined
      && !sameResolvedPath(options.artifactPath, artifactFile)) {
    fail('artifactPath must resolve to the exact canonical current-candidate artifact path');
  }

  const existingArtifact = secureReadFile(artifactFile, {
    allowMissing: true,
    label: 'canonical candidate artifact',
    maxBytes: MAX_ARTIFACT_BYTES,
    requireNonEmpty: true,
  });
  if (!existingArtifact && before.candidate.status !== 'proposed') {
    fail('a new canonical artifact may only be staged for the current proposed revision');
  }

  const stagedFile = atomicStageNoClobber(artifactFile, staged.buffer, {
    label: 'canonical candidate artifact',
    maxBytes: MAX_ARTIFACT_BYTES,
    requireNonEmpty: true,
  });
  const readback = readCandidateArtifact(name, normalizedId, baseDir);
  if (readback.hash !== staged.hash || !stagedFile.readback.buffer.equals(staged.buffer)) {
    fail(stagedFile.changed
      ? 'artifact readback mismatch after atomic staging'
      : 'canonical artifact already exists with different content; overwrite is prohibited');
  }

  const after = findActiveCandidate(name, normalizedId, baseDir, projectId);
  if (after.projection.journal_revision !== before.projection.journal_revision
      || after.projection.journal_head_hash !== before.projection.journal_head_hash
      || after.candidate.candidate_hash !== before.candidate.candidate_hash
      || after.candidate.revision !== before.candidate.revision) {
    fail('candidate authority changed while staging artifact; no authority binding was issued');
  }
  return {
    changed: stagedFile.changed,
    artifact: readback,
    candidate_id: normalizedId,
    candidate_hash: after.candidate.candidate_hash,
    candidate_revision: after.candidate.revision,
    journal_revision: after.projection.journal_revision,
    journal_head_hash: after.projection.journal_head_hash,
  };
}

function verifyStagedArtifactForEvaluation(candidateId, subjectArtifactHash, options = {}) {
  const normalizedId = normalizeBoundId(candidateId, 'candidateId', /^lc-[a-f0-9]{32}$/);
  const projectId = options.projectId;
  const baseDir = options.baseDir;
  const projection = inspectCandidateStore(resolveStoreDir(baseDir, projectId));
  const candidate = projection.candidates.find((item) => item.candidate_id === normalizedId);
  if (!candidate) fail(`candidate ${normalizedId} is missing from the authoritative journal`);
  if (candidate.project_id !== projectId) fail('candidate project_id does not match authority context');
  let target;
  try {
    target = normalizeTarget(candidate.target);
  } catch {
    return { required: false };
  }
  const match = /^(skill|command):([a-z][a-z0-9-]{0,63})$/.exec(target.key);
  const expectedHash = normalizeHash(subjectArtifactHash, 'subject_artifact_hash');
  const artifact = readCandidateArtifact(match[2], normalizedId, baseDir);
  if (artifact.hash !== expectedHash) {
    fail('evaluation subject_artifact_hash does not match the staged canonical artifact');
  }
  return {
    required: true,
    name: match[2],
    candidate_id: normalizedId,
    candidate_hash: candidate.candidate_hash,
    candidate_revision: candidate.revision,
    artifact,
  };
}

function normalizeVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version <= 0) {
    fail(`version must be a positive integer, got "${value}"`);
  }
  return version;
}

function normalizePassRate(value) {
  const passRate = Number(value);
  if (!Number.isFinite(passRate) || passRate < 0 || passRate > 1) {
    fail(`passRate must be a number in [0,1], got "${value}"`);
  }
  return passRate;
}

function normalizeHash(value, field, options = {}) {
  try {
    return validateHash(value, field, options);
  } catch (error) {
    fail(error.message);
  }
}

function normalizeBoundId(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${field} has invalid authoritative identity`);
  }
  return value;
}

function normalizeEvaluatorRef(value) {
  if (typeof value !== 'string' || !value.trim()) fail('evaluatorRef must be a non-empty string');
  if (value.length > 1024) fail('evaluatorRef exceeds 1024 characters');
  return redactSensitiveText(value.trim());
}

function normalizeSource(value) {
  const source = value === undefined ? 'skill-eval' : value;
  if (typeof source !== 'string' || !source.trim()) fail('source must be a non-empty string');
  if (source.length > 1024) fail('source exceeds 1024 characters');
  return redactSensitiveText(source.trim());
}

function normalizeCases(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) && !isPlainObject(value)) {
    fail('cases must be an object, array, or null');
  }
  try {
    return redactCanonicalValue(value, 'cases');
  } catch (error) {
    fail(`invalid cases: ${error.message}`);
  }
}

function normalizeNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) fail(`${field} must be a non-negative integer`);
  return value;
}

function normalizeCaseSummary(value) {
  if (!isPlainObject(value)) fail('cases must be an authoritative case summary object');
  try {
    assertExactKeys(value, CASE_SUMMARY_FIELDS, 'eval result cases');
  } catch (error) {
    fail(error.message);
  }
  const summary = {
    case_results_hash: normalizeHash(value.case_results_hash, 'cases.case_results_hash'),
    case_count: normalizeNonNegativeInteger(value.case_count, 'cases.case_count'),
    passed_count: normalizeNonNegativeInteger(value.passed_count, 'cases.passed_count'),
  };
  if (summary.passed_count > summary.case_count) {
    fail('cases.passed_count must not exceed cases.case_count');
  }
  return summary;
}

function caseSummaryFromEvaluation(evaluation) {
  return normalizeCaseSummary({
    case_results_hash: evaluation.case_results_hash,
    case_count: evaluation.case_count,
    passed_count: evaluation.passed_count,
  });
}

function normalizeTimestampForWrite(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`timestamp must be a valid date-time, got "${value}"`);
  return date.toISOString();
}

function resultHash(record) {
  const core = { ...record };
  delete core.result_hash;
  return stableHash(core);
}

function validateV3Record(record, expectedName) {
  try {
    assertExactKeys(record, V3_FIELDS, 'eval result');
  } catch (error) {
    fail(error.message);
  }
  if (record.schema_version !== EVAL_RESULTS_SCHEMA_VERSION) {
    fail(`unknown schema_version "${record.schema_version}"`, 'SKILL_EVAL_RESULTS_UNKNOWN_SCHEMA');
  }
  try {
    normalizeTimestamp(record.timestamp, 'timestamp');
  } catch (error) {
    fail(error.message);
  }
  assertValidName(record.name);
  if (record.name !== expectedName) {
    fail(`record name mismatch: expected "${expectedName}", got "${record.name}"`);
  }
  normalizeVersion(record.version);
  normalizePassRate(record.pass_rate);
  normalizeHash(record.skill_hash, 'skill_hash');
  normalizeBoundId(record.candidate_id, 'candidate_id', /^lc-[a-f0-9]{32}$/);
  normalizeHash(record.candidate_hash, 'candidate_hash');
  const target = normalizeTarget(record.target, expectedName);
  if (canonicalStringify(target) !== canonicalStringify(record.target)) {
    fail('target is not canonical');
  }
  const scope = normalizeProjectScope(record.scope);
  if (canonicalStringify(scope) !== canonicalStringify(record.scope)) {
    fail('scope is not canonical');
  }
  normalizeHash(record.baseline_hash, 'baseline_hash', { nullable: true });
  normalizeHash(record.case_set_hash, 'case_set_hash');
  normalizeEvaluatorRef(record.evaluator_ref);
  normalizeHash(record.evaluator_hash, 'evaluator_hash');
  normalizeBoundId(record.evaluation_id, 'evaluation_id', /^eval-[a-f0-9]{32}$/);
  normalizeHash(record.evaluation_hash, 'evaluation_hash');
  normalizeBoundId(
    record.approval_receipt_id,
    'approval_receipt_id',
    /^approval-[a-f0-9]{32}$/
  );
  normalizeHash(record.approval_receipt_hash, 'approval_receipt_hash');
  normalizeSource(record.source);
  normalizeHash(record.result_hash, 'result_hash');

  const caseSummary = normalizeCaseSummary(record.cases);
  if (canonicalStringify(caseSummary) !== canonicalStringify(record.cases)) {
    fail('cases are not canonical');
  }
  const derivedPassRate = caseSummary.case_count === 0
    ? 0
    : caseSummary.passed_count / caseSummary.case_count;
  if (record.pass_rate !== derivedPassRate) {
    fail('pass_rate must be derived from cases passed_count/case_count');
  }
  const computed = resultHash(record);
  if (computed !== record.result_hash) {
    fail(`result hash mismatch: expected ${record.result_hash}, computed ${computed}`);
  }
  return record;
}

function validateV2Record(record, expectedName) {
  try {
    assertExactKeys(record, V2_FIELDS, 'legacy v2 eval result');
  } catch (error) {
    fail(error.message);
  }
  if (record.schema_version !== LEGACY_HASH_BOUND_SCHEMA_VERSION) {
    fail(`unknown schema_version "${record.schema_version}"`, 'SKILL_EVAL_RESULTS_UNKNOWN_SCHEMA');
  }
  try {
    normalizeTimestamp(record.timestamp, 'timestamp');
  } catch (error) {
    fail(error.message);
  }
  assertValidName(record.name);
  if (record.name !== expectedName) {
    fail(`record name mismatch: expected "${expectedName}", got "${record.name}"`);
  }
  normalizeVersion(record.version);
  normalizePassRate(record.pass_rate);
  normalizeHash(record.skill_hash, 'skill_hash');
  normalizeHash(record.candidate_hash, 'candidate_hash');
  normalizeHash(record.baseline_hash, 'baseline_hash', { nullable: true });
  normalizeHash(record.case_set_hash, 'case_set_hash');
  normalizeEvaluatorRef(record.evaluator_ref);
  normalizeHash(record.evaluator_hash, 'evaluator_hash');
  normalizeSource(record.source);
  normalizeHash(record.result_hash, 'result_hash');
  const redactedCases = normalizeCases(record.cases);
  if (canonicalStringify(redactedCases) !== canonicalStringify(record.cases)) {
    fail('cases contain unredacted sensitive data');
  }
  const computed = resultHash(record);
  if (computed !== record.result_hash) {
    fail(`result hash mismatch: expected ${record.result_hash}, computed ${computed}`);
  }
  return record;
}

function validateV1Record(record, expectedName) {
  const allowed = new Set([...V1_REQUIRED_FIELDS, 'cases']);
  const actual = Object.keys(record);
  const missing = V1_REQUIRED_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(record, field));
  const unknown = actual.filter((field) => !allowed.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `legacy eval result fields invalid; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`
    );
  }
  try {
    normalizeTimestamp(record.timestamp, 'timestamp');
  } catch (error) {
    fail(error.message);
  }
  assertValidName(record.name);
  if (record.name !== expectedName) {
    fail(`record name mismatch: expected "${expectedName}", got "${record.name}"`);
  }
  normalizeVersion(record.version);
  normalizePassRate(record.pass_rate);
  normalizeSource(record.source);

  if (!Object.prototype.hasOwnProperty.call(record, 'cases')) return record;
  return { ...record, cases: normalizeCases(record.cases) };
}

function validateRecord(record, expectedName) {
  if (!isPlainObject(record)) fail('result line must contain a JSON object');
  if (record.schema_version === EVAL_RESULTS_SCHEMA_VERSION) {
    return validateV3Record(record, expectedName);
  }
  if (record.schema_version === LEGACY_HASH_BOUND_SCHEMA_VERSION) {
    return validateV2Record(record, expectedName);
  }
  if (record.schema_version === LEGACY_EVAL_RESULTS_SCHEMA_VERSION) {
    return validateV1Record(record, expectedName);
  }
  fail(
    `unknown schema_version "${record.schema_version}"`,
    'SKILL_EVAL_RESULTS_UNKNOWN_SCHEMA'
  );
}

function normalizeResult(input) {
  return {
    version: normalizeVersion(input.version),
    passRate: normalizePassRate(input.passRate),
    skillHash: normalizeHash(input.skillHash, 'skillHash'),
    candidateId: normalizeBoundId(input.candidateId, 'candidateId', /^lc-[a-f0-9]{32}$/),
    candidateHash: normalizeHash(input.candidateHash, 'candidateHash'),
    target: normalizeTarget(input.target),
    scope: normalizeProjectScope(input.scope),
    baselineHash: normalizeHash(input.baselineHash, 'baselineHash', { nullable: true }),
    caseSetHash: normalizeHash(input.caseSetHash, 'caseSetHash'),
    evaluatorRef: normalizeEvaluatorRef(input.evaluatorRef),
    evaluatorHash: normalizeHash(input.evaluatorHash, 'evaluatorHash'),
    evaluationId: normalizeBoundId(input.evaluationId, 'evaluationId', /^eval-[a-f0-9]{32}$/),
    evaluationHash: normalizeHash(input.evaluationHash, 'evaluationHash'),
    approvalReceiptId: normalizeBoundId(
      input.approvalReceiptId,
      'approvalReceiptId',
      /^approval-[a-f0-9]{32}$/
    ),
    approvalReceiptHash: normalizeHash(input.approvalReceiptHash, 'approvalReceiptHash'),
    cases: normalizeCaseSummary(input.cases),
    source: normalizeSource(input.source),
  };
}

function appendResultRecord(name, input = {}) {
  assertValidName(name);
  const baseDir = input.baseDir;
  const normalized = normalizeResult(input);
  const resultsFile = resolveResultsFile(name, baseDir);

  // A writer must not append behind a corrupt or unknown record.
  if (fs.existsSync(resultsFile)) readResults(name, { baseDir });

  const record = {
    schema_version: EVAL_RESULTS_SCHEMA_VERSION,
    timestamp: normalizeTimestampForWrite(input.timestamp),
    name,
    version: normalized.version,
    pass_rate: normalized.passRate,
    skill_hash: normalized.skillHash,
    candidate_id: normalized.candidateId,
    candidate_hash: normalized.candidateHash,
    target: normalized.target,
    scope: normalized.scope,
    baseline_hash: normalized.baselineHash,
    case_set_hash: normalized.caseSetHash,
    evaluator_ref: normalized.evaluatorRef,
    evaluator_hash: normalized.evaluatorHash,
    evaluation_id: normalized.evaluationId,
    evaluation_hash: normalized.evaluationHash,
    approval_receipt_id: normalized.approvalReceiptId,
    approval_receipt_hash: normalized.approvalReceiptHash,
    cases: normalized.cases,
    source: normalized.source,
  };
  record.result_hash = resultHash(record);
  validateV3Record(record, name);

  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
  fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
  return { record, resultsFile };
}

function deriveAuthoritativeResult(name, candidateId, input = {}) {
  assertValidName(name);
  const baseDir = input.baseDir;
  const projectId = input.projectId;
  const version = normalizeVersion(input.version);
  const normalizedId = normalizeBoundId(candidateId, 'candidateId', /^lc-[a-f0-9]{32}$/);
  const checkedAt = operationTimestamp(input, 'authoritative result recording');
  const retentionDays = configuredRetentionDays(baseDir);
  const { candidate, projection } = findActiveCandidate(
    name,
    normalizedId,
    baseDir,
    projectId,
    { requirePromoted: true }
  );
  const scope = normalizeProjectScope(candidate.scope, projectId);
  assertCandidateNotExpiredAt(candidate, checkedAt, 'authoritative result recording', retentionDays);
  const evaluation = candidate.evaluation;
  if (!evaluation || evaluation.decision !== 'pass'
      || !evaluation.eligibility || evaluation.eligibility.eligible !== true) {
    fail('promoted candidate does not carry a passing authoritative evaluation');
  }
  const passRate = normalizePassRate(evaluation.pass_rate);
  const cases = caseSummaryFromEvaluation(evaluation);
  const derivedPassRate = cases.case_count === 0 ? 0 : cases.passed_count / cases.case_count;
  if (passRate !== derivedPassRate) fail('evaluation pass_rate is not derived from case counts');
  if (evaluation.subject_artifact_hash == null) {
    fail('evaluation subject_artifact_hash is required for result recording');
  }
  const artifact = readCandidateArtifact(name, normalizedId, baseDir);
  if (artifact.hash !== evaluation.subject_artifact_hash) {
    fail('canonical artifact hash does not match evaluation subject_artifact_hash');
  }
  if (input.artifactPath !== undefined
      && !sameResolvedPath(input.artifactPath, artifact.file)) {
    fail('artifactPath must resolve to the exact canonical current-candidate artifact path');
  }
  const approval = candidate.approval;
  const promotion = candidate.promotion;
  if (!approval || !promotion
      || approval.receipt_id !== promotion.approval_receipt_id
      || approval.receipt_hash !== promotion.approval_receipt_hash) {
    fail('promoted candidate approval and promotion bindings are inconsistent');
  }
  const receipt = projection.receipts.find((item) => item.receipt_id === approval.receipt_id);
  if (!receipt || receipt.receipt_hash !== approval.receipt_hash
      || receipt.candidate_id !== candidate.candidate_id
      || receipt.evaluation_hash !== evaluation.evaluation_hash) {
    fail('active approval receipt is not bound to the promoted candidate evaluation');
  }
  const evaluatorRef = evaluation.assessor
    && (evaluation.assessor.authority_ref || evaluation.assessor.id);
  const target = normalizeTarget(candidate.target, name);
  return {
    authority: {
      candidate_hash: candidate.candidate_hash,
      candidate_revision: candidate.revision,
      journal_revision: projection.journal_revision,
      journal_head_hash: projection.journal_head_hash,
    },
    appendInput: {
      version,
      passRate,
      skillHash: artifact.hash,
      candidateId: candidate.candidate_id,
      candidateHash: candidate.candidate_hash,
      target,
      scope,
      baselineHash: evaluation.baseline_hash,
      caseSetHash: evaluation.case_set_hash,
      evaluatorRef,
      evaluatorHash: evaluation.evaluator_hash,
      evaluationId: evaluation.evaluation_id,
      evaluationHash: evaluation.evaluation_hash,
      approvalReceiptId: receipt.receipt_id,
      approvalReceiptHash: receipt.receipt_hash,
      cases,
      source: 'self-learning-authority',
      timestamp: checkedAt,
      baseDir,
    },
    artifact,
  };
}

function recordAuthoritativeResult(name, candidateId, input = {}) {
  const derived = deriveAuthoritativeResult(name, candidateId, input);
  const existing = readResults(name, { baseDir: input.baseDir });
  if (existing.some((record) => record.schema_version !== EVAL_RESULTS_SCHEMA_VERSION)) {
    fail('legacy v1/v2 result history cannot be extended or authorize publish');
  }
  const prospective = {
    schema_version: EVAL_RESULTS_SCHEMA_VERSION,
    timestamp: normalizeTimestampForWrite(derived.appendInput.timestamp),
    name,
    version: normalizeVersion(derived.appendInput.version),
    pass_rate: normalizePassRate(derived.appendInput.passRate),
    skill_hash: derived.appendInput.skillHash,
    candidate_id: derived.appendInput.candidateId,
    candidate_hash: derived.appendInput.candidateHash,
    target: derived.appendInput.target,
    scope: derived.appendInput.scope,
    baseline_hash: derived.appendInput.baselineHash,
    case_set_hash: derived.appendInput.caseSetHash,
    evaluator_ref: derived.appendInput.evaluatorRef,
    evaluator_hash: derived.appendInput.evaluatorHash,
    evaluation_id: derived.appendInput.evaluationId,
    evaluation_hash: derived.appendInput.evaluationHash,
    approval_receipt_id: derived.appendInput.approvalReceiptId,
    approval_receipt_hash: derived.appendInput.approvalReceiptHash,
    cases: derived.appendInput.cases,
    source: derived.appendInput.source,
  };
  prospective.result_hash = resultHash(prospective);
  validateV3Record(prospective, name);

  const candidateExisting = existing.find((record) => record.candidate_id === candidateId);
  if (candidateExisting) {
    const existingIdentity = { ...candidateExisting };
    const prospectiveIdentity = { ...prospective };
    delete existingIdentity.timestamp;
    delete existingIdentity.result_hash;
    delete prospectiveIdentity.timestamp;
    delete prospectiveIdentity.result_hash;
    if (canonicalStringify(existingIdentity) !== canonicalStringify(prospectiveIdentity)) {
      fail('candidate already has a different authoritative result record');
    }
    return {
      changed: false,
      record: candidateExisting,
      resultsFile: resolveResultsFile(name, input.baseDir),
      artifact: derived.artifact,
    };
  }
  if (existing.some((record) => record.version === prospective.version)) {
    fail(`version ${prospective.version} is already bound to another candidate`);
  }
  if (existing.length > 0 && prospective.version <= existing[existing.length - 1].version) {
    fail('version must increase relative to the latest authoritative result');
  }
  if (existing.length > 0) {
    const continuityMismatches = targetContinuityMismatches(
      existing[existing.length - 1],
      prospective
    );
    if (continuityMismatches.length > 0) {
      fail(`target/baseline authority is not continuous: ${continuityMismatches.join('; ')}`);
    }
  }

  const rechecked = findActiveCandidate(
    name,
    candidateId,
    input.baseDir,
    input.projectId,
    { requirePromoted: true }
  );
  if (rechecked.projection.journal_revision !== derived.authority.journal_revision
      || rechecked.projection.journal_head_hash !== derived.authority.journal_head_hash
      || rechecked.candidate.candidate_hash !== derived.authority.candidate_hash
      || rechecked.candidate.revision !== derived.authority.candidate_revision) {
    fail('candidate authority changed while preparing result append');
  }
  const written = appendResultRecord(name, derived.appendInput);
  const readback = readResults(name, { baseDir: input.baseDir });
  const latest = readback[readback.length - 1];
  if (!latest || latest.result_hash !== written.record.result_hash) {
    fail('authoritative result readback mismatch');
  }
  return { changed: true, ...written, artifact: derived.artifact };
}

function readResults(name, options = {}) {
  const resultsFile = resolveResultsFile(name, options.baseDir);
  if (!fs.existsSync(resultsFile)) return [];
  const raw = fs.readFileSync(resultsFile, 'utf8');
  const records = [];
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      fail(
        `malformed line ${index + 1} in ${resultsFile}: ${error.message}`,
        'SKILL_EVAL_RESULTS_CORRUPT'
      );
    }
    try {
      records.push(validateRecord(parsed, name));
    } catch (error) {
      error.message = `${error.message} (line ${index + 1} in ${resultsFile})`;
      throw error;
    }
  }
  return records;
}

function readLatestTwo(name, options = {}) {
  const records = readResults(name, options);
  return {
    prev: records.length >= 2 ? records[records.length - 2] : null,
    curr: records.length >= 1 ? records[records.length - 1] : null,
  };
}

function normalizeTolerance(value) {
  const tolerance = value === undefined ? 0 : Number(value);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
    fail(`tolerance must be a number in [0,1], got "${value}"`);
  }
  return tolerance;
}

function targetContinuityMismatches(prev, curr) {
  const mismatches = [];
  if (curr.baseline_hash !== prev.skill_hash) {
    mismatches.push('candidate baseline_hash does not match previous skill_hash');
  }
  if (curr.target.key !== prev.target.key) {
    mismatches.push('target key changed between baseline and candidate');
  }
  if (curr.target.source_path !== prev.target.source_path) {
    mismatches.push('target source_path changed between baseline and candidate');
  }
  if (canonicalStringify(curr.scope) !== canonicalStringify(prev.scope)) {
    mismatches.push('project scope changed between baseline and candidate');
  }
  if (curr.target.source_hash !== curr.baseline_hash) {
    mismatches.push('candidate target source_hash does not match baseline_hash');
  }
  return mismatches;
}

function comparisonMismatches(prev, curr) {
  const mismatches = [];
  if (curr.version <= prev.version) {
    mismatches.push(`version must increase (${prev.version} -> ${curr.version})`);
  }
  if (curr.candidate_id === prev.candidate_id) {
    mismatches.push('candidate_id must differ from baseline');
  }
  if (curr.evaluation_id === prev.evaluation_id) {
    mismatches.push('evaluation_id must differ from baseline');
  }
  if (curr.approval_receipt_id === prev.approval_receipt_id) {
    mismatches.push('approval_receipt_id must differ from baseline');
  }
  mismatches.push(...targetContinuityMismatches(prev, curr));
  if (curr.case_set_hash !== prev.case_set_hash) {
    mismatches.push('case_set_hash changed');
  }
  if (curr.evaluator_ref !== prev.evaluator_ref) {
    mismatches.push('evaluator_ref changed');
  }
  if (curr.evaluator_hash !== prev.evaluator_hash) {
    mismatches.push('evaluator_hash changed');
  }
  return mismatches;
}

function checkRegression(name, options = {}) {
  const tolerance = normalizeTolerance(options.tolerance);
  const records = readResults(name, options);
  const prev = records.length >= 2 ? records[records.length - 2] : null;
  const curr = records.length >= 1 ? records[records.length - 1] : null;
  if (!curr || !prev) {
    return {
      status: 'blocked',
      publish_authorized: false,
      reason_code: 'no-baseline',
      prev,
      curr,
      tolerance,
      reason: 'no-baseline：需要可比较的 baseline 与 candidate 两条完整记录',
    };
  }

  if (records.some((record) => record.schema_version !== EVAL_RESULTS_SCHEMA_VERSION)) {
    return {
      status: 'blocked',
      publish_authorized: false,
      reason_code: 'legacy-unbound',
      prev,
      curr,
      tolerance,
      reason: 'legacy v1/v2 result 缺少 authoritative lifecycle binding，不能授权 publish',
    };
  }

  const mismatches = comparisonMismatches(prev, curr);
  if (mismatches.length > 0) {
    return {
      status: 'blocked',
      publish_authorized: false,
      reason_code: 'identity-mismatch',
      prev,
      curr,
      tolerance,
      mismatches,
      reason: `eval identity 不可比较：${mismatches.join('; ')}`,
    };
  }

  const threshold = prev.pass_rate - tolerance;
  if (curr.pass_rate < threshold) {
    return {
      status: 'regression',
      publish_authorized: false,
      reason_code: 'pass-rate-regression',
      prev,
      curr,
      tolerance,
      reason: `新版通过率 ${(curr.pass_rate * 100).toFixed(1)}% < 旧版 ${(prev.pass_rate * 100).toFixed(1)}%`
        + (tolerance > 0 ? ` - 容差 ${(tolerance * 100).toFixed(1)}%` : ''),
    };
  }
  return {
    status: 'ok',
    publish_authorized: false,
    reason_code: 'comparable-non-regression',
    prev,
    curr,
    tolerance,
    reason: 'hash-bound eval 可比较且新版通过率未超容差退化',
  };
}

function blockedAuthority(reasonCode, reason, regression, extra = {}) {
  return {
    ...regression,
    status: 'blocked',
    publish_authorized: false,
    reason_code: reasonCode,
    reason,
    ...extra,
  };
}

function findTombstone(projection, entityId) {
  return projection.tombstoned.find((item) => item.entity_id === entityId) || null;
}

function validateAuthorityRecord(record, projection, label, regression, expected = {}) {
  const candidate = projection.candidates.find((item) => item.candidate_id === record.candidate_id);
  if (!candidate) {
    const tombstone = findTombstone(projection, record.candidate_id);
    return blockedAuthority(
      tombstone ? 'candidate-tombstoned' : 'candidate-missing',
      `${label} candidate ${record.candidate_id} is ${tombstone ? 'tombstoned' : 'missing'} in the authoritative journal`,
      regression,
      { authoritative_record: label, tombstone }
    );
  }

  const receiptTombstone = findTombstone(projection, record.approval_receipt_id);
  if (receiptTombstone) {
    return blockedAuthority(
      'approval-tombstoned',
      `${label} approval receipt ${record.approval_receipt_id} is tombstoned`,
      regression,
      { authoritative_record: label, tombstone: receiptTombstone }
    );
  }

  if (candidate.status !== 'promoted' || candidate.effective_status !== 'promoted') {
    return blockedAuthority(
      'candidate-not-promoted',
      `${label} candidate ${record.candidate_id} is not currently promoted (status=${candidate.status}, effective=${candidate.effective_status})`,
      regression,
      { authoritative_record: label }
    );
  }

  if (expected.checkedAt && expected.retentionDays) {
    try {
      assertCandidateNotExpiredAt(
        candidate,
        expected.checkedAt,
        `${label} publish guard`,
        expected.retentionDays
      );
    } catch (error) {
      return blockedAuthority(
        'candidate-expired',
        `${label} candidate is expired at publish guard time: ${error.message}`,
        regression,
        { authoritative_record: label, checked_at: expected.checkedAt }
      );
    }
  }

  const mismatches = [];
  if (expected.projectId && candidate.project_id !== expected.projectId) {
    mismatches.push('candidate project_id mismatch');
  }
  if (expected.name) {
    try {
      const target = normalizeTarget(candidate.target, expected.name);
      if (canonicalStringify(target) !== canonicalStringify(record.target)) {
        mismatches.push('candidate target does not exactly match the recorded target');
      }
    } catch (error) {
      mismatches.push(`candidate target is invalid: ${error.message}`);
    }
  }
  try {
    const candidateScope = normalizeProjectScope(candidate.scope, expected.projectId);
    const recordScope = normalizeProjectScope(record.scope, expected.projectId);
    if (canonicalStringify(candidateScope) !== canonicalStringify(recordScope)) {
      mismatches.push('candidate scope does not exactly match the recorded project scope');
    }
  } catch (error) {
    mismatches.push(`project scope is invalid: ${error.message}`);
  }
  if (candidate.candidate_hash !== record.candidate_hash) {
    mismatches.push('candidate_hash is not the current promoted candidate hash');
  }
  const evaluation = candidate.evaluation;
  if (!evaluation) {
    mismatches.push('current candidate has no evaluation');
  } else {
    if (evaluation.evaluation_id !== record.evaluation_id) mismatches.push('evaluation_id mismatch');
    if (evaluation.evaluation_hash !== record.evaluation_hash) mismatches.push('evaluation_hash mismatch');
    if (evaluation.baseline_hash !== record.baseline_hash) mismatches.push('evaluation baseline_hash mismatch');
    if (evaluation.case_set_hash !== record.case_set_hash) mismatches.push('evaluation case_set_hash mismatch');
    if (evaluation.evaluator_hash !== record.evaluator_hash) mismatches.push('evaluation evaluator_hash mismatch');
    if (evaluation.pass_rate !== record.pass_rate) mismatches.push('evaluation pass_rate mismatch');
    let authoritativeCases = null;
    try {
      authoritativeCases = caseSummaryFromEvaluation(evaluation);
    } catch (error) {
      mismatches.push(`evaluation case summary invalid: ${error.message}`);
    }
    if (authoritativeCases
        && canonicalStringify(authoritativeCases) !== canonicalStringify(record.cases)) {
      mismatches.push('evaluation case summary mismatch');
    }
    if (evaluation.subject_artifact_hash == null) {
      mismatches.push('evaluation subject_artifact_hash is required for publish');
    } else if (evaluation.subject_artifact_hash !== record.skill_hash) {
      mismatches.push('skill_hash does not match evaluation subject_artifact_hash');
    }
    if (!evaluation.assessor || typeof evaluation.assessor !== 'object') {
      mismatches.push('evaluation assessor is missing');
    } else {
      const evaluatorRef = evaluation.assessor.authority_ref || evaluation.assessor.id;
      if (evaluatorRef !== record.evaluator_ref) mismatches.push('evaluation evaluator_ref mismatch');
    }
    if (evaluation.decision !== 'pass' || !evaluation.eligibility || !evaluation.eligibility.eligible) {
      mismatches.push('evaluation is not currently pass/eligible');
    }
  }

  const approval = candidate.approval;
  if (!approval) {
    mismatches.push('current candidate has no approval binding');
  } else {
    if (approval.receipt_id !== record.approval_receipt_id) mismatches.push('approval receipt_id mismatch');
    if (approval.receipt_hash !== record.approval_receipt_hash) mismatches.push('approval receipt_hash mismatch');
  }
  const promotion = candidate.promotion;
  if (!promotion) {
    mismatches.push('current candidate has no promotion binding');
  } else {
    if (promotion.approval_receipt_id !== record.approval_receipt_id) {
      mismatches.push('promotion approval_receipt_id mismatch');
    }
    if (promotion.approval_receipt_hash !== record.approval_receipt_hash) {
      mismatches.push('promotion approval_receipt_hash mismatch');
    }
  }

  const receipt = projection.receipts.find((item) => item.receipt_id === record.approval_receipt_id);
  if (!receipt) {
    mismatches.push('approval receipt missing from authoritative journal');
  } else {
    if (receipt.receipt_hash !== record.approval_receipt_hash) mismatches.push('journal receipt_hash mismatch');
    if (receipt.candidate_id !== record.candidate_id) mismatches.push('journal receipt candidate_id mismatch');
    if (receipt.evaluation_hash !== record.evaluation_hash) mismatches.push('journal receipt evaluation_hash mismatch');
    if (approval && receipt.candidate_hash !== approval.candidate_hash) {
      mismatches.push('journal receipt candidate revision mismatch');
    }
  }

  if (mismatches.length > 0) {
    return blockedAuthority(
      'authority-mismatch',
      `${label} result is not bound to the current authoritative lifecycle: ${mismatches.join('; ')}`,
      regression,
      { authoritative_record: label, mismatches }
    );
  }
  return null;
}

function validateArtifactRecord(record, name, baseDir, label, regression) {
  let artifact;
  try {
    artifact = readCandidateArtifact(name, record.candidate_id, baseDir);
  } catch (error) {
    return blockedAuthority(
      'artifact-invalid',
      `${label} canonical artifact cannot be verified: ${error.message}`,
      regression,
      { authoritative_record: label }
    );
  }
  if (artifact.hash !== record.skill_hash) {
    return blockedAuthority(
      'artifact-drift',
      `${label} canonical artifact hash ${artifact.hash} does not match recorded skill_hash ${record.skill_hash}`,
      regression,
      { authoritative_record: label, artifact }
    );
  }
  return { artifact };
}

function readTargetSource(record, repoRoot) {
  const target = normalizeTarget(record.target, record.name);
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) fail('repoRoot required');
  const root = path.resolve(repoRoot);
  const sourceFile = path.resolve(root, ...target.source_path.split('/'));
  const relative = path.relative(root, sourceFile);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    fail('target source_path escapes or aliases the repository root');
  }
  const readback = secureReadFile(sourceFile, {
    label: 'target source artifact',
    maxBytes: MAX_ARTIFACT_BYTES,
    requireNonEmpty: true,
  });
  return {
    file: sourceFile,
    path: target.source_path,
    hash: artifactContentHash(readback.buffer),
    bytes: readback.bytes,
  };
}

function checkPublishGuard(name, options = {}) {
  const regression = checkRegression(name, options);
  if (regression.status !== 'ok') return regression;
  if (typeof options.baseDir !== 'string' || !options.baseDir.trim()) {
    return blockedAuthority(
      'authority-context-missing',
      'publish guard requires the authoritative self-learning baseDir',
      regression
    );
  }
  if (typeof options.projectId !== 'string' || !options.projectId.trim()) {
    return blockedAuthority(
      'authority-context-missing',
      'publish guard requires an authoritative projectId',
      regression
    );
  }
  if (typeof options.repoRoot !== 'string' || !options.repoRoot.trim()) {
    return blockedAuthority(
      'authority-context-missing',
      'publish guard requires the trusted repository root',
      regression
    );
  }

  let checkedAt;
  let retentionDays;
  try {
    checkedAt = operationTimestamp(options, 'publish guard');
    retentionDays = configuredRetentionDays(options.baseDir);
  } catch (error) {
    return blockedAuthority(
      'retention-policy-invalid',
      `publish freshness cannot be verified: ${error.message}`,
      regression
    );
  }

  let projection;
  try {
    projection = inspectCandidateStore(resolveStoreDir(options.baseDir, options.projectId));
  } catch (error) {
    return blockedAuthority(
      'authority-store-invalid',
      `authoritative self-learning journal cannot be verified: ${error.message}`,
      regression
    );
  }
  const authorityExpected = {
    projectId: options.projectId,
    name,
    checkedAt,
    retentionDays,
  };
  const previousFailure = validateAuthorityRecord(
    regression.prev,
    projection,
    'baseline',
    regression,
    authorityExpected
  );
  if (previousFailure) return previousFailure;
  const currentFailure = validateAuthorityRecord(
    regression.curr,
    projection,
    'candidate',
    regression,
    authorityExpected
  );
  if (currentFailure) return currentFailure;
  const baselineArtifact = validateArtifactRecord(
    regression.prev,
    name,
    options.baseDir,
    'baseline',
    regression
  );
  if (baselineArtifact.status === 'blocked') return baselineArtifact;
  const candidateArtifact = validateArtifactRecord(
    regression.curr,
    name,
    options.baseDir,
    'candidate',
    regression
  );
  if (candidateArtifact.status === 'blocked') return candidateArtifact;
  let sourceArtifact;
  try {
    sourceArtifact = readTargetSource(regression.curr, options.repoRoot);
  } catch (error) {
    return blockedAuthority(
      'source-invalid',
      `current target source cannot be verified: ${error.message}`,
      regression
    );
  }
  const sourceMismatches = [];
  if (sourceArtifact.hash !== regression.prev.skill_hash) {
    sourceMismatches.push('current source hash does not match the previous promoted artifact');
  }
  if (sourceArtifact.hash !== regression.curr.target.source_hash) {
    sourceMismatches.push('current source hash does not match candidate target.source_hash');
  }
  if (sourceArtifact.hash !== regression.curr.baseline_hash) {
    sourceMismatches.push('current source hash does not match candidate baseline_hash');
  }
  if (sourceMismatches.length > 0) {
    return blockedAuthority(
      'source-drift',
      `current target source is not the evaluated baseline: ${sourceMismatches.join('; ')}`,
      regression,
      { mismatches: sourceMismatches, source_artifact: sourceArtifact }
    );
  }
  return {
    ...regression,
    status: 'ok',
    publish_authorized: true,
    reason_code: 'authoritative-promoted-non-regression',
    reason: 'deterministic regression identity, promoted lifecycle, and baseline/current canonical artifacts are authoritative',
    authority: {
      project_id: options.projectId,
      checked_at: checkedAt,
      retention_days: retentionDays,
      journal_revision: projection.journal_revision,
      journal_head_hash: projection.journal_head_hash,
      baseline_candidate_id: regression.prev.candidate_id,
      candidate_id: regression.curr.candidate_id,
      evaluation_hash: regression.curr.evaluation_hash,
      approval_receipt_hash: regression.curr.approval_receipt_hash,
      baseline_artifact: baselineArtifact.artifact,
      candidate_artifact: candidateArtifact.artifact,
      source_artifact: sourceArtifact,
    },
  };
}

module.exports = {
  EVAL_RESULTS_SCHEMA_VERSION,
  LEGACY_HASH_BOUND_SCHEMA_VERSION,
  LEGACY_EVAL_RESULTS_SCHEMA_VERSION,
  EVALS_DIR_NAME,
  CANDIDATES_DIR_NAME,
  ARTIFACT_FILE_NAME,
  MAX_ARTIFACT_BYTES,
  SKILL_NAME_RE,
  TARGET_FIELDS,
  SCOPE_FIELDS,
  V2_FIELDS,
  V3_FIELDS,
  checkPublishGuard,
  checkRegression,
  readLatestTwo,
  readCandidateArtifact,
  readResults,
  recordAuthoritativeResult,
  stageCandidateArtifact,
  verifyStagedArtifactForEvaluation,
  resolveResultsFile,
  resolveCandidateArtifactFile,
  resultHash,
  artifactContentHash,
  normalizeTarget,
  normalizeProjectScope,
  readTargetSource,
  validateAuthorityRecord,
  validateRecord,
};
