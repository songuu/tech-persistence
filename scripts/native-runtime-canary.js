#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const {
  checkRecords,
  runDeterministicCanary,
} = require('./agent-orchestrator/native-runtime-canary');

function usage() {
  console.log([
    'Usage:',
    '  node scripts/native-runtime-canary.js self-test [--artifact-root <empty-dir>]',
    '  node scripts/native-runtime-canary.js run --artifact-root <empty-dir>',
    '  node scripts/native-runtime-canary.js check --file <records.json>',
    '',
    'Modes:',
    '  self-test  Derive and verify deterministic offline contract artifacts.',
    '  run        Persist deterministic artifacts in the requested empty directory.',
    '  check      Validate caller-supplied record fields only; it does not attest provenance.',
  ].join('\n'));
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return argv[index + 1];
}

function assertKnownArguments(argv, allowed) {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    index += 1;
  }
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === 'help' || argv.includes('--help')) {
    usage();
    return;
  }

  if (command === 'check') {
    assertKnownArguments(argv, ['--file']);
    const recordsPath = optionValue(argv, '--file');
    if (!recordsPath) throw new Error('check requires --file <records.json>');
    const file = path.resolve(recordsPath);
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = checkRecords(records);
    console.log(JSON.stringify({
      ...result,
      mode: 'caller-supplied-record-validator',
      evidenceTrust: 'caller-supplied-unverified',
    }));
    return;
  }

  if (command === 'self-test' || command === 'run') {
    assertKnownArguments(argv, ['--artifact-root']);
    const artifactRoot = optionValue(argv, '--artifact-root');
    if (command === 'run' && !artifactRoot) {
      throw new Error('run requires --artifact-root <empty-dir>');
    }
    const result = runDeterministicCanary(
      artifactRoot ? { artifactRoot } : {}
    );
    console.log(JSON.stringify({ ...result, command }));
    return;
  }

  throw new Error('expected command: self-test, run, or check');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { main };
