/**
 * memory-tools.js — Memory MCP tool handlers
 *
 * 每个 handler 接受 JSON args，返回 MCP CallToolResult shape：
 *   { content: [{ type: 'text', text: string }], isError?: boolean }
 *
 * 同一套 handlers 供 memory-mcp-server.js 和未来 CLI / skill 共用。
 * 所有 handler 必须：
 *   - 失败模式静默：fs 错误返 "(no results)"，绝不抛
 *   - 输出脱敏：所有 line/body 经 redactSensitive
 *   - 不写入 observations：MCP 查询本身不应进 memory，避免自指
 */

const fs = require('fs');
const path = require('path');

const {
  detectProjectIdentity,
  collectMemoryEntries,
  mergeMemoryEntries,
  parseFrontmatter,
  redactSensitive,
  topicTitle,
  hashText,
} = require('./memory-v5');
const { resolveCompatReadDirs, resolveBaseDir } = require('./runtime-paths');
const { searchMemory, formatRecallContext } = require('./memory-search');
const {
  assertActionEnabled,
  executeLearningAction,
  resolveLearningContext,
} = require('./self-learning-service');
const {
  checkPublishGuard,
  recordAuthoritativeResult,
  stageCandidateArtifact,
  verifyStagedArtifactForEvaluation,
} = require('./skill-eval-results');
const { detectStableProjectIdentity, findGitRoot } = require('./project-identity');
const { readJournal, resolveStoreDir } = require('./self-learning-store');
const {
  isTrustedUserAuthorityEvent,
  journalActorForEvent,
  normalizeBehaviorEvent,
} = require('./behavior-events');
const {
  canonicalStringify,
  redactCanonicalValue,
  stableHash,
} = require('./self-learning-canonical');

const MCP_LOCAL_ADMIN_OPERATIONS = new Set(['approve', 'promote', 'govern', 'retention']);
const SELF_LEARNING_CONTROL_PREFIX = 'TP_SELF_LEARNING_CONTROL_V1:';

function ok(text) {
  return { content: [{ type: 'text', text: String(text || '') }] };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: `[error] ${message}` }],
    isError: true,
  };
}

function rejectUnknownArgs(args, allowed, label) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return errorResult(`${label} arguments must be an object`);
  }
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  return unknown.length > 0
    ? errorResult(`${label} has unknown argument(s): ${unknown.join(', ')}`)
    : null;
}

function getProjectContext() {
  const project = detectProjectIdentity();
  const baseDirs = resolveCompatReadDirs();
  return { project, baseDirs };
}

function listProjectMemoryDirs(baseDirs, projectId) {
  return baseDirs.map((dir) => path.join(dir, 'projects', projectId, 'memory'));
}

function listProjectSessionsDirs(baseDirs, projectId) {
  return baseDirs.map((dir) => path.join(dir, 'projects', projectId, 'sessions'));
}

function handleSearch(args = {}) {
  const query = String(args.query || args.prompt || '').trim();
  if (!query) return errorResult('missing query');

  const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
  const { project, baseDirs } = getProjectContext();

  const result = searchMemory({
    prompt: query,
    projectId: project.id,
    baseDirs,
    touchedFiles: Array.isArray(args.files) ? args.files : [],
    sprintTags: Array.isArray(args.tags) ? args.tags : [],
    limits: { memoryTop: limit, sessionTop: 2, instinctTop: 3, budgetChars: 4000 },
  });

  return ok(formatRecallContext(result, { budgetChars: 4000 }));
}

function handleRecent(args = {}) {
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
  const { project, baseDirs } = getProjectContext();
  const sessionsDirs = listProjectSessionsDirs(baseDirs, project.id);

  const all = [];
  for (const dir of sessionsDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .forEach((name) => {
          const file = path.join(dir, name);
          let content;
          try {
            content = fs.readFileSync(file, 'utf-8');
          } catch {
            return;
          }
          const { meta, body } = parseFrontmatter(content);
          const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
          all.push({
            name,
            date: dateMatch ? dateMatch[1] : meta.date || '1970-01-01',
            preview: String(body || '').slice(0, 240).replace(/\s+/g, ' ').trim(),
          });
        });
    } catch {}
  }

  const sorted = all
    .sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name))
    .slice(0, limit);

  if (sorted.length === 0) return ok('(no recent sessions)');
  const lines = sorted.map((s) => `- ${s.date} ${s.name}: ${redactSensitive(s.preview)}`);
  return ok(['## Recent Sessions', ...lines].join('\n'));
}

