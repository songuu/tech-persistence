'use strict';

const fs = require('fs');
const path = require('path');
const { stableHash } = require('./self-learning-canonical');

function sha256(value) {
  return stableHash(String(value)).slice('sha256:'.length);
}

function stripRemoteSuffix(value) {
  return String(value || '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '');
}

const DEFAULT_REMOTE_PORTS = Object.freeze({
  'git:': '9418',
  'git+ssh:': '22',
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
});

function normalizedRemoteAuthority(parsed) {
  const host = String(parsed.hostname || '').toLowerCase();
  const port = String(parsed.port || '');
  if (!port || DEFAULT_REMOTE_PORTS[parsed.protocol] === port) return host;
  return `${host}:${port}`;
}

function normalizeGitRemote(remote) {
  const input = String(remote || '').trim();
  if (!input) throw new Error('project-identity: git remote is required');

  // SCP-like Git syntax is not a URL, so normalize it before URL parsing.
  const scpMatch = input.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scpMatch && !input.includes('://') && !/^[A-Za-z]:[\\/]/.test(input)) {
    const host = scpMatch[1].toLowerCase();
    const repositoryPath = stripRemoteSuffix(scpMatch[2]);
    if (!repositoryPath) throw new Error('project-identity: git remote repository path is empty');
    return `${host}/${repositoryPath}`;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('project-identity: unsupported git remote format');
  }
  const host = normalizedRemoteAuthority(parsed);
  const repositoryPath = stripRemoteSuffix(parsed.pathname);
  if (!host || !repositoryPath) throw new Error('project-identity: git remote host/path is required');
  return `${host}/${repositoryPath}`;
}

function projectIdentityFromRemote(remote) {
  const normalized = normalizeGitRemote(remote);
  const digest = sha256(`git-remote-normalized\0${normalized}`);
  return {
    id: `project-${digest.slice(0, 24)}`,
    name: path.posix.basename(normalized),
    source: 'git-remote-normalized',
    locator_hash: `sha256:${sha256(normalized)}`,
  };
}

function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveGitDir(repoRoot) {
  const marker = path.join(repoRoot, '.git');
  if (!fs.existsSync(marker)) return null;
  const stat = fs.lstatSync(marker);
  if (stat.isDirectory()) return marker;
  if (!stat.isFile()) return null;
  const content = fs.readFileSync(marker, 'utf8');
  const match = content.match(/^gitdir:\s*(.+)\s*$/im);
  return match ? path.resolve(repoRoot, match[1].trim()) : null;
}

function readOriginRemote(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return '';
  const configPath = path.join(gitDir, 'config');
  if (!fs.existsSync(configPath)) return '';
  const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[(.+)]\s*$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1].trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (url) return url[1];
  }
  return '';
}

function localIdentity(root, source) {
  const resolved = path.resolve(root);
  const digest = sha256(`${source}\0${resolved}`);
  return {
    id: `project-${digest.slice(0, 24)}`,
    name: path.basename(resolved),
    source,
    locator_hash: `sha256:${sha256(resolved)}`,
  };
}

function detectStableProjectIdentity(cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd);
  let root = null;
  try {
    root = findGitRoot(resolvedCwd);
    if (root) {
      const remote = readOriginRemote(root);
      if (remote) return projectIdentityFromRemote(remote);
    }
  } catch {
    // Fall through to a path fingerprint. Raw paths are never returned.
  }
  return localIdentity(root || resolvedCwd, root ? 'git-root-hash' : 'cwd-hash');
}

module.exports = {
  detectStableProjectIdentity,
  findGitRoot,
  normalizeGitRemote,
  projectIdentityFromRemote,
  readOriginRemote,
};
