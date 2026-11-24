'use strict';

const fs = require('fs');
const { detectProjectIdentity } = require('./memory-v5');
const { resolveCompatReadDirs } = require('./runtime-paths');
const { searchMemory, formatRecallContext, hasUsefulResults } = require('./memory-search');
const { detectActiveSprintTags } = require('../inject-context');

const MAX_INPUT_BYTES = 512 * 1024;
const DEFAULT_BUDGET_CHARS = 3000;

function main() {
  const input = fs.readFileSync(0);
  if (input.length > MAX_INPUT_BYTES) throw new Error('recall input exceeds bound');
  const payload = JSON.parse(input.toString('utf8'));
  if (!payload || typeof payload.prompt !== 'string' || !Array.isArray(payload.touchedFiles)) {
    throw new Error('invalid recall input');
  }
  const project = detectProjectIdentity();
  if (!project || !project.id) return;
  const baseDirs = resolveCompatReadDirs();
  let sprintTags = [];
  try { sprintTags = detectActiveSprintTags(); } catch {}
  const result = searchMemory({
    prompt: payload.prompt,
    projectId: project.id,
    baseDirs,
    cwd: process.cwd(),
    touchedFiles: payload.touchedFiles,
    sprintTags,
    limits: { budgetChars: DEFAULT_BUDGET_CHARS },
  });
  if (!hasUsefulResults(result)) return;
  const body = formatRecallContext(result, { budgetChars: DEFAULT_BUDGET_CHARS });
  if (!body || body.length < 40) return;
  const context = `<learned-context project="${project.name || 'unknown'}" source="prompt-recall">\n${body}\n</learned-context>`;
  process.stdout.write(JSON.stringify({ context }));
}

if (require.main === module) {
  try { main(); } catch { process.exitCode = 1; }
}

module.exports = { main };
