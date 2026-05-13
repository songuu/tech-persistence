'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// 22 个 tech-persistence 命令白名单（与 user-level/commands/*.md 同步）
// 注：/skill 是 2026-05-13 新增的统一入口；/skill-* 4 命令保留作 alias
const COMMAND_WHITELIST = Object.freeze([
  'agent-loop',
  'checkpoint',
  'compound',
  'evolve',
  'instinct-export',
  'instinct-import',
  'instinct-status',
  'learn',
  'plan',
  'prototype',
  'review',
  'review-learnings',
  'session-summary',
  'skill',
  'skill-diagnose',
  'skill-eval',
  'skill-improve',
  'skill-publish',
  'sprint',
  'test',
  'think',
  'work',
]);

const WHITELIST_SET = new Set(COMMAND_WHITELIST);

const COMMAND_NAME_RE = /<command-name>\/([a-z][a-z0-9-]*)<\/command-name>/g;

// cwd → Claude Code transcript slug：小写 + `:` `\` `/` 各替换为单个 `-`
// 例 `C:\project\my\tech-persistence` → `c--project-my-tech-persistence`
// （盘符冒号 + 反斜杠产生连续两个 `-`，这是 Claude Code 实际规则）
function cwdToSlug(cwd) {
  return String(cwd)
    .toLowerCase()
    .replace(/[\\/:]/g, '-')
    .replace(/^-+/, '');
}

function resolveTranscriptDir(cwd) {
  const home = os.homedir();
  const slug = cwdToSlug(cwd);
  return path.join(home, '.claude', 'projects', slug);
}

