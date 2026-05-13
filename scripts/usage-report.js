#!/usr/bin/env node
'use strict';

/**
 * usage-report.js — 21 个 tech-persistence 命令精准使用率报告
 *
 * 数据源（精准）：
 *   1. Claude Code transcript: ~/.claude/projects/<slug>/*.jsonl 中 user message 的 <command-name> 标签
 *   2. Codex observations:     ~/.claude/homunculus/projects/<id>/observations.jsonl 中 tool:"Skill" + input_summary.skill
 *
 * 用法：
 *   node scripts/usage-report.js                  # 默认：写 Markdown 到 docs/reports/command-usage-YYYY-MM-DD.md
 *   node scripts/usage-report.js --markdown       # 同上（显式）
 *   node scripts/usage-report.js --inline         # 输出 Markdown 到 stdout（供 /review-learnings 集成）
 *   node scripts/usage-report.js --json           # 输出 JSON 到 stdout
 *   node scripts/usage-report.js --window 60      # 自定义滚动窗口天数（默认 30）
 *   node scripts/usage-report.js --out <path>     # 自定义输出文件路径
 */

const fs = require('fs');
const path = require('path');
const { aggregate, COMMAND_WHITELIST } = require('./lib/usage-aggregator');

function parseArgs(argv) {
  const args = {
    mode: 'markdown', // markdown | inline | json
    windowDays: 30,
    out: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--markdown') args.mode = 'markdown';
    else if (arg === '--inline') args.mode = 'inline';
    else if (arg === '--json') args.mode = 'json';
    else if (arg === '--window') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) {
        args.windowDays = n;
        i += 1;
      }
    } else if (arg === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }
  return args;
}

