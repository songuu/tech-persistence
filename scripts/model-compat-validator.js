#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_SCHEMA_VERSION = 'codex-model-compat-architecture-evidence-v1';
const EVIDENCE_PREFIX = 'CODEX_MODEL_COMPAT_EVIDENCE=';
const SPRINT_PHASES = Object.freeze(['think', 'plan', 'work', 'review', 'compound']);
const ARCHITECTURE_TESTS = Object.freeze([
  path.join(__dirname, 'test-codex-active-sprint-state.js'),
  path.join(__dirname, 'test-codex-native-skill-projection.js'),
]);

function sanitizedChildEnvironment(source) {
  const clean = {};
  for (const [key, value] of Object.entries(source || {})) {
    const normalized = key.toUpperCase();
    if (normalized === 'NODE_OPTIONS' || normalized === 'NODE_PATH') continue;
    clean[key] = value;
  }
  return clean;
}

function architectureEvidenceMarker() {
  // These values describe repository contracts covered by ARCHITECTURE_TESTS.
  // They are not claims about the active model's live vision or collaboration capabilities.
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sprint: {
      phases: [...SPRINT_PHASES],
      resumeVerified: true,
    },
    fallbackContracts: {
      visionVerified: true,
      collaborationVerified: true,
    },
  };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write('[FAIL] model compatibility validator accepts no arguments or capability claims\n');
    return 2;
  }

  const run = dependencies.spawnSyncImpl || spawnSync;
  const env = sanitizedChildEnvironment(dependencies.env || process.env);
  for (const testPath of ARCHITECTURE_TESTS) {
    const result = run(process.execPath, [testPath], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!result || result.error || result.status !== 0) {
      const reason = result && result.error
        ? `spawn ${result.error.code || result.error.message}`
        : (result && result.signal
          ? `signal ${result.signal}`
          : `exit ${result && Number.isInteger(result.status) ? result.status : 'unknown'}`);
      stderr.write(
        `[FAIL] architecture compatibility test ${path.basename(testPath)}: ${reason}\n`
      );
      return 1;
    }
  }

  stdout.write(`${EVIDENCE_PREFIX}${JSON.stringify(architectureEvidenceMarker())}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ARCHITECTURE_TESTS,
  EVIDENCE_PREFIX,
  EVIDENCE_SCHEMA_VERSION,
  REPO_ROOT,
  architectureEvidenceMarker,
  main,
  sanitizedChildEnvironment,
};