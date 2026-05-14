#!/usr/bin/env node

/**
 * memory-export.js — Tech Persistence Memory → agentmemory bridge (Phase 3 P2)
 *
 * 用法：
 *   node scripts/memory-export.js --format=jsonl --output=path/to/file.jsonl
 *   node scripts/memory-export.js --format=markdown --output=dir/
 *   node scripts/memory-export.js --push=agentmemory  # 需 env AGENTMEMORY_URL
 *
 * 输出携带稳定 id + provenance metadata：
 *   tech-persistence:v5:<project-id>:<memory-id>
 *
 * 默认行为 = export-on-demand。不并装 agentmemory plugin，不自动启动 server。
 * 失败模式：output 路径不可写 → 报错 + exit 1；REST push 失败 → 警告但不退出。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const {
  detectProjectIdentity,
  collectMemoryEntries,
  mergeMemoryEntries,
  redactSensitive,
  topicTitle,
  parseFrontmatter,
} = require('./lib/memory-v5');
const { resolveCompatReadDirs } = require('./lib/runtime-paths');

const STABLE_ID_PREFIX = 'tech-persistence:v5';

function parseArgs(argv) {
  const args = { format: 'jsonl', output: '', push: null, includeSessions: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--format=')) args.format = arg.slice('--format='.length);
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
    else if (arg.startsWith('--push=')) args.push = arg.slice('--push='.length);
    else if (arg === '--include-sessions') args.includeSessions = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  process.stdout.write(`memory-export — Tech Persistence → agentmemory bridge

Usage:
  node scripts/memory-export.js --format=jsonl --output=memory.jsonl
  node scripts/memory-export.js --format=markdown --output=./export-dir
  node scripts/memory-export.js --push=agentmemory     # POST to env AGENTMEMORY_URL

Options:
  --format=jsonl|markdown   Output format (default: jsonl).
  --output=PATH             Output file (jsonl) or directory (markdown).
  --push=agentmemory        After export, POST each record to env AGENTMEMORY_URL/agentmemory/remember.
                            Skipped silently when AGENTMEMORY_URL is unset.
  --include-sessions        Also export session summaries.
  -h, --help                Show this help.
`);
}

function readSessionFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(content);
  const name = path.basename(file);
  const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return {
    name,
    date: dateMatch ? dateMatch[1] : meta.date || '1970-01-01',
    body: String(body || ''),
  };
}

function collectRecords(project, baseDirs, options = {}) {
  const records = [];

  const memoryEntries = [];
  baseDirs.forEach((baseDir) => {
    const dir = path.join(baseDir, 'projects', project.id, 'memory');
    memoryEntries.push(...collectMemoryEntries(dir));
  });
  const merged = mergeMemoryEntries(memoryEntries);

  merged.forEach((entry) => {
    const stableId = `${STABLE_ID_PREFIX}:${project.id}:${entry.id}`;
    const note = String(entry.line || '')
      .replace(/^- \d{4}-\d{2}-\d{2}\s+/, '')
      .replace(/^\[\d(?:\.\d+)?\]\s+/, '')
      .trim();
    records.push({
      kind: 'memory',
      id: stableId,
      source_memory_id: entry.id,
      source_topic: entry.topic,
      source_topic_title: topicTitle(entry.topic),
      date: entry.date,
      confidence: entry.confidence,
      body: redactSensitive(note),
      provenance: {
        source_system: 'tech-persistence',
        source_version: 'memory-v5',
        source_project_id: project.id,
        source_project_name: project.name,
        source_memory_id: entry.id,
        source_topic: entry.topic,
      },
    });
  });

  if (options.includeSessions) {
    baseDirs.forEach((baseDir) => {
      const sessionsDir = path.join(baseDir, 'projects', project.id, 'sessions');
      if (!fs.existsSync(sessionsDir)) return;
      let names;
      try {
        names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith('.md'));
      } catch {
        return;
      }
      names.forEach((name) => {
        const session = readSessionFile(path.join(sessionsDir, name));
        if (!session) return;
        const stableId = `${STABLE_ID_PREFIX}:${project.id}:session:${name.replace(/\.md$/, '')}`;
        records.push({
          kind: 'session',
          id: stableId,
          source_session_name: name,
          date: session.date,
          body: redactSensitive(session.body),
          provenance: {
            source_system: 'tech-persistence',
            source_version: 'memory-v5',
            source_project_id: project.id,
            source_project_name: project.name,
            source_session_name: name,
          },
        });
      });
    });
  }

  return records;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function exportJsonl(records, outputPath) {
  if (!outputPath) throw new Error('--output is required for jsonl export');
  ensureDir(path.dirname(path.resolve(outputPath)));
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(outputPath, `${lines}\n`);
  return outputPath;
}

function recordToMarkdown(record) {
  const fm = [
    '---',
    `id: "${record.id}"`,
    `kind: ${record.kind}`,
    `date: "${record.date}"`,
    record.confidence != null ? `confidence: ${record.confidence}` : null,
    record.source_topic ? `source_topic: "${record.source_topic}"` : null,
    'provenance:',
    `  source_system: ${record.provenance.source_system}`,
    `  source_version: ${record.provenance.source_version}`,
    `  source_project_id: ${record.provenance.source_project_id}`,
    `  source_project_name: ${record.provenance.source_project_name}`,
    record.provenance.source_memory_id ? `  source_memory_id: ${record.provenance.source_memory_id}` : null,
    record.provenance.source_topic ? `  source_topic: ${record.provenance.source_topic}` : null,
    record.provenance.source_session_name ? `  source_session_name: ${record.provenance.source_session_name}` : null,
    '---',
    '',
    record.body,
    '',
  ].filter((line) => line !== null);
  return fm.join('\n');
}

function exportMarkdown(records, outputDir) {
  if (!outputDir) throw new Error('--output is required for markdown export');
  ensureDir(outputDir);
  records.forEach((record) => {
    const safeId = record.id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(outputDir, `${safeId}.md`);
    fs.writeFileSync(file, recordToMarkdown(record));
  });
  return outputDir;
}

function pushOne(url, record) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(record);
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Source-System': 'tech-persistence',
          'X-Source-Version': 'memory-v5',
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

async function pushToAgentmemory(records) {
  const baseUrl = process.env.AGENTMEMORY_URL;
  if (!baseUrl) {
    process.stderr.write('[push] AGENTMEMORY_URL not set — skipping REST push\n');
    return { sent: 0, failed: 0 };
  }
  const endpoint = `${baseUrl.replace(/\/$/, '')}/agentmemory/remember`;
  let sent = 0;
  let failed = 0;
  for (const record of records) {
    const result = await pushOne(endpoint, record);
    if (result.ok) sent++;
    else {
      failed++;
      process.stderr.write(`[push] ${record.id} failed: ${result.error || result.status}\n`);
    }
  }
  return { sent, failed };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const project = detectProjectIdentity();
  const baseDirs = resolveCompatReadDirs();
  const records = collectRecords(project, baseDirs, { includeSessions: args.includeSessions });

  if (records.length === 0) {
    process.stderr.write('[export] no memory records found for current project\n');
    process.exit(0);
  }

  if (args.format === 'jsonl') {
    const out = exportJsonl(records, args.output || `memory-export-${project.id}.jsonl`);
    process.stdout.write(`exported ${records.length} records → ${out}\n`);
  } else if (args.format === 'markdown') {
    const out = exportMarkdown(records, args.output || `memory-export-${project.id}`);
    process.stdout.write(`exported ${records.length} records → ${out}/\n`);
  } else {
    process.stderr.write(`unknown format: ${args.format}\n`);
    process.exit(1);
  }

  if (args.push === 'agentmemory') {
    const result = await pushToAgentmemory(records);
    process.stdout.write(`push: ${result.sent} sent, ${result.failed} failed\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[fatal] ${err.message || err}\n`);
    process.exit(1);
  });
}

module.exports = { collectRecords, exportJsonl, exportMarkdown, recordToMarkdown, STABLE_ID_PREFIX };
