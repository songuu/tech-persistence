'use strict';

// This outbox shares the existing local-account trust boundary of Claude hooks.
// Hashes detect accidental corruption; they do not authenticate the host.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { acquireJournalLock, readJournal, PROMPT_RECEIPT_SCHEMA_VERSION } = require('./self-learning-store');
const { normalizeBehaviorEvent, createBehaviorEvent } = require('./behavior-events');
const { assertExactKeys, assertRedactionStableString, canonicalStringify, hashObject, validateHash } = require('./self-learning-canonical');

const VERSION = 'claude-prompt-outbox-v1';
const MAX_JOB_BYTES = 64 * 1024;
const BATCH_SIZE = 128;
const MAX_PENDING_JOBS = 1024;
const JOB_FILE = /^(\d{12})-([a-f0-9]{64})\.json$/;
const TEMP_FILE = /^\.pending-[a-f0-9]{32}\.tmp$/;
const CONFLICT_TEMP_FILE = /^\.pending-(\d{12}-[a-f0-9]{64})-[a-f0-9]{32}\.tmp$/;
const BLOCKED_FILE = /^\.blocked-(\d{12})-([a-f0-9]{64})$/;
const PLACEHOLDER_SOURCE = 'prompt-outbox:placeholder';
const PLACEHOLDER_TIME = '1970-01-01T00:00:00.000Z';

function noLinks(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw Error('outbox path must be absolute');
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let cursor = root;
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (stat.isSymbolicLink()) throw Error('outbox path contains a symbolic link or junction');
    if (!stat.isDirectory()) throw Error('outbox path component is not a directory');
  }
  return resolved;
}

function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureDirectories(dir) {
  const missing = [];
  let cursor = dir;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw Error('outbox has no existing parent');
    cursor = parent;
  }
  noLinks(cursor);
  for (const next of missing.reverse()) {
    try { fs.mkdirSync(next, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    noLinks(next);
    fsyncDir(path.dirname(next));
  }
}

function ensureOutbox(dir) {
  const root = noLinks(dir);
  ensureDirectories(root);
  noLinks(root);
  const jobs = path.join(root, 'jobs');
  noLinks(jobs);
  ensureDirectories(jobs);
  noLinks(jobs);
  fsyncDir(root);
  return { root, jobs, enqueueLock: path.join(root, 'enqueue-lock'), drainLock: path.join(root, 'drain-lock') };
}

function normalizeSpec(spec) {
  assertExactKeys(spec, ['project_id', 'session_id', 'transcript_ref', 'replay_ref'], 'prompt receipt spec');
  for (const field of ['project_id', 'session_id']) {
    if (typeof spec[field] !== 'string' || !spec[field].trim() || spec[field].length > 256) {
      throw Error(`invalid outbox ${field}`);
    }
    assertRedactionStableString(spec[field], field);
  }
  validateHash(spec.transcript_ref, 'transcript_ref');
  validateHash(spec.replay_ref, 'replay_ref');
  return { project_id: spec.project_id, session_id: spec.session_id, transcript_ref: spec.transcript_ref, replay_ref: spec.replay_ref };
}

function stripIdentity(event) {
  const { event_id, idempotency_key, source_event_id, occurred_at, ...draft } = event;
  return draft;
}

function validateDraft(draft, spec, stored = false) {
  // Preserve the journal's redacted, bounded summary. For short input that
  // summary can still contain the entire prompt; never persist the raw payload.
  const event = stored
    ? createBehaviorEvent({ ...draft, source_event_id: PLACEHOLDER_SOURCE, occurred_at: PLACEHOLDER_TIME })
    : normalizeBehaviorEvent(draft);
  if (event.project_id !== spec.project_id || event.session_id !== spec.session_id
      || event.runtime !== 'claude' || event.source !== 'claude_hook'
      || event.actor.kind !== 'user'
      || !((event.event_type === 'user.prompt' && event.source_assurance === 'observed')
        || (event.event_type === 'user.approval' && event.source_assurance === 'explicit'))
      || Object.hasOwn(event.details, 'prompt_receipt')) {
    throw Error('outbox event does not match the native prompt receipt');
  }
  const result = stripIdentity(event);
  if (stored && canonicalStringify(result) !== canonicalStringify(draft)) throw Error('invalid outbox event draft');
  return result;
}

function normalizeInput(input, stored = false) {
  assertExactKeys(input, ['receipt_spec', 'event_draft'], 'outbox input');
  const receipt_spec = normalizeSpec(input.receipt_spec);
  return { receipt_spec, event_draft: validateDraft(input.event_draft, receipt_spec, stored) };
}

function address(spec) { return hashObject(spec).slice(7); }
function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
}

