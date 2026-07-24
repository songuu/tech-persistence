#!/usr/bin/env node
'use strict';

const {
  advanceActiveSprint,
  blockActiveSprint,
  completeActiveSprint,
  initActiveSprint,
  readActiveSprint,
  sprintStateError,
} = require('./lib/codex-active-sprint');

const COMMAND_OPTIONS = Object.freeze({
  status: new Set(),
  init: new Set(['plan', 'restore-phase', 'next', 'now']),
  advance: new Set(['expected', 'to', 'next', 'now']),
  block: new Set(['expected', 'reason', 'next', 'now']),
  complete: new Set(['expected']),
});

function usage() {
  return [
    'usage:',
    '  codex-active-sprint-state.js status',
    '  codex-active-sprint-state.js init --plan <docs/plans/*.md> [--restore-phase <phase>] --next <action>',
    '  codex-active-sprint-state.js advance --expected <phase> --to <phase> --next <action>',
    '  codex-active-sprint-state.js block --expected <phase> --reason <reason> --next <action>',
    '  codex-active-sprint-state.js complete --expected compound',
  ].join('\n');
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !Object.hasOwn(COMMAND_OPTIONS, argv[0])) {
    throw sprintStateError('INVALID_SPRINT_COMMAND', usage());
  }
  const command = argv[0];
  const allowed = COMMAND_OPTIONS[command];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--') || value === undefined) {
      throw sprintStateError('INVALID_SPRINT_COMMAND', usage());
    }
    const key = flag.slice(2);
    if (!allowed.has(key) || Object.hasOwn(options, key) || String(value).startsWith('--')) {
      throw sprintStateError('INVALID_SPRINT_COMMAND', `invalid or repeated option ${flag}\n${usage()}`);
    }
    options[key] = value;
  }
  return { command, options };
}

function requireOptions(command, options, names) {
  for (const name of names) {
    if (!Object.hasOwn(options, name)) {
      throw sprintStateError('INVALID_SPRINT_COMMAND', `${command} requires --${name}\n${usage()}`);
    }
  }
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const { command, options } = parseArgs(argv);
  if (command === 'status') return readActiveSprint(cwd);
  if (command === 'init') {
    requireOptions(command, options, ['plan', 'next']);
    return initActiveSprint({
      cwd,
      plan: options.plan,
      restorePhase: options['restore-phase'],
      next: options.next,
      now: options.now,
    });
  }
  if (command === 'advance') {
    requireOptions(command, options, ['expected', 'to', 'next']);
    return advanceActiveSprint({
      cwd,
      expectedPhase: options.expected,
      toPhase: options.to,
      next: options.next,
      now: options.now,
    });
  }
  if (command === 'block') {
    requireOptions(command, options, ['expected', 'reason', 'next']);
    return blockActiveSprint({
      cwd,
      expectedPhase: options.expected,
      reason: options.reason,
      next: options.next,
      now: options.now,
    });
  }
  requireOptions(command, options, ['expected']);
  return completeActiveSprint({ cwd, expectedPhase: options.expected });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    const code = error && error.code ? error.code : 'SPRINT_STATE_ERROR';
    process.stderr.write(`[${code}] ${error && error.message ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = { COMMAND_OPTIONS, main, parseArgs, requireOptions, usage };
