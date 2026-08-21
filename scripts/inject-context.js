#!/usr/bin/env node

/**
 * inject-context.js — SessionStart Hook 上下文注入
 *
 * 在每次新会话开始时：
 *   1. 检测未完成的 sprint handoff 文件（最高优先）
 *   2. 加载最近 N 个会话摘要
 *   3. 仅自动加载 promoted LearningCandidate
 *   4. 将历史高置信度本能作为明确的 legacy 兼容层加载
 *   5. 格式化后通过 hookSpecificOutput.additionalContext 注入
 */

const fs = require('fs');
const path = require('path');
const {
  resolveBaseDir,
  resolveCompatReadDirs,
  resolvePlanDirectories,
  resolveProjectPlansDir,
} = require('./lib/runtime-paths');
const {
  DEFAULT_MEMORY_CONFIG,
  detectProjectIdentity,
  loadUnifiedMemoryIndex,
  parseFrontmatter,
  recordMemoryRecallMetric,
} = require('./lib/memory-v5');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { normalizeTimestamp } = require('./lib/self-learning-canonical');
const { writeInjectedManifest, readLatestRecallUsage } = require('./lib/recall-usage');
const {
  executeLearningAction,
  filterCandidatesForContext,
  loadSelfLearningPolicy,
} = require('./lib/self-learning-service');

const CONTEXT_BUDGET_CHARS = 12000;
const MAX_SESSION_START_INPUT_BYTES = 64 * 1024;

function resolveLearningBaseDir(explicit = null) {
  const managed = explicit || process.env.TP_SELF_LEARNING_BASE_DIR;
  if (!managed) return resolveBaseDir();
  if (typeof managed !== 'string' || !path.isAbsolute(managed)) {
    const error = new Error('managed self-learning base directory must be absolute');
    error.code = 'SELF_LEARNING_BASE_DIR_INVALID';
    throw error;
  }
  return path.resolve(managed);
}

function runtimeDiagnostic(reason, error = null) {
  const safeReason = String(reason || 'runtime-error')
    .replace(/[^a-z0-9-]/gi, '-')
    .slice(0, 96);
  const code = error && typeof error.code === 'string'
    ? String(error.code).replace(/[^a-z0-9_-]/gi, '').slice(0, 64)
    : error && typeof error.name === 'string'
      ? String(error.name).replace(/[^a-z0-9_-]/gi, '').slice(0, 64)
      : null;
  try {
    process.stderr.write(
      `[inject-context] ${safeReason}${code ? ` (${code})` : ''}\n`.slice(0, 256)
    );
  } catch {}
}

function readSessionStartInputBounded(maximumBytes = MAX_SESSION_START_INPUT_BYTES) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(4096);
  let total = 0;
  while (true) {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > maximumBytes) return { oversized: true, text: '' };
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return { oversized: false, text: Buffer.concat(chunks).toString('utf8') };
}

