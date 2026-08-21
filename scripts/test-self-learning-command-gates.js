#!/usr/bin/env node

/**
 * Text-contract regression tests for the self-learning command surfaces.
 *
 * WHY: these commands are LLM protocols, so a direct-write sentence is an
 * executable bypass even when the deterministic store itself is safe.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function includesAll(relativePath, needles) {
  const content = read(relativePath);
  needles.forEach((needle) => {
    assert.ok(
      content.includes(needle),
      `${relativePath} must contain self-learning contract token: ${needle}`
    );
  });
  return content;
}

function excludesAll(relativePath, needles) {
  const content = read(relativePath);
  needles.forEach((needle) => {
    assert.ok(
      !content.includes(needle),
      `${relativePath} still contains legacy direct-write bypass: ${needle}`
    );
  });
}

const producerDocs = [
  'user-level/commands/evolve.md',
  'user-level/commands/learn.md',
  'user-level/commands/compound.md',
  'user-level/commands/session-summary.md',
  'user-level/commands/instinct-import.md',
  'user-level/commands/skill.md',
  'user-level/commands/skill-improve.md',
  'codex-native/skills/compound/SKILL.md',
  'codex-native/skills/continuous-learning/SKILL.md',
];

producerDocs.forEach((relativePath) => {
  includesAll(relativePath, [
    'Self-learning candidate gate',
    '`propose`',
    '`evaluate`',
    '`shadow`',
    '`approve`',
    '`promote`',
  ]);
});

const evolve = includesAll('user-level/commands/evolve.md', [
  '`candidate_id`',
  '`candidate_hash`',
  '`--auto`',
  'skill / command / rule',
  '`evolved_into`',
]);
assert.match(evolve, /--auto[\s\S]{0,500}(?:不得|禁止)[\s\S]{0,200}`approve`[\s\S]{0,100}`promote`/);
excludesAll('user-level/commands/evolve.md', [
  '自动落地；改写',
  '生成的文件写入对应目录',
  '源本能不删除，但标记 `evolved_into: "产物路径"`',
]);

includesAll('user-level/commands/learn.md', [
  '`LearningCandidate`',
  'scope',
  'confidence',
]);
excludesAll('user-level/commands/learn.md', [
  '本能→`homunculus/instincts/`',
  '通过 5/5，允许写入',
]);

includesAll('user-level/commands/compound.md', [
  '`LearningCandidate`',
  '`docs/solutions/`',
  'solution',
  '既有写权限内直接新增/更新',
]);
excludesAll('user-level/commands/compound.md', [
  '### 步骤 4: 创建/更新本能',
  '新本能标记 `pending_absorption`',
]);

includesAll('user-level/commands/session-summary.md', [
  '`LearningCandidate`',
  '会话总结',
]);
excludesAll('user-level/commands/session-summary.md', [
  '自动调用 /learn 提取经验 + 本能',
  '自动追加到 `.claude/rules/architecture.md`',
]);

includesAll('user-level/commands/instinct-import.md', [
  '`legacy-unverified`',
  '`needs-review`',
  'candidate',
]);
excludesAll('user-level/commands/instinct-import.md', [
  '确认后写入 `~/.claude/homunculus/instincts/inherited/`',
]);

const skill = includesAll('user-level/commands/skill.md', [
  '`candidate_id`',
  '`candidate_hash`',
  '`evaluation_id`',
  '`evaluation_hash`',
  '`approval_receipt_id`',
  '`approval_receipt_hash`',
  '`shadow`',
  "人工 `go`",
  'tp_learning_govern(operation="publish-guard")',
  '`{key,source_path,source_hash}`',
  '`evaluation_artifact_ref:{name}`',
]);
assert.match(skill, /\/skill auto[\s\S]{0,3000}(?:不得|禁止)[\s\S]{0,200}(?:publish|`promote`)/);
excludesAll('user-level/commands/skill.md', [
  'diagnose → eval → improve → publish',
  '备份 + changelog + 标记 absorbed_into',
]);

includesAll('user-level/commands/skill-improve.md', [
  '`LearningCandidate`',
  '`candidate_id`',
  '`candidate_hash`',
  '`propose`',
]);

includesAll('user-level/commands/skill-eval.md', [
  '`candidate_id`',
  '`candidate_hash`',
  '`skill_hash`',
  '`baseline_hash`',
  '`case_set_hash`',
  '`evaluator_id`',
  '`evaluation_id`',
  '`evaluation_hash`',
  'fail closed',
  'v1/v2',
  '`skill:<name>`',
  '`stageEvaluationArtifactAuthority(name,candidateId,results,{baseDir,projectId,cwd})`',
  '--source-event-ref',
  '`project_id`',
  'brand 不能',
  'MCP **不能 stage 或自报 case results**',
  '`nlink===1`',
  '`{key,source_path,source_hash}`',
]);

includesAll('user-level/commands/skill-publish.md', [
  '`candidate_id`',
  '`candidate_hash`',
  '`evaluation_id`',
  '`evaluation_hash`',
  '`approval_receipt_id`',
  '`approval_receipt_hash`',
  '`user.approval`',
  '人工 `go`',
  '`--auto`',
  'readback',
  '"operation": "publish-guard"',
  '非 promoted',
  'v1/v2',
  '`target.source_hash`',
  'guard→write TOCTOU',
]);
excludesAll('user-level/commands/skill-publish.md', [
  '无前一版基线时放行',
]);

includesAll('codex-native/skills/compound/SKILL.md', [
  '现有 Compound 授权内直接新增/更新',
]);

console.log('[OK] self-learning command protocols close direct-write and auto-promotion bypasses');
