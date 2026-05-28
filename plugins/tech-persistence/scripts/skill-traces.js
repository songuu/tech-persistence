#!/usr/bin/env node

/**
 * skill-traces.js — CLI for skill failure/correction trace capture.
 *
 * 核心逻辑在 scripts/lib/skill-traces.js（含脱敏）；本文件只管 argv + exit policy。
 *   record — /skill diagnose 从 observations 提取失败 trace，人工确认后结构化追加
 *   list   — /skill improve 读 trace 做根因反思前的预览
 *
 * Exit policy（见 .claude/rules/hook-exit-codes.md）：record/list 是 CLI 工具，
 * 参数/边界错 exit 2（usage）；正常 exit 0；不 crash 调用方主流程。
 */

'use strict';

const lib = require('./lib/skill-traces');
const { resolveBaseDir } = require('./lib/runtime-paths');

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
  process.stderr.write(`[skill-traces] usage error: ${message}\n`);
  process.stderr.write(
    'Usage:\n'
      + '  node scripts/skill-traces.js record --name <n> [--failure-step <s>] [--error-excerpt <s>] [--correction-diff <s>] [--input-excerpt <s>] [--source <s>] [--base-dir <dir>]\n'
      + '  node scripts/skill-traces.js list <name> [--base-dir <dir>]\n'
  );
  process.exit(2);
}

function runRecord(flags) {
  const name = flags.name;
  if (!name) return usageError('record requires --name');
  const baseDir = flags['base-dir'] || resolveBaseDir();
  const input = {
    failure_step: flags['failure-step'],
    error_excerpt: flags['error-excerpt'],
    correction_diff: flags['correction-diff'],
    input_excerpt: flags['input-excerpt'],
    source: flags.source,
  };
  if (
    !input.failure_step && !input.error_excerpt && !input.correction_diff && !input.input_excerpt
  ) {
    return usageError('record requires at least one of --failure-step/--error-excerpt/--correction-diff/--input-excerpt');
  }
  try {
    const { record, traceFile } = lib.recordTrace(name, input, { baseDir });
    process.stdout.write(`[skill-traces] recorded ${name} trace → ${traceFile}\n`);
    if (record.failure_step) process.stdout.write(`  failure_step: ${record.failure_step}\n`);
    process.exit(0);
  } catch (err) {
    return usageError(err.message);
  }
}

function runList(positional, flags) {
  const name = positional[0];
  if (!name) return usageError('list requires <name>');
  if (!lib.SKILL_NAME_RE.test(name)) return usageError(`invalid skill name "${name}"`);
  const baseDir = flags['base-dir'] || resolveBaseDir();
  let records;
  try {
    records = lib.readTraces(name, { baseDir });
  } catch (err) {
    return usageError(err.message);
  }
  process.stdout.write(`[skill-traces] ${name}: ${records.length} trace(s)\n`);
  records.forEach((r, i) => {
    process.stdout.write(`  #${i + 1} ${r.timestamp} ${r.failure_step || r.error_excerpt || '(no summary)'}\n`);
  });
  process.exit(0);
}

function main() {
  const [, , subcommand, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);
  if (subcommand === 'record') return runRecord(flags);
  if (subcommand === 'list') return runList(positional, flags);
  return usageError(`unknown subcommand "${subcommand || ''}"`);
}

main();
