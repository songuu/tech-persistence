'use strict';

/**
 * recall-usage.js — demand-side 召回使用率信号（measure-before-enforce）
 *
 * WHY：现有 memory-recall.jsonl 的 hit_rate = indexed_entries / total_entries，
 * 是「供给侧覆盖率」（注入了多少进 12KB 索引），完全没有衡量
 * 「注入的知识有没有被实际用上」。本 lib 提供 demand-side 粗粒度信号：
 *   - SessionStart：记录本次注入了哪些 domain（instinct domain 集合）→ manifest
 *   - Stop：从 observations 推断本会话实际触及的 domain，算交集 → usage 信号
 *
 * 定位（重要，避免误读为精确度量）：
 *   - 这是「粗粒度退化探测」，核心产物是 dormant_domains（注入了但本会话没碰）。
 *   - inferSessionDomains 故意「宽松」（宁可多算碰到，少误报沉睡）。
 *   - 「语义遵守」（模型是否真按本能行动）测不到（ADR-017 边界），不在本 lib 范围。
 *   - 本 lib 只 measure，不做任何 enforcement（ADR-013/ADR-021 教训：先证价值再下沉）。
 */

const fs = require('fs');
const path = require('path');
const { stripPrivateTags } = require('./redaction');

const MANIFEST_LATEST = 'injected-latest.json';
const USAGE_JSONL = 'recall-usage.jsonl';

// 受控 domain 词表，对齐 evaluate-session.js CONFIG.domains。
// instinct.domain 与 inferSessionDomains 的输出都归一到此词表，交集才有意义。
const KNOWN_DOMAINS = [
  'code-style', 'testing', 'git', 'debugging', 'performance',
  'architecture', 'security', 'toolchain', 'api-design', 'workflow',
];

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// session id 进文件名前必须 sanitize，防路径逃逸（与 ADR-019 SKILL_NAME_RE 同源防御）。
function sanitizeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return '';
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function manifestFileName(sessionId) {
  const safe = sanitizeSessionId(sessionId);
  return safe ? `injected-${safe}.json` : MANIFEST_LATEST;
}

