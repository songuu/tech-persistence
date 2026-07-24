#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  marketplaceExpectationFromRaw,
  publishTextCompareAndSwap,
} = require('./update-codex-marketplace');

const MAX_AGENTS_BYTES = 256 * 1024;
// Exact normalized hashes of historical Tech Persistence-generated Codex
// instruction files. This intentionally is an allowlist, not a content
// heuristic: a one-byte user edit makes the file custom and therefore
// non-replaceable.
const LEGACY_GENERATED_HASHES = Object.freeze({
  user: Object.freeze([
    '2f2de24b4eed8d8af8ef95214f067e8968d137e895eae888bc9e63b1c2ba8eb3',
  ]),
  project: Object.freeze([]),
});
const MANAGED_MARKERS = Object.freeze({
  user: '<!-- tech-persistence:codex-agents:user:v1 -->',
  project: '<!-- tech-persistence:codex-agents:project:v1 -->',
});

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeComparableText(value) {
  return String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

function normalizedSha256(value) {
  return sha256(Buffer.from(normalizeComparableText(value), 'utf8'));
}

function legacyClaudeToCodex(text) {
  let result = String(text);
  const replacements = [
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
  ];
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function readPlainFile(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a plain file: ${resolved}`);
  }
  if (stat.size > MAX_AGENTS_BYTES) {
    throw new Error(`${label} exceeds ${MAX_AGENTS_BYTES} bytes: ${resolved}`);
  }
  return { path: resolved, raw: fs.readFileSync(resolved), mode: stat.mode & 0o777 };
}

function assertSafeTarget(allowedRoot, target) {
  const root = path.resolve(allowedRoot);
  const resolvedTarget = path.resolve(target);
  if (path.basename(resolvedTarget).toLowerCase() !== 'agents.md') {
    throw new Error(`Codex instruction target must be AGENTS.md: ${resolvedTarget}`);
  }
  if (!pathIsInside(root, resolvedTarget)) {
    throw new Error(`Codex instruction target escapes allowed root: ${resolvedTarget}`);
  }
  if (!pathExists(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`allowed root must be a plain directory: ${root}`);
  }
  const realRoot = fs.realpathSync.native(root);
  const relative = path.relative(root, resolvedTarget);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!pathExists(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Codex instruction target crosses a symbolic link or junction: ${current}`);
    }
    const realCurrent = fs.realpathSync.native(current);
    if (!pathIsInside(realRoot, realCurrent)) {
      throw new Error(`Codex instruction target resolves outside allowed root: ${current}`);
    }
  }
  return { root, target: resolvedTarget, realRoot };
}

function firstNormalizedLine(raw) {
  return normalizeComparableText(raw.toString('utf8')).split('\n', 1)[0];
}

function classifyExistingAgents({ raw, templateRaw, legacyRaw, kind }) {
  if (raw.equals(templateRaw)) return 'managed-current';
  const marker = MANAGED_MARKERS[kind];
  if (firstNormalizedLine(raw) === marker) return 'managed-marker';
  if (LEGACY_GENERATED_HASHES[kind].includes(normalizedSha256(raw.toString('utf8')))) {
    return 'legacy-generated';
  }
  if (legacyRaw) {
    const projected = legacyClaudeToCodex(legacyRaw.toString('utf8'));
    if (normalizedSha256(raw.toString('utf8')) === normalizedSha256(projected)) {
      return 'legacy-generated';
    }
  }
  return 'custom';
}

