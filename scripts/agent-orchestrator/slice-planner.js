'use strict';

const fs = require('fs');
const path = require('path');
const sliceNormalizer = require('./slice-normalizer');

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

function buildGlobalContractPrompt(requirement, options) {
  const lines = [];
  lines.push('You are the Claude Code global-contract provider for agent-loop pipeline mode.');
  lines.push('Goal: produce a single JSON document that freezes the run-level contract before any slice planning begins.');
  lines.push('');
  lines.push('Hard rules:');
  lines.push('- Output exactly one JSON object that validates against the schema agent-loop/global-contract.schema.json.');
  lines.push('- Do NOT plan slices in this output.');
  lines.push('- Use blockingQuestions[] for anything that prevents safe planning. Non-empty blockingQuestions halts the pipeline.');
  lines.push('- runtimeTargets MUST list both "claude-code" and "codex" unless the user explicitly excludes one.');
  lines.push('- riskLevel ∈ {L0,L1,L2,L3,L4}. Default L2 unless user request clearly elevates risk.');
  lines.push('');
  lines.push('Required fields:');
  lines.push('  version: "global-v1"');
  lines.push('  goal: <one-paragraph statement of the run goal>');
  lines.push('  nonGoals: <bullet list of things explicitly NOT in scope>');
  lines.push('  globalAcceptance: <run-level acceptance criteria, must be verifiable>');
  lines.push('  architectureConstraints: <invariants that every slice must respect>');
  lines.push('  runtimeTargets: ["claude-code", "codex"]');
  lines.push('  riskLevel, blockingQuestions');
  lines.push('Optional: integrationValidationCommands (commands to run at the integration review stage).');
  lines.push('');
  lines.push('Workdir (read-only context): ' + (options && options.workdir ? options.workdir : process.cwd()));
  lines.push('');
  lines.push('User requirement (verbatim):');
  lines.push('---');
  lines.push(requirement.trim());
  lines.push('---');
  return lines.join('\n');
}

