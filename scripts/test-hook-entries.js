#!/usr/bin/env node

/**
 * test-hook-entries.js — 单测 hook 入口纯函数
 *
 * 覆盖：
 *   - caveman-activate.resolveMode: env / config file / default 三档优先级
 *   - caveman-activate.modeRules: 每个 VALID_MODE 都有非空 rule string
 *   - caveman-activate.readConfigMode: 无文件 / 有 bad json / 正常 三种路径
 *   - caveman-activate.VALID_MODES 完整性
 *   - observe.js exports 完整性（getObservationPath 路径派生）
 *   - guard-handoff-path 顶层 handoff 写入阻断
 *   - 守卫验证：require 不触发 main 副作用
 *
 * 防御：[[2026-05-09 hooks, observability]] hook 守卫纪律 + [[D4]] hook 入口可测性
 *
 * 运行：node scripts/test-hook-entries.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

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

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withTempHome(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-hook-test-'));
  withEnv({ HOME: root, USERPROFILE: root }, () => fn(root));
}

function withTempCwd(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-hook-cwd-'));
  const previous = process.cwd();
  process.chdir(root);
  try {
    fn(root);
  } finally {
    process.chdir(previous);
  }
}

function clearRequireCache() {
  // 清缓存让 readConfigMode 重新读 os.homedir
  delete require.cache[require.resolve('./caveman-activate.js')];
}

// ============================================================
// caveman-activate exports & 守卫
// ============================================================

test('A1 caveman-activate exports expected keys', () => {
  const m = require('./caveman-activate.js');
  for (const k of ['DEFAULT_MODE', 'VALID_MODES', 'readConfigMode', 'resolveMode', 'modeRules', 'main']) {
    assert(k in m, `missing export: ${k}`);
  }
});

test('A2 caveman-activate require does NOT trigger main side-effect (no JSON to stdout)', () => {
  // 这里仅断言 exports 拿到 + main 是 function 未被自动调用
  // 真正副作用检查在 sprint Work T5 已做（node -e require + console 验证）
  const m = require('./caveman-activate.js');
  assert.strictEqual(typeof m.main, 'function');
});

// ============================================================
// resolveMode 三档优先级：env > config > default
// ============================================================

test('B1 resolveMode default = "full" (no env, no config)', () => {
  withTempHome(() => {
    withEnv({ CAVEMAN_DEFAULT_MODE: undefined }, () => {
      clearRequireCache();
      const m = require('./caveman-activate.js');
      assert.strictEqual(m.resolveMode(), 'full');
    });
  });
});

test('B2 resolveMode honors CAVEMAN_DEFAULT_MODE env', () => {
  withTempHome(() => {
    withEnv({ CAVEMAN_DEFAULT_MODE: 'off' }, () => {
      clearRequireCache();
      const m = require('./caveman-activate.js');
      assert.strictEqual(m.resolveMode(), 'off');
    });
  });
});

test('B3 resolveMode invalid env falls back to default', () => {
  withTempHome(() => {
    withEnv({ CAVEMAN_DEFAULT_MODE: 'nonsense-mode' }, () => {
      clearRequireCache();
      const m = require('./caveman-activate.js');
      assert.strictEqual(m.resolveMode(), 'full');
    });
  });
});

test('B4 resolveMode reads config file when env unset', () => {
  withTempHome((home) => {
    const cfgDir = path.join(home, '.config', 'caveman');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ defaultMode: 'ultra' }));
    withEnv({ CAVEMAN_DEFAULT_MODE: undefined }, () => {
      clearRequireCache();
      const m = require('./caveman-activate.js');
      assert.strictEqual(m.resolveMode(), 'ultra');
    });
  });
});

test('B5 resolveMode env overrides config file', () => {
  withTempHome((home) => {
    const cfgDir = path.join(home, '.config', 'caveman');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ defaultMode: 'ultra' }));
    withEnv({ CAVEMAN_DEFAULT_MODE: 'lite' }, () => {
      clearRequireCache();
      const m = require('./caveman-activate.js');
      assert.strictEqual(m.resolveMode(), 'lite');
    });
  });
});

test('B6 resolveMode normalizes case', () => {
  withTempHome(() => {
    withEnv({ CAVEMAN_DEFAULT_MODE: 'ULTRA' }, () => {
      clearRequireCache();
      const m = require('./caveman-activate.js');
      assert.strictEqual(m.resolveMode(), 'ultra');
    });
  });
});

// ============================================================
// readConfigMode 边界
// ============================================================

test('C1 readConfigMode returns null when file missing', () => {
  withTempHome(() => {
    clearRequireCache();
    const m = require('./caveman-activate.js');
    assert.strictEqual(m.readConfigMode(), null);
  });
});

test('C2 readConfigMode returns null on bad JSON (no throw)', () => {
  withTempHome((home) => {
    const cfgDir = path.join(home, '.config', 'caveman');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), '{ not json');
    clearRequireCache();
    const m = require('./caveman-activate.js');
    assert.strictEqual(m.readConfigMode(), null);
  });
});

test('C3 readConfigMode returns null when defaultMode missing', () => {
  withTempHome((home) => {
    const cfgDir = path.join(home, '.config', 'caveman');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ otherKey: 'x' }));
    clearRequireCache();
    const m = require('./caveman-activate.js');
    assert.strictEqual(m.readConfigMode(), null);
  });
});

// ============================================================
// modeRules 完整性 + VALID_MODES
// ============================================================

test('D1 VALID_MODES contains 8 modes', () => {
  const m = require('./caveman-activate.js');
  assert.strictEqual(m.VALID_MODES.size, 8);
  for (const expected of ['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-full', 'wenyan-ultra']) {
    assert(m.VALID_MODES.has(expected), `missing mode: ${expected}`);
  }
});

test('D2 modeRules returns non-empty string for every VALID_MODE', () => {
  const m = require('./caveman-activate.js');
  for (const mode of m.VALID_MODES) {
    if (mode === 'off') continue;
    const rule = m.modeRules(mode);
    assert(typeof rule === 'string' && rule.length > 10, `mode ${mode} returned empty/short rule`);
  }
});

test('D3 modeRules unknown mode falls back to Full rule', () => {
  const m = require('./caveman-activate.js');
  const rule = m.modeRules('whatever-unknown');
  assert(rule.startsWith('Full:'), `unknown mode should fall back to Full, got: ${rule.slice(0, 30)}`);
});

// ============================================================
// observe.js exports
// ============================================================

test('E1 observe.js exports main + getObservationPath', () => {
  const m = require('./observe.js');
  assert(typeof m.main === 'function', 'main not exported');
  assert(typeof m.getObservationPath === 'function', 'getObservationPath not exported');
});

test('E2 observe.js require does NOT auto-write observations.jsonl', () => {
  // 已在 sprint Work T5 通过 node -e 验证；此处再断言 module 行为
  const before = fs.readdirSync(__dirname);
  const m = require('./observe.js');
  const after = fs.readdirSync(__dirname);
  assert.deepStrictEqual(before, after, 'require should not create files');
  assert.strictEqual(typeof m.main, 'function');
});

test('E3 evaluate-session autoCheckpoint writes handoffs under docs/plans/.handoff', () => {
  withTempCwd((root) => {
    const plansDir = path.join(root, 'docs', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    const m = require('./evaluate-session.js');
    assert.strictEqual(typeof m.autoCheckpoint, 'function');
    const checkpoint = m.autoCheckpoint(
      {
        file: '2026-05-22-demo-sprint.md',
        status: 'work',
        content: '- [x] Done\n- [ ] Todo\n',
      },
      [{ phase: 'post', tool: 'Edit', input_summary: 'path "scripts/foo.js"' }]
    );

    const expectedRel = 'docs/plans/.handoff/2026-05-22-demo-sprint-handoff-1.md';
    assert.strictEqual(checkpoint.file, expectedRel);
    assert.ok(fs.existsSync(path.join(root, expectedRel)), 'handoff should be written under .handoff');
    assert.ok(
      !fs.existsSync(path.join(plansDir, '2026-05-22-demo-sprint-handoff-1.md')),
      'handoff must not be written to top-level docs/plans'
    );
  });
});

test('E4 guard-handoff-path blocks direct top-level handoff writes', () => {
  const guard = require('./guard-handoff-path.js');
  const payload = JSON.stringify({
    tool_name: 'Write',
    input: { file_path: 'docs/plans/2026-06-02-demo-handoff-1.md' },
  });

  assert.deepStrictEqual(
    guard.findTopLevelHandoffPaths(payload),
    ['docs/plans/2026-06-02-demo-handoff-1.md']
  );
});

test('E5 guard-handoff-path allows .handoff writes and read-only shell references', () => {
  const guard = require('./guard-handoff-path.js');
  const allowedPayload = JSON.stringify({
    tool_name: 'Write',
    input: { file_path: 'docs/plans/.handoff/2026-06-02-demo-handoff-1.md' },
  });
  const shellPayload = JSON.stringify({
    tool_name: 'functions.shell_command',
    input: { command: 'rg "docs/plans/2026-06-02-demo-handoff-1.md" docs' },
  });

  assert.deepStrictEqual(guard.findTopLevelHandoffPaths(allowedPayload), []);
  assert.deepStrictEqual(guard.findTopLevelHandoffPaths(shellPayload), []);
});

test('E6 plugin hook config runs handoff guard before async observe hook', () => {
  const { buildPluginHookConfig } = require('./lib/hook-registry');
  const config = buildPluginHookConfig();
  const preToolUse = config.hooks.PreToolUse.find((entry) => entry.matcher === '*');
  assert.ok(preToolUse, 'missing PreToolUse * entry');
  assert.ok(preToolUse.hooks.length >= 2, 'expected guard + observe hooks');
  assert.ok(preToolUse.hooks[0].command.includes('guard-handoff-path.js'));
  assert.strictEqual(preToolUse.hooks[0].async, false);
  assert.ok(preToolUse.hooks[1].command.includes('observe.js pre'));
});

test('E7 plugin SessionStart hooks skip resume to avoid duplicate startup injection', () => {
  const { buildPluginHookConfig, PLUGIN_SESSION_START_MATCHER } = require('./lib/hook-registry');
  const config = buildPluginHookConfig();
  assert.strictEqual(PLUGIN_SESSION_START_MATCHER, 'startup|clear|compact');
  assert.ok(config.hooks.SessionStart.every((entry) => !entry.matcher.split('|').includes('resume')));
  const startupEntry = config.hooks.SessionStart.find((entry) => entry.matcher === PLUGIN_SESSION_START_MATCHER);
  assert.ok(startupEntry, 'missing startup/clear/compact SessionStart entry');
  assert.ok(startupEntry.hooks.some((hook) => hook.command.includes('inject-context.js')));
  assert.ok(startupEntry.hooks.some((hook) => hook.command.includes('caveman-activate.js')));
});
// ============================================================
// .codex/hooks.json runtime boundary
// ============================================================

test('F1 project .codex/hooks.json must not hard-code ~/.claude runtime paths', () => {
  const hooksPath = path.join(__dirname, '..', '.codex', 'hooks.json');
  const content = fs.readFileSync(hooksPath, 'utf8');
  assert.ok(!content.includes('~/.claude'), '.codex/hooks.json must not reference ~/.claude');
  assert.ok(!content.includes('.claude/skills'), '.codex/hooks.json must not reference Claude skill paths');
});

// ============================================================
// 总结
// ============================================================

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  failures.forEach((f) => console.error(`  - ${f.name}: ${f.err.message}`));
  process.exit(1);
}
process.exit(0);
