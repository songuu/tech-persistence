'use strict';

const fs = require('fs');
const path = require('path');

const MAX_COMMAND_LENGTH = 8 * 1024;
const SHELL_META = /[;|&><`^\0]|\$\(|\r|\n/;
const DISALLOWED_ACTION = /(?:^|[/\\._:@=-])(deploy(?:ment)?|release|publish|install|prepare|postinstall|migrat(?:e|ion)|seed|reset|destroy|push)(?=$|[/\\._:@=-])/i;

function splitArgv(command) {
  const text = String(command || '').trim();
  if (!text) return [];

  const argv = [];
  let token = '';
  let tokenStarted = false;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (char === '\\' && text[index + 1] === quote) {
        token += quote;
        tokenStarted = true;
        index += 1;
        continue;
      }
      token += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        argv.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) throw new Error(`validation command has an unmatched ${quote} quote`);
  if (tokenStarted) argv.push(token);
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

function realPathInside(root, candidate) {
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch (_) {
    return false;
  }
}

function isRepoScript(workdir, scriptPath) {
  if (!scriptPath || scriptPath.startsWith('-') || path.isAbsolute(scriptPath)) return false;
  const root = path.resolve(workdir);
  const absolute = path.resolve(root, scriptPath);
  if (!realPathInside(root, absolute)) return false;
  try {
    return fs.statSync(absolute).isFile();
  } catch (_) {
    return false;
  }
}

function containsDisallowedAction(value) {
  return DISALLOWED_ACTION.test(String(value || ''));
}

function rejection(command, code, reason, argv = []) {
  return { ok: false, command, argv, code, reason };
}

function packageScriptName(argv) {
  const args = argv.slice(1);
  let scriptName = null;
  if (args[0] === 'test') scriptName = 'test';
  if (args[0] === 'run' && args[1] && !args[1].startsWith('-')) scriptName = args[1];
  if (args[0] === 'run' && args[1] === '--' && args[2]) scriptName = args[2];
  return scriptName;
}

function packageScriptSafety(scriptName, scripts, seen = new Set()) {
  if (seen.has(scriptName)) {
    return { ok: false, code: 'package-script-cycle', reason: `contains a package-script cycle at ${scriptName}` };
  }
  const nextSeen = new Set(seen);
  nextSeen.add(scriptName);

  const scriptBody = String(scripts[scriptName] || '').trim();
  if (!scriptBody) {
    return { ok: false, code: 'empty-package-script', reason: 'has an empty command body' };
  }
  if (SHELL_META.test(scriptBody)) {
    return { ok: false, code: 'unsafe-package-script', reason: 'uses forbidden shell operators' };
  }

  let bodyArgv;
  try {
    bodyArgv = splitArgv(scriptBody);
  } catch (error) {
    return { ok: false, code: 'invalid-package-script', reason: error.message };
  }
  const unsafeToken = bodyArgv.find((item) => containsDisallowedAction(item));
  if (unsafeToken) {
    return {
      ok: false,
      code: 'disallowed-action',
      reason: `invokes forbidden action ${unsafeToken}`,
    };
  }

  const [executable, ...args] = bodyArgv;
  const normalized = String(executable || '').toLowerCase();
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(normalized)) {
    const nestedName = packageScriptName(bodyArgv);
    if (!nestedName || !Object.prototype.hasOwnProperty.call(scripts, nestedName)) {
      return {
        ok: false,
        code: 'undeclared-package-script',
        reason: `references an undeclared package script via ${scriptBody}`,
      };
    }
    if (containsDisallowedAction(nestedName)) {
      return { ok: false, code: 'disallowed-action', reason: `references forbidden package script ${nestedName}` };
    }
    return packageScriptSafety(nestedName, scripts, nextSeen);
  }
  if (normalized === 'node') {
    const unsafeNodeFlag = args.find((item) => ['-e', '--eval', '-p', '--print'].includes(item));
    if (unsafeNodeFlag) {
      return { ok: false, code: 'unsafe-node-flag', reason: `uses forbidden Node flag ${unsafeNodeFlag}` };
    }
    if (args.length === 0) {
      return { ok: false, code: 'invalid-package-script', reason: 'does not identify a repository command' };
    }
    return { ok: true };
  }
  if (normalized === 'git' && args.length === 2 && args[0] === 'diff' && args[1] === '--check') {
    return { ok: true };
  }
  return {
    ok: false,
    code: 'package-script-executable-not-allowed',
    reason: `uses executable ${executable || '<empty>'} outside the validation allowlist`,
  };
}

function scriptInvocation(command, argv, scripts) {
  const executable = argv[0];
  const scriptName = packageScriptName(argv);
  if (!scriptName || !Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
    return rejection(
      command,
      'undeclared-package-script',
      `${executable} command must reference a declared package script`,
      argv
    );
  }
  if (containsDisallowedAction(scriptName)) {
    return rejection(
      command,
      'disallowed-action',
      `package script ${scriptName} is not eligible for model-generated validation`,
      argv
    );
  }

  const safety = packageScriptSafety(scriptName, scripts);
  if (!safety.ok) {
    return rejection(
      command,
      safety.code,
      `package script ${scriptName} ${safety.reason}`,
      argv
    );
  }
  return { ok: true, scriptName };
}

function validateGeneratedValidationCommand(command, { workdir } = {}) {
  const text = String(command || '').trim();
  if (!text) return rejection(text, 'empty-command', 'validation command is empty');
  if (text.length > MAX_COMMAND_LENGTH) {
    return rejection(text, 'command-too-long', `validation command exceeds ${MAX_COMMAND_LENGTH} characters`);
  }
  if (SHELL_META.test(text)) {
    return rejection(
      text,
      'shell-meta',
      'shell operators and substitutions are forbidden in model-generated validation'
    );
  }

  let argv;
  try {
    argv = splitArgv(text);
  } catch (error) {
    return rejection(text, 'invalid-argv', error.message);
  }
  if (argv.length === 0) {
    return rejection(text, 'empty-argv', 'validation command has no executable');
  }
  const unsafeToken = argv.find((item) => containsDisallowedAction(item));
  if (unsafeToken) {
    return rejection(
      text,
      'disallowed-action',
      `validation argument ${unsafeToken} contains a forbidden deploy, publish, migration, install, seed, or reset action`,
      argv
    );
  }

  const [executable, ...args] = argv;
  const normalized = executable.toLowerCase();
  const root = path.resolve(workdir || process.cwd());
  const scripts = packageScripts(root);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(normalized)) {
    const script = scriptInvocation(text, argv, scripts);
    return script.ok
      ? {
          ok: true,
          command: text,
          argv,
          kind: 'package-script',
          scriptName: script.scriptName,
        }
      : script;
  }
  if (normalized === 'node' && args.length >= 1 && isRepoScript(root, args[0])) {
    return {
      ok: true,
      command: text,
      argv,
      kind: 'repo-node-script',
      scriptPath: args[0],
    };
  }
  if (normalized === 'git' && args.length === 2 && args[0] === 'diff' && args[1] === '--check') {
    return { ok: true, command: text, argv, kind: 'git-diff-check' };
  }
  return rejection(
    text,
    'executable-not-allowed',
    `executable ${executable} is not in the generated-validation allowlist; use a declared package script, repository Node script, or git diff --check`,
    argv
  );
}

module.exports = {
  MAX_COMMAND_LENGTH,
  splitArgv,
  validateGeneratedValidationCommand,
};
