/**
 * memory-tools.js — Memory MCP tool handlers
 *
 * 每个 handler 接受 JSON args，返回 MCP CallToolResult shape：
 *   { content: [{ type: 'text', text: string }], isError?: boolean }
 *
 * 同一套 handlers 供 memory-mcp-server.js 和未来 CLI / skill 共用。
 * 所有 handler 必须：
 *   - 失败模式静默：fs 错误返 "(no results)"，绝不抛
 *   - 输出脱敏：所有 line/body 经 redactSensitive
 *   - 不写入 observations：MCP 查询本身不应进 memory，避免自指
 */

const fs = require('fs');
const path = require('path');

const {
  detectProjectIdentity,
  collectMemoryEntries,
  mergeMemoryEntries,
  parseFrontmatter,
  redactSensitive,
  topicTitle,
  hashText,
} = require('./memory-v5');
const { resolveCompatReadDirs, resolveBaseDir } = require('./runtime-paths');
const { searchMemory, formatRecallContext } = require('./memory-search');

function ok(text) {
  return { content: [{ type: 'text', text: String(text || '') }] };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: `[error] ${message}` }],
    isError: true,
  };
}

function getProjectContext() {
  const project = detectProjectIdentity();
  const baseDirs = resolveCompatReadDirs();
  return { project, baseDirs };
}

function listProjectMemoryDirs(baseDirs, projectId) {
  return baseDirs.map((dir) => path.join(dir, 'projects', projectId, 'memory'));
}

function listProjectSessionsDirs(baseDirs, projectId) {
  return baseDirs.map((dir) => path.join(dir, 'projects', projectId, 'sessions'));
}

function handleSearch(args = {}) {
  const query = String(args.query || args.prompt || '').trim();
  if (!query) return errorResult('missing query');

  const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
  const { project, baseDirs } = getProjectContext();

  const result = searchMemory({
    prompt: query,
    projectId: project.id,
    baseDirs,
    touchedFiles: Array.isArray(args.files) ? args.files : [],
    sprintTags: Array.isArray(args.tags) ? args.tags : [],
    limits: { memoryTop: limit, sessionTop: 2, instinctTop: 3, budgetChars: 4000 },
  });

  if (result.memory.length === 0 && result.sessions.length === 0 && result.instincts.length === 0) {
    return ok('(no results)');
  }
  return ok(formatRecallContext(result, { budgetChars: 4000 }));
}

function handleRecent(args = {}) {
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
  const { project, baseDirs } = getProjectContext();
  const sessionsDirs = listProjectSessionsDirs(baseDirs, project.id);

  const all = [];
  for (const dir of sessionsDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .forEach((name) => {
          const file = path.join(dir, name);
          let content;
          try {
            content = fs.readFileSync(file, 'utf-8');
          } catch {
            return;
          }
          const { meta, body } = parseFrontmatter(content);
          const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
          all.push({
            name,
            date: dateMatch ? dateMatch[1] : meta.date || '1970-01-01',
            preview: String(body || '').slice(0, 240).replace(/\s+/g, ' ').trim(),
          });
        });
    } catch {}
  }

  const sorted = all
    .sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name))
    .slice(0, limit);

  if (sorted.length === 0) return ok('(no recent sessions)');
  const lines = sorted.map((s) => `- ${s.date} ${s.name}: ${redactSensitive(s.preview)}`);
  return ok(['## Recent Sessions', ...lines].join('\n'));
}

