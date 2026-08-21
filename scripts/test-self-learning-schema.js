#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateValue } = require('./agent-orchestrator/structured-output');
const {
  createLearningCandidate,
  evaluateCandidateState,
} = require('./lib/learning-candidates');
const { stableHash } = require('./lib/self-learning-canonical');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { resolveStoreDir } = require('./lib/self-learning-store');
const { addCase } = require('./lib/skill-eval-cases');
const { stageEvaluationArtifactAuthority } = require('./lib/self-learning-evaluation-artifacts');
const {
  buildBehaviorEpisode,
} = require('./lib/behavior-episodes');
const {
  appendBehaviorEvent,
  createBehaviorEvent,
  normalizeEvidenceRef,
} = require('./lib/behavior-events');

const root = path.resolve(__dirname, '..');
const EVALUATION_PROJECT_ID = detectStableProjectIdentity(process.cwd()).id;
const schemaRoot = path.join(root, 'schemas', 'self-learning');
const expected = [
  'approval-receipt.schema.json',
  'behavior-episode.schema.json',
  'behavior-event.schema.json',
  'candidate-evaluation.schema.json',
  'evidence-ref.schema.json',
  'journal-record.schema.json',
  'learning-candidate.schema.json',
  'tombstone.schema.json',
];

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(schemaRoot, name), 'utf8'));
}

function resolveLocalRefs(value, rootSchema) {
  if (Array.isArray(value)) return value.map((item) => resolveLocalRefs(item, rootSchema));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string') {
    assert.match(value.$ref, /^#\//, 'schema tests only resolve document-local refs');
    const resolved = value.$ref.slice(2).split('/').reduce((current, token) =>
      current[token.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema);
    return resolveLocalRefs(resolved, rootSchema);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    resolveLocalRefs(item, rootSchema),
  ]));
}

function assertSchemaValid(value, schema, label) {
  const errors = validateValue(value, resolveLocalRefs(schema, schema));
  assert.deepStrictEqual(errors, [], `${label}: ${errors.join('; ')}`);
}

assert.deepStrictEqual(
  fs.readdirSync(schemaRoot).filter((name) => name.endsWith('.json')).sort(),
  expected,
  'self-learning schema inventory'
);

