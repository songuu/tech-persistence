'use strict';

const path = require('path');
const { stripPrivateTags } = require('./redaction');
const {
  canonicalStringify,
  isPlainObject,
  redactCanonicalValue,
  stableHash,
} = require('./self-learning-canonical');
const {
  isTrustedUserAuthorityEvent,
  journalActorForEvent,
  normalizeBehaviorEvent,
} = require('./behavior-events');
const { detectStableProjectIdentity } = require('./project-identity');
const { readJournal, resolveStoreDir } = require('./self-learning-store');
const {
  readStrictCases,
  secureAppendUtf8Line,
} = require('./self-learning-evaluation-artifacts');

const EVAL_CASES_SCHEMA_VERSION = '2.0';
const EVAL_CASE_SOURCE_SCHEMA_VERSION = 'self-learning-eval-case-source-v1';
const EVALS_DIR_NAME = 'skill-evals';
const CASES_DIR_NAME = 'cases';
const CASES_FILE_NAME = 'cases.jsonl';
// 与 skill-traces / skill-eval-results 一致：只接受 `[a-z][a-z0-9-]{0,63}`，防路径逃逸到 evalsDir 外
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

// v1 的 `trace` provenance 是 caller 自声明快照，不能作为授权证据。
// v2 只接受 canonical journal 中仍 active 的 native user BehaviorEvent。
const ALLOWED_PROVENANCE = new Set(['behavior_event']);
const SOURCE_TRACE_FIELDS = Object.freeze([
  'schema_version',
  'source_event_ref',
  'journal_record_hash',
  'input_digest',
  'occurred_at',
]);
const AUTHORITY_OPTION_FIELDS = new Set(['baseDir', 'projectId', 'cwd']);
const BEHAVIOR_EVENT_REF_RE = /^behavior-event:[a-f0-9]{64}$/;

function assertValidName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new Error(`skill-eval-cases: invalid skill name "${name}" (need ${SKILL_NAME_RE})`);
  }
}

// {baseDir}/skill-evals/{name}/cases/cases.jsonl（与 B3 results/results.jsonl 平级同构）
function resolveCasesFile(name, baseDir) {
  assertValidName(name);
  if (!baseDir) throw new Error('skill-eval-cases: baseDir required');
  return path.join(path.resolve(baseDir), EVALS_DIR_NAME, name, CASES_DIR_NAME, CASES_FILE_NAME);
}

function authorityError(message) {
  return new Error(`skill-eval-cases: ${message}`);
}

function resolveAuthorityContext(options = {}) {
  if (!isPlainObject(options)) throw authorityError('authority options must be an object');
  const unknown = Object.keys(options).filter((key) => !AUTHORITY_OPTION_FIELDS.has(key));
  if (unknown.length > 0) {
    throw authorityError(`authority options contain unsupported field(s): ${unknown.join(', ')}`);
  }
  if (typeof options.baseDir !== 'string' || !options.baseDir.trim()) {
    throw authorityError('baseDir required for canonical case authority');
  }
  if (typeof options.projectId !== 'string' || !options.projectId.trim()) {
    throw authorityError('projectId required for canonical case authority');
  }
  const cwd = options.cwd === undefined ? process.cwd() : options.cwd;
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw authorityError('cwd must be a non-empty string');
  }
  const project = detectStableProjectIdentity(cwd);
  if (project.id !== options.projectId) {
    throw authorityError(
      `project identity mismatch: detected ${project.id}, expected ${options.projectId}`
    );
  }
  return {
    baseDir: path.resolve(options.baseDir),
    cwd: path.resolve(cwd),
    project,
    projectId: options.projectId,
  };
}

function activeBehaviorRecords(journal) {
  const tombstoned = new Set(journal.records
    .filter((record) => record.record_type === 'tombstone')
    .map((record) => record.entity_id));
  const active = new Map();
  for (const record of journal.records) {
    if (record.record_type !== 'behavior_event' || tombstoned.has(record.entity_id)) continue;
    active.set(record.entity_id, record);
  }
  return { active, tombstoned };
}

function sourceTraceFor(record, event) {
  return {
    schema_version: EVAL_CASE_SOURCE_SCHEMA_VERSION,
    source_event_ref: event.event_id,
    journal_record_hash: record.record_hash,
    input_digest: event.input_digest,
    occurred_at: event.occurred_at,
  };
}

