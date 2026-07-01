const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { redactSensitiveText } = require('./redaction');

const MEMORY_VERSION = '5.0';

const DEFAULT_MEMORY_CONFIG = {
  indexMaxLines: 200,
  indexMaxBytes: 25 * 1024,
  maxIndexEntries: 40,
  maxTopicEntries: 80,
  minMemoryConfidence: 0.45,
};

const TOPIC_LABELS = {
  architecture: 'Architecture',
  debugging: 'Debugging',
  testing: 'Testing',
  toolchain: 'Toolchain',
  workflow: 'Workflow',
  security: 'Security',
  performance: 'Performance',
  'code-style': 'Code Style',
  'api-design': 'API Design',
  general: 'General',
};

function hashText(value, length = 12) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function redactSensitive(value) {
  if (typeof value !== 'string') return value;
  return redactSensitiveText(value);
}

function safeStringify(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeValue(value, maxLength) {
  return redactSensitive(safeStringify(value))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function parseJsonMaybe(input) {
  if (!input) return { parsed: null, format: 'empty' };
  try {
    return { parsed: JSON.parse(input), format: 'json' };
  } catch {
    return { parsed: null, format: 'text' };
  }
}

function uniqueStrings(values) {
  const seen = new Set();
  return values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function uniqueDirs(values) {
  const seen = new Set();
  return values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => path.resolve(value))
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveGitDir(repoRoot) {
  const gitMarker = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitMarker)) return null;
  const stat = fs.lstatSync(gitMarker);
  if (stat.isDirectory()) return gitMarker;
  if (!stat.isFile()) return null;

  try {
    const content = fs.readFileSync(gitMarker, 'utf-8');
    const match = content.match(/gitdir:\s*(.+)\s*$/im);
    if (!match) return null;
    return path.resolve(repoRoot, match[1].trim());
  } catch {
    return null;
  }
}

function readGitRemoteOrigin(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return '';
  const configPath = path.join(gitDir, 'config');
  if (!fs.existsSync(configPath)) return '';
  try {
    const lines = fs.readFileSync(configPath, 'utf-8').split(/\r?\n/);
    let inOrigin = false;
    for (const line of lines) {
      const sectionMatch = line.match(/^\s*\[(.+)]\s*$/);
      if (sectionMatch) {
        inOrigin = /^remote\s+"origin"$/.test(sectionMatch[1].trim());
        continue;
      }
      if (!inOrigin) continue;
      const urlMatch = line.match(/^\s*url\s*=\s*(.+)\s*$/);
      if (urlMatch) return urlMatch[1].trim();
    }
  } catch {}
  return '';
}

function detectProjectIdentity(cwd = process.cwd()) {
  try {
    const repoRoot = findGitRoot(cwd);
    const remote = repoRoot ? readGitRemoteOrigin(repoRoot) : '';
    if (remote) {
      return {
        id: hashText(remote),
        name: path.basename(remote, '.git'),
        source: 'git-remote',
      };
    }
  } catch {}

  try {
    const root = findGitRoot(cwd);
    if (root) {
      return {
        id: hashText(root),
        name: path.basename(root),
        source: 'git-root',
      };
    }
  } catch {}

  const resolvedCwd = path.resolve(cwd);
  return {
    id: hashText(resolvedCwd),
    name: path.basename(resolvedCwd),
    source: 'cwd',
  };
}

function extractPathsFromString(value) {
  if (typeof value !== 'string') return [];
  const matches = value.match(/(?:[A-Za-z]:[\\/][^\s"'<>|]+|(?:\.{1,2}[\\/]|[\w.-]+[\\/])[\w./\\-]+)/g);
  if (!matches) return [];
  return matches.map((match) => match.replace(/[),.;\]}]+$/, ''));
}

function extractPaths(value, depth = 0) {
  if (depth > 5 || value === undefined || value === null) return [];
  if (typeof value === 'string') return extractPathsFromString(value);
  if (Array.isArray(value)) return value.flatMap((item) => extractPaths(item, depth + 1));
  if (typeof value !== 'object') return [];

  const paths = [];
  Object.entries(value).forEach(([key, child]) => {
    const normalizedKey = key.toLowerCase();
    if (
      ['path', 'filepath', 'file_path', 'file', 'filename', 'workdir', 'cwd'].includes(normalizedKey)
      || normalizedKey.endsWith('path')
      || normalizedKey.endsWith('file')
    ) {
      if (typeof child === 'string') paths.push(child);
      if (Array.isArray(child)) paths.push(...child.filter((item) => typeof item === 'string'));
    }
    paths.push(...extractPaths(child, depth + 1));
  });
  return uniqueStrings(paths);
}

function normalizeToolName(value) {
  const toolName = firstString(value) || 'unknown';
  return toolName.replace(/^functions\./, '').replace(/^mcp__/, '').slice(0, 80);
}

function extractCommand(toolName, inputValue) {
  const tool = String(toolName || '').toLowerCase();
  if (!tool.includes('shell') && !tool.includes('bash') && !tool.includes('powershell')) {
    return '';
  }
  if (typeof inputValue === 'string') return inputValue.trim();
  if (inputValue && typeof inputValue === 'object') {
    return firstString(inputValue.command, inputValue.cmd, inputValue.script, inputValue.args);
  }
  return '';
}

function commandFamily(command) {
  if (!command) return '';
  const trimmed = command.trim();
  const withoutShell = trimmed
    .replace(/^powershell(?:\.exe)?\s+-[A-Za-z]+\s+/i, '')
    .replace(/^pwsh(?:\.exe)?\s+-[A-Za-z]+\s+/i, '')
    .replace(/^cmd\s+\/c\s+/i, '');
  const parts = withoutShell.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const cleanParts = parts.map((part) => part.replace(/^["']|["']$/g, ''));
  if (cleanParts.length === 0) return '';
  if (['npm', 'pnpm', 'yarn', 'node', 'git', 'npx', 'bash', 'cargo', 'go', 'python', 'python3'].includes(cleanParts[0])) {
    return cleanParts.slice(0, Math.min(cleanParts.length, 3)).join(' ');
  }
  return cleanParts[0];
}

function inferStatus(payload, outputSummary) {
  if (payload && typeof payload === 'object') {
    const exitCode = firstDefined(payload.exit_code, payload.exitCode, payload.code, payload.statusCode);
    if (Number.isInteger(exitCode)) return exitCode === 0 ? 'success' : 'error';
    if (payload.is_error === true || payload.error) return 'error';
    if (payload.ok === true || payload.success === true) return 'success';
  }
  const output = String(outputSummary || '');
  if (/\b(exit code|exit_code)\s*[:=]?\s*[1-9]\d*\b/i.test(output)) return 'error';
  if (/\b(error|exception|failed|failure|traceback|enoent)\b/i.test(output)) return 'error';
  if (/\b(exit code|exit_code)\s*[:=]?\s*0\b/i.test(output)) return 'success';
  return 'unknown';
}

function normalizeHookPayload(rawInput, phase) {
  const { parsed, format } = parseJsonMaybe(rawInput);
  const payload = parsed && typeof parsed === 'object' ? parsed : {};
  const toolName = normalizeToolName(firstDefined(
    payload.tool_name,
    payload.toolName,
    payload.name,
    payload.tool?.name,
    payload.tool,
    payload.tool_call?.name,
    payload.toolCall?.name,
    payload.function?.name,
    payload.recipient_name,
    payload.recipient
  ));

  const inputValue = firstDefined(
    payload.input,
    payload.tool_input,
    payload.toolInput,
    payload.arguments,
    payload.args,
    payload.parameters,
    payload.params,
    payload.tool_call?.arguments,
    payload.toolCall?.args,
    payload.command,
    format === 'text' ? rawInput : undefined
  );

  const outputValue = firstDefined(
    payload.output,
    payload.tool_output,
    payload.toolOutput,
    payload.result,
    payload.response,
    payload.stdout,
    payload.stderr,
    payload.error
  );

  const inputSummary = summarizeValue(inputValue, 800);
  const outputSummary = phase === 'post' ? summarizeValue(outputValue, 1600) : '';
  const command = extractCommand(toolName, inputValue);
  const status = inferStatus(payload, outputSummary);
  const inputPaths = extractPaths(inputValue);

  return {
    schema_version: MEMORY_VERSION,
    payload_format: format,
    payload_keys: Object.keys(payload).slice(0, 20),
    tool: toolName,
    input_summary: inputSummary,
    output_summary: outputSummary || undefined,
    input_paths: inputPaths,
    command: redactSensitive(command).slice(0, 300),
    command_family: commandFamily(command),
    status,
    error_signal: status === 'error',
  };
}

function yamlEscape(value) {
  if (typeof value !== 'string') return '""';
  return `"${value.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"')}"`;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  match[1].split('\n').forEach((line) => {
    const parts = line.split(':');
    const key = parts.shift();
    if (!key || parts.length === 0) return;
    meta[key.trim()] = parts.join(':').trim().replace(/^["']|["']$/g, '');
  });
  return {
    meta,
    body: content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim(),
  };
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`"'()[\]{}:;,.!?]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function similarityScore(left, right) {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function patternSignature(pattern) {
  const basis = [
    pattern.type,
    pattern.domain,
    pattern.command_family || '',
    pattern.primary_file || '',
    pattern.description || '',
  ].join('|').toLowerCase();
  return hashText(basis);
}

function topicForDomain(domain) {
  return TOPIC_LABELS[domain] ? domain : 'general';
}

function topicTitle(topic) {
  return TOPIC_LABELS[topic] || TOPIC_LABELS.general;
}

function boundText(value, maxLines, maxBytes) {
  const lines = String(value || '').split(/\r?\n/).slice(0, maxLines);
  let output = lines.join('\n');
  while (Buffer.byteLength(output, 'utf8') > maxBytes && output.length > 0) {
    output = output.slice(0, Math.floor(output.length * 0.9));
  }
  return output.trim();
}

function parseMemoryEntriesFromTopic(topic, content) {
  const entries = [];
  const lines = String(content || '').split(/\r?\n/);
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

function collectMemoryEntries(memoryDir) {
  if (!fs.existsSync(memoryDir)) return [];
  return fs.readdirSync(memoryDir)
    .filter(file => file.endsWith('.md') && file !== 'MEMORY.md')
    .flatMap((file) => {
      const topic = path.basename(file, '.md');
      const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
      return parseMemoryEntriesFromTopic(topic, content).map((entry) => ({
        ...entry,
        source: memoryDir,
      }));
    });
}

function collectMemoryTopicStats(memoryDirs) {
  const stats = {
    topic_count: 0,
    topic_file_count: 0,
    total_bytes: 0,
  };
  const topics = new Set();

  uniqueDirs(memoryDirs).forEach((memoryDir) => {
    if (!fs.existsSync(memoryDir)) return;
    fs.readdirSync(memoryDir)
      .filter(file => file.endsWith('.md') && file !== 'MEMORY.md')
      .forEach((file) => {
        const fullPath = path.join(memoryDir, file);
        try {
          const fileStats = fs.statSync(fullPath);
          if (!fileStats.isFile()) return;
          topics.add(path.basename(file, '.md'));
          stats.topic_file_count += 1;
          stats.total_bytes += fileStats.size;
        } catch {}
      });
  });

  stats.topic_count = topics.size;
  return stats;
}

function sortMemoryEntries(entries) {
  return [...entries].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.date.localeCompare(a.date);
  });
}

function mergeMemoryEntries(entries) {
  const byId = new Map();
  entries.forEach((entry) => {
    if (!entry || !entry.id) return;
    const existing = byId.get(entry.id);
    if (
      !existing ||
      entry.confidence > existing.confidence ||
      (entry.confidence === existing.confidence && entry.date > existing.date)
    ) {
      byId.set(entry.id, entry);
    }
  });
  return sortMemoryEntries([...byId.values()]);
}

function selectMemoryIndexEntries(entries, config = DEFAULT_MEMORY_CONFIG, options = {}) {
  const merged = sortMemoryEntries(mergeMemoryEntries(entries));
  const limit = config.maxIndexEntries || DEFAULT_MEMORY_CONFIG.maxIndexEntries;

  // 按 topic 优先级重排，命中 prioritizeTopics 的 entry 排前面。
  // 命中条目少时仍排前，保证"相关性"信号不被埋。
  const prioritizeTopics = Array.isArray(options.prioritizeTopics) ? options.prioritizeTopics : [];
  if (prioritizeTopics.length === 0) return merged.slice(0, limit);

  const topicSet = new Set(prioritizeTopics.map((tag) => String(tag).toLowerCase()));
  const prioritized = [];
  const rest = [];
  for (const entry of merged) {
    if (topicSet.has(String(entry.topic || '').toLowerCase())) {
      prioritized.push(entry);
    } else {
      rest.push(entry);
    }
  }
  return [...prioritized, ...rest].slice(0, limit);
}

function formatIndexEntryLine(entry) {
  const note = (entry.line || '- No detail')
    .replace(/^- \d{4}-\d{2}-\d{2} /, '')
    .trim();
  return `- [${topicTitle(entry.topic)}] ${note}`;
}

function formatMemoryIndexBody(entries) {
  const activeNotes = entries.map(formatIndexEntryLine);
  const groupedTopics = [...new Set(entries.map(entry => entry.topic))].sort();
  const topicLines = groupedTopics.map(topic =>
    `- [[${topic}]] - ${entries.filter(entry => entry.topic === topic).length} active notes`
  );

  return `# MEMORY

This file is generated by Tech Persistence memory v5: concise startup index first, detailed topic files on demand.

## Active Notes
${activeNotes.join('\n') || '- No durable notes yet.'}

## Topics
${topicLines.join('\n') || '- No topic files yet.'}
`;
}

function formatMemoryIndexContent(entries, project, config = DEFAULT_MEMORY_CONFIG, options = {}) {
  const memoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...config };
  const includeFrontmatter = options.includeFrontmatter !== false;
  const dateStr = options.date || new Date().toISOString().split('T')[0];
  const projectName = project && project.name ? project.name : 'unknown';
  let selected = selectMemoryIndexEntries(entries, memoryConfig, {
    prioritizeTopics: options.prioritizeTopics,
  });

  const build = () => {
    const body = formatMemoryIndexBody(selected);
    if (!includeFrontmatter) return body;
    return `---
type: auto-memory-index
memory_version: ${yamlEscape(MEMORY_VERSION)}
project: ${yamlEscape(projectName)}
updated: "${dateStr}"
tags: [memory, index]
---

${body}`;
  };

  let content = build();
  while (Buffer.byteLength(content, 'utf8') > memoryConfig.indexMaxBytes && selected.length > 0) {
    selected = selected.slice(0, -1);
    content = build();
  }

  const lines = content.split(/\r?\n/);
  if (lines.length > memoryConfig.indexMaxLines) {
    content = lines.slice(0, memoryConfig.indexMaxLines).join('\n');
  }

  return { content, indexed: selected.length };
}

function loadMemoryIndexBody(memoryDir, config = DEFAULT_MEMORY_CONFIG) {
  const memoryPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) return '';
  const content = fs.readFileSync(memoryPath, 'utf-8');
  const { body } = parseFrontmatter(content);
  return boundText(
    body,
    config.indexMaxLines || DEFAULT_MEMORY_CONFIG.indexMaxLines,
    config.indexMaxBytes || DEFAULT_MEMORY_CONFIG.indexMaxBytes
  );
}

function loadUnifiedMemoryIndex(memoryDirs, config = DEFAULT_MEMORY_CONFIG, options = {}) {
  const dirs = uniqueDirs(memoryDirs);
  const entries = mergeMemoryEntries(dirs.flatMap(collectMemoryEntries));
  if (entries.length > 0) {
    return formatMemoryIndexContent(
      entries,
      { name: 'unified' },
      config,
      {
        includeFrontmatter: false,
        prioritizeTopics: options.prioritizeTopics,
      }
    ).content;
  }

  const seenBodies = new Set();
  const bodies = dirs
    .map((dir) => loadMemoryIndexBody(dir, config))
    .filter(Boolean)
    .filter((body) => {
      const key = body.toLowerCase();
      if (seenBodies.has(key)) return false;
      seenBodies.add(key);
      return true;
    });

  if (bodies.length === 0) return '';
  return boundText(
    bodies.join('\n\n---\n\n'),
    config.indexMaxLines || DEFAULT_MEMORY_CONFIG.indexMaxLines,
    config.indexMaxBytes || DEFAULT_MEMORY_CONFIG.indexMaxBytes
  );
}

function buildMemoryRecallMetric(memoryDirs, config = DEFAULT_MEMORY_CONFIG, options = {}) {
  const memoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...config };
  const dirs = uniqueDirs(memoryDirs);
  const entries = mergeMemoryEntries(dirs.flatMap(collectMemoryEntries));
  const selected = selectMemoryIndexEntries(entries, memoryConfig, {
    prioritizeTopics: options.prioritizeTopics,
  });
  const topicStats = collectMemoryTopicStats(dirs);
  const totalEntries = entries.length;
  const hitRate = totalEntries === 0 ? 1 : selected.length / totalEntries;
  const project = options.project || {};

  return {
    schema_version: MEMORY_VERSION,
    timestamp: options.timestamp || new Date().toISOString(),
    project_id: project.id || 'unknown',
    project_name: project.name || 'unknown',
    topic_count: topicStats.topic_count,
    topic_file_count: topicStats.topic_file_count,
    total_entries: totalEntries,
    indexed_entries: selected.length,
    index_max_entries: memoryConfig.maxIndexEntries,
    total_bytes: topicStats.total_bytes,
    hit_rate: Number(hitRate.toFixed(4)),
    prioritize_topics: Array.isArray(options.prioritizeTopics) ? options.prioritizeTopics : [],
  };
}

function writeMemoryRecallMetric(metric, telemetryDir) {
  if (!telemetryDir) return null;
  fs.mkdirSync(telemetryDir, { recursive: true });
  const outputPath = path.join(telemetryDir, 'memory-recall.jsonl');
  fs.appendFileSync(outputPath, `${JSON.stringify(metric)}\n`);
  return outputPath;
}

function recordMemoryRecallMetric(memoryDirs, config = DEFAULT_MEMORY_CONFIG, options = {}) {
  const metric = buildMemoryRecallMetric(memoryDirs, config, options);
  const outputPath = writeMemoryRecallMetric(metric, options.telemetryDir);
  return { metric, outputPath };
}

module.exports = {
  buildMemoryRecallMetric,
  collectMemoryEntries,
  collectMemoryTopicStats,
  DEFAULT_MEMORY_CONFIG,
  detectProjectIdentity,
  formatMemoryIndexContent,
  MEMORY_VERSION,
  boundText,
  commandFamily,
  hashText,
  loadUnifiedMemoryIndex,
  mergeMemoryEntries,
  normalizeHookPayload,
  parseMemoryEntriesFromTopic,
  parseFrontmatter,
  patternSignature,
  redactSensitive,
  recordMemoryRecallMetric,
  safeStringify,
  selectMemoryIndexEntries,
  similarityScore,
  sortMemoryEntries,
  summarizeValue,
  topicForDomain,
  topicTitle,
  uniqueDirs,
  writeMemoryRecallMetric,
  yamlEscape,
};
