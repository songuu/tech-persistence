#!/usr/bin/env node
'use strict';

// Read-only status for the local-account prompt handoff.  Conflict jobs may
// contain a short redacted prompt, so never emit file contents or local paths.
const fs = require('fs');
const path = require('path');
const { resolveBaseDir } = require('./runtime-paths');
const { detectStableProjectIdentity } = require('./project-identity');
const { resolveStoreDir } = require('./self-learning-store');

const JOB = /^(\d{12})-([a-f0-9]{64})\.json$/;
const BLOCKED = /^\.blocked-(\d{12})-([a-f0-9]{64})$/;
const TEMP = /^\.pending-[a-f0-9]{32}\.tmp$/;
const MAX_JOB_BYTES = 64 * 1024;

function assertDirectoryPath(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw Error('invalid outbox status');
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('invalid outbox status');
  }
  return true;
}

function checkPlainFile(file, maxSize, links = 1) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1
      || stat.nlink > links || stat.size > maxSize) {
    throw Error('invalid outbox status');
  }
  return stat;
}

function inspectPromptOutbox(baseDir, projectId) {
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) throw Error('invalid outbox status');
  const root = path.join(resolveStoreDir(baseDir, projectId), 'prompt-outbox');
  if (!assertDirectoryPath(root)) {
    return { state: 'absent', pending: 0, blocked: 0, worker_failure: false, conflicts: [] };
  }
  const jobsDir = path.join(root, 'jobs');
  if (!assertDirectoryPath(jobsDir)) throw Error('invalid outbox status');
  const names = fs.readdirSync(jobsDir).sort();
  const jobs = new Set();
  const blocked = new Set();
  const sequences = new Set();
  let staged = false;
  for (const name of names) {
    const jobMatch = JOB.exec(name);
    if (jobMatch) {
      if (jobMatch[1] === '000000000000' || sequences.has(jobMatch[1])) throw Error('invalid outbox status');
      sequences.add(jobMatch[1]);
      checkPlainFile(path.join(jobsDir, name), MAX_JOB_BYTES);
      jobs.add(name.slice(0, -5));
    } else if (BLOCKED.test(name)) {
      if (checkPlainFile(path.join(jobsDir, name), 0).size !== 0) throw Error('invalid outbox status');
      blocked.add(name.slice('.blocked-'.length));
    } else if (TEMP.test(name)) {
      checkPlainFile(path.join(jobsDir, name), MAX_JOB_BYTES, 2);
      staged = true;
    } else {
      throw Error('invalid outbox status');
    }
  }
  for (const id of blocked) if (!jobs.has(id)) throw Error('inconsistent outbox status');
  let workerFailure = false;
  try {
    checkPlainFile(path.join(root, 'worker-failure'), 64);
    workerFailure = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // A concurrent producer or consumer can otherwise yield a misleading mix of
  // snapshots. The command is read-only, so report a retryable error instead.
  if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(jobsDir).sort())) {
    throw Error('inconsistent outbox status');
  }
  const state = blocked.size ? 'blocked'
    : workerFailure || staged ? 'needs-attention'
      : jobs.size ? 'pending' : 'empty';
  return {
    state,
    pending: jobs.size,
    blocked: blocked.size,
    worker_failure: workerFailure,
    conflicts: [...blocked].sort(),
  };
}

function main(argv = process.argv.slice(2)) {
  if (!['status', 'reject'].includes(argv[0])) throw Error('invalid arguments');
  let baseDir = process.env.TP_SELF_LEARNING_BASE_DIR || resolveBaseDir();
  let projectId = null;
  let conflictId = null;
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--base-dir', '--project-id', '--conflict'].includes(key) || seen.has(key)
        || typeof argv[i + 1] !== 'string' || !argv[i + 1]) throw Error('invalid arguments');
    seen.add(key);
    if (key === '--base-dir') baseDir = argv[i + 1];
    else if (key === '--project-id') projectId = argv[i + 1];
    else conflictId = argv[i + 1];
  }
  projectId = projectId || detectStableProjectIdentity(process.cwd()).id;
  if (argv[0] === 'status') {
    if (conflictId !== null) throw Error('invalid arguments');
    process.stdout.write(`${JSON.stringify(inspectPromptOutbox(baseDir, projectId))}\n`);
    return;
  }
  if (!conflictId) throw Error('invalid arguments');
  const result = rejectPromptConflict(baseDir, projectId, conflictId);
  const launch = require('./prompt-receipt-worker').startPromptReceiptWorker(baseDir, projectId);
  process.stdout.write(`${JSON.stringify({ ...result, worker: launch.status })}\n`);
}

function rejectPromptConflict(baseDir, projectId, conflictId) {
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) throw Error('invalid outbox recovery');
  const outbox = path.join(resolveStoreDir(baseDir, projectId), 'prompt-outbox');
  return require('./prompt-receipt-outbox').rejectPromptConflict(outbox, conflictId, projectId);
}

if (require.main === module) {
  try { main(); }
  catch {
    // Neither filesystem paths nor payload details belong in diagnostics.
    process.stderr.write('[prompt-receipt-recovery] operation failed; retry or inspect the local outbox.\n');
    process.exitCode = 1;
  }
}

module.exports = { inspectPromptOutbox, rejectPromptConflict, main };
