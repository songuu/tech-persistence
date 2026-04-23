# Codex Plugin Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Codex-native `tech-persistence` plugin that preserves the complete Claude Code feature set in Codex.

**Architecture:** Keep the existing Claude Code distribution untouched and add `plugins/tech-persistence/` as a generated Codex plugin package. Shared scripts gain a runtime path resolver so Claude continues to use `~/.claude/homunculus`, while Codex uses `~/.codex/homunculus` or `TECH_PERSISTENCE_HOME`.

**Tech Stack:** Node.js built-ins, PowerShell, Bash, Codex plugin manifest, Markdown slash commands, Codex skills, Codex/Claude-compatible hooks.

**Implementation Status:** `completed` — Tasks 1-10 are implemented, verified, and committed on 2026-04-23.

**Task Completion Status**

- [x] Task 1: Add Codex Plugin Validator
- [x] Task 2: Add Codex Plugin Manifest and Skeleton
- [x] Task 3: Add Runtime Path Resolver
- [x] Task 4: Add Codex Plugin Builder
- [x] Task 5: Add Codex Hooks Configuration
- [x] Task 6: Add Codex Installation Scripts
- [x] Task 7: Add Import and Verification Utilities
- [x] Task 8: Update Documentation
- [x] Task 9: End-to-End Verification
- [x] Task 10: Completion Checklist

**Change Log**

- 2026-04-23: Added a Codex-native `tech-persistence` plugin package with generated commands, skills, hooks, runtime-aware homunculus paths, install flows, Claude data import, validation, and dual-runtime documentation.
- 2026-04-23: Fixed Codex installer parity so `~/.codex` receives the same user-level commands/skills/rules as `~/.claude`, project `.codex` receives command/rule/skill mirrors, and UTF-8/case-sensitive template conversion prevents `.Codex`/`Codex.md` mojibake regressions.
- 2026-04-23: Added repo-root Codex marketplace metadata and installer registration so the plugin is visible and installable from the local Codex marketplace.
- 2026-04-23: Verified current Codex CLI registers plugin workflows through skills, not custom TUI slash commands; generated one Codex skill wrapper per command so workflows are invoked as `$sprint`, `$prototype`, `$plan`, etc., while command markdown remains packaged for compatibility and future support.

---

### Task 1: Add Codex Plugin Validator

**Files:**
- Create: `scripts/validate-codex-plugin.js`
- Test: run `node scripts/validate-codex-plugin.js` before plugin exists

**Step 1: Write the failing validator**

Create `scripts/validate-codex-plugin.js` with these checks:

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const pluginRoot = path.join(root, 'plugins', 'tech-persistence');
const expectedCommands = [
  'checkpoint.md', 'compound.md', 'evolve.md', 'instinct-export.md',
  'instinct-import.md', 'instinct-status.md', 'learn.md', 'plan.md',
  'prototype.md', 'review.md', 'review-learnings.md',
  'session-summary.md', 'skill-diagnose.md', 'skill-eval.md',
  'skill-improve.md', 'skill-publish.md', 'sprint.md', 'test.md',
  'think.md', 'work.md',
];
const expectedSkills = [
  'memory', 'continuous-learning', 'prototype-workflow',
  'test-strategy', 'context-handoff',
];

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
    return null;
  }
}

function exists(file, label = file) {
  if (!fs.existsSync(file)) {
    fail(`${label} missing`);
    return false;
  }
  ok(`${label} exists`);
  return true;
}

if (!exists(pluginRoot, 'plugin root')) process.exit(1);

const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
if (exists(manifestPath, 'plugin manifest')) {
  const manifest = readJson(manifestPath);
  if (manifest) {
    ['name', 'version', 'description', 'skills', 'hooks', 'interface'].forEach((key) => {
      if (!manifest[key]) fail(`manifest missing ${key}`);
    });
    if (manifest.name !== 'tech-persistence') fail('manifest name must be tech-persistence');
  }
}

const commandsDir = path.join(pluginRoot, 'commands');
if (exists(commandsDir, 'commands dir')) {
  expectedCommands.forEach((name) => exists(path.join(commandsDir, name), `command ${name}`));
}

