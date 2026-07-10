'use strict';

const fs = require('fs');
const path = require('path');

const SHELL_META = /[;|&><`]|\$\(|\r|\n/;
const DISALLOWED_SCRIPT = /(?:^|[-_:])(deploy|release|publish|install|prepare|postinstall|migrate|seed|reset|destroy|push)(?:$|[-_:])/i;

function splitArgv(command) {
  const text = String(command || '').trim();
  if (!text) return [];
  const argv = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    argv.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  return argv;
}

function packageScripts(workdir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workdir, 'package.json'), 'utf8'));
    return pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch (_) {
    return {};
  }
}

function isRepoScript(workdir, scriptPath) {
  if (!scriptPath || path.isAbsolute(scriptPath)) return false;
  const root = path.resolve(workdir);
  const absolute = path.resolve(root, scriptPath);
  const relative = path.relative(root, absolute);
  return !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(absolute) && fs.statSync(absolute).isFile();
}

function scriptInvocation(argv, scripts) {
  const executable = argv[0];
  const args = argv.slice(1);
  let scriptName = null;
  if (args[0] === 'test') scriptName = 'test';
  if (args[0] === 'run' && args[1] && !args[1].startsWith('-')) scriptName = args[1];
  if (args[0] === 'run' && args[1] === '--' && args[2]) scriptName = args[2];
  if (!scriptName || !Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
    return { ok: false, reason: `${executable} command must reference a declared package script` };
  }
  if (DISALLOWED_SCRIPT.test(scriptName)) {
    return { ok: false, reason: `package script ${scriptName} is not eligible for model-generated validation` };
  }
  return { ok: true, scriptName };
}

function validateGeneratedValidationCommand(command, { workdir } = {}) {
  const text = String(command || '').trim();
  if (!text) return { ok: false, command: text, reason: 'validation command is empty' };
  if (SHELL_META.test(text)) {
    return { ok: false, command: text, reason: 'shell operators and substitutions are forbidden in model-generated validation' };
  }
  const argv = splitArgv(text);
  if (argv.length === 0) return { ok: false, command: text, reason: 'validation command has no executable' };
  const [executable, ...args] = argv;
  const normalized = executable.toLowerCase();
  const scripts = packageScripts(workdir || process.cwd());
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(normalized)) {
    const script = scriptInvocation(argv, scripts);
    return script.ok
      ? { ok: true, command: text, argv, kind: 'package-script', scriptName: script.scriptName }
      : { ok: false, command: text, reason: script.reason };
  }
  if (normalized === 'node' && args.length >= 1 && isRepoScript(workdir || process.cwd(), args[0])) {
    return { ok: true, command: text, argv, kind: 'repo-node-script', scriptPath: args[0] };
  }
  if (normalized === 'git' && args.length === 2 && args[0] === 'diff' && args[1] === '--check') {
    return { ok: true, command: text, argv, kind: 'git-diff-check' };
  }
  return { ok: false, command: text, reason: `executable ${executable} is not in the generated-validation allowlist` };
}

module.exports = { splitArgv, validateGeneratedValidationCommand };