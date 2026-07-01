#!/usr/bin/env node
'use strict';

/**
 * skill-size-budget.js
 *
 * Read-only size report for command and skill surfaces. The report makes
 * "always visible / on-demand but heavy" pressure measurable before carving.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_WARN_BYTES = 6000;
const DEFAULT_HEAVY_BYTES = 12000;
const DEFAULT_TOP = 20;

const SCAN_TARGETS = Object.freeze([
  {
    dir: path.join('user-level', 'commands'),
    kind: 'command',
    surface: 'command-source',
    origin: 'source',
    pattern: 'flat-md',
  },
  {
    dir: path.join('.codex', 'commands'),
    kind: 'command',
    surface: 'codex-command-projection',
    origin: 'projection',
    pattern: 'flat-md',
  },
  {
    dir: path.join('plugins', 'tech-persistence', 'commands'),
    kind: 'command',
    surface: 'plugin-command-projection',
    origin: 'projection',
    pattern: 'flat-md',
  },
  {
    dir: path.join('user-level', 'skills'),
    kind: 'skill',
    surface: 'skill-source',
    origin: 'source',
    pattern: 'skill-md',
  },
  {
    dir: path.join('.codex', 'skills'),
    kind: 'skill',
    surface: 'codex-skill-runtime',
    origin: 'runtime',
    pattern: 'skill-md',
  },
  {
    dir: path.join('.agents', 'skills'),
    kind: 'skill',
    surface: 'agents-skill-runtime',
    origin: 'runtime',
    pattern: 'skill-md',
  },
  {
    dir: path.join('plugins', 'tech-persistence', 'skills'),
    kind: 'skill',
    surface: 'plugin-skill-runtime',
    origin: 'runtime',
    pattern: 'skill-md',
  },
]);

function normalizeRel(filePath) {
  return filePath.replace(/\\/g, '/');
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    top: DEFAULT_TOP,
    json: false,
    markdown: false,
    warnBytes: DEFAULT_WARN_BYTES,
    heavyBytes: DEFAULT_HEAVY_BYTES,
    includeProjections: true,
    help: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' && argv[index + 1]) {
      args.root = path.resolve(argv[++index]);
    } else if (arg === '--top' && argv[index + 1]) {
      const value = Number(argv[++index]);
      if (Number.isFinite(value) && value > 0) args.top = Math.floor(value);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--markdown') {
      args.markdown = true;
    } else if (arg === '--warn-bytes' && argv[index + 1]) {
      const value = Number(argv[++index]);
      if (Number.isFinite(value) && value >= 0) args.warnBytes = Math.floor(value);
    } else if (arg === '--heavy-bytes' && argv[index + 1]) {
      const value = Number(argv[++index]);
      if (Number.isFinite(value) && value >= 0) args.heavyBytes = Math.floor(value);
    } else if (arg === '--source-only') {
      args.includeProjections = false;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function listFlatMarkdownFiles(root, relDir) {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function listSkillMarkdownFiles(root, relDir) {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, 'SKILL.md'))
    .filter((filePath) => fs.existsSync(filePath))
    .sort();
}

function listTargetFiles(root, target) {
  if (target.pattern === 'flat-md') return listFlatMarkdownFiles(root, target.dir);
  if (target.pattern === 'skill-md') return listSkillMarkdownFiles(root, target.dir);
  throw new Error(`unknown scan pattern: ${target.pattern}`);
}

function parseFrontmatterBytes(content) {
  if (!content.startsWith('---\n')) return 0;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return 0;
  return end + '\n---'.length;
}

function deriveName(filePath, target) {
  if (target.kind === 'command') return path.basename(filePath, '.md');
  return path.basename(path.dirname(filePath));
}

function classifyPressure(bytes, warnBytes, heavyBytes) {
  if (bytes >= heavyBytes) return 'heavy';
  if (bytes >= warnBytes) return 'warn';
  return 'ok';
}

function measureFile(root, target, filePath, commandNames, options = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relPath = normalizeRel(path.relative(root, filePath));
  const name = deriveName(filePath, target);
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const frontmatterBytes = parseFrontmatterBytes(content);
  const commandDerived = target.kind === 'skill'
    && (commandNames.has(name) || content.includes(`former /${name} command`));

  return {
    name,
    path: relPath,
    kind: target.kind,
    surface: target.surface,
    origin: target.origin,
    commandDerived,
    bytes,
    lines,
    frontmatterBytes,
    bodyBytes: Math.max(0, bytes - frontmatterBytes),
    pressure: classifyPressure(
      bytes,
      options.warnBytes ?? DEFAULT_WARN_BYTES,
      options.heavyBytes ?? DEFAULT_HEAVY_BYTES
    ),
  };
}

function collectCommandNames(root, targets) {
  const names = new Set();
  targets
    .filter((target) => target.kind === 'command')
    .forEach((target) => {
      listTargetFiles(root, target).forEach((filePath) => {
        names.add(path.basename(filePath, '.md'));
      });
    });
  return names;
}

function collectSkillSizeBudget(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const includeProjections = options.includeProjections !== false;
  const targets = SCAN_TARGETS.filter((target) => includeProjections || target.origin !== 'projection');
  const commandNames = collectCommandNames(root, targets);
  const entries = targets.flatMap((target) => (
    listTargetFiles(root, target).map((filePath) => measureFile(root, target, filePath, commandNames, options))
  ));
  entries.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

  const bySurface = {};
  for (const entry of entries) {
    if (!bySurface[entry.surface]) {
      bySurface[entry.surface] = { count: 0, bytes: 0, heavy: 0, warn: 0 };
    }
    bySurface[entry.surface].count += 1;
    bySurface[entry.surface].bytes += entry.bytes;
    if (entry.pressure === 'heavy') bySurface[entry.surface].heavy += 1;
    if (entry.pressure === 'warn') bySurface[entry.surface].warn += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    root,
    thresholds: {
      warnBytes: options.warnBytes ?? DEFAULT_WARN_BYTES,
      heavyBytes: options.heavyBytes ?? DEFAULT_HEAVY_BYTES,
    },
    total: {
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      heavy: entries.filter((entry) => entry.pressure === 'heavy').length,
      warn: entries.filter((entry) => entry.pressure === 'warn').length,
      commandDerivedSkills: entries.filter((entry) => entry.commandDerived).length,
    },
    bySurface,
    entries,
  };
}

function formatBytes(bytes) {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatMarkdown(report, top = DEFAULT_TOP) {
  const rows = report.entries.slice(0, top);
  const lines = [];
  lines.push(`# Skill Size Budget (${report.generatedAt.slice(0, 10)})`);
  lines.push('');
  lines.push(`Root: \`${report.root}\``);
  lines.push(`Thresholds: warn >= ${formatBytes(report.thresholds.warnBytes)}, heavy >= ${formatBytes(report.thresholds.heavyBytes)}`);
  lines.push(`Total: ${report.total.files} files, ${formatBytes(report.total.bytes)}, heavy ${report.total.heavy}, warn ${report.total.warn}, command-derived skills ${report.total.commandDerivedSkills}`);
  lines.push('');
  lines.push(`## Top ${rows.length}`);
  lines.push('');
  lines.push('| Rank | File | Surface | Kind | Derived | Size | Lines | Pressure |');
  lines.push('|---:|---|---|---|---:|---:|---:|---|');
  rows.forEach((entry, index) => {
    lines.push(`| ${index + 1} | \`${entry.path}\` | ${entry.surface} | ${entry.kind} | ${entry.commandDerived ? 'yes' : 'no'} | ${formatBytes(entry.bytes)} | ${entry.lines} | ${entry.pressure} |`);
  });
  lines.push('');
  lines.push('## By Surface');
  lines.push('');
  lines.push('| Surface | Files | Size | Heavy | Warn |');
  lines.push('|---|---:|---:|---:|---:|');
  Object.keys(report.bySurface).sort().forEach((surface) => {
    const row = report.bySurface[surface];
    lines.push(`| ${surface} | ${row.count} | ${formatBytes(row.bytes)} | ${row.heavy} | ${row.warn} |`);
  });
  lines.push('');
  return lines.join('\n');
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/skill-size-budget.js [options]',
    '',
    'Options:',
    '  --top <n>          Number of largest files to show (default 20)',
    '  --json             Print JSON report',
    '  --markdown         Print Markdown report (default)',
    '  --source-only      Skip generated projection surfaces',
    '  --warn-bytes <n>   Warning threshold (default 6000)',
    '  --heavy-bytes <n>  Heavy threshold (default 12000)',
    '  --root <path>      Repo root (default cwd)',
    '',
  ].join('\n'));
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const report = collectSkillSizeBudget(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${formatMarkdown(report, args.top)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (error) {
    process.stderr.write(`[skill-size-budget] failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_HEAVY_BYTES,
  DEFAULT_TOP,
  DEFAULT_WARN_BYTES,
  SCAN_TARGETS,
  collectSkillSizeBudget,
  formatMarkdown,
  listFlatMarkdownFiles,
  listSkillMarkdownFiles,
  main,
  measureFile,
  parseArgs,
};