'use strict';

const fs = require('fs');
const path = require('path');
const { extractSkillFromObservation } = require('./usage-aggregator');

const SKILL_SIGNALS_SCHEMA_VERSION = '1.0';
const SIGNALS_DIR_NAME = 'skill-signals';
// Skill 名校验：只接受 `[a-z][a-z0-9-]{0,63}`，防止路径逃逸到 signalsDir 外
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

// ─── Stage A: 从 session observations 派生 skill 信号 ───
//
// 提取 Codex 端 tool:"Skill" 工具调用，按 skill 名分桶 +
// 同秒同 skill 去重（与 usage-aggregator 一致），写入
// {baseDir}/skill-signals/{name}.jsonl。
//
// 数据局限：仅覆盖 Codex 端 tool:"Skill"；Claude Code 端 SlashCommand
// 不进 PreToolUse hook，结构性无法捕获。
function aggregateSkillSignals(observations, opts = {}) {
  const { project, baseDir, sessionId, now } = opts;
  if (!baseDir) throw new Error('aggregateSkillSignals: baseDir required');
  if (!project || !project.id) throw new Error('aggregateSkillSignals: project.id required');

  const skillCallsThisSession = new Map();
  for (const obs of observations || []) {
    const skill = extractSkillFromObservation(obs);
    if (!skill || !SKILL_NAME_RE.test(skill)) continue; // 路径逃逸防御
    const entry = skillCallsThisSession.get(skill) || { calls: 0, dedupSet: new Set() };
    const dedupKey = String(obs.timestamp || '').slice(0, 19);
    if (!dedupKey || entry.dedupSet.has(dedupKey)) continue;
    entry.dedupSet.add(dedupKey);
    entry.calls += 1;
    skillCallsThisSession.set(skill, entry);
  }

  if (skillCallsThisSession.size === 0) return { written: 0, skills: [] };

  const signalsDir = path.join(baseDir, SIGNALS_DIR_NAME);
  fs.mkdirSync(signalsDir, { recursive: true });
  const tsIso = (now ? new Date(now) : new Date()).toISOString();
  // sessionId fallback：优先 obs 自带 session_id（同 session 一致），次选传入参数，
  // 最后兜底时间戳；`s-${Date.now()}` 在同毫秒并发时会撞，仅作最后防线
  let resolvedSessionId = sessionId;
  if (!resolvedSessionId && Array.isArray(observations) && observations.length > 0) {
    const firstObsSession = observations.find((o) => o && typeof o.session_id === 'string');
    if (firstObsSession) resolvedSessionId = firstObsSession.session_id;
  }
  if (!resolvedSessionId) resolvedSessionId = `s-${Date.now()}`;

  const skills = [];
  let written = 0;
  for (const [skill, data] of skillCallsThisSession) {
    const signalPath = path.join(signalsDir, `${skill}.jsonl`);
    const record = {
      schema_version: SKILL_SIGNALS_SCHEMA_VERSION,
      timestamp: tsIso,
      session_id: resolvedSessionId,
      project: project.id,
      skill,
      calls: data.calls,
      source: 'codex-observations',
    };
    try {
      fs.appendFileSync(signalPath, JSON.stringify(record) + '\n');
      written += 1;
      skills.push(skill);
    } catch (err) {
      process.stderr.write(`[skill-signals] append failed for ${skill}: ${err.message}\n`);
    }
  }
  return { written, skills };
}

// ─── Stage C 辅助：扫描 skill-signals/ 给 /compound 输出健康摘要 ───
//
// 返回数组形如 [{ skill, totalCalls, lastSeen, level: 'healthy'|'observe'|'recommend' }]
// level 阈值：calls >= recommendThreshold → 'recommend'；
//             calls >= healthyThreshold → 'healthy'；否则 'observe'。
//
// 签名对齐 aggregateSkillSignals：全部命名参数（解构 opts）
function summarizeSkillSignals(opts = {}) {
  const { baseDir, healthyThreshold, recommendThreshold } = opts;
  if (!baseDir) throw new Error('summarizeSkillSignals: baseDir required');
  const healthy = Number.isFinite(healthyThreshold) ? healthyThreshold : 5;
  const recommend = Number.isFinite(recommendThreshold) ? recommendThreshold : 20;
  const signalsDir = path.join(baseDir, SIGNALS_DIR_NAME);
  if (!fs.existsSync(signalsDir)) return [];

  const files = fs.readdirSync(signalsDir).filter((name) => name.endsWith('.jsonl'));
  const summary = [];
  for (const file of files) {
    const skill = file.replace(/\.jsonl$/, '');
    if (!SKILL_NAME_RE.test(skill)) continue; // 防御：忽略不合规文件名
    const filePath = path.join(signalsDir, file);
    let totalCalls = 0;
    let lastSeen = null;
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (Number.isFinite(record.calls)) totalCalls += record.calls;
          const ts = record.timestamp;
          if (ts && (!lastSeen || ts > lastSeen)) lastSeen = ts;
        } catch {
          // 跳过损坏行（保留静默 — 单行损坏不应阻塞整文件聚合）
        }
      }
    } catch (err) {
      process.stderr.write(`[skill-signals] read failed for ${file}: ${err.message}\n`);
      continue;
    }
    let level = 'observe';
    if (totalCalls >= recommend) level = 'recommend';
    else if (totalCalls >= healthy) level = 'healthy';
    summary.push({ skill, totalCalls, lastSeen, level });
  }
  // 按调用数降序
  summary.sort((a, b) => b.totalCalls - a.totalCalls);
  return summary;
}

module.exports = {
  SKILL_SIGNALS_SCHEMA_VERSION,
  SIGNALS_DIR_NAME,
  aggregateSkillSignals,
  summarizeSkillSignals,
};