function assertTrustedSourceRecord(record, sourceEventRef, projectId, caseInput) {
  if (!record) {
    throw authorityError(`source_event_ref is not active in the canonical project journal: ${sourceEventRef}`);
  }
  let event;
  try {
    event = normalizeBehaviorEvent(record.payload);
  } catch (error) {
    throw authorityError(`source BehaviorEvent is invalid: ${error.message}`);
  }
  const expectedActor = journalActorForEvent(event);
  if (record.record_type !== 'behavior_event'
      || record.record_id !== event.event_id
      || record.entity_id !== event.event_id
      || event.event_id !== sourceEventRef
      || event.project_id !== projectId) {
    throw authorityError('source BehaviorEvent identity does not match the canonical project record');
  }
  if (record.occurred_at !== event.occurred_at) {
    throw authorityError('source BehaviorEvent time does not match its journal record');
  }
  if (!expectedActor.authority_ref
      || canonicalStringify(record.actor) !== canonicalStringify(expectedActor)) {
    throw authorityError('source BehaviorEvent journal actor does not completely match trusted authority');
  }
  if (event.actor.kind !== 'user'
      || event.event_type !== 'user.prompt'
      || !isTrustedUserAuthorityEvent(event, 'memory')) {
    throw authorityError('source_event_ref must identify a trusted native user UserPromptSubmit event');
  }
  const redactedInput = redactCanonicalValue(caseInput, 'eval case input');
  const inputDigest = stableHash(redactedInput);
  if (event.input_digest !== inputDigest) {
    throw authorityError('case input digest does not match the referenced BehaviorEvent input digest');
  }
  return { event, source_trace: sourceTraceFor(record, event) };
}

function assertAuthoritativeCaseShape(caseRecord) {
  if (!isPlainObject(caseRecord)) throw authorityError('case record must be an object');
  if (caseRecord.schema_version !== EVAL_CASES_SCHEMA_VERSION) {
    throw authorityError(
      `case schema_version ${String(caseRecord.schema_version)} is not authoritative; expected ${EVAL_CASES_SCHEMA_VERSION}`
    );
  }
  if (caseRecord.provenance !== 'behavior_event') {
    throw authorityError('case provenance is not authoritative; expected behavior_event');
  }
  if (typeof caseRecord.input !== 'string' || !caseRecord.input) {
    throw authorityError('case input must be a non-empty string');
  }
  if (stripPrivateTags(caseRecord.input) !== caseRecord.input) {
    throw authorityError('case input is not redaction-stable');
  }
  if (!isPlainObject(caseRecord.source_trace)) {
    throw authorityError('case source_trace must be an object');
  }
  const actualFields = Object.keys(caseRecord.source_trace).sort();
  const expectedFields = [...SOURCE_TRACE_FIELDS].sort();
  if (actualFields.length !== expectedFields.length
      || actualFields.some((field, index) => field !== expectedFields[index])) {
    throw authorityError('case source_trace fields do not match the authoritative schema');
  }
  if (!BEHAVIOR_EVENT_REF_RE.test(caseRecord.source_trace.source_event_ref || '')) {
    throw authorityError('case source_trace source_event_ref is invalid');
  }
  return caseRecord;
}

// Batch authority verification reads the canonical project journal exactly once.
// Callers may identify base/project/cwd only; serialized journal snapshots are never accepted.
function verifyCaseAuthorities(caseRecords, options = {}) {
  if (!Array.isArray(caseRecords)) throw authorityError('caseRecords must be an array');
  const context = resolveAuthorityContext(options);
  const journal = readJournal(resolveStoreDir(context.baseDir, context.projectId));
  const { active, tombstoned } = activeBehaviorRecords(journal);
  return caseRecords.map((caseRecord) => {
    assertAuthoritativeCaseShape(caseRecord);
    const sourceEventRef = caseRecord.source_trace.source_event_ref;
    if (tombstoned.has(sourceEventRef)) {
      throw authorityError(`source_event_ref is tombstoned in the canonical project journal: ${sourceEventRef}`);
    }
    const sourceRecord = active.get(sourceEventRef);
    const { event, source_trace: expectedTrace } = assertTrustedSourceRecord(
      sourceRecord,
      sourceEventRef,
      context.projectId,
      caseRecord.input
    );
    if (canonicalStringify(caseRecord.source_trace) !== canonicalStringify(expectedTrace)) {
      throw authorityError('case source_trace does not match the canonical BehaviorEvent record');
    }
    return {
      project: context.project,
      source_record: sourceRecord,
      source_event: event,
    };
  });
}

