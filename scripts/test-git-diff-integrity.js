#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const orchestrator = require('./agent-orchestrator');

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`
  );
  return String(result.stdout || '').trim();
}

function hash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-git-diff-integrity-'));
const workdir = path.join(tempRoot, 'repo');
const runDir = path.join(workdir, '.agent-runs', 'test-run');
fs.mkdirSync(workdir, { recursive: true });

function contentSummaries(diffText) {
  return String(diffText || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Diff omitted; content summary: '))
    .map((line) => JSON.parse(line.slice('Diff omitted; content summary: '.length)));
}

try {
  const trackedName = '追踪文件.txt';
  const literalMagicName = 'literal[1].txt';
  const pathspecDecoyName = 'literal1.txt';
  git(workdir, ['init']);
  git(workdir, ['config', 'user.email', 'test@example.com']);
  git(workdir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(workdir, trackedName), 'initial\n');
  fs.writeFileSync(path.join(workdir, literalMagicName), 'literal target\n');
  fs.writeFileSync(path.join(workdir, pathspecDecoyName), 'pathspec decoy\n');
  git(workdir, ['add', trackedName, literalMagicName, pathspecDecoyName]);
  git(workdir, ['commit', '-m', 'test: initialize integrity fixture']);
  const literalHeadObjectId = git(workdir, [
    'hash-object',
    '--no-filters',
    '--',
    literalMagicName,
  ]);
  const decoyHeadObjectId = git(workdir, [
    'hash-object',
    '--no-filters',
    '--',
    pathspecDecoyName,
  ]);

  fs.writeFileSync(
    path.join(workdir, trackedName),
    Array.from({ length: 2048 }, (_, index) => `changed-${index}`).join('\n')
  );
  fs.writeFileSync(path.join(workdir, literalMagicName), 'literal changed\n');
  const changed = orchestrator.listChangedFiles(workdir, runDir);
  assert.strictEqual(changed.some((entry) => entry.path === trackedName), true);
  const overflowFallback = orchestrator.collectGitDiff(workdir, runDir, changed, {
    maxBuffer: 256,
  });
  assert.match(overflowFallback, /git-diff-output-overflow-v1/);
  assert.match(overflowFallback, /head-index-worktree-content-summaries/);
  assert.match(overflowFallback, /"path":"追踪文件\.txt"/);
  assert.match(overflowFallback, /"head":\{"exists":true/);
  assert.match(overflowFallback, /"index":\{"exists":true/);
  assert.match(overflowFallback, /"worktree":\{"exists":true,"type":"file"/);
  const literalSummary = contentSummaries(overflowFallback)
    .find((summary) => summary.path === literalMagicName);
  assert(literalSummary, 'literal pathspec summary is required');
  assert.strictEqual(literalSummary.head.objectId, literalHeadObjectId);
  assert.strictEqual(literalSummary.index.entries.length, 1);
  assert.strictEqual(literalSummary.index.entries[0].objectId, literalHeadObjectId);
  assert.notStrictEqual(literalSummary.head.objectId, decoyHeadObjectId);

  assert.throws(
    () => orchestrator.collectGitDiff(workdir, runDir, changed, {
      runDiff: () => ({ status: 2, stdout: '', stderr: 'forced git diff failure' }),
    }),
    /git diff staged failed: forced git diff failure/
  );

  git(workdir, ['checkout', '--', trackedName]);
  const renamedName = 'renamed-tracked.txt';
  fs.renameSync(path.join(workdir, trackedName), path.join(workdir, renamedName));
  git(workdir, ['add', '-A']);
  const renamed = orchestrator.listChangedFiles(workdir, runDir);
  const renameEntry = renamed.find((entry) => entry.status.includes('R'));
  assert(renameEntry, 'porcelain -z rename entry is required');
  assert.strictEqual(renameEntry.path, renamedName);
  assert.strictEqual(renameEntry.originalPath, trackedName);
  const renameBinding = orchestrator.collectGitDiff(workdir, runDir, renamed, {
    maxBuffer: 256,
  });
  assert.match(renameBinding, /"originalPath":"追踪文件\.txt"/);
  assert.match(renameBinding, /"originalHead":\{"exists":true/);
  git(workdir, ['reset', '--hard', 'HEAD']);

  fs.mkdirSync(runDir, { recursive: true });
  const managedDestination = path.join(runDir, 'moved-into-managed.txt');
  fs.renameSync(path.join(workdir, trackedName), managedDestination);
  git(workdir, ['add', '-A']);
  const crossedBoundary = orchestrator.listChangedFiles(workdir, runDir);
  const boundaryRename = crossedBoundary.find((entry) => entry.status.includes('R'));
  assert(boundaryRename, 'rename across the managed boundary must not be filtered');
  assert.strictEqual(boundaryRename.originalPath, trackedName);
  assert.strictEqual(boundaryRename.path, '.agent-runs/test-run/moved-into-managed.txt');
  const boundaryBinding = orchestrator.collectGitDiff(
    workdir,
    runDir,
    crossedBoundary,
    { maxBuffer: 256 }
  );
  assert.match(boundaryBinding, /"originalPath":"追踪文件\.txt"/);
  assert.match(boundaryBinding, /"originalHead":\{"exists":true/);
  git(workdir, ['reset', '--hard', 'HEAD']);

  const windowsJunction = process.platform === 'win32';
  const targetA = path.join(tempRoot, windowsJunction ? 'target-a-dir' : 'target-a.txt');
  const targetB = path.join(tempRoot, windowsJunction ? 'target-b-dir' : 'target-b.txt');
  const linkName = windowsJunction ? 'linked-dir' : 'linked.txt';
  const linkPath = path.join(workdir, linkName);
  if (windowsJunction) {
    fs.mkdirSync(targetA);
    fs.mkdirSync(targetB);
    fs.writeFileSync(path.join(targetA, 'same.txt'), 'same target content\n');
    fs.writeFileSync(path.join(targetB, 'same.txt'), 'same target content\n');
  } else {
    fs.writeFileSync(targetA, 'same target content\n');
    fs.writeFileSync(targetB, 'same target content\n');
  }
  fs.symlinkSync(targetA, linkPath, windowsJunction ? 'junction' : 'file');

  const firstFingerprint = orchestrator.worktreeFileFingerprint(workdir, linkName);
  const firstDiff = orchestrator.collectGitDiff(
    workdir,
    runDir,
    [{ status: '??', path: linkName }]
  );
  assert.strictEqual(firstFingerprint.type, 'symlink');
  assert.match(firstFingerprint.linkPayloadHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(firstDiff, /symlink-new-file/);

  fs.rmSync(linkPath, { recursive: windowsJunction, force: true });
  fs.symlinkSync(targetB, linkPath, windowsJunction ? 'junction' : 'file');
  const secondFingerprint = orchestrator.worktreeFileFingerprint(workdir, linkName);
  const secondDiff = orchestrator.collectGitDiff(
    workdir,
    runDir,
    [{ status: '??', path: linkName }]
  );
  assert.strictEqual(firstFingerprint.linkPayloadBytes, secondFingerprint.linkPayloadBytes);
  assert.notStrictEqual(firstFingerprint.linkPayloadHash, secondFingerprint.linkPayloadHash);
  assert.notStrictEqual(
    hash(firstDiff),
    hash(secondDiff),
    'same-content, same-length symlink target drift must change diffHash input'
  );

  console.log('git-diff-integrity: 33 passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
