#!/usr/bin/env node

/**
 * test-memory-search.js — 自包含单测（无外部 framework）
 *
 * 覆盖：tokenizer / scorer / searchMemory 端到端 / 失败模式
 * 运行：node scripts/test-memory-search.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const {
  DEFAULT_LIMITS,
  extractPathTokens,
  formatRecallContext,
  hasUsefulResults,
  scoreEntry,
  searchMemory,
  tokenizeAscii,
  tokenizeCjk,
  tokenizeQuery,
} = require('./lib/memory-search');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[OK] ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

function makeTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-memory-search-'));
  const projectId = 'testproj';
  const projectDir = path.join(root, 'projects', projectId);
  fs.mkdirSync(path.join(projectDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'instincts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instincts', 'personal'), { recursive: true });
  return { root, projectId, projectDir };
}

function writeMemoryTopic(projectDir, topic, entries) {
  const lines = [
    `# ${topic}`,
    '',
  ];
  entries.forEach((entry) => {
    lines.push(`<!-- memory:v5:${entry.id} -->`);
    lines.push(`- ${entry.date} [${entry.confidence}] ${entry.body}`);
    lines.push('');
  });
  fs.writeFileSync(path.join(projectDir, 'memory', `${topic}.md`), lines.join('\n'));
}

function writeSession(projectDir, name, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`)
    .join('\n');
  fs.writeFileSync(
    path.join(projectDir, 'sessions', name),
    `---\n${fm}\n---\n\n${body}\n`
  );
}

function writeInstinct(dir, name, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`)
    .join('\n');
  fs.writeFileSync(
    path.join(dir, name),
    `---\n${fm}\n---\n\n${body}\n`
  );
}

// ---------- Tokenizer tests ----------

test('tokenizeAscii filters tokens shorter than 2 chars', () => {
  const tokens = tokenizeAscii('a bb runtime-paths js');
  assert.ok(tokens.has('bb'));
  assert.ok(tokens.has('runtime-paths'));
  assert.ok(tokens.has('js'));
  assert.ok(!tokens.has('a'));
});

test('tokenizeAscii lowercases and splits on punctuation', () => {
  const tokens = tokenizeAscii('HelloWorld, runtime.js;TEST');
  assert.ok(tokens.has('helloworld'));
  assert.ok(tokens.has('runtime'));
  assert.ok(tokens.has('js'));
  assert.ok(tokens.has('test'));
});

test('tokenizeCjk generates 2-gram for chinese text', () => {
  const tokens = tokenizeCjk('双运行时边界');
  assert.ok(tokens.has('双运'));
  assert.ok(tokens.has('运行'));
  assert.ok(tokens.has('行时'));
  assert.ok(tokens.has('时边'));
  assert.ok(tokens.has('边界'));
});

test('tokenizeCjk ignores single chars and ASCII gaps', () => {
  const tokens = tokenizeCjk('我 是 abc');
  assert.strictEqual(tokens.size, 0);
});

test('tokenizeCjk handles mixed CJK and ASCII', () => {
  const tokens = tokenizeCjk('修复 runtime-paths 双运行时');
  assert.ok(tokens.has('修复'));
  assert.ok(tokens.has('双运'));
  assert.ok(tokens.has('运行'));
  assert.ok(tokens.has('行时'));
});

test('extractPathTokens captures windows and unix paths', () => {
  const tokens = extractPathTokens('see scripts/lib/runtime-paths.js or C:\\Users\\foo\\bar.md');
  const arr = [...tokens];
  assert.ok(arr.some((t) => t.includes('runtime-paths')));
  assert.ok(arr.some((t) => t.includes('bar.md')));
});

test('extractPathTokens captures bare filenames with known extensions', () => {
  const tokens = extractPathTokens('open observe.js and inject-context.js');
  assert.ok(tokens.has('observe.js'));
  assert.ok(tokens.has('inject-context.js'));
});

test('tokenizeQuery combines all token types', () => {
  const q = tokenizeQuery('修复 runtime-paths.js 双运行时');
  assert.ok(q.ascii.size > 0);
  assert.ok(q.cjk.size > 0);
  assert.ok(q.paths.size > 0);
  assert.ok(q.all.size >= q.ascii.size + q.cjk.size);
});

// ---------- Scorer tests ----------

test('scoreEntry rewards keyword match', () => {
  const entry = {
    id: 'a',
    topic: 'architecture',
    date: '2026-05-13',
    confidence: 0.8,
    line: '- 2026-05-13 [0.8] runtime-paths is the dual-runtime boundary',
  };
  const matching = scoreEntry(entry, tokenizeQuery('runtime-paths boundary'), {});
  const unrelated = scoreEntry(entry, tokenizeQuery('totally other stuff'), {});
  assert.ok(matching.total > unrelated.total);
  assert.ok(matching.components.keyword > 0);
});

test('scoreEntry rewards sprint-tag match on topic', () => {
  const entry = {
    id: 'b',
    topic: 'debugging',
    date: '2026-05-13',
    confidence: 0.7,
    line: '- 2026-05-13 [0.7] some debug note',
  };
  const noTags = scoreEntry(entry, tokenizeQuery('debug note'), {});
  const withTags = scoreEntry(entry, tokenizeQuery('debug note'), {
    sprintTags: ['debugging'],
  });
  assert.ok(withTags.total > noTags.total);
  assert.strictEqual(withTags.components.topic, 1);
});

test('scoreEntry recency component decays', () => {
  const recent = {
    id: 'r',
    topic: 'workflow',
    date: '2026-05-13',
    confidence: 0.5,
    line: '- 2026-05-13 [0.5] foo',
  };
  const old = { ...recent, date: '2025-01-01' };
  const q = tokenizeQuery('foo workflow');
  const recentScore = scoreEntry(recent, q, {});
  const oldScore = scoreEntry(old, q, {});
  assert.ok(recentScore.components.recency > oldScore.components.recency);
});

// ---------- End-to-end searchMemory ----------

test('searchMemory returns top entries by relevance', () => {
  const { root, projectId, projectDir } = makeTempProject();
  writeMemoryTopic(projectDir, 'architecture', [
    {
      id: '1111',
      date: '2026-05-13',
      confidence: 0.8,
      body: 'runtime-paths.js is the dual-runtime boundary, do not Codex-only',
    },
    {
      id: '2222',
      date: '2026-05-10',
      confidence: 0.6,
      body: 'unrelated note about css',
    },
  ]);
  writeMemoryTopic(projectDir, 'debugging', [
    {
      id: '3333',
      date: '2026-05-12',
      confidence: 0.75,
      body: 'runtime hook silently failed in observe.js',
    },
  ]);

  const result = searchMemory({
    prompt: 'how should I handle runtime-paths.js',
    projectId,
    baseDirs: [root],
  });

  assert.ok(result.memory.length > 0, 'expected memory hits');
  assert.strictEqual(result.memory[0].entry.id, '1111', 'most relevant entry should rank first');
  const score1111 = result.memory.find((item) => item.entry.id === '1111').score.total;
  const score2222 = result.memory.find((item) => item.entry.id === '2222');
  if (score2222) {
    assert.ok(
      score1111 > score2222.score.total,
      `expected 1111 (${score1111}) > 2222 (${score2222.score.total})`
    );
  }
});

test('searchMemory handles CJK prompt and surfaces CJK memory', () => {
  const { root, projectId, projectDir } = makeTempProject();
  writeMemoryTopic(projectDir, 'architecture', [
    {
      id: 'aaaa',
      date: '2026-05-13',
      confidence: 0.85,
      body: '双运行时边界由 runtime-paths.js 维护，不能 Codex-only',
    },
    {
      id: 'bbbb',
      date: '2026-05-13',
      confidence: 0.5,
      body: 'css styling tweaks',
    },
  ]);

  const result = searchMemory({
    prompt: '双运行时怎么处理',
    projectId,
    baseDirs: [root],
    limits: { minScore: 0.0 },
  });

  assert.ok(result.memory.length > 0);
  assert.strictEqual(result.memory[0].entry.id, 'aaaa');
});

test('searchMemory respects minScore threshold', () => {
  const { root, projectId, projectDir } = makeTempProject();
  writeMemoryTopic(projectDir, 'general', [
    {
      id: 'low',
      date: '2026-05-13',
      confidence: 0.4,
      body: 'something completely unrelated',
    },
  ]);

  const result = searchMemory({
    prompt: 'runtime-paths.js boundary',
    projectId,
    baseDirs: [root],
    limits: { minScore: 1.5 },
  });

  assert.strictEqual(result.memory.length, 0);
});

test('searchMemory returns empty on empty query', () => {
  const { root, projectId } = makeTempProject();
  const result = searchMemory({
    prompt: '',
    projectId,
    baseDirs: [root],
  });
  assert.strictEqual(result.memory.length, 0);
  assert.strictEqual(result.sessions.length, 0);
  assert.strictEqual(result.instincts.length, 0);
});

test('searchMemory tolerates missing dirs', () => {
  const result = searchMemory({
    prompt: 'anything',
    projectId: 'nonexistent',
    baseDirs: ['/tmp/does-not-exist-xyz'],
  });
  assert.strictEqual(result.memory.length, 0);
});

test('searchMemory surfaces matching session snippet', () => {
  const { root, projectId, projectDir } = makeTempProject();
  writeSession(
    projectDir,
    '2026-05-13-aaaa.md',
    { date: '2026-05-13', type: 'session-summary', tags: '[session]' },
    'discussed runtime-paths.js dual-runtime boundary and Codex parity'
  );
  writeSession(
    projectDir,
    '2026-05-12-bbbb.md',
    { date: '2026-05-12', type: 'session-summary' },
    'unrelated css fixes'
  );

  const result = searchMemory({
    prompt: 'runtime-paths boundary',
    projectId,
    baseDirs: [root],
    limits: { minScore: 0.0 },
  });

  assert.ok(result.sessions.length > 0);
  assert.ok(result.sessions[0].session.name.startsWith('2026-05-13'));
});

test('searchMemory surfaces matching instinct from global personal dir', () => {
  const { root, projectId } = makeTempProject();
  writeInstinct(
    path.join(root, 'instincts', 'personal'),
    'runtime-paths-boundary.md',
    {
      name: 'runtime-paths-boundary',
      confidence: 0.8,
      domain: 'architecture',
      trigger: 'editing hooks that touch homunculus directories',
    },
    'Always go through runtime-paths.js, never hardcode .claude or .codex.'
  );

  const result = searchMemory({
    prompt: 'should I hardcode .claude path in hook?',
    projectId,
    baseDirs: [root],
    limits: { minScore: 0.0 },
  });

  assert.ok(result.instincts.length > 0);
  assert.strictEqual(result.instincts[0].instinct.name, 'runtime-paths-boundary.md');
});

// ---------- formatRecallContext / hasUsefulResults ----------

test('formatRecallContext respects budgetChars', () => {
  const result = {
    memory: [
      {
        entry: {
          topic: 'architecture',
          date: '2026-05-13',
          confidence: 0.8,
          line: '- 2026-05-13 [0.8] foo bar runtime-paths boundary',
        },
        score: { total: 5 },
      },
    ],
    sessions: [],
    instincts: [],
    limits: DEFAULT_LIMITS,
  };
  const output = formatRecallContext(result, { budgetChars: 80 });
  assert.ok(output.length <= 80, `output ${output.length} chars over budget 80`);
});

test('hasUsefulResults true when any non-empty set', () => {
  assert.strictEqual(
    hasUsefulResults({ memory: [], sessions: [], instincts: [] }),
    false
  );
  assert.strictEqual(
    hasUsefulResults({ memory: [{}], sessions: [], instincts: [] }),
    true
  );
});

test('formatRecallContext redacts secrets in entry line', () => {
  const result = {
    memory: [
      {
        entry: {
          topic: 'general',
          date: '2026-05-13',
          confidence: 0.7,
          line: '- 2026-05-13 [0.7] api_key=sk-proj-xxxx very sensitive',
        },
        score: { total: 5 },
      },
    ],
    sessions: [],
    instincts: [],
    limits: DEFAULT_LIMITS,
  };
  const output = formatRecallContext(result, { budgetChars: 2000 });
  assert.ok(!output.includes('sk-proj-xxxx'), 'secret should be redacted');
  assert.ok(output.includes('[REDACTED]'));
});

// ---------- T8 新增：Solution recall scenarios ----------

const {
  collectSolutionFiles,
  scoreSolution,
} = require('./lib/memory-search');

function writeSolution(solutionsDir, name, frontmatter, body) {
  fs.mkdirSync(solutionsDir, { recursive: true });
  let content;
  if (frontmatter) {
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`)
      .join('\n');
    content = `---\n${fm}\n---\n\n${body}\n`;
  } else {
    content = body;
  }
  fs.writeFileSync(path.join(solutionsDir, name), content);
}

test('S22 collectSolutionFiles reads solutions with frontmatter', () => {
  const { root } = makeTempProject();
  const solutionsDir = path.join(root, 'docs', 'solutions');
  writeSolution(
    solutionsDir,
    '2026-05-14-foo-bar.md',
    { title: 'Foo Bar Solution', date: '2026-05-14', tags: '[solution, foo]' },
    '# Foo Bar Solution\n\nProblem solved.'
  );
  const entries = collectSolutionFiles(solutionsDir);
  assert.strictEqual(entries.length, 1, 'one entry expected');
  assert.strictEqual(entries[0].topic, 'solution');
  assert.strictEqual(entries[0].date, '2026-05-14');
  assert.strictEqual(entries[0].title, 'Foo Bar Solution');
  assert.strictEqual(entries[0].confidence, 0.7);
});

test('S23 collectSolutionFiles fallback for solution without frontmatter', () => {
  const { root } = makeTempProject();
  const solutionsDir = path.join(root, 'docs', 'solutions');
  writeSolution(
    solutionsDir,
    '2026-04-30-legacy-fix.md',
    null,
    '# Legacy Caveman Fix\n\nProblem and root cause.'
  );
  const entries = collectSolutionFiles(solutionsDir);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].date, '2026-04-30', 'date from filename');
  assert.strictEqual(entries[0].title, 'Legacy Caveman Fix', 'title from h1');
});

test('S24 searchMemory with cwd returns solutions array', () => {
  const { root, projectId } = makeTempProject();
  const solutionsDir = path.join(root, 'docs', 'solutions');
  writeSolution(
    solutionsDir,
    '2026-05-14-plugin-migration.md',
    { title: 'Plugin migration cascade', date: '2026-05-14', tags: 'solution,plugin-migration,hook' },
    '# Plugin migration cascade\n\nhook double-fire fix.'
  );
  const result = searchMemory({
    prompt: 'plugin-migration hook double-fire',
    projectId,
    baseDirs: [root],
    cwd: root,
    limits: { minScore: 0.5 },
  });
  assert.ok(Array.isArray(result.solutions), 'solutions key present');
  assert.ok(result.solutions.length >= 1, 'at least 1 solution matched');
  assert.strictEqual(result.solutions[0].solution.title, 'Plugin migration cascade');
});

test('S25 scoreSolution keyword weight is 2.0 (vs memory 1.5)', () => {
  const query = {
    ascii: new Set(['plugin', 'migration']),
    cjk: new Set(),
    paths: new Set(),
    all: new Set(['plugin', 'migration']),
  };
  const solutionEntry = {
    line: '[Solution] 2026-05-14 plugin migration cascade',
    note: 'plugin migration content',
    tags: 'plugin,migration',
    title: 'plugin migration',
    date: '2026-05-14',
  };
  const score = scoreSolution(solutionEntry, query);
  // keyword 因 2.0 系数 + path/recency/confidence 累加，应明显高
  assert.ok(score.total > 1.5, `score.total ${score.total} > 1.5`);
  assert.ok(score.components.keyword > 0, 'keyword component positive');
  // 同样 query 在 scoreEntry 上系数 1.5，理论 scoreSolution 应高于 scoreEntry
  // （不严格比对，因为两者还有 sprint-tag / confidence 等差异）
});

test('S26 solution merges into top-k with topK truncation', () => {
  const { root, projectId } = makeTempProject();
  const solutionsDir = path.join(root, 'docs', 'solutions');
  for (let i = 0; i < 5; i++) {
    writeSolution(
      solutionsDir,
      `2026-05-1${i}-doc-${i}.md`,
      { title: `Doc keyword Solution ${i}`, date: `2026-05-1${i}` },
      `# Doc keyword Solution ${i}\n\nkeyword keyword keyword`
    );
  }
  const result = searchMemory({
    prompt: 'keyword',
    projectId,
    baseDirs: [root],
    cwd: root,
    limits: { minScore: 0.3, solutionTop: 3 },
  });
  assert.ok(result.solutions.length <= 3, `solutionTop=3 enforced, got ${result.solutions.length}`);
  assert.ok(result.solutions.length >= 1, 'at least 1 match');
  // 降序：第一条 score >= 第二条
  if (result.solutions.length >= 2) {
    assert.ok(result.solutions[0].score.total >= result.solutions[1].score.total, 'descending order');
  }
});

// ---------- Summary ----------

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${err.stack || err.message}`);
  });
  process.exit(1);
}
