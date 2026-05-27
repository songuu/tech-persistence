#!/usr/bin/env node

/**
 * test-memory-recall-telemetry.js
 *
 * Self-contained tests for aggregate Memory v5 recall telemetry.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  buildMemoryRecallMetric,
  detectProjectIdentity,
  recordMemoryRecallMetric,
  writeMemoryRecallMetric,
} = require('./lib/memory-v5');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTopic(memoryDir, topic, entries) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const lines = [`# ${topic}`, ''];
  entries.forEach((entry) => {
    lines.push(`<!-- memory:v5:${entry.id} -->`);
    lines.push(`- ${entry.date} [${entry.confidence}] ${entry.body}`);
    lines.push('');
  });
  fs.writeFileSync(path.join(memoryDir, `${topic}.md`), lines.join('\n'));
}

test('buildMemoryRecallMetric records aggregate counts only', () => {
  const root = makeTempDir('tp-memory-recall-');
  const memoryDir = path.join(root, 'memory');
  writeTopic(memoryDir, 'security', [
    { id: 'aaa111', date: '2026-05-27', confidence: 0.9, body: 'redact private tags' },
    { id: 'bbb222', date: '2026-05-26', confidence: 0.8, body: 'do not leak body text' },
  ]);
  writeTopic(memoryDir, 'workflow', [
    { id: 'ccc333', date: '2026-05-25', confidence: 0.7, body: 'run tests' },
  ]);

  const metric = buildMemoryRecallMetric([memoryDir], { maxIndexEntries: 1 }, {
    project: { id: 'proj', name: 'Project' },
    timestamp: '2026-05-27T00:00:00.000Z',
    prioritizeTopics: ['security'],
  });

  assert.strictEqual(metric.project_id, 'proj');
  assert.strictEqual(metric.topic_count, 2);
  assert.strictEqual(metric.topic_file_count, 2);
  assert.strictEqual(metric.total_entries, 3);
  assert.strictEqual(metric.indexed_entries, 1);
  assert.strictEqual(metric.hit_rate, 0.3333);
  assert.ok(metric.total_bytes > 0);
  const serialized = JSON.stringify(metric);
  assert.ok(!serialized.includes('redact private tags'));
  assert.ok(!serialized.includes('do not leak body text'));
});

test('recordMemoryRecallMetric appends JSONL telemetry', () => {
  const root = makeTempDir('tp-memory-recall-record-');
  const memoryDir = path.join(root, 'memory');
  const telemetryDir = path.join(root, 'telemetry');
  writeTopic(memoryDir, 'architecture', [
    { id: 'ddd444', date: '2026-05-27', confidence: 0.9, body: 'deterministic markdown' },
  ]);

  const { outputPath, metric } = recordMemoryRecallMetric([memoryDir], {}, {
    project: { id: 'proj', name: 'Project' },
    telemetryDir,
  });

  assert.strictEqual(outputPath, path.join(telemetryDir, 'memory-recall.jsonl'));
  const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf-8').trim());
  assert.strictEqual(parsed.total_entries, metric.total_entries);
  assert.strictEqual(parsed.hit_rate, 1);
});

test('writeMemoryRecallMetric is a no-op without telemetryDir', () => {
  const result = writeMemoryRecallMetric({ ok: true }, null);
  assert.strictEqual(result, null);
});

test('inject-context records recall telemetry during SessionStart', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const home = makeTempDir('tp-memory-recall-inject-');
  const project = detectProjectIdentity(repoRoot);
  const memoryDir = path.join(home, 'projects', project.id, 'memory');
  writeTopic(memoryDir, 'security', [
    { id: 'eee555', date: '2026-05-27', confidence: 0.9, body: 'privacy tag stripping' },
  ]);

  const result = spawnSync(process.execPath, [path.join(__dirname, 'inject-context.js')], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'),
      TECH_PERSISTENCE_HOME: home,
      TECH_PERSISTENCE_RUNTIME: 'claude',
      CLAUDE_SESSION_ID: 'test-memory-recall-session',
    },
  });

  assert.strictEqual(result.status, 0, result.stderr);
  const telemetryPath = path.join(home, 'telemetry', 'memory-recall.jsonl');
  assert.ok(fs.existsSync(telemetryPath), 'expected telemetry file');
  const parsed = JSON.parse(fs.readFileSync(telemetryPath, 'utf-8').trim().split(/\r?\n/).pop());
  assert.strictEqual(parsed.project_id, project.id);
  assert.strictEqual(parsed.total_entries, 1);
  assert.ok(!JSON.stringify(parsed).includes('privacy tag stripping'));
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${err.stack || err.message}`);
  });
  process.exit(1);
}
