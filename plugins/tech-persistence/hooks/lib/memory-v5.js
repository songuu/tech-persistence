const crypto = require('crypto');

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

const SECRET_PATTERNS = [
  /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
];

function hashText(value, length = 12) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function redactSensitive(value) {
  if (typeof value !== 'string') return value;
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (match) => {
      const keyMatch = match.match(/^[^:=\s]+/);
      return keyMatch ? `${keyMatch[0]}: [REDACTED]` : '[REDACTED]';
    }),
    value
  );
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

module.exports = {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_VERSION,
  boundText,
  commandFamily,
  hashText,
  normalizeHookPayload,
  parseFrontmatter,
  patternSignature,
  redactSensitive,
  safeStringify,
  similarityScore,
  summarizeValue,
  topicForDomain,
  topicTitle,
  yamlEscape,
};
