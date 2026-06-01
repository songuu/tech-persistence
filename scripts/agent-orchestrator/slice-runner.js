'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENERATED_CHANGE_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
]);

const MANAGED_CHANGE_PREFIXES = [
  '.agent-runs/',
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  'coverage/',
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeText(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
}

function sliceDir(runDir, sliceId) {
  return path.join(runDir, 'slices', sliceId);
}

function buildSliceImplementPrompt(globalContract, slice, options) {
  const lines = [];
  lines.push('You are the Codex implementation provider for agent-loop pipeline mode.');
  lines.push('You will implement exactly ONE slice. The global contract and the slice contract are FROZEN. Do not propose contract changes here — they belong in the slice review.');
  lines.push('');
  lines.push('Hard rules:');
  lines.push('- Touch only the files declared in ownedFiles. readFiles are read-only context.');
  lines.push('- Do not modify .agent-runs/ artifacts.');
  lines.push('- After implementation, return a JSON handoff that validates against agent-loop/agent-handoff.schema.json.');
  lines.push('- summary should describe what changed and why, anchored to the slice contract.');
  lines.push('- followUpTasks should be non-empty only when you discovered work that cannot fit inside this slice.');
  lines.push('');
  lines.push('Frozen global contract:');
  lines.push('```json');
  lines.push(JSON.stringify(globalContract, null, 2));
  lines.push('```');
  lines.push('Frozen slice contract (this is your scope):');
  lines.push('```json');
  lines.push(JSON.stringify(slice, null, 2));
  lines.push('```');
  if (options && options.workdir) lines.push('Workdir: ' + options.workdir);
  return lines.join('\n');
}

function sliceHandoffPath(runDir, sliceId) {
  return path.join(sliceDir(runDir, sliceId), 'handoff.json');
}

function sliceDiffPath(runDir, sliceId) {
  return path.join(sliceDir(runDir, sliceId), 'diff.patch');
}

function sliceValidationPath(runDir, sliceId) {
  return path.join(sliceDir(runDir, sliceId), 'validation.json');
}

function sliceChangedFilesGatePath(runDir, sliceId) {
  return path.join(sliceDir(runDir, sliceId), 'changed-files-gate.json');
}

function writeSliceHandoff(runDir, sliceId, handoff) {
  writeJson(sliceHandoffPath(runDir, sliceId), handoff);
}

function writeSliceDiff(runDir, sliceId, diff) {
  writeText(sliceDiffPath(runDir, sliceId), diff || '');
}

function writeSliceValidation(runDir, sliceId, validation) {
  writeJson(sliceValidationPath(runDir, sliceId), validation);
}

function writeSliceChangedFilesGate(runDir, sliceId, gate) {
  writeJson(sliceChangedFilesGatePath(runDir, sliceId), gate);
}

function loadSliceHandoff(runDir, sliceId) {
  const file = sliceHandoffPath(runDir, sliceId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function dryRunHandoff(slice) {
  return {
    summary: `[dry-run] no Codex call performed for ${slice.id}`,
    changedFiles: slice.ownedFiles || [],
    notes: 'dry-run mode produced this placeholder handoff',
    followUpTasks: [],
  };
}

function normalizeRepoPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^"|"$/g, '')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function normalizeChangedFileEntries(changedFiles) {
  if (!Array.isArray(changedFiles)) return [];
  const seen = new Set();
  const entries = [];
  for (const entry of changedFiles) {
    const rawPath = typeof entry === 'string' ? entry : entry && (entry.path || entry.file || entry.filename);
    const repoPath = normalizeRepoPath(rawPath);
    if (!repoPath || seen.has(repoPath)) continue;
    seen.add(repoPath);
    entries.push({
      path: repoPath,
      status: typeof entry === 'object' && entry ? String(entry.status || '') : '',
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function resolveInsideWorkdir(workdir, repoPath) {
  const root = path.resolve(workdir || process.cwd());
  const absolutePath = path.resolve(root, normalizeRepoPath(repoPath));
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolutePath;
}

function fileFingerprint(workdir, repoPath) {
  const absolutePath = resolveInsideWorkdir(workdir, repoPath);
  if (!absolutePath) return { exists: false, unsafePath: true };
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return { exists: true, type: stat.isDirectory() ? 'directory' : 'other', size: stat.size };
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
    return { exists: true, type: 'file', size: stat.size, hash };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false };
    return { exists: false, error: error.message };
  }
}

function snapshotChangedFiles(workdir, changedFiles) {
  const files = {};
  for (const entry of normalizeChangedFileEntries(changedFiles)) {
    files[entry.path] = {
      status: entry.status,
      fingerprint: fileFingerprint(workdir, entry.path),
    };
  }
  return {
    changedFiles: Object.keys(files).sort(),
    files,
  };
}

function sameFingerprint(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function changedFilesBetweenSnapshots(beforeSnapshot, afterSnapshot) {
  const beforeFiles = beforeSnapshot && beforeSnapshot.files ? beforeSnapshot.files : {};
  const afterFiles = afterSnapshot && afterSnapshot.files ? afterSnapshot.files : {};
  const paths = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  return [...paths].filter((repoPath) => {
    const before = beforeFiles[repoPath];
    const after = afterFiles[repoPath];
    if (!before || !after) return true;
    return !sameFingerprint(before.fingerprint, after.fingerprint) || before.status !== after.status;
  }).sort();
}

function pathMatchesOwnedScope(repoPath, ownedScope) {
  const file = normalizeRepoPath(repoPath);
  const scope = normalizeRepoPath(ownedScope);
  if (!file || !scope) return false;
  if (scope.endsWith('/**')) return file.startsWith(scope.slice(0, -2));
  if (scope.endsWith('/*')) return file.startsWith(scope.slice(0, -1));
  if (scope.endsWith('/')) return file.startsWith(scope);
  return file === scope || file.startsWith(`${scope}/`);
}

function classifyChangeException(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  if (GENERATED_CHANGE_FILES.has(normalized)) return 'generated';
  if (MANAGED_CHANGE_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return 'managed';
  }
  return null;
}

function evaluateSliceChangedFiles(slice, beforeSnapshot, afterSnapshot) {
  const ownedFiles = Array.isArray(slice && slice.ownedFiles)
    ? slice.ownedFiles.map(normalizeRepoPath).filter(Boolean)
    : [];
  const changedFiles = afterSnapshot && Array.isArray(afterSnapshot.changedFiles) ? afterSnapshot.changedFiles : [];
  const touchedFiles = changedFilesBetweenSnapshots(beforeSnapshot, afterSnapshot);
  const allowedFiles = [];
  const exceptions = [];
  const outOfScopeFiles = [];

  for (const repoPath of touchedFiles) {
    if (ownedFiles.some((ownedFile) => pathMatchesOwnedScope(repoPath, ownedFile))) {
      allowedFiles.push(repoPath);
      continue;
    }
    const exceptionType = classifyChangeException(repoPath);
    if (exceptionType) {
      exceptions.push({ path: repoPath, type: exceptionType });
      continue;
    }
    outOfScopeFiles.push(repoPath);
  }

  return {
    sliceId: slice && slice.id ? slice.id : null,
    ok: outOfScopeFiles.length === 0,
    ownedFiles,
    changedFiles,
    touchedFiles,
    allowedFiles: allowedFiles.sort(),
    exceptions,
    outOfScopeFiles: outOfScopeFiles.sort(),
  };
}

function assertSliceChangedFilesGate(gate) {
  if (gate && gate.ok) return;
  const files = gate && Array.isArray(gate.outOfScopeFiles) ? gate.outOfScopeFiles : [];
  throw new Error(`changed-files gate failed: out-of-scope file(s): ${files.join(', ') || 'unknown'}`);
}

module.exports = {
  buildSliceImplementPrompt,
  writeSliceHandoff,
  writeSliceDiff,
  writeSliceValidation,
  writeSliceChangedFilesGate,
  loadSliceHandoff,
  snapshotChangedFiles,
  evaluateSliceChangedFiles,
  assertSliceChangedFilesGate,
  dryRunHandoff,
  sliceDir,
  sliceChangedFilesGatePath,
};
