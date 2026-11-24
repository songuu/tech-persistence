'use strict';

// These bindings preserve the native prompt-id stream across the period before
// Claude creates its transcript. They share the existing local-account trust
// boundary and never contain the transcript path or prompt itself.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { acquireJournalLock } = require('./self-learning-store');
const { canonicalStringify, hashObject, validateHash, assertExactKeys } = require('./self-learning-canonical');

function unsafe() {
  const error = new Error('transcript binding is unsafe or inconsistent');
  error.code = 'SELF_LEARNING_TRANSCRIPT_UNSAFE';
  return error;
}

function noLinks(dir) {
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
  }
}

function ensureDirectory(dir) {
  noLinks(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  noLinks(dir);
}

function syncDir(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readPlainJson(file) {
  let before;
  try { before = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw unsafe();
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw unsafe();
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const pathAfter = fs.lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size
      || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.ctimeMs !== before.ctimeMs || pathAfter.nlink !== 1) throw unsafe();
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'SELF_LEARNING_TRANSCRIPT_UNSAFE') throw error;
    throw unsafe();
  } finally { fs.closeSync(fd); }
}

function createOnce(dir, file, data, key) {
  const temp = path.join(dir, `.binding-${key}-${crypto.randomBytes(16).toString('hex')}.tmp`);
  const bytes = `${canonicalStringify(data)}\n`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temp, file);
    fs.unlinkSync(temp);
    syncDir(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function recoverBindingStages(dir, key) {
  const pattern = new RegExp(`^\\.binding-${key}-[a-f0-9]{32}\\.tmp$`);
  for (const name of fs.readdirSync(dir)) {
    if (!pattern.test(name)) continue;
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== 1 && stat.nlink !== 2)) throw unsafe();
    if (stat.nlink === 2) {
      const pinnedTargets = [`${key}.json`, `${key}.pin.json`];
      const matches = pinnedTargets.some((target) => {
        try {
          const candidate = fs.lstatSync(path.join(dir, target));
          return candidate.isFile() && !candidate.isSymbolicLink()
            && candidate.dev === stat.dev && candidate.ino === stat.ino && candidate.nlink === 2;
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      });
      if (!matches) throw unsafe();
    }
    fs.unlinkSync(file);
    syncDir(dir);
  }
}

function resolvePromptTranscriptBinding({ storeDir, projectId, sessionId, transcriptPath, nativePromptId, inspectTranscript }) {
  if (!path.isAbsolute(transcriptPath) || typeof inspectTranscript !== 'function') throw unsafe();
  const normalizedPath = process.platform === 'win32' ? path.resolve(transcriptPath).toLowerCase() : path.resolve(transcriptPath);
  const sessionRef = hashObject({ schema_version: 'claude-transcript-session-v1', project_id: projectId, session_id: sessionId });
  const pathRef = hashObject({ schema_version: 'claude-transcript-path-v1', normalized_path: normalizedPath });
  const key = sessionRef.slice(7);
  const root = path.join(storeDir, 'prompt-bindings');
  ensureDirectory(root);
  const lockRoot = path.join(root, 'locks', key);
  const lock = acquireJournalLock(lockRoot, { operation: 'prompt-transcript-binding', retry_timeout_ms: 1000, stale_lock_age_ms: 0 });
  try {
    recoverBindingStages(root, key);
    const file = path.join(root, `${key}.json`);
    const pinFile = path.join(root, `${key}.pin.json`);
    let binding = readPlainJson(file);
    const pin = readPlainJson(pinFile);
    let observed;
    try { observed = inspectTranscript(); } catch (error) {
      if (error && error.code === 'SELF_LEARNING_TRANSCRIPT_MISSING') observed = null;
      else throw error;
    }
    if (!binding) {
      if (pin || (!observed && !nativePromptId)) throw unsafe();
      binding = {
        schema_version: 'claude-transcript-binding-v1',
        session_ref: sessionRef,
        path_ref: pathRef,
        stream_ref: observed ? observed.transcript_ref : hashObject({
          schema_version: 'claude-native-prompt-compat-stream-v1', session_ref: sessionRef, path_ref: pathRef,
        }),
        initial_inode_ref: observed ? observed.transcript_ref : null,
      };
      createOnce(root, file, binding, key);
    }
    assertExactKeys(binding, ['schema_version', 'session_ref', 'path_ref', 'stream_ref', 'initial_inode_ref'], 'transcript binding');
    if (binding.schema_version !== 'claude-transcript-binding-v1' || binding.session_ref !== sessionRef || binding.path_ref !== pathRef) throw unsafe();
    validateHash(binding.stream_ref, 'bound stream');
    if (binding.initial_inode_ref !== null) validateHash(binding.initial_inode_ref, 'initial transcript identity');
    const expectedStream = binding.initial_inode_ref || hashObject({
      schema_version: 'claude-native-prompt-compat-stream-v1', session_ref: sessionRef, path_ref: pathRef,
    });
    if (binding.stream_ref !== expectedStream) throw unsafe();
    if (pin) {
      assertExactKeys(pin, ['schema_version', 'inode_ref'], 'transcript pin');
      if (pin.schema_version !== 'claude-transcript-pin-v1') throw unsafe();
      validateHash(pin.inode_ref, 'pinned transcript identity');
      if (binding.initial_inode_ref && binding.initial_inode_ref !== pin.inode_ref) throw unsafe();
    }
    const pinned = binding.initial_inode_ref || (pin && pin.inode_ref);
    if (!observed) {
      if (pinned || !nativePromptId) throw unsafe();
      return { transcript_ref: binding.stream_ref, cursor_ref: null };
    }
    if (pinned && pinned !== observed.transcript_ref) throw unsafe();
    if (!pinned) createOnce(root, pinFile, { schema_version: 'claude-transcript-pin-v1', inode_ref: observed.transcript_ref }, key);
    return { transcript_ref: binding.stream_ref, cursor_ref: observed.cursor_ref };
  } catch (error) {
    if (error && error.code && error.code.startsWith('SELF_LEARNING_')) throw error;
    throw unsafe();
  } finally { lock.release(); }
}

module.exports = { resolvePromptTranscriptBinding };
