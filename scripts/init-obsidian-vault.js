#!/usr/bin/env node

/**
 * init-obsidian-vault.js — 将 Homunculus 知识库初始化为 Obsidian Vault
 *
 * 功能：
 *   1. 在 homunculus/Obsidian vault 下生成 .obsidian/ 配置
 *   2. 创建 _templates/ 模板（供 Templater 插件使用）
 *   3. 配置排除规则（.jsonl, archive/ 等非 markdown 文件）
 *   4. 生成 MCP Server 配置片段
 *   5. 幂等：已有 vault 只刷新系统管理的派生配置（graph.json colorGroups / Dashboard），
 *      保留用户偏好（app.json / appearance.json / graph 布局）；无变化则不写、不产生备份
 *
 * 用法：
 *   node scripts/init-obsidian-vault.js [--vault-path <path>] [--claude|--codex|--shared]
 */

const fs = require('fs');
const path = require('path');
const { syncObsidianSolutionProjection } = require('./sync-solution-index');

// ─── 参数解析 + 路径安全校验 ───
function parseArgs() {
  const args = process.argv.slice(2);
  let vaultPath = null;
  let runtime = null;
  const home = process.env.HOME || process.env.USERPROFILE;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--vault-path' && args[i + 1]) {
      vaultPath = args[i + 1];
      i++;
    } else if (args[i] === '--claude' || args[i] === '--codex' || args[i] === '--shared') {
      runtime = args[i].slice(2);
    }
  }

  if (!vaultPath) {
    vaultPath = defaultVaultPath(home, runtime);
  }

  // 解析为绝对路径，防止路径遍历
  // 用 realpathSync 解决 Windows 短路径名（ADMINI~1 vs Administrator）
  try { vaultPath = fs.realpathSync(path.resolve(vaultPath)); } catch { vaultPath = path.resolve(vaultPath); }

  // 安全校验：vault 必须在用户 home 目录下
  let homeResolved;
  try { homeResolved = fs.realpathSync(path.resolve(home)); } catch { homeResolved = path.resolve(home); }
  if (!vaultPath.startsWith(homeResolved + path.sep) && vaultPath !== homeResolved) {
    console.error(`❌ 安全限制: vault 路径必须在用户目录内 (${homeResolved})`);
    console.error(`   提供的路径: ${vaultPath}`);
    process.exit(1);
  }

  return { vaultPath };
}

