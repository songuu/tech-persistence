#!/usr/bin/env node

/**
 * prompt-submit.js — UserPromptSubmit Hook
 *
 * 在用户每轮 prompt 提交时，按 prompt 内容召回相关 Memory v5 entries / sessions / instincts，
 * 通过 hookSpecificOutput.additionalContext 注入当前轮。
 *
 * 失败模式（按 plan §6.8 全部 silent exit 0）：
 *   - stdin 不是 JSON / payload 没有 prompt → 静默
 *   - 检索超时 / 抛异常 → 静默（debug 模式才写 stderr）
 *   - 匹配低于阈值 → 不输出
 *   - env TECH_PERSISTENCE_DISABLE_PROMPT_RECALL=1 → 直接 exit 0
 *   - 自指防护：不输出已经在 prompt 中包含的 verbatim 内容
 *
 * Hook 自身不写 observations，避免 prompt-recall 制造自指。
 */

const {
  detectProjectIdentity,
} = require('./lib/memory-v5');
const { resolveCompatReadDirs } = require('./lib/runtime-paths');
const {
  searchMemory,
  formatRecallContext,
  hasUsefulResults,
} = require('./lib/memory-search');
const { detectActiveSprintTags } = require('./inject-context');

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_BUDGET_CHARS = 3000;
const MIN_PROMPT_LENGTH = 8;

function readStdinSync(timeoutMs) {
  try {
    const fd = 0;
    const fs = require('fs');
    const chunks = [];
    const buf = Buffer.alloc(65536);
    const start = Date.now();
    while (true) {
      if (Date.now() - start > timeoutMs) break;
      let bytes;
      try {
        bytes = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (err) {
        if (err.code === 'EAGAIN') continue;
        break;
      }
      if (bytes === 0) break;
      chunks.push(Buffer.from(buf.slice(0, bytes)));
      if (chunks.length > 64) break;
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return '';
  }
}

function extractPrompt(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.input,
    payload.message,
    payload.text,
    payload.content,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractTouchedFiles(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.touched_files,
    payload.touchedFiles,
    payload.files,
    payload.context_files,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === 'string');
    }
  }
  return [];
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function main() {
  if (process.env.TECH_PERSISTENCE_DISABLE_PROMPT_RECALL === '1') {
    process.exit(0);
  }

  const raw = readStdinSync(DEFAULT_TIMEOUT_MS);
  if (!raw.trim()) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = extractPrompt(payload);
  if (!prompt || prompt.length < MIN_PROMPT_LENGTH) {
    process.exit(0);
  }

  const touchedFiles = extractTouchedFiles(payload);

  let project;
  try {
    project = detectProjectIdentity();
  } catch {
    process.exit(0);
  }
  if (!project || !project.id) {
    process.exit(0);
  }

  let baseDirs;
  try {
    baseDirs = resolveCompatReadDirs();
  } catch {
    process.exit(0);
  }

  let sprintTags = [];
  try {
    sprintTags = detectActiveSprintTags();
  } catch {
    sprintTags = [];
  }

  let result;
  try {
    result = searchMemory({
      prompt,
      projectId: project.id,
      baseDirs,
      cwd: process.cwd(),
      touchedFiles,
      sprintTags,
      limits: { budgetChars: DEFAULT_BUDGET_CHARS },
    });
  } catch {
    process.exit(0);
  }

  if (!hasUsefulResults(result)) {
    process.exit(0);
  }

  let body;
  try {
    body = formatRecallContext(result, { budgetChars: DEFAULT_BUDGET_CHARS });
  } catch {
    process.exit(0);
  }

  if (!body || body.length < 40) {
    process.exit(0);
  }

  const context = `<learned-context project="${project.name || 'unknown'}" source="prompt-recall">
${body}
</learned-context>`;

  const output = safeStringify({
    hookSpecificOutput: {
      additionalContext: context,
    },
  });

  if (!output) {
    process.exit(0);
  }

  process.stdout.write(output);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

module.exports = { extractPrompt, extractTouchedFiles };
