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
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  generateGraphConfig,
  mergeGraphColorGroups,
  generateDashboard,
  SYNC_EXCLUDES,
  excludesForTarget,
  generateUserIgnores,
  generateGitignore,
  generateStignore,
  upsertIgnoreFile,
} = require('./init-obsidian-vault');

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

// ─── 存在即刷新：mergeGraphColorGroups 保留布局偏好，只替换 colorGroups ───
test('merge refreshes colorGroups to canonical (drift fix)', () => {
  // 模拟用户 vault 里过期的 graph.json（含 #rule 空转 + 漏 memory + 自定义布局）
  const stale = {
    scale: 2.5,
    repelStrength: 42,
    customUserField: 'keep-me',
    colorGroups: [
      { query: 'tag:#instinct', color: { a: 1, rgb: 5373645 } },
      { query: 'tag:#rule', color: { a: 1, rgb: 16744192 } },
    ],
  };
  const merged = mergeGraphColorGroups(stale);
  // colorGroups 刷新为 canonical（6 类，无 rule）
  assert.deepStrictEqual(graphTags(merged), EXPECTED_VAULT_TAGS);
  // 用户布局偏好原样保留
  assert.strictEqual(merged.scale, 2.5, 'scale 布局偏好应保留');
  assert.strictEqual(merged.repelStrength, 42, 'repelStrength 布局偏好应保留');
  assert.strictEqual(merged.customUserField, 'keep-me', '未知用户字段应保留');
});

test('merge is idempotent on canonical config (no junk .bak)', () => {
  const canonical = generateGraphConfig();
  const merged = mergeGraphColorGroups(canonical);
  // 幂等：canonical 再 merge 应字节一致，安装器据此跳过写入、不产生备份
  assert.strictEqual(JSON.stringify(merged), JSON.stringify(canonical));
});

// ─── 跨设备同步排除：单一事实源 + 三投影（docs/solutions/2026-06-02-obsidian-cross-device.md）───

// 提取 ignore 文本里的规则行（去掉 # / // 注释和空行）。
function ignorePatterns(text) {
  return text
    .split('\n')
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
}

// 跨设备同步的高危项：文件级同步会丢数据或损坏 vault。任一从 canonical 漏掉即数据安全回归。
const HIGH_SEVERITY = ['*.jsonl', '.agent-runs/'];

test('SYNC_EXCLUDES 覆盖所有高危项（漏一个 = 数据安全回归）', () => {
  const patterns = SYNC_EXCLUDES.map((e) => e.pattern);
  for (const critical of HIGH_SEVERITY) {
    assert.ok(patterns.includes(critical), `高危项 ${critical} 必须在 SYNC_EXCLUDES 中`);
  }
});

test('.gitignore 排除 jsonl/.agent-runs/workspace，且不含无意义的 .git/', () => {
  const rules = ignorePatterns(generateGitignore());
  assert.ok(rules.includes('*.jsonl'), 'git 同步必须排除 append-only jsonl（丢行）');
  assert.ok(rules.includes('.agent-runs/'), 'git 同步必须排除运行态目录');
  assert.ok(rules.includes('.obsidian/workspace.json'), 'git 同步必须排除高频重写的 workspace.json');
  assert.ok(rules.includes('.obsidian/workspace-mobile.json'), 'git 同步必须排除移动端 workspace');
  // .gitignore 里列 .git/ 无意义（git 永不追踪自身），故 git 投影不含它
  assert.ok(!rules.includes('.git/'), '.gitignore 不应列 .git/（git 语义下无意义）');
});

test('.stignore 排除 .git/（Syncthing 文件级同步会损坏 refs）+ jsonl + 运行态', () => {
  const rules = ignorePatterns(generateStignore());
  assert.ok(rules.includes('.git/'), 'Syncthing 必须排除 .git/ 防 refs 损坏');
  assert.ok(rules.includes('*.jsonl'), 'Syncthing 必须排除 jsonl');
  assert.ok(rules.includes('.agent-runs/'), 'Syncthing 必须排除运行态目录');
});

test('.obsidianignore 向后兼容：原有 5 条规则全部保留', () => {
  const rules = ignorePatterns(generateUserIgnores());
  for (const legacy of ['*.jsonl', 'archive/', 'node_modules/', '.git/', '*.bak.*']) {
    assert.ok(rules.includes(legacy), `.obsidianignore 必须保留历史规则 ${legacy}（merge 向后兼容）`);
  }
});

// 有判别力的反向 invariant：高危项不得从任一"同步" projection 漏掉。
// （"投影⊆canonical" 由 excludesForTarget 的 filter+map 实现构造保证，恒真无信号，故不测。）
// 这条会在有人误把某高危 entry 的 git/syncthing target 删掉时 fail——正是本 sprint 要防的数据安全回归。
test('高危项不得从 git / syncthing 任一同步投影漏掉（per-target）', () => {
  for (const target of ['git', 'syncthing']) {
    const projection = excludesForTarget(target);
    for (const critical of HIGH_SEVERITY) {
      assert.ok(
        projection.includes(critical),
        `${target} 同步投影必须含高危项 ${critical}（漏掉 = 数据安全回归）`
      );
    }
  }
});

// upsertIgnoreFile 合并行为：existing 含子串行 / 注释提及时，高危规则仍必须被追加（守 P1 修复，防子串误匹配回归）。
test('upsertIgnoreFile：existing 含子串/注释不致漏补高危规则 + 幂等', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-ignore-'));
  try {
    const filename = '.stignore';
    const target = path.join(tmpDir, filename);
    // 故意构造会让子串匹配误判的 existing：'logs/*.jsonl.bak' 含 '*.jsonl'，注释提到 '.git/'
    fs.writeFileSync(target, ['logs/*.jsonl.bak', '// my notes about .git/ internals', 'archive/'].join('\n') + '\n');
    upsertIgnoreFile(tmpDir, filename, generateStignore());
    const after = fs.readFileSync(target, 'utf-8');
    const rules = new Set(
      after.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
    );
    assert.ok(rules.has('*.jsonl'), '*.jsonl 不能被 logs/*.jsonl.bak 子串吞没而漏补');
    assert.ok(rules.has('.git/'), '.git/ 不能被注释行子串命中而漏补');
    assert.ok(rules.has('.agent-runs/'), '.agent-runs/ 必须补上');
    // 幂等：完整后二次运行不再追加
    const before2 = fs.readFileSync(target, 'utf-8');
    upsertIgnoreFile(tmpDir, filename, generateStignore());
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), before2, '二次 upsert 应幂等不追加');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
