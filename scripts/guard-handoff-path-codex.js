#!/usr/bin/env node

'use strict';

/** Codex-only bounded PreToolUse handoff guard. */

const fs = require('fs');

const TOP_LEVEL_HANDOFF_RE = /(?:^|\/)docs\/plans\/(?!\.handoff\/)(?:session-[^/]+-handoff|[^/]+-handoff-\d+(?:-compact)?)\.md$/i;
const MAX_PAYLOAD_CHARS = 64 * 1024;
const MAX_STRING_CHARS = 4096;
const MAX_DEPTH = 5;
const MAX_NODES = 200;
const MAX_ARRAY_ITEMS = 50;
const MAX_PATHS = 32;

const WRITE_TOOL_ALLOWLIST = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'str_replace_editor',
  'apply_patch',
  'functions.apply_patch',
  'write_file',
  'edit_file',
  'delete_file',
  'move_file',
  'create_file',
]);

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() && value.length <= MAX_STRING_CHARS) {
      return value.trim();
    }
  }
  return '';
}

function parseBoundedPayload(rawInput) {
  try {
    if (typeof rawInput !== 'string' || rawInput.length === 0 || rawInput.length > MAX_PAYLOAD_CHARS) return null;
    const payload = JSON.parse(rawInput);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

function normalizeToolName(payload) {
  const nestedTool = payload.tool && typeof payload.tool === 'object' ? payload.tool.name : payload.tool;
  const value = firstString(
    payload.tool_name,
    payload.toolName,
    payload.name,
    nestedTool,
    payload.tool_call && payload.tool_call.name,
    payload.toolCall && payload.toolCall.name,
    payload.function && payload.function.name,
    payload.recipient_name,
    payload.recipient
  );
  return value.slice(0, 80);
}

function firstInput(payload) {
  for (const value of [
    payload.input,
    payload.tool_input,
    payload.toolInput,
    payload.arguments,
    payload.args,
    payload.parameters,
    payload.params,
    payload.tool_call && payload.tool_call.arguments,
    payload.toolCall && payload.toolCall.args,
    payload.command,
  ]) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function pathsFromString(value) {
  if (typeof value !== 'string' || value.length > MAX_STRING_CHARS) return [];
  const matches = value.match(/(?:[A-Za-z]:[\\/][^\s"'<>|]+|(?:\.{1,2}[\\/]|[\w.-]+[\\/])[\w./\\-]+)/g);
  return (matches || []).slice(0, MAX_PATHS).map((match) => match.replace(/[),.;\]}]+$/, ''));
}

function extractBoundedPaths(value) {
  const paths = [];
  const state = { nodes: 0 };
  function visit(current, depth) {
    if (paths.length >= MAX_PATHS || depth > MAX_DEPTH || current === null || current === undefined) return;
    state.nodes += 1;
    if (state.nodes > MAX_NODES) return;
    if (typeof current === 'string') {
      paths.push(...pathsFromString(current).slice(0, MAX_PATHS - paths.length));
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, MAX_ARRAY_ITEMS)) visit(item, depth + 1);
      return;
    }
    if (typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current).slice(0, MAX_ARRAY_ITEMS)) {
      const normalizedKey = key.toLowerCase();
      if (typeof child === 'string' && child.length <= MAX_STRING_CHARS
          && (['path', 'filepath', 'file_path', 'file', 'filename', 'workdir', 'cwd'].includes(normalizedKey)
            || normalizedKey.endsWith('path') || normalizedKey.endsWith('file'))) {
        paths.push(child);
      }
      visit(child, depth + 1);
      if (paths.length >= MAX_PATHS || state.nodes > MAX_NODES) break;
    }
  }
  visit(value, 0);
  const seen = new Set();
  return paths
    .map((item) => String(item).trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PATHS);
}

function normalizeCandidatePath(candidate) {
  return String(candidate || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function isWriteLikeTool(tool) {
  return WRITE_TOOL_ALLOWLIST.has(String(tool || '').trim().toLowerCase());
}

function isTopLevelHandoffPath(candidate) {
  const normalized = normalizeCandidatePath(candidate);
  return Boolean(normalized && TOP_LEVEL_HANDOFF_RE.test(normalized));
}

function findTopLevelHandoffPaths(rawInput) {
  const payload = parseBoundedPayload(rawInput);
  if (!payload || !isWriteLikeTool(normalizeToolName(payload))) return [];
  return extractBoundedPaths(firstInput(payload))
    .filter(isTopLevelHandoffPath)
    .map(normalizeCandidatePath)
    .sort();
}

function readStdin() {
  try {
    const buffer = Buffer.allocUnsafe(MAX_PAYLOAD_CHARS + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(0, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_PAYLOAD_CHARS) return '';
    return buffer.subarray(0, total).toString('utf8').trim();
  } catch {
    return '';
  }
}

function main() {
  try {
    const matches = findTopLevelHandoffPaths(readStdin());
    if (matches.length === 0) return;
    process.stderr.write([
      'Top-level handoff guard: blocked transient handoff write.',
      'Handoff files must be written under docs/plans/.handoff/.',
      '',
      ...matches.map((file) => `- ${file}`),
      '',
    ].join('\n'));
    process.exit(2);
  } catch (error) {
    process.stderr.write(`[guard-handoff-path-codex] skipped: ${error && error.message ? error.message : error}\n`);
  }
}

if (require.main === module) main();

module.exports = {
  MAX_PAYLOAD_CHARS,
  extractBoundedPaths,
  findTopLevelHandoffPaths,
  isTopLevelHandoffPath,
  isWriteLikeTool,
  normalizeCandidatePath,
  parseBoundedPayload,
  WRITE_TOOL_ALLOWLIST,
};
