'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  assertExactKeys,
  canonicalStringify,
  isPlainObject,
  stableHash,
} = require('./self-learning-canonical');
const {
  readJournal,
  resolveStoreDir,
} = require('./self-learning-store');

const EVALUATION_ARTIFACT_SCHEMA_VERSION = 'self-learning-evaluation-artifact-v2';
const EVALUATION_AUTHORITY_SCHEMA_VERSION = 'self-learning-evaluation-artifact-authority-v2';
const EVAL_CASES_SCHEMA_VERSION = '2.0';
const EVALS_DIR_NAME = 'skill-evals';
const CASES_DIR_NAME = 'cases';
const CASES_FILE_NAME = 'cases.jsonl';
const CANDIDATES_DIR_NAME = 'candidates';
const EVALUATION_ARTIFACT_FILE_NAME = 'case-results.json';
const MAX_EVALUATION_ARTIFACT_BYTES = 1024 * 1024;
const MAX_EVALUATION_CASES = 10_000;
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const CANDIDATE_ID_RE = /^lc-[a-f0-9]{32}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const CASE_REQUIRED_FIELDS = Object.freeze([
  'schema_version',
  'timestamp',
  'name',
  'id',
  'input',
  'provenance',
  'source_trace',
]);
const CASE_OPTIONAL_FIELDS = Object.freeze(['expectation', 'tags']);
const RESULT_ITEM_FIELDS = Object.freeze(['case_id', 'passed']);
const ARTIFACT_FIELDS = Object.freeze([
  'schema_version',
  'project_id',
  'name',
  'candidate_id',
  'case_set_hash',
  'case_results_hash',
  'case_count',
  'passed_count',
  'pass_rate',
  'results',
]);

// Only objects created by this process after a secure read receive authority.
// A serialized object deliberately loses this membership and cannot be replayed as live authority.
const evaluationAuthorityBrand = new WeakSet();

function fail(message, code = 'SELF_LEARNING_EVALUATION_ARTIFACT_INVALID') {
  const error = new Error(`self-learning-evaluation-artifacts: ${message}`);
  error.code = code;
  throw error;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentMetadata(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertSingleLink(stat, label) {
  if (stat.nlink !== 1n) {
    fail(`${label} must have link count nlink===1; external hardlinks are prohibited`);
  }
}

function assertExistingPathChain(candidate, options = {}) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error && error.code === 'ENOENT' && options.allowMissing === true) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      fail(`${options.label || 'artifact'} path contains a symbolic link or junction: ${current}`);
    }
    const real = fs.realpathSync.native(current);
    if (!samePath(real, current)) {
      fail(`${options.label || 'artifact'} path is not canonical: ${current}`);
    }
  }
}