function readJob(file, match) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_JOB_BYTES) {
    throw Error('outbox job is not a bounded plain file');
  }
  const fd = fs.openSync(file, 'r');
  let bytes;
  try {
    if (!sameStat(before, fs.fstatSync(fd))) throw Error('outbox job changed before read');
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const amount = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!amount) throw Error('outbox job read was incomplete');
      offset += amount;
    }
    if (!sameStat(before, fs.fstatSync(fd))) throw Error('outbox job changed during read');
  } finally { fs.closeSync(fd); }
  if (!sameStat(before, fs.lstatSync(file)) || bytes.length !== before.size) throw Error('outbox job changed after read');
  const envelope = JSON.parse(bytes.toString('utf8'));
  assertExactKeys(envelope, ['schema_version', 'job', 'digest'], 'outbox envelope');
  if (envelope.schema_version !== VERSION || hashObject(envelope.job) !== envelope.digest) throw Error('outbox job digest mismatch');
  const job = normalizeInput(envelope.job, true);
  if (address(job.receipt_spec) !== match[2]) throw Error('outbox job address mismatch');
  return { file, bytes, stat: before, job };
}

function scan(queue) {
  const jobs = [];
  const blockers = new Set();
  let previousSequence = 0;
  const names = fs.readdirSync(queue.jobs).sort();
  for (const name of names) {
    if (TEMP_FILE.test(name)) {
      // Only an enqueue lock owner can create these; once we hold that lock,
      // any remaining temporary is from an interrupted publication.
      const file = path.join(queue.jobs, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2) throw Error('unsafe outbox temporary');
      fs.unlinkSync(file);
      fsyncDir(queue.jobs);
      continue;
    }
    const blocked = BLOCKED_FILE.exec(name);
    if (blocked) {
      const stat = fs.lstatSync(path.join(queue.jobs, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0) throw Error('invalid outbox conflict marker');
      blockers.add(`${blocked[1]}-${blocked[2]}.json`);
      continue;
    }
    const match = JOB_FILE.exec(name);
    if (!match) throw Error('unexpected outbox entry');
    const sequence = Number(match[1]);
    if (sequence <= previousSequence) throw Error('invalid or duplicate outbox sequence');
    previousSequence = sequence;
    jobs.push({ name, match });
  }
  for (const name of blockers) {
    const entry = jobs.find((item) => item.name === name);
    if (!entry) throw Error('outbox conflict marker lacks its job');
    entry.blocked = true;
  }
  return jobs;
}

function streamKey(job) {
  const spec = job.receipt_spec;
  return hashObject({ project_id: spec.project_id, session_id: spec.session_id, transcript_ref: spec.transcript_ref });
}

function entriesKey(entries) {
  return entries.map((entry) => `${entry.name}:${Boolean(entry.blocked)}`).join('|');
}

function withEnqueueLock(queue, callback, retryTimeout = 1500) {
  const lock = acquireJournalLock(queue.enqueueLock, { operation: 'prompt-outbox-enqueue', retry_timeout_ms: retryTimeout, stale_lock_age_ms: 0 });
  try { return callback(); } finally { lock.release(); }
}

function enqueuePromptReceipt(outboxDir, input) {
  const job = normalizeInput(input);
  const queue = ensureOutbox(outboxDir);
  return withEnqueueLock(queue, () => {
    const entries = scan(queue);
    const key = address(job.receipt_spec);
    const existing = entries.filter((entry) => entry.match[2] === key);
    if (existing.length > 1) throw Error('duplicate outbox replay address');
    if (existing.length) {
      const previous = readJob(path.join(queue.jobs, existing[0].name), existing[0].match).job;
      if (canonicalStringify(previous) !== canonicalStringify(job)) throw Error('outbox replay semantic conflict');
      return { status: 'duplicate' };
    }
    if (entries.length >= MAX_PENDING_JOBS) {
      const error = Error('prompt outbox capacity reached');
      error.code = 'PROMPT_OUTBOX_FULL';
      throw error;
    }
    const sequence = entries.length ? Number(entries[entries.length - 1].match[1]) + 1 : 1;
    if (!Number.isSafeInteger(sequence) || sequence > 999999999999) throw Error('outbox sequence exhausted');
    const final = path.join(queue.jobs, `${String(sequence).padStart(12, '0')}-${key}.json`);
    const temp = path.join(queue.jobs, `.pending-${crypto.randomBytes(16).toString('hex')}.tmp`);
    const bytes = Buffer.from(`${canonicalStringify({ schema_version: VERSION, job, digest: hashObject(job) })}\n`);
    if (bytes.length > MAX_JOB_BYTES) throw Error('outbox job exceeds size limit');
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.linkSync(temp, final);
      fs.unlinkSync(temp);
      fsyncDir(queue.jobs);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return { status: 'queued' };
  });
}

function drainPromptReceipts(outboxDir, handler) {
  if (typeof handler !== 'function') throw Error('outbox batch handler is required');
  const queue = ensureOutbox(outboxDir);
  let consumer;
  try {
    consumer = acquireJournalLock(queue.drainLock, { operation: 'prompt-outbox-drain', retry_timeout_ms: 0, stale_lock_age_ms: 0 });
  } catch (e) {
    if (e.code === 'SELF_LEARNING_LOCKED') return { status: 'busy', count: 0 };
    throw e;
  }
  let count = 0;
  try {
    while (true) {
      const entries = withEnqueueLock(queue, () => {
        const entries = scan(queue);
        if (!entries.length) {
          // Clear only while owning both locks: a later worker failure must not
          // be erased by an earlier consumer finishing its empty check.
          if (markerExists(queue)) {
            fs.unlinkSync(failureMarker(queue));
            fsyncDir(queue.root);
          }
          // Releasing consumer while enqueue is still locked makes the empty
          // observation and handoff indivisible from a new publication.
          consumer.release();
          consumer = null;
          return [];
        }
        return entries;
      });
      if (!entries.length) return { status: 'drained', count };
      // Only the consumer deletes committed jobs. Their bounded reads and
      // validation need not hold the producer lock, even on a slow disk.
      const blockedStreams = new Map();
      for (const item of entries.filter((entry) => entry.blocked)) {
        const job = readJob(path.join(queue.jobs, item.name), item.match).job;
        const key = streamKey(job);
        blockedStreams.set(key, Math.min(blockedStreams.get(key) || Infinity, Number(item.match[1])));
      }
      const batch = [];
      for (const item of entries) {
        if (batch.length >= BATCH_SIZE) break;
        if (item.blocked) continue;
        const entry = readJob(path.join(queue.jobs, item.name), item.match);
        const blockedAt = blockedStreams.get(streamKey(entry.job));
        if (blockedAt !== undefined && Number(item.match[1]) >= blockedAt) continue;
        batch.push(entry);
      }
      if (!batch.length) {
        const unchanged = withEnqueueLock(queue, () => {
          if (entriesKey(scan(queue)) !== entriesKey(entries)) return false;
          writeFailureMarker(queue);
          consumer.release();
          consumer = null;
          return true;
        });
        if (unchanged) return { status: 'blocked', count };
        continue;
      }
      const returned = handler(batch.map((entry) => entry.job));
      if (returned && typeof returned.then === 'function') throw Error('outbox handler must be synchronous');
      const outcomes = returned === undefined ? batch.map(() => 'committed') : returned;
      if (!Array.isArray(outcomes) || outcomes.length !== batch.length
          || outcomes.some((outcome) => !['committed', 'conflict', 'deferred'].includes(outcome))) {
        throw Error('invalid outbox batch outcomes');
      }
      const blockedInBatch = new Set();
      for (let i = 0; i < batch.length; i += 1) {
        const key = streamKey(batch[i].job);
        if (blockedInBatch.has(key) && outcomes[i] !== 'deferred') throw Error('outbox outcome overtakes a conflicting stream');
        if (outcomes[i] === 'deferred' && !blockedInBatch.has(key)) throw Error('outbox outcome defers an unblocked stream');
        if (outcomes[i] === 'conflict') blockedInBatch.add(key);
      }
      for (let i = 0; i < batch.length; i += 1) {
        const entry = batch[i];
        if (outcomes[i] === 'deferred') continue;
        const match = JOB_FILE.exec(path.basename(entry.file));
        const current = readJob(entry.file, match);
        if (!sameStat(entry.stat, current.stat) || !entry.bytes.equals(current.bytes)) throw Error('outbox job changed before acknowledgement');
        // One lock acquisition per acknowledgement bounds interference with
        // producers independently of the size of a completed batch.
        withEnqueueLock(queue, () => {
          if (!sameStat(current.stat, fs.lstatSync(entry.file))) throw Error('outbox job changed during acknowledgement');
          if (outcomes[i] === 'conflict') {
            const conflictPath = path.join(queue.jobs, `.blocked-${match[1]}-${match[2]}`);
            const fd = fs.openSync(conflictPath, 'wx', 0o600);
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            writeFailureMarker(queue);
          } else {
            fs.unlinkSync(entry.file);
            count += 1;
          }
          fsyncDir(queue.jobs);
        });
      }
    }
  } catch (error) {
    // Report the failure before releasing the consumer lock. Otherwise a new
    // consumer could succeed and clear the marker before this failure writes
    // a stale marker. Busy producers may delay this background-only path.
    if (consumer) {
      try {
        while (true) {
          try {
            withEnqueueLock(queue, () => writeFailureMarker(queue), 120000);
            break;
          } catch (markError) {
            if (!markError || markError.code !== 'SELF_LEARNING_LOCKED') throw markError;
          }
        }
      } catch (markError) {
        try { if (error && typeof error === 'object') error.outbox_marker_error = markError; } catch { /* Preserve the original failure. */ }
      }
    }
    throw error;
  } finally { if (consumer) consumer.release(); }
}

function failureMarker(queue) {
  return path.join(queue.root, 'worker-failure');
}

function markerExists(queue) {
  const file = failureMarker(queue);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64) {
    throw Error('invalid outbox failure marker');
  }
  return true;
}

