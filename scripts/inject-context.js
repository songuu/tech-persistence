#!/usr/bin/env node

/**
 * inject-context.js — SessionStart Hook 上下文注入
 *
 * 在每次新会话开始时：
 *   1. 检测未完成的 sprint handoff 文件（最高优先）
 *   2. 加载最近 N 个会话摘要
 *   3. 加载高置信度本能（>=0.7 自动应用）
 *   4. 格式化后通过 hookSpecificOutput.additionalContext 注入
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  resolveCompatReadDirs,
  resolveProjectPlansDir,
} = require('./lib/runtime-paths');
const {
  DEFAULT_MEMORY_CONFIG,
  boundText,
  parseFrontmatter,
} = require('./lib/memory-v5');

const CONTEXT_BUDGET_CHARS = 12000;

function detectProject() {
  const { execSync } = require('child_process');
  const execOpts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    const remote = execSync('git remote get-url origin', execOpts).trim();
    if (remote) {
      const hash = crypto.createHash('sha256').update(remote).digest('hex').slice(0, 12);
      return { id: hash, name: path.basename(remote, '.git') };
    }
  } catch {}
  try {
    const root = execSync('git rev-parse --show-toplevel', execOpts).trim();
    if (root) {
      const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
      return { id: hash, name: path.basename(root) };
    }
  } catch {}
  const cwd = process.cwd();
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return { id: hash, name: path.basename(cwd) };
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

function loadMemoryIndex(memoryDir) {
  const memoryPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) return '';
  const content = fs.readFileSync(memoryPath, 'utf-8');
  const { body } = parseFrontmatter(content);
  return boundText(
    body,
    DEFAULT_MEMORY_CONFIG.indexMaxLines,
    DEFAULT_MEMORY_CONFIG.indexMaxBytes
  );
}

function loadMemoryIndexWithFallback(baseDirs, relativeParts) {
  for (const baseDir of baseDirs) {
    const content = loadMemoryIndex(path.join(baseDir, ...relativeParts));
    if (content) return content;
  }
  return '';
}

function addSection(sections, title, body, maxChars) {
  if (!body) return;
  sections.push({
    title,
    body: String(body).trim().slice(0, maxChars),
  });
}

function renderSections(sections) {
  let remaining = CONTEXT_BUDGET_CHARS;
  const rendered = [];

  for (const section of sections) {
    if (remaining <= 0) break;
    const heading = `## ${section.title}\n\n`;
    const available = Math.max(0, remaining - heading.length);
    const body = section.body.slice(0, available).trim();
    if (!body) continue;
    const block = `${heading}${body}`;
    rendered.push(block);
    remaining -= block.length + 2;
  }

  return rendered.join('\n\n');
}

/**
 * 检测未完成的 sprint handoff 文件
 * 查找 docs/plans/ 下最新的 *-handoff-*.md
 */
function detectPendingHandoff() {
  const plansDir = path.join(process.cwd(), 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return null;

  const handoffs = fs.readdirSync(plansDir)
    .filter(f => f.includes('-handoff-') && f.endsWith('.md'))
    .sort()
    .reverse();

  if (handoffs.length === 0) return null;

  const latest = handoffs[0];
  const content = fs.readFileSync(path.join(plansDir, latest), 'utf-8');

  // 检查关联的 sprint 文档是否还是 in-progress/checkpoint 状态
  const sprintDocMatch = content.match(/sprint_doc:\s*"?([^"\n]+)"?/);
  if (sprintDocMatch) {
    const sprintDocPath = path.join(process.cwd(), sprintDocMatch[1]);
    if (fs.existsSync(sprintDocPath)) {
      const sprintContent = fs.readFileSync(sprintDocPath, 'utf-8');
      // 如果 sprint 已经 completed 则不注入 handoff
      if (sprintContent.match(/status:\s*completed/)) return null;
    }
  }

  return { file: latest, content: content };
}

/**
 * 检测未完成的 prototype 收敛状态
 */
