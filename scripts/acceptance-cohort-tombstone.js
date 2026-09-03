#!/usr/bin/env node
'use strict';

const path = require('path');
const evaluator = require('./agent-orchestrator/acceptance-evaluator');

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(argv = process.argv.slice(2)) {
  const workdir = option(argv, '--workdir');
  const runDir = option(argv, '--run-dir');
  const controlRoot = option(argv, '--control-root');
  const broker = option(argv, '--broker');
  const reason = option(argv, '--reason');
  if (!workdir || !runDir || !controlRoot || !broker || !reason) {
    throw new Error(
      'Usage: acceptance-cohort-tombstone --workdir <path> --run-dir <path> '
      + '--control-root <path> --broker <path> '
      + '--reason <operator-abandoned|superseded-before-evaluation>'
    );
  }
  const result = evaluator.recordAcceptanceCohortTombstone({
    workdir: path.resolve(workdir),
    runDir: path.resolve(runDir),
    reason,
    controlStoreOptions: {
      providerRoot: path.resolve(workdir),
      controlRoot: path.resolve(controlRoot),
      cohortTombstoneBrokerPath: path.resolve(broker),
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'written') process.exitCode = 1;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
