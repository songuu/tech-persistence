#!/usr/bin/env node

/**
 * evaluate-session.js — Stop Hook 会话评估器
 *
 * 融合：
 *   - ECC: 本能提取 + 置信度评分 + 域标签 + 进化路径
 *   - Claude-Mem: 会话摘要生成 + 结构化观察分类
 *
 * 在每次会话结束 (Stop) 时执行：
 *   1. 读取本次会话的所有观察
 *   2. 检测可重复的模式
 *   3. 创建/更新原子本能 (instinct)
 *   4. 生成会话摘要
 *   5. 健康检查 + 提示
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  resolveBaseDir,
  resolveProjectInstructionFile,
  resolveProjectRulesDir,
  resolveSessionId,
} = require('./lib/runtime-paths');
const {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_VERSION,
  hashText,
  parseFrontmatter,
  patternSignature,
  similarityScore,
  summarizeValue,
  topicForDomain,
  topicTitle,
  yamlEscape,
} = require('./lib/memory-v5');

// ─── 配置 ───
const CONFIG = {
  min_confidence: 0.3,
  auto_approve_threshold: 0.7,
  confidence_decay_rate: 0.05,
  confidence_boost: 0.1,
  cluster_threshold: 3, // 3+ 相关本能触发进化
  max_observations_per_session: 500,
  memory: DEFAULT_MEMORY_CONFIG,
  domains: [
    'code-style', 'testing', 'git', 'debugging', 'performance',
    'architecture', 'security', 'toolchain', 'api-design', 'workflow'
  ],
  observation_types: [
    'user_correction',   // 用户纠正了 Claude 的行为
    'error_resolution',  // 解决了一个错误
    'repeated_workflow',  // 反复出现的工作流模式
    'tool_preference',   // 偏好某种工具/方法
    'discovery',         // 新发现
    'decision',          // 做出了技术决策
  ]
};

// ─── 项目检测（与 observe.js 一致）───
function detectProject() {
  const { execSync } = require('child_process');
  const execOpts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    const remote = execSync('git remote get-url origin', execOpts).trim();
    if (remote) {
      const hash = crypto.createHash('sha256').update(remote).digest('hex').slice(0, 12);
      return { id: hash, name: path.basename(remote, '.git'), source: 'git-remote' };
    }
  } catch {}
  try {
    const root = execSync('git rev-parse --show-toplevel', execOpts).trim();
    if (root) {
      const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
      return { id: hash, name: path.basename(root), source: 'git-root' };
    }
  } catch {}
  const cwd = process.cwd();
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return { id: hash, name: path.basename(cwd), source: 'cwd' };
}

// ─── 路径解析 ───
function getPaths(project) {
  const hDir = resolveBaseDir();
  const localInstructionsFile = resolveProjectInstructionFile();
  return {
    baseDir: hDir,
    // 项目级
    projectDir: path.join(hDir, 'projects', project.id),
    projectObs: path.join(hDir, 'projects', project.id, 'observations.jsonl'),
    projectInstincts: path.join(hDir, 'projects', project.id, 'instincts'),
    projectMemory: path.join(hDir, 'projects', project.id, 'memory'),
    projectSessions: path.join(hDir, 'projects', project.id, 'sessions'),
    // 全局
    globalInstincts: path.join(hDir, 'instincts', 'personal'),
    registry: path.join(hDir, 'projects.json'),
    // 本地项目
    localRules: resolveProjectRulesDir(),
    localInstructionsFile,
    localInstructionsLabel: path.basename(localInstructionsFile),
  };
}

// ─── 读取本次会话的观察 ───
function readSessionObservations(obsPath) {
  if (!fs.existsSync(obsPath)) return [];
  const lines = fs.readFileSync(obsPath, 'utf-8').trim().split('\n').filter(Boolean);
  const sessionId = resolveSessionId({ fallback: false });

  return lines
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter(obs => {
      // 如果有 session_id，只取当前会话的
      if (sessionId && obs.session_id) return obs.session_id === sessionId;
      // 否则取最近 2 小时内的
      const age = Date.now() - new Date(obs.timestamp).getTime();
      return age < 2 * 60 * 60 * 1000;
    })
    .slice(-CONFIG.max_observations_per_session);
}

// ─── 模式检测 ───
function isPostObservation(obs) {
  return obs.phase === 'post';
}

function isEditObservation(obs) {
  const tool = String(obs.tool || '').toLowerCase();
  return [
    'write',
    'edit',
    'multiedit',
    'str_replace_editor',
    'apply_patch',
    'functions.apply_patch',
  ].some((name) => tool.includes(name));
}

function commandDomain(command) {
  const value = String(command || '').toLowerCase();
  if (/\b(test|vitest|jest|playwright|pytest|cargo test|go test)\b/.test(value)) return 'testing';
  if (/\b(lint|eslint|biome|tsc|typecheck|validate|preflight|check|build)\b/.test(value)) return 'toolchain';
  if (/\bgit\b/.test(value)) return 'git';
  return 'toolchain';
}

function commandDisplay(obs) {
  return obs.command || obs.command_family || obs.tool || 'unknown';
}

function buildPattern(rawPattern) {
  const pattern = {
    confidence: CONFIG.min_confidence,
    domain: 'workflow',
    evidence: '',
    ...rawPattern,
  };
  pattern.signature = pattern.signature || patternSignature(pattern);
  pattern.memory = pattern.memory || null;
  return pattern;
}

function detectPatterns(observations) {
  const patterns = [];
  const addPattern = (pattern) => patterns.push(buildPattern(pattern));
  const postObservations = observations.filter(isPostObservation);

  // 1. 工具使用频率统计
  const toolCounts = {};
  postObservations.forEach(obs => {
    if (obs.tool) {
      toolCounts[obs.tool] = (toolCounts[obs.tool] || 0) + 1;
    }
  });

  // 2. 检测重复工具序列（repeated_workflow）
  const toolSequence = postObservations
    .map(o => o.tool)
    .filter(Boolean);

  // 找长度 3+ 的重复子序列
  for (let len = 3; len <= 5; len++) {
    const seqCounts = {};
    for (let i = 0; i <= toolSequence.length - len; i++) {
      const seq = toolSequence.slice(i, i + len).join(' → ');
      seqCounts[seq] = (seqCounts[seq] || 0) + 1;
    }
    Object.entries(seqCounts)
      .filter(([, count]) => count >= 2)
      .forEach(([seq, count]) => {
        addPattern({
          type: 'repeated_workflow',
          description: `反复执行工具序列: ${seq}`,
          evidence: `本次会话中出现 ${count} 次`,
          confidence: Math.min(0.3 + count * 0.1, 0.7),
          domain: 'workflow',
          memory: {
            topic: 'workflow',
            summary: `观察到重复工具序列: ${seq}`,
            detail: `本次会话中出现 ${count} 次，可考虑沉淀为 skill 或脚本。`,
          },
        });
      });
  }

  // 3. 检测错误恢复模式：先失败，后续同类命令/工具成功
  const failedObservations = postObservations.filter(o =>
    o.error_signal === true ||
    o.status === 'error' ||
    /\b(error|exception|failed|failure|traceback|enoent)\b/i.test(o.output_summary || '')
  );
  const resolvedFailures = new Set();
  failedObservations.forEach((failed) => {
    const failedIndex = observations.indexOf(failed);
    const failedFamily = failed.command_family || failed.tool;
    const laterSuccess = postObservations.find((candidate) => {
      if (observations.indexOf(candidate) <= failedIndex) return false;
      const candidateFamily = candidate.command_family || candidate.tool;
      return candidateFamily === failedFamily && candidate.status === 'success';
    });
    if (!laterSuccess) return;
    resolvedFailures.add(failed);
    addPattern({
      type: 'error_resolution',
      description: `失败后恢复成功: ${failedFamily}`,
      evidence: `${commandDisplay(failed)} -> ${commandDisplay(laterSuccess)}`,
      confidence: 0.55,
      domain: 'debugging',
      command_family: failed.command_family || '',
      memory: {
        topic: 'debugging',
        summary: `当 ${failedFamily} 失败后，优先复用后续成功的同类验证路径。`,
        detail: `${summarizeValue(failed.output_summary || failed.input_summary, 180)} -> ${summarizeValue(laterSuccess.output_summary || laterSuccess.input_summary, 180)}`,
      },
    });
  });

  const unresolvedErrorCount = failedObservations.filter(obs => !resolvedFailures.has(obs)).length;
  if (unresolvedErrorCount > 0) {
    addPattern({
      type: 'error_observed',
      description: `会话中出现 ${unresolvedErrorCount} 个未确认恢复的错误/异常`,
      evidence: failedObservations
        .filter(obs => !resolvedFailures.has(obs))
        .slice(0, 5)
        .map(o => `${o.tool}: ${(o.output_summary || '').slice(0, 120)}`)
        .join('\n'),
      confidence: 0.3,
      domain: 'debugging',
    });
  }

  // 4. 检测文件编辑热区
  const editedFiles = {};
  observations
    .filter(isEditObservation)
    .forEach(o => {
      const paths = Array.isArray(o.input_paths) && o.input_paths.length > 0
        ? o.input_paths
        : [(o.input_summary || '').match(/(?:path|file)['":\s]+([^\s'"]+)/)?.[1]].filter(Boolean);
      paths.forEach((filePath) => {
        editedFiles[filePath] = (editedFiles[filePath] || 0) + 1;
      });
    });
  Object.entries(editedFiles)
    .filter(([, count]) => count >= 3)
    .forEach(([file, count]) => {
      addPattern({
        type: 'repeated_workflow',
        description: `频繁编辑文件: ${file} (${count} 次)`,
        evidence: `可能需要重构或抽取`,
        confidence: 0.3,
        domain: 'code-style',
        primary_file: file,
        memory: {
          topic: 'code-style',
          summary: `文件 ${file} 是高频修改点，相关改动应优先检查边界和重复逻辑。`,
          detail: `本次会话记录到 ${count} 次编辑。`,
        },
      });
    });

  // 5. 记录可复用的验证/工具链命令，形成类似 Claude Code auto memory 的项目索引
  const commandCounts = {};
  postObservations
    .filter(o => o.command && o.status !== 'error')
    .forEach((obs) => {
      commandCounts[obs.command] = (commandCounts[obs.command] || 0) + 1;
    });

  Object.entries(commandCounts)
    .filter(([command, count]) => count >= 2 || /\b(test|lint|validate|preflight|build|check|tsc)\b/i.test(command))
    .slice(0, 8)
    .forEach(([command, count]) => {
      const domain = commandDomain(command);
      addPattern({
        type: 'tool_preference',
        description: `项目常用命令: ${command}`,
        evidence: `本次会话成功/可用 ${count} 次`,
        confidence: Math.min(0.45 + count * 0.05, 0.75),
        domain,
        command_family: command,
        memory: {
          topic: domain,
          summary: `本项目可复用命令: \`${command}\`。`,
          detail: `本次会话观察到 ${count} 次成功或非错误执行。`,
        },
      });
    });

  return patterns;
}

// ─── 本能 (Instinct) 管理 ───
function loadInstincts(instinctDir) {
  if (!fs.existsSync(instinctDir)) return [];
  return fs.readdirSync(instinctDir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.md'))
    .map(f => {
      const content = fs.readFileSync(path.join(instinctDir, f), 'utf-8');
      const { meta } = parseFrontmatter(content);
      if (!meta || Object.keys(meta).length === 0) return null;
      return { ...meta, file: f, fullContent: content };
    })
    .filter(Boolean);
}

function replaceOrInsertFrontmatterField(content, key, value) {
  const field = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:\\s*.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, field);
  return content.replace(/^---\n/, `---\n${field}\n`);
}

function appendEvidence(content, evidenceLine) {
  const evidenceIdx = content.indexOf('## Evidence');
  if (evidenceIdx !== -1) {
    const relatedIdx = content.indexOf('## Related', evidenceIdx);
    if (relatedIdx !== -1) {
      return `${content.slice(0, relatedIdx).trimEnd()}\n${evidenceLine}\n\n${content.slice(relatedIdx)}`;
    }
  }
  const relatedIdx = content.indexOf('## Related');
  if (relatedIdx !== -1) {
    return `${content.slice(0, relatedIdx).trimEnd()}\n\n## Evidence\n${evidenceLine}\n\n${content.slice(relatedIdx)}`;
  }
  return `${content.trimEnd()}\n${evidenceLine}\n`;
}

function createOrUpdateInstinct(instinctDir, pattern) {
  fs.mkdirSync(instinctDir, { recursive: true });
  const existing = loadInstincts(instinctDir);

  // 检查是否有相似本能
  const similar = existing.find(inst =>
    inst.signature === pattern.signature ||
    (
      inst.domain === pattern.domain &&
      similarityScore(inst.trigger || inst.description || inst.id, pattern.description) >= 0.55
    )
  );

  if (similar) {
    // 更新置信度（提升）
    const oldConf = parseFloat(similar.confidence) || 0.3;
    const newConf = Math.min(Math.max(oldConf, pattern.confidence) + CONFIG.confidence_boost, 0.95);
    const filePath = path.join(instinctDir, similar.file);
    let content = fs.readFileSync(filePath, 'utf-8');
    content = replaceOrInsertFrontmatterField(content, 'confidence', newConf.toFixed(2));
    content = replaceOrInsertFrontmatterField(content, 'last_seen', `"${new Date().toISOString().split('T')[0]}"`);
    content = replaceOrInsertFrontmatterField(content, 'signature', yamlEscape(pattern.signature));
    content = replaceOrInsertFrontmatterField(content, 'memory_version', yamlEscape(MEMORY_VERSION));
    const evidenceLine = `\n- ${new Date().toISOString().split('T')[0]}: ${pattern.evidence.replace(/[\r\n]+/g, ' ').slice(0, 200)}`;
    content = appendEvidence(content, evidenceLine);
    fs.writeFileSync(filePath, content);
    return { action: 'updated', id: similar.id, newConfidence: newConf };
  }

  // 创建新本能
  const id = pattern.type.replace(/_/g, '-') + '-' + Date.now().toString(36);
  const filename = `${id}.md`;
  const dateStr = new Date().toISOString().split('T')[0];
  const safeDescription = pattern.description.replace(/[\r\n:]+/g, ' ').trim().slice(0, 80);
  const safeEvidence = pattern.evidence.replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  const safeDomain = pattern.domain.replace(/[\r\n:]+/g, '-');
  const content = `---
id: ${yamlEscape(id)}
trigger: ${yamlEscape(safeDescription)}
signature: ${yamlEscape(pattern.signature)}
confidence: ${pattern.confidence.toFixed(2)}
domain: ${yamlEscape(safeDomain)}
type: ${yamlEscape(pattern.type)}
source: "session-observation"
memory_version: ${yamlEscape(MEMORY_VERSION)}
created: "${dateStr}"
last_seen: "${dateStr}"
scope: ${yamlEscape(pattern.scope || 'project')}
tags: [instinct, ${yamlEscape(safeDomain)}]
aliases: [${yamlEscape(safeDescription.slice(0, 50))}]
---

# ${safeDescription.slice(0, 60)}

## Action
${safeDescription}

## Evidence
- ${dateStr}: ${safeEvidence}

## Related
`;

  fs.writeFileSync(path.join(instinctDir, filename), content);
  return { action: 'created', id, confidence: pattern.confidence };
}

// ─── 置信度衰减 ───
function decayInstincts(instinctDir) {
  if (!fs.existsSync(instinctDir)) return [];
  const decayed = [];
  const instincts = loadInstincts(instinctDir);

  instincts.forEach(inst => {
    if (!inst.last_seen) return;
    const daysSince = Math.floor(
      (Date.now() - new Date(inst.last_seen).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSince > 14) {
      const oldConf = parseFloat(inst.confidence) || 0.5;
      const decay = Math.floor(daysSince / 14) * CONFIG.confidence_decay_rate;
      const newConf = Math.max(oldConf - decay, 0.1);

      if (newConf !== oldConf) {
        const filePath = path.join(instinctDir, inst.file);
        let content = fs.readFileSync(filePath, 'utf-8');
        content = content.replace(
          /confidence:\s*[\d.]+/,
          `confidence: ${newConf.toFixed(2)}`
        );
        fs.writeFileSync(filePath, content);
        decayed.push({
          id: inst.id, from: oldConf, to: newConf,
          suggestDelete: newConf < 0.15
        });
      }
    }
  });

  return decayed;
}

// ─── Codex Memory v5: Claude Code auto-memory style index + topic files ───
function memoryEntryFromPattern(pattern) {
  if (!pattern.memory || pattern.confidence < CONFIG.memory.minMemoryConfidence) return null;
  const dateStr = new Date().toISOString().split('T')[0];
  const topic = topicForDomain(pattern.memory.topic || pattern.domain);
  const summary = summarizeValue(pattern.memory.summary || pattern.description, 220);
  if (!summary) return null;

  return {
    id: pattern.signature || patternSignature(pattern),
    date: dateStr,
    confidence: pattern.confidence,
    topic,
    type: pattern.type,
    summary,
    detail: summarizeValue(pattern.memory.detail || pattern.evidence, 260),
  };
}

function loadMemoryConfig(baseDir) {
  const configPath = path.join(baseDir, 'config.json');
  let configured = {};
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    configured = config.memory_v5 || config.memoryV5 || config.memory || {};
  } catch {}

  return {
    ...DEFAULT_MEMORY_CONFIG,
    enabled: configured.enabled !== false,
    indexMaxLines: configured.index_max_lines || configured.indexMaxLines || DEFAULT_MEMORY_CONFIG.indexMaxLines,
    indexMaxBytes: configured.index_max_bytes || configured.indexMaxBytes || DEFAULT_MEMORY_CONFIG.indexMaxBytes,
    maxIndexEntries: configured.max_index_entries || configured.maxIndexEntries || DEFAULT_MEMORY_CONFIG.maxIndexEntries,
    maxTopicEntries: configured.max_topic_entries || configured.maxTopicEntries || DEFAULT_MEMORY_CONFIG.maxTopicEntries,
    minMemoryConfidence: configured.min_memory_confidence || configured.minMemoryConfidence || DEFAULT_MEMORY_CONFIG.minMemoryConfidence,
  };
}

function topicFilePath(memoryDir, topic) {
  return path.join(memoryDir, `${topic}.md`);
}

function formatMemoryLine(entry) {
  const detail = entry.detail ? ` Evidence: ${entry.detail}` : '';
  return `- ${entry.date} [${entry.confidence.toFixed(2)}] [${entry.type}] ${entry.summary}${detail}`;
}

function topicFrontmatter(topic, project) {
  const dateStr = new Date().toISOString().split('T')[0];
  return `---
type: memory-topic
memory_version: ${yamlEscape(MEMORY_VERSION)}
topic: ${yamlEscape(topic)}
project: ${yamlEscape(project.name)}
updated: "${dateStr}"
tags: [memory, ${yamlEscape(topic)}]
---

# ${topicTitle(topic)} Memory

Generated by Tech Persistence memory v5. Keep durable notes here; MEMORY.md stays a concise startup index.

## Notes
`;
}

function upsertMemoryEntry(memoryDir, entry, project) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const filePath = topicFilePath(memoryDir, entry.topic);
  const marker = `<!-- memory:v5:${entry.id} -->`;
  const replacement = `${marker}\n${formatMemoryLine(entry)}`;
  let content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : topicFrontmatter(entry.topic, project);

  if (!content.includes('## Notes')) {
    content = `${content.trimEnd()}\n\n## Notes\n`;
  }

  const existingPattern = new RegExp(`<!-- memory:v5:${entry.id} -->\\r?\\n- [^\\n]*`, 'm');
  const action = existingPattern.test(content) ? 'updated' : 'created';
  if (action === 'updated') {
    content = content.replace(existingPattern, replacement);
  } else {
    content = `${content.trimEnd()}\n${replacement}\n`;
  }

  content = replaceOrInsertFrontmatterField(content, 'updated', `"${entry.date}"`);
  content = replaceOrInsertFrontmatterField(content, 'memory_version', yamlEscape(MEMORY_VERSION));
  content = pruneMemoryTopicEntries(content, entry.topic);
  fs.writeFileSync(filePath, content);
  return action;
}

function parseMemoryEntriesFromTopic(topic, content) {
  const entries = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const markerMatch = lines[i].match(/<!-- memory:v5:([a-f0-9]+) -->/);
    if (!markerMatch || !lines[i + 1].startsWith('- ')) continue;
    const line = lines[i + 1];
    const date = line.match(/^- (\d{4}-\d{2}-\d{2})/)?.[1] || '1970-01-01';
    const confidence = parseFloat(line.match(/\[(\d(?:\.\d+)?)\]/)?.[1] || '0.3');
    entries.push({
      id: markerMatch[1],
      topic,
      date,
      confidence,
      line,
    });
  }
  return entries;
}

function pruneMemoryTopicEntries(content, topic) {
  const entries = parseMemoryEntriesFromTopic(topic, content);
  if (entries.length <= CONFIG.memory.maxTopicEntries) return content;

  const keepIds = new Set(entries
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.date.localeCompare(a.date);
    })
    .slice(0, CONFIG.memory.maxTopicEntries)
    .map(entry => entry.id));

  const lines = content.split(/\r?\n/);
  const pruned = [];
  for (let i = 0; i < lines.length; i++) {
    const markerMatch = lines[i].match(/<!-- memory:v5:([a-f0-9]+) -->/);
    if (markerMatch && !keepIds.has(markerMatch[1])) {
      i += 1;
      continue;
    }
    pruned.push(lines[i]);
  }
  return pruned.join('\n');
}

function collectMemoryEntries(memoryDir) {
  if (!fs.existsSync(memoryDir)) return [];
  return fs.readdirSync(memoryDir)
    .filter(file => file.endsWith('.md') && file !== 'MEMORY.md')
    .flatMap((file) => {
      const topic = path.basename(file, '.md');
      const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
      return parseMemoryEntriesFromTopic(topic, content);
    });
}

function writeMemoryIndex(memoryDir, project) {
  const entries = collectMemoryEntries(memoryDir)
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.date.localeCompare(a.date);
    })
    .slice(0, CONFIG.memory.maxIndexEntries);

  const dateStr = new Date().toISOString().split('T')[0];
  const groupedTopics = [...new Set(entries.map(entry => entry.topic))].sort();
  const activeNotes = entries.map((entry) =>
    `- [${topicTitle(entry.topic)}] ${entry.line.replace(/^- \d{4}-\d{2}-\d{2} /, '')}`
  );
  const topicLines = groupedTopics.map(topic =>
    `- [[${topic}]] - ${entries.filter(entry => entry.topic === topic).length} active notes`
  );

  let content = `---
type: auto-memory-index
memory_version: ${yamlEscape(MEMORY_VERSION)}
project: ${yamlEscape(project.name)}
updated: "${dateStr}"
tags: [memory, index]
---

# MEMORY

This file is generated by Tech Persistence memory v5 and mirrors Claude Code auto memory: concise startup index first, detailed topic files on demand.

## Active Notes
${activeNotes.join('\n') || '- No durable notes yet.'}

## Topics
${topicLines.join('\n') || '- No topic files yet.'}
`;

  const lines = content.split(/\r?\n/);
  if (lines.length > CONFIG.memory.indexMaxLines) {
    content = lines.slice(0, CONFIG.memory.indexMaxLines).join('\n');
  }
  while (Buffer.byteLength(content, 'utf8') > CONFIG.memory.indexMaxBytes && activeNotes.length > 0) {
    activeNotes.pop();
    content = `---
type: auto-memory-index
memory_version: ${yamlEscape(MEMORY_VERSION)}
project: ${yamlEscape(project.name)}
updated: "${dateStr}"
tags: [memory, index]
---

# MEMORY

This file is generated by Tech Persistence memory v5 and mirrors Claude Code auto memory: concise startup index first, detailed topic files on demand.

## Active Notes
${activeNotes.join('\n') || '- No durable notes yet.'}

## Topics
${topicLines.join('\n') || '- No topic files yet.'}
`;
  }

  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), content);
  return entries.length;
}

function writeMemoryNotes(memoryDir, patterns, project) {
  const seen = new Set();
  const results = { created: 0, updated: 0, skipped: 0, indexed: 0 };
  patterns
    .map(memoryEntryFromPattern)
    .filter(Boolean)
    .forEach((entry) => {
      if (seen.has(entry.id)) {
        results.skipped += 1;
        return;
      }
      seen.add(entry.id);
      const action = upsertMemoryEntry(memoryDir, entry, project);
      results[action] += 1;
    });

  results.indexed = writeMemoryIndex(memoryDir, project);
  return results;
}

// ─── 生成会话摘要 ───
function generateSessionSummary(observations, patterns, instinctResults, memoryResults, project) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].slice(0, 5);
  const projectName = (project && project.name) || 'unknown';

  const toolStats = {};
  observations.filter(o => o.phase === 'post').forEach(o => {
    toolStats[o.tool] = (toolStats[o.tool] || 0) + 1;
  });

  const topTools = Object.entries(toolStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool, count]) => `${tool}(${count})`)
    .join(', ');

  // 收集本次涉及的本能 ID 用于 wikilinks
  const instinctLinks = instinctResults
    .filter(r => r.id)
    .map(r => `[[${r.id}]]`)
    .join(', ');

  return `---
date: "${dateStr}"
time: "${timeStr}"
project: "${projectName}"
type: session-summary
observations: ${observations.length}
patterns: ${patterns.length}
tags: [session, ${yamlEscape(projectName)}]
---

# Session ${dateStr} ${timeStr}

## Stats
- Observations: ${observations.length}
- Top tools: ${topTools || 'none'}
- Patterns detected: ${patterns.length}
- Instincts: +${instinctResults.filter(r => r.action === 'created').length} new, ${instinctResults.filter(r => r.action === 'updated').length} updated
- Memory v5: +${memoryResults.created} new, ${memoryResults.updated} updated, ${memoryResults.indexed} indexed

## Instinct Links
${instinctLinks || '_No instinct changes this session_'}
`;
}

// ─── 健康检查 ───
function healthCheck(paths) {
  const warnings = [];

  // CLAUDE.md / AGENTS.md 行数
  if (fs.existsSync(paths.localInstructionsFile)) {
    const lines = fs.readFileSync(paths.localInstructionsFile, 'utf-8').split('\n').length;
    if (lines > 200) {
      warnings.push(`⚠️  ${paths.localInstructionsLabel} 已 ${lines} 行 (建议 < 200)，考虑迁移到 ${path.relative(process.cwd(), paths.localRules)}/`);
    }
  }

  // rules 文件检查
  if (fs.existsSync(paths.localRules)) {
    fs.readdirSync(paths.localRules).filter(f => f.endsWith('.md')).forEach(f => {
      const lines = fs.readFileSync(path.join(paths.localRules, f), 'utf-8').split('\n').length;
      if (lines > 100) {
        warnings.push(`⚠️  ${path.join(path.relative(process.cwd(), paths.localRules), f)} 已 ${lines} 行 (建议 < 100)`);
      }
    });
  }

  // 观察文件大小
  if (fs.existsSync(paths.projectObs)) {
    const size = fs.statSync(paths.projectObs).size;
    if (size > 5 * 1024 * 1024) {
      warnings.push(`⚠️  观察日志 ${(size / 1024 / 1024).toFixed(1)}MB，建议运行 /retrospective 归档`);
    }
  }

  // 本能数量
  if (fs.existsSync(paths.projectInstincts)) {
    const count = fs.readdirSync(paths.projectInstincts).filter(f => f.endsWith('.md')).length;
    if (count > 50) {
      warnings.push(`⚠️  已有 ${count} 个本能，建议运行 /evolve 聚类进化`);
    }
  }

  // Memory v5 索引预算：对齐 Claude Code auto memory 的 200 行 / 25KB 启动索引
  const memoryIndex = path.join(paths.projectMemory, 'MEMORY.md');
  if (fs.existsSync(memoryIndex)) {
    const content = fs.readFileSync(memoryIndex, 'utf-8');
    const lines = content.split('\n').length;
    const size = Buffer.byteLength(content, 'utf8');
    if (lines > CONFIG.memory.indexMaxLines || size > CONFIG.memory.indexMaxBytes) {
      warnings.push(`⚠️  MEMORY.md 已 ${lines} 行 / ${(size / 1024).toFixed(1)}KB，建议裁剪 topic 索引`);
    }
  }

  return warnings;
}

// ─── 更新项目注册表 ───
function updateProjectRegistry(paths, project) {
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(paths.registry, 'utf-8'));
  } catch {}
  registry[project.id] = {
    name: project.name,
    source: project.source,
    lastSeen: new Date().toISOString(),
    path: process.cwd(),
  };
  fs.mkdirSync(path.dirname(paths.registry), { recursive: true });
  fs.writeFileSync(paths.registry, JSON.stringify(registry, null, 2));
}

// ─── Sprint 自动 Checkpoint ───
function detectActiveSprint() {
  const plansDir = path.join(process.cwd(), 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return null;

  const sprintDocs = fs.readdirSync(plansDir)
    .filter(f => f.endsWith('.md') && !f.includes('-handoff-') && f !== 'TEMPLATE.md')
    .map(f => {
      const content = fs.readFileSync(path.join(plansDir, f), 'utf-8');
      const statusMatch = content.match(/status:\s*["']?([\w-]+)["']?/);
      const status = statusMatch ? statusMatch[1] : null;
      const tasksDone = (content.match(/- \[x\]/gi) || []).length;
      const tasksTotal = (content.match(/- \[[ x]\]/gi) || []).length;
      return { file: f, status, content, tasksDone, tasksTotal };
    })
    .filter(d =>
      d.status &&
      ['in-progress', 'planning', 'reviewing', 'draft'].includes(d.status) &&
      !(d.tasksTotal > 0 && d.tasksDone >= d.tasksTotal)
    );

  return sprintDocs.length > 0 ? sprintDocs[0] : null;
}

function shouldAutoCheckpoint(observations) {
  if (process.env.TECH_PERSISTENCE_DISABLE_CHECKPOINT === '1') return false;
  if (process.env.TECH_PERSISTENCE_FORCE_CHECKPOINT === '1') return true;

  const toolCalls = observations.filter(isPostObservation).length;
  const editCalls = observations.filter(isEditObservation).length;
  return observations.length >= 30 || toolCalls >= 20 || editCalls >= 5;
}

function autoCheckpoint(sprint, observations) {
  if (!sprint) return null;

  const plansDir = path.join(process.cwd(), 'docs', 'plans');
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().split('T')[1].slice(0, 5);

  // 计算 handoff 编号
  const existingHandoffs = fs.readdirSync(plansDir)
    .filter(f => f.includes('-handoff-'))
    .length;
  const handoffNum = existingHandoffs + 1;

  // 从 sprint 文档中提取任务状态
  const tasksDone = (sprint.content.match(/- \[x\]/gi) || []).length;
  const tasksTotal = (sprint.content.match(/- \[[ x]\]/gi) || []).length;

  // 从观察中提取修改的文件
  const editedFiles = new Set();
  observations
    .filter(o => o.tool === 'Write' || o.tool === 'Edit' || o.tool === 'str_replace_editor')
    .forEach(o => {
      const fp = (o.input_summary || '').match(/(?:path|file)['":\s]+([^\s'"]+)/)?.[1];
      if (fp) editedFiles.add(fp);
    });

  // 生成交接文件
  const baseName = sprint.file.replace('.md', '');
  const handoffFile = `${baseName}-handoff-${handoffNum}.md`;
  const handoffContent = `---
type: sprint-handoff
sprint_doc: "docs/plans/${sprint.file}"
checkpoint_number: ${handoffNum}
created: "${now.toISOString()}"
phase: "${sprint.status}"
tasks_done: ${tasksDone}
tasks_total: ${tasksTotal}
tags: [handoff, sprint]
---

# Sprint Auto-Checkpoint #${handoffNum}

## Sprint 状态
- 文档: docs/plans/${sprint.file}
- 阶段: ${sprint.status}
- Task: ${tasksDone}/${tasksTotal} 完成
- 时间: ${dateStr} ${timeStr}

## 本次会话修改的文件
${[...editedFiles].map(f => `- ${f}`).join('\n') || '- (无文件修改记录)'}

## 本次会话观察统计
- 观察数: ${observations.length}
- 工具调用: ${observations.filter(o => o.phase === 'post').length}

## Related
- [[${baseName}]]
`;

  fs.writeFileSync(path.join(plansDir, handoffFile), handoffContent);
  return { file: handoffFile, tasksDone, tasksTotal };
}

// ─── 主流程 ───
function main() {
  const project = detectProject();
  const paths = getPaths(project);
  CONFIG.memory = loadMemoryConfig(paths.baseDir);

  // 确保目录存在
  [paths.projectDir, paths.projectInstincts, paths.projectMemory, paths.projectSessions, paths.globalInstincts]
    .forEach(dir => fs.mkdirSync(dir, { recursive: true }));

  // 更新注册表
  updateProjectRegistry(paths, project);

  // 1. 读取观察
  const observations = readSessionObservations(paths.projectObs);
  if (observations.length < 3) {
    console.log('💡 会话较短，跳过自动学习分析');
    return;
  }

  // 2. 检测模式
  const patterns = detectPatterns(observations);

  // 3. 创建/更新本能
  const instinctResults = [];
  patterns.forEach(pattern => {
    const targetDir = pattern.domain === 'workflow'
      ? paths.globalInstincts
      : paths.projectInstincts;
    pattern.scope = pattern.domain === 'workflow' ? 'global' : 'project';
    const result = createOrUpdateInstinct(targetDir, pattern);
    instinctResults.push(result);
  });

  // 4. 写入 Codex Memory v5 索引和 topic 文件
  const memoryResults = CONFIG.memory.enabled
    ? writeMemoryNotes(paths.projectMemory, patterns, project)
    : { created: 0, updated: 0, skipped: 0, indexed: 0 };

  // 5. 置信度衰减
  const projectDecayed = decayInstincts(paths.projectInstincts);
  const globalDecayed = decayInstincts(paths.globalInstincts);

  // 6. 生成会话摘要
  const summary = generateSessionSummary(observations, patterns, instinctResults, memoryResults, project);
  const summaryFile = path.join(
    paths.projectSessions,
    `${new Date().toISOString().split('T')[0]}-${Date.now().toString(36)}.md`
  );
  fs.writeFileSync(summaryFile, summary);

  // 7. 自动 Sprint Checkpoint (如果有活跃 sprint)
  const activeSprint = shouldAutoCheckpoint(observations) ? detectActiveSprint() : null;
  const checkpoint = autoCheckpoint(activeSprint, observations);

  // 8. 健康检查
  const warnings = healthCheck(paths);

  // 9. 输出报告
  console.log('');
  console.log(`📊 会话自学习报告 [${project.name}]`);
  console.log(`   观察: ${observations.length} | 模式: ${patterns.length} | 本能: +${instinctResults.filter(r => r.action === 'created').length} ↑${instinctResults.filter(r => r.action === 'updated').length} | Memory v5: +${memoryResults.created} ↑${memoryResults.updated}`);

  if (instinctResults.length > 0) {
    console.log('   本能变更:');
    instinctResults.forEach(r => {
      if (r.action === 'created') {
        console.log(`     🆕 ${r.id} (置信度 ${r.confidence})`);
      } else {
        console.log(`     ⬆️  ${r.id} → 置信度 ${r.newConfidence.toFixed(2)}`);
      }
    });
  }

  if (memoryResults.created > 0 || memoryResults.updated > 0) {
    console.log(`   Memory v5: MEMORY.md 索引 ${memoryResults.indexed} 条，topic notes +${memoryResults.created} ↑${memoryResults.updated}`);
  }

  const allDecayed = [...projectDecayed, ...globalDecayed];
  if (allDecayed.length > 0) {
    console.log(`   ⏬ ${allDecayed.length} 个本能置信度衰减`);
    allDecayed.filter(d => d.suggestDelete).forEach(d => {
      console.log(`     🗑️  建议删除: ${d.id} (置信度 ${d.to.toFixed(2)})`);
    });
  }

  if (checkpoint) {
    console.log(`   ⚡ Sprint 自动 checkpoint: ${checkpoint.file} (${checkpoint.tasksDone}/${checkpoint.tasksTotal} tasks)`);
    console.log(`     下次 /sprint resume 可从此处恢复`);
  }

  if (warnings.length > 0) {
    console.log('   健康检查:');
    warnings.forEach(w => console.log(`     ${w}`));
  }

  console.log('');
  console.log('   💡 运行 /compound 提取深度经验 | /instinct-status 查看所有本能');
  console.log('');
}

try { main(); } catch (err) {
  // Hook 错误不应中断 Claude Code 主流程
  // console.error('evaluate-session error:', err.message);
  process.exit(0);
}