function handleSave(args = {}) {
  const body = String(args.body || args.content || '').trim();
  if (!body) return errorResult('missing body');

  const topic = String(args.topic || 'general')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40) || 'general';
  const confidence = Math.max(0.3, Math.min(0.95, Number(args.confidence) || 0.7));
  const date = new Date().toISOString().split('T')[0];
  const id = hashText(`${topic}:${body}:${date}`, 12);

  const { project } = getProjectContext();
  const baseDir = resolveBaseDir();
  const memoryDir = path.join(baseDir, 'projects', project.id, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  const file = path.join(memoryDir, `${topic}.md`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : `# ${topicTitle(topic)}\n\n`;
  const entry = `<!-- memory:v5:${id} -->\n- ${date} [${confidence.toFixed(2)}] ${redactSensitive(body)}\n\n`;
  fs.writeFileSync(file, existing + entry);

  return ok(`saved memory:v5:${id} → ${path.relative(baseDir, file)}`);
}

function handleFileHistory(args = {}) {
  const targetFile = String(args.file || args.path || '').trim();
  if (!targetFile) return errorResult('missing file');

  const { project, baseDirs } = getProjectContext();
  const memoryDirs = listProjectMemoryDirs(baseDirs, project.id);
  const allEntries = mergeMemoryEntries(memoryDirs.flatMap(collectMemoryEntries));

  const baseName = path.basename(targetFile).toLowerCase();
  const fullPathLower = targetFile.toLowerCase();
  const matched = allEntries.filter((entry) => {
    const line = String(entry.line || '').toLowerCase();
    return line.includes(baseName) || (fullPathLower.length > baseName.length && line.includes(fullPathLower));
  });

  if (matched.length === 0) return ok(`(no memory entries reference ${targetFile})`);

  const lines = matched.slice(0, 10).map((entry) => {
    const note = String(entry.line || '')
      .replace(/^- \d{4}-\d{2}-\d{2}\s+/, '')
      .replace(/^\[\d(?:\.\d+)?\]\s+/, '')
      .trim();
    return `- [${topicTitle(entry.topic)}] ${entry.date} [${entry.confidence.toFixed(2)}] ${redactSensitive(note)}`;
  });
  return ok([`## Memory entries referencing ${targetFile}`, ...lines].join('\n'));
}

function handleProjectProfile() {
  const { project, baseDirs } = getProjectContext();
  const memoryDirs = listProjectMemoryDirs(baseDirs, project.id);
  const allEntries = mergeMemoryEntries(memoryDirs.flatMap(collectMemoryEntries));

  const byTopic = new Map();
  allEntries.forEach((entry) => {
    const key = entry.topic || 'general';
    if (!byTopic.has(key)) byTopic.set(key, { count: 0, maxConfidence: 0, latestDate: '0000-00-00' });
    const slot = byTopic.get(key);
    slot.count++;
    if (entry.confidence > slot.maxConfidence) slot.maxConfidence = entry.confidence;
    if (entry.date > slot.latestDate) slot.latestDate = entry.date;
  });

  const topicLines = [...byTopic.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([topic, slot]) =>
      `- [${topicTitle(topic)}] ${slot.count} entries, top conf ${slot.maxConfidence.toFixed(2)}, latest ${slot.latestDate}`
    );

  const sessionCount = listProjectSessionsDirs(baseDirs, project.id)
    .filter((dir) => fs.existsSync(dir))
    .reduce((sum, dir) => {
      try {
        return sum + fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length;
      } catch {
        return sum;
      }
    }, 0);

  const body = [
    `## Project Profile: ${project.name}`,
    `Project id: ${project.id}`,
    `Memory entries: ${allEntries.length}`,
    `Sessions: ${sessionCount}`,
    '',
    '### By Topic',
    ...(topicLines.length > 0 ? topicLines : ['(no entries)']),
  ].join('\n');
  return ok(body);
}

const TOOL_DEFINITIONS = [
  {
    name: 'tp_memory_search',
    description: 'Search Tech Persistence Memory v5 entries / sessions / instincts by prompt or query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (prompt or keywords).' },
        limit: { type: 'integer', description: 'Max memory entries to return (1-20).', default: 5 },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to boost path-match score.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional sprint tags to boost topic-match score.' },
      },
      required: ['query'],
    },
    handler: handleSearch,
  },
  {
    name: 'tp_memory_recent',
    description: 'List the most recent session summaries for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max sessions to return (1-20).', default: 5 },
      },
    },
    handler: handleRecent,
  },
  {
    name: 'tp_memory_save',
    description: 'Save a durable memory note into the current project topic file.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Memory body (single short paragraph).' },
        topic: { type: 'string', description: 'Topic slug, e.g. architecture / debugging / workflow.', default: 'general' },
        confidence: { type: 'number', description: 'Confidence 0.3-0.95.', default: 0.7 },
      },
      required: ['body'],
    },
    handler: handleSave,
  },
  {
    name: 'tp_memory_file_history',
    description: 'Find memory entries that reference a given file path or basename.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path or basename to search for.' },
      },
      required: ['file'],
    },
    handler: handleFileHistory,
  },
  {
    name: 'tp_memory_project_profile',
    description: 'Show a summary of the current project memory: counts per topic, sessions, top confidence.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: handleProjectProfile,
  },
];

function listToolsForMcp() {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

function callTool(name, args) {
  const def = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def) return errorResult(`unknown tool: ${name}`);
  try {
    return def.handler(args || {});
  } catch (err) {
    return errorResult(`handler failed: ${err.message || err}`);
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  callTool,
  listToolsForMcp,
  handleSearch,
  handleRecent,
  handleSave,
  handleFileHistory,
  handleProjectProfile,
};