function expandHome(value, home) {
  if (!value) return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function readSharedConfig(home) {
  const configPath = process.env.TECH_PERSISTENCE_CONFIG
    ? path.resolve(expandHome(process.env.TECH_PERSISTENCE_CONFIG, home))
    : path.join(home, '.tech-persistence', 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

function sharedVaultPath(home) {
  if (process.env.TECH_PERSISTENCE_HOME) {
    return path.resolve(expandHome(process.env.TECH_PERSISTENCE_HOME, home));
  }
  const config = readSharedConfig(home);
  const configured = config && (config.homunculusHome || config.homunculusDir || config.vaultPath);
  return configured ? path.resolve(expandHome(configured, home)) : null;
}

function defaultVaultPath(home, runtime) {
  if (runtime === 'claude') return path.join(home, '.claude', 'homunculus');
  if (runtime === 'codex') return path.join(home, '.codex', 'homunculus');

  const shared = sharedVaultPath(home);
  if (runtime === 'shared' && !shared) {
    console.error('❌ 未找到共享 homunculus 配置。请先运行 scripts/configure-shared-homunculus.js。');
    process.exit(1);
  }
  return shared || path.join(home, '.claude', 'homunculus');
}

// ─── Obsidian 核心配置 ───
function generateAppConfig() {
  return {
    livePreview: true,
    defaultViewMode: 'source',
    showFrontmatter: true,
    foldHeading: true,
    foldIndent: true,
    useTab: false,
    tabSize: 2,
    readableLineLength: true,
    strictLineBreaks: false,
    newFileLocation: 'folder',
    newFileFolderPath: '_inbox',
    attachmentFolderPath: '_attachments',
    alwaysUpdateLinks: true,
    promptDelete: false
  };
}

// ─── Obsidian 外观配置 ───
function generateAppearanceConfig() {
  return {
    baseFontSize: 16,
    interfaceFontSize: 14,
    enabledCssSnippets: []
  };
}

// ─── 跨设备同步排除：单一事实源 ───
// 这些文件跨设备/跨终端同步会丢数据或损坏 vault，必须被同步工具排除。
// 见 docs/solutions/2026-06-02-obsidian-cross-device.md。
// targets 指该规则应进入哪些目标的 ignore（不同工具语义不同）：
//   obsidian  → .obsidianignore（Obsidian 索引/视图排除）
//   git       → vault 内 .gitignore（git-based 同步，桌面推荐）
//   syncthing → vault 内 .stignore（Syncthing 同步）
const SYNC_EXCLUDES = [
  { pattern: '*.jsonl', targets: ['obsidian', 'git', 'syncthing'] },             // append-only 无锁遥测，文件级同步丢行
  { pattern: '.agent-runs/', targets: ['obsidian', 'git', 'syncthing'] },        // agent-loop 运行态临时目录
  { pattern: 'archive/', targets: ['obsidian', 'git', 'syncthing'] },            // 归档历史，无需跨设备
  { pattern: 'node_modules/', targets: ['obsidian', 'git', 'syncthing'] },       // 依赖目录
  { pattern: '*.bak.*', targets: ['obsidian', 'git', 'syncthing'] },             // 本地备份
  { pattern: '.obsidian/workspace.json', targets: ['git', 'syncthing'] },        // 高频重写的桌面布局，双向同步永久冲突
  { pattern: '.obsidian/workspace-mobile.json', targets: ['git', 'syncthing'] }, // 移动端布局，与桌面天生不同
  { pattern: '.git/', targets: ['obsidian', 'syncthing'] }                       // git 内部目录：obsidian=不索引 git 对象；syncthing=文件级同步会损坏 refs；.gitignore 列它无意义故不入 git 目标
];

function excludesForTarget(target) {
  return SYNC_EXCLUDES.filter((entry) => entry.targets.includes(target)).map((entry) => entry.pattern);
}

// ─── 文件排除配置 ───
// .obsidianignore：Obsidian 索引/视图排除。向后兼容——原有 5 条规则全部保留，仅新增 .agent-runs/ 防御。
function generateUserIgnores() {
  return excludesForTarget('obsidian').join('\n');
}

// vault 内 .gitignore：git-based 跨设备同步（桌面推荐路径）开箱即排除危险文件，无需用户手动配置。
function generateGitignore() {
  return [
    '# tech-persistence vault — git-based 跨设备同步排除（init-obsidian-vault.js 自动生成）',
    '# 见 docs/solutions/2026-06-02-obsidian-cross-device.md。铁律：一个 vault 只能有一个同步权威。',
    ...excludesForTarget('git')
  ].join('\n');
}

// vault 内 .stignore：Syncthing 跨设备同步排除（Syncthing 用 // 作注释）。
function generateStignore() {
  return [
    '// tech-persistence vault — Syncthing 跨设备同步排除（init-obsidian-vault.js 自动生成）',
    '// 见 docs/solutions/2026-06-02-obsidian-cross-device.md',
    ...excludesForTarget('syncthing')
  ].join('\n');
}

// 同步排除文件的幂等写入：存在则只补缺失规则（不覆盖用户自定义），不存在则新建。
// 注释行（# 或 //）不计入"缺失规则"检测，只用于新建时的文件头。
function upsertIgnoreFile(vaultPath, filename, content) {
  const targetPath = path.join(vaultPath, filename);
  const requiredRules = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
  if (fs.existsSync(targetPath)) {
    const existing = fs.readFileSync(targetPath, 'utf-8');
    // 按规则行精确匹配（不是子串）：剥离 existing 的注释/空行后比对整行，
    // 否则 'logs/*.jsonl.bak' 会吞没 '*.jsonl'、注释提到 '.git/' 会误判已存在 → 数据安全级规则静默漏补。
    const existingRules = new Set(
      existing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'))
    );
    const missing = requiredRules.filter((rule) => !existingRules.has(rule));
    if (missing.length > 0) {
      fs.appendFileSync(targetPath, '\n' + missing.join('\n') + '\n');
      console.log(`   ✅ ${filename} 补充 ${missing.length} 条规则`);
    } else {
      console.log(`   ⚠️  ${filename} 已存在且完整，跳过`);
    }
  } else {
    fs.writeFileSync(targetPath, content.endsWith('\n') ? content : content + '\n');
    console.log(`   ✅ ${filename} 排除规则`);
  }
}

// ─── Graph View 配置 ───
function generateGraphConfig() {
  return {
    collapse_filter: false,
    search: '',
    showTags: true,
    showAttachments: false,
    hideUnresolved: false,
    showOrphans: true,
    collapse_color: false,
    // 配色仅覆盖真正写入 vault 的产出类型（与 Dashboard dataview 查询、README 接入表三方一致）。
    // rule/architecture 是 repo 内的注入层规则（.claude/rules/），不写入 homunculus vault，
    // 故不配色——否则是永不命中的空转配置（见 docs/plans/2026-06-01-obsidian-integration-completeness.md）。
    colorGroups: [
      { query: 'tag:#instinct', color: { a: 1, rgb: 5373645 } },
      { query: 'tag:#memory', color: { a: 1, rgb: 3899638 } },
      { query: 'tag:#session', color: { a: 1, rgb: 2263842 } },
      { query: 'tag:#solution', color: { a: 1, rgb: 65382 } },
      { query: 'tag:#sprint', color: { a: 1, rgb: 29695 } },
      { query: 'tag:#handoff', color: { a: 1, rgb: 16761095 } }
    ],
    collapse_display: false,
    lineSizeMultiplier: 1,
    nodeSizeMultiplier: 1,
    textFadeMultiplier: 0,
    collapse_forces: false,
    centerStrength: 0.518713,
    repelStrength: 10,
    linkStrength: 1,
    linkDistance: 250,
    scale: 1,
    close: false
  };
}

// ─── graph.json 刷新：只替换系统管理的 colorGroups，保留用户布局偏好 ───
// colorGroups（tag→color 映射）是随产出类型演化的派生配置，必须与最新 tag 类同步；
// 其余字段（scale/forces/repelStrength 等）是用户在 Obsidian 图谱界面里调的布局偏好，保留不动。
function mergeGraphColorGroups(existing) {
  return { ...existing, colorGroups: generateGraphConfig().colorGroups };
}

// ─── 模板文件 ───
function generateInstinctTemplate() {
  return `---
id: "{{id}}"
trigger: "{{trigger}}"
confidence: {{confidence}}
domain: "{{domain}}"
type: "{{type}}"
source: "session-observation"
created: "{{date}}"
last_seen: "{{date}}"
scope: "{{scope}}"
tags:
  - instinct
  - "{{domain}}"
aliases:
  - "{{trigger}}"
---

# {{trigger}}

## Action
{{description}}

## Evidence
- {{date}}: {{evidence}}

## Related
`;
}

function generateSessionTemplate() {
  return `---
date: "{{date}}"
time: "{{time}}"
project: "{{project}}"
type: session-summary
tags:
  - session
  - "{{project}}"
---

# Session {{date}} {{time}}

## Stats
- Observations: {{observations}}
- Patterns: {{patterns}}
- Instincts: {{instincts}}

## Tools Used
{{tools}}

## Patterns Detected
{{pattern_details}}

## Instinct Changes
{{instinct_changes}}
`;
}

function generateSolutionTemplate() {
  return `---
title: "{{title}}"
date: "{{date}}"
tags:
  - solution
  - "{{domain}}"
related_instincts: []
---

# {{title}}

## Problem
{{problem}}

## Root Cause
{{root_cause}}

## Solution
{{solution}}

## Prevention
{{prevention}}

## Related
`;
}

function generateHandoffTemplate() {
  return `---
type: sprint-handoff
sprint_doc: "{{sprint_doc}}"
checkpoint_number: {{number}}
created: "{{datetime}}"
phase: "{{phase}}"
tasks_done: {{tasks_done}}
tasks_total: {{tasks_total}}
tags:
  - handoff
  - sprint
---

# Sprint Handoff #{{number}}

## Sprint 状态
- 文档: {{sprint_doc}}
- 阶段: {{phase}}
- Task: {{tasks_done}}/{{tasks_total}} 完成

## 已完成的 Task

## 未完成的 Task

## 关键决策

## 已修改的文件

## 当前测试状态

## 下一步

## Related
- [[{{sprint_doc_name}}]]
`;
}

function generateDashboard() {
  return `---
tags:
  - dashboard
  - MOC
aliases:
  - Home
  - Index
---

# Knowledge Dashboard

> Auto-generated by tech-persistence. This is the entry point for the Obsidian vault.

## Quick Links
- [[instinct-index|All Instincts]]
- [[session-index|Session History]]
- [[persona|User Persona]]

## Knowledge Areas
- \`#debugging\` — Debugging gotchas and patterns
- \`#architecture\` — Architecture decisions
- \`#performance\` — Performance findings
- \`#code-style\` — Code style preferences
- \`#testing\` — Testing patterns
- \`#workflow\` — Workflow automations
- \`#security\` — Security considerations

## Recent
\`\`\`dataview
TABLE confidence, domain, last_seen
FROM #instinct
SORT last_seen DESC
LIMIT 10
\`\`\`

## High Confidence Instincts
\`\`\`dataview
TABLE confidence, domain, trigger
FROM #instinct
WHERE number(confidence) >= 0.7
SORT confidence DESC
\`\`\`

## Active Sprints
\`\`\`dataview
TABLE status, tasks_done + "/" + tasks_total AS progress
FROM #sprint
WHERE status != "completed"
SORT file.mtime DESC
\`\`\`

## Recent Checkpoints
\`\`\`dataview
TABLE sprint_doc, phase, checkpoint_number
FROM #handoff
SORT created DESC
LIMIT 5
\`\`\`

## Recent Solutions
\`\`\`dataview
TABLE date
FROM #solution
SORT date DESC
LIMIT 5
\`\`\`

## Memory Topics
\`\`\`dataview
TABLE topic, project, updated
FROM #memory
WHERE type = "memory-topic"
SORT updated DESC
LIMIT 10
\`\`\`

## Recent Sessions
\`\`\`dataview
TABLE project, time
FROM #session
SORT date DESC
LIMIT 10
\`\`\`
`;
}

// ─── MCP 配置生成 ───
function generateMcpConfig(vaultPath) {
  return {
    mcpServers: {
      obsidian: {
        command: 'npx',
        args: ['-y', '@bitbonsai/mcpvault@latest', vaultPath.replace(/\\/g, '/')]
      }
    }
  };
}

// ─── 主流程 ───
function main() {
  const { vaultPath } = parseArgs();

  console.log('');
  console.log('🗄️  Obsidian Vault 初始化');
  console.log(`   Vault 路径: ${vaultPath}`);
  console.log('');

  // 检查 vault 目录存在
  if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
    console.log('   📁 创建 vault 目录');
  }

  // .obsidian/ 配置（缺失项补齐；graph.json 已存在则刷新 colorGroups 保留布局偏好）
  const obsidianDir = path.join(vaultPath, '.obsidian');
  fs.mkdirSync(obsidianDir, { recursive: true });

  // app.json / appearance.json 是用户偏好，仅在缺失时写入，不覆盖已有自定义
  const appPath = path.join(obsidianDir, 'app.json');
  if (!fs.existsSync(appPath)) {
    fs.writeFileSync(appPath, JSON.stringify(generateAppConfig(), null, 2));
  }
  const appearancePath = path.join(obsidianDir, 'appearance.json');
  if (!fs.existsSync(appearancePath)) {
    fs.writeFileSync(appearancePath, JSON.stringify(generateAppearanceConfig(), null, 2));
  }

  // graph.json：缺失则全量生成；已存在则只刷新 colorGroups（与最新产出类型同步），布局偏好保留。
  // 幂等：合并结果与现状一致时不写、不备份，避免重复安装堆积 .bak 垃圾。
  const graphPath = path.join(obsidianDir, 'graph.json');
  if (!fs.existsSync(graphPath)) {
    fs.writeFileSync(graphPath, JSON.stringify(generateGraphConfig(), null, 2));
    console.log('   ✅ .obsidian/ 配置生成');
  } else {
    let existingGraph = null;
    try {
      existingGraph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    } catch {
      existingGraph = null;
    }
    if (!existingGraph || typeof existingGraph !== 'object') {
      // 解析失败/格式异常：备份后重写为 canonical，避免静默丢弃用户文件
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      fs.copyFileSync(graphPath, graphPath + '.bak.' + ts);
      fs.writeFileSync(graphPath, JSON.stringify(generateGraphConfig(), null, 2));
      console.log('   ✅ graph.json 损坏已重写 (旧版已备份)');
    } else {
      const merged = mergeGraphColorGroups(existingGraph);
      if (JSON.stringify(merged) !== JSON.stringify(existingGraph)) {
        fs.writeFileSync(graphPath, JSON.stringify(merged, null, 2));
        console.log('   ✅ graph.json colorGroups 已刷新 (布局偏好保留)');
      } else {
        console.log('   ⚠️  graph.json colorGroups 已是最新，跳过');
      }
    }
  }

  // 同步排除文件（幂等合并，不覆盖用户自定义）：
  //   .obsidianignore → Obsidian 索引/视图排除
  //   .gitignore      → git-based 跨设备同步（桌面推荐）开箱排除危险文件
  //   .stignore       → Syncthing 跨设备同步排除
  // 注：Obsidian Sync / iCloud / Dropbox 的排除需在各自 App 内配置，无法靠 vault 文件自动化（见 obsidian-setup.md）。
  upsertIgnoreFile(vaultPath, '.obsidianignore', generateUserIgnores());
  upsertIgnoreFile(vaultPath, '.gitignore', generateGitignore());
  upsertIgnoreFile(vaultPath, '.stignore', generateStignore());

  // _templates/
  const templatesDir = path.join(vaultPath, '_templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'instinct.md'), generateInstinctTemplate());
  fs.writeFileSync(path.join(templatesDir, 'session-summary.md'), generateSessionTemplate());
  fs.writeFileSync(path.join(templatesDir, 'solution.md'), generateSolutionTemplate());
  fs.writeFileSync(path.join(templatesDir, 'handoff.md'), generateHandoffTemplate());
  console.log('   ✅ _templates/ 模板文件 (4 个)');

  // _inbox/ (新笔记默认位置)
  const inboxDir = path.join(vaultPath, '_inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  // Dashboard（系统管理的 MOC；幂等：与 canonical 一致则跳过，避免重复安装堆积 .bak 垃圾）
  const dashboardPath = path.join(vaultPath, 'Dashboard.md');
  const dashboardContent = generateDashboard();
  if (fs.existsSync(dashboardPath)) {
    const existingDashboard = fs.readFileSync(dashboardPath, 'utf-8');
    if (existingDashboard === dashboardContent) {
      console.log('   ⚠️  Dashboard.md 已是最新，跳过');
    } else {
      // 内容有差异（drift 或用户手改）才备份后重写
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      fs.copyFileSync(dashboardPath, dashboardPath + '.bak.' + ts);
      fs.writeFileSync(dashboardPath, dashboardContent);
      console.log('   ✅ Dashboard.md 更新 (旧版已备份)');
    }
  } else {
    fs.writeFileSync(dashboardPath, dashboardContent);
    console.log('   ✅ Dashboard.md 知识仪表板');
  }

  const solutionProjection = syncObsidianSolutionProjection(process.cwd(), {
    obsidianVault: vaultPath,
  });
  if (solutionProjection) {
    const rel = path.relative(vaultPath, solutionProjection.targetDir).replace(/\\/g, '/');
    if (solutionProjection.changed) {
      console.log(`   ✅ ${rel}/ 解决方案投影 (${solutionProjection.written} synced, ${solutionProjection.removed} removed)`);
    } else {
      console.log(`   ⚠️  ${rel}/ 解决方案投影已是最新`);
    }
  }

  // evolved/ 目录（确保存在）
  const evolvedDirs = ['evolved/skills', 'evolved/rules', 'skill-signals', 'skill-evals', 'skill-changelog'];
  evolvedDirs.forEach(dir => {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
  });

  // MCP 配置输出
  const mcpConfig = generateMcpConfig(vaultPath);
  const mcpConfigPath = path.join(vaultPath, '_mcp-config-snippet.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  console.log('');
  console.log('   📋 MCP Server 配置已写入: _mcp-config-snippet.json');
  console.log('   将其合并到 Claude Code 或 Codex 的 mcpServers 字段即可');
  console.log('');
  console.log('   下一步:');
  console.log('   1. 用 Obsidian 打开此 vault: ' + vaultPath);
  console.log('   2. 安装推荐插件: Dataview, Templater, Graph Analysis');
  console.log('   3. 将 _mcp-config-snippet.json 合并到 Claude Code 配置');
  console.log('   4. 正常使用 /compound 或 $compound — 知识会自动出现在 Obsidian 中');
  console.log('');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ 初始化失败:', err.message);
    process.exit(1);
  }
}

module.exports = {
  generateGraphConfig,
  mergeGraphColorGroups,
  generateDashboard,
  generateAppConfig,
  parseArgs,
  defaultVaultPath,
  SYNC_EXCLUDES,
  excludesForTarget,
  generateUserIgnores,
  generateGitignore,
  generateStignore,
  upsertIgnoreFile,
};