function boundedIdentity(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function explicitSessionEnvironmentValues(env) {
  const runtime = String(env.TECH_PERSISTENCE_RUNTIME || '').toLowerCase();
  if (runtime === 'claude') return [env.CLAUDE_SESSION_ID];
  if (runtime === 'codex') return [env.CODEX_SESSION_ID];
  return [env.CODEX_SESSION_ID, env.CLAUDE_SESSION_ID];
}

function parseSessionStartInvocation(raw, env = process.env) {
  let payload = {};
  if (typeof raw === 'string' && raw.trim() !== '') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_SESSION_START_INPUT_BYTES) {
      return { status: 'error', reason: 'session-start-payload-too-large' };
    }
    try {
      payload = JSON.parse(raw);
    } catch {
      return { status: 'error', reason: 'invalid-session-start-payload' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 'error', reason: 'invalid-session-start-payload' };
    }
    if (payload.hook_event_name && payload.hook_event_name !== 'SessionStart') {
      return { status: 'skipped', reason: 'unsupported-hook-event' };
    }
  }
  const payloadSessions = [...new Set([
    boundedIdentity(payload.session_id),
    boundedIdentity(payload.sessionId),
  ].filter(Boolean))];
  if (payloadSessions.length > 1) {
    return { status: 'error', reason: 'session-identity-mismatch' };
  }
  const payloadSession = payloadSessions[0] || null;
  if ((payload.session_id !== undefined || payload.sessionId !== undefined) && !payloadSession) {
    return { status: 'error', reason: 'invalid-session-identity' };
  }
  const envSessions = [...new Set(
    explicitSessionEnvironmentValues(env).map(boundedIdentity).filter(Boolean)
  )];
  if ((payloadSession && envSessions.some((value) => value !== payloadSession))
      || (!payloadSession && envSessions.length > 1)) {
    return { status: 'error', reason: 'session-identity-mismatch' };
  }
  const payloadTasks = [...new Set([
    boundedIdentity(payload.task_ref),
    boundedIdentity(payload.task_id),
    boundedIdentity(payload.taskRef),
    boundedIdentity(payload.taskId),
  ].filter(Boolean))];
  if (payloadTasks.length > 1) {
    return { status: 'error', reason: 'task-identity-mismatch' };
  }
  const payloadTask = payloadTasks[0] || null;
  if ((payload.task_ref !== undefined || payload.task_id !== undefined
      || payload.taskRef !== undefined || payload.taskId !== undefined)
      && !payloadTask) {
    return { status: 'error', reason: 'invalid-task-identity' };
  }
  const envTask = boundedIdentity(env.TP_SELF_LEARNING_TASK_REF);
  if (payloadTask && envTask && payloadTask !== envTask) {
    return { status: 'error', reason: 'task-identity-mismatch' };
  }
  const suppliedTimes = [...new Set([
    boundedIdentity(payload.occurred_at),
    boundedIdentity(payload.timestamp),
  ].filter(Boolean))];
  if (suppliedTimes.length > 1) {
    return { status: 'error', reason: 'occurred-at-mismatch' };
  }
  if ((payload.occurred_at !== undefined || payload.timestamp !== undefined)
      && suppliedTimes.length === 0) {
    return { status: 'error', reason: 'invalid-occurred-at' };
  }
  const suppliedTime = suppliedTimes[0] || null;
  let now = suppliedTime || new Date().toISOString();
  try {
    now = normalizeTimestamp(now, 'SessionStart occurred_at');
  } catch {
    return { status: 'error', reason: 'invalid-occurred-at' };
  }
  return {
    status: 'ready',
    payload,
    sessionId: payloadSession || envSessions[0] || null,
    taskRef: payloadTask || envTask || null,
    now,
  };
}

function resolveManagedProjectAuthority(payload, cwd, env = process.env) {
  const trustedCwd = path.resolve(cwd || process.cwd());
  const trustedProject = detectStableProjectIdentity(trustedCwd);
  const managedProjectId = boundedIdentity(env.TP_SELF_LEARNING_PROJECT_ID);
  if (env.TP_SELF_LEARNING_PROJECT_ID && !managedProjectId) {
    const error = new Error('managed project identity is invalid');
    error.code = 'SELF_LEARNING_PROJECT_MISMATCH';
    throw error;
  }
  const projectId = managedProjectId || trustedProject.id;
  if (managedProjectId && managedProjectId !== trustedProject.id) {
    const error = new Error('managed project identity does not match trusted cwd');
    error.code = 'SELF_LEARNING_PROJECT_MISMATCH';
    throw error;
  }
  const payloadProjectIds = [...new Set([
    boundedIdentity(payload && payload.project_id),
    boundedIdentity(payload && payload.projectId),
  ].filter(Boolean))];
  const suppliedPayloadProject = payload && (
    payload.project_id !== undefined || payload.projectId !== undefined
  );
  if ((suppliedPayloadProject && payloadProjectIds.length === 0)
      || payloadProjectIds.length > 1
      || (payloadProjectIds[0] && payloadProjectIds[0] !== projectId)) {
    const error = new Error('payload project identity mismatch');
    error.code = 'SELF_LEARNING_PROJECT_MISMATCH';
    throw error;
  }
  if (payload && payload.cwd !== undefined) {
    if (typeof payload.cwd !== 'string'
        || detectStableProjectIdentity(payload.cwd).id !== projectId) {
      const error = new Error('payload cwd project identity mismatch');
      error.code = 'SELF_LEARNING_PROJECT_MISMATCH';
      throw error;
    }
  }
  return { projectId, trustedCwd };
}

