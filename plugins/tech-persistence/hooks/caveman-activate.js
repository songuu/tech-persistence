#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MODE = 'full';
const VALID_MODES = new Set([
  'off',
  'lite',
  'full',
  'ultra',
  'wenyan-lite',
  'wenyan',
  'wenyan-full',
  'wenyan-ultra',
]);

function readConfigMode() {
  const configPath = path.join(os.homedir(), '.config', 'caveman', 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.defaultMode || null;
  } catch {
    return null;
  }
}

function resolveMode() {
  const requested = process.env.CAVEMAN_DEFAULT_MODE || readConfigMode() || DEFAULT_MODE;
  const normalized = String(requested).trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : DEFAULT_MODE;
}

function modeRules(mode) {
  if (mode === 'lite') return 'Lite: drop filler and hedging. Keep normal grammar.';
  if (mode === 'ultra') return 'Ultra: maximum compression. Fragments, abbreviations, arrows when clear.';
  if (mode === 'wenyan' || mode === 'wenyan-full') return 'Wenyan: classical Chinese compression when Chinese is appropriate.';
  if (mode === 'wenyan-lite') return 'Wenyan-lite: semi-classical Chinese, readable but compact.';
  if (mode === 'wenyan-ultra') return 'Wenyan-ultra: maximum classical terseness.';
  return 'Full: drop articles/filler/pleasantries/hedging. Fragments OK.';
}

function main() {
  const mode = resolveMode();
  if (mode === 'off') return;

  const context = `<caveman-mode source="tech-persistence-v7" mode="${mode}">
CAVEMAN MODE ACTIVE.
Rules: ${modeRules(mode)}
Keep technical substance exact. Keep user's language: Chinese request -> Chinese answer.
Pattern: [thing] [action] [reason]. [next step].
Drop: filler, pleasantries, hedging, redundant setup.
Preserve: code blocks, commands, file paths, errors, API names, security meaning.
Code/commits/PRs: normal required format; use caveman only where safe.
Auto-clarity: security warnings, irreversible actions, complex multi-step sequences, or user confusion -> use normal clear prose, then resume terse mode.
Manual off: user says "stop caveman" or "normal mode".
</caveman-mode>`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      additionalContext: context,
    },
  }));
}

try {
  main();
} catch (error) {
  try {
    process.stderr.write(`[caveman-activate] hook failed: ${error && error.message ? error.message : error}\n`);
  } catch {}
  process.exit(0);
}
