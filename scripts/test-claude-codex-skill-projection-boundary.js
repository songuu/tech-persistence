#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const builder = require(path.join(
  root,
  'plugins',
  'tech-persistence',
  'scripts',
  'build-codex-plugin.js'
));

function listSkillNames(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && fs.existsSync(path.join(rootDir, entry.name, 'SKILL.md'))
    ))
    .map((entry) => entry.name)
    .sort();
}

function main() {
  assert.strictEqual(typeof builder.copySkills, 'function', 'copySkills must be testable');
  assert.strictEqual(typeof builder.copyCodexSkills, 'function', 'copyCodexSkills must be testable');

  const temporaryPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runtime-skill-projection-'));
  try {
    builder.copyCommands(temporaryPluginRoot);
    builder.copySkills(temporaryPluginRoot);

    const commandNames = builder.expectedCommands
      .map((name) => path.basename(name, '.md'))
      .sort();
    const expectedClaudeSkills = [...new Set([
      ...builder.expectedSkills,
      ...commandNames,
    ])].sort();
    const claudeSkills = listSkillNames(path.join(temporaryPluginRoot, 'skills'));

    assert.deepStrictEqual(
      claudeSkills,
      expectedClaudeSkills,
      'Claude skills must include every canonical skill and command wrapper'
    );
    const emptyClaudeSkillDirs = fs.readdirSync(path.join(temporaryPluginRoot, 'skills'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !fs.existsSync(path.join(
        temporaryPluginRoot,
        'skills',
        entry.name,
        'SKILL.md'
      )))
      .map((entry) => entry.name)
      .sort();
    assert.deepStrictEqual(
      emptyClaudeSkillDirs,
      [],
      'Claude skills projection must not contain empty skill directories'
    );
    assert.deepStrictEqual(
      fs.readdirSync(path.join(temporaryPluginRoot, 'commands')),
      [],
      'Claude plugin staging must retire every flat command file'
    );
    for (const skillName of builder.expectedSkills) {
      const sourceSkill = fs.readFileSync(
        path.join(root, 'user-level', 'skills', skillName, 'SKILL.md')
      );
      const projectedSkill = fs.readFileSync(
        path.join(temporaryPluginRoot, 'skills', skillName, 'SKILL.md')
      );
      assert.deepStrictEqual(
        projectedSkill,
        sourceSkill,
        `Claude skill must preserve native source bytes: ${skillName}`
      );
    }
    for (const commandName of commandNames) {
      const sourceCommand = fs.readFileSync(
        path.join(root, 'user-level', 'commands', `${commandName}.md`),
        'utf8'
      );
      const projectedCommandSkill = fs.readFileSync(
        path.join(temporaryPluginRoot, 'skills', commandName, 'SKILL.md'),
        'utf8'
      );
      assert.strictEqual(
        projectedCommandSkill,
        builder.normalizeLf(sourceCommand),
        `Claude command skill must match its canonical command source: ${commandName}`
      );
    }

    builder.copyCodexSkills(temporaryPluginRoot);

    const codexSkills = listSkillNames(path.join(temporaryPluginRoot, 'codex-skills'));
    assert.deepStrictEqual(
      codexSkills,
      [...new Set([...builder.expectedSkills, ...commandNames])].sort(),
      'Codex skills must retain every real skill and command wrapper'
    );
    for (const commandName of commandNames) {
      assert(
        fs.existsSync(path.join(temporaryPluginRoot, 'codex-skills', commandName, 'SKILL.md')),
        `missing Codex command wrapper: ${commandName}`
      );
    }

    const fallbackWrapper = fs.readFileSync(
      path.join(temporaryPluginRoot, 'codex-skills', 'test', 'SKILL.md'),
      'utf8'
    );
    assert.match(fallbackWrapper, /^---\nname: test\n/m);
    assert.match(fallbackWrapper, /Codex-compatible entry point for the former \/test command/);

    const agentLoopWrapper = fs.readFileSync(
      path.join(temporaryPluginRoot, 'codex-skills', 'agent-loop', 'SKILL.md'),
      'utf8'
    );
    assert.match(agentLoopWrapper, /Codex × Claude Code 双原生编排/);
    assert.match(agentLoopWrapper, /Claude Code 只负责需求分析、技术设计、任务拆解和只读复审/);
    assert.match(agentLoopWrapper, /Codex 默认通过 `exec` adapter 按冻结 spec 实现/);
    assert.doesNotMatch(agentLoopWrapper, /Codex × Codex|Codex 只负责需求分析/);

    const contextHandoffSource = fs.readFileSync(
      path.join(root, 'user-level', 'skills', 'context-handoff', 'SKILL.md'),
      'utf8'
    );
    const claudeContextHandoff = fs.readFileSync(
      path.join(temporaryPluginRoot, 'skills', 'context-handoff', 'SKILL.md'),
      'utf8'
    );
    const codexContextHandoff = fs.readFileSync(
      path.join(temporaryPluginRoot, 'codex-skills', 'context-handoff', 'SKILL.md'),
      'utf8'
    );
    assert.strictEqual(claudeContextHandoff, contextHandoffSource);
    assert.strictEqual(
      codexContextHandoff,
      builder.normalizeLf(builder.transform(contextHandoffSource)),
      'Codex fallback skill must be transformed from the canonical Claude source'
    );
  } finally {
    fs.rmSync(temporaryPluginRoot, { recursive: true, force: true });
  }

  console.log('[OK] Claude/Codex skill projection boundary tests passed');
}

main();
