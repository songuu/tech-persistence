#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const propagate = require('./propagate-command-changes');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function occurrences(content, token) {
  return content.split(token).length - 1;
}

function assertThinkRouting(relativePath) {
  const content = read(relativePath);
  const label = relativePath.replace(/\\/g, '/');

  for (const route of ['probe-like', 'bounded-like', 'architectural-like']) {
    assert.match(content, new RegExp(`\\b${route}\\b`), `${label} is missing ${route}`);
  }
  assert.match(content, /隐藏复杂度[^\n]*只能升级/, `${label} must make route upgrades one-way`);
  assert.match(
    content,
    /throwaway[^\n]*(?:重新分类|重分类)/i,
    `${label} must reclassify throwaway work before retaining it`
  );
  assert.match(
    content,
    /开放产品决策[^\n]*不可逆[^\n]*外部副作用[^\n]*权限/,
    `${label} must separate approval gates from artifact routing`
  );
  assert.match(
    content,
    /活动[^\n]*\/sprint[^\n]*think\s*->\s*plan[^\n]*状态边/,
    `${label} must preserve the active Sprint state-machine edge`
  );
  assert.match(
    content,
    /路由(?:结论|与下一步)/,
    `${label} must emit an explicit route decision for Plan/Work handoff`
  );
  assert.match(
    content,
    /(?:原样|精确)[^\n]*`probe-like`[^\n]*`bounded-like`[^\n]*`architectural-like`/,
    `${label} must emit one exact route label for machine-comparable behavior evidence`
  );
  assert.doesNotMatch(
    content,
    /<\s*30\s*分钟[^\n]*(?:\/plan|Plan)/i,
    `${label} must not route small work to Plan by time estimate alone`
  );
  assert.doesNotMatch(
    content,
    /持久化[^\n]*(?:CRITICAL|不可跳过)/i,
    `${label} must not impose a blanket persistence tax`
  );
}

function assertPlanShadowPilot(relativePath) {
  const content = read(relativePath);
  const label = relativePath.replace(/\\/g, '/');

  assert.match(
    content,
    /architectural-like[^\n]*(?:shadow|影子)[^\n]*design-authority/i,
    `${label} must scope the shadow design authority to architectural work`
  );
  assert.match(
    content,
    /(?:直接调用 Plan|Plan 研究发现)[^\n]*architectural/i,
    `${label} must classify direct Plan entry instead of depending only on Think handoff`
  );
  assert.strictEqual(
    occurrences(content, '<!-- design-authority:start -->'),
    1,
    `${label} must define exactly one design-authority start marker`
  );
  assert.strictEqual(
    occurrences(content, '<!-- design-authority:end -->'),
    1,
    `${label} must define exactly one design-authority end marker`
  );
  for (const check of ['placeholder', '内部一致性', 'scope', '歧义']) {
    assert.match(content, new RegExp(check, 'i'), `${label} is missing ${check} preflight`);
  }
  assert.match(
    content,
    /不(?:计算|生成)[^\n]*(?:digest|hash)[^\n]*不[^\n]*(?:runtime|Work\/Review)/i,
    `${label} must keep the pilot out of lineage runtime enforcement`
  );
  assert.match(
    content,
    /acceptance_protocol=v1[^\n]*(?:transport projection|传输投影)/i,
    `${label} must define how the shadow owner coexists with Sprint acceptance`
  );
  assert.match(
    content,
    /不要仅因[^\n]*Plan[^\n]*持久化/,
    `${label} must make Plan persistence conditional`
  );
  assert.doesNotMatch(
    content,
    /持久化[^\n]*(?:CRITICAL|不可跳过)/i,
    `${label} must not impose a blanket Plan persistence tax`
  );
  assert.doesNotMatch(content, /docs\/specs\//i, `${label} must not add a physical spec surface`);
  assert.doesNotMatch(content, /source_sha256|spec-lineage/i, `${label} must not prebuild lineage`);
}

for (const source of [
  'codex-native/skills/think/SKILL.md',
  'user-level/commands/think.md',
]) {
  assertThinkRouting(source);
}

for (const source of [
  'codex-native/skills/plan/SKILL.md',
  'user-level/commands/plan.md',
]) {
  assertPlanShadowPilot(source);
}

const autoMode = read('user-level/rules/auto-mode.md');
assert.match(
  autoMode,
  /\| `\/think` \|[^\n]*所选[^\n]*(?:work|\/work)[^\n]*(?:plan|\/plan)/i,
  'auto-mode must follow the selected standalone Think route'
);
assert.doesNotMatch(
  autoMode,
  /\| `\/think` \|[^\n]*scope 明确时自动进入 plan/i,
  'auto-mode must not force every clear Think request into Plan'
);
assert.strictEqual(
  read('.codex/rules/auto-mode.md').replace(/\r\n/g, '\n'),
  propagate.applyCodexRegex(autoMode).replace(/\r\n/g, '\n'),
  'Codex auto-mode projection must match its canonical source'
);

console.log('[OK] Think artifact routing and design-authority shadow contracts passed');