function resolveObservationsPaths() {
  const home = os.homedir();
  const homunculusDir = path.join(home, '.claude', 'homunculus', 'projects');
  if (!fs.existsSync(homunculusDir)) return [];
  const projects = fs.readdirSync(homunculusDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const paths = [];
  for (const projectId of projects) {
    const main = path.join(homunculusDir, projectId, 'observations.jsonl');
    if (fs.existsSync(main)) paths.push({ projectId, file: main });
    const archiveDir = path.join(homunculusDir, projectId, 'archive');
    if (fs.existsSync(archiveDir)) {
      const archives = fs.readdirSync(archiveDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => path.join(archiveDir, name));
      for (const a of archives) paths.push({ projectId, file: a });
    }
  }
  return paths;
}

// 流式扫一个 jsonl 文件，对每个非空 line 调 onLine
function streamJsonl(filePath, onLine) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        onLine(obj);
      } catch {
        // 忽略损坏行
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// 从一条 transcript entry 提取命令名（仅真实触发，排除 tool_result 噪音）
function extractCommandsFromTranscriptEntry(entry) {
  if (!entry || entry.type !== 'user') return [];
  const msg = entry.message;
  if (!msg || typeof msg.content !== 'string') return []; // 关键：content 是 array → tool_result 噪音
  const content = msg.content;
  if (!content.includes('<command-name>')) return [];
  const names = [];
  let match;
  COMMAND_NAME_RE.lastIndex = 0;
  while ((match = COMMAND_NAME_RE.exec(content)) !== null) {
    names.push(match[1]);
  }
  return names;
}

// 从 Codex observations 一条 entry 提取 skill 名
function extractSkillFromObservation(entry) {
  if (!entry || entry.tool !== 'Skill' || entry.phase !== 'pre') return null;
  const summary = entry.input_summary;
  if (typeof summary !== 'string') return null;
  // input_summary 是 JSON 字符串（已被 normalizeHookPayload 序列化）
  try {
    const parsed = JSON.parse(summary);
    if (parsed && typeof parsed.skill === 'string') return parsed.skill;
  } catch {
    // fallback：正则提取
    const m = summary.match(/"skill"\s*:\s*"([a-z][a-z0-9-]*)"/i);
    if (m) return m[1];
  }
  return null;
}

// 主聚合函数
async function aggregate(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : 30;
  const now = opts.now ? new Date(opts.now) : new Date();
  const windowCutoff = new Date(now.getTime() - windowDays * 86400 * 1000);

  const stats = new Map(); // command → { windowCC, windowCodex, totalCC, totalCodex, first, last }
  for (const name of COMMAND_WHITELIST) {
    stats.set(name, {
      command: name,
      windowCC: 0,
      windowCodex: 0,
      totalCC: 0,
      totalCodex: 0,
      first: null,
      last: null,
    });
  }

  function record(command, runtime, ts) {
    const row = stats.get(command);
    if (!row) return;
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return;
    if (runtime === 'cc') {
      row.totalCC += 1;
      if (date >= windowCutoff) row.windowCC += 1;
    } else if (runtime === 'codex') {
      row.totalCodex += 1;
      if (date >= windowCutoff) row.windowCodex += 1;
    }
    if (!row.first || date < row.first) row.first = date;
    if (!row.last || date > row.last) row.last = date;
  }

  // 源 1: Claude Code transcript
  const transcriptDir = resolveTranscriptDir(cwd);
  const transcriptSources = { dir: transcriptDir, exists: false, files: [] };
  if (fs.existsSync(transcriptDir)) {
    transcriptSources.exists = true;
    const files = fs.readdirSync(transcriptDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(transcriptDir, name));
    transcriptSources.files = files;
    for (const file of files) {
      await streamJsonl(file, (entry) => {
        const names = extractCommandsFromTranscriptEntry(entry);
        if (names.length === 0) return;
        const ts = entry.timestamp;
        if (!ts) return;
        for (const name of names) {
          if (WHITELIST_SET.has(name)) record(name, 'cc', ts);
        }
      });
    }
  }

  // 源 2: Codex observations
  // 去重 key：skill + 秒级 timestamp（同秒内同 skill 视为 hook 重复触发，记 1 次）
  // 根因：Claude Code + Codex 可能同时注册 PreToolUse hook，单次工具调用产生多条 observation
  const observationSources = resolveObservationsPaths();
  const observationSeen = new Set();
  for (const source of observationSources) {
    await streamJsonl(source.file, (entry) => {
      const skill = extractSkillFromObservation(entry);
      if (!skill || !WHITELIST_SET.has(skill)) return;
      const ts = entry.timestamp;
      if (!ts) return;
      const secondTs = String(ts).slice(0, 19); // YYYY-MM-DDTHH:MM:SS
      const dedupKey = `${skill}@${secondTs}`;
      if (observationSeen.has(dedupKey)) return;
      observationSeen.add(dedupKey);
      record(skill, 'codex', ts);
    });
  }

  // 转 rows + 汇总
  const rows = COMMAND_WHITELIST.map((name) => {
    const row = stats.get(name);
    return {
      command: name,
      windowCC: row.windowCC,
      windowCodex: row.windowCodex,
      windowTotal: row.windowCC + row.windowCodex,
      totalCC: row.totalCC,
      totalCodex: row.totalCodex,
      totalAll: row.totalCC + row.totalCodex,
      first: row.first ? row.first.toISOString() : null,
      last: row.last ? row.last.toISOString() : null,
    };
  });

  return {
    generatedAt: now.toISOString(),
    cwd,
    windowDays,
    windowCutoff: windowCutoff.toISOString(),
    sources: {
      transcript: {
        dir: transcriptSources.dir,
        exists: transcriptSources.exists,
        fileCount: transcriptSources.files.length,
      },
      observations: observationSources.map((s) => ({ projectId: s.projectId, file: s.file })),
    },
    whitelist: COMMAND_WHITELIST.slice(),
    rows,
  };
}

module.exports = {
  COMMAND_WHITELIST,
  cwdToSlug,
  resolveTranscriptDir,
  resolveObservationsPaths,
  extractCommandsFromTranscriptEntry,
  extractSkillFromObservation,
  aggregate,
};