function dedupeDomains(domains) {
  if (!Array.isArray(domains)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of domains) {
    const norm = String(raw || '').trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.sort();
}

function normalizeManifest(manifest) {
  const source = manifest || {};
  return {
    schema: 'recall-usage-manifest/v1',
    session_id: typeof source.session_id === 'string' ? source.session_id : '',
    project_id: typeof source.project_id === 'string' ? source.project_id : '',
    timestamp: typeof source.timestamp === 'string' ? source.timestamp : '',
    injected_domains: dedupeDomains(source.injected_domains),
    injected_instinct_count: Number.isFinite(source.injected_instinct_count)
      ? source.injected_instinct_count
      : 0,
  };
}

/**
 * 写 injected manifest。总是额外覆盖 injected-latest.json（无 session id 时唯一可对上的锚点）。
 * manifest 只含 domain 名（受控词表）+ 计数 + id/timestamp，绝不含 body 文本。
 */
function writeInjectedManifest(telemetryDir, manifest) {
  if (!telemetryDir) return null;
  const normalized = normalizeManifest(manifest);
  ensureDir(telemetryDir);
  const payload = JSON.stringify(normalized);
  const primary = path.join(telemetryDir, manifestFileName(normalized.session_id));
  fs.writeFileSync(primary, payload);
  const latest = path.join(telemetryDir, MANIFEST_LATEST);
  if (primary !== latest) fs.writeFileSync(latest, payload);
  return primary;
}

/**
 * 读 injected manifest：先按 sessionId 找精确文件，回退 latest；损坏文件跳过。
 */
function readInjectedManifest(telemetryDir, sessionId) {
  if (!telemetryDir) return null;
  const candidates = [];
  const safe = sanitizeSessionId(sessionId);
  if (safe) candidates.push(path.join(telemetryDir, `injected-${safe}.json`));
  candidates.push(path.join(telemetryDir, MANIFEST_LATEST));
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      return normalizeManifest(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch {
      // 损坏 JSON 跳过，尝试下一个候选
    }
  }
  return null;
}

function isEditTool(tool) {
  const value = String(tool || '').toLowerCase();
  return ['write', 'edit', 'multiedit', 'str_replace_editor', 'apply_patch']
    .some((name) => value.includes(name));
}

function collectObservationPaths(obs) {
  const out = [];
  if (Array.isArray(obs.input_paths)) {
    out.push(...obs.input_paths.filter((p) => typeof p === 'string'));
  }
  const summaryMatch = String(obs.input_summary || '').match(/(?:path|file)['":\s]+([^\s'"]+)/);
  if (summaryMatch) out.push(summaryMatch[1]);
  return out;
}

/**
 * 从单条 observation 推断它触及的 domain（可多个）。宽松匹配：宁可多算，少误报沉睡。
 */
function domainsForObservation(obs) {
  const domains = new Set();
  const cmd = String(obs.command || obs.command_family || '').toLowerCase();
  const tool = String(obs.tool || '').toLowerCase();
  const pathBlob = collectObservationPaths(obs).join(' ').toLowerCase();
  const output = String(obs.output_summary || '').toLowerCase();

  // workflow：任何工具调用都算（会话本身就是 workflow，workflow 类知识泛化适用）
  domains.add('workflow');

  if (/\b(test|vitest|jest|playwright|pytest|spec)\b/.test(cmd)
    || /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/|(^|\/)test-|smoke-)/.test(pathBlob)) {
    domains.add('testing');
  }
  if (/\bgit\b/.test(cmd)) domains.add('git');
  if (/\b(lint|eslint|biome|tsc|typecheck|validate|preflight|build|npm|pnpm|yarn|node|cargo|make)\b/.test(cmd)
    || /(package\.json|tsconfig|\.eslintrc|biome\.json|build-|install-|preflight)/.test(pathBlob)) {
    domains.add('toolchain');
  }
  if (obs.error_signal === true || obs.status === 'error'
    || /\b(error|exception|failed|failure|traceback|enoent|debug)\b/.test(output)) {
    domains.add('debugging');
  }
  if (/\barchitect/.test(cmd) || /(architecture|adr-|\/rules\/architecture|\bdesign\b)/.test(pathBlob)) {
    domains.add('architecture');
  }
  if (/\b(secret-scan|security|audit)\b/.test(cmd) || /(security|secret|credential|\bauth\b|\.env)/.test(pathBlob)) {
    domains.add('security');
  }
  if (/\b(bench|perf|profile)\b/.test(cmd) || /(perf|performance|bench)/.test(pathBlob)) {
    domains.add('performance');
  }
  if (/\b(curl|api|fetch|http)\b/.test(cmd) || /(\/api\/|controller|route|endpoint|\.proto|openapi|swagger)/.test(pathBlob)) {
    domains.add('api-design');
  }
  if (isEditTool(tool) && /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|rb|php)\b/.test(pathBlob)) {
    domains.add('code-style');
  }
  return domains;
}

/**
 * 从全部 observations 推断会话触及的 domain 全集。
 */
function inferSessionDomains(observations) {
  if (!Array.isArray(observations)) return [];
  const all = new Set();
  for (const obs of observations) {
    if (!obs || typeof obs !== 'object') continue;
    domainsForObservation(obs).forEach((d) => all.add(d));
  }
  return [...all].sort();
}

/**
 * 算 demand-side 使用率。dormant_domains（注入了但本会话没碰）是核心退化信号。
 */
function computeDemandSideUsage(injectedDomains, sessionDomains) {
  const injected = dedupeDomains(injectedDomains);
  const session = new Set(dedupeDomains(sessionDomains));
  const used = injected.filter((d) => session.has(d));
  const dormant = injected.filter((d) => !session.has(d));
  return {
    injected_domain_count: injected.length,
    session_domain_count: session.size,
    used_domain_count: used.length,
    used_domains: used,
    dormant_domains: dormant,
    usage_rate: injected.length === 0 ? null : round4(used.length / injected.length),
  };
}

// 纵深防御：即使所有字段都是受控词表/hash，仍递归过 stripPrivateTags（与 ADR-017/019 同纵深）。
function redactDeep(value) {
  if (typeof value === 'string') return stripPrivateTags(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = redactDeep(val);
    return out;
  }
  return value;
}

/**
 * 组装 demand-side metric（已脱敏，append 进 recall-usage.jsonl）。
 */
function buildRecallUsageMetric(input) {
  const { project, sessionId, manifest, observations, timestamp } = input || {};
  const injectedDomains = manifest ? manifest.injected_domains : [];
  const sessionDomains = inferSessionDomains(observations);
  const usage = computeDemandSideUsage(injectedDomains, sessionDomains);
  const metric = {
    schema: 'recall-usage/v1',
    project_id: project && project.id ? project.id : '',
    session_id: typeof sessionId === 'string' ? sessionId : '',
    timestamp: typeof timestamp === 'string' ? timestamp : '',
    injected_instinct_count: manifest && Number.isFinite(manifest.injected_instinct_count)
      ? manifest.injected_instinct_count
      : 0,
    observation_count: Array.isArray(observations) ? observations.length : 0,
    manifest_found: Boolean(manifest),
    session_domains: sessionDomains,
    ...usage,
  };
  return redactDeep(metric);
}

function recordRecallUsage(telemetryDir, metric) {
  if (!telemetryDir) return null;
  ensureDir(telemetryDir);
  const file = path.join(telemetryDir, USAGE_JSONL);
  fs.appendFileSync(file, `${JSON.stringify(metric)}\n`);
  return file;
}

/**
 * 读最近一条 recall-usage metric（消费点用：cost summary / retrospective）；损坏行跳过。
 */
function readLatestRecallUsage(telemetryDir) {
  if (!telemetryDir) return null;
  const file = path.join(telemetryDir, USAGE_JSONL);
  try {
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf-8').trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // 损坏行跳过
      }
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  KNOWN_DOMAINS,
  MANIFEST_LATEST,
  USAGE_JSONL,
  sanitizeSessionId,
  manifestFileName,
  dedupeDomains,
  normalizeManifest,
  writeInjectedManifest,
  readInjectedManifest,
  inferSessionDomains,
  domainsForObservation,
  computeDemandSideUsage,
  buildRecallUsageMetric,
  recordRecallUsage,
  readLatestRecallUsage,
};
