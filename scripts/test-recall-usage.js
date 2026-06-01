#!/usr/bin/env node

/**
 * test-recall-usage.js — recall-usage.js 自包含单元测试
 *
 * 覆盖：sanitize/命名、domain 去重、manifest 读写 round-trip + fallback + 损坏跳过、
 * 启发式 inferSessionDomains、usage 计算、metric 组装 + 脱敏、append/readLatest fail-open。
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeSessionId,
  manifestFileName,
  dedupeDomains,
  normalizeManifest,
  writeInjectedManifest,
  readInjectedManifest,
  inferSessionDomains,
  computeDemandSideUsage,
  buildRecallUsageMetric,
  recordRecallUsage,
  readLatestRecallUsage,
  MANIFEST_LATEST,
} = require('./lib/recall-usage');

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

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('sanitizeSessionId strips path-escape chars + bounds length', () => {
  assert.strictEqual(sanitizeSessionId('../../etc/passwd'), '______etc_passwd');
  assert.strictEqual(sanitizeSessionId('abc-123_XY'), 'abc-123_XY');
  assert.strictEqual(sanitizeSessionId(''), '');
  assert.strictEqual(sanitizeSessionId(null), '');
  assert.strictEqual(sanitizeSessionId('a'.repeat(200)).length, 120);
});

test('manifestFileName uses sid or latest fallback', () => {
  assert.strictEqual(manifestFileName('sess1'), 'injected-sess1.json');
  assert.strictEqual(manifestFileName(''), MANIFEST_LATEST);
  assert.strictEqual(manifestFileName('../x'), 'injected-___x.json'); // 3 chars (. . /) → 3 underscores
});

test('dedupeDomains lowercases, dedupes, sorts, drops empty', () => {
  assert.deepStrictEqual(dedupeDomains(['Git', 'git', '  Testing ', '']), ['git', 'testing']);
  assert.deepStrictEqual(dedupeDomains(null), []);
  assert.deepStrictEqual(dedupeDomains(['b', 'a']), ['a', 'b']);
});

test('normalizeManifest fills defaults + dedupes domains', () => {
  const m = normalizeManifest({ session_id: 's', injected_domains: ['A', 'a'], injected_instinct_count: 3 });
  assert.strictEqual(m.schema, 'recall-usage-manifest/v1');
  assert.deepStrictEqual(m.injected_domains, ['a']);
  assert.strictEqual(m.injected_instinct_count, 3);
  const empty = normalizeManifest(null);
  assert.deepStrictEqual(empty.injected_domains, []);
  assert.strictEqual(empty.injected_instinct_count, 0);
  assert.strictEqual(empty.session_id, '');
});

test('writeInjectedManifest + readInjectedManifest round-trip by sid', () => {
  const dir = tmp('ru-manifest-');
  writeInjectedManifest(dir, {
    session_id: 'sx', project_id: 'p', injected_domains: ['git', 'testing'], injected_instinct_count: 2,
  });
  assert.ok(fs.existsSync(path.join(dir, 'injected-sx.json')));
  assert.ok(fs.existsSync(path.join(dir, MANIFEST_LATEST)));
  const read = readInjectedManifest(dir, 'sx');
  assert.deepStrictEqual(read.injected_domains, ['git', 'testing']);
  assert.strictEqual(read.project_id, 'p');
});

test('readInjectedManifest falls back to latest when sid file missing', () => {
  const dir = tmp('ru-manifest-fb-');
  writeInjectedManifest(dir, {
    session_id: '', project_id: 'p', injected_domains: ['workflow'], injected_instinct_count: 1,
  });
  const read = readInjectedManifest(dir, 'nonexistent-sid');
  assert.deepStrictEqual(read.injected_domains, ['workflow']);
});

test('readInjectedManifest returns null on missing dir/file + skips corrupt', () => {
  const dir = tmp('ru-manifest-corrupt-');
  assert.strictEqual(readInjectedManifest(dir, 'x'), null);
  fs.writeFileSync(path.join(dir, MANIFEST_LATEST), '{not json');
  assert.strictEqual(readInjectedManifest(dir, 'x'), null);
  assert.strictEqual(readInjectedManifest(null, 'x'), null);
});

test('inferSessionDomains maps observations to wide domain set', () => {
  const obs = [
    { phase: 'post', tool: 'Bash', command: 'git push' },
    { phase: 'post', tool: 'Bash', command: 'npm run build' },
    { phase: 'post', tool: 'Bash', command: 'pytest tests/' },
    { phase: 'post', tool: 'Edit', input_paths: ['src/a.ts'] },
    { phase: 'post', tool: 'Read', input_paths: ['.claude/rules/architecture.md'] },
    { phase: 'post', tool: 'Bash', command: 'node secret-scan.js', input_paths: ['.env'] },
    { phase: 'post', tool: 'Bash', command: 'echo hi', error_signal: true },
  ];
  const domains = inferSessionDomains(obs);
  ['git', 'toolchain', 'testing', 'code-style', 'architecture', 'security', 'debugging', 'workflow']
    .forEach((d) => assert.ok(domains.includes(d), `expected ${d} in ${JSON.stringify(domains)}`));
});

test('inferSessionDomains handles empty / non-array; any obs yields workflow', () => {
  assert.deepStrictEqual(inferSessionDomains([]), []);
  assert.deepStrictEqual(inferSessionDomains(null), []);
  assert.ok(inferSessionDomains([{ phase: 'post', tool: 'Read' }]).includes('workflow'));
});

test('computeDemandSideUsage computes used/dormant/rate', () => {
  const u = computeDemandSideUsage(['git', 'testing', 'security'], ['git', 'testing', 'workflow']);
  assert.strictEqual(u.injected_domain_count, 3);
  assert.strictEqual(u.used_domain_count, 2);
  assert.deepStrictEqual(u.used_domains, ['git', 'testing']);
  assert.deepStrictEqual(u.dormant_domains, ['security']);
  assert.strictEqual(u.usage_rate, 0.6667);
});

test('computeDemandSideUsage empty injected → usage_rate null', () => {
  const u = computeDemandSideUsage([], ['git']);
  assert.strictEqual(u.injected_domain_count, 0);
  assert.strictEqual(u.usage_rate, null);
  assert.deepStrictEqual(u.dormant_domains, []);
});

test('buildRecallUsageMetric assembles metric from manifest + observations', () => {
  const obs = [{ phase: 'post', tool: 'Bash', command: 'git commit' }];
  const m = buildRecallUsageMetric({
    project: { id: 'pid' },
    sessionId: 'sid',
    manifest: { injected_domains: ['git', 'security'], injected_instinct_count: 2 },
    observations: obs,
    timestamp: '2026-06-01T00:00:00Z',
  });
  assert.strictEqual(m.schema, 'recall-usage/v1');
  assert.strictEqual(m.project_id, 'pid');
  assert.strictEqual(m.manifest_found, true);
  assert.strictEqual(m.observation_count, 1);
  assert.ok(m.used_domains.includes('git'));
  assert.ok(m.dormant_domains.includes('security'));
});

test('buildRecallUsageMetric handles null manifest gracefully', () => {
  const m = buildRecallUsageMetric({
    project: { id: 'p' }, sessionId: 's', manifest: null, observations: [], timestamp: 't',
  });
  assert.strictEqual(m.manifest_found, false);
  assert.strictEqual(m.injected_domain_count, 0);
  assert.strictEqual(m.usage_rate, null);
});

test('buildRecallUsageMetric strips private tags (defense-in-depth)', () => {
  const m = buildRecallUsageMetric({
    project: { id: 'p' },
    sessionId: 's',
    manifest: { injected_domains: ['<private>leaked-secret</private>x'], injected_instinct_count: 1 },
    observations: [{ phase: 'post', tool: 'Read' }],
    timestamp: 't',
  });
  assert.ok(!JSON.stringify(m).includes('leaked-secret'), 'private content must be redacted');
});

test('recordRecallUsage appends + readLatestRecallUsage reads last', () => {
  const dir = tmp('ru-record-');
  recordRecallUsage(dir, { schema: 'recall-usage/v1', usage_rate: 0.5, seq: 1 });
  recordRecallUsage(dir, { schema: 'recall-usage/v1', usage_rate: 0.8, seq: 2 });
  const latest = readLatestRecallUsage(dir);
  assert.strictEqual(latest.seq, 2);
  assert.strictEqual(latest.usage_rate, 0.8);
});

test('readLatestRecallUsage skips corrupt trailing lines + handles missing', () => {
  const dir = tmp('ru-record-corrupt-');
  assert.strictEqual(readLatestRecallUsage(dir), null);
  fs.writeFileSync(path.join(dir, 'recall-usage.jsonl'), '{"seq":1}\n{bad json\n');
  const latest = readLatestRecallUsage(dir);
  assert.strictEqual(latest.seq, 1);
  assert.strictEqual(readLatestRecallUsage(null), null);
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
