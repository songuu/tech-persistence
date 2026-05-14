/**
 * memory-search.js — Memory v5 query-aware recall library
 *
 * 供 UserPromptSubmit hook、Memory MCP tools、CLI 共用的检索底座。
 * 输入：user prompt + 上下文（cwd / touchedFiles / sprintTags）。
 * 输出：top-k memory entries / session snippets / instincts，含分项 score。
 *
 * 设计原则：
 *   - 复用 memory-v5.collectMemoryEntries / topicTitle / parseFrontmatter
 *   - 不调用 loadUnifiedMemoryIndex（那是 SessionStart index formatter，不是 search API）
 *   - 失败模式：所有 fs / parse 错误返空集合，绝不抛异常
 *   - CJK 用 2-gram；ASCII 按非字母数字切；路径保留 basename
 *   - sprint-tag 复用 detectActiveSprintTags() 信号（caller 传入），不重新实现
 */

const fs = require('fs');
const path = require('path');

const {
  collectMemoryEntries,
  mergeMemoryEntries,
  parseFrontmatter,
  topicTitle,
  redactSensitive,
} = require('./memory-v5');

const DEFAULT_LIMITS = {
  memoryTop: 5,
  sessionTop: 2,
  instinctTop: 3,
  budgetChars: 3000,
  minScore: 1.2,
};

const ASCII_TOKEN_MIN_LEN = 2;
const CJK_RANGE = /[㐀-鿿豈-﫿]/;

function isCjkChar(char) {
  return CJK_RANGE.test(char);
}