const skillsDir = path.join(pluginRoot, 'skills');
if (exists(skillsDir, 'skills dir')) {
  expectedSkills.forEach((name) => {
    exists(path.join(skillsDir, name, 'SKILL.md'), `skill ${name}`);
  });
}

const hooksPath = path.join(pluginRoot, 'hooks.json');
if (exists(hooksPath, 'hooks.json')) {
  const hooksConfig = readJson(hooksPath);
  const hooks = hooksConfig && hooksConfig.hooks ? hooksConfig.hooks : {};
  ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].forEach((hook) => {
    if (!hooks[hook]) fail(`hooks.json missing ${hook}`);
  });
}

['inject-context.js', 'observe.js', 'evaluate-session.js'].forEach((script) => {
  exists(path.join(pluginRoot, 'hooks', script), `hook script ${script}`);
});

if (process.exitCode) process.exit(process.exitCode);
console.log('[OK] Codex plugin validation passed');
```

**Step 2: Run validator to verify it fails**

Run: `node scripts/validate-codex-plugin.js`

Expected: FAIL with `plugin root missing`.

**Step 3: Commit**

```bash
git add scripts/validate-codex-plugin.js
git commit -m "test: add codex plugin validator"
```

---

### Task 2: Add Codex Plugin Manifest and Skeleton

**Files:**
- Create: `plugins/tech-persistence/.codex-plugin/plugin.json`
- Create: `plugins/tech-persistence/README.md`
- Create: `plugins/tech-persistence/assets/tech-persistence-small.svg`
- Create: `plugins/tech-persistence/assets/tech-persistence.svg`

**Step 1: Create directories**

Create:

```text
plugins/tech-persistence/.codex-plugin/
plugins/tech-persistence/assets/
plugins/tech-persistence/commands/
plugins/tech-persistence/skills/
plugins/tech-persistence/hooks/
plugins/tech-persistence/scripts/
```

**Step 2: Add manifest**

Write `plugins/tech-persistence/.codex-plugin/plugin.json`:

```json
{
  "name": "tech-persistence",
  "version": "1.0.0",
  "description": "Self-evolving engineering persistence system for Codex: workflows, learning, instincts, review, testing, handoff, and Obsidian-compatible knowledge storage.",
  "author": {
    "name": "Tech Persistence",
    "url": "https://github.com/"
  },
  "homepage": "https://github.com/",
  "repository": "https://github.com/",
  "license": "MIT",
  "keywords": [
    "codex",
    "skills",
    "commands",
    "learning",
    "workflow",
    "knowledge-management",
    "obsidian"
  ],
  "skills": "./skills/",
  "hooks": "./hooks.json",
  "interface": {
    "displayName": "Tech Persistence",
    "shortDescription": "Self-evolving workflows and memory for Codex",
    "longDescription": "Use Tech Persistence to run planning, work, review, compound learning, instinct evolution, risk-adaptive testing, context handoff, and Obsidian-compatible knowledge capture directly inside Codex.",
    "developerName": "Tech Persistence",
    "category": "Coding",
    "capabilities": [
      "Interactive",
      "Read",
      "Write"
    ],
    "websiteURL": "https://github.com/",
    "privacyPolicyURL": "https://openai.com/policies/row-privacy-policy/",
    "termsOfServiceURL": "https://openai.com/policies/row-terms-of-use/",
    "defaultPrompt": [
      "Use Tech Persistence to plan this feature",
      "Review this session and compound learnings",
      "Show my Codex knowledge and instincts"
    ],
    "brandColor": "#0F766E",
    "composerIcon": "./assets/tech-persistence-small.svg",
    "logo": "./assets/tech-persistence.svg",
    "screenshots": []
  }
}
```

**Step 3: Add README**

Write a short README with:
- What the plugin includes.
- Codex storage path: `~/.codex/homunculus`.
- Build command: `node plugins/tech-persistence/scripts/build-codex-plugin.js`.
- Validation command: `node scripts/validate-codex-plugin.js`.

**Step 4: Run validator**

Run: `node scripts/validate-codex-plugin.js`

Expected: still FAIL because commands, skills, and hooks are not present yet.

**Step 5: Commit**

```bash
git add plugins/tech-persistence
git commit -m "feat: add codex plugin skeleton"
```

---

### Task 3: Add Runtime Path Resolver

**Files:**
- Create: `scripts/lib/runtime-paths.js`
- Modify: `scripts/inject-context.js`
- Modify: `scripts/observe.js`
- Modify: `scripts/evaluate-session.js`
- Test: run hook scripts with `TECH_PERSISTENCE_RUNTIME=codex`

**Step 1: Add resolver**

Create `scripts/lib/runtime-paths.js`:

```js
const path = require('path');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE;
}

