#!/usr/bin/env node

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}

const sprint = read('user-level/commands/sprint.md');
const agentLoop = read('user-level/commands/agent-loop.md');
const readme = read('README.md');

assert.match(sprint, /运行时可移植性契约/);
assert.match(sprint, /当前可执行宿主/);
assert.match(sprint, /只有 Codex/);
assert.match(sprint, /只有 Claude Code/);
assert.match(sprint, /Codex 和 Claude Code 都不可用/);
assert.match(sprint, /非当前 provider.*不得.*阻塞/);
assert.match(sprint, /partial effects.*禁止切换 writer/i);
assert.match(sprint, /不得.*要求用户登录某个固定厂商/);
assert.match(sprint, /\/sprint evidence/);
assert.match(sprint, /harnessUsed/);
assert.match(sprint, /sprintTranscriptBound/);
assert.match(sprint, /transaction_read_only=true/);

assert.match(agentLoop, /可选执行后端/);
assert.match(agentLoop, /不会成为.*\/sprint.*前置条件/);
assert.match(agentLoop, /不得因为需求中出现.*Harness.*自动选择/i);

assert.match(readme, /Sprint 运行时可移植性/);
assert.match(readme, /当前宿主/);
assert.match(readme, /其他框架/);
assert.match(readme, /\/sprint evidence/);

for (const [skillPath, referencePath] of [
  ['.codex/skills/sprint/SKILL.md', null],
  ['codex-native/skills/sprint/SKILL.md', 'codex-native/skills/sprint/references/runtime-portability.md'],
  ['plugins/tech-persistence/codex-skills/sprint/SKILL.md', 'plugins/tech-persistence/codex-skills/sprint/references/runtime-portability.md'],
]) {
  const projection = read(skillPath) + (referencePath ? read(referencePath) : '');
  const relativePath = referencePath || skillPath;
  assert.match(projection, /运行时可移植性契约/, `${relativePath} must preserve the contract`);
  assert.match(projection, /非当前 provider.*不得.*阻塞/, `${relativePath} must preserve fallback semantics`);
}

for (const skillRoot of ['codex-native/skills/sprint', 'plugins/tech-persistence/codex-skills/sprint']) {
  const evidence = read(`${skillRoot}/SKILL.md`) + read(`${skillRoot}/references/evidence.md`);
  assert.match(evidence, /Sprint Runtime Evidence/);
  assert.match(evidence, /unbound-local/);
  assert.match(evidence, /transaction_read_only=true/);
}

const agentLoopProjection = read('plugins/tech-persistence/codex-skills/agent-loop/SKILL.md');
assert.match(agentLoopProjection, /可选执行后端/);
assert.match(agentLoopProjection, /不会成为.*\/sprint.*前置条件/);

console.log('[OK] sprint runtime portability contract is explicit');
