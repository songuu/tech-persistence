'use strict';

const fs = require('fs');
const path = require('path');
const { stripPrivateTags } = require('./redaction');

const EVAL_CASES_SCHEMA_VERSION = '1.0';
const EVALS_DIR_NAME = 'skill-evals';
const CASES_DIR_NAME = 'cases';
const CASES_FILE_NAME = 'cases.jsonl';
// 与 skill-traces / skill-eval-results 一致：只接受 `[a-z][a-z0-9-]{0,63}`，防路径逃逸到 evalsDir 外
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

// 护城河：eval case 只接受来自真实使用 trace 的 provenance（不接受 skill 自产）。
// trace = 来自 skill-traces/{name}.jsonl（B1）的真实失败/纠正，沉淀为最有价值的 case。
const ALLOWED_PROVENANCE = new Set(['trace']);

function assertValidName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new Error(`skill-eval-cases: invalid skill name "${name}" (need ${SKILL_NAME_RE})`);
  }
}

// {baseDir}/skill-evals/{name}/cases/cases.jsonl（与 B3 results/results.jsonl 平级同构）
function resolveCasesFile(name, baseDir) {
  assertValidName(name);
  if (!baseDir) throw new Error('skill-eval-cases: baseDir required');
  return path.join(baseDir, EVALS_DIR_NAME, name, CASES_DIR_NAME, CASES_FILE_NAME);
}

// 递归脱敏：对象/数组里所有字符串值都过 stripPrivateTags（纵深防御，
// 即使来源 skill-traces 已脱敏；source_trace 是嵌套对象，必须深度处理）
function redactDeep(value) {
  if (typeof value === 'string') return stripPrivateTags(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactDeep(value[key]);
    return out;
  }
  return value;
}

// 追加一条结构化 eval case。
// 强制 gate：provenance 必须 ∈ ALLOWED_PROVENANCE（护城河）+ source_trace 必须是对象（快照不可复现的真实上下文）。
// 所有字符串字段写入前 stripPrivateTags（纵深防御）。
function addCase(name, input = {}, options = {}) {
  assertValidName(name);
  const baseDir = options.baseDir;

  const provenance = typeof input.provenance === 'string' ? input.provenance : 'trace';
  if (!ALLOWED_PROVENANCE.has(provenance)) {
    throw new Error(
      `skill-eval-cases: provenance must be one of [${[...ALLOWED_PROVENANCE].join(', ')}] `
        + `(eval case 必须来自真实使用 trace，不接受 skill 自产), got "${input.provenance}"`
    );
  }
  if (!input.source_trace || typeof input.source_trace !== 'object' || Array.isArray(input.source_trace)) {
    throw new Error(
      'skill-eval-cases: source_trace required (object) — 必须快照来源 trace，'
        + '否则真实输入不可复现且护城河不可查'
    );
  }
  if (typeof input.input !== 'string' || input.input.length === 0) {
    throw new Error('skill-eval-cases: input required (non-empty string) — case 的触发输入');
  }

  const casesFile = resolveCasesFile(name, baseDir);
  fs.mkdirSync(path.dirname(casesFile), { recursive: true });

  const record = {
    schema_version: EVAL_CASES_SCHEMA_VERSION,
    timestamp: (input.timestamp ? new Date(input.timestamp) : new Date()).toISOString(),
    name,
    id: typeof input.id === 'string' && input.id ? stripPrivateTags(input.id) : `case-${Date.now()}`,
    input: stripPrivateTags(input.input),
    expectation:
      typeof input.expectation === 'string' && input.expectation
        ? stripPrivateTags(input.expectation)
        : undefined,
    provenance,
    source_trace: redactDeep(input.source_trace),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => stripPrivateTags(String(t))) : undefined,
  };

  // append-only：重复 id 不阻塞（jsonl 时间线允许同 id 演进），仅 stderr 提示
  try {
    const existing = readCases(name, { baseDir });
    if (existing.some((c) => c.id === record.id)) {
      process.stderr.write(`[skill-eval-cases] note: case id "${record.id}" already exists (append anyway)\n`);
    }
  } catch {
    // 读失败不应阻塞写
  }

  fs.appendFileSync(casesFile, JSON.stringify(record) + '\n');
  return { record, casesFile };
}

// 读全部 case（按 append 顺序）；损坏行跳过 + stderr marker，不抛
function readCases(name, options = {}) {
  const casesFile = resolveCasesFile(name, options.baseDir);
  if (!fs.existsSync(casesFile)) return [];
  const raw = fs.readFileSync(casesFile, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) {
      process.stderr.write(`[skill-eval-cases] skipped malformed line in ${casesFile}: ${err.message}\n`);
    }
  }
  return records;
}

module.exports = {
  EVAL_CASES_SCHEMA_VERSION,
  EVALS_DIR_NAME,
  CASES_DIR_NAME,
  CASES_FILE_NAME,
  SKILL_NAME_RE,
  ALLOWED_PROVENANCE,
  resolveCasesFile,
  addCase,
  readCases,
};
