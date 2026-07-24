#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  marketplaceExpectationFromRaw,
  publishTextCompareAndSwap,
} = require('./update-codex-marketplace');

const MODES = new Set(['overwrite', 'backup', 'no-overwrite', 'no-overwrite-strict']);

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPlainDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a plain directory: ${directory}`);
  }
}

function resolveAllowedTarget(allowedRoot, target) {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedTarget = path.resolve(target);
  if (!pathIsInside(resolvedRoot, resolvedTarget)) {
    throw new Error(`target escapes allowed root: ${resolvedTarget}`);
  }
  assertPlainDirectory(resolvedRoot, 'allowed root');
  const resolvedParent = path.dirname(resolvedTarget);
  assertPlainDirectory(resolvedParent, 'target parent');
  const realRoot = fs.realpathSync.native(resolvedRoot);
  const realParent = fs.realpathSync.native(resolvedParent);
  if (!pathIsInside(realRoot, realParent)) {
    throw new Error(`target parent escapes allowed root through a link: ${resolvedParent}`);
  }
  return resolvedTarget;
}

function readPlainSource(source) {
  const resolvedSource = path.resolve(source);
  const stat = fs.lstatSync(resolvedSource);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`source must be a plain file: ${resolvedSource}`);
  }
  return fs.readFileSync(resolvedSource, 'utf8');
}

function readTargetExpectation(target) {
  if (!pathExists(target)) return { ...marketplaceExpectationFromRaw(null), raw: null };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`target must be absent or a plain file: ${target}`);
  }
  const raw = fs.readFileSync(target);
  return { ...marketplaceExpectationFromRaw(raw), raw };
}

function convertCodexText(text) {
  return [
    [/~\/\.claude\/CLAUDE\.md/g, '~/.codex/AGENTS.md'],
    [/~\/\.claude\/homunculus/g, '~/.codex/homunculus'],
    [/CLAUDE_PROJECT_DIR/g, 'CODEX_PROJECT_DIR'],
    [/CLAUDE\.md/g, 'AGENTS.md'],
    [/\.claude\/commands/g, '.codex/commands'],
    [/\.claude\/skills/g, '.codex/skills'],
    [/\.claude\/rules/g, '.codex/rules'],
    [/\.claude\/plans/g, '.codex/plans'],
    [/\.claude/g, '.codex'],
    [/Claude Code/g, 'Codex'],
    [/Claude/g, 'Codex'],
  ].reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function isGeneratedBroken(raw) {
  if (!raw) return false;
  return /Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/.test(raw.toString('utf8'));
}

function backupPathFor(target) {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${target}.bak.${timestamp}.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
}

function retainExpectedBackup(target, expectation) {
  if (!expectation.existed) return null;
  const backupPath = backupPathFor(target);
  publishTextCompareAndSwap(
    backupPath,
    expectation.raw,
    marketplaceExpectationFromRaw(null),
    { previousLabel: 'install-backup' }
  );
  return backupPath;
}

function installCodexTextAsset(options = {}) {
  if (!options.allowedRoot) throw new Error('allowedRoot is required');
  if (!options.source) throw new Error('source is required');
  if (!options.target) throw new Error('target is required');
  const mode = options.mode || 'overwrite';
  if (!MODES.has(mode)) throw new Error(`unsupported text asset mode: ${mode}`);

  const target = resolveAllowedTarget(options.allowedRoot, options.target);
  const sourceText = readPlainSource(options.source);
  const converted = Buffer.from(convertCodexText(sourceText), 'utf8');
  const expectation = readTargetExpectation(target);

  if (expectation.existed && expectation.raw.equals(converted)) {
    return {
      status: 'unchanged',
      target,
      backupPath: null,
      expectedExisted: true,
      expectedSha256: expectation.sha256,
    };
  }

  const noOverwrite = mode === 'no-overwrite' || mode === 'no-overwrite-strict';
  const repairGenerated = mode === 'no-overwrite'
    && expectation.existed
    && isGeneratedBroken(expectation.raw);
  if (noOverwrite && expectation.existed && !repairGenerated) {
    return {
      status: 'skipped',
      target,
      backupPath: null,
      expectedExisted: true,
      expectedSha256: expectation.sha256,
    };
  }

  const backupPath = (mode === 'backup' || repairGenerated)
    ? retainExpectedBackup(target, expectation)
    : null;
  const publish = publishTextCompareAndSwap(target, converted, expectation, {
    previousLabel: 'install',
    testHooks: options.testHooks,
  });
  return {
    status: repairGenerated ? 'repaired' : 'published',
    target,
    backupPath,
    expectedExisted: expectation.existed,
    expectedSha256: expectation.sha256,
    publish,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--allowed-root', '--source', '--target', '--mode'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === '--allowed-root') options.allowedRoot = value;
    else if (argument === '--source') options.source = value;
    else if (argument === '--target') options.target = value;
    else if (argument === '--mode') options.mode = value;
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const result = installCodexTextAsset(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  convertCodexText,
  installCodexTextAsset,
  isGeneratedBroken,
  main,
  parseArgs,
  readTargetExpectation,
  resolveAllowedTarget,
};