function buildSlicePlannerPrompt(globalContract, alreadyPlanned, options) {
  const lines = [];
  lines.push('You are the Claude Code slice-planner provider for agent-loop pipeline mode.');
  lines.push('Goal: emit the next batch of executable slices given the FROZEN global contract.');
  lines.push('');
  lines.push('Hard rules:');
  lines.push('- Output exactly one JSON object: { "slices": [<sliceObject>, ...] } where each sliceObject validates against agent-loop/pipeline-slice.schema.json.');
  lines.push('- Each slice id must be unique among already-planned ids: ' + alreadyPlanned.map((id) => `"${id}"`).join(', ') || 'none.');
  lines.push('- A slice may declare ownedFiles, readFiles, dependsOn, risk (L0..L4), acceptanceCriteria, doneCriteria, validationCommands, questions[].');
  lines.push('- Risk L4 or sensitive areas (auth, secret, migration, destructive, api, data-schema, storage-path) MUST be split into smaller scope — orchestrator will reject otherwise.');
  lines.push('- If the contract has unresolved blockingQuestions, you MUST return { "slices": [] }.');
  lines.push('- dependsOn must only reference already-planned slice ids; do not reference future slices.');
  lines.push('- Slice ownedFiles SHOULD NOT overlap with each other in the same batch.');
  lines.push('- Prefer minimum batch size that unblocks progress; the orchestrator will call you again for the next batch.');
  lines.push('');
  lines.push('Frozen global contract:');
  lines.push('```json');
  lines.push(JSON.stringify(globalContract, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Already planned slice ids: ' + (alreadyPlanned.length ? alreadyPlanned.join(', ') : 'none'));
  lines.push('Workdir: ' + (options && options.workdir ? options.workdir : process.cwd()));
  return lines.join('\n');
}

function buildSliceReviewPrompt(globalContract, slice, options) {
  const lines = [];
  lines.push('You are the Claude Code slice-review provider for agent-loop pipeline mode.');
  lines.push('Goal: verify that the Codex implementation satisfies the FROZEN slice contract.');
  lines.push('');
  lines.push('Hard rules:');
  lines.push('- Output exactly one JSON object that validates against agent-loop/review-result.schema.json with optional contractRevisions[].');
  lines.push('- contractRevisions[] are the ONLY way to propose changes to the frozen global contract. Sources outside this array are ignored.');
  lines.push('- If the slice is a reconciliation slice (id starts with reconcile-), you MUST NOT propose contractRevisions[]; the orchestrator will escalate any revision to contract-conflict.');
  lines.push('- decision ∈ {approved, needs-followup, blocked}.');
  lines.push('');
  lines.push('Frozen global contract:');
  lines.push('```json');
  lines.push(JSON.stringify(globalContract, null, 2));
  lines.push('```');
  lines.push('Frozen slice contract:');
  lines.push('```json');
  lines.push(JSON.stringify(slice, null, 2));
  lines.push('```');
  if (options && options.diffPath) lines.push('Diff file: ' + options.diffPath);
  if (options && options.handoffPath) lines.push('Handoff file: ' + options.handoffPath);
  if (options && options.changedFilesGatePath) lines.push('Changed-files gate file: ' + options.changedFilesGatePath);
  return lines.join('\n');
}

function buildIntegrationReviewPrompt(globalContract, slices, options) {
  const lines = [];
  lines.push('You are the Claude Code integration-review provider for agent-loop pipeline mode.');
  lines.push('Goal: emit a final go/no-go review for the entire run.');
  lines.push('');
  lines.push('Hard rules:');
  lines.push('- Output exactly one JSON object that validates against agent-loop/review-result.schema.json. decision MUST be one of approved, needs-followup, blocked.');
  lines.push('- Check global goal, global acceptance, every slice contract, every diff, every validation log, every contract revision.');
  lines.push('- Approve only when every required slice is slice-completed and no breaking/cross-cutting drift is outstanding.');
  lines.push('- Do NOT propose contractRevisions[]; the integration review is the final gate, not a revision moment.');
  lines.push('');
  lines.push('Frozen global contract:');
  lines.push('```json');
  lines.push(JSON.stringify(globalContract, null, 2));
  lines.push('```');
  lines.push('Slice contracts (frozen):');
  lines.push('```json');
  lines.push(JSON.stringify(slices, null, 2));
  lines.push('```');
  if (options && options.aggregatedValidation) {
    lines.push('Aggregated validation commands (integration stage):');
    for (const command of options.aggregatedValidation) {
      lines.push('  - ' + command);
    }
  }
  return lines.join('\n');
}

function writeSliceArtifacts(runDir, slice, raw) {
  const dir = sliceDir(runDir, slice.id);
  writeJson(path.join(dir, 'slice.json'), slice);
  if (raw !== undefined) writeJson(path.join(dir, 'slice.raw.json'), raw);
  return dir;
}

function loadSlice(runDir, sliceId) {
  const file = path.join(sliceDir(runDir, sliceId), 'slice.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listSliceIds(runDir) {
  const dir = path.join(runDir, 'slices');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function loadAllSlices(runDir) {
  return listSliceIds(runDir).map((id) => loadSlice(runDir, id)).filter(Boolean);
}

function writeSlicePrompts(runDir, sliceId, prompts) {
  const dir = path.join(sliceDir(runDir, sliceId), 'prompts');
  ensureDir(dir);
  for (const key of Object.keys(prompts)) {
    writeText(path.join(dir, `${key}.md`), prompts[key]);
  }
}

module.exports = {
  buildGlobalContractPrompt,
  buildSlicePlannerPrompt,
  buildSliceReviewPrompt,
  buildIntegrationReviewPrompt,
  writeSliceArtifacts,
  writeSlicePrompts,
  loadSlice,
  loadAllSlices,
  listSliceIds,
  sliceDir,
};