function loadInstincts(dir, minConfidence) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const meta = {};
      match[1].split('\n').forEach(line => {
        const [key, ...vals] = line.split(':');
        if (key && vals.length) meta[key.trim()] = vals.join(':').trim().replace(/^["']|["']$/g, '');
      });
      meta.body = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
      return meta;
    })
    .filter(inst => inst && parseFloat(inst.confidence) >= minConfidence)
    .sort((a, b) => parseFloat(b.confidence) - parseFloat(a.confidence));
}

/**
 * 加载 persona.md（用户统一画像）— first-hit 模式
 *
 * Persona 是项目级单文件，5 字段结构（role / preferences / non-negotiables /
 * communication-style / known-context）。不合并多个 compat dir，避免同字段冲突。
 *
 * 跨项目复用：用户可在 OS 层 symlink `~/.claude/persona.md` 到任一项目的 persona.md，
 * 或反向 symlink。代码不感知 symlink，按普通文件读取即可。
 *
 * @param {string[]} memoryDirs - 候选 memory 目录列表
 * @returns {string} persona body（去除 frontmatter），无文件时返回 ''
 */
function loadPersonaBody(memoryDirs) {
  for (const dir of memoryDirs) {
    const personaPath = path.join(dir, 'persona.md');
    if (!fs.existsSync(personaPath)) continue;
    const content = fs.readFileSync(personaPath, 'utf-8');
    const { body } = parseFrontmatter(content);
    if (body) return body;
  }
  return '';
}

function loadRecentSessions(sessionsDir, limit = 5) {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .slice(-limit)
    .map(f => fs.readFileSync(path.join(sessionsDir, f), 'utf-8'))
    .reverse();
}

function loadRecentSessionsWithFallback(baseDirs, relativeParts, limit = 5) {
  for (const baseDir of baseDirs) {
    const sessions = loadRecentSessions(path.join(baseDir, ...relativeParts), limit);
    if (sessions.length > 0) return sessions;
  }
  return [];
}

function loadInstinctsWithFallback(baseDirs, relativeParts, minConfidence) {
  for (const baseDir of baseDirs) {
    const instincts = loadInstincts(path.join(baseDir, ...relativeParts), minConfidence);
    if (instincts.length > 0) return instincts;
  }
  return [];
}

function promotedCandidatesFromContextPayload(payload, identity = {}) {
  const value = payload && payload.result ? payload.result : payload;
  const automatic = value && (value.automatic_context || value.auto_context);
  const candidates = Array.isArray(automatic)
    ? automatic
    : Array.isArray(automatic && automatic.promoted)
      ? automatic.promoted
      : Array.isArray(value && value.promoted_candidates)
        ? value.promoted_candidates
        : Array.isArray(value && value.context && value.context.promoted)
          ? value.context.promoted
          : [];
  const structurallyPromoted = candidates.filter((candidate) => candidate
    && candidate.status === 'promoted'
    && (candidate.effective_status === undefined || candidate.effective_status === 'promoted')
    && candidate.statement
    && typeof candidate.statement.text === 'string'
    && candidate.statement.text.trim());
  const executionContext = payload && payload.context ? payload.context : {};
  return filterCandidatesForContext(structurallyPromoted, {
    project_id: identity.project_id || executionContext.project_id || (value && value.project_id),
    session_id: identity.session_id,
    task_ref: identity.task_ref,
    personal_id: identity.personal_id,
    global_id: identity.global_id,
    team_id: identity.team_id,
    now: identity.now,
    retention_days: identity.retention_days
      || (executionContext.policy && executionContext.policy.retention_days),
  });
}

function isSelfLearningReaderEnabled(baseDir) {
  try {
    const policy = loadSelfLearningPolicy(baseDir);
    return policy.enabled && policy.reader_enabled && policy.mode !== 'off';
  } catch {
    return false;
  }
}

function isLegacyReaderEnabled(baseDir) {
  try {
    return loadSelfLearningPolicy(baseDir).legacy_reader_enabled === true;
  } catch {
    return false;
  }
}