function verifyCaseAuthority(caseRecord, options = {}) {
  return verifyCaseAuthorities([caseRecord], options)[0];
}

// Append a case only after resolving its authority from the canonical journal.
// Caller-provided provenance, timestamps, or source snapshots are rejected.
function addCase(name, input = {}, options = {}) {
  assertValidName(name);
  if (!isPlainObject(input)) throw authorityError('case input must be an object');
  if (typeof input.input !== 'string' || input.input.length === 0) {
    throw new Error('skill-eval-cases: input required (non-empty string) — case 的触发输入');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'source_trace')) {
    throw authorityError('caller source_trace is not accepted; use source_event_ref');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'provenance')
      || Object.prototype.hasOwnProperty.call(input, 'timestamp')) {
    throw authorityError('caller provenance/timestamp is not accepted; authority is server-derived');
  }
  if (typeof input.source_event_ref !== 'string' || !BEHAVIOR_EVENT_REF_RE.test(input.source_event_ref)) {
    throw authorityError('source_event_ref required (canonical BehaviorEvent event_id)');
  }

  const context = resolveAuthorityContext(options);
  const redactedInput = stripPrivateTags(input.input);
  const journal = readJournal(resolveStoreDir(context.baseDir, context.projectId));
  const { active, tombstoned } = activeBehaviorRecords(journal);
  if (tombstoned.has(input.source_event_ref)) {
    throw authorityError(`source_event_ref is tombstoned in the canonical project journal: ${input.source_event_ref}`);
  }
  const sourceRecord = active.get(input.source_event_ref);
  const authority = assertTrustedSourceRecord(
    sourceRecord,
    input.source_event_ref,
    context.projectId,
    redactedInput
  );

  const casesFile = resolveCasesFile(name, context.baseDir);

  const timestamp = new Date();
  const id = typeof input.id === 'string' && input.id
    ? stripPrivateTags(input.id)
    : `case-${Date.now()}`;
  if (!id || id.length > 256) {
    throw new Error('skill-eval-cases: id must be a non-empty string <=256 characters');
  }

  const record = {
    schema_version: EVAL_CASES_SCHEMA_VERSION,
    timestamp: timestamp.toISOString(),
    name,
    id,
    input: redactedInput,
    expectation:
      typeof input.expectation === 'string' && input.expectation
        ? stripPrivateTags(input.expectation)
        : undefined,
    provenance: 'behavior_event',
    source_trace: authority.source_trace,
    tags: Array.isArray(input.tags) ? input.tags.map((t) => stripPrivateTags(String(t))) : undefined,
  };

  // Case identity is part of the evaluation authority. Appending a second
  // record with the same id would make result coverage ambiguous, so fail closed.
  const existing = readCases(name, { baseDir: context.baseDir });
  if (existing.some((item) => item.id === record.id)) {
    throw new Error(`skill-eval-cases: duplicate case id "${record.id}"`);
  }

  secureAppendUtf8Line(casesFile, JSON.stringify(record), {
    label: 'evaluation cases artifact',
  });
  return { record, casesFile };
}

// 读全部 case（按 append 顺序）。损坏、链接或重复 id 都 fail closed；
// 缺失文件仍表示尚未建立测试集，供 list/add 首次初始化使用。
function readCases(name, options = {}) {
  return readStrictCases(name, {
    baseDir: options.baseDir,
    allowMissing: true,
    requireNonEmpty: true,
  });
}

module.exports = {
  EVAL_CASES_SCHEMA_VERSION,
  EVAL_CASE_SOURCE_SCHEMA_VERSION,
  EVALS_DIR_NAME,
  CASES_DIR_NAME,
  CASES_FILE_NAME,
  SKILL_NAME_RE,
  ALLOWED_PROVENANCE,
  resolveCasesFile,
  addCase,
  readCases,
  verifyCaseAuthorities,
  verifyCaseAuthority,
};
