#!/usr/bin/env node

/**
 * Block transient sprint handoff files from being written to docs/plans top-level.
 * They belong in docs/plans/.handoff/ so Obsidian/project docs stay clean.
 */

const path = require('path');
const { normalizeHookPayload } = require('./lib/memory-v5');

const TOP_LEVEL_HANDOFF_RE = /(?:^|\/)docs\/plans\/(?!\.handoff\/)(?:session-[^/]+-handoff|[^/]+-handoff-\d+(?:-compact)?)\.md$/i;

function readStdin() {
  try {
    return process.platform === 'win32'
      ? require('fs').readFileSync(0, 'utf-8').trim()
      : require('fs').readFileSync('/dev/stdin', 'utf-8').trim();
  } catch {
    return '';
  }
}

function normalizeCandidatePath(candidate) {
  return String(candidate || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function isWriteLikeTool(tool) {
  const normalized = String(tool || '').toLowerCase();
  return (
    normalized.includes('write') ||
    normalized.includes('edit') ||
    normalized.includes('str_replace_editor') ||
    normalized.includes('apply_patch')
  );
}

function isTopLevelHandoffPath(candidate) {
  const normalized = normalizeCandidatePath(candidate);
  if (!normalized) return false;
  return TOP_LEVEL_HANDOFF_RE.test(normalized);
}

function findTopLevelHandoffPaths(rawInput, phase = 'pre') {
  const payload = normalizeHookPayload(rawInput, phase);
  if (!isWriteLikeTool(payload.tool)) return [];
  return payload.input_paths
    .filter(isTopLevelHandoffPath)
    .map(normalizeCandidatePath)
    .sort();
}

function main() {
  try {
    const matches = findTopLevelHandoffPaths(readStdin(), 'pre');
    if (matches.length === 0) return;

    process.stderr.write(
      [
        'Top-level handoff guard: blocked transient handoff write.',
        'Handoff files must be written under docs/plans/.handoff/.',
        '',
        ...matches.map((file) => `- ${file}`),
        '',
      ].join('\n')
    );
    process.exit(2);
  } catch (error) {
    process.stderr.write(`[guard-handoff-path] skipped: ${error && error.message ? error.message : error}\n`);
  }
}

if (require.main === module) main();

module.exports = {
  findTopLevelHandoffPaths,
  isTopLevelHandoffPath,
  isWriteLikeTool,
  normalizeCandidatePath,
};
