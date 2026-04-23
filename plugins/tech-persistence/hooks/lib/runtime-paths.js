const path = require('path');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE;
}

function runtimeFromEnvironment() {
  if (process.env.TECH_PERSISTENCE_RUNTIME) {
    return process.env.TECH_PERSISTENCE_RUNTIME.toLowerCase();
  }
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

function resolveProjectDirName() {
  return runtimeFromEnvironment() === 'codex' ? '.codex' : '.claude';
}

function resolveProjectPlansDir(cwd = process.cwd()) {
  return path.join(cwd, resolveProjectDirName(), 'plans');
}

function resolveProjectRulesDir(cwd = process.cwd()) {
  return path.join(cwd, resolveProjectDirName(), 'rules');
}

function resolveProjectInstructionFile(cwd = process.cwd()) {
  return runtimeFromEnvironment() === 'codex'
    ? path.join(cwd, 'AGENTS.md')
    : path.join(cwd, 'AGENTS.md');
}

function resolveSessionId(options = {}) {
  const fallback = options.fallback !== false;
  const sessionId = process.env.CODEX_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  return sessionId || (fallback ? `s-${Date.now()}` : undefined);
}

module.exports = {
  homeDir,
  runtimeFromEnvironment,
  resolveBaseDir,
  resolveCompatReadDirs,
  resolveProjectPlansDir,
  resolveProjectRulesDir,
  resolveProjectInstructionFile,
  resolveSessionId,
};
