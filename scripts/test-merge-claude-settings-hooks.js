#!/usr/bin/env node

/**
 * test-merge-claude-settings-hooks.js — 单测 hook command 不含 cmd 风格语法
 *
 * 历史背景：Claude Code 在 Windows 上通过 Git Bash 执行 hook command（已踩 2 次：
 * 2026-04-09 + 2026-05-12）。若 hook command 写 cmd 风格 `2>nul || exit /b 0`，
 * 在 bash 中：
 *   - `2>nul` 被解释为重定向到当前目录下名为 `nul` 的真实文件（每次 hook 触发都创建/覆盖）
 *   - `exit /b 0` 是无效语法（但因 || 短路从未执行所以不可见）
 *
 * 本测试是 [[debugging-gotchas]] [2026-05-12 hooks, shell-mismatch] 的回归保护：
 * 对所有 hook command 断言：不含 cmd 风格语法。
 *
 * 运行：node scripts/test-merge-claude-settings-hooks.js
 */

const assert = require('assert');
const { buildClaudeClassicHookSpecs } = require('./lib/hook-registry');

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

// cmd 风格语法（在 bash 中会破坏 hook 行为）
// 加 /i flag 防大小写变体（cmd.exe 不区分大小写，2>NUL / Exit /B / %PATH% 也是 cmd）
const CMD_FORBIDDEN_PATTERNS = [
  { re: /\b2>nul\b/i, desc: '2>nul (creates literal "nul" file in bash)' },
  { re: /\bexit \/b\b/i, desc: 'exit /b (invalid bash syntax)' },
  { re: /\b>nul\b/i, desc: '>nul (cmd redirect; bash will write a "nul" file)' },
  { re: /%[A-Za-z_][A-Za-z0-9_]*%/, desc: '%VAR% (cmd env var; bash uses $VAR)' },
];

function getAllHookCommands(shell) {
  const specs = buildClaudeClassicHookSpecs({
    hookRoot: '/test/hook-root',
    shell,
  });
  const commands = [];
  for (const [hookName, spec] of Object.entries(specs)) {
    if (spec && spec.hook && typeof spec.hook.command === 'string') {
      commands.push({ hookName, command: spec.hook.command });
    }
  }
  return commands;
}

// ============================================================
// shell=windows: 实际生产中 Claude Code 在 Windows 上跑的就是 git-bash
// 因此 windows 模式生成的 command 必须是 POSIX 语法
// ============================================================

test('W1 windows-shell hook commands do NOT contain cmd-style 2>nul', () => {
  const commands = getAllHookCommands('windows');
  assert(commands.length > 0, 'no hook commands returned');
  for (const { hookName, command } of commands) {
    assert(
      !/\b2>nul\b/.test(command),
      `${hookName}: contains "2>nul" (cmd syntax breaks Git Bash): ${command.slice(0, 120)}`
    );
  }
});

test('W2 windows-shell hook commands do NOT contain cmd-style exit /b', () => {
  const commands = getAllHookCommands('windows');
  for (const { hookName, command } of commands) {
    assert(
      !/\bexit \/b\b/.test(command),
      `${hookName}: contains "exit /b" (invalid in bash): ${command.slice(0, 120)}`
    );
  }
});

test('W3 windows-shell hook commands have NO cmd-style forbidden patterns', () => {
  const commands = getAllHookCommands('windows');
  for (const { hookName, command } of commands) {
    for (const { re, desc } of CMD_FORBIDDEN_PATTERNS) {
      assert(!re.test(command), `${hookName}: matches forbidden pattern (${desc}): ${command.slice(0, 120)}`);
    }
  }
});

test('W4 windows-shell hook commands use POSIX null-redirect if any null-redirect present', () => {
  const commands = getAllHookCommands('windows');
  for (const { hookName, command } of commands) {
    if (/null/.test(command)) {
      assert(
        /\/dev\/null/.test(command),
        `${hookName}: uses "null" but not "/dev/null" — likely cmd syntax: ${command.slice(0, 120)}`
      );
    }
  }
});

// ============================================================
// shell=posix: 同样规则（既然两边都跑 bash，行为应一致）
// ============================================================

test('P1 posix-shell hook commands also free of cmd-style syntax', () => {
  const commands = getAllHookCommands('posix');
  assert(commands.length > 0, 'no hook commands returned');
  for (const { hookName, command } of commands) {
    for (const { re, desc } of CMD_FORBIDDEN_PATTERNS) {
      assert(!re.test(command), `${hookName}: matches forbidden pattern (${desc}): ${command.slice(0, 120)}`);
    }
  }
});

// ============================================================
// Sanity: 至少覆盖 4 经典 hook（SessionStart/PreToolUse/PostToolUse/Stop）
// ============================================================

test('S1 buildClaudeClassicHookSpecs returns the 4 classic hooks', () => {
  const specs = buildClaudeClassicHookSpecs({ hookRoot: '/x', shell: 'posix' });
  const names = Object.keys(specs).sort();
  // 至少包含这 4 个；若 registry 扩展了更多 hook 也允许
  const required = ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'];
  for (const r of required) {
    assert(names.includes(r), `missing classic hook: ${r} (got: ${names.join(', ')})`);
  }
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
