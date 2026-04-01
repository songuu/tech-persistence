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

// ─── 配置 ───
const CONFIG = {
  min_confidence: 0.3,
  auto_approve_threshold: 0.7,
  confidence_decay_rate: 0.05,
  confidence_boost: 0.1,
  cluster_threshold: 3, // 3+ 相关本能触发进化
  max_observations_per_session: 500,
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
  const home = process.env.HOME || process.env.USERPROFILE;
  const hDir = path.join(home, '.claude', 'homunculus');
  return {
    // 项目级
    projectDir: path.join(hDir, 'projects', project.id),
    projectObs: path.join(hDir, 'projects', project.id, 'observations.jsonl'),
    projectInstincts: path.join(hDir, 'projects', project.id, 'instincts'),
    projectSessions: path.join(hDir, 'projects', project.id, 'sessions'),
    // 全局
    globalInstincts: path.join(hDir, 'instincts', 'personal'),
    registry: path.join(hDir, 'projects.json'),
    // 本地项目
    localRules: path.join(process.cwd(), '.claude', 'rules'),
    localClaudeMd: path.join(process.cwd(), 'CLAUDE.md'),
  };
}

// ─── 读取本次会话的观察 ───
function readSessionObservations(obsPath) {
  if (!fs.existsSync(obsPath)) return [];
  const lines = fs.readFileSync(obsPath, 'utf-8').trim().split('\n').filter(Boolean);
  const sessionId = process.env.CLAUDE_SESSION_ID;

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
function detectPatterns(observations) {
  const patterns = [];

  // 1. 工具使用频率统计
  const toolCounts = {};
  observations.forEach(obs => {
    if (obs.phase === 'post' && obs.tool) {
      toolCounts[obs.tool] = (toolCounts[obs.tool] || 0) + 1;
    }
  });

  // 2. 检测重复工具序列（repeated_workflow）
  const toolSequence = observations
    .filter(o => o.phase === 'post')
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
        patterns.push({
          type: 'repeated_workflow',
          description: `反复执行工具序列: ${seq}`,
          evidence: `本次会话中出现 ${count} 次`,
          confidence: Math.min(0.3 + count * 0.1, 0.7),
          domain: 'workflow',
        });
      });
  }

  // 3. 检测错误解决模式 (error_resolution)
  const errorObs = observations.filter(o =>
    o.phase === 'post' && o.output_summary &&
    (o.output_summary.includes('error') || o.output_summary.includes('Error') ||
     o.output_summary.includes('FAIL') || o.output_summary.includes('exception'))
  );
  if (errorObs.length > 0) {
    patterns.push({
      type: 'error_resolution',
      description: `会话中遇到 ${errorObs.length} 个错误/异常`,
      evidence: errorObs.map(o => `${o.tool}: ${(o.output_summary || '').slice(0, 100)}`).join('\n'),
      confidence: 0.3,
      domain: 'debugging',
    });
  }

  // 4. 检测文件编辑热区
  const editedFiles = {};
  observations
    .filter(o => o.tool === 'Write' || o.tool === 'Edit' || o.tool === 'str_replace_editor')
    .forEach(o => {
      const filePath = (o.input_summary || '').match(/(?:path|file)['":\s]+([^\s'"]+)/)?.[1];
      if (filePath) editedFiles[filePath] = (editedFiles[filePath] || 0) + 1;
    });
  Object.entries(editedFiles)
    .filter(([, count]) => count >= 3)
    .forEach(([file, count]) => {
      patterns.push({
        type: 'repeated_workflow',
        description: `频繁编辑文件: ${file} (${count} 次)`,
        evidence: `可能需要重构或抽取`,
        confidence: 0.3,
        domain: 'code-style',
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
      // 解析 YAML frontmatter
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const meta = {};
      match[1].split('\n').forEach(line => {
        const [key, ...vals] = line.split(':');
        if (key && vals.length) meta[key.trim()] = vals.join(':').trim().replace(/^["']|["']$/g, '');
      });
      return { ...meta, file: f, fullContent: content };
    })
    .filter(Boolean);
}

function createOrUpdateInstinct(instinctDir, pattern) {
  fs.mkdirSync(instinctDir, { recursive: true });
  const existing = loadInstincts(instinctDir);

  // 检查是否有相似本能
  const similar = existing.find(inst =>
    inst.domain === pattern.domain &&
    (inst.description || '').includes(pattern.description.slice(0, 30))
  );

  if (similar) {
    // 更新置信度（提升）
    const oldConf = parseFloat(similar.confidence) || 0.3;
    const newConf = Math.min(oldConf + CONFIG.confidence_boost, 0.95);
    const filePath = path.join(instinctDir, similar.file);
    let content = fs.readFileSync(filePath, 'utf-8');
    content = content.replace(
      /confidence:\s*[\d.]+/,
      `confidence: ${newConf.toFixed(2)}`
    );
    content = content.replace(
      /last_seen:\s*.*/,
      `last_seen: "${new Date().toISOString().split('T')[0]}"`
    );
    // 追加证据
    content += `\n- ${new Date().toISOString().split('T')[0]}: ${pattern.evidence.slice(0, 200)}`;
    fs.writeFileSync(filePath, content);
    return { action: 'updated', id: similar.id, newConfidence: newConf };
  }

  // 创建新本能
  const id = pattern.type.replace(/_/g, '-') + '-' + Date.now().toString(36);
  const filename = `${id}.md`;
  const content = `---
id: "${id}"
trigger: "${pattern.description.slice(0, 80)}"
confidence: ${pattern.confidence.toFixed(2)}
domain: "${pattern.domain}"
type: "${pattern.type}"
source: "session-observation"
created: "${new Date().toISOString().split('T')[0]}"
last_seen: "${new Date().toISOString().split('T')[0]}"
scope: "project"
---

# ${pattern.description.slice(0, 60)}

## Action
${pattern.description}

## Evidence
- ${new Date().toISOString().split('T')[0]}: ${pattern.evidence.slice(0, 500)}
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
        decayed.push({ id: inst.id, from: oldConf, to: newConf });
      }

      // 置信度降到 0.15 以下，标记为候选删除
      if (newConf < 0.15) {
        decayed.push({ id: inst.id, to: newConf, suggestDelete: true });
      }
    }
  });

  return decayed;
}

// ─── 生成会话摘要 ───
function generateSessionSummary(observations, patterns, instinctResults) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].slice(0, 5);

  const toolStats = {};
  observations.filter(o => o.phase === 'post').forEach(o => {
    toolStats[o.tool] = (toolStats[o.tool] || 0) + 1;
  });

  const topTools = Object.entries(toolStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool, count]) => `${tool}(${count})`)
    .join(', ');

  return `## 会话 ${dateStr} ${timeStr}
- 观察数: ${observations.length}
- 主要工具: ${topTools || '无'}
- 检测模式: ${patterns.length} 个
- 本能更新: ${instinctResults.filter(r => r.action === 'updated').length} 条更新, ${instinctResults.filter(r => r.action === 'created').length} 条新增
`;
}

// ─── 健康检查 ───
function healthCheck(paths) {
  const warnings = [];

  // CLAUDE.md 行数
  if (fs.existsSync(paths.localClaudeMd)) {
    const lines = fs.readFileSync(paths.localClaudeMd, 'utf-8').split('\n').length;
    if (lines > 200) {
      warnings.push(`⚠️  CLAUDE.md 已 ${lines} 行 (建议 < 200)，考虑迁移到 .claude/rules/`);
    }
  }

  // rules 文件检查
  if (fs.existsSync(paths.localRules)) {
    fs.readdirSync(paths.localRules).filter(f => f.endsWith('.md')).forEach(f => {
      const lines = fs.readFileSync(path.join(paths.localRules, f), 'utf-8').split('\n').length;
      if (lines > 100) {
        warnings.push(`⚠️  .claude/rules/${f} 已 ${lines} 行 (建议 < 100)`);
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

// ─── 主流程 ───
function main() {
  const project = detectProject();
  const paths = getPaths(project);

  // 确保目录存在
  [paths.projectDir, paths.projectInstincts, paths.projectSessions, paths.globalInstincts]
    .forEach(dir => fs.mkdirSync(dir, { recursive: true }));

  // 更新注册表
  updateProjectRegistry(paths, project);

  // 1. 读取观察
  const observations = readSessionObservations(paths.projectObs);
  if (observations.length < 3) {
    // 会话太短，不分析
    console.log('💡 会话较短，跳过自动学习分析');
    return;
  }

  // 2. 检测模式
  const patterns = detectPatterns(observations);

  // 3. 创建/更新本能
  const instinctResults = [];
  patterns.forEach(pattern => {
    // 判断作用域：通用经验 → global，项目特定 → project
    const targetDir = pattern.domain === 'workflow'
      ? paths.globalInstincts
      : paths.projectInstincts;
    const result = createOrUpdateInstinct(targetDir, pattern);
    instinctResults.push(result);
  });

  // 4. 置信度衰减
  const projectDecayed = decayInstincts(paths.projectInstincts);
  const globalDecayed = decayInstincts(paths.globalInstincts);

  // 5. 生成会话摘要
  const summary = generateSessionSummary(observations, patterns, instinctResults);
  const summaryFile = path.join(
    paths.projectSessions,
    `${new Date().toISOString().split('T')[0]}-${Date.now().toString(36)}.md`
  );
  fs.writeFileSync(summaryFile, summary);

  // 6. 健康检查
  const warnings = healthCheck(paths);

  // 7. 输出报告
  console.log('');
  console.log(`📊 会话自学习报告 [${project.name}]`);
  console.log(`   观察: ${observations.length} | 模式: ${patterns.length} | 本能: +${instinctResults.filter(r => r.action === 'created').length} ↑${instinctResults.filter(r => r.action === 'updated').length}`);

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

  const allDecayed = [...projectDecayed, ...globalDecayed];
  if (allDecayed.length > 0) {
    console.log(`   ⏬ ${allDecayed.length} 个本能置信度衰减`);
    allDecayed.filter(d => d.suggestDelete).forEach(d => {
      console.log(`     🗑️  建议删除: ${d.id} (置信度 ${d.to.toFixed(2)})`);
    });
  }

  if (warnings.length > 0) {
    console.log('   健康检查:');
    warnings.forEach(w => console.log(`     ${w}`));
  }

  console.log('');
  console.log('   💡 运行 /learn 手动提取深度经验 | /instinct-status 查看所有本能');
  console.log('');
}

try { main(); } catch (err) {
  // Hook 错误不应中断 Claude Code 主流程
  // console.error('evaluate-session error:', err.message);
  process.exit(0);
}