function handleSave(args = {}) {
  const invalidArgs = rejectUnknownArgs(
    args,
    ['body', 'topic', 'confidence', 'user_confirmation_ref'],
    'tp_memory_save'
  );
  if (invalidArgs) return invalidArgs;
  const body = String(args.body || '');
  if (!body.trim()) return errorResult('missing body');
  const safeBody = redactCanonicalValue(body);
  if (typeof safeBody !== 'string' || /[\r\n]/.test(safeBody) || safeBody.length > 4000) {
    return errorResult('body must be one bounded verbatim paragraph after redaction');
  }
  const confirmationRef = typeof args.user_confirmation_ref === 'string'
    ? args.user_confirmation_ref.trim()
    : '';
  if (!confirmationRef) {
    return errorResult(
      'missing user_confirmation_ref; tp_memory_save accepts only user-confirmed verbatim notes'
    );
  }
  if (confirmationRef.length > 512) return errorResult('user_confirmation_ref exceeds 512 characters');

  const topic = String(args.topic || 'general')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40) || 'general';
  const confidence = Math.max(0.3, Math.min(0.95, Number(args.confidence) || 0.7));
  const date = new Date().toISOString().split('T')[0];
  const id = hashText(`${topic}:${safeBody}:${date}`, 12);

  const baseDir = resolveBaseDir();
  const project = detectStableProjectIdentity(process.cwd());
  let journal;
  try {
    journal = readJournal(resolveStoreDir(baseDir, project.id));
  } catch (error) {
    return errorResult(`cannot verify user confirmation journal: ${error.message}`);
  }
  const tombstoned = new Set(journal.records
    .filter((record) => record.record_type === 'tombstone')
    .map((record) => record.entity_id));
  const confirmationRecord = [...journal.records].reverse().find((record) => (
    record.record_type === 'behavior_event'
      && record.entity_id === confirmationRef
      && !tombstoned.has(record.entity_id)
  ));
  if (!confirmationRecord) return errorResult('user_confirmation_ref is not active in the canonical project journal');
  let confirmationEvent;
  try {
    confirmationEvent = normalizeBehaviorEvent(confirmationRecord.payload);
  } catch (error) {
    return errorResult(`user confirmation event is invalid: ${error.message}`);
  }
  const rememberSemantic = { action: 'remember', body: safeBody };
  const expectedCodexDigest = stableHash(redactCanonicalValue(rememberSemantic));
  const expectedClaudeDigest = stableHash(redactCanonicalValue(
    `${SELF_LEARNING_CONTROL_PREFIX}${canonicalStringify(rememberSemantic)}`
  ));
  const expectedJournalActor = journalActorForEvent(confirmationEvent);
  const exactRememberControl = (confirmationEvent.source === 'codex_cli'
      && confirmationEvent.final_disposition === 'accepted'
      && canonicalStringify(confirmationEvent.details) === canonicalStringify(rememberSemantic)
      && confirmationEvent.input_digest === expectedCodexDigest)
    || (confirmationEvent.source === 'claude_hook'
      && confirmationEvent.input_digest === expectedClaudeDigest);
  if (confirmationEvent.project_id !== project.id
      || confirmationRecord.record_id !== confirmationEvent.event_id
      || confirmationRecord.entity_id !== confirmationEvent.event_id
      || confirmationEvent.actor.kind !== 'user'
      || confirmationRecord.actor.kind !== expectedJournalActor.kind
      || confirmationRecord.actor.id !== expectedJournalActor.id
      || confirmationRecord.actor.runtime !== expectedJournalActor.runtime
      || confirmationRecord.actor.authority_ref !== expectedJournalActor.authority_ref
      || !expectedJournalActor.authority_ref
      || !isTrustedUserAuthorityEvent(confirmationEvent, 'memory')
      || !exactRememberControl) {
    return errorResult(
      'user_confirmation_ref is not a trusted same-project remember control bound to this verbatim body'
    );
  }
  const memoryDir = path.join(baseDir, 'projects', project.id, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  const file = path.join(memoryDir, `${topic}.md`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : `# ${topicTitle(topic)}\n\n`;
  const confirmationHash = hashText(`user-confirmation:${confirmationRef}`, 16);
  const entry = `<!-- memory:v5:${id} -->\n- ${date} [${confidence.toFixed(2)}] ${safeBody}\n`
    + `<!-- user-confirmation:${confirmationHash} -->\n\n`;
  fs.writeFileSync(file, existing + entry);

  return ok(
    `saved user-confirmed verbatim memory:v5:${id}`
      + ` confirmation:${confirmationHash} → ${path.relative(baseDir, file)}`
  );
}

function handleFileHistory(args = {}) {
  const targetFile = String(args.file || args.path || '').trim();
  if (!targetFile) return errorResult('missing file');

  const { project, baseDirs } = getProjectContext();
  const memoryDirs = listProjectMemoryDirs(baseDirs, project.id);
  const allEntries = mergeMemoryEntries(memoryDirs.flatMap(collectMemoryEntries));

  const baseName = path.basename(targetFile).toLowerCase();
  const fullPathLower = targetFile.toLowerCase();
  const matched = allEntries.filter((entry) => {
    const line = String(entry.line || '').toLowerCase();
    return line.includes(baseName) || (fullPathLower.length > baseName.length && line.includes(fullPathLower));
  });

  if (matched.length === 0) return ok(`(no memory entries reference ${targetFile})`);

  const lines = matched.slice(0, 10).map((entry) => {
    const note = String(entry.line || '')
      .replace(/^- \d{4}-\d{2}-\d{2}\s+/, '')
      .replace(/^\[\d(?:\.\d+)?\]\s+/, '')
      .trim();
    return `- [${topicTitle(entry.topic)}] ${entry.date} [${entry.confidence.toFixed(2)}] ${redactSensitive(note)}`;
  });
  return ok([`## Memory entries referencing ${targetFile}`, ...lines].join('\n'));
}

function handleProjectProfile() {
  const { project, baseDirs } = getProjectContext();
  const memoryDirs = listProjectMemoryDirs(baseDirs, project.id);
  const allEntries = mergeMemoryEntries(memoryDirs.flatMap(collectMemoryEntries));

  const byTopic = new Map();
  allEntries.forEach((entry) => {
    const key = entry.topic || 'general';
    if (!byTopic.has(key)) byTopic.set(key, { count: 0, maxConfidence: 0, latestDate: '0000-00-00' });
    const slot = byTopic.get(key);
    slot.count++;
    if (entry.confidence > slot.maxConfidence) slot.maxConfidence = entry.confidence;
    if (entry.date > slot.latestDate) slot.latestDate = entry.date;
  });

  const topicLines = [...byTopic.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([topic, slot]) =>
      `- [${topicTitle(topic)}] ${slot.count} entries, top conf ${slot.maxConfidence.toFixed(2)}, latest ${slot.latestDate}`
    );

  const sessionCount = listProjectSessionsDirs(baseDirs, project.id)
    .filter((dir) => fs.existsSync(dir))
    .reduce((sum, dir) => {
      try {
        return sum + fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length;
      } catch {
        return sum;
      }
    }, 0);

  const body = [
    `## Project Profile: ${project.name}`,
    `Project id: ${project.id}`,
    `Memory entries: ${allEntries.length}`,
    `Sessions: ${sessionCount}`,
    '',
    '### By Topic',
    ...(topicLines.length > 0 ? topicLines : ['(no entries)']),
  ].join('\n');
  return ok(body);
}

function learningEnvelope(args, action) {
  const result = executeLearningAction(action, {
    candidate_id: args.candidate_id,
    input: args.input || {},
  }, { entrypoint: 'mcp' });
  return ok(JSON.stringify(result, null, 2));
}

function handleLearningRecord(args = {}) {
  const invalidArgs = rejectUnknownArgs(args, ['kind', 'input'], 'tp_learning_record');
  if (invalidArgs) return invalidArgs;
  const kind = args.kind || 'event';
  if (kind !== 'event') return errorResult('tp_learning_record accepts event only; EvidenceRef is local-authority only');
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
    return errorResult('input object is required');
  }
  return learningEnvelope(args, 'record');
}