function assertRegularFile(stat, label) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a plain regular file`);
  }
  assertSingleLink(stat, label);
}

function assertSize(stat, label, maxBytes, requireNonEmpty) {
  if (stat.size > BigInt(maxBytes)) fail(`${label} exceeds ${maxBytes} bytes`);
  if (requireNonEmpty && stat.size === 0n) fail(`${label} must be nonempty`);
}

function readDescriptorExactly(descriptor, size, label) {
  const length = Number(size);
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(descriptor, buffer, offset, length - offset, offset);
    if (count === 0) fail(`${label} ended before its declared size`);
    offset += count;
  }
  return buffer;
}

function secureReadFile(file, options = {}) {
  const resolved = path.resolve(file);
  const label = options.label || 'artifact';
  const maxBytes = options.maxBytes || MAX_EVALUATION_ARTIFACT_BYTES;
  assertExistingPathChain(resolved, { allowMissing: options.allowMissing, label });

  let before;
  try {
    before = fs.lstatSync(resolved, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT' && options.allowMissing === true) return null;
    throw error;
  }
  assertRegularFile(before, label);
  assertSize(before, label, maxBytes, options.requireNonEmpty === true);
  if (!samePath(fs.realpathSync.native(resolved), resolved)) {
    fail(`${label} path is not canonical`);
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  let buffer;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertRegularFile(opened, label);
    assertSize(opened, label, maxBytes, options.requireNonEmpty === true);
    if (!sameContentMetadata(before, opened)) {
      fail(`${label} identity or content metadata changed before fd read`);
    }

    buffer = fs.readFileSync(descriptor);
    const afterFirstRead = fs.fstatSync(descriptor, { bigint: true });
    assertRegularFile(afterFirstRead, label);
    assertSize(afterFirstRead, label, maxBytes, options.requireNonEmpty === true);
    if (!sameContentMetadata(opened, afterFirstRead)
        || afterFirstRead.size !== BigInt(buffer.length)) {
      fail(`${label} changed while being read`);
    }
    const verificationBuffer = readDescriptorExactly(descriptor, afterFirstRead.size, label);
    const afterVerificationRead = fs.fstatSync(descriptor, { bigint: true });
    assertRegularFile(afterVerificationRead, label);
    assertSize(afterVerificationRead, label, maxBytes, options.requireNonEmpty === true);
    if (!sameContentMetadata(afterFirstRead, afterVerificationRead)
        || !verificationBuffer.equals(buffer)) {
      fail(`${label} content or metadata changed while being read`);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  const after = fs.lstatSync(resolved, { bigint: true });
  assertRegularFile(after, label);
  assertSize(after, label, maxBytes, options.requireNonEmpty === true);
  if (!sameContentMetadata(before, after)) {
    fail(`${label} path was replaced while being read`);
  }
  if (!samePath(fs.realpathSync.native(resolved), resolved)) {
    fail(`${label} path changed while being read`);
  }
  assertExistingPathChain(resolved, { label });
  return {
    file: resolved,
    buffer,
    bytes: buffer.length,
    identity: Object.freeze({
      dev: before.dev.toString(),
      ino: before.ino.toString(),
      size: Number(before.size),
      nlink: Number(before.nlink),
    }),
  };
}

function secureUtf8(readback, label) {
  const text = readback.buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(readback.buffer)) {
    fail(`${label} must be valid UTF-8 text`);
  }
  if (text.includes('\u0000')) fail(`${label} must not contain NUL bytes`);
  return text;
}

function assertParentUnchanged(parent, before, label) {
  const after = fs.lstatSync(parent, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
    fail(`${label} parent directory was replaced during staging`);
  }
  if (!samePath(fs.realpathSync.native(parent), parent)) {
    fail(`${label} parent directory is not canonical`);
  }
  assertExistingPathChain(parent, { label });
}

function ensureVerifiedParent(file, label) {
  const parent = path.dirname(path.resolve(file));
  assertExistingPathChain(parent, { allowMissing: true, label });
  fs.mkdirSync(parent, { recursive: true });
  assertExistingPathChain(parent, { label });
  const stat = fs.lstatSync(parent, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} parent must be a plain directory`);
  }
  if (!samePath(fs.realpathSync.native(parent), parent)) {
    fail(`${label} parent directory is not canonical`);
  }
  return { parent, stat };
}

