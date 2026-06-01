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
const {
  resolveBaseDir,
  resolveCompatReadDirs,
  resolveProjectPlansDir,
  resolveSessionId,
} = require('./lib/runtime-paths');
const {
  DEFAULT_MEMORY_CONFIG,
  detectProjectIdentity,
  loadUnifiedMemoryIndex,
  parseFrontmatter,
  recordMemoryRecallMetric,
} = require('./lib/memory-v5');
const { writeInjectedManifest, readLatestRecallUsage } = require('./lib/recall-usage');

const CONTEXT_BUDGET_CHARS = 12000;

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
  const project = detectProjectIdentity();
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
      `文件: ${prototype.displayPath}\n\n${prototype.content}`,
      700
    );
  }

  // 0c. Persona（用户统一画像）— 500 字节单独预算，先于 memory index 注入
  // Why: persona 是跨会话稳定的低频信号，不应被 memory index 的 entry 排挤
  const personaBody = loadPersonaBody(
    compatReadDirs.map(baseDir => path.join(baseDir, 'projects', project.id, 'memory'))
  );
  if (personaBody) {
    addSection(sections, 'Persona (用户画像)', personaBody, 900);
  }

  // 0d. Memory v5: merge compatible runtime stores instead of shadowing by first hit
  // 按当前活跃 sprint 的 tags 重排 entries — 命中条目排前，与 sprint 主题更相关的经验先进入上下文
  const sprintTags = detectActiveSprintTags();
  const memoryDirs = compatReadDirs.map(baseDir => path.join(baseDir, 'projects', project.id, 'memory'));
  const memoryIndex = loadUnifiedMemoryIndex(
    memoryDirs,
    DEFAULT_MEMORY_CONFIG,
    { prioritizeTopics: sprintTags }
  );
  try {
    recordMemoryRecallMetric(memoryDirs, DEFAULT_MEMORY_CONFIG, {
      project,
      prioritizeTopics: sprintTags,
      telemetryDir: path.join(resolveBaseDir(), 'telemetry'),
    });
  } catch (error) {
    try {
      process.stderr.write(`[inject-context] memory recall telemetry failed: ${error && error.message ? error.message : error}\n`);
    } catch {}
  }
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

  // 4. demand-side 召回 manifest：记录本次注入了哪些 instinct domain（measure-before-enforce）。
  // WHY: 现有 recall 指标只测「注入了多少进索引」（供给侧）；此 manifest 让 Stop hook 能算
  // 「注入的 domain 本会话有没有被碰到」（需求侧）。只记 domain 名 + 计数，无 body 文本。
  try {
    const injectedInstincts = [...projectInstincts.slice(0, 10), ...globalInstincts.slice(0, 5)];
    writeInjectedManifest(path.join(resolveBaseDir(), 'telemetry'), {
      session_id: resolveSessionId({ fallback: false }) || '',
      project_id: project.id,
      timestamp: new Date().toISOString(),
      injected_domains: injectedInstincts.map((inst) => inst.domain).filter(Boolean),
      injected_instinct_count: injectedInstincts.length,
    });
  } catch (error) {
    try {
      process.stderr.write(`[inject-context] injected manifest failed: ${error && error.message ? error.message : error}\n`);
    } catch {}
  }

  if (sections.length === 0) {
    process.exit(0);
  }

  // demand-side 召回信号消费点 1：上次会话使用率附到 cost summary（高频可见）。
  // WHY: 让「注入的 domain 上次有没有被碰到」在压力大的会话（cost summary 触发时）可见。
  let demandSideLine = '';
  try {
    const latest = readLatestRecallUsage(path.join(resolveBaseDir(), 'telemetry'));
    if (latest && latest.injected_domain_count > 0) {
      const rate = latest.usage_rate === null ? 'n/a' : `${Math.round(latest.usage_rate * 100)}%`;
      const dormant = Array.isArray(latest.dormant_domains) && latest.dormant_domains.length > 0
        ? `; dormant=${latest.dormant_domains.join(', ')}`
        : '';
      demandSideLine = `prior-session demand-side recall: ${latest.used_domain_count}/${latest.injected_domain_count} domains used (${rate})${dormant}`;
    }
  } catch {}

  const context = renderContextWithOptionalCostSummary(sections, project.name, process.env, { demandSideLine });

  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context
    }
  });
  console.log(output);
}

// 只在直接作为脚本运行时跑 main；被 require 时仅 export 函数供测试。
if (require.main === module) {
  try { main(); } catch { process.exit(0); }
}

module.exports = {
  detectPendingHandoff,
  detectActiveSprintTags,
  renderSections,
  renderSectionsWithStats,
  shouldIncludeContextCostSummary,
  renderContextCostSummary,
  renderContextWithOptionalCostSummary,
};
