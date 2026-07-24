#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  BEGIN_MARKER,
  END_MARKER,
  SECTION_ANCHOR,
  parseFrontmatter,
  parseArgs,
  collectSolutions,
  readRegisteredProject,
  renderIndexJsonl,
  resolveProjectionProject,
  upsertSolutionSection,
  syncObsidianSolutionProjection,
  syncSolutionIndex,
} = require('./sync-solution-index');
const { checkSolutionIndexSync } = require('./pre-commit-check');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-solution-index-'));
  fs.mkdirSync(path.join(repo, 'docs', 'solutions'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude\n\n### 解决方案索引\n\n- old\n\n## Other\nkeep\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agents\n\n## 已知陷阱（高频）\nnone\n\n## 当前迭代重点\n- [ ] x\n');
  return repo;
}

function copySolutionIndexRuntime(repo) {
  const scriptsDir = path.join(repo, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'sync-solution-index.js'), path.join(scriptsDir, 'sync-solution-index.js'));
  fs.cpSync(path.join(__dirname, 'lib'), path.join(scriptsDir, 'lib'), { recursive: true });
}

function writeSolution(repo, name, frontmatter, body) {
  fs.writeFileSync(
    path.join(repo, 'docs', 'solutions', name),
    ['---', frontmatter.trim(), '---', '', body.trim(), ''].join('\n')
  );
}

test('parseFrontmatter parses scalar and array fields', () => {
  const parsed = parseFrontmatter([
    '---',
    'title: "A title"',
    'date: 2026-05-18',
    'tags: [solution, memory, codex]',
    '---',
    '# Body',
    '',
  ].join('\n'));
  assert.strictEqual(parsed.data.title, 'A title');
  assert.strictEqual(parsed.data.date, '2026-05-18');
  assert.deepStrictEqual(parsed.data.tags, ['solution', 'memory', 'codex']);
  assert.ok(parsed.body.includes('# Body'));
});