function installCodexAgents(options = {}) {
  const kind = options.kind;
  if (!Object.hasOwn(MANAGED_MARKERS, kind)) {
    throw new Error(`Codex instruction kind must be user or project: ${kind || '<missing>'}`);
  }
  if (!options.allowedRoot || !options.target || !options.template) {
    throw new Error('allowedRoot, target, and template are required');
  }

  const safety = assertSafeTarget(options.allowedRoot, options.target);
  const template = readPlainFile(options.template, 'Codex-native AGENTS template');
  if (firstNormalizedLine(template.raw) !== MANAGED_MARKERS[kind]) {
    throw new Error(`Codex-native ${kind} template is missing its managed marker`);
  }
  const legacy = options.legacySource
    ? readPlainFile(options.legacySource, 'legacy Claude instruction source')
    : null;

  if (!pathExists(safety.target)) {
    publishTextCompareAndSwap(
      safety.target,
      template.raw,
      marketplaceExpectationFromRaw(null),
      { testHooks: options.testHooks }
    );
    assertSafeTarget(safety.root, safety.target);
    const installed = fs.readFileSync(safety.target);
    if (!installed.equals(template.raw)) {
      throw new Error(`created Codex AGENTS bytes failed verification: ${safety.target}`);
    }
    return {
      kind,
      target: safety.target,
      status: 'created',
      optimized: true,
      backupPath: null,
      sha256: sha256(installed),
    };
  }

  const targetStat = fs.lstatSync(safety.target);
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`Codex instruction target must be a plain file: ${safety.target}`);
  }
  if (targetStat.size > MAX_AGENTS_BYTES) {
    return {
      kind,
      target: safety.target,
      status: 'preserved-custom',
      optimized: false,
      backupPath: null,
      reason: `existing AGENTS.md exceeds ${MAX_AGENTS_BYTES} bytes`,
      sha256: sha256(fs.readFileSync(safety.target)),
    };
  }

  const existingRaw = fs.readFileSync(safety.target);
  const classification = classifyExistingAgents({
    raw: existingRaw,
    templateRaw: template.raw,
    legacyRaw: legacy && legacy.raw,
    kind,
  });
  if (classification === 'managed-current') {
    return {
      kind,
      target: safety.target,
      status: 'unchanged',
      optimized: true,
      backupPath: null,
      sha256: sha256(existingRaw),
    };
  }
  if (classification === 'custom') {
    return {
      kind,
      target: safety.target,
      status: 'preserved-custom',
      optimized: false,
      backupPath: null,
      reason: 'existing AGENTS.md is not a managed or exact legacy-generated Tech Persistence file',
      sha256: sha256(existingRaw),
    };
  }

  const expectation = marketplaceExpectationFromRaw(
    existingRaw,
    process.platform === 'win32' ? null : targetStat.mode & 0o777
  );
  const published = publishTextCompareAndSwap(
    safety.target,
    template.raw,
    expectation,
    {
      retainPrevious: true,
      previousLabel: 'tech-persistence-agents-backup',
      testHooks: options.testHooks,
    }
  );
  assertSafeTarget(safety.root, safety.target);
  const installed = fs.readFileSync(safety.target);
  if (!installed.equals(template.raw)) {
    throw new Error(`migrated Codex AGENTS bytes failed verification: ${safety.target}`);
  }
  if (!published.previousPath || !pathExists(published.previousPath)) {
    throw new Error(`migrated Codex AGENTS has no retained verified backup: ${safety.target}`);
  }
  const backup = fs.readFileSync(published.previousPath);
  if (!backup.equals(existingRaw) || sha256(backup) !== expectation.sha256) {
    throw new Error(`migrated Codex AGENTS backup differs from original bytes: ${published.previousPath}`);
  }
  return {
    kind,
    target: safety.target,
    status: classification === 'legacy-generated' ? 'migrated-legacy' : 'updated-managed',
    optimized: true,
    backupPath: published.previousPath,
    sha256: sha256(installed),
    previousSha256: expectation.sha256,
  };
}

function parseArgs(argv) {
  const options = {};
  const valueArgs = new Set([
    '--kind',
    '--allowed-root',
    '--target',
    '--template',
    '--legacy-source',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!valueArgs.has(argument)) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    index += 1;
    const key = {
      '--kind': 'kind',
      '--allowed-root': 'allowedRoot',
      '--target': 'target',
      '--template': 'template',
      '--legacy-source': 'legacySource',
    }[argument];
    options[key] = value;
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const result = installCodexAgents(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.optimized ? 0 : 2;
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
  LEGACY_GENERATED_HASHES,
  MANAGED_MARKERS,
  classifyExistingAgents,
  installCodexAgents,
  legacyClaudeToCodex,
  normalizeComparableText,
  normalizedSha256,
};