function runtimeFromEnvironment() {
  if (process.env.TECH_PERSISTENCE_RUNTIME) return process.env.TECH_PERSISTENCE_RUNTIME;
  if (process.env.CODEX_HOME) return 'codex';
  if (process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_SESSION_ID) return 'claude';
  return 'claude';
}

function resolveBaseDir() {
  if (process.env.TECH_PERSISTENCE_HOME) return process.env.TECH_PERSISTENCE_HOME;
  const runtime = runtimeFromEnvironment();
  if (runtime === 'codex') {
    const codexHome = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
    return path.join(codexHome, 'homunculus');
  }
  return path.join(homeDir(), '.claude', 'homunculus');
}

function resolveCompatReadDirs() {
  const dirs = [resolveBaseDir()];
  const claudeDir = path.join(homeDir(), '.claude', 'homunculus');
  if (!dirs.includes(claudeDir)) dirs.push(claudeDir);
  return dirs;
}

module.exports = {
  homeDir,
  runtimeFromEnvironment,
  resolveBaseDir,
  resolveCompatReadDirs,
};
```

**Step 2: Update `observe.js`**

Replace hard-coded `path.join(home, '.claude', 'homunculus')` with:

```js
const { resolveBaseDir } = require('./lib/runtime-paths');
const homunculusDir = resolveBaseDir();
```

**Step 3: Update `evaluate-session.js`**

Replace hard-coded homunculus path with `resolveBaseDir()`.

**Step 4: Update `inject-context.js`**

Use `resolveBaseDir()` as primary read path and `resolveCompatReadDirs()` for optional fallback reads from old Claude data.

**Step 5: Run smoke checks**

Run:

```powershell
$env:TECH_PERSISTENCE_RUNTIME='codex'; node scripts/observe.js post
$env:TECH_PERSISTENCE_RUNTIME='codex'; node scripts/inject-context.js
$env:TECH_PERSISTENCE_RUNTIME='codex'; node scripts/evaluate-session.js
```

Expected: no crash; files appear under `~/.codex/homunculus` if observations are recorded.

**Step 6: Commit**

```bash
git add scripts/lib/runtime-paths.js scripts/inject-context.js scripts/observe.js scripts/evaluate-session.js
git commit -m "feat: add runtime-aware homunculus paths"
```

---

### Task 4: Add Codex Plugin Builder

**Files:**
- Create: `plugins/tech-persistence/scripts/build-codex-plugin.js`
- Modify generated content under `plugins/tech-persistence/commands/`
- Modify generated content under `plugins/tech-persistence/skills/`
- Modify generated content under `plugins/tech-persistence/hooks/`

**Step 1: Write builder script**

Create a Node script that:
- Copies every `user-level/commands/*.md` into `plugins/tech-persistence/commands/`.
- Copies every `user-level/skills/*/SKILL.md` into `plugins/tech-persistence/skills/*/SKILL.md`.
- Copies `scripts/inject-context.js`, `scripts/observe.js`, `scripts/evaluate-session.js` into `plugins/tech-persistence/hooks/`.
- Copies `scripts/lib/runtime-paths.js` into `plugins/tech-persistence/hooks/lib/runtime-paths.js`.
- Copies `user-level/homunculus/config.json` into `plugins/tech-persistence/codex-homunculus-template/config.json`.
- Applies text replacements for Codex paths.

Use this replacement map:

```js
const replacements = [
  [/~\/\.claude\/homunculus/g, '~/.codex/homunculus'],
  [/`~\/\.claude\/homunculus/g, '`~/.codex/homunculus'],
  [/~\/\.claude\/commands/g, '~/.codex commands via Tech Persistence plugin'],
  [/Claude Code/g, 'Codex'],
  [/Claude/g, 'Codex'],
  [/\.claude\/rules/g, '.codex/rules'],
  [/\.claude\/plans/g, '.codex/plans'],
];
```

**Step 2: Run builder**

Run: `node plugins/tech-persistence/scripts/build-codex-plugin.js`

Expected:
- 20 command files generated.
- 5 skill files generated.
- 3 hook scripts and `hooks/lib/runtime-paths.js` generated.

**Step 3: Run validator**

Run: `node scripts/validate-codex-plugin.js`

Expected: still FAIL until `hooks.json` exists.

**Step 4: Commit**

```bash
git add plugins/tech-persistence
git commit -m "feat: generate codex plugin assets"
```

---

### Task 5: Add Codex Hooks Configuration

**Files:**
- Create: `plugins/tech-persistence/hooks.json`
- Create: `plugins/tech-persistence/hooks/run-hook.cmd`

**Step 1: Add `hooks.json`**

Write:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" inject-context.js",
            "async": false,
            "timeout": 5000
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" observe.js pre",
            "async": true,
            "timeout": 2000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" observe.js post",
            "async": true,
            "timeout": 2000
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" evaluate-session.js",
            "async": false,
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

**Step 2: Add Windows-safe wrapper**

Write `plugins/tech-persistence/hooks/run-hook.cmd`:

```cmd
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_NAME=%~1"
shift /1
set "TECH_PERSISTENCE_RUNTIME=codex"
node "%SCRIPT_DIR%%SCRIPT_NAME%" %*
exit /b 0
```

**Step 3: Run validator**

Run: `node scripts/validate-codex-plugin.js`

Expected: PASS for manifest, commands, skills, hooks, and hook scripts.

**Step 4: Commit**

```bash
git add plugins/tech-persistence/hooks.json plugins/tech-persistence/hooks/run-hook.cmd
git commit -m "feat: add codex hook configuration"
```

---

### Task 6: Add Codex Installation Scripts

**Files:**
- Create: `install-codex.ps1`
- Create: `install-codex.sh`
- Modify: `scripts/preflight.js`

**Step 1: Write PowerShell installer**

Implement `install-codex.ps1` with switches:

```powershell
param(
  [switch]$User,
  [switch]$Project,
  [switch]$All,
  [switch]$ImportClaude,
  [switch]$Help
)
```

Behavior:
- `-User`: copy `plugins/tech-persistence` to `$HOME\plugins\tech-persistence`; update `$HOME\.agents\plugins\marketplace.json`.
- `-Project`: create `.codex/rules`, `.codex/plans`, `docs/solutions`, and copy project templates.
- `-All`: run User and Project.
- `-ImportClaude`: copy `$HOME\.claude\homunculus` into `$HOME\.codex\homunculus` if target does not exist.

Marketplace entry:

```json
{
  "name": "tech-persistence",
  "source": {
    "source": "local",
    "path": "./plugins/tech-persistence"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Coding"
}
```

**Step 2: Write Bash installer**

Implement equivalent behavior in `install-codex.sh`.

**Step 3: Extend preflight**

Add `--codex` mode to `scripts/preflight.js`:
- Check Node.js >= 18.
- Check Git.
- Warn if `codex` CLI is not found.
- Check `~/.codex` and `~/.agents/plugins` writability.
- Check existing marketplace entry for `tech-persistence`.

**Step 4: Run local validation**

Run:

```powershell
node scripts/preflight.js --codex
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -Help
bash install-codex.sh --help
```

Expected: commands print help/preflight without modifying user plugin directories.

**Step 5: Commit**

```bash
git add install-codex.ps1 install-codex.sh scripts/preflight.js
git commit -m "feat: add codex installation flow"
```

---

### Task 7: Add Import and Verification Utilities

**Files:**
- Create: `plugins/tech-persistence/scripts/import-claude-homunculus.js`
- Modify: `scripts/validate-codex-plugin.js`

**Step 1: Add import utility**

Create script that:
- Reads source from `--from`, default `~/.claude/homunculus`.
- Writes target from `--to`, default `~/.codex/homunculus`.
- Refuses to overwrite unless `--force`.
- Copies only data files and directories, excluding transient lock files.

**Step 2: Add validator checks**

Extend validator to check:
- `plugins/tech-persistence/scripts/import-claude-homunculus.js` exists.
- `plugins/tech-persistence/codex-homunculus-template/config.json` exists.
- Generated hook scripts do not contain `'.claude', 'homunculus'` hard-coded as primary path.

**Step 3: Run import dry run**

Run:

```powershell
node plugins/tech-persistence/scripts/import-claude-homunculus.js --dry-run
node scripts/validate-codex-plugin.js
```

Expected: dry run reports planned copy; validator passes.

**Step 4: Commit**

```bash
git add plugins/tech-persistence/scripts/import-claude-homunculus.js scripts/validate-codex-plugin.js
git commit -m "feat: add codex homunculus import utility"
```

---

### Task 8: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-04-23-codex-plugin-support-design.md`
- Modify: `docs/plans/2026-04-23-codex-plugin-support.md`

**Step 1: Update README title and summary**

Change from Claude-only wording to dual runtime wording:

```md
# Claude Code / Codex 自进化工程系统
```

Mention:
- Claude Code install remains `install.ps1` / `install.sh`.
- Codex install uses `install-codex.ps1` / `install-codex.sh`.
- Codex plugin path is `plugins/tech-persistence/`.

**Step 2: Add Codex installation section**

Add:

```powershell
node scripts\preflight.js --codex
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All
```

```bash
node scripts/preflight.js --codex
bash install-codex.sh --all
```

**Step 3: Update directory structure**

Add:

```text
plugins/tech-persistence/
├── .codex-plugin/plugin.json
├── commands/
├── skills/
├── hooks.json
└── hooks/
```

**Step 4: Update design and plan progress**

Mark design status as `in-progress` once implementation begins.

**Step 5: Run validation**

Run:

```powershell
node scripts/validate-codex-plugin.js
node scripts/preflight.js --codex
```

Expected: validation passes; preflight has no blocking errors.

**Step 6: Commit**

```bash
git add README.md docs/plans/2026-04-23-codex-plugin-support-design.md docs/plans/2026-04-23-codex-plugin-support.md
git commit -m "docs: document codex plugin support"
```

---

### Task 9: End-to-End Verification

**Files:**
- No source changes expected unless verification finds bugs.

**Step 1: Rebuild plugin**

Run:

```powershell
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
```

Expected: generated content is current and validation passes.

**Step 2: Run Codex runtime hook smoke tests**

Run:

```powershell
$env:TECH_PERSISTENCE_RUNTIME='codex'
node plugins/tech-persistence/hooks/observe.js post
node plugins/tech-persistence/hooks/inject-context.js
node plugins/tech-persistence/hooks/evaluate-session.js
```

Expected: scripts exit 0 and do not write to `~/.claude/homunculus` as primary target.

**Step 3: Run install help checks**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -Help
bash install-codex.sh --help
```

Expected: both print usage.

**Step 4: Inspect generated diff**

Run: `git status --short`

Expected: no unexpected generated changes after rebuild.

**Step 5: Commit fixes if needed**

If verification required changes:

```bash
git add <changed-files>
git commit -m "fix: stabilize codex plugin verification"
```

---

### Task 10: Completion Checklist

**Files:**
- Modify: `docs/plans/2026-04-23-codex-plugin-support.md`

**Step 1: Mark implementation plan status**

Set completed tasks in this plan and append a change log entry.

**Step 2: Run final verification**

Run:

```powershell
node scripts/validate-codex-plugin.js
node scripts/preflight.js --codex
git status --short
```

Expected:
- Validator passes.
- Preflight has no blocking errors.
- Worktree contains only intentional plan status updates or is clean.

**Step 3: Final commit**

```bash
git add docs/plans/2026-04-23-codex-plugin-support.md
git commit -m "docs: complete codex plugin support plan"
```