function detectPendingPrototype() {
  const plansDir = resolveProjectPlansDir();
  if (!fs.existsSync(plansDir)) return null;

  const statuses = fs.readdirSync(plansDir)
    .filter(f => f.startsWith('prototype-') && f.endsWith('-status.md'))
    .sort()
    .reverse();

  if (statuses.length === 0) return null;

  const latest = statuses[0];
  const content = fs.readFileSync(path.join(plansDir, latest), 'utf-8');

  // 如果已收敛完成则不注入
  if (content.includes('收敛完成') || content.includes('converged')) return null;

  const projectConfigDir = path.basename(path.dirname(plansDir));
  return {
    file: latest,
    displayPath: `${projectConfigDir}/plans/${latest}`,
    content: content.slice(0, 500),
  }; // 只取摘要
}

function main() {
  const project = detectProject();
  const compatReadDirs = resolveCompatReadDirs();

  const sections = [];

  // 0. 未完成的 sprint handoff（最高优先）
  const handoff = detectPendingHandoff();
  if (handoff) {
    addSection(
      sections,
      '未完成的 Sprint (从 checkpoint 恢复)',
      `文件: docs/plans/${handoff.file}\n\n${handoff.content}`,
      1500
    );
  }

  // 0b. 未完成的 prototype 收敛
  const prototype = detectPendingPrototype();
  if (prototype) {
    addSection(
      sections,
      '未完成的原型收敛',
      `文件: ${prototype.displayPath}\n\n${prototype.content}`,
      700
    );
  }

  // 0c. Codex memory v5: Claude Code auto memory style concise index
  const memoryIndex = loadMemoryIndexWithFallback(
    compatReadDirs,
    ['projects', project.id, 'memory']
  );
  if (memoryIndex) {
    addSection(
      sections,
      'Auto Memory v5 (MEMORY.md concise index)',
      memoryIndex,
      DEFAULT_MEMORY_CONFIG.indexMaxBytes
    );
  }

  // 1. 近期会话摘要
  const sessions = loadRecentSessionsWithFallback(
    compatReadDirs,
    ['projects', project.id, 'sessions'],
    3
  );
  if (sessions.length > 0) {
    addSection(sections, `近期会话 (${project.name})`, sessions.join('\n---\n'), 3000);
  }

  // 2. 高置信度项目本能 (>=0.5)
  const projectInstincts = loadInstinctsWithFallback(
    compatReadDirs,
    ['projects', project.id, 'instincts'],
    0.5
  );
  if (projectInstincts.length > 0) {
    const instinctLines = projectInstincts.slice(0, 10).map(inst => {
      const conf = parseFloat(inst.confidence).toFixed(1);
      const flag = parseFloat(inst.confidence) >= 0.7 ? '🟢' : '🟡';
      return `- ${flag} [${conf}] [${inst.domain || '?'}] ${inst.trigger || inst.id}`;
    });
    addSection(sections, '项目本能 (已学习的行为模式)', instinctLines.join('\n'), 1600);
  }

  // 3. 高置信度全局本能 (>=0.7)
  const globalInstincts = loadInstinctsWithFallback(
    compatReadDirs,
    ['instincts', 'personal'],
    0.7
  );
  if (globalInstincts.length > 0) {
    const instinctLines = globalInstincts.slice(0, 5).map(inst => {
      const conf = parseFloat(inst.confidence).toFixed(1);
      return `- 🟢 [${conf}] [${inst.domain || '?'}] ${inst.trigger || inst.id}`;
    });
    addSection(sections, '全局本能 (跨项目通用)', instinctLines.join('\n'), 1000);
  }

  if (sections.length === 0) {
    process.exit(0);
  }

  const context = `<learned-context project="${project.name}">
${renderSections(sections)}
</learned-context>`;

  const output = JSON.stringify({
    hookSpecificOutput: {
      additionalContext: context
    }
  });
  console.log(output);
}

try { main(); } catch { process.exit(0); }
