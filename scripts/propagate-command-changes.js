#!/usr/bin/env node

/**
 * Propagate user-level/commands/*.md changes to:
 *  - plugins/tech-persistence/commands/*.md (verbatim)
 *  - .codex/commands/*.md (native thin entry for think/plan/work/review/compound/sprint; regex otherwise)
 *  - plugins/tech-persistence/codex-skills/* (rebuilt projection)
 *
 * Claude plugin skills are independent canonical skills and are never derived
 * from commands. Command wrappers exist only in the Codex projection.
 *
 * Also copies user-level/rules/<rule>.md to .codex/rules/<rule>.md for any rule
 * passed via --rules flag.
 *
 * Usage:
 *   node scripts/propagate-command-changes.js sprint work plan review think agent-loop test prototype evolve
 *   node scripts/propagate-command-changes.js --rules auto-mode
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const buildCodexPlugin = require(path.join(repoRoot, 'plugins', 'tech-persistence', 'scripts', 'build-codex-plugin.js'));
const nativeCommandNames = new Set(['compound', 'plan', 'review', 'sprint', 'think', 'work']);

const codexReplacements = [
  [/在 Claude Code runtime 下/g, '在支持 Agent spawn 的 runtime 下'],
  [/Claude Code runtime 下/g, '支持 Agent spawn 的 runtime 下'],
  [/仅对 Claude Code runtime 生效/g, '仅对支持 Agent spawn 的 runtime 生效'],
  [/Claude Code SlashCommand/g, 'non-Codex slash command'],
  [/CLAUDE\.md \/ AGENTS\.md/g, 'runtime instruction docs'],
  [/CLAUDE\.md \+ AGENTS\.md/g, 'runtime instruction docs'],
  [/CLAUDE-solutions-index/g, 'AGENTS-solutions-index'],
  [/node scripts\/archive-claude-solutions-index\.js/g, 'node scripts/archive-claude-solutions-index.js --claude-md AGENTS.md'],
  [/~\/\.claude\/homunculus/g, '~/.codex/homunculus'],
  [/~\/\.claude\/CLAUDE\.md/g, '~/.codex/AGENTS.md'],
  [/~\/\.claude\/rules/g, '~/.codex/rules'],
  [/~\/\.claude\/commands/g, '~/.codex/commands'],
  [/~\/\.claude\/skills/g, '~/.codex/skills'],
  [/CLAUDE_PROJECT_DIR/g, 'CODEX_PROJECT_DIR'],
  [/CLAUDE\.md/g, 'AGENTS.md'],
  [/\.claude\/commands/g, '.codex/commands'],
  [/\.claude\/skills/g, '.codex/skills'],
  [/\.claude\/rules/g, '.codex/rules'],
  [/\.claude\/plans/g, '.codex/plans'],
  [/\.claude\b/g, '.codex'],
  [/Claude Code/g, 'Codex'],
  [/Claude/g, 'Codex'],
];

function applyCodexRegex(text) {
  return codexReplacements.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function codexCommandContent(name, sourceText) {
  if (!nativeCommandNames.has(name)) return applyCodexRegex(sourceText);
  return readText(path.join(repoRoot, 'codex-native', 'commands', `${name}.md`));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function injectIntoSkillWrapper(skillContent, newCommandBody) {
  const marker = '## Command Instructions';
  const idx = skillContent.indexOf(marker);
  if (idx === -1) return null;
  const header = skillContent.slice(0, idx + marker.length);
  return `${header}\n\n${stripFrontmatter(newCommandBody).trimStart()}\n`;
}

function commandSkillWrapper(name, sourceText) {
  return buildCodexPlugin.commandToSkill(`${name}.md`, sourceText);
}

function stripFrontmatter(content) {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

function propagateCommand(name) {
  const sourcePath = path.join(repoRoot, 'user-level', 'commands', `${name}.md`);
  if (!fs.existsSync(sourcePath)) {
    console.warn(`[skip] no user-level source for ${name}`);
    return;
  }
  const sourceText = readText(sourcePath);

  const targets = [
    {
      label: 'plugin command',
      path: path.join(repoRoot, 'plugins', 'tech-persistence', 'commands', `${name}.md`),
      transform: (text) => text,
    },
    {
      label: 'codex command',
      path: path.join(repoRoot, '.codex', 'commands', `${name}.md`),
      transform: (text) => codexCommandContent(name, text),
    },
  ];

  for (const target of targets) {
    if (!fs.existsSync(path.dirname(target.path))) {
      console.warn(`[skip] ${target.label} dir missing for ${name}`);
      continue;
    }
    writeText(target.path, target.transform(sourceText));
    console.log(`[ok]   ${target.label}: ${path.relative(repoRoot, target.path)}`);
  }

  buildCodexPlugin.syncCodexSkill(name);
  console.log(`[ok]   codex skill projection: plugins/tech-persistence/codex-skills/${name}`);
}

function propagateRule(name) {
  const sourcePath = path.join(repoRoot, 'user-level', 'rules', `${name}.md`);
  if (!fs.existsSync(sourcePath)) {
    console.warn(`[skip] no user-level rule for ${name}`);
    return;
  }
  const text = readText(sourcePath);
  const codexTarget = path.join(repoRoot, '.codex', 'rules', `${name}.md`);
  writeText(codexTarget, applyCodexRegex(text));
  console.log(`[ok]   codex rule: ${path.relative(repoRoot, codexTarget)}`);
}

function main() {
  const args = process.argv.slice(2);
  const rules = [];
  const commands = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--rules') {
      while (++i < args.length && !args[i].startsWith('--')) rules.push(args[i]);
      i -= 1;
    } else {
      commands.push(args[i]);
    }
  }
  if (commands.length === 0 && rules.length === 0) {
    console.error('Usage: propagate-command-changes.js <cmd>... [--rules <rule>...]');
    process.exit(1);
  }
  for (const cmd of commands) propagateCommand(cmd);
  for (const rule of rules) propagateRule(rule);
}

if (require.main === module) main();

module.exports = {
  applyCodexRegex,
  codexCommandContent,
  nativeCommandNames,
  injectIntoSkillWrapper,
  commandSkillWrapper,
  stripFrontmatter,
  propagateCommand,
  propagateRule,
};