function loadPromotedCandidateContext(options = {}) {
  const baseDir = resolveLearningBaseDir(options.baseDir);
  const readerEnabled = options.readerEnabled === undefined
    ? isSelfLearningReaderEnabled(baseDir)
    : options.readerEnabled === true;
  if (!readerEnabled) return [];
  const executeAction = options.executeLearningAction || executeLearningAction;
  const now = options.now || new Date().toISOString();
  try {
    const payload = executeAction('context', {
      base_dir: baseDir,
      ...(options.projectId ? { project_id: options.projectId } : {}),
      cwd: options.cwd || process.cwd(),
      input: {
        session_id: options.sessionId,
        task_ref: options.taskRef,
        personal_id: options.personalId,
        global_id: options.globalId,
        team_id: options.teamId,
        now,
      },
    });
    return promotedCandidatesFromContextPayload(payload, {
      project_id: options.projectId || (payload.context && payload.context.project_id),
      session_id: options.sessionId,
      task_ref: options.taskRef,
      personal_id: options.personalId,
      global_id: options.globalId,
      team_id: options.teamId,
      now,
      retention_days: payload.context
        && payload.context.policy
        && payload.context.policy.retention_days,
    });
  } catch (error) {
    // SessionStart 必须 fail closed：损坏/不可读 journal 不降级注入 shadow 或 legacy candidate。
    if (typeof options.onError === 'function') {
      options.onError({
        reason: 'candidate-store-read-failed',
        code: error && typeof error.code === 'string' ? error.code : null,
      });
    }
    return [];
  }
}

function renderPromotedCandidateLines(candidates, limit = 10) {
  return candidates.slice(0, limit).map((candidate) => {
    const scope = candidate.scope && candidate.scope.level
      ? `${candidate.scope.level}:${candidate.scope.id || '?'}`
      : 'unknown';
    const kind = candidate.kind || 'unknown';
    const target = candidate.target && candidate.target.key
      ? ` -> ${candidate.target.key}`
      : '';
    return `- [${kind}] [${scope}] ${candidate.statement.text.trim()}${target}`;
  });
}

function addSection(sections, title, body, maxChars) {
  if (!body) return;
  sections.push({
    title,
    body: String(body).trim().slice(0, maxChars),
  });
}

function renderSectionsWithStats(sections, budgetChars = CONTEXT_BUDGET_CHARS) {
  let remaining = budgetChars;
  const rendered = [];
  const sectionStats = [];
  let sourceChars = 0;
  let injectedChars = 0;

  for (const section of sections) {
    const sourceBody = String(section.body || '').trim();
    const heading = `## ${section.title}\n\n`;
    const selectedChars = heading.length + sourceBody.length;
    sourceChars += selectedChars;
    if (remaining <= 0) {
      sectionStats.push({
        title: section.title,
        sourceChars: selectedChars,
        injectedChars: 0,
        truncated: sourceBody.length > 0,
      });
      continue;
    }
    const available = Math.max(0, remaining - heading.length);
    const body = sourceBody.slice(0, available).trim();
    if (!body) {
      sectionStats.push({
        title: section.title,
        sourceChars: selectedChars,
        injectedChars: 0,
        truncated: sourceBody.length > 0,
      });
      continue;
    }
    const block = `${heading}${body}`;
    rendered.push(block);
    injectedChars += block.length;
    sectionStats.push({
      title: section.title,
      sourceChars: selectedChars,
      injectedChars: block.length,
      truncated: body.length < sourceBody.length,
    });
    remaining -= block.length + 2;
  }

  return {
    text: rendered.join('\n\n'),
    stats: {
      budgetChars,
      sourceChars,
      injectedChars,
      estimatedTokens: Math.ceil(injectedChars / 4),
      selectedSections: sections.length,
      injectedSections: sectionStats.filter((s) => s.injectedChars > 0).length,
      truncatedSections: sectionStats.filter((s) => s.truncated).map((s) => s.title),
      sections: sectionStats,
    },
  };
}

function renderSections(sections) {
  return renderSectionsWithStats(sections).text;
}