test('collectSolutions derives stable entries from docs/solutions', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-17-a.md', 'title: "A"\ndate: 2026-05-17\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  writeSolution(repo, '2026-05-18-b.md', 'title: "B"\ndate: 2026-05-18\ntags: [solution, beta]', '# B\n\n## Problem\n\nBeta problem.');
  const entries = collectSolutions(repo);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].id, '2026-05-18-b');
  assert.strictEqual(entries[0].summary, 'Beta problem.');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('upsertSolutionSection replaces existing bounded section', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  const entries = collectSolutions(repo);
  const before = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
  const after = upsertSolutionSection(before, entries);
  assert.ok(!after.includes('- old'));
  assert.ok(after.includes('<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->'));
  assert.ok(after.includes('Alpha problem.'));
  assert.ok(after.includes('## Other\nkeep'));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('upsertSolutionSection inserts technical sediment section when missing', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  const entries = collectSolutions(repo);
  const before = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8');
  const after = upsertSolutionSection(before, entries);
  const afterSecondRun = upsertSolutionSection(after, entries);
  assert.ok(after.includes('## 技术沉淀（通用经验）'));
  assert.ok(after.indexOf('### 解决方案索引') < after.indexOf('## 当前迭代重点'));
  assert.strictEqual(afterSecondRun, after);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('syncSolutionIndex writes the canonical jsonl and Claude projection without mutating AGENTS', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  const agentsBefore = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8');
  const result = syncSolutionIndex(repo, { targets: ['claude', 'codex'] });
  assert.strictEqual(result.entries.length, 1);
  assert.ok(fs.existsSync(path.join(repo, 'docs', 'solutions', 'index.jsonl')));
  assert.ok(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8').includes('Alpha problem.'));
  assert.strictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8'), agentsBefore);
  assert.deepStrictEqual(result.changes.map((change) => change.target), ['index', 'claude', 'codex']);
  assert.deepStrictEqual(
    result.changes.find((change) => change.target === 'codex'),
    {
      target: 'codex',
      path: path.join(repo, 'AGENTS.md'),
      changed: false,
      migration: 'already-absent',
    }
  );
  const jsonl = renderIndexJsonl(result.entries).trim();
  assert.deepStrictEqual(JSON.parse(jsonl), result.entries[0]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('non-stale Codex and Claude-only paths do not load the CAS runtime', () => {
  const repo = makeRepo();
  const casPath = require.resolve('./update-codex-marketplace');
  delete require.cache[casPath];

  syncSolutionIndex(repo, { targets: ['claude', 'codex'] });
  assert.strictEqual(require.cache[casPath], undefined);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('codex target removes one legacy managed block while preserving adjacent custom content', () => {
  const repo = makeRepo();
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  const agentsPath = path.join(repo, 'AGENTS.md');
  const agentsBefore = [
    '# Agents',
    '',
    'custom before',
    '',
    SECTION_ANCHOR,
    '',
    BEGIN_MARKER,
    '> stale generated content',
    '- stale entry',
    END_MARKER,
    '',
    'custom after',
    '',
  ].join('\n');
  fs.writeFileSync(agentsPath, agentsBefore);
  const claudePath = path.join(repo, 'CLAUDE.md');
  const claudeBefore = fs.readFileSync(claudePath, 'utf-8');
  const expectedClaude = upsertSolutionSection(claudeBefore, collectSolutions(repo));

  const first = syncSolutionIndex(repo, { targets: ['claude', 'codex'] });
  const agentsAfter = fs.readFileSync(agentsPath, 'utf-8');
  const codexChange = first.changes.find((change) => change.target === 'codex');
  assert.strictEqual(codexChange.changed, true);
  assert.strictEqual(codexChange.migration, 'removed-legacy-managed-block');
  assert.strictEqual(agentsAfter.includes(BEGIN_MARKER), false);
  assert.strictEqual(agentsAfter.includes(END_MARKER), false);
  assert.strictEqual(agentsAfter.includes(SECTION_ANCHOR), false);
  assert.ok(agentsAfter.includes('custom before'));
  assert.ok(agentsAfter.includes('custom after'));
  assert.strictEqual(fs.readFileSync(claudePath, 'utf-8'), expectedClaude);

  const second = syncSolutionIndex(repo, { targets: ['claude', 'codex'] });
  assert.strictEqual(fs.readFileSync(agentsPath, 'utf-8'), agentsAfter);
  assert.deepStrictEqual(
    second.changes.find((change) => change.target === 'codex'),
    {
      target: 'codex',
      path: agentsPath,
      changed: false,
      migration: 'already-absent',
    }
  );
  assert.strictEqual(fs.readFileSync(claudePath, 'utf-8'), expectedClaude);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('codex migration CAS preserves a writer that replaces AGENTS before publish', () => {
  const repo = makeRepo();
  const agentsPath = path.join(repo, 'AGENTS.md');
  fs.writeFileSync(agentsPath, [
    '# Agents',
    SECTION_ANCHOR,
    BEGIN_MARKER,
    '- stale',
    END_MARKER,
    '',
  ].join('\n'));
  const external = '# external writer\n';

  assert.throws(
    () => syncSolutionIndex(repo, {
      targets: ['codex'],
      skipIndex: true,
      codexMigrationTestHooks: {
        beforePublish() {
          fs.writeFileSync(agentsPath, external);
        },
      },
    }),
    (error) => error && error.code === 'CODEX_COMPARE_AND_SWAP_CONFLICT'
  );
  assert.strictEqual(fs.readFileSync(agentsPath, 'utf-8'), external);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('codex migration CAS rejects parent path replacement and preserves external bytes', () => {
  const repo = makeRepo();
  const managedDir = path.join(repo, 'managed');
  const displacedDir = path.join(repo, 'managed-displaced');
  fs.mkdirSync(managedDir);
  const agentsPath = path.join(managedDir, 'AGENTS.md');
  fs.writeFileSync(agentsPath, [BEGIN_MARKER, '- stale', END_MARKER, ''].join('\n'));
  const external = '# replacement parent\n';

  assert.throws(
    () => syncSolutionIndex(repo, {
      targets: ['codex'],
      agentsMd: path.join('managed', 'AGENTS.md'),
      skipIndex: true,
      codexMigrationTestHooks: {
        beforeClaim() {
          fs.renameSync(managedDir, displacedDir);
          fs.mkdirSync(managedDir);
          fs.writeFileSync(agentsPath, external);
        },
      },
    }),
    /compare-and-swap|parent identity/i
  );
  assert.strictEqual(fs.readFileSync(agentsPath, 'utf-8'), external);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('codex migration hard crash is recovered and safely retried', () => {
  const repo = makeRepo();
  const agentsPath = path.join(repo, 'AGENTS.md');
  fs.writeFileSync(agentsPath, [
    '# Agents',
    'custom before',
    SECTION_ANCHOR,
    BEGIN_MARKER,
    '- stale',
    END_MARKER,
    'custom after',
    '',
  ].join('\n'));
  const childPath = path.join(repo, 'crash-migration.js');
  fs.writeFileSync(childPath, [
    "const { syncSolutionIndex } = require(process.argv[2]);",
    "syncSolutionIndex(process.argv[3], {",
    "  targets: ['codex'],",
    "  skipIndex: true,",
    "  codexMigrationTestHooks: { beforePublish() { process.exit(86); } },",
    "});",
    '',
  ].join('\n'));
  const crashed = spawnSync(
    process.execPath,
    [childPath, path.join(__dirname, 'sync-solution-index.js'), repo],
    { encoding: 'utf8' }
  );
  assert.strictEqual(crashed.status, 86, crashed.stderr);
  assert.strictEqual(fs.existsSync(agentsPath), false, 'hard crash should occur after the canonical claim');

  const retried = syncSolutionIndex(repo, { targets: ['codex'], skipIndex: true });
  const change = retried.changes.find((entry) => entry.target === 'codex');
  assert.strictEqual(change.changed, true);
  assert.strictEqual(change.commitState, 'committed');
  const after = fs.readFileSync(agentsPath, 'utf-8');
  assert.ok(after.includes('custom before'));
  assert.ok(after.includes('custom after'));
  assert.strictEqual(after.includes(BEGIN_MARKER), false);
  assert.strictEqual(after.includes(END_MARKER), false);
  const residue = fs.readdirSync(repo).filter((name) => (
    name.includes('tech-persistence-cas-recovery')
      || name.includes('solution-index-migration')
      || name.includes('.install.')
  ));
  assert.deepStrictEqual(residue, []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('codex target does not create AGENTS when the file is absent', () => {
  const repo = makeRepo();
  const agentsPath = path.join(repo, 'AGENTS.md');
  fs.rmSync(agentsPath);

  const result = syncSolutionIndex(repo, { targets: ['codex'] });
  assert.strictEqual(fs.existsSync(agentsPath), false);
  assert.deepStrictEqual(
    result.changes.find((change) => change.target === 'codex'),
    {
      target: 'codex',
      path: agentsPath,
      changed: false,
      migration: 'absent-file',
    }
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

test('codex migration fails closed for missing, repeated, malformed, or out-of-order markers', () => {
  const cases = [
    ['missing end', `${BEGIN_MARKER}\nstale\n`],
    ['missing begin', `${END_MARKER}\n`],
    ['repeated begin', `${BEGIN_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n`],
    ['out of order', `${END_MARKER}\n${BEGIN_MARKER}\n`],
    ['non-exact marker line', ` ${BEGIN_MARKER}\n${END_MARKER}\n`],
  ];

  for (const [name, content] of cases) {
    const repo = makeRepo();
    const agentsPath = path.join(repo, 'AGENTS.md');
    const indexPath = path.join(repo, 'docs', 'solutions', 'index.jsonl');
    fs.writeFileSync(agentsPath, `# Agents\n\ncustom\n${content}`);
    const before = fs.readFileSync(agentsPath, 'utf-8');
    assert.throws(
      () => syncSolutionIndex(repo, { targets: ['codex'] }),
      (error) => error
        && error.code === 'TECH_PERSISTENCE_INVALID_AGENTS_SOLUTION_INDEX'
        && /invalid solution-index managed markers/.test(error.message),
      name
    );
    assert.strictEqual(fs.readFileSync(agentsPath, 'utf-8'), before, name);
    assert.strictEqual(fs.existsSync(indexPath), false, `${name}: canonical index changed before validation`);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('skipRuntimeDocs bypasses AGENTS migration validation and leaves it untouched', () => {
  const repo = makeRepo();
  const agentsPath = path.join(repo, 'AGENTS.md');
  const malformed = `# Agents\n\n${BEGIN_MARKER}\nstale\n`;
  fs.writeFileSync(agentsPath, malformed);

  const result = syncSolutionIndex(repo, {
    targets: ['codex'],
    skipRuntimeDocs: true,
  });
  assert.deepStrictEqual(result.changes.map((change) => change.target), ['index']);
  assert.strictEqual(fs.readFileSync(agentsPath, 'utf-8'), malformed);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('pre-commit solution guard ignores AGENTS-only changes', () => {
  const repo = makeRepo();
  const failures = checkSolutionIndexSync(['AGENTS.md'], repo);
  assert.deepStrictEqual(failures, []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('pre-commit solution guard checks only canonical index and Claude projection', () => {
  const repo = makeRepo();
  copySolutionIndexRuntime(repo);
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  syncSolutionIndex(repo, { targets: ['claude', 'codex'] });
  writeSolution(repo, '2026-05-18-a.md', 'title: "B"\ndate: 2026-05-18\ntags: [solution, beta]', '# B\n\n## Problem\n\nBeta problem.');

  const failures = checkSolutionIndexSync(
    ['docs/solutions/2026-05-18-a.md'],
    repo
  );
  assert.deepStrictEqual(
    failures.map((failure) => failure.path).sort(),
    ['CLAUDE.md', 'docs/solutions/index.jsonl']
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

test('syncSolutionIndex can sync only obsidian projection without touching repo projections', () => {
  const repo = makeRepo();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-obsidian-only-vault-'));
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');

  const claudeBefore = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
  const agentsBefore = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8');

  const result = syncSolutionIndex(repo, {
    obsidianTarget: true,
    obsidianVault: vault,
    projectId: 'proj123',
    projectName: 'tech-persistence',
    skipIndex: true,
    skipRuntimeDocs: true,
  });

  assert.ok(fs.existsSync(path.join(vault, 'projects', 'proj123', 'solutions', '2026-05-18-a.md')));
  assert.strictEqual(fs.existsSync(path.join(repo, 'docs', 'solutions', 'index.jsonl')), false);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8'), claudeBefore);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8'), agentsBefore);
  assert.deepStrictEqual(result.changes.map((change) => change.target), ['obsidian']);

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(vault, { recursive: true, force: true });
});

test('parseArgs supports obsidian-only targets for dirty worktrees', () => {
  const options = parseArgs([
    'node',
    'scripts/sync-solution-index.js',
    '--target',
    'obsidian',
    '--obsidian-vault',
    'shared',
  ]);
  assert.deepStrictEqual(options.targets, []);
  assert.strictEqual(options.obsidianTarget, true);
  assert.strictEqual(options.obsidianVault, 'shared');
  assert.strictEqual(options.skipIndex, true);
  assert.strictEqual(options.skipRuntimeDocs, true);
});

test('parseArgs keeps --all plus obsidian as combined sync targets', () => {
  const options = parseArgs([
    'node',
    'scripts/sync-solution-index.js',
    '--all',
    '--target',
    'obsidian',
    '--obsidian-vault',
    'shared',
  ]);
  assert.deepStrictEqual(options.targets, ['claude', 'codex']);
  assert.strictEqual(options.obsidianTarget, true);
  assert.strictEqual(options.skipIndex, undefined);
  assert.strictEqual(options.skipRuntimeDocs, undefined);
});

test('syncObsidianSolutionProjection mirrors solutions into vault project dir and stays idempotent', () => {
  const repo = makeRepo();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-obsidian-vault-'));
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');
  writeSolution(repo, '2026-05-19-b.md', 'title: "B"\ndate: 2026-05-19\ntags: [solution, beta]', '# B\n\n## Problem\n\nBeta problem.');

  const targetDir = path.join(vault, 'projects', 'proj123', 'solutions');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'stale.md'), '# stale\n');

  const first = syncObsidianSolutionProjection(repo, {
    obsidianVault: vault,
    projectId: 'proj123',
    projectName: 'tech-persistence',
  });

  assert.ok(fs.existsSync(path.join(targetDir, '2026-05-18-a.md')));
  assert.ok(fs.existsSync(path.join(targetDir, '2026-05-19-b.md')));
  assert.ok(!fs.existsSync(path.join(targetDir, 'stale.md')), 'stale projected files should be removed');
  assert.strictEqual(first.written, 2);
  assert.strictEqual(first.removed, 1);
  assert.strictEqual(first.changed, true);
  assert.strictEqual(
    fs.readFileSync(path.join(targetDir, '2026-05-18-a.md'), 'utf-8'),
    fs.readFileSync(path.join(repo, 'docs', 'solutions', '2026-05-18-a.md'), 'utf-8')
  );

  const second = syncObsidianSolutionProjection(repo, {
    obsidianVault: vault,
    projectId: 'proj123',
    projectName: 'tech-persistence',
  });
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.written, 0);
  assert.strictEqual(second.removed, 0);

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(vault, { recursive: true, force: true });
});

test('readRegisteredProject and resolveProjectionProject prefer vault registry match over cwd fallback', () => {
  const repo = makeRepo();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-obsidian-registry-'));
  fs.writeFileSync(
    path.join(vault, 'projects.json'),
    JSON.stringify({
      proj123: {
        name: 'tech-persistence',
        source: 'git-remote',
        path: repo,
      },
    }, null, 2)
  );

  const registered = readRegisteredProject(vault, repo);
  assert.deepStrictEqual(registered, {
    id: 'proj123',
    name: 'tech-persistence',
    source: 'git-remote',
  });

  const resolved = resolveProjectionProject(repo, vault);
  assert.strictEqual(resolved.id, 'proj123');
  assert.strictEqual(resolved.name, 'tech-persistence');

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(vault, { recursive: true, force: true });
});

test('syncObsidianSolutionProjection supports custom project root for desktop mirror targets', () => {
  const repo = makeRepo();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-obsidian-custom-root-'));
  writeSolution(repo, '2026-05-18-a.md', 'title: "A"\ndate: 2026-05-18\ntags: [solution, alpha]', '# A\n\n## Problem\n\nAlpha problem.');

  const result = syncObsidianSolutionProjection(repo, {
    obsidianVault: vault,
    projectId: 'proj123',
    projectName: 'tech-persistence',
    obsidianProjectRoot: '_shared_homunculus/projects',
  });

  const target = path.join(vault, '_shared_homunculus', 'projects', 'proj123', 'solutions', '2026-05-18-a.md');
  assert.strictEqual(result.targetDir, path.dirname(target));
  assert.ok(fs.existsSync(target));

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(vault, { recursive: true, force: true });
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, error }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${error.stack || error.message}`);
  });
  process.exit(1);
}
