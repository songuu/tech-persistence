const path = require('path');
const fs = require('fs');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE;
}

function expandHome(value) {
  if (!value) return value;
  const home = homeDir();
  if (!home) return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function resolveUserPath(value) {
  return path.resolve(expandHome(value));
}

function defaultConfigPath() {
  return path.join(homeDir(), '.tech-persistence', 'config.json');
}

function resolveConfigPath() {
  return process.env.TECH_PERSISTENCE_CONFIG
    ? resolveUserPath(process.env.TECH_PERSISTENCE_CONFIG)
    : defaultConfigPath();
}

function readSharedConfig() {
  const configPath = resolveConfigPath();
  if (!configPath || !fs.existsSync(configPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveConfiguredBaseDir() {
  const config = readSharedConfig();
  if (!config) return null;
  const configuredPath = config.homunculusHome || config.homunculusDir || config.vaultPath;
  return typeof configuredPath === 'string' && configuredPath.trim()
    ? resolveUserPath(configuredPath)
    : null;
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
  if (process.env.TECH_PERSISTENCE_HOME) {
    return resolveUserPath(process.env.TECH_PERSISTENCE_HOME);
  }

  const configuredBaseDir = resolveConfiguredBaseDir();
  if (configuredBaseDir) return configuredBaseDir;

  const runtime = runtimeFromEnvironment();
  if (runtime === 'codex') {
    const codexHome = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
    return path.join(codexHome, 'homunculus');
  }
  return path.join(homeDir(), '.claude', 'homunculus');
}

function uniqueDirs(dirs) {
  const seen = new Set();
  return dirs.filter((dir) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveCompatReadDirs() {
  const home = homeDir();
  const dirs = [resolveBaseDir()];
  const claudeDir = path.join(homeDir(), '.claude', 'homunculus');
  const codexDir = path.join(home, '.codex', 'homunculus');
  if (!dirs.includes(claudeDir)) dirs.push(claudeDir);
  if (!dirs.includes(codexDir)) dirs.push(codexDir);
  return uniqueDirs(dirs);
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
  defaultConfigPath,
  expandHome,
  homeDir,
  readSharedConfig,
  resolveConfiguredBaseDir,
  runtimeFromEnvironment,
  resolveBaseDir,
  resolveCompatReadDirs,
  resolveConfigPath,
  resolveProjectPlansDir,
  resolveProjectRulesDir,
  resolveProjectInstructionFile,
  resolveSessionId,
};