function shouldIncludeContextCostSummary(stats, env = process.env) {
  const flag = String(env.TECH_PERSISTENCE_CONTEXT_COST_SUMMARY || '').toLowerCase();
  if (['1', 'true', 'yes', 'always'].includes(flag)) return true;
  if (!stats || !stats.budgetChars) return false;
  return stats.injectedChars >= Math.floor(stats.budgetChars * 0.8)
    || stats.truncatedSections.length > 0;
}

function renderContextCostSummary(stats) {
  const truncated = stats.truncatedSections.slice(0, 3);
  const truncatedText = truncated.length > 0
    ? `; truncated=${truncated.join(', ')}${stats.truncatedSections.length > truncated.length ? ', ...' : ''}`
    : '';
  return [
    `context=${stats.injectedChars}/${stats.budgetChars} chars`,
    `~${stats.estimatedTokens} tokens`,
    `sections=${stats.injectedSections}/${stats.selectedSections}`,
    `selected=${stats.sourceChars} chars${truncatedText}`,
  ].join('; ');
}

function renderContextWithOptionalCostSummary(sections, projectName, env = process.env, extras = {}) {
  let rendered = renderSectionsWithStats(sections);
  let finalSections = sections;
  if (shouldIncludeContextCostSummary(rendered.stats, env)) {
    let summary = renderContextCostSummary(rendered.stats);
    if (extras.demandSideLine) summary += `\n${extras.demandSideLine}`;
    finalSections = [{ title: 'Context cost summary', body: summary }, ...sections];
    rendered = renderSectionsWithStats(finalSections);
  }
  return `<learned-context project="${projectName}">
${rendered.text}
</learned-context>`;
}

const HANDOFF_FILE_RE = /(?:^session-.+-handoff|-handoff-\d+(?:-compact)?)\.md$/;

function listHandoffCandidates(dir, displayPrefix) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && HANDOFF_FILE_RE.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        return {
          fullPath,
          displayPath: `${displayPrefix}/${entry.name}`,
          mtimeMs: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.displayPath.localeCompare(a.displayPath));
  } catch {
    return [];
  }
}

/**
 * 检测未完成的 sprint/session handoff 文件。
 * 优先读取 docs/plans/.handoff/，仅为兼容历史数据回退到 docs/plans/ 顶层。
 */
function detectPendingHandoff(options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const plansDir = options.plansDir || path.join(repoRoot, 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return null;

  const candidateGroups = [
    listHandoffCandidates(path.join(plansDir, '.handoff'), 'docs/plans/.handoff'),
    listHandoffCandidates(plansDir, 'docs/plans'),
  ];

  for (const candidates of candidateGroups) {
    for (const candidate of candidates) {
      let content;
      try {
        content = fs.readFileSync(candidate.fullPath, 'utf-8');
      } catch {
        continue;
      }

      // 检查关联的 sprint 文档是否还是 in-progress/checkpoint 状态。
      const sprintDocMatch = content.match(/sprint_doc:\s*"?([^"\n]+)"?/);
      if (sprintDocMatch) {
        const sprintDocPath = path.join(repoRoot, sprintDocMatch[1]);
        if (fs.existsSync(sprintDocPath)) {
          const sprintContent = fs.readFileSync(sprintDocPath, 'utf-8');
          if (sprintContent.match(/status:\s*completed/)) continue;
        }
      }

      return { file: candidate.displayPath, content };
    }
  }

  return null;
}

/**
 * 探测当前活跃 sprint 文档的 tags，用于按相关性排序 MEMORY.md entries。
 *
 * 行为：扫描 plansDir 下 status: planning / in-progress / reviewing / active 的最新文档，
 * 解析 frontmatter 的 tags 数组返回。
 *
 * 注意：返回的 tags 用作 selectMemoryIndexEntries 的 prioritizeTopics — 此处是
 * **近似匹配**（sprint tags 与 memory topic 名按字符串相等比较，大小写不敏感）。
 * Memory entry 本身没有显式 tag 字段，topic 来自文件名（debugging / performance / ...）。
 * 仅当 sprint tag 字面命中 memory topic name 才生效，未命中时不影响原排序。
 *
 * @param {string} [plansDir] - plans 目录路径（测试用，默认 cwd/docs/plans）
 * @returns {string[]} tags 数组，无 active sprint 或无 tags 时返回 []
 */
