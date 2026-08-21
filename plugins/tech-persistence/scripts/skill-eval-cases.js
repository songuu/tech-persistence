#!/usr/bin/env node

/**
 * skill-eval-cases.js — CLI for sinking native user prompts into structured eval cases.
 *
 * 核心逻辑在 scripts/lib/skill-eval-cases.js（含 canonical journal authority + 脱敏）；
 * 本文件只管 argv + exit policy。
 *   add  — /skill diagnose|eval 把一条真实 UserPromptSubmit 固化为结构化 eval case
 *   list — /skill eval 跑测试前预览并复验当前项目的 case 集
 *
 * 护城河：add 强制 --source-event-ref 指向当前项目 canonical journal 中仍 active 的
 * trusted native user BehaviorEvent；caller JSON snapshot 永远不具备授权能力。
 *
 * Exit policy（见 .claude/rules/hook-exit-codes.md）：add/list 是 CLI 工具，
 * 参数/边界错 exit 2（usage）；正常 exit 0；不 crash 调用方主流程。
 */

'use strict';

const lib = require('./lib/skill-eval-cases');
const { detectStableProjectIdentity } = require('./lib/project-identity');
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
  process.stderr.write(`[skill-eval-cases] usage error: ${message}\n`);
  process.stderr.write(
    'Usage:\n'
      + '  node scripts/skill-eval-cases.js add --name <n> --input <s> --source-event-ref <event_id> [--expectation <s>] [--id <s>] [--tag <s>] [--base-dir <dir>]\n'
      + '  node scripts/skill-eval-cases.js list <name> [--base-dir <dir>]\n'
  );
  process.exit(2);
}

function runAdd(flags) {
  const name = flags.name;
  if (!name) return usageError('add requires --name');
  if (typeof flags.input !== 'string' || !flags.input) {
    return usageError('add requires --input (the triggering input of the case)');
  }
  if (Object.prototype.hasOwnProperty.call(flags, 'from-trace')) {
    return usageError('--from-trace is not accepted; caller JSON cannot authorize an eval case');
  }
  if (typeof flags['source-event-ref'] !== 'string' || !flags['source-event-ref']) {
    return usageError('add requires --source-event-ref <event_id>');
  }
  const baseDir = flags['base-dir'] || resolveBaseDir();
  const input = {
    input: flags.input,
    expectation: typeof flags.expectation === 'string' ? flags.expectation : undefined,
    id: typeof flags.id === 'string' ? flags.id : undefined,
    source_event_ref: flags['source-event-ref'],
    tags: typeof flags.tag === 'string' ? [flags.tag] : undefined,
  };
  try {
    const cwd = process.cwd();
    const project = detectStableProjectIdentity(cwd);
    const { record, casesFile } = lib.addCase(name, input, {
      baseDir,
      projectId: project.id,
      cwd,
    });
    process.stdout.write(`[skill-eval-cases] added ${name} case "${record.id}" → ${casesFile}\n`);
    process.stdout.write(`  input: ${record.input.slice(0, 80)}\n`);
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
    records = lib.readCases(name, { baseDir });
    const cwd = process.cwd();
    const project = detectStableProjectIdentity(cwd);
    lib.verifyCaseAuthorities(records, { baseDir, projectId: project.id, cwd });
  } catch (err) {
    return usageError(err.message);
  }
  process.stdout.write(`[skill-eval-cases] ${name}: ${records.length} case(s) (provenance=behavior_event)\n`);
  records.forEach((r, i) => {
    process.stdout.write(`  #${i + 1} ${r.id} ${r.timestamp} :: ${String(r.input).slice(0, 60)}\n`);
  });
  process.exit(0);
}

function main() {
  const [, , subcommand, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);
  if (subcommand === 'add') return runAdd(flags);
  if (subcommand === 'list') return runList(positional, flags);
  return usageError(`unknown subcommand "${subcommand || ''}"`);
}

main();
