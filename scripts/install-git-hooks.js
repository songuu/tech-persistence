#!/usr/bin/env node

/**
 * Install the tech-persistence pre-commit guard into the current repo's
 * .git/hooks/pre-commit. Idempotent: existing managed hook is overwritten,
 * existing user hook is backed up to .bak.<timestamp> before replacement.
 *
 * Usage:
 *   node scripts/install-git-hooks.js          # install into cwd's repo
 *   node scripts/install-git-hooks.js --force  # ignore "is this our hook" check
 *   node scripts/install-git-hooks.js --uninstall
 *
 * Fail-open: if not a git repo, exit 0 with a warning. Never throws fatally.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// MARKER must appear verbatim in installed hooks for our own-vs-foreign detection
// (backupIfForeign / uninstall). HOOK_BODY interpolates this constant at install time,
// so the two are always in sync — but if anyone hand-edits the hook body comment,
// they must update MARKER too. Don't reword one without the other.
const MARKER = 'tech-persistence pre-commit guard (managed; do not edit)';

const HOOK_BODY = `#!/bin/sh
# ${MARKER}
# Source: scripts/pre-commit-check.js
# Bypass: git commit --no-verify
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then
  exit 0
fi
CHECK="$ROOT/scripts/pre-commit-check.js"
if [ ! -f "$CHECK" ]; then
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[pre-commit] node not found in PATH; skipping tech-persistence checks" >&2
  exit 0
fi
exec node "$CHECK"
`;

function resolveHookPath(cwd) {
  try {
    const hookDir = execSync('git rev-parse --git-path hooks', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // `git rev-parse --git-path hooks` may return a relative path; resolve.
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.isAbsolute(hookDir) ? path.join(hookDir, 'pre-commit') : path.join(repoRoot, hookDir, 'pre-commit');
  } catch {
    return null;
  }
}

function backupIfForeign(hookPath, force) {
  if (!fs.existsSync(hookPath)) return null;
  const existing = fs.readFileSync(hookPath, 'utf-8');
  if (existing.includes(MARKER)) return null; // already ours, no backup needed
  if (force) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 14);
  const backupPath = `${hookPath}.bak.${ts}`;
  fs.writeFileSync(backupPath, existing);
  return backupPath;
}

function install(opts) {
  const hookPath = resolveHookPath(opts.cwd);
  if (!hookPath) {
    process.stderr.write('[install-git-hooks] not a git repo; skipping\n');
    return { installed: false, reason: 'not-a-repo' };
  }

  fs.mkdirSync(path.dirname(hookPath), { recursive: true });

  const backup = backupIfForeign(hookPath, opts.force);
  fs.writeFileSync(hookPath, HOOK_BODY);
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // chmod may fail on Windows-native FS; git for windows still respects sh.
  }
  return { installed: true, hookPath, backup };
}

function uninstall(opts) {
  const hookPath = resolveHookPath(opts.cwd);
  if (!hookPath || !fs.existsSync(hookPath)) return { removed: false };
  const existing = fs.readFileSync(hookPath, 'utf-8');
  if (!existing.includes(MARKER)) {
    process.stderr.write('[install-git-hooks] existing pre-commit is not ours; refusing to remove\n');
    return { removed: false, reason: 'foreign-hook' };
  }
  fs.unlinkSync(hookPath);
  return { removed: true, hookPath };
}

function main() {
  const args = process.argv.slice(2);
  const opts = {
    cwd: process.cwd(),
    force: args.includes('--force'),
    uninstall: args.includes('--uninstall'),
  };

  if (opts.uninstall) {
    const result = uninstall(opts);
    if (result.removed) {
      process.stdout.write(`[install-git-hooks] removed ${result.hookPath}\n`);
    }
    return;
  }

  const result = install(opts);
  if (!result.installed) return;
  if (result.backup) {
    process.stdout.write(`[install-git-hooks] backed up existing pre-commit → ${result.backup}\n`);
  }
  process.stdout.write(`[install-git-hooks] installed → ${result.hookPath}\n`);
  process.stdout.write('[install-git-hooks] bypass with: git commit --no-verify\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[install-git-hooks] error (ignored): ${err && err.message}\n`);
    process.exit(0);
  }
}

module.exports = { install, uninstall, resolveHookPath, MARKER, HOOK_BODY };