for (const name of expected) {
  const schema = readSchema(name);
  assert.strictEqual(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.match(schema.$id, /\/schemas\/self-learning\//);
  assert.strictEqual(schema.type, 'object');
  assert.strictEqual(schema.additionalProperties, false, `${name} must reject unknown fields`);
  assert(Array.isArray(schema.required) && schema.required.length > 0, `${name} required fields`);
}

const journalSchema = readSchema('journal-record.schema.json');
assert.strictEqual(
  journalSchema.properties.schema_version.const,
  'self-learning-journal-record-v1'
);
assert(journalSchema.required.includes('record_hash'));
assert(journalSchema.required.includes('previous_hash'));
assert.strictEqual(journalSchema.properties.sequence.minimum, 1);

const evidenceSchema = readSchema('evidence-ref.schema.json');
const behaviorEventSchema = readSchema('behavior-event.schema.json');
const evidence = normalizeEvidenceRef({
  schema_version: 'self-learning-evidence-ref-v1',
  source_type: 'user_confirmation',
  source_ref: 'confirmation:schema',
  immutable_ref: 'journal:confirmation:schema',
  digest: `sha256:${'d'.repeat(64)}`,
  uri: null,
  final_disposition: 'accepted',
  captured_at: '2026-08-20T00:00:00.000Z',
  scope: { level: 'task', id: 'task-schema' },
  redaction_status: 'passed',
  assurance: 'explicit',
  signal_strength: 'explicit',
  fact_status: 'fact',
});
assert.deepStrictEqual([...evidenceSchema.required].sort(), Object.keys(evidence).sort());
assertSchemaValid(evidence, evidenceSchema, 'evidence ref schema');
const behaviorEvent = createBehaviorEvent({
  project_id: 'project-schema',
  session_id: 'session-schema',
  task_ref: 'task-schema',
  turn_ref: 'turn-schema',
  parent_event_id: null,
  source_event_id: 'source-event-schema',
  actor: { kind: 'user', id: 'user:schema', role: null },
  runtime: 'codex',
  source: 'codex_cli',
  source_assurance: 'explicit',
  scope: { level: 'task', id: 'task-schema' },
  event_type: 'user.feedback',
  signal_strength: 'explicit',
  fact_status: 'fact',
  status: 'observed',
  final_disposition: 'accepted',
  details: { summary: 'schema sample' },
  input_digest: null,
  output_digest: null,
  evidence_refs: [evidence],
  occurred_at: '2026-08-20T00:00:01.000Z',
});
assert.deepStrictEqual([...behaviorEventSchema.required].sort(), Object.keys(behaviorEvent).sort());
assertSchemaValid(behaviorEvent, behaviorEventSchema, 'behavior event schema');
const episodeEvent = (eventType, sourceId, occurredAt, overrides = {}) => createBehaviorEvent({
  project_id: 'project-schema',
  session_id: 'session-schema',
  task_ref: 'task-schema',
  turn_ref: sourceId,
  parent_event_id: null,
  source_event_id: sourceId,
  actor: { kind: 'agent', id: 'agent:schema', role: null },
  runtime: 'codex',
  source: 'codex_mcp',
  source_assurance: 'explicit',
  scope: { level: 'task', id: 'task-schema' },
  event_type: eventType,
  signal_strength: 'explicit',
  fact_status: 'fact',
  status: 'observed',
  final_disposition: 'unknown',
  details: {},
  input_digest: null,
  output_digest: null,
  evidence_refs: [],
  occurred_at: occurredAt,
  ...overrides,
});
const behaviorEpisode = buildBehaviorEpisode([
  episodeEvent('user.prompt', 'episode-prompt', '2026-08-20T00:00:01.000Z', {
    actor: { kind: 'user', id: 'user:schema', role: null },
    source: 'codex_cli',
  }),
  episodeEvent('tool.request', 'episode-tool', '2026-08-20T00:00:02.000Z', {
    source_assurance: 'observed',
    signal_strength: 'weak',
  }),
  episodeEvent('task.result', 'episode-result', '2026-08-20T00:00:03.000Z', {
    source: 'agent_loop',
    source_assurance: 'verified',
    signal_strength: 'weak',
    status: 'succeeded',
    final_disposition: 'accepted',
    details: { verification_status: 'verified' },
    evidence_refs: [evidence],
  }),
]);
const behaviorEpisodeSchema = readSchema('behavior-episode.schema.json');
assert.deepStrictEqual([...behaviorEpisodeSchema.required].sort(), Object.keys(behaviorEpisode).sort());
assertSchemaValid(behaviorEpisode, behaviorEpisodeSchema, 'behavior episode schema');

const candidateSchema = readSchema('learning-candidate.schema.json');
const evaluationSchema = readSchema('candidate-evaluation.schema.json');
const receiptSchema = readSchema('approval-receipt.schema.json');
assert.deepStrictEqual(
  [...candidateSchema.$defs.evidenceRef.required].sort(),
  [...evidenceSchema.required].sort(),
  'candidate embedded EvidenceRef required fields must match the unified EvidenceRef schema'
);
assert.deepStrictEqual(
  candidateSchema.$defs.evidenceRef.properties.source_type.enum,
  evidenceSchema.properties.source_type.enum,
  'candidate embedded EvidenceRef provenance types must not drift'
);
assert.deepStrictEqual(
  [...candidateSchema.$defs.evaluation.required].sort(),
  [...evaluationSchema.required].sort(),
  'candidate embedded evaluation required fields must match the evaluation schema'
);
const proposer = { kind: 'agent', id: 'agent:learner', authority_ref: 'local:agent' };
const evaluator = { kind: 'agent', id: 'agent:evaluator', authority_ref: 'local:evaluator' };
const publisher = { kind: 'user', id: 'user:owner', authority_ref: 'local:user-confirmation' };
const rawEvidence = (id) => ({
  schema_version: 'self-learning-evidence-ref-v1',
  source_type: 'behavior_episode',
  source_ref: id,
  immutable_ref: `journal:${id}`,
  digest: `sha256:${(id === 'episode-schema-a' ? 'a' : 'b').repeat(64)}`,
  uri: null,
  final_disposition: 'accepted',
  captured_at: '2026-08-20T00:00:00.000Z',
  scope: { level: 'project', id: EVALUATION_PROJECT_ID },
  redaction_status: 'passed',
  assurance: 'verified',
  signal_strength: 'explicit',
  fact_status: 'fact',
});
const candidate = createLearningCandidate({
  project_id: EVALUATION_PROJECT_ID,
  kind: 'strategy',
  statement: { text: 'Run bounded tests first.', fact_status: 'inference' },
  target: {
    key: 'testing.order',
    source_path: 'docs/testing-order.md',
    source_hash: stableHash({ target: 'testing.order', version: 1 }),
  },
  scope: { level: 'project', id: EVALUATION_PROJECT_ID },
  proposer,
  evidence_refs: [rawEvidence('episode-schema-a'), rawEvidence('episode-schema-b')],
  counterexamples: [],
  occurred_at: '2026-08-20T00:00:00.000Z',
});
assert.deepStrictEqual([...candidateSchema.required].sort(), Object.keys(candidate).sort());
assertSchemaValid(candidate, candidateSchema, 'proposal candidate schema');
for (const sourcePath of ['../testing-order.md', '/docs/testing-order.md', 'docs//testing-order.md']) {
  const invalidTarget = { ...candidate, target: { ...candidate.target, source_path: sourcePath } };
  assert(validateValue(invalidTarget, resolveLocalRefs(candidateSchema, candidateSchema))
    .some((error) => /source_path|pattern/.test(error)), `schema must reject ${sourcePath}`);
}

const evaluationBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-schema-evaluation-'));
const schemaCaseInput = 'validate schema candidate';
const schemaCasePrompt = appendBehaviorEvent(
  resolveStoreDir(evaluationBaseDir, EVALUATION_PROJECT_ID),
  {
    project_id: EVALUATION_PROJECT_ID,
    session_id: 'schema-eval-session',
    task_ref: null,
    turn_ref: 'schema-eval-turn',
    parent_event_id: null,
    actor: { kind: 'user', id: 'user:schema-eval', role: null },
    runtime: 'codex',
    source: 'codex_cli',
    source_assurance: 'explicit',
    scope: { level: 'session', id: 'schema-eval-session' },
    event_type: 'user.prompt',
    signal_strength: 'explicit',
    fact_status: 'fact',
    status: 'observed',
    final_disposition: 'unknown',
    details: { fixture: 'self-learning-schema-evaluation' },
    input_value: schemaCaseInput,
    output_value: null,
    evidence_refs: [],
    occurred_at: '2026-08-20T00:00:30.000Z',
    source_event_id: 'schema-eval-prompt',
  }
);
addCase('schema-eval', {
  id: 'schema-case-1',
  input: schemaCaseInput,
  source_event_ref: schemaCasePrompt.event.event_id,
}, { baseDir: evaluationBaseDir, cwd: process.cwd(), projectId: EVALUATION_PROJECT_ID });
const evaluationAuthority = stageEvaluationArtifactAuthority(
  'schema-eval',
  candidate.candidate_id,
  [{ case_id: 'schema-case-1', passed: true }],
  { baseDir: evaluationBaseDir, cwd: process.cwd(), projectId: EVALUATION_PROJECT_ID }
).authority;

const evaluated = evaluateCandidateState(candidate, {
  expected_candidate_hash: candidate.candidate_hash,
  rubric_version: 'tv-v1',
  truth_score: 0.9,
  value_score: 0.8,
  evaluation_artifact_authority: evaluationAuthority,
  assessor: evaluator,
  evidence_ref_ids: candidate.evidence_refs.map((item) => item.evidence_id),
  counterexamples_reviewed: true,
  assessed_at: '2026-08-20T00:01:00.000Z',
});
assert.deepStrictEqual([...evaluationSchema.required].sort(), Object.keys(evaluated.evaluation).sort());
assertSchemaValid(evaluated.evaluation, evaluationSchema, 'candidate evaluation schema');
assertSchemaValid(evaluated, candidateSchema, 'evaluated candidate schema');

const receipt = {
  schema_version: 'self-learning-approval-receipt-v1',
  receipt_id: `approval-${'a'.repeat(32)}`,
  receipt_hash: `sha256:${'b'.repeat(64)}`,
  candidate_id: candidate.candidate_id,
  candidate_hash: evaluated.candidate_hash,
  evaluation_hash: evaluated.evaluation.evaluation_hash,
  approval_event_ref: {
    event_id: 'bev-approval-schema',
    event_hash: `sha256:${'c'.repeat(64)}`,
  },
  publisher,
  approved_at: '2026-08-20T00:03:00.000Z',
  authority_semantics: 'auditable-local-protocol',
};
assert.deepStrictEqual([...receiptSchema.required].sort(), Object.keys(receipt).sort());
assertSchemaValid(receipt, receiptSchema, 'approval receipt schema');
fs.rmSync(evaluationBaseDir, { recursive: true, force: true });
const tampered = { ...candidate, statement: { ...candidate.statement, unexpected: true } };
assert(validateValue(tampered, resolveLocalRefs(candidateSchema, candidateSchema))
  .some((error) => /additional property unexpected/.test(error)));

console.log('self-learning schema tests passed');
