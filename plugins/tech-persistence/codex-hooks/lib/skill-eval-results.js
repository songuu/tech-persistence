'use strict';

const fs = require('fs');
const path = require('path');

const EVAL_RESULTS_SCHEMA_VERSION = '1.0';
const EVALS_DIR_NAME = 'skill-evals';
const RESULTS_DIR_NAME = 'results';
const RESULTS_FILE_NAME = 'results.jsonl';
// 与 skill-signals 一致：只接受 `[a-z][a-z0-9-]{0,63}`，防止路径逃逸到 evalsDir 外
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

function assertValidName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new Error(`skill-eval-results: invalid skill name "${name}" (need ${SKILL_NAME_RE})`);
  }
}

// {baseDir}/skill-evals/{name}/results/results.jsonl
function resolveResultsFile(name, baseDir) {
  assertValidName(name);
  if (!baseDir) throw new Error('skill-eval-results: baseDir required');
  return path.join(baseDir, EVALS_DIR_NAME, name, RESULTS_DIR_NAME, RESULTS_FILE_NAME);
}

// 系统边界校验：pass_rate 必须是 0..1 浮点，version 必须是正整数
function normalizeResult(input) {
  const version = Number(input.version);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`skill-eval-results: version must be a positive integer, got "${input.version}"`);
  }
  const passRate = Number(input.passRate);
  if (!Number.isFinite(passRate) || passRate < 0 || passRate > 1) {
    throw new Error(`skill-eval-results: passRate must be a number in [0,1], got "${input.passRate}"`);
  }
  return { version, passRate };
}

// 追加一条 eval 结果到 results.jsonl（append-only 时间线）
function recordResult(name, input = {}) {
  assertValidName(name);
  const { baseDir, timestamp } = input;
  const { version, passRate } = normalizeResult(input);
  const resultsFile = resolveResultsFile(name, baseDir);
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
  const record = {
    schema_version: EVAL_RESULTS_SCHEMA_VERSION,
    timestamp: (timestamp ? new Date(timestamp) : new Date()).toISOString(),
    name,
    version,
    pass_rate: passRate,
    cases: input.cases && typeof input.cases === 'object' ? input.cases : undefined,
    source: typeof input.source === 'string' ? input.source : 'skill-eval',
  };
  fs.appendFileSync(resultsFile, JSON.stringify(record) + '\n');
  return { record, resultsFile };
}

// 读全部结果记录（按 append 顺序）；损坏行跳过并留 marker，不抛
function readResults(name, options = {}) {
  const { baseDir } = options;
  const resultsFile = resolveResultsFile(name, baseDir);
  if (!fs.existsSync(resultsFile)) return [];
  const raw = fs.readFileSync(resultsFile, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) {
      process.stderr.write(`[skill-eval-results] skipped malformed line in ${resultsFile}: ${err.message}\n`);
    }
  }
  return records;
}

// 取时间线最后两条（prev = 倒数第二 = 当前已发布版基线, curr = 最后 = 待发布提案版）
function readLatestTwo(name, options = {}) {
  const records = readResults(name, options);
  return {
    prev: records.length >= 2 ? records[records.length - 2] : null,
    curr: records.length >= 1 ? records[records.length - 1] : null,
  };
}

// 退化判定。无可比对基线（0 或 1 条）→ no-baseline 放行。
// curr.pass_rate < prev.pass_rate - tolerance → regression 拒绝。
function checkRegression(name, options = {}) {
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : 0;
  const { prev, curr } = readLatestTwo(name, options);
  if (!curr || !prev) {
    return { status: 'no-baseline', prev, curr, tolerance, reason: '无前一版基线可比对，放行' };
  }
  const threshold = prev.pass_rate - tolerance;
  if (curr.pass_rate < threshold) {
    return {
      status: 'regression',
      prev,
      curr,
      tolerance,
      reason: `新版通过率 ${(curr.pass_rate * 100).toFixed(1)}% < 旧版 ${(prev.pass_rate * 100).toFixed(1)}%`
        + (tolerance > 0 ? ` - 容差 ${(tolerance * 100).toFixed(1)}%` : ''),
    };
  }
  return { status: 'ok', prev, curr, tolerance, reason: '新版通过率未退化' };
}

module.exports = {
  EVAL_RESULTS_SCHEMA_VERSION,
  EVALS_DIR_NAME,
  SKILL_NAME_RE,
  resolveResultsFile,
  recordResult,
  readResults,
  readLatestTwo,
  checkRegression,
};