function formatDate(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

function formatMarkdown(result) {
  const lines = [];
  const dateStr = result.generatedAt.slice(0, 10);
  lines.push(`# 命令使用频率报告 (${dateStr})`);
  lines.push('');
  lines.push(`> 生成时间: ${result.generatedAt}`);
  lines.push(`> 工作目录: \`${result.cwd}\``);
  lines.push(`> 滚动窗口: ${result.windowDays} 天（cutoff = ${result.windowCutoff.slice(0, 10)}）`);
  lines.push('');

  // 数据源段
  lines.push('## 数据源');
  lines.push('');
  const tr = result.sources.transcript;
  lines.push(`- Claude Code transcript: \`${tr.dir}\``);
  lines.push(`  - ${tr.exists ? `${tr.fileCount} 个 session 文件` : '⚠ 目录不存在'}`);
  lines.push(`- Codex observations: ${result.sources.observations.length} 个项目目录`);
  for (const obs of result.sources.observations) {
    lines.push(`  - \`${obs.projectId}\`: \`${obs.file}\``);
  }
  lines.push('');

  // 主表
  lines.push('## 主表（21 个命令）');
  lines.push('');
  lines.push('| 命令 | 30d CC | 30d Codex | 30d 合计 | 累计 CC | 累计 Codex | 累计合计 | 首次 | 末次 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  // 排序：按累计合计降序，0 调用排最后；零调用项内按字母序
  const sorted = result.rows.slice().sort((a, b) => {
    if (a.totalAll !== b.totalAll) return b.totalAll - a.totalAll;
    return a.command.localeCompare(b.command);
  });
  for (const row of sorted) {
    lines.push(
      `| /${row.command} | ${row.windowCC} | ${row.windowCodex} | **${row.windowTotal}** | ${row.totalCC} | ${row.totalCodex} | **${row.totalAll}** | ${formatDate(row.first)} | ${formatDate(row.last)} |`
    );
  }
  lines.push('');

  // 分类摘要
  const zeroCalls = result.rows.filter((r) => r.totalAll === 0).map((r) => r.command);
  const lowCalls = result.rows.filter((r) => r.totalAll > 0 && r.totalAll <= 2).map((r) => `/${r.command}(${r.totalAll})`);
  const activeCalls = result.rows.filter((r) => r.windowTotal > 0).map((r) => `/${r.command}(${r.windowTotal})`);

  lines.push('## 分类摘要');
  lines.push('');
  lines.push(`### ✅ 30 天活跃（${activeCalls.length}）`);
  lines.push(activeCalls.length ? activeCalls.join(', ') : '（无）');
  lines.push('');
  lines.push(`### 🟡 累计极低（≤2 次，${lowCalls.length}）`);
  lines.push(lowCalls.length ? lowCalls.join(', ') : '（无）');
  lines.push('');
  lines.push(`### 🔴 累计零调用（${zeroCalls.length}）`);
  lines.push(zeroCalls.length ? zeroCalls.map((c) => `/${c}`).join(', ') : '（无）');
  lines.push('');

  // 数据局限
  lines.push('## 数据局限');
  lines.push('');
  lines.push('- **transcript 仅覆盖当前 cwd 对应的 Claude Code session**。其他 cwd（如另一项目目录或 subagent）触发的本项目命令不计入。');
  lines.push('- **Codex observations 覆盖度受 hook 安装时间限制**。早于 hook 安装的调用不计入。');
  lines.push('- **Codex 数据已去重**（同秒同 skill 视为 hook 双触发，记 1 次）。');
  lines.push('- transcript 中 `<command-name>` 标签出现在 tool_result（message.content 为数组）中视为噪音，**仅 message.content 为字符串时计数**。');
  lines.push('');

  // 复用说明
  lines.push('## 如何复跑');
  lines.push('');
  lines.push('```bash');
  lines.push('# 默认：写到 docs/reports/command-usage-YYYY-MM-DD.md');
  lines.push('node scripts/usage-report.js');
  lines.push('');
  lines.push('# 自定义窗口 60 天');
  lines.push('node scripts/usage-report.js --window 60');
  lines.push('');
  lines.push('# 实时查看（不写文件）');
  lines.push('node scripts/usage-report.js --inline');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function formatInline(result) {
  // 简短表格 + 摘要，供 /review-learnings 引用
  const lines = [];
  lines.push(`📊 命令使用频率（${result.generatedAt.slice(0, 10)}，窗口 ${result.windowDays}d）`);
  lines.push('');
  const sorted = result.rows.slice().sort((a, b) => {
    if (a.totalAll !== b.totalAll) return b.totalAll - a.totalAll;
    return a.command.localeCompare(b.command);
  });
  lines.push('| 命令 | 30d | 累计 | 首次 | 末次 |');
  lines.push('|---|---|---|---|---|');
  for (const row of sorted) {
    lines.push(`| /${row.command} | ${row.windowTotal} | ${row.totalAll} | ${formatDate(row.first)} | ${formatDate(row.last)} |`);
  }
  lines.push('');
  const zeroCalls = result.rows.filter((r) => r.totalAll === 0);
  if (zeroCalls.length > 0) {
    lines.push(`🔴 累计零调用: ${zeroCalls.map((r) => `/${r.command}`).join(', ')}`);
  }
  return lines.join('\n');
}

function defaultOutPath(cwd, dateStr) {
  const reportsDir = path.join(cwd, 'docs', 'reports');
  return path.join(reportsDir, `command-usage-${dateStr}.md`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 18).join('\n') + '\n');
    return;
  }

  const cwd = process.cwd();
  const result = await aggregate({ cwd, windowDays: args.windowDays });

  if (args.mode === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (args.mode === 'inline') {
    process.stdout.write(formatInline(result) + '\n');
    return;
  }

  // markdown 模式：默认写文件
  const markdown = formatMarkdown(result);
  const dateStr = result.generatedAt.slice(0, 10);
  const outPath = args.out || defaultOutPath(cwd, dateStr);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf8');
  process.stdout.write(`✓ Report written to ${outPath}\n`);
  process.stdout.write(`  ${result.sources.transcript.fileCount} transcript sessions, ${result.sources.observations.length} observation source(s)\n`);
  const activeCount = result.rows.filter((r) => r.windowTotal > 0).length;
  process.stdout.write(`  ${activeCount}/${COMMAND_WHITELIST.length} commands active in last ${args.windowDays} days\n`);
}

main().catch((err) => {
  process.stderr.write(`[usage-report] failed: ${err.message}\n`);
  process.exit(1);
});