function handleLearningClose(args = {}) {
  const invalidArgs = rejectUnknownArgs(args, ['input'], 'tp_learning_close');
  if (invalidArgs) return invalidArgs;
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
    return errorResult('input object is required');
  }
  return learningEnvelope(args, 'close');
}

function handleLearningPropose(args = {}) {
  const invalidArgs = rejectUnknownArgs(args, ['input'], 'tp_learning_propose');
  if (invalidArgs) return invalidArgs;
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
    return errorResult('input object is required');
  }
  return learningEnvelope(args, 'propose');
}

function handleLearningInspect(args = {}) {
  const invalidArgs = rejectUnknownArgs(args, ['view', 'candidate_id'], 'tp_learning_inspect');
  if (invalidArgs) return invalidArgs;
  const view = args.view || 'inspect';
  if (!['inspect', 'context', 'metrics', 'verify-store'].includes(view)) {
    return errorResult('view must be inspect, context, metrics, or verify-store');
  }
  return learningEnvelope(args, view);
}

function handleLearningGovern(args = {}) {
  const invalidArgs = rejectUnknownArgs(
    args,
    ['operation', 'candidate_id', 'input'],
    'tp_learning_govern'
  );
  if (invalidArgs) return invalidArgs;
  const operation = args.operation;
  if (![
    'artifact-stage', 'evaluate', 'shadow', 'approve', 'promote', 'result-record',
    'govern', 'retention', 'publish-guard',
  ].includes(operation)) {
    return errorResult(
      'operation must be artifact-stage, evaluate, shadow, approve, promote, result-record, govern, retention, or publish-guard'
    );
  }
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
    return errorResult('input object is required');
  }
  if (MCP_LOCAL_ADMIN_OPERATIONS.has(operation)) {
    return errorResult(`${operation} is unavailable through MCP; use the trusted local admin CLI`);
  }
  if (operation === 'publish-guard') {
    if (args.candidate_id !== undefined) {
      return errorResult('publish-guard does not accept caller-selected candidate_id');
    }
    const invalidInput = rejectUnknownArgs(args.input, ['name', 'tolerance'], 'publish-guard input');
    if (invalidInput) return invalidInput;
    const name = args.input.name;
    if (typeof name !== 'string' || !name.trim()) {
      return errorResult('publish-guard requires input.name');
    }
    const baseDir = path.resolve(resolveBaseDir());
    const projectId = detectStableProjectIdentity(process.cwd()).id;
    const repoRoot = findGitRoot(process.cwd());
    const result = checkPublishGuard(name.trim(), {
      baseDir,
      projectId,
      repoRoot,
      tolerance: args.input.tolerance,
    });
    const envelope = JSON.stringify({
      context: { base_dir: baseDir, project_id: projectId },
      result,
    }, null, 2);
    return result.status === 'ok' && result.publish_authorized === true
      ? ok(envelope)
      : errorResult(envelope);
  }
  if (['artifact-stage', 'evaluate', 'shadow', 'approve', 'promote', 'result-record'].includes(operation)
      && !args.candidate_id) {
    return errorResult(`${operation} requires candidate_id`);
  }
  if (operation === 'artifact-stage' || operation === 'result-record') {
    const allowed = operation === 'artifact-stage'
      ? ['name', 'content']
      : ['name', 'version'];
    const invalidInput = rejectUnknownArgs(args.input, allowed, `${operation} input`);
    if (invalidInput) return invalidInput;
    if (typeof args.input.name !== 'string' || !args.input.name.trim()) {
      return errorResult(`${operation} requires input.name`);
    }
    const context = resolveLearningContext({}, { entrypoint: 'mcp' });
    assertActionEnabled(operation, context);
    const baseDir = context.base_dir;
    const projectId = context.project_id;
    const result = operation === 'artifact-stage'
      ? stageCandidateArtifact(
        args.input.name.trim(),
        args.candidate_id,
        args.input.content,
        { baseDir, projectId }
      )
      : recordAuthoritativeResult(
        args.input.name.trim(),
        args.candidate_id,
        { baseDir, projectId, version: args.input.version }
      );
    return ok(JSON.stringify({
      context: { base_dir: baseDir, project_id: projectId },
      result,
    }, null, 2));
  }
  if (operation === 'evaluate') {
    verifyStagedArtifactForEvaluation(args.candidate_id, args.input.subject_artifact_hash, {
      baseDir: path.resolve(resolveBaseDir()),
      projectId: detectStableProjectIdentity(process.cwd()).id,
    });
  }
  return learningEnvelope(args, operation);
}

