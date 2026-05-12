#!/usr/bin/env node

/**
 * Pre-commit guard for tech-persistence.
 *
 * Verifies on staged changes:
 *   1. Propagate sync — when user-level/commands or user-level/rules sources change,
 *      derived copies (plugin / .codex) must already be regenerated.
 *   2. Plan scope lint — new sprint plan docs must contain a「关键假设验证」section
 *      with substantive content (ADR-012). Older docs (filename date < GRANDFATHER_BEFORE)
 *      are grandfathered.
 *
 * On hook-internal failure (missing transform modules, git unavailable, parse errors,
 * etc.) — log to stderr and exit 0. The commit is never blocked by hook bugs;
 * `--no-verify` is always an escape hatch.
 *
 * Exit codes:
 *   0 — all clean OR hook-internal failure (fail-open by design)
 *   1 — real validation failure that the user must resolve
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ORCHESTRATOR_PATH_RE = /^(?:scripts|plugins\/tech-persistence\/scripts)\/agent-orchestrator(?:\.js|\/[^/]+\.js)$/;

// Plans whose filename date is strictly < this string skip lint.
// Adopted 2026-05-11 in ADR-012; 1-day buffer so the commit landing the rule
// itself stays clean. Filename date (YYYY-MM-DD prefix) is authoritative here
// — independent of frontmatter, which may be missing or have CRLF issues.
const GRANDFATHER_BEFORE = '2026-05-12';
const PLAN_PATH_RE = /^docs\/plans\/(\d{4}-\d{2}-\d{2})-.+\.md$/;

function resolveRepoRoot(cwd = process.cwd()) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function getStagedFiles(repoRoot) {
  // -c core.quotePath=false: emit non-ASCII filenames verbatim, not octal-escaped.
  // Otherwise files like docs/plans/2026-05-12-中文.md become "\"...\"" quoted strings
  // and our regex/path operations silently miss them.
  // Include deletions (D): deleting a source file should still trigger orphan detection
  // of the now-stale plugin copy.
  const output = execSync('git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMRD', {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function loadTransformers(repoRoot) {
  const propagatePath = path.join(repoRoot, 'scripts', 'propagate-command-changes.js');
  const buildPath = path.join(repoRoot, 'plugins', 'tech-persistence', 'scripts', 'build-codex-plugin.js');
  if (!fs.existsSync(propagatePath) || !fs.existsSync(buildPath)) {
    const err = new Error(
      'pre-commit-check 依赖的派生脚本缺失\n' +
      `  缺失: ${!fs.existsSync(propagatePath) ? propagatePath : ''}${!fs.existsSync(buildPath) ? ' ' + buildPath : ''}\n` +
      '  如果文件被重命名，同步更新 scripts/pre-commit-check.js::loadTransformers'
    );
    err.code = 'MISSING_TRANSFORMERS';
    throw err;
  }
  const propagate = require(propagatePath);
  const build = require(buildPath);
  return {
    applyCodexRegex: propagate.applyCodexRegex,
    pluginTransform: build.transform,
    normalizeLf: build.normalizeLf,
    commandToSkill: build.commandToSkill,
    expectedCommands: build.expectedCommands,
  };
}

function checkPropagateSync(stagedFiles, repoRoot) {
  const userLevelChanged = stagedFiles.filter((f) =>
    f.startsWith('user-level/commands/') || f.startsWith('user-level/rules/')
  );
  if (userLevelChanged.length === 0) return [];

  const t = loadTransformers(repoRoot);
  const mismatches = [];

  for (const sourceRel of userLevelChanged) {
    const sourceContent = readIfExists(path.join(repoRoot, sourceRel));
    if (sourceContent == null) continue;

    if (sourceRel.startsWith('user-level/commands/')) {
      const name = path.basename(sourceRel, '.md');

      const codexCmdRel = `.codex/commands/${name}.md`;
      const codexCmdActual = readIfExists(path.join(repoRoot, codexCmdRel));
      const codexCmdExpected = t.applyCodexRegex(sourceContent);
      if (codexCmdActual !== codexCmdExpected) {
        mismatches.push({ source: sourceRel, derived: codexCmdRel, kind: 'command', reason: 'propagate output mismatch' });
      }

      const pluginCmdRel = `plugins/tech-persistence/commands/${name}.md`;
      const pluginCmdActual = readIfExists(path.join(repoRoot, pluginCmdRel));
      const pluginCmdExpected = t.normalizeLf(t.pluginTransform(sourceContent));
      if (pluginCmdActual !== pluginCmdExpected) {
        mismatches.push({ source: sourceRel, derived: pluginCmdRel, kind: 'command', reason: 'build-codex-plugin output mismatch' });
      }

      if (Array.isArray(t.expectedCommands) && t.expectedCommands.includes(`${name}.md`)) {
        const skillRel = `plugins/tech-persistence/skills/${name}/SKILL.md`;
        const skillActual = readIfExists(path.join(repoRoot, skillRel));
        const skillExpected = t.commandToSkill(`${name}.md`, sourceContent);
        if (skillActual !== skillExpected) {
          mismatches.push({ source: sourceRel, derived: skillRel, kind: 'command', reason: 'skill wrapper mismatch' });
        }
      }
    }

    if (sourceRel.startsWith('user-level/rules/')) {
      const name = path.basename(sourceRel, '.md');
      const codexRuleRel = `.codex/rules/${name}.md`;
      const codexRuleActual = readIfExists(path.join(repoRoot, codexRuleRel));
      const codexRuleExpected = t.applyCodexRegex(sourceContent);
      if (codexRuleActual !== codexRuleExpected) {
        mismatches.push({ source: sourceRel, derived: codexRuleRel, kind: 'rule', reason: 'propagate rule output mismatch' });
      }
    }
  }

  return mismatches;
}

function sha256OfFile(filePath) {
  // build-codex-plugin.js writes plugin copies via normalizeLf (CRLF → LF). To stay
  // consistent with that build semantics, hash the LF-normalized bytes. Otherwise a
  // user who saves the source with CRLF (Windows editors) gets stuck in a loop —
  // build can't help because it always writes LF, and raw-byte sha mismatches forever.
  try {
    const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

function checkOrchestratorSync(stagedFiles, repoRoot) {
  // Triggered when either source or plugin copy of agent-orchestrator is staged.
  // Source = scripts/agent-orchestrator{.js,/*.js}; plugin copy under plugins/tech-persistence/scripts/...
  // build-codex-plugin.js does byte-copy (no transform) for .js, so direct sha256 compare is correct.
  const trigger = stagedFiles.some((f) => ORCHESTRATOR_PATH_RE.test(f));
  if (!trigger) return [];

  const mismatches = [];

  // Main file pair
  const mainPair = ['scripts/agent-orchestrator.js', 'plugins/tech-persistence/scripts/agent-orchestrator.js'];
  // Dynamic submodule pairs from source side. build-codex-plugin.js's
  // copyAgentOrchestratorSubmodules() is non-recursive (flat .js files only);
  // assert that invariant here so adding a subdirectory doesn't silently produce
  // an incomplete plugin bundle that still passes both build and pre-commit.
  const submoduleSourceDir = path.join(repoRoot, 'scripts', 'agent-orchestrator');
  let submoduleNames = [];
  if (fs.existsSync(submoduleSourceDir)) {
    for (const entry of fs.readdirSync(submoduleSourceDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        mismatches.push({
          source: `scripts/agent-orchestrator/${entry.name}/`,
          derived: '(unsupported by build-codex-plugin)',
          kind: 'orchestrator',
          reason: 'nested directory under scripts/agent-orchestrator/ — build is non-recursive; flatten or update build-codex-plugin.copyAgentOrchestratorSubmodules',
        });
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        submoduleNames.push(entry.name);
      }
    }
    submoduleNames.sort();
  }
  const pairs = [mainPair].concat(
    submoduleNames.map((n) => [
      `scripts/agent-orchestrator/${n}`,
      `plugins/tech-persistence/scripts/agent-orchestrator/${n}`,
    ])
  );

  for (const [srcRel, dstRel] of pairs) {
    const srcAbs = path.join(repoRoot, srcRel);
    const dstAbs = path.join(repoRoot, dstRel);
    const a = sha256OfFile(srcAbs);
    const b = sha256OfFile(dstAbs);
    if (a == null) {
      mismatches.push({ source: srcRel, derived: dstRel, kind: 'orchestrator', reason: 'source file missing' });
      continue;
    }
    if (b == null) {
      mismatches.push({ source: srcRel, derived: dstRel, kind: 'orchestrator', reason: 'plugin copy missing — run build-codex-plugin' });
      continue;
    }
    if (a !== b) {
      mismatches.push({ source: srcRel, derived: dstRel, kind: 'orchestrator', reason: 'sha256 mismatch — plugin copy out of sync' });
    }
  }

  // Orphan detection: plugin has .js submodules not in source
  const pluginSubmoduleDir = path.join(repoRoot, 'plugins', 'tech-persistence', 'scripts', 'agent-orchestrator');
  if (fs.existsSync(pluginSubmoduleDir)) {
    const sourceSet = new Set(submoduleNames);
    const pluginNames = fs.readdirSync(pluginSubmoduleDir).filter((n) => n.endsWith('.js'));
    for (const name of pluginNames) {
      if (!sourceSet.has(name)) {
        mismatches.push({
          source: `scripts/agent-orchestrator/${name}`,
          derived: `plugins/tech-persistence/scripts/agent-orchestrator/${name}`,
          kind: 'orchestrator',
          reason: 'orphan plugin submodule — source file does not exist',
        });
      }
    }
  }

  return mismatches;
}

function parseFrontmatter(content) {
  // Accept both LF and CRLF line endings. Windows editors often write CRLF.
  const startsLF = content.startsWith('---\n');
  const startsCRLF = content.startsWith('---\r\n');
  if (!startsLF && !startsCRLF) return null;
  const startOffset = startsCRLF ? 5 : 4;
  // End marker must be at line start; accept LF or CRLF newline preceding it.
  const endMatch = content.slice(startOffset).search(/(?:\r?\n)---(?:\r?\n|$)/);
  if (endMatch === -1) return null;
  const raw = content.slice(startOffset, startOffset + endMatch).replace(/\r\n/g, '\n');
  const data = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    data[m[1]] = m[2].replace(/^"(.*)"$/, '$1').trim();
  }
  return data;
}

function checkPlanScope(stagedFiles, repoRoot) {
  const planEntries = [];
  for (const f of stagedFiles) {
    if (f.includes('-handoff-')) continue;
    if (f.endsWith('/TEMPLATE.md')) continue;
    const m = f.match(PLAN_PATH_RE);
    if (!m) continue;
    planEntries.push({ rel: f, filenameDate: m[1] });
  }
  if (planEntries.length === 0) return [];

  const failures = [];

  for (const { rel: planRel, filenameDate } of planEntries) {
    // Filename date is authoritative for grandfather decisions — independent of
    // frontmatter format issues (CRLF, missing FM, malformed `created` field).
    if (filenameDate < GRANDFATHER_BEFORE) continue;

    const content = readIfExists(path.join(repoRoot, planRel));
    if (content == null) continue;

    const anchorRe = /(?:^#{1,6}\s+\*{0,2}关键假设验证|^\*\*关键假设验证\*\*)/m;
    const match = anchorRe.exec(content);
    if (!match) {
      failures.push({ plan: planRel, reason: 'missing「关键假设验证」section' });
      continue;
    }

    const rest = content.slice(match.index + match[0].length);
    const nextHeadingIdx = rest.search(/\n#{1,6}\s/);
    const sectionBody = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx);
    const meaningfulChars = sectionBody.replace(/\s/g, '').length;
    if (meaningfulChars < 100) {
      failures.push({
        plan: planRel,
        reason: `「关键假设验证」section too thin (${meaningfulChars} non-whitespace chars; need ≥100)`,
      });
    }
  }

  return failures;
}

function deriveRepairCommand(mismatches) {
  const cmdNames = [...new Set(mismatches
    .filter((m) => m.kind === 'command')
    .map((m) => path.basename(m.source, '.md')))];
  const ruleNames = [...new Set(mismatches
    .filter((m) => m.kind === 'rule')
    .map((m) => path.basename(m.source, '.md')))];
  const hasOrchestrator = mismatches.some((m) => m.kind === 'orchestrator');

  const parts = [];
  if (cmdNames.length > 0 || ruleNames.length > 0) {
    let propagateArgs = cmdNames.join(' ');
    if (ruleNames.length > 0) {
      propagateArgs += `${cmdNames.length > 0 ? ' ' : ''}--rules ${ruleNames.join(' ')}`;
    }
    parts.push(`node scripts/propagate-command-changes.js ${propagateArgs}`);
  }
  if (cmdNames.length > 0 || hasOrchestrator) {
    parts.push('node plugins/tech-persistence/scripts/build-codex-plugin.js');
  }
  parts.push('node scripts/validate-codex-plugin.js');
  return parts;
}

function formatPropagateError(mismatches) {
  const hasCmd = mismatches.some((m) => m.kind === 'command' || m.kind === 'rule');
  const hasOrch = mismatches.some((m) => m.kind === 'orchestrator');
  let title;
  if (hasCmd && hasOrch) title = '✗ 多副本同步失败: user-level/ 派生 + agent-orchestrator plugin 副本均不一致';
  else if (hasOrch) title = '✗ 多副本同步失败: agent-orchestrator 源与 plugin 副本不一致';
  else title = '✗ Propagate sync 失败: user-level/ 源已改但派生未同步';

  const lines = ['', title, ''];
  for (const m of mismatches) {
    lines.push(`  ${m.source}`);
    lines.push(`    → ${m.derived}`);
    lines.push(`    × ${m.reason}`);
  }
  lines.push('');
  lines.push('  修复（按顺序执行）:');
  for (const cmd of deriveRepairCommand(mismatches)) {
    lines.push(`    ${cmd}`);
  }
  lines.push('  然后 git add 受影响文件后重新 commit');
  lines.push('');
  return lines.join('\n');
}

function formatPlanError(failures) {
  const lines = [
    '',
    '✗ Plan scope lint 失败: 缺少「关键假设验证」段（ADR-012）',
    '',
  ];
  for (const f of failures) {
    lines.push(`  ${f.plan}`);
    lines.push(`    × ${f.reason}`);
  }
  lines.push('');
  lines.push('  修复: 在 plan 的「### 风险和假设」节下添加');
  lines.push('');
  lines.push('    **关键假设验证**（兑现 ADR-012）：');
  lines.push('');
  lines.push('    | 假设 | 验证方式 | 实际 |');
  lines.push('    |------|---------|------|');
  lines.push('    | <你的假设> | Read <文件> 验证 | <实际发现> |');
  lines.push('');
  lines.push('  绕过: git commit --no-verify (不推荐, 失去自动校验)');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const repoRoot = resolveRepoRoot();
  const stagedFiles = getStagedFiles(repoRoot);

  if (stagedFiles.length === 0) {
    process.exit(0);
  }

  const mismatches = [
    ...checkPropagateSync(stagedFiles, repoRoot),
    ...checkOrchestratorSync(stagedFiles, repoRoot),
  ];
  const failures = checkPlanScope(stagedFiles, repoRoot);

  if (mismatches.length === 0 && failures.length === 0) {
    process.exit(0);
  }

  if (mismatches.length > 0) process.stderr.write(formatPropagateError(mismatches));
  if (failures.length > 0) process.stderr.write(formatPlanError(failures));

  process.exit(1);
}

// Hook-level safety net: never lock the user out. Distinguish MISSING_TRANSFORMERS
// from generic errors so structural drift surfaces a real diagnosis, not just a
// generic "ignored" line.
if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (err && err.code === 'MISSING_TRANSFORMERS') {
      process.stderr.write(`[pre-commit] ${err.message}\n[pre-commit] hook 已 fail-open 放行（commit 通过）\n`);
    } else {
      process.stderr.write(`[pre-commit] hook 内部异常已忽略（commit 放行）: ${err && err.message}\n`);
    }
    process.exit(0);
  }
}

module.exports = {
  resolveRepoRoot,
  getStagedFiles,
  loadTransformers,
  checkPropagateSync,
  checkOrchestratorSync,
  checkPlanScope,
  parseFrontmatter,
  deriveRepairCommand,
  formatPropagateError,
  formatPlanError,
  GRANDFATHER_BEFORE,
  ORCHESTRATOR_PATH_RE,
};