function atomicStageNoClobber(file, buffer, options = {}) {
  const resolved = path.resolve(file);
  const label = options.label || 'artifact';
  if (!Buffer.isBuffer(buffer)) fail(`${label} stage content must be a Buffer`);
  const maxBytes = options.maxBytes || MAX_EVALUATION_ARTIFACT_BYTES;
  if (buffer.length > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  if (options.requireNonEmpty === true && buffer.length === 0) fail(`${label} must be nonempty`);

  const parentAuthority = ensureVerifiedParent(resolved, label);
  assertExistingPathChain(resolved, { allowMissing: true, label });
  const temporaryFile = path.join(
    parentAuthority.parent,
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`
  );
  let descriptor;
  let changed = false;
  try {
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    const created = fs.fstatSync(descriptor, { bigint: true });
    assertRegularFile(created, `${label} temporary file`);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor, { bigint: true });
    assertRegularFile(written, `${label} temporary file`);
    if (!sameIdentity(created, written) || written.size !== BigInt(buffer.length)) {
      fail(`${label} temporary file changed while being written`);
    }
    fs.closeSync(descriptor);
    descriptor = undefined;

    const temporaryReadback = secureReadFile(temporaryFile, {
      label: `${label} temporary file`,
      maxBytes,
      requireNonEmpty: options.requireNonEmpty === true,
    });
    if (!temporaryReadback.buffer.equals(buffer)) fail(`${label} temporary readback mismatch`);
    try {
      // Same-directory hard-link provides an atomic create-if-absent publish. The
      // temporary name is removed immediately; the final secure read requires nlink===1.
      fs.linkSync(temporaryFile, resolved);
      changed = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryFile);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  assertParentUnchanged(parentAuthority.parent, parentAuthority.stat, label);
  const readback = secureReadFile(resolved, {
    label,
    maxBytes,
    requireNonEmpty: options.requireNonEmpty === true,
  });
  if (!readback.buffer.equals(buffer)) {
    fail(changed
      ? `${label} readback mismatch after atomic staging`
      : `${label} already exists with different content; overwrite is prohibited`);
  }
  return { changed, readback };
}

function secureAppendUtf8Line(file, line, options = {}) {
  const resolved = path.resolve(file);
  const label = options.label || 'JSONL artifact';
  if (typeof line !== 'string' || line.includes('\r') || line.includes('\n')) {
    fail(`${label} append must be exactly one LF-free UTF-8 line`);
  }
  const buffer = Buffer.from(`${line}\n`, 'utf8');
  const maxBytes = options.maxBytes || MAX_EVALUATION_ARTIFACT_BYTES;
  const existing = secureReadFile(resolved, { allowMissing: true, label, maxBytes });
  if (!existing) {
    return atomicStageNoClobber(resolved, buffer, {
      label,
      maxBytes,
      requireNonEmpty: true,
    });
  }
  if (existing.bytes + buffer.length > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  if (existing.bytes > 0 && existing.buffer[existing.buffer.length - 1] !== 0x0a) {
    fail(`${label} is corrupt: missing final LF`);
  }

  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent, { bigint: true });
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertRegularFile(opened, label);
    if (opened.dev.toString() !== existing.identity.dev
        || opened.ino.toString() !== existing.identity.ino
        || Number(opened.size) !== existing.bytes) {
      fail(`${label} identity changed before append`);
    }
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    const afterWrite = fs.fstatSync(descriptor, { bigint: true });
    assertRegularFile(afterWrite, label);
    if (!sameIdentity(opened, afterWrite)
        || afterWrite.size !== opened.size + BigInt(buffer.length)) {
      fail(`${label} changed during append`);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  assertParentUnchanged(parent, parentStat, label);
  const readback = secureReadFile(resolved, {
    label,
    maxBytes,
    requireNonEmpty: true,
  });
  if (!readback.buffer.subarray(readback.buffer.length - buffer.length).equals(buffer)) {
    fail(`${label} append readback mismatch`);
  }
  return { changed: true, readback };
}

function assertValidName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    fail(`invalid skill name "${name}"`);
  }
  return name;
}

function assertCandidateId(candidateId) {
  if (typeof candidateId !== 'string' || !CANDIDATE_ID_RE.test(candidateId)) {
    fail('candidate_id has invalid authoritative identity');
  }
  return candidateId;
}

function resolveCasesFile(name, baseDir) {
  assertValidName(name);
  if (typeof baseDir !== 'string' || !baseDir.trim()) fail('baseDir required');
  return path.join(path.resolve(baseDir), EVALS_DIR_NAME, name, CASES_DIR_NAME, CASES_FILE_NAME);
}

function resolveEvaluationArtifactFile(name, candidateId, baseDir) {
  assertValidName(name);
  assertCandidateId(candidateId);
  if (typeof baseDir !== 'string' || !baseDir.trim()) fail('baseDir required');
  return path.join(
    path.resolve(baseDir),
    EVALS_DIR_NAME,
    name,
    CANDIDATES_DIR_NAME,
    candidateId,
    EVALUATION_ARTIFACT_FILE_NAME
  );
}

function validateCaseRecord(value, name, index) {
  if (!isPlainObject(value)) fail(`case line ${index} must contain an object`);
  const actual = Object.keys(value).sort();
  const allowed = new Set([...CASE_REQUIRED_FIELDS, ...CASE_OPTIONAL_FIELDS]);
  const missing = CASE_REQUIRED_FIELDS.filter(
    (field) => !Object.prototype.hasOwnProperty.call(value, field)
  );
  const unknown = actual.filter((field) => !allowed.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    fail(`case line ${index} fields invalid; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`);
  }
  if (value.schema_version !== EVAL_CASES_SCHEMA_VERSION) {
    fail(`case line ${index} has unknown schema_version`);
  }
  if (value.name !== name) fail(`case line ${index} name does not match ${name}`);
  if (typeof value.timestamp !== 'string'
      || Number.isNaN(new Date(value.timestamp).getTime())
      || new Date(value.timestamp).toISOString() !== value.timestamp) {
    fail(`case line ${index} timestamp is invalid or noncanonical`);
  }
  if (typeof value.id !== 'string' || !value.id || value.id.length > 256) {
    fail(`case line ${index} id must be a nonempty string <=256 characters`);
  }
  if (typeof value.input !== 'string' || !value.input) {
    fail(`case line ${index} input must be nonempty`);
  }
  if (value.provenance !== 'behavior_event') {
    fail(`case line ${index} provenance must be behavior_event`);
  }
  if (!isPlainObject(value.source_trace)) fail(`case line ${index} source_trace must be an object`);
  if (Object.prototype.hasOwnProperty.call(value, 'expectation')
      && (typeof value.expectation !== 'string' || !value.expectation)) {
    fail(`case line ${index} expectation must be a nonempty string`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'tags')
      && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string'))) {
    fail(`case line ${index} tags must contain strings`);
  }
  // Forces source_trace and other nested values through the canonical JSON value validator.
  canonicalStringify(value);
  return value;
}

function readStrictCases(name, options = {}) {
  const casesFile = resolveCasesFile(name, options.baseDir);
  const readback = secureReadFile(casesFile, {
    allowMissing: options.allowMissing === true,
    label: 'evaluation cases artifact',
    maxBytes: MAX_EVALUATION_ARTIFACT_BYTES,
    requireNonEmpty: options.requireNonEmpty !== false,
  });
  if (!readback) return [];
  const raw = secureUtf8(readback, 'evaluation cases artifact');
  if (raw.includes('\r')) fail('evaluation cases artifact is corrupt: only LF line endings are allowed');
  if (!raw.endsWith('\n')) fail('evaluation cases artifact is corrupt: missing final LF');
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    fail('evaluation cases artifact must be nonempty and contain no blank lines');
  }
  if (lines.length > MAX_EVALUATION_CASES) {
    fail(`evaluation cases artifact exceeds ${MAX_EVALUATION_CASES} cases`);
  }
  const seen = new Set();
  const cases = lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      fail(`evaluation cases artifact malformed at line ${index + 1}: ${error.message}`);
    }
    const record = validateCaseRecord(parsed, name, index + 1);
    if (JSON.stringify(record) !== line) {
      fail(`evaluation cases artifact line ${index + 1} is noncanonical or corrupt`);
    }
    if (seen.has(record.id)) fail(`duplicate case id "${record.id}"`);
    seen.add(record.id);
    return record;
  });
  return cases;
}

function requireAuthorityProjectId(options = {}) {
  if (typeof options.projectId !== 'string'
      || !options.projectId.trim()
      || options.projectId.length > 256) {
    fail('an explicit projectId is required for evaluation case journal authority');
  }
  return options.projectId;
}

function verifyCasesAuthority(cases, options = {}) {
  const projectId = requireAuthorityProjectId(options);
  // Lazy loading avoids the intentional utility cycle: skill-eval-cases reuses
  // this module's secure artifact primitives, while authority verification is
  // needed only after both modules have completed initialization.
  const { verifyCaseAuthorities } = require('./skill-eval-cases');
  if (typeof verifyCaseAuthorities !== 'function') {
    fail('evaluation case journal authority verifier is unavailable');
  }
  verifyCaseAuthorities(cases, {
    baseDir: options.baseDir,
    projectId,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  return projectId;
}

function readAuthorityJournalSnapshot(options, projectId) {
  const storeDir = resolveStoreDir(options.baseDir, projectId);
  const journal = readJournal(storeDir);
  return Object.freeze({
    store_dir: path.resolve(storeDir),
    revision: journal.revision,
    head_hash: journal.head_hash,
  });
}

function verifyCasesAtStableJournal(cases, options = {}) {
  const projectId = requireAuthorityProjectId(options);
  const before = readAuthorityJournalSnapshot(options, projectId);
  verifyCasesAuthority(cases, options);
  const after = readAuthorityJournalSnapshot(options, projectId);
  if (before.revision !== after.revision || before.head_hash !== after.head_hash) {
    fail(
      'canonical evaluation case journal changed while authority was verified',
      'SELF_LEARNING_EVALUATION_AUTHORITY_STALE'
    );
  }
  return after;
}

function normalizeResults(results, cases) {
  if (!Array.isArray(results)) fail('results must be an array');
  if (results.length > MAX_EVALUATION_CASES) fail('results exceed the bounded case limit');
  const expected = new Set(cases.map((item) => item.id));
  const seen = new Set();
  const normalized = results.map((item, index) => {
    try {
      assertExactKeys(item, RESULT_ITEM_FIELDS, `result ${index + 1}`);
    } catch (error) {
      fail(error.message);
    }
    if (typeof item.case_id !== 'string' || !item.case_id) {
      fail(`result ${index + 1} case_id must be nonempty`);
    }
    if (typeof item.passed !== 'boolean') fail(`result ${index + 1} passed must be boolean`);
    if (seen.has(item.case_id)) fail(`duplicate result for case id "${item.case_id}"`);
    seen.add(item.case_id);
    return { case_id: item.case_id, passed: item.passed };
  });
  const missing = [...expected].filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0 || seen.size !== expected.size) {
    fail(`results must exactly cover case ids; missing=[${missing.join(',')}], extra=[${extra.join(',')}]`);
  }
  return normalized.sort((left, right) => left.case_id.localeCompare(right.case_id));
}

function deriveArtifact(name, candidateId, projectId, cases, results) {
  const normalizedResults = normalizeResults(results, cases);
  const caseCount = cases.length;
  const passedCount = normalizedResults.filter((item) => item.passed).length;
  return {
    schema_version: EVALUATION_ARTIFACT_SCHEMA_VERSION,
    project_id: projectId,
    name,
    candidate_id: candidateId,
    case_set_hash: stableHash({ project_id: projectId, cases }),
    case_results_hash: stableHash(normalizedResults),
    case_count: caseCount,
    passed_count: passedCount,
    pass_rate: caseCount === 0 ? 0 : passedCount / caseCount,
    results: normalizedResults,
  };
}

function validateArtifact(value, name, candidateId, projectId, cases) {
  try {
    assertExactKeys(value, ARTIFACT_FIELDS, 'evaluation artifact');
  } catch (error) {
    fail(error.message);
  }
  if (value.schema_version !== EVALUATION_ARTIFACT_SCHEMA_VERSION) {
    fail(`unknown evaluation artifact schema_version "${value.schema_version}"`);
  }
  if (value.project_id !== projectId
      || value.name !== name
      || value.candidate_id !== candidateId) {
    fail('evaluation artifact identity mismatch');
  }
  if (!Array.isArray(value.results)) fail('evaluation artifact results must be an array');
  const derived = deriveArtifact(name, candidateId, projectId, cases, value.results);
  for (const field of ARTIFACT_FIELDS) {
    if (canonicalStringify(value[field]) !== canonicalStringify(derived[field])) {
      fail(`evaluation artifact ${field} is corrupt or not server-derived`);
    }
  }
  if (!HASH_RE.test(value.case_set_hash) || !HASH_RE.test(value.case_results_hash)) {
    fail('evaluation artifact hashes are invalid');
  }
  return derived;
}

function brandAuthority(artifact, file, projectId, journalSnapshot) {
  const authority = Object.freeze({
    schema_version: EVALUATION_AUTHORITY_SCHEMA_VERSION,
    project_id: projectId,
    name: artifact.name,
    candidate_id: artifact.candidate_id,
    case_set_hash: artifact.case_set_hash,
    case_results_hash: artifact.case_results_hash,
    case_count: artifact.case_count,
    passed_count: artifact.passed_count,
    pass_rate: artifact.pass_rate,
    file: path.resolve(file),
    journal_store_dir: journalSnapshot.store_dir,
    journal_revision: journalSnapshot.revision,
    journal_head_hash: journalSnapshot.head_hash,
  });
  evaluationAuthorityBrand.add(authority);
  return authority;
}

function assertEvaluationArtifactAuthority(value) {
  if (!value || typeof value !== 'object' || !evaluationAuthorityBrand.has(value)) {
    fail('evaluation artifact authority brand is missing or belongs to another process');
  }
  return value;
}

function evaluationAuthorityAppendOptions(value, storeDir, projectId) {
  const authority = assertEvaluationArtifactAuthority(value);
  if (authority.project_id !== projectId) {
    fail('evaluation artifact authority project_id mismatch');
  }
  if (!samePath(authority.journal_store_dir, storeDir)) {
    fail('evaluation artifact authority canonical journal mismatch');
  }
  if (!Number.isSafeInteger(authority.journal_revision)
      || authority.journal_revision < 0
      || (authority.journal_revision === 0 && authority.journal_head_hash !== null)
      || (authority.journal_revision > 0 && !HASH_RE.test(authority.journal_head_hash || ''))) {
    fail('evaluation artifact authority journal binding is invalid');
  }
  return Object.freeze({
    expected_revision: authority.journal_revision,
    expected_head_hash: authority.journal_head_hash,
  });
}

function readEvaluationArtifactAuthority(name, candidateId, options = {}) {
  assertValidName(name);
  assertCandidateId(candidateId);
  const projectId = requireAuthorityProjectId(options);
  const cases = readStrictCases(name, {
    baseDir: options.baseDir,
    requireNonEmpty: true,
  });
  const journalSnapshot = verifyCasesAtStableJournal(cases, options);
  const file = resolveEvaluationArtifactFile(name, candidateId, options.baseDir);
  const readback = secureReadFile(file, {
    label: 'evaluation results artifact',
    maxBytes: MAX_EVALUATION_ARTIFACT_BYTES,
    requireNonEmpty: true,
  });
  const raw = secureUtf8(readback, 'evaluation results artifact');
  if (raw.includes('\r') || !raw.endsWith('\n')) {
    fail('evaluation results artifact is corrupt: canonical LF JSON required');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`evaluation results artifact is malformed: ${error.message}`);
  }
  const artifact = validateArtifact(parsed, name, candidateId, projectId, cases);
  const canonical = `${canonicalStringify(artifact)}\n`;
  if (raw !== canonical) fail('evaluation results artifact is noncanonical or corrupt');
  return brandAuthority(artifact, file, projectId, journalSnapshot);
}

function stageEvaluationArtifactAuthority(name, candidateId, results, options = {}) {
  assertValidName(name);
  assertCandidateId(candidateId);
  const projectId = requireAuthorityProjectId(options);
  const cases = readStrictCases(name, {
    baseDir: options.baseDir,
    requireNonEmpty: true,
  });
  verifyCasesAuthority(cases, options);
  const artifact = deriveArtifact(name, candidateId, projectId, cases, results);
  const buffer = Buffer.from(`${canonicalStringify(artifact)}\n`, 'utf8');
  const file = resolveEvaluationArtifactFile(name, candidateId, options.baseDir);
  const staged = atomicStageNoClobber(file, buffer, {
    label: 'evaluation results artifact',
    maxBytes: MAX_EVALUATION_ARTIFACT_BYTES,
    requireNonEmpty: true,
  });
  const authority = readEvaluationArtifactAuthority(name, candidateId, {
    baseDir: options.baseDir,
    projectId,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  return {
    changed: staged.changed,
    authority,
    artifact: Object.freeze({
      file: staged.readback.file,
      bytes: staged.readback.bytes,
      hash: stableHash(artifact),
    }),
  };
}

module.exports = {
  EVALUATION_ARTIFACT_SCHEMA_VERSION,
  EVALUATION_AUTHORITY_SCHEMA_VERSION,
  EVALUATION_ARTIFACT_FILE_NAME,
  MAX_EVALUATION_ARTIFACT_BYTES,
  assertEvaluationArtifactAuthority,
  atomicStageNoClobber,
  evaluationAuthorityAppendOptions,
  readEvaluationArtifactAuthority,
  readStrictCases,
  resolveEvaluationArtifactFile,
  secureAppendUtf8Line,
  secureReadFile,
  stageEvaluationArtifactAuthority,
};
