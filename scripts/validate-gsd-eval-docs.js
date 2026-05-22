#!/usr/bin/env node

/**
 * Validate the GSD sibling-eval documentation bundle.
 *
 * This is intentionally narrow: it guards the known drift points from the
 * 2026-05-21 GSD evaluation instead of becoming a generic markdown linter.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const planPath = path.join(repoRoot, 'docs', 'plans', '2026-05-21-gsd-eval.md');
const solutionPath = path.join(repoRoot, 'docs', 'solutions', '2026-05-21-gsd-eval.md');
const claudePath = path.join(repoRoot, 'CLAUDE.md');
const agentsPath = path.join(repoRoot, 'AGENTS.md');
const indexPath = path.join(repoRoot, 'docs', 'solutions', 'index.jsonl');

const canonicalTitle = 'gsd-build/get-shit-done 评估 — 0 直接实施 + 5 follow-up + 11 硬拒绝 + 2 防御性拒绝改正';
const expectedInstincts = [
  'command-bloat.md',
  'evidence-based-recalibration.md',
  'sibling-eval-completed-status-requires-review-pass.md',
  'sibling-evaluation-defaults-to-framework-building.md',
  'reuse-existing-infra-before-building-new.md',
  'entry-protocol-vs-lessons-archive-layering.md',
];

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return {};
  const data = {};
  content.slice(4, end).split('\n').forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return;
    data[match[1]] = match[2].replace(/^["']|["']$/g, '');
  });
  return data;
}

function section(content, heading) {
  const match = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').exec(content);
  if (!match) return '';
  const rest = content.slice(match.index + match[0].length);
  const next = rest.search(/\n#{1,3}\s+/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countLines(block, regex) {
  return block.split('\n').filter((line) => regex.test(line)).length;
}

function tableDataRowCount(block) {
  return block
    .split('\n')
    .filter((line) => /^\| /.test(line))
    .filter((line) => !/^\|[-\s|]+$/.test(line))
    .filter((line) => !/^\| # /.test(line))
    .length;
}

function fail(message) {
  failures.push(message);
}

const failures = [];
const plan = read(planPath);
const solution = read(solutionPath);
const planFm = parseFrontmatter(plan);
const solutionFm = parseFrontmatter(solution);

if (planFm.status !== 'completed') fail('plan frontmatter status must be completed');
if (planFm.tasks_total !== '6') fail('plan tasks_total must be 6');
if (planFm.tasks_completed !== '6') fail('plan tasks_completed must be 6');

const success = section(plan, '### 成功标准');
const uncheckedSuccess = countLines(success, /^- \[ \]/);
if (uncheckedSuccess !== 0) fail(`plan success criteria must have 0 unchecked items, got ${uncheckedSuccess}`);

const decisionTable = section(plan, '### §决策表（15 行, 每行 reference 4 不可妥协原则之一）');
const decisionRows = countLines(decisionTable, /^\| \d+ \|/);
if (decisionRows < 17) fail(`plan decision table must have at least 17 rows, got ${decisionRows}`);

const principleRows = decisionTable
  .split('\n')
  .filter((line) => /^\| \d+ \|/.test(line) && /\|[^|]*(?:MR|DET|LT|OBS)/.test(line)).length;
if (principleRows !== decisionRows) {
  fail(`every plan decision row must reference MR/DET/LT/OBS, got ${principleRows}/${decisionRows}`);
}

if (solutionFm.status !== 'completed') fail('solution frontmatter status must be completed');
if (solutionFm.title !== canonicalTitle) fail('solution title must match canonical GSD eval title');
if (!solution.includes(`# ${canonicalTitle.replace(' — ', ' sprint — ')}`)) {
  fail('solution H1 must match canonical GSD eval title');
}

const followupCount = countLines(solution, /^\*\*Follow-up #\d+:/);
if (followupCount !== 5) fail(`solution must contain 5 follow-up headings, got ${followupCount}`);

const rejectionRows = tableDataRowCount(section(solution, '### C) 拒绝清单 — 11 项 + 2 个 "思想吸收" 改正（按 4 原则筛, Phase 4 P0-A/防御性拒绝修订）'));
if (rejectionRows !== 13) fail(`solution rejection/absorption table must contain 13 rows, got ${rejectionRows}`);

if (solution.includes('0 直接借鉴 + 2 follow-up + 13 拒绝')) {
  fail('solution must not contain stale 2 follow-up / 13 reject wording');
}

const instinctDir = path.join(process.env.USERPROFILE || '', '.claude', 'homunculus', 'projects', '8331ab9c2853', 'instincts');
expectedInstincts.forEach((name) => {
  const instinctPath = path.join(instinctDir, name);
  if (!fs.existsSync(instinctPath)) fail(`missing instinct file: ${instinctPath}`);
});

const claude = read(claudePath);
const agents = read(agentsPath);
const indexLines = read(indexPath).split('\n').filter(Boolean);
let indexEntry = null;
try {
  indexEntry = JSON.parse(indexLines.find((line) => line.includes('"id":"2026-05-21-gsd-eval"')) || 'null');
} catch (error) {
  fail(`index json parse failed: ${error.message}`);
}

if (!claude.includes(canonicalTitle)) fail('CLAUDE.md solution index must include canonical title');
if (!agents.includes(canonicalTitle)) fail('AGENTS.md solution index must include canonical title');
if (!indexEntry || indexEntry.title !== canonicalTitle) fail('docs/solutions/index.jsonl must include canonical title');

if (failures.length > 0) {
  console.error('GSD eval doc validation failed:');
  failures.forEach((message) => console.error(`- ${message}`));
  process.exit(1);
}

console.log('GSD eval doc validation passed');