function normalizeFrontmatterScalar(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
}

function parseInlineFrontmatterList(value) {
  const match = String(value || '').match(/^\[([^\]]+)\]$/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function detectActiveSprintTags(plansDir = path.join(process.cwd(), 'docs', 'plans')) {
  if (!fs.existsSync(plansDir)) return [];

  let planFiles;
  try {
    planFiles = fs.readdirSync(plansDir)
      .filter((f) => f.endsWith('.md') && !f.includes('-handoff-') && f !== 'TEMPLATE.md')
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const activeStatuses = new Set(['planning', 'in-progress', 'in_progress', 'reviewing', 'active']);

  for (const file of planFiles) {
    let content;
    try {
      content = fs.readFileSync(path.join(plansDir, file), 'utf-8');
    } catch {
      continue;
    }
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const { meta } = parseFrontmatter(content);
    const status = normalizeFrontmatterScalar(meta.status);
    if (!status || !activeStatuses.has(status)) continue;

    return parseInlineFrontmatterList(meta.tags);
  }
  return [];
}

/**
 * 检测未完成的 prototype 收敛状态
 */
function detectPendingPrototype() {
  for (const plansLocation of resolvePlanDirectories()) {
    const plansDir = plansLocation.path;
    if (!fs.existsSync(plansDir)) continue;

    const statuses = fs.readdirSync(plansDir)
      .filter(f => f.startsWith('prototype-') && f.endsWith('-status.md'))
      .sort()
      .reverse();

    if (statuses.length === 0) continue;

    const latest = statuses[0];
    const content = fs.readFileSync(path.join(plansDir, latest), 'utf-8');

    // Skip converged prototype status files.
    if (content.includes('收敛完成') || content.includes('converged')) continue;

    return {
      file: latest,
      displayPath: `${plansLocation.displayPath}/${latest}`,
      sourceType: plansLocation.sourceType,
      content: content.slice(0, 500),
    };
  }

  return null;
}

function main(options = {}) {
  let baseDir;
  let policy;
  try {
    baseDir = resolveLearningBaseDir(options.baseDir);
    policy = loadSelfLearningPolicy(baseDir);
  } catch (error) {
    runtimeDiagnostic(
      error && error.code === 'SELF_LEARNING_CONFIG_INVALID'
        ? 'invalid-policy'
        : 'runtime-config-failed',
      error
    );
    return { status: 'error', reason: 'invalid-policy' };
  }

  let startInput;
  try {
    startInput = options.input === undefined
      ? readSessionStartInputBounded()
      : { oversized: false, text: String(options.input) };
  } catch (error) {
    runtimeDiagnostic('session-start-input-read-failed', error);
    return { status: 'error', reason: 'session-start-input-read-failed' };
  }
  if (startInput.oversized) {
    runtimeDiagnostic('session-start-payload-too-large');
    return { status: 'error', reason: 'session-start-payload-too-large' };
  }
  const invocation = parseSessionStartInvocation(
    startInput.text,
    options.env || process.env
  );
  if (invocation.status === 'skipped') return invocation;
  if (invocation.status !== 'ready') {
    runtimeDiagnostic(invocation.reason);
    return invocation;
  }

  let authority;
  try {
    authority = resolveManagedProjectAuthority(
      invocation.payload,
      options.cwd || process.cwd(),
      options.env || process.env
    );
  } catch (error) {
    runtimeDiagnostic('project-identity-mismatch', error);
    return { status: 'error', reason: 'project-identity-mismatch' };
  }
  const cwd = authority.trustedCwd;
  const project = detectProjectIdentity(cwd);
  const learningProjectId = authority.projectId;
  const sessionId = options.sessionId || invocation.sessionId || null;
  const taskRef = options.taskRef || invocation.taskRef || null;
  const now = options.now || invocation.now;
  const legacyReaderEnabled = policy.legacy_reader_enabled === true;
  const selfLearningReaderEnabled = policy.enabled
    && policy.reader_enabled
    && policy.mode !== 'off';
  const compatReadDirs = resolveCompatReadDirs();

  const sections = [];

  // 0. 未完成的 sprint handoff（最高优先）
  const handoff = detectPendingHandoff();
  if (handoff) {
    addSection(
      sections,
      '未完成的 Sprint (从 checkpoint 恢复)',
      `文件: ${handoff.file}\n\n${handoff.content}`,
      1500
    );
  }

  // 0b. 未完成的 prototype 收敛
  const prototype = detectPendingPrototype();
  if (prototype) {
    addSection(
      sections,
      '未完成的原型收敛',
      `文件: ${prototype.displayPath}\nsourceType: ${prototype.sourceType}\n\n${prototype.content}`,
      700
    );
  }

  // 0c. Persona（用户统一画像）— 500 字节单独预算，先于 memory index 注入
  // Why: persona 是跨会话稳定的低频信号，不应被 memory index 的 entry 排挤
  const personaBody = legacyReaderEnabled
    ? loadPersonaBody(
      compatReadDirs.map(compatDir => path.join(compatDir, 'projects', project.id, 'memory'))
    )
    : '';
  if (personaBody) {
    addSection(sections, 'Persona (用户画像)', personaBody, 900);
  }

  // 0d. Memory v5: merge compatible runtime stores instead of shadowing by first hit
  // 按当前活跃 sprint 的 tags 重排 entries — 命中条目排前，与 sprint 主题更相关的经验先进入上下文
  const sprintTags = detectActiveSprintTags();
  const memoryDirs = compatReadDirs.map(baseDir => path.join(baseDir, 'projects', project.id, 'memory'));
  const memoryIndex = legacyReaderEnabled
    ? loadUnifiedMemoryIndex(
      memoryDirs,
      DEFAULT_MEMORY_CONFIG,
      { prioritizeTopics: sprintTags }
    )
    : '';
  if (legacyReaderEnabled) {
    try {
      recordMemoryRecallMetric(memoryDirs, DEFAULT_MEMORY_CONFIG, {
        project,
        prioritizeTopics: sprintTags,
        telemetryDir: path.join(baseDir, 'telemetry'),
      });
    } catch (error) {
      runtimeDiagnostic('legacy-recall-telemetry-failed', error);
    }
  }
  if (memoryIndex) {
    addSection(
      sections,
      'Legacy Auto Memory v5 (兼容层)',
      memoryIndex,
      DEFAULT_MEMORY_CONFIG.indexMaxBytes
    );
  }

  // 1. 近期会话摘要
  const sessions = legacyReaderEnabled
    ? loadRecentSessionsWithFallback(
      compatReadDirs,
      ['projects', project.id, 'sessions'],
      3
    )
    : [];
  if (sessions.length > 0) {
    addSection(sections, `近期会话 (${project.name})`, sessions.join('\n---\n'), 3000);
  }

  // 2. 新治理链：只有 promoted Candidate 能进入自动上下文。
  // shadow/proposed/evaluated/approved 均由 context reader 排除，并在此二次校验。
  const promotedCandidates = loadPromotedCandidateContext({
    baseDir,
    cwd,
    projectId: learningProjectId,
    sessionId,
    taskRef,
    now,
    readerEnabled: selfLearningReaderEnabled,
    onError(failure) {
      runtimeDiagnostic(
        failure.reason,
        failure.code ? { code: failure.code } : null
      );
    },
  });
  if (promotedCandidates.length > 0) {
    addSection(
      sections,
      '已批准并提升的 Learning Candidates',
      renderPromotedCandidateLines(promotedCandidates).join('\n'),
      1800
    );
  }

  // 3. Legacy 兼容层：历史本能独立展示，不与新 Candidate 生命周期混合。
  const projectInstincts = legacyReaderEnabled
    ? loadInstinctsWithFallback(
      compatReadDirs,
      ['projects', project.id, 'instincts'],
      0.5
    )
    : [];
  if (projectInstincts.length > 0) {
    const instinctLines = projectInstincts.slice(0, 10).map(inst => {
      const conf = parseFloat(inst.confidence).toFixed(1);
      const flag = parseFloat(inst.confidence) >= 0.7 ? '🟢' : '🟡';
      return `- ${flag} [${conf}] [${inst.domain || '?'}] ${inst.trigger || inst.id}`;
    });
    addSection(sections, 'Legacy 项目本能 (兼容层)', instinctLines.join('\n'), 1600);
  }

  // 4. 高置信度全局 legacy 本能 (>=0.7)
  const globalInstincts = legacyReaderEnabled
    ? loadInstinctsWithFallback(
      compatReadDirs,
      ['instincts', 'personal'],
      0.7
    )
    : [];
  if (globalInstincts.length > 0) {
    const instinctLines = globalInstincts.slice(0, 5).map(inst => {
      const conf = parseFloat(inst.confidence).toFixed(1);
      return `- 🟢 [${conf}] [${inst.domain || '?'}] ${inst.trigger || inst.id}`;
    });
    addSection(sections, 'Legacy 全局本能 (兼容层)', instinctLines.join('\n'), 1000);
  }

  // 5. demand-side 召回 manifest：记录本次注入了哪些 legacy instinct domain（measure-before-enforce）。
  // WHY: 现有 recall 指标只测「注入了多少进索引」（供给侧）；此 manifest 让 Stop hook 能算
  // 「注入的 domain 本会话有没有被碰到」（需求侧）。只记 domain 名 + 计数，无 body 文本。
  if (legacyReaderEnabled) {
    try {
      const injectedInstincts = [...projectInstincts.slice(0, 10), ...globalInstincts.slice(0, 5)];
      writeInjectedManifest(path.join(baseDir, 'telemetry'), {
        session_id: sessionId || '',
        project_id: project.id,
        timestamp: now,
        injected_domains: injectedInstincts.map((inst) => inst.domain).filter(Boolean),
        injected_instinct_count: injectedInstincts.length,
      });
    } catch (error) {
      runtimeDiagnostic('legacy-manifest-write-failed', error);
    }
  }

  if (sections.length === 0) {
    return { status: 'skipped', reason: 'no-context' };
  }

  // demand-side 召回信号消费点 1：上次会话使用率附到 cost summary（高频可见）。
  // WHY: 让「注入的 domain 上次有没有被碰到」在压力大的会话（cost summary 触发时）可见。
  let demandSideLine = '';
  try {
    const latest = legacyReaderEnabled
      ? readLatestRecallUsage(path.join(baseDir, 'telemetry'))
      : null;
    if (latest && (latest.injected_domain_count > 0 || latest.active_retrieval_count > 0)) {
      const rate = latest.usage_rate === null ? 'n/a' : `${Math.round(latest.usage_rate * 100)}%`;
      const dormant = Array.isArray(latest.dormant_domains) && latest.dormant_domains.length > 0
        ? `; dormant=${latest.dormant_domains.join(', ')}`
        : '';
      const retrieval = Number.isFinite(latest.active_retrieval_count) && latest.active_retrieval_count > 0
        ? `; active-retrieval=${latest.active_retrieval_count}`
        : '';
      demandSideLine = `prior-session demand-side recall: ${latest.used_domain_count}/${latest.injected_domain_count} domains used (${rate})${dormant}${retrieval}`;
    }
  } catch {}

  const context = renderContextWithOptionalCostSummary(
    sections,
    project.name,
    options.env || process.env,
    { demandSideLine }
  );

  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context
    }
  });
  console.log(output);
  return { status: 'injected', section_count: sections.length };
}

// 只在直接作为脚本运行时跑 main；被 require 时仅 export 函数供测试。
if (require.main === module) {
  try {
    main();
  } catch (error) {
    runtimeDiagnostic('runtime-failed', error);
  }
  process.exitCode = 0;
}

module.exports = {
  detectPendingPrototype,
  detectPendingHandoff,
  detectActiveSprintTags,
  isLegacyReaderEnabled,
  isSelfLearningReaderEnabled,
  loadPromotedCandidateContext,
  main,
  parseSessionStartInvocation,
  readSessionStartInputBounded,
  resolveManagedProjectAuthority,
  promotedCandidatesFromContextPayload,
  renderSections,
  renderSectionsWithStats,
  renderPromotedCandidateLines,
  shouldIncludeContextCostSummary,
  renderContextCostSummary,
  renderContextWithOptionalCostSummary,
  runtimeDiagnostic,
};
