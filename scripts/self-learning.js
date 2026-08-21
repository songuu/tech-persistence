#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const { executeLearningAction } = require('./lib/self-learning-service');

const MAX_INPUT_BYTES = 1024 * 1024;
const ACTIONS = new Set([
  'record',
  'evidence',
  'close',
  'propose',
  'evaluate',
  'shadow',
  'approve',
  'promote',
  'inspect',
  'context',
  'metrics',
  'govern',
  'retention',
  'verify-store',
]);
const INPUT_OPTIONAL = new Set(['inspect', 'context', 'metrics', 'verify-store']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!key) throw new Error('empty flag is not allowed');
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/self-learning.js <action> --base-dir <dir> --project-id <id> [candidate-id] [--input <file|->]',
    '',
    `Actions: ${[...ACTIONS].join(', ')}`,
    '',
    'Write actions require a JSON object from --input.',
    'Generic CLI record writes weak agent observations; trusted user events require native host capture.',
    'Generic CLI evidence is rejected; authoritative EvidenceRef capture is native-host only.',
    'Approval is a separate user.approval BehaviorEvent from that trusted capture path.',
    'delete means an auditable tombstone; this command never performs physical purge.',
  ].join('\n');
}

function readInput(source) {
  if (!source) return {};
  let raw;
  if (source === '-') {
    raw = fs.readFileSync(0, 'utf8');
  } else {
    const file = path.resolve(source);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`input must be a plain JSON file: ${file}`);
    }
    if (stat.size > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    raw = fs.readFileSync(file, 'utf8');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`input is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('input JSON must be an object');
  }
  return parsed;
}

function safeResult(value) {
  return JSON.parse(JSON.stringify(value));
}

function run(argv) {
  const { positional, flags } = parseArgs(argv);
  const action = positional[0];
  if (action === 'help' || flags.help === true) return { help: usage() };
  if (!ACTIONS.has(action)) throw new Error(`unknown action "${action || ''}"\n${usage()}`);
  if (typeof flags['base-dir'] !== 'string') throw new Error('--base-dir is required');
  if (typeof flags['project-id'] !== 'string') throw new Error('--project-id is required');
  if (!INPUT_OPTIONAL.has(action) && typeof flags.input !== 'string') {
    throw new Error(`${action} requires --input <file|->`);
  }
  const input = readInput(typeof flags.input === 'string' ? flags.input : null);
  const candidateId = flags['candidate-id'] || positional[1] || input.candidate_id;
  if (['evaluate', 'shadow', 'approve', 'promote'].includes(action) && !candidateId) {
    throw new Error(`${action} requires candidate-id positional or --candidate-id`);
  }
  if (action === 'govern' && input.entity_id == null && !candidateId) {
    throw new Error('govern requires candidate-id or input.entity_id');
  }
  const result = executeLearningAction(action, {
    base_dir: flags['base-dir'],
    project_id: flags['project-id'],
    candidate_id: candidateId,
    input,
  }, {
    require_explicit_base_dir: true,
    // This generic JSON CLI is caller-controlled. Native host adapters call the
    // service directly and remain the only trusted capture path.
    entrypoint: 'cli',
  });
  return safeResult(result);
}

function main(argv = process.argv.slice(2)) {
  try {
    const result = run(argv);
    if (result.help) {
      process.stdout.write(`${result.help}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    const code = error && error.code ? `${error.code}: ` : '';
    process.stderr.write(`[self-learning] ${code}${error.message || error}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  ACTIONS,
  MAX_INPUT_BYTES,
  main,
  parseArgs,
  readInput,
  run,
  usage,
};
