'use strict';

const fs = require('fs');
const path = require('path');
const { stripPrivateTags } = require('./redaction');

const SKILL_TRACES_SCHEMA_VERSION = '1.0';
const TRACES_DIR_NAME = 'skill-traces';
// 与 skill-signals / skill-eval-results 一致：只接受 `[a-z][a-z0-9-]{0,63}`，防路径逃逸
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

// 写入前必须脱敏的字符串字段（trace 含真实输入，纵深防御）
const REDACTED_STRING_FIELDS = ['failure_step', 'error_excerpt', 'correction_diff', 'input_excerpt'];

function assertValidName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new Error(`skill-traces: invalid skill name "${name}" (need ${SKILL_NAME_RE})`);
  }
}

// {baseDir}/skill-traces/{name}.jsonl
function resolveTraceFile(name, baseDir) {
  assertValidName(name);
  if (!baseDir) throw new Error('skill-traces: baseDir required');
  return path.join(baseDir, TRACES_DIR_NAME, `${name}.jsonl`);
}

// 追加一条 trace。所有字符串字段写入前 stripPrivateTags（即使来源 observations 已脱敏，仍纵深防御）。
function recordTrace(name, input = {}, options = {}) {
  assertValidName(name);
  const baseDir = options.baseDir;
  const traceFile = resolveTraceFile(name, baseDir);
  fs.mkdirSync(path.dirname(traceFile), { recursive: true });
  const record = {
    schema_version: SKILL_TRACES_SCHEMA_VERSION,
    timestamp: (input.timestamp ? new Date(input.timestamp) : new Date()).toISOString(),
    skill: name,
    source: typeof input.source === 'string' ? stripPrivateTags(input.source) : 'diagnose-extract',
  };
  for (const field of REDACTED_STRING_FIELDS) {
    if (typeof input[field] === 'string' && input[field].length > 0) {
      record[field] = stripPrivateTags(input[field]);
    }
  }
  fs.appendFileSync(traceFile, JSON.stringify(record) + '\n');
  return { record, traceFile };
}

// 读全部 trace 记录（按 append 顺序）；损坏行跳过 + stderr marker，不抛
function readTraces(name, options = {}) {
  const traceFile = resolveTraceFile(name, options.baseDir);
  if (!fs.existsSync(traceFile)) return [];
  const raw = fs.readFileSync(traceFile, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) {
      process.stderr.write(`[skill-traces] skipped malformed line in ${traceFile}: ${err.message}\n`);
    }
  }
  return records;
}

module.exports = {
  SKILL_TRACES_SCHEMA_VERSION,
  TRACES_DIR_NAME,
  SKILL_NAME_RE,
  REDACTED_STRING_FIELDS,
  resolveTraceFile,
  recordTrace,
  readTraces,
};
