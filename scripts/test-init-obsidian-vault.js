#!/usr/bin/env node

'use strict';

/**
 * test-init-obsidian-vault.js — Obsidian vault 接入三方一致性测试
 *
 * 守护 docs/plans/2026-06-01-obsidian-integration-completeness.md 立的 invariant：
 * 三处 source of truth（graph.json colorGroups / Dashboard dataview / 期望的 vault 类）
 * 对每类产出的接入声称必须一致。防止重新引入 rule/architecture 空转配色或漏配 memory。
 *
 * 含 dogfood 负样本：故意注入空转配色 / 漏查询，断言一致性检查能拒。
 */

const assert = require('assert');
const { generateGraphConfig, generateDashboard } = require('./init-obsidian-vault');

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

// 真正写入 vault 的 6 类产出（与 README 接入表、obsidian-setup/usage 文档一致）。
// rule/architecture 是 repo 注入层（.claude/rules/），文件不在 vault，故不在此集合。
const EXPECTED_VAULT_TAGS = ['handoff', 'instinct', 'memory', 'session', 'solution', 'sprint'];

function graphTags(graphConfig) {
  return [...new Set(graphConfig.colorGroups.map((g) => g.query.replace('tag:#', '')))].sort();
}

function dashboardTags(dashboardText) {
  const matches = [...dashboardText.matchAll(/FROM #(\w+)/g)].map((m) => m[1]);
  return [...new Set(matches)].sort();
}

/**
 * 三方一致性检查：返回漂移描述数组（空 = 一致）。
 * @param {object} graphConfig generateGraphConfig() 输出
 * @param {string} dashboardText generateDashboard() 输出
 * @param {string[]} expected 期望的 vault tag 集合
 */
function checkThreeWayConsistency(graphConfig, dashboardText, expected) {
  const drift = [];
  const exp = [...expected].sort();
  const g = graphTags(graphConfig);
  const d = dashboardTags(dashboardText);
  if (JSON.stringify(g) !== JSON.stringify(exp)) {
    drift.push(`graph colorGroups ${JSON.stringify(g)} != expected ${JSON.stringify(exp)}`);
  }
  if (JSON.stringify(d) !== JSON.stringify(exp)) {
    drift.push(`dashboard dataview ${JSON.stringify(d)} != expected ${JSON.stringify(exp)}`);
  }
  return drift;
}

// ─── 正样本：真实生成器三方一致 ───
test('graph colorGroups == 6 vault classes (no rule/architecture空转)', () => {
  const tags = graphTags(generateGraphConfig());
  assert.deepStrictEqual(tags, EXPECTED_VAULT_TAGS);
  assert.ok(!tags.includes('rule'), 'rule 配色应已移除（repo 注入层）');
  assert.ok(!tags.includes('architecture'), 'architecture 配色应已移除（repo 注入层）');
  assert.ok(tags.includes('memory'), 'memory 配色必须存在');
});

test('dashboard dataview queries == 6 vault classes', () => {
  const tags = dashboardTags(generateDashboard());
  assert.deepStrictEqual(tags, EXPECTED_VAULT_TAGS);
});

test('three-way consistency holds for real generators', () => {
  const drift = checkThreeWayConsistency(generateGraphConfig(), generateDashboard(), EXPECTED_VAULT_TAGS);
  assert.deepStrictEqual(drift, [], `unexpected drift: ${drift.join('; ')}`);
});

test('dashboard contains persona quick link', () => {
  assert.ok(/\[\[persona/.test(generateDashboard()), 'Dashboard 应含 persona quick link');
});

// ─── Dogfood 负样本 a：重新引入 rule 空转配色 → 一致性检查必须拒 ───
test('NEG: reintroduced #rule color is flagged as drift', () => {
  const tampered = generateGraphConfig();
  tampered.colorGroups.push({ query: 'tag:#rule', color: { a: 1, rgb: 16744192 } });
  const drift = checkThreeWayConsistency(tampered, generateDashboard(), EXPECTED_VAULT_TAGS);
  assert.ok(drift.length > 0, '注入 #rule 空转配色后应检测到漂移');
  assert.ok(drift.some((d) => d.includes('graph')), '漂移应指向 graph colorGroups');
});

// ─── Dogfood 负样本 b：dashboard 漏一个 memory 查询 → 必须拒 ───
test('NEG: dashboard missing #memory query is flagged as drift', () => {
  const tampered = generateDashboard().replace(/FROM #memory/g, 'FROM #instinct');
  const drift = checkThreeWayConsistency(generateGraphConfig(), tampered, EXPECTED_VAULT_TAGS);
  assert.ok(drift.length > 0, '漏 memory 查询后应检测到漂移');
  assert.ok(drift.some((d) => d.includes('dashboard')), '漂移应指向 dashboard dataview');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