const TOOL_DEFINITIONS = [
  {
    name: 'tp_memory_search',
    description: 'Search Tech Persistence Memory v5 entries / sessions / instincts by prompt or query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (prompt or keywords).' },
        limit: { type: 'integer', description: 'Max memory entries to return (1-20).', default: 5 },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to boost path-match score.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional sprint tags to boost topic-match score.' },
      },
      required: ['query'],
    },
    handler: handleSearch,
  },
  {
    name: 'tp_memory_recent',
    description: 'List the most recent session summaries for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max sessions to return (1-20).', default: 5 },
      },
    },
    handler: handleRecent,
  },
  {
    name: 'tp_memory_save',
    description: 'Save only a user-confirmed verbatim durable note. Never use for inferred learning, automatic Compound output, or agent-authored summaries.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        body: { type: 'string', description: 'Memory body (single short paragraph).' },
        topic: { type: 'string', description: 'Topic slug, e.g. architecture / debugging / workflow.', default: 'general' },
        confidence: { type: 'number', description: 'Confidence 0.3-0.95.', default: 0.7 },
        user_confirmation_ref: {
          type: 'string',
          description: 'Active canonical BehaviorEvent event_id whose explicit user input_digest binds this exact redacted verbatim note.',
        },
      },
      required: ['body', 'user_confirmation_ref'],
    },
    handler: handleSave,
  },
  {
    name: 'tp_memory_file_history',
    description: 'Find memory entries that reference a given file path or basename.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path or basename to search for.' },
      },
      required: ['file'],
    },
    handler: handleFileHistory,
  },
  {
    name: 'tp_memory_project_profile',
    description: 'Show a summary of the current project memory: counts per topic, sessions, top confidence.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: handleProjectProfile,
  },
  {
    name: 'tp_learning_record',
    description: 'Record one weak agent-observed BehaviorEvent. MCP cannot mint user authority, verified results, or EvidenceRefs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['event'], default: 'event' },
        input: { type: 'object', description: 'BehaviorEvent observation input; authority fields are server-bound.' },
      },
      required: ['input'],
    },
    handler: handleLearningRecord,
  },
  {
    name: 'tp_learning_close',
    description: 'Close a task/session BehaviorEpisode from authoritative events and record its EvidenceRef.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'object', description: 'Episode identity, timestamp, and journal actor.' },
      },
      required: ['input'],
    },
    handler: handleLearningClose,
  },
  {
    name: 'tp_learning_propose',
    description: 'Propose a scoped LearningCandidate from EvidenceRefs already committed to the authority journal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'object', description: 'LearningCandidate proposal input.' },
      },
      required: ['input'],
    },
    handler: handleLearningPropose,
  },
  {
    name: 'tp_learning_inspect',
    description: 'Inspect provenance, TV, counterexamples, lifecycle, context, metrics, or journal integrity.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: { type: 'string', enum: ['inspect', 'context', 'metrics', 'verify-store'], default: 'inspect' },
        candidate_id: { type: 'string' },
      },
    },
    handler: handleLearningInspect,
  },
  {
    name: 'tp_learning_govern',
    description: 'Stage a canonical candidate artifact, evaluate, shadow, explicitly approve, promote, derive a v3 result record, validate the authoritative publish guard, correct, expire, tombstone, or apply retention; never auto-publishes runtime assets.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: {
          type: 'string',
          enum: [
            'artifact-stage', 'evaluate', 'shadow', 'approve', 'promote', 'result-record',
            'govern', 'retention', 'publish-guard',
          ],
        },
        candidate_id: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['operation', 'input'],
    },
    handler: handleLearningGovern,
  },
];

function listToolsForMcp() {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

function callTool(name, args) {
  const def = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def) return errorResult(`unknown tool: ${name}`);
  try {
    return def.handler(args || {});
  } catch (err) {
    return errorResult(`handler failed: ${err.message || err}`);
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  callTool,
  listToolsForMcp,
  handleSearch,
  handleRecent,
  handleSave,
  handleFileHistory,
  handleProjectProfile,
  handleLearningRecord,
  handleLearningClose,
  handleLearningPropose,
  handleLearningInspect,
  handleLearningGovern,
};
