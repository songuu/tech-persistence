#!/usr/bin/env node

/**
 * CLI for hash-bound skill eval result recording and fail-closed publish guard.
 *
 * Exit policy:
 *   0 — guard status is exactly "ok", or record completed with readback-safe data.
 *   2 — usage error, blocked/regression guard, malformed store, or internal error.
 */

'use strict';

const lib = require('./lib/skill-eval-results');
const { resolveBaseDir } = require('./lib/runtime-paths');
const { detectStableProjectIdentity, findGitRoot } = require('./lib/project-identity');
const {
  assertActionEnabled,
  resolveLearningContext,
} = require('./lib/self-learning-service');

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
      + '  node scripts/skill-eval-results.js record --name <n> --version <N>\n'
      + '    --candidate-id <lc-id> [--artifact-path <canonical-artifact.md>]\n'
      + '  node scripts/skill-eval-results.js guard <name> [--tolerance <0..1>]\n'
  );
  process.exit(2);
}

function requireStringFlag(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key]) {
    usageError(`record requires --${key}`);
  }
  return flags[key];
}

function assertAllowedFlags(flags, allowed, command) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(flags).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) usageError(`${command} has unknown flag(s): ${unknown.join(', ')}`);
}

function trustedRepoRoot() {
  const root = findGitRoot(process.cwd());
  if (!root) throw new Error('current working directory is not inside a trusted Git repository');
  return root;
}

function runRecord(flags) {
  assertAllowedFlags(flags, [
    'name', 'version', 'candidate-id', 'artifact-path',
  ], 'record');
  const baseDir = resolveBaseDir();
  const projectId = detectStableProjectIdentity(process.cwd()).id;
  const name = requireStringFlag(flags, 'name');
  const version = requireStringFlag(flags, 'version');
  const candidateId = requireStringFlag(flags, 'candidate-id');

  try {
    const context = resolveLearningContext({
      base_dir: baseDir,
      project_id: projectId,
      cwd: process.cwd(),
    }, { require_explicit_base_dir: true });
    assertActionEnabled('result-record', context);
    const repoRoot = trustedRepoRoot();
    const { record, resultsFile, changed } = lib.recordAuthoritativeResult(name, candidateId, {
      version,
      baseDir,
      projectId,
      repoRoot,
      artifactPath: flags['artifact-path'],
    });
    process.stdout.write(
      `[skill-eval-results] ${changed ? 'recorded' : 'already recorded'} ${name} v${record.version}`
        + ` pass_rate=${(record.pass_rate * 100).toFixed(1)}%`
        + ` result_hash=${record.result_hash} → ${resultsFile}\n`
    );
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[skill-eval-results] ERROR: ${error.message}\n`);
    process.exit(2);
  }
}

function writeBlocked(name, result) {
  process.stderr.write(
    `[skill-guard] BLOCKED: ${name} ${result.reason_code || result.status || 'unknown'}\n`
  );
  process.stderr.write(`  ${result.reason}\n`);
  if (Array.isArray(result.mismatches)) {
    result.mismatches.forEach((mismatch) => process.stderr.write(`  - ${mismatch}\n`));
  }
  if (result.prev && result.curr) {
    process.stderr.write(
      `  旧版 v${result.prev.version} pass_rate=${(result.prev.pass_rate * 100).toFixed(1)}%\n`
    );
    process.stderr.write(
      `  新版 v${result.curr.version} pass_rate=${(result.curr.pass_rate * 100).toFixed(1)}%\n`
    );
  }
}

function runGuard(positional, flags) {
  assertAllowedFlags(flags, ['tolerance'], 'guard');
  const name = positional[0];
  if (!name) return usageError('guard requires <name>');
  if (!lib.SKILL_NAME_RE.test(name)) return usageError(`invalid skill name "${name}"`);
  const baseDir = resolveBaseDir();
  const projectId = detectStableProjectIdentity(process.cwd()).id;
  let repoRoot;
  try {
    repoRoot = trustedRepoRoot();
  } catch (error) {
    process.stderr.write(`[skill-guard] ERROR: ${error.message}\n`);
    process.exit(2);
  }
  const tolerance = flags.tolerance === undefined ? 0 : flags.tolerance;

  let result;
  try {
    result = lib.checkPublishGuard(name, { baseDir, projectId, repoRoot, tolerance });
  } catch (error) {
    process.stderr.write(`[skill-guard] ERROR: ${error.message}\n`);
    process.exit(2);
  }

  // Only an explicit comparable non-regression may authorize the caller to continue.
  if (result.status !== 'ok' || result.publish_authorized !== true) {
    writeBlocked(name, result);
    process.exit(2);
  }

  const { prev, curr } = result;
  const currPct = (curr.pass_rate * 100).toFixed(1);
  const prevPct = (prev.pass_rate * 100).toFixed(1);
  if (curr.pass_rate < prev.pass_rate) {
    process.stdout.write(
      `[skill-guard] PASS: ${name} v${curr.version} pass_rate=${currPct}% < 旧版 ${prevPct}%，`
        + `降幅在容差 ${(result.tolerance * 100).toFixed(1)}% 内，放行\n`
    );
  } else {
    process.stdout.write(
      `[skill-guard] PASS: ${name} v${curr.version} pass_rate=${currPct}% ≥ 旧版 ${prevPct}%\n`
    );
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