function tokenizeAscii(text) {
  const tokens = new Set();
  String(text || '')
    .toLowerCase()
    .replace(/[`"'()[\]{}:;,.!?，。；：、！？《》「」『』（）]/g, ' ')
    .split(/[\s]+/)
    .filter((token) => token.length >= ASCII_TOKEN_MIN_LEN && /[a-z0-9]/.test(token))
    .forEach((token) => tokens.add(token));
  return tokens;
}

function tokenizeCjk(text) {
  const tokens = new Set();
  const str = String(text || '');
  let buffer = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (isCjkChar(ch)) {
      buffer += ch;
    } else {
      if (buffer.length >= 2) {
        for (let j = 0; j <= buffer.length - 2; j++) {
          tokens.add(buffer.slice(j, j + 2));
        }
      }
      buffer = '';
    }
  }
  if (buffer.length >= 2) {
    for (let j = 0; j <= buffer.length - 2; j++) {
      tokens.add(buffer.slice(j, j + 2));
    }
  }
  return tokens;
}

function extractPathTokens(text) {
  const tokens = new Set();
  const matches = String(text || '').match(
    /(?:[A-Za-z]:[\\/][^\s"'<>|]+|(?:\.{1,2}[\\/]|[\w.-]+[\\/])[\w./\\-]+|[\w-]+\.(?:js|ts|tsx|jsx|md|json|yml|yaml|toml|sh|ps1|py|rb|css|html))/g
  );
  if (!matches) return tokens;
  matches.forEach((raw) => {
    const cleaned = raw.replace(/[),.;\]}]+$/, '');
    tokens.add(cleaned.toLowerCase());
    const base = path.basename(cleaned).toLowerCase();
    if (base) tokens.add(base);
    cleaned
      .split(/[\\/.\-_]/)
      .filter((part) => part.length >= 2)
      .forEach((part) => tokens.add(part.toLowerCase()));
  });
  return tokens;
}

function tokenizeQuery(text) {
  const ascii = tokenizeAscii(text);
  const cjk = tokenizeCjk(text);
  const paths = extractPathTokens(text);
  return {
    ascii,
    cjk,
    paths,
    all: new Set([...ascii, ...cjk, ...paths]),
  };
}

function dateDistanceDays(dateStr) {
  const today = new Date();
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return 9999;
  const diff = today.getTime() - parsed.getTime();
  return diff / (1000 * 60 * 60 * 24);
}

function recencyBoost(dateStr) {
  const days = dateDistanceDays(dateStr);
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.6;
  if (days <= 90) return 0.3;
  if (days <= 180) return 0.15;
  return 0.05;
}

function confidenceBoost(value) {
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function countMatches(haystackTokens, needleTokens) {
  if (!needleTokens || needleTokens.size === 0) return 0;
  let hits = 0;
  for (const token of needleTokens) {
    if (haystackTokens.has(token)) hits++;
  }
  return hits;
}

function scoreEntry(entry, query, options = {}) {
  const text = `${entry.line || ''} ${entry.topic || ''}`;
  const entryAscii = tokenizeAscii(text);
  const entryCjk = tokenizeCjk(text);
  const entryPaths = extractPathTokens(text);

  const asciiHits = countMatches(entryAscii, query.ascii);
  const cjkHits = countMatches(entryCjk, query.cjk);
  const pathHits = countMatches(entryPaths, query.paths);

  const queryAsciiSize = query.ascii.size || 1;
  const queryCjkSize = query.cjk.size || 1;
  const queryPathSize = query.paths.size || 1;

  const keyword = (asciiHits / queryAsciiSize) * 0.6 + (cjkHits / queryCjkSize) * 0.4;
  const pathScore = pathHits / queryPathSize;

  const sprintTags = Array.isArray(options.sprintTags) ? options.sprintTags : [];
  const sprintTagSet = new Set(sprintTags.map((t) => String(t).toLowerCase()));
  const topicLower = String(entry.topic || '').toLowerCase();
  const topicMatch = sprintTagSet.size > 0 && sprintTagSet.has(topicLower) ? 1 : 0;

  const recency = recencyBoost(entry.date);
  const confidence = confidenceBoost(entry.confidence);

  const total =
    keyword * 2.0 +
    pathScore * 2.5 +
    topicMatch * 1.0 +
    recency * 0.5 +
    confidence * 0.5;

  return {
    total,
    components: { keyword, path: pathScore, topic: topicMatch, recency, confidence },
  };
}

function collectSessionFiles(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];
  try {
    return fs
      .readdirSync(sessionsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => {
        const file = path.join(sessionsDir, name);
        let content;
        try {
          content = fs.readFileSync(file, 'utf-8');
        } catch {
          return null;
        }
        const { meta, body } = parseFrontmatter(content);
        const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
        return {
          file,
          name,
          date: dateMatch ? dateMatch[1] : meta.date || '1970-01-01',
          body: String(body || '').slice(0, 4000),
          tags: meta.tags || '',
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function scoreSession(session, query) {
  const ascii = tokenizeAscii(session.body);
  const cjk = tokenizeCjk(session.body);
  const paths = extractPathTokens(session.body);

  const asciiHits = countMatches(ascii, query.ascii);
  const cjkHits = countMatches(cjk, query.cjk);
  const pathHits = countMatches(paths, query.paths);

  const queryAsciiSize = query.ascii.size || 1;
  const queryCjkSize = query.cjk.size || 1;
  const queryPathSize = query.paths.size || 1;

  const keyword = (asciiHits / queryAsciiSize) * 0.6 + (cjkHits / queryCjkSize) * 0.4;
  const pathScore = pathHits / queryPathSize;
  const recency = recencyBoost(session.date);

  return {
    total: keyword * 1.5 + pathScore * 2.0 + recency * 0.4,
    components: { keyword, path: pathScore, recency },
  };
}

function collectInstinctFiles(instinctsDir, minConfidence = 0.5) {
  if (!fs.existsSync(instinctsDir)) return [];
  try {
    return fs
      .readdirSync(instinctsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => {
        const file = path.join(instinctsDir, name);
        let content;
        try {
          content = fs.readFileSync(file, 'utf-8');
        } catch {
          return null;
        }
        const { meta, body } = parseFrontmatter(content);
        const confidence = parseFloat(meta.confidence || '0');
        if (!(confidence >= minConfidence)) return null;
        return {
          file,
          name,
          confidence,
          domain: meta.domain || '',
          trigger: meta.trigger || meta.id || path.basename(name, '.md'),
          body: String(body || '').slice(0, 1200),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function scoreInstinct(instinct, query) {
  const text = `${instinct.trigger} ${instinct.body}`;
  const ascii = tokenizeAscii(text);
  const cjk = tokenizeCjk(text);
  const paths = extractPathTokens(text);

  const asciiHits = countMatches(ascii, query.ascii);
  const cjkHits = countMatches(cjk, query.cjk);
  const pathHits = countMatches(paths, query.paths);

  const queryAsciiSize = query.ascii.size || 1;
  const queryCjkSize = query.cjk.size || 1;
  const queryPathSize = query.paths.size || 1;

  const keyword = (asciiHits / queryAsciiSize) * 0.6 + (cjkHits / queryCjkSize) * 0.4;
  const pathScore = pathHits / queryPathSize;

  return {
    total: keyword * 1.5 + pathScore * 1.5 + instinct.confidence * 0.6,
    components: { keyword, path: pathScore, confidence: instinct.confidence },
  };
}

function searchMemory(options = {}) {
  const {
    prompt = '',
    projectId,
    baseDirs = [],
    touchedFiles = [],
    sprintTags = [],
    limits = {},
  } = options;

  const finalLimits = { ...DEFAULT_LIMITS, ...limits };
  const enrichedPrompt = `${prompt} ${touchedFiles.join(' ')}`;
  const query = tokenizeQuery(enrichedPrompt);

  if (query.all.size === 0) {
    return { memory: [], sessions: [], instincts: [], query, limits: finalLimits };
  }

  const memoryEntries = [];
  const sessionFiles = [];
  const instinctFiles = [];

  for (const baseDir of baseDirs) {
    if (!projectId) continue;
    const memoryDir = path.join(baseDir, 'projects', projectId, 'memory');
    const sessionsDir = path.join(baseDir, 'projects', projectId, 'sessions');
    const instinctsProjectDir = path.join(baseDir, 'projects', projectId, 'instincts');
    const instinctsGlobalDir = path.join(baseDir, 'instincts', 'personal');

    try {
      memoryEntries.push(...collectMemoryEntries(memoryDir));
    } catch {}
    sessionFiles.push(...collectSessionFiles(sessionsDir));
    instinctFiles.push(...collectInstinctFiles(instinctsProjectDir, 0.5));
    instinctFiles.push(...collectInstinctFiles(instinctsGlobalDir, 0.7));
  }

  const mergedMemory = mergeMemoryEntries(memoryEntries);

  const scoredMemory = mergedMemory
    .map((entry) => ({ entry, score: scoreEntry(entry, query, { sprintTags }) }))
    .filter((item) => item.score.total >= finalLimits.minScore)
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, finalLimits.memoryTop);

  const seenSessions = new Set();
  const scoredSessions = sessionFiles
    .filter((session) => {
      if (seenSessions.has(session.name)) return false;
      seenSessions.add(session.name);
      return true;
    })
    .map((session) => ({ session, score: scoreSession(session, query) }))
    .filter((item) => item.score.total >= finalLimits.minScore)
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, finalLimits.sessionTop);

  const seenInstincts = new Set();
  const scoredInstincts = instinctFiles
    .filter((inst) => {
      if (seenInstincts.has(inst.name)) return false;
      seenInstincts.add(inst.name);
      return true;
    })
    .map((inst) => ({ instinct: inst, score: scoreInstinct(inst, query) }))
    .filter((item) => item.score.total >= finalLimits.minScore)
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, finalLimits.instinctTop);

  return {
    memory: scoredMemory,
    sessions: scoredSessions,
    instincts: scoredInstincts,
    query,
    limits: finalLimits,
  };
}

function formatRecallLine(entry) {
  // entry.line 形如 "- 2026-05-13 [0.7] body"。剥离 leading "- date " 与 "[conf] "
  // 两段前缀（避免与下面我们重新拼接的 date / confidence 重复）。
  const note = String(entry.line || '')
    .replace(/^- \d{4}-\d{2}-\d{2}\s+/, '')
    .replace(/^\[\d(?:\.\d+)?\]\s+/, '')
    .trim();
  const confidence = Number.isFinite(entry.confidence) ? entry.confidence.toFixed(2) : '?';
  return `- [${topicTitle(entry.topic)}] ${entry.date} [${confidence}] ${redactSensitive(note)}`;
}

function formatInstinctLine(instinct) {
  const flag = instinct.confidence >= 0.7 ? '🟢' : '🟡';
  return `- ${flag} [${instinct.confidence.toFixed(2)}] [${instinct.domain || '?'}] ${redactSensitive(instinct.trigger)}`;
}

function formatSessionSnippet(session) {
  const snippet = String(session.body || '').slice(0, 300).replace(/\s+/g, ' ').trim();
  return `- ${session.date}: ${redactSensitive(snippet)}`;
}

function formatRecallContext(result, options = {}) {
  const budgetChars = options.budgetChars ?? result.limits?.budgetChars ?? DEFAULT_LIMITS.budgetChars;
  const lines = [];
  lines.push('## Relevant Tech Persistence Memory');
  lines.push('');

  if (result.memory.length > 0) {
    lines.push('### Memory v5');
    result.memory.forEach((item) => lines.push(formatRecallLine(item.entry)));
    lines.push('');
  }

  if (result.instincts.length > 0) {
    lines.push('### Instincts');
    result.instincts.forEach((item) => lines.push(formatInstinctLine(item.instinct)));
    lines.push('');
  }

  if (result.sessions.length > 0) {
    lines.push('### Recent Sessions');
    result.sessions.forEach((item) => lines.push(formatSessionSnippet(item.session)));
    lines.push('');
  }

  lines.push(`Source: Memory v5 prompt recall. Budget: ${budgetChars} chars.`);

  let body = lines.join('\n');
  if (body.length > budgetChars) {
    body = `${body.slice(0, budgetChars - 20)}\n... [truncated]`;
  }
  return body;
}

function hasUsefulResults(result) {
  return (
    (result.memory && result.memory.length > 0) ||
    (result.instincts && result.instincts.length > 0) ||
    (result.sessions && result.sessions.length > 0)
  );
}

module.exports = {
  DEFAULT_LIMITS,
  collectInstinctFiles,
  collectSessionFiles,
  extractPathTokens,
  formatRecallContext,
  hasUsefulResults,
  scoreEntry,
  scoreInstinct,
  scoreSession,
  searchMemory,
  tokenizeAscii,
  tokenizeCjk,
  tokenizeQuery,
};
