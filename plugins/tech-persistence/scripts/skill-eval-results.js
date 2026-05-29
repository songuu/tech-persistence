#!/usr/bin/env node

/**
 * skill-eval-results.js — CLI for skill eval result recording + publish guard.
 *
 * 两个子命令（核心逻辑在 scripts/lib/skill-eval-results.js，本文件只管 argv + exit policy）：
 *   record  — /skill eval 跑完测试集后记录结构化通过率（追加 results.jsonl）
 *   guard   — /skill publish 发布前校验新版未退化（validator，退化 exit 2 拒绝）
 *
 * Exit policy（见 .claude/rules/hook-exit-codes.md）：
 *   guard 是 validator → 退化 exit 2；内部异常 fail-open exit 0 + stderr marker（不锁死 publish）。
 *   record / usage 错 → exit 2（blocking usage error）。
 */

'use strict';

const lib = require('./lib/skill-eval-results');
const { resolveBaseDir } = require('./lib/runtime-paths');

const FAIL_OPEN_MARKER = '[skill-guard] fail-open:';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function usageError(message) {
  process.stderr.write(`[skill-eval-results] usage error: ${message}\n`);
  process.stderr.write(
    'Usage:\n'
      + '  node scripts/skill-eval-results.js record --name <n> --version <N> --pass-rate <0..1> [--cases <json>] [--base-dir <dir>]\n'
      + '  node scripts/skill-eval-results.js guard <name> [--tolerance <0..1>] [--base-dir <dir>]\n'
  );
  process.exit(2);
}

function runRecord(flags) {
  const baseDir = flags['base-dir'] || resolveBaseDir();
  const name = flags.name;
  if (!name) return usageError('record requires --name');
  if (flags.version === undefined) return usageError('record requires --version');
  if (flags['pass-rate'] === undefined) return usageError('record requires --pass-rate');
  let cases;
  if (typeof flags.cases === 'string') {
    try {
      cases = JSON.parse(flags.cases);
    } catch (err) {
      return usageError(`--cases must be valid JSON: ${err.message}`);
    }
  }
  try {
    const { record, resultsFile } = lib.recordResult(name, {
      version: flags.version,
      passRate: flags['pass-rate'],
      cases,
      baseDir,
    });
    process.stdout.write(
      `[skill-eval-results] recorded ${name} v${record.version} pass_rate=${(record.pass_rate * 100).toFixed(1)}% → ${resultsFile}\n`
    );
    process.exit(0);
  } catch (err) {
    // record 是写操作非 validator：参数/边界错按 usage error 暴露给调用方
    return usageError(err.message);
  }
}

function runGuard(positional, flags) {
  const name = positional[0];
  if (!name) return usageError('guard requires <name>');
  if (!lib.SKILL_NAME_RE.test(name)) return usageError(`invalid skill name "${name}"`);
  const baseDir = flags['base-dir'] || resolveBaseDir();
  const tolerance = flags.tolerance !== undefined ? Number(flags.tolerance) : 0;

  let result;
  try {
    result = lib.checkRegression(name, { baseDir, tolerance });
  } catch (err) {
    // fail-open：guard 内部异常绝不锁死用户 publish（exit 0 + marker）
    process.stderr.write(`${FAIL_OPEN_MARKER} ${err.message}\n`);
    process.exit(0);
  }

  if (result.status === 'regression') {
    const { prev, curr } = result;
    process.stderr.write(`[skill-guard] BLOCKED: ${name} 发布退化\n`);
    process.stderr.write(`  ${result.reason}\n`);
    process.stderr.write(`  旧版 v${prev.version} pass_rate=${(prev.pass_rate * 100).toFixed(1)}%\n`);
    process.stderr.write(`  新版 v${curr.version} pass_rate=${(curr.pass_rate * 100).toFixed(1)}%\n`);
    process.stderr.write('修复路径：\n');
    process.stderr.write(`  - 改进提案后重跑 /skill eval ${name} 直到通过率 ≥ ${(prev.pass_rate * 100).toFixed(1)}%\n`);
    process.stderr.write(`  - 或确认这是预期取舍：node scripts/skill-eval-results.js guard ${name} --tolerance <允许下降幅度>\n`);
    process.exit(2);
  }

  if (result.status === 'no-baseline') {
    process.stdout.write(`[skill-guard] PASS: ${name} ${result.reason}\n`);
  } else {
    const { prev, curr, tolerance } = result;
    const currPct = (curr.pass_rate * 100).toFixed(1);
    const prevPct = (prev.pass_rate * 100).toFixed(1);
    if (curr.pass_rate < prev.pass_rate) {
      // 容差放行：新版通过率实际低于旧版，仅因降幅 ≤ tolerance 才通过 →
      // 文案不能谎称 "≥ 旧版"（60% ≥ 90% 是字面失真），必须如实说明是容差吸收
      process.stdout.write(
        `[skill-guard] PASS: ${name} v${curr.version} pass_rate=${currPct}% < 旧版 ${prevPct}%，降幅在容差 ${(tolerance * 100).toFixed(1)}% 内，放行\n`
      );
    } else {
      process.stdout.write(
        `[skill-guard] PASS: ${name} v${curr.version} pass_rate=${currPct}% ≥ 旧版 ${prevPct}%\n`
      );
    }
  }
  process.exit(0);
}

function main() {
  const [, , subcommand, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);
  if (subcommand === 'record') return runRecord(flags);
  if (subcommand === 'guard' || subcommand === 'check') return runGuard(positional, flags);
  return usageError(`unknown subcommand "${subcommand || ''}"`);
}

main();