function reportPromptReceiptWorkerFailure(outboxDir) {
  const queue = ensureOutbox(outboxDir);
  return withEnqueueLock(queue, () => writeFailureMarker(queue));
}

function writeFailureMarker(queue) {
  if (markerExists(queue)) return;
  const fd = fs.openSync(failureMarker(queue), 'wx', 0o600);
  try { fs.writeFileSync(fd, 'worker-failure\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDir(queue.root);
}

function hasPromptReceiptWorkerFailure(outboxDir) {
  const queue = ensureOutbox(outboxDir);
  return withEnqueueLock(queue, () => markerExists(queue));
}

function clearPromptReceiptWorkerFailure(outboxDir) {
  const queue = ensureOutbox(outboxDir);
  return withEnqueueLock(queue, () => {
    if (!markerExists(queue)) return;
    fs.unlinkSync(failureMarker(queue));
    fsyncDir(queue.root);
  });
}

function cleanupConflictStaging(archiveDir, conflictId, expectedBytes) {
  for (const name of fs.readdirSync(archiveDir)) {
    const match = CONFLICT_TEMP_FILE.exec(name);
    if (!match || match[1] !== conflictId) continue;
    const candidate = path.join(archiveDir, name);
    const before = fs.lstatSync(candidate);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > expectedBytes.length) {
      throw Error('prompt conflict staging is unsafe');
    }
    const fd = fs.openSync(candidate, 'r');
    let bytes;
    try {
      if (!sameStat(before, fs.fstatSync(fd))) throw Error('prompt conflict staging changed before reading');
      bytes = fs.readFileSync(fd);
      if (!sameStat(before, fs.fstatSync(fd))) throw Error('prompt conflict staging changed during reading');
    } finally { fs.closeSync(fd); }
    if (!sameStat(before, fs.lstatSync(candidate)) || bytes.length !== before.size
        || !expectedBytes.subarray(0, bytes.length).equals(bytes)) {
      throw Error('prompt conflict staging does not match the pending decision');
    }
    // The conflict-bound filename, exclusive creation, and exact expected-byte
    // prefix identify our interrupted publish inside the local-account trust boundary.
    fs.unlinkSync(candidate);
    fsyncDir(archiveDir);
  }
}

// A conflict is never discarded automatically. An explicit operator decision
// may archive an already-conflicting replay, preserving its full redacted job.
// The existing journal event remains authoritative and subsequent jobs in the
// stream can then run. This inherits the local-account trust boundary above.
function rejectPromptConflict(outboxDir, conflictId, expectedProjectId) {
  if (typeof conflictId !== 'string' || !/^\d{12}-[a-f0-9]{64}$/.test(conflictId)) {
    throw Error('invalid prompt conflict identifier');
  }
  if (typeof expectedProjectId !== 'string' || !expectedProjectId) throw Error('invalid prompt conflict project');
  const resolved = noLinks(outboxDir);
  if (!fs.existsSync(path.join(resolved, 'jobs'))) throw Error('prompt conflict outbox is absent');
  const queue = ensureOutbox(resolved);
  const consumer = acquireJournalLock(queue.drainLock, {
    operation: 'prompt-outbox-reject-conflict', retry_timeout_ms: 1500, stale_lock_age_ms: 0,
  });
  try {
    return withEnqueueLock(queue, () => {
      const archiveDir = path.join(queue.root, 'conflict-archive');
      noLinks(archiveDir);
      const archiveFile = path.join(archiveDir, `${conflictId}.json`);
      const file = path.join(queue.jobs, `${conflictId}.json`);
      const marker = path.join(queue.jobs, `.blocked-${conflictId}`);
      const match = JOB_FILE.exec(path.basename(file));
      const hasJob = fs.existsSync(file);
      const hasMarker = fs.existsSync(marker);
      const hasArchive = fs.existsSync(archiveFile);
      if ((!hasMarker && !hasArchive) || (hasMarker && !hasJob)) throw Error('prompt conflict state is inconsistent');
      let entry;
      if (hasJob) entry = readJob(file, match);
      let archived;
      let archiveStat;
      if (hasArchive) {
        archiveStat = fs.lstatSync(archiveFile);
        if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || ![1, 2].includes(archiveStat.nlink) || archiveStat.size > MAX_JOB_BYTES * 2) {
          throw Error('prompt conflict archive is unsafe');
        }
        const archiveFd = fs.openSync(archiveFile, 'r');
        let archiveBytes;
        try {
          if (!sameStat(archiveStat, fs.fstatSync(archiveFd))) throw Error('prompt conflict archive changed before reading');
          archiveBytes = fs.readFileSync(archiveFd);
          if (!sameStat(archiveStat, fs.fstatSync(archiveFd))) throw Error('prompt conflict archive changed during reading');
        } finally { fs.closeSync(archiveFd); }
        if (!sameStat(archiveStat, fs.lstatSync(archiveFile))) throw Error('prompt conflict archive changed after reading');
        archived = JSON.parse(archiveBytes.toString('utf8'));
        assertExactKeys(archived, ['schema_version', 'decision', 'conflict_id', 'record_hash', 'job'], 'prompt conflict archive');
        if (archived.schema_version !== 'claude-prompt-conflict-archive-v1'
            || archived.decision !== 'reject_conflicting_duplicate' || archived.conflict_id !== conflictId) {
          throw Error('prompt conflict archive is invalid');
        }
        validateHash(archived.record_hash, 'prompt conflict record hash');
        archived.job = normalizeInput(archived.job, true);
        if (address(archived.job.receipt_spec) !== match[2]) throw Error('prompt conflict archive identity mismatch');
        if (entry && canonicalStringify(entry.job) !== canonicalStringify(archived.job)) throw Error('prompt conflict archive differs from job');
      }
      if (!entry && !archived) throw Error('prompt conflict job is absent');
      const job = entry ? entry.job : archived.job;
      const spec = job.receipt_spec;
      if (spec.project_id !== expectedProjectId) throw Error('prompt conflict project mismatch');
      const expectedStream = hashObject({ schema_version: PROMPT_RECEIPT_SCHEMA_VERSION, project_id: spec.project_id,
        session_id: spec.session_id, transcript_ref: spec.transcript_ref });
      const journal = readJournal(path.dirname(queue.root));
      const matches = journal.records.filter((record) => {
        const event = record.payload;
        const receipt = event && event.details && event.details.prompt_receipt;
        return record.record_type === 'behavior_event' && receipt
          && event.project_id === spec.project_id && event.session_id === spec.session_id
          && receipt.stream_ref === expectedStream && receipt.transcript_ref === spec.transcript_ref
          && receipt.replay_ref === spec.replay_ref;
      });
      if (matches.length !== 1) throw Error('prompt conflict lacks one original journal record');
      const original = matches[0];
      const originalEvent = normalizeBehaviorEvent(original.payload);
      const receipt = originalEvent.details.prompt_receipt;
      assertExactKeys(receipt, ['schema_version', 'stream_ref', 'transcript_ref', 'replay_ref', 'occurrence'], 'original prompt receipt');
      if (receipt.schema_version !== PROMPT_RECEIPT_SCHEMA_VERSION || !Number.isSafeInteger(receipt.occurrence)
          || receipt.occurrence < 1) throw Error('prompt conflict original receipt is invalid');
      const expectedSource = `claude-prompt-receipt:${expectedStream.slice(7)}:${spec.replay_ref.slice(7)}:${String(receipt.occurrence).padStart(12, '0')}`;
      if (originalEvent.runtime !== 'claude' || originalEvent.source !== 'claude_hook'
          || originalEvent.source_event_id !== expectedSource || original.occurred_at !== originalEvent.occurred_at
          || original.actor.kind !== 'user' || original.actor.runtime !== 'claude'
          || original.actor.authority_ref !== expectedSource) throw Error('prompt conflict original journal record is invalid');
      const candidate = createBehaviorEvent({ ...job.event_draft, source_event_id: expectedSource,
        occurred_at: original.occurred_at, details: { ...job.event_draft.details, prompt_receipt: receipt } });
      if (hashObject(candidate) === original.payload_hash) throw Error('prompt conflict has no semantic difference');
      const evidence = { schema_version: 'claude-prompt-conflict-archive-v1', decision: 'reject_conflicting_duplicate',
        conflict_id: conflictId, record_hash: original.record_hash, job };
      const expectedBytes = Buffer.from(`${canonicalStringify(evidence)}\n`);
      if (archived && canonicalStringify(archived) !== canonicalStringify(evidence)) throw Error('prompt conflict archive disagrees with journal');
      if (archived && archiveStat.nlink === 2) {
        const candidates = fs.readdirSync(archiveDir).filter((name) => {
          const match = CONFLICT_TEMP_FILE.exec(name);
          return match && match[1] === conflictId;
        }).filter((name) => {
          const stat = fs.lstatSync(path.join(archiveDir, name));
          return stat.isFile() && !stat.isSymbolicLink() && sameStat(stat, archiveStat);
        });
        if (candidates.length !== 1 || !sameStat(archiveStat, fs.lstatSync(archiveFile))) {
          throw Error('prompt conflict archive publication is ambiguous');
        }
        fs.unlinkSync(path.join(archiveDir, candidates[0]));
        fsyncDir(archiveDir);
      }
      ensureDirectories(archiveDir);
      cleanupConflictStaging(archiveDir, conflictId, expectedBytes);
      if (!archived) {
        const temporary = path.join(archiveDir, `.pending-${conflictId}-${crypto.randomBytes(16).toString('hex')}.tmp`);
        let fd;
        try {
          fd = fs.openSync(temporary, 'wx', 0o600);
          let offset = 0;
          while (offset < expectedBytes.length) offset += fs.writeSync(fd, expectedBytes, offset, expectedBytes.length - offset);
          fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
          fs.linkSync(temporary, archiveFile);
          fs.unlinkSync(temporary);
          fsyncDir(archiveDir);
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      if (hasMarker) {
        const stat = fs.lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0) throw Error('prompt conflict marker is invalid');
        fs.unlinkSync(marker);
        fsyncDir(queue.jobs);
      }
      if (entry) {
        if (!sameStat(entry.stat, fs.lstatSync(entry.file))) throw Error('prompt conflict job changed before release');
        fs.unlinkSync(entry.file);
        fsyncDir(queue.jobs);
      }
      return { status: hasJob ? 'rejected' : 'already-rejected' };
    });
  } finally { consumer.release(); }
}

module.exports = {
  enqueuePromptReceipt, drainPromptReceipts,
  reportPromptReceiptWorkerFailure, hasPromptReceiptWorkerFailure, clearPromptReceiptWorkerFailure,
  rejectPromptConflict, MAX_PENDING_JOBS,
};
