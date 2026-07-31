#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SUPPORTED_EVENTS = Object.freeze([
  'SubagentStart',
  'SubagentStop',
  'PostCompact',
  'SessionEnd',
]);
const SUPPORTED_EVENT_SET = new Set(SUPPORTED_EVENTS);
const EVIDENCE_DIR_NAME = 'native-lifecycle-evidence';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 256;
const MAX_RUN_DIR_CHARS = 4096;
const MAX_EVIDENCE_FILES = 4096;

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

function boundedString(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value
    .slice(0, MAX_FIELD_CHARS)
    .replace(/[\u0000-\u001f\u007f]/g, '?');
}

function addString(target, key, value) {
  const bounded = boundedString(value);
  if (bounded !== null) target[key] = bounded;
}

function serializedSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function buildEvidenceProjection(payload) {
  const event = payload.hook_event_name;
  const refs = {};
  const attributes = {};

  addString(refs, 'sessionId', payload.session_id);
  addString(refs, 'turnId', payload.turn_id);
  addString(attributes, 'model', payload.model);
  addString(attributes, 'permissionMode', payload.permission_mode);

  if (event === 'SubagentStart' || event === 'SubagentStop') {
    addString(refs, 'agentId', payload.agent_id);
    addString(refs, 'agentType', payload.agent_type);
  }
  if (event === 'SubagentStop' && typeof payload.stop_hook_active === 'boolean') {
    attributes.stopHookActive = payload.stop_hook_active;
  }
  if (event === 'PostCompact') addString(attributes, 'trigger', payload.trigger);
  if (event === 'SessionEnd') addString(attributes, 'reason', payload.reason);

  return {
    version: 1,
    kind: 'native-runtime-lifecycle',
    runtime: 'codex',
    event,
    refs,
    attributes,
  };
}

function assertExplicitRunDir(runDir, runsDir = null) {
  if (typeof runDir !== 'string' || runDir.length === 0) {
    throw new Error('explicit runDir must be a non-empty absolute path');
  }
  if (runDir.length > MAX_RUN_DIR_CHARS) {
    throw new Error(`explicit runDir exceeds ${MAX_RUN_DIR_CHARS} characters`);
  }
  if (!path.isAbsolute(runDir)) {
    throw new Error(`explicit runDir must be absolute: ${runDir}`);
  }

  const resolved = path.resolve(runDir);
  let runsRoot;
  if (runsDir === null || runsDir === undefined || runsDir === '') {
    runsRoot = path.dirname(resolved);
    if (path.basename(runsRoot).toLowerCase() !== '.agent-runs') {
      throw new Error(`explicit runDir must be directly under .agent-runs unless runsDir is supplied: ${resolved}`);
    }
  } else {
    if (typeof runsDir !== 'string' || !path.isAbsolute(runsDir)) {
      throw new Error(`explicit runsDir must be an absolute path: ${runsDir}`);
    }
    runsRoot = path.resolve(runsDir);
    if (path.dirname(resolved) !== runsRoot) {
      throw new Error(`explicit runDir must be directly under explicit runsDir: ${resolved}`);
    }
  }

  const rootStat = fs.lstatSync(runsRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`runs root must be a plain directory: ${runsRoot}`);
  }
  const runStat = fs.lstatSync(resolved);
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw new Error(`explicit runDir must be a plain directory: ${resolved}`);
  }

  const realRunsRoot = fs.realpathSync.native(runsRoot);
  const realRunDir = fs.realpathSync.native(resolved);
  if (path.dirname(realRunDir) !== realRunsRoot) {
    throw new Error(`explicit runDir resolves outside its runs root: ${resolved}`);
  }
  return { runDir: resolved, realRunDir };
}

function ensureEvidenceDir(run) {
  const evidenceDir = path.join(run.runDir, EVIDENCE_DIR_NAME);
  if (!pathExists(evidenceDir)) {
    try {
      fs.mkdirSync(evidenceDir, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  }
  const stat = fs.lstatSync(evidenceDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`lifecycle evidence target must be a plain directory, not a symbolic link or junction: ${evidenceDir}`);
  }
  const realEvidenceDir = fs.realpathSync.native(evidenceDir);
  if (!pathIsInside(run.realRunDir, realEvidenceDir)) {
    throw new Error(`lifecycle evidence target resolves outside explicit runDir: ${evidenceDir}`);
  }
  return evidenceDir;
}

function countEvidenceFiles(evidenceDir) {
  let count = 0;
  const directory = fs.opendirSync(evidenceDir);
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        count += 1;
        if (count >= MAX_EVIDENCE_FILES) return count;
      }
    }
    return count;
  } finally {
    directory.closeSync();
  }
}

function existingEvidenceIsPlainFile(file) {
  if (!pathExists(file)) return false;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`lifecycle evidence entry must be a plain file: ${file}`);
  }
  return true;
}

function recordLifecycleEvidence(payload, options = {}) {
  if (!options.runDir) return { status: 'noop', reason: 'missing-run-dir' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'noop', reason: 'invalid-payload' };
  }
  if (!SUPPORTED_EVENT_SET.has(payload.hook_event_name)) {
    return { status: 'noop', reason: 'unsupported-event' };
  }
  if (serializedSize(payload) > MAX_INPUT_BYTES) {
    return { status: 'noop', reason: 'payload-too-large' };
  }

  const run = assertExplicitRunDir(options.runDir, options.runsDir);
  const projection = buildEvidenceProjection(payload);
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(JSON.stringify(projection))
    .digest('hex');
  const evidenceDir = ensureEvidenceDir(run);
  const file = path.join(evidenceDir, `${idempotencyKey}.json`);

  if (existingEvidenceIsPlainFile(file)) {
    return { status: 'duplicate', idempotencyKey, file };
  }
  if (countEvidenceFiles(evidenceDir) >= MAX_EVIDENCE_FILES) {
    return { status: 'noop', reason: 'evidence-cap-reached' };
  }

  const evidence = {
    ...projection,
    idempotencyKey,
    recordedAt: options.recordedAt || new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(evidence)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error && error.code === 'EEXIST' && existingEvidenceIsPlainFile(file)) {
      return { status: 'duplicate', idempotencyKey, file };
    }
    throw error;
  }
  return { status: 'recorded', idempotencyKey, file };
}

function readStdinBounded(maxBytes = MAX_INPUT_BYTES) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(4096);
  let total = 0;
  while (true) {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > maxBytes) return { oversized: true, text: '' };
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return { oversized: false, text: Buffer.concat(chunks).toString('utf8') };
}

function main() {
  try {
    const input = readStdinBounded();
    if (input.oversized || input.text.trim() === '') return 0;
    let payload;
    try {
      payload = JSON.parse(input.text);
    } catch {
      return 0;
    }
    recordLifecycleEvidence(payload, {
      runDir: process.env.TP_AGENT_RUN_DIR,
      runsDir: process.env.TP_AGENT_RUNS_DIR,
    });
  } catch (error) {
    // Evidence collection must fail open: lifecycle hooks never steer or block
    // the host runtime. Keep the diagnostic bounded and off stdout.
    const message = String(error && error.message ? error.message : error).slice(0, 512);
    process.stderr.write(`[codex-lifecycle-evidence] ${message}\n`);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  EVIDENCE_DIR_NAME,
  MAX_EVIDENCE_FILES,
  MAX_FIELD_CHARS,
  MAX_INPUT_BYTES,
  SUPPORTED_EVENTS,
  buildEvidenceProjection,
  main,
  recordLifecycleEvidence,
};
