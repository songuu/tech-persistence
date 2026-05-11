'use strict';

const fs = require('fs');
const path = require('path');

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

function writeSliceHandoff(runDir, sliceId, handoff) {
  writeJson(sliceHandoffPath(runDir, sliceId), handoff);
}

function writeSliceDiff(runDir, sliceId, diff) {
  writeText(sliceDiffPath(runDir, sliceId), diff || '');
}

function writeSliceValidation(runDir, sliceId, validation) {
  writeJson(sliceValidationPath(runDir, sliceId), validation);
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

module.exports = {
  buildSliceImplementPrompt,
  writeSliceHandoff,
  writeSliceDiff,
  writeSliceValidation,
  loadSliceHandoff,
  dryRunHandoff,
  sliceDir,
};
