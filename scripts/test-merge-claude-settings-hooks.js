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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  HOOK_TARGETS,
  buildClaudeClassicHookSpecs,
  buildPluginHookConfig,
  getHookScriptNames,
  getHookSettingsExpectations,
} = require('./lib/hook-registry');
const { inspectSettingsHookIssues } = require('./validate-claude-install');
const {
  PROMPT_RECEIPT_LOCK_RETRY_TIMEOUT_MS,
} = require('./lib/self-learning-store');

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

test('W5 classic hooks keep fail-open fallback while preserving bounded stderr diagnostics', () => {
  const commands = getAllHookCommands('windows');
  for (const { hookName, command } of commands) {
    assert.match(command, /\|\|\s*true\s*$/, `${hookName}: missing fail-open fallback`);
    assert(!command.includes('2>/dev/null'), `${hookName}: stderr diagnostics are swallowed`);
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
// Sanity: 精确覆盖 5 个自学习经典 hook（含 UserPromptSubmit 记忆召回）
// ============================================================

test('S1 buildClaudeClassicHookSpecs returns the 5 required classic hooks', () => {
  const specs = buildClaudeClassicHookSpecs({ hookRoot: '/x', shell: 'posix' });
  const names = Object.keys(specs).sort();
  const required = ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'];
  assert.deepStrictEqual(names, required);
  assert.match(specs.UserPromptSubmit.hook.command, /prompt-submit\.js/);
});

test('S1a hook registry uses Claude timeout seconds with bounded lifecycle budgets', () => {
  const classic = buildClaudeClassicHookSpecs({ hookRoot: '/x', shell: 'posix' });
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(classic).map(([event, spec]) => [event, spec.hook.timeout])),
    {
      SessionStart: 5,
      UserPromptSubmit: 5,
      PreToolUse: 2,
      PostToolUse: 2,
      Stop: 10,
    }
  );

  const plugin = buildPluginHookConfig();
  const timeouts = Object.values(plugin.hooks)
    .flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.timeout)));
  assert(timeouts.length > 0);
  assert(timeouts.every((timeout) => [2, 5, 10].includes(timeout)), JSON.stringify(timeouts));
  assert(
    PROMPT_RECEIPT_LOCK_RETRY_TIMEOUT_MS < classic.UserPromptSubmit.hook.timeout * 1000,
    'prompt receipt lock retry must finish before the host timeout'
  );
});

test('S1b installer and install validator consume the same five-hook classic authority', () => {
  const expectations = getHookSettingsExpectations(HOOK_TARGETS.CLAUDE_CLASSIC);
  assert.deepStrictEqual(
    expectations.map((entry) => entry.event).sort(),
    ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']
  );
  assert(getHookScriptNames(HOOK_TARGETS.CLAUDE_CLASSIC).includes('prompt-submit.js'));

  const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  assert.match(installer, /getHookScriptNames\(r\.HOOK_TARGETS\.CLAUDE_CLASSIC\)/);
  const validator = fs.readFileSync(path.join(__dirname, 'validate-claude-install.js'), 'utf8');
  assert.match(validator, /getHookSettingsExpectations\(HOOK_TARGETS\.CLAUDE_CLASSIC\)/);
  assert.match(validator, /getHookScriptNames\(HOOK_TARGETS\.CLAUDE_CLASSIC\)/);
});

test('S1c install validator rejects matching commands with legacy millisecond timeouts', () => {
  const expectations = getHookSettingsExpectations(HOOK_TARGETS.CLAUDE_CLASSIC);
  assert(expectations.every((entry) => Number.isInteger(entry.timeout)));
  assert.deepStrictEqual(
    Object.fromEntries(expectations.map((entry) => [entry.event, entry.timeout])),
    { SessionStart: 5, UserPromptSubmit: 5, PreToolUse: 2, PostToolUse: 2, Stop: 10 }
  );
  const settings = buildClaudeClassicHookSpecs({ hookRoot: '/installed/hooks', shell: 'posix' });
  const hooks = Object.fromEntries(Object.entries(settings).map(([event, spec]) => [event, [{
    matcher: spec.matcher,
    hooks: [spec.hook],
  }]]));
  assert.deepStrictEqual(inspectSettingsHookIssues({ hooks }), []);
  hooks.UserPromptSubmit[0].hooks[0].timeout = 1800;
  assert.deepStrictEqual(
    inspectSettingsHookIssues({ hooks }).map((issue) => ({
      code: issue.code,
      event: issue.expected.event,
      timeout: issue.expected.timeout,
    })),
    [{ code: 'wrong-timeout', event: 'UserPromptSubmit', timeout: 5 }]
  );
});

test('S2 merge CLI diagnostics never echo attacker-controlled error values', () => {
  const secret = 'merge-diagnostic-secret-92387';
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'merge-claude-settings-hooks.js'),
    `--unknown-${secret}`,
  ], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(result.status, 1);
  assert(result.stderr.length > 0 && result.stderr.length <= 512);
  assert(!result.stderr.includes(secret), result.stderr);
});

test('S3 merge upgrades installed managed hooks that previously swallowed stderr', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-merge-classic-hooks-'));
  const settingsPath = path.join(root, 'settings.json');
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{
            type: 'command',
            command: 'node "/installed/hooks/inject-context.js" 2>/dev/null || true',
            timeout: 5000,
          }],
        }],
      },
    }));
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'merge-claude-settings-hooks.js'),
      settingsPath,
      '--hook-root',
      '/installed/hooks',
      '--shell',
      'posix',
    ], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(result.status, 0, result.error && result.error.message || result.stderr);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepStrictEqual(
      Object.keys(settings.hooks).sort(),
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']
    );
    const commands = Object.values(settings.hooks).flatMap((entries) => (
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command))
    ));
    assert(commands.every((command) => !command.includes('2>/dev/null')));
    assert(commands.every((command) => /\|\|\s*true\s*$/.test(command)));
    const installedTimeouts = Object.fromEntries(Object.entries(settings.hooks).map(
      ([event, entries]) => [event, entries.flatMap((entry) => entry.hooks)[0].timeout]
    ));
    assert.deepStrictEqual(installedTimeouts, {
      SessionStart: 5,
      UserPromptSubmit: 5,
      PreToolUse: 2,
      PostToolUse: 2,
      Stop: 10,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
