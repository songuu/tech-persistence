#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveCodexInvocation(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  const fileExists = options.existsSync || fs.existsSync;
  const nodeExecutable = options.execPath || process.execPath;
  const userHome = environment.USERPROFILE || environment.HOME || null;
  const codexHome = options.codexHome
    || environment.CODEX_HOME
    || (userHome ? path.join(userHome, '.codex') : null);
  const pluginAppserverCli = platform === 'win32' && codexHome
    ? path.join(codexHome, 'plugins', '.plugin-appserver', 'codex.exe')
    : null;
  if (pluginAppserverCli && fileExists(pluginAppserverCli)) {
    return {
      command: pluginAppserverCli,
      argsPrefix: [],
      source: 'windows-plugin-appserver-cli',
    };
  }

  const npmCli = platform === 'win32' && environment.APPDATA
    ? path.join(
      environment.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js'
    )
    : null;
  if (npmCli && fileExists(npmCli)) {
    return { command: nodeExecutable, argsPrefix: [npmCli], source: 'windows-npm-cli' };
  }
  return { command: 'codex', argsPrefix: [], source: 'path-fallback' };
}

function defaultRunCodex(args, options = {}) {
  const invocation = resolveCodexInvocation(options);
  const spawn = options.spawnSync || spawnSync;
  return spawn(invocation.command, [...invocation.argsPrefix, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

module.exports = {
  defaultRunCodex,
  resolveCodexInvocation,
};
