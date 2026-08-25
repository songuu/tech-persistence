#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { convertCodexText } = require('./install-codex-text-asset');
const {
  marketplaceExpectationFromRaw,
  publishTextCompareAndSwap,
} = require('./update-codex-marketplace');

const MANIFEST_NAME = 'project-standards.json';
const MANAGED_START = '<!-- tech-persistence:project-standards:start -->';
const MANAGED_END = '<!-- tech-persistence:project-standards:end -->';
const ATTRIBUTES_START = '# tech-persistence:project-standards:start';
const ATTRIBUTES_END = '# tech-persistence:project-standards:end';
const PROFILE_ORDER = [
  'base',
  'frontend',
  'backend',
  'agent',
  'data',
  'infrastructure',
  'library',
  'monorepo',
  'fullstack',
  'unknown',
];
const PROFILE_SET = new Set(PROFILE_ORDER);
const RUNTIMES = new Set(['claude', 'codex']);
const IGNORED_DIRECTORIES = new Set([
  '.git', '.claude', '.codex', '.agents', '.cursor', '.idea', '.vscode',
  'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', 'target', 'vendor',
]);
const PLACEHOLDER_SIGNAL_FILES = new Set(['.gitkeep', '.keep', '.placeholder']);

const FRONTEND_PACKAGES = [
  'react', 'react-dom', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit',
  'angular', '@angular/core', 'solid-js', 'vite', 'astro', 'remix', '@remix-run/react',
];
const BACKEND_PACKAGES = [
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi', '@nestjs/core', 'nestjs',
  'hono', 'restify', 'adonisjs', '@adonisjs/core', 'loopback', '@loopback/core',
  'trpc', '@trpc/server',
];
const AGENT_PACKAGES = [
  'langchain', '@langchain/core', 'crewai', 'autogen', 'pyautogen', 'mastra',
  '@mastra/core', 'semantic-kernel', '@microsoft/semantic-kernel', 'llamaindex',
  'llama-index', 'pydantic-ai', 'smolagents', '@openai/agents', 'openai-agents',
  'openai_agents', 'google-adk', 'agno', 'haystack-ai',
];
const DATA_PACKAGES = [
  'pandas', 'polars', 'pyspark', 'apache-airflow', 'airflow', 'dbt-core', 'dagster',
  'prefect', 'duckdb', 'kafka-python', '@apache-arrow/es2015-cjs', 'apache-arrow',
];

function normalizeLf(value) {
  return String(value).replace(/\r\n/g, '\n');
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactObjectKeys(value, required, optional, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${label} has invalid fields (missing=${missing.join(',') || 'none'}, extra=${extra.join(',') || 'none'})`);
  }
}

function stripYamlInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && (quote === null || quote === character)) {
      quote = quote === character ? null : character;
    } else if (character === '#' && quote === null) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function normalizeWorkspaceEntry(value) {
  let normalized = stripYamlInlineComment(String(value || '').trim());
  if ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1).trim();
  }
  return path.posix.normalize(normalizeSlashes(normalized));
}

function isRootWorkspaceEntry(value) {
  const normalized = normalizeWorkspaceEntry(value);
  return normalized === '.' || normalized === './';
}

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function relativePath(root, target) {
  return normalizeSlashes(path.relative(root, target));
}

function assertPlainPath(root, target, label, options = {}) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!pathIsInside(absoluteRoot, absoluteTarget)) {
    throw new Error(`${label} escapes allowed root: ${absoluteTarget}`);
  }
  if (!pathExists(absoluteRoot)) {
    if (options.createRoot) fs.mkdirSync(absoluteRoot, { recursive: true });
    else throw new Error(`${label} root does not exist: ${absoluteRoot}`);
  }
  const relative = path.relative(absoluteRoot, absoluteTarget);
  const parts = relative ? relative.split(path.sep) : [];
  let current = absoluteRoot;
  for (const part of parts) {
    current = path.join(current, part);
    if (!pathExists(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink/junction/reparse point: ${current}`);
    }
  }
  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} root must be a plain directory: ${absoluteRoot}`);
  }
  const realRoot = fs.realpathSync.native(absoluteRoot);
  let existing = absoluteTarget;
  while (!pathExists(existing) && existing !== absoluteRoot) existing = path.dirname(existing);
  const realExisting = fs.realpathSync.native(existing);
  if (!pathIsInside(realRoot, realExisting)) {
    throw new Error(`${label} realpath escapes allowed root: ${absoluteTarget}`);
  }
  return absoluteTarget;
}

function assertPlainTree(root, target, label, treeRoot = target) {
  const absolute = assertPlainPath(root, target, label);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symlink: ${absolute}`);
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) throw new Error(`${label} contains an unsupported entry: ${absolute}`);
  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(absolute, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${label} cannot contain symlinks: ${child}`);
    const childRelative = relativePath(treeRoot, child);
    if (isForbiddenLocalAsset(childRelative)) {
      throw new Error(`${label} contains forbidden local/ephemeral asset: ${child}`);
    }
    if (entry.isFile()) files.push(child);
    else if (entry.isDirectory()) files.push(...assertPlainTree(root, child, label, treeRoot));
    else throw new Error(`${label} contains an unsupported entry: ${child}`);
  }
  return files;
}

function writeFileAtomic(root, target, content, label, expectedSha256) {
  assertPlainPath(root, target, label);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertPlainPath(root, path.dirname(target), label);
  let current = null;
  if (pathExists(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} target must be a plain file`);
    current = fs.readFileSync(target);
  }
  const currentSha256 = current === null ? null : sha256(current);
  if (expectedSha256 !== undefined && currentSha256 !== expectedSha256) {
    throw new Error(`${label} changed after ownership verification`);
  }
  return publishTextCompareAndSwap(
    target,
    Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
    marketplaceExpectationFromRaw(current),
    { previousLabel: 'project-standards' }
  );
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function readPlainEvidenceFile(projectRoot, file) {
  try {
    assertPlainPath(projectRoot, file, 'architecture evidence');
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function safeJson(file) {
  const raw = safeRead(file);
  if (raw === null) return null;
  return parseJsonText(raw, file);
}

function parseJsonText(raw, file) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`);
  }
}

function listPackageJsonFiles(projectRoot, maxDepth = 3) {
  const results = [];
  function visit(directory, depth) {
    if (depth > maxDepth) return;
    const packagePath = path.join(directory, 'package.json');
    if (pathExists(packagePath) && fs.lstatSync(packagePath).isFile()) results.push(packagePath);
    if (depth === maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
          || entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  }
  visit(projectRoot, 0);
  return results.sort();
}

function hasSubstantiveSignal(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) return false;
  if (stat.isFile()) {
    return stat.size > 0 && !PLACEHOLDER_SIGNAL_FILES.has(path.basename(target).toLowerCase());
  }
  if (!stat.isDirectory()) return false;

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()
        || PLACEHOLDER_SIGNAL_FILES.has(entry.name.toLowerCase())
        || isForbiddenLocalAsset(entry.name)) continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    if (hasSubstantiveSignal(path.join(target, entry.name))) return true;
  }
  return false;
}

function existingSignal(projectRoot, candidates) {
  for (const candidate of candidates) {
    const absolute = path.join(projectRoot, ...candidate.split('/'));
    if (hasSubstantiveSignal(absolute)) return candidate;
  }
  return null;
}

function dependencySignal(dependencies, names) {
  return names.find((name) => dependencies.has(name)) || null;
}

function manifestDependencySignal(manifestText, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dependencyBoundary = new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i');
    if (dependencyBoundary.test(manifestText)) return name;
  }
  return null;
}

function orderProfiles(profiles) {
  const set = new Set(profiles);
  return PROFILE_ORDER.filter((name) => set.has(name));
}

function normalizeExplicitProfiles(profiles) {
  const values = Array.isArray(profiles)
    ? profiles
    : String(profiles || '').split(',');
  const requested = values.map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  for (const profile of requested) {
    if (!PROFILE_SET.has(profile)) {
      throw new Error(`unsupported explicit project profile: ${profile}`);
    }
  }
  const selected = new Set(['base', ...requested.filter((profile) => profile !== 'base')]);
  if (selected.has('fullstack')) {
    selected.add('frontend');
    selected.add('backend');
  }
  if (selected.has('unknown') && selected.size > 2) {
    throw new Error('unknown project profile cannot be combined with known architecture profiles');
  }
  if (selected.has('frontend') && selected.has('backend')) selected.add('fullstack');
  if (selected.size === 1) selected.add('unknown');
  const ordered = orderProfiles(selected);
  return {
    mode: 'explicit',
    profiles: ordered,
    evidence: ordered.filter((profile) => profile !== 'base').map((profile) => ({
      profile,
      source: 'explicit',
      signal: `profile selected explicitly: ${profile}`,
    })),
  };
}

function detectProjectProfiles(projectRoot) {
  const root = path.resolve(projectRoot);
  if (!pathExists(root) || !fs.lstatSync(root).isDirectory()) {
    throw new Error(`project root does not exist: ${root}`);
  }
  const evidence = [];
  const selected = new Set(['base']);
  const seenEvidence = new Set();
  function add(profile, source, signal) {
    if (!PROFILE_SET.has(profile) || profile === 'base') throw new Error(`invalid detected profile: ${profile}`);
    selected.add(profile);
    const entry = { profile, source: normalizeSlashes(source), signal };
    const key = JSON.stringify(entry);
    if (!seenEvidence.has(key)) {
      seenEvidence.add(key);
      evidence.push(entry);
    }
  }

  const packageFiles = listPackageJsonFiles(root);
  const dependencies = new Set();
  const dependencySources = new Map();
  let rootPackage = null;
  for (const packageFile of packageFiles) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    } catch {
      continue;
    }
    if (path.resolve(packageFile) === path.join(root, 'package.json')) rootPackage = pkg;
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dependencyName of Object.keys(pkg[group] || {})) {
        const name = dependencyName.toLowerCase();
        dependencies.add(name);
        if (!dependencySources.has(name)) dependencySources.set(name, new Set());
        dependencySources.get(name).add(relativePath(root, packageFile));
      }
    }
  }

  function packageEvidenceSource(name) {
    const sources = [...(dependencySources.get(name) || [])];
    sources.sort((left, right) => {
      if (left === 'package.json') return -1;
      if (right === 'package.json') return 1;
      return left.localeCompare(right);
    });
    return sources[0] || 'package.json';
  }

  const frontendPackage = dependencySignal(dependencies, FRONTEND_PACKAGES);
  if (frontendPackage) add('frontend', packageEvidenceSource(frontendPackage), `dependency:${frontendPackage}`);
  const frontendPath = existingSignal(root, ['src/app', 'src/pages', 'src/components', 'app/components', 'public/index.html']);
  const hasViteConfig = ['vite.config.ts', 'vite.config.js']
    .some((name) => readPlainEvidenceFile(root, path.join(root, name)) !== null);
  if (frontendPath && (frontendPackage || hasViteConfig)) {
    add('frontend', frontendPath, 'frontend source layout');
  }

  const backendPackage = dependencySignal(dependencies, BACKEND_PACKAGES);
  if (backendPackage) add('backend', packageEvidenceSource(backendPackage), `dependency:${backendPackage}`);
  const backendPath = existingSignal(root, [
    'src/app/api', 'app/api', 'src/routes', 'src/controllers', 'src/server', 'server',
    'api', 'cmd/server', 'internal/server',
  ]);
  if (backendPath) add('backend', backendPath, 'server/API source layout');

  const ecosystemManifests = new Map([
    'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'go.mod',
    'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  ].map((name) => [name, readPlainEvidenceFile(root, path.join(root, name))]));
  const ecosystemText = [...ecosystemManifests.values()].filter(Boolean).join('\n').toLowerCase();
  const backendEcosystems = [
    'fastapi', 'django', 'flask', 'litestar', 'sqlalchemy', 'gin-gonic', 'fiber',
    'actix-web', 'axum', 'rocket', 'spring-boot', 'quarkus',
  ];
  const backendEcosystem = manifestDependencySignal(ecosystemText, backendEcosystems);
  if (backendEcosystem) add('backend', 'project manifests', `backend framework:${backendEcosystem}`);

  const agentPackage = dependencySignal(dependencies, AGENT_PACKAGES);
  if (agentPackage) add('agent', packageEvidenceSource(agentPackage), `agent dependency:${agentPackage}`);
  const agentManifestSignal = manifestDependencySignal(ecosystemText, AGENT_PACKAGES);
  if (agentManifestSignal) add('agent', 'project manifests', `agent dependency:${agentManifestSignal}`);
  const agentPath = existingSignal(root, [
    'agents', 'src/agents', 'prompts', 'src/prompts', 'evals', 'src/evals', 'mcp',
    'scripts/agent-orchestrator.js', 'scripts/agent-orchestrator', 'schemas/agent-loop',
  ]);
  if (agentPath) {
    add('agent', agentPath, 'agent prompt/tool/eval layout');
  }
  const agentToolPath = existingSignal(root, ['tools', 'src/tools']);
  if (agentToolPath && (agentPackage || agentManifestSignal)) {
    add('agent', agentToolPath, 'agent tool layout');
  }

  const dataPackage = dependencySignal(dependencies, DATA_PACKAGES);
  if (dataPackage) add('data', packageEvidenceSource(dataPackage), `data dependency:${dataPackage}`);
  const dataManifestSignal = manifestDependencySignal(ecosystemText, DATA_PACKAGES);
  if (dataManifestSignal) add('data', 'project manifests', `data dependency:${dataManifestSignal}`);
  const dataPath = existingSignal(root, ['dbt_project.yml', 'dags', 'pipelines', 'warehouse', 'notebooks']);
  if (dataPath) add('data', dataPath, 'data pipeline layout');

  const infrastructurePath = existingSignal(root, [
    'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
    'terraform', 'infra', 'infrastructure', 'k8s', 'kubernetes', 'helm', '.github/workflows',
  ]);
  if (infrastructurePath) add('infrastructure', infrastructurePath, 'deployment/infrastructure asset');

  const isLibrary = Boolean(rootPackage && rootPackage.private !== true
    && (rootPackage.exports || rootPackage.main || rootPackage.module || rootPackage.types));
  if (isLibrary) add('library', 'package.json', 'published package entrypoint');
  if (/\[build-system\]|setuptools|poetry-core|maturin/.test(ecosystemText)
      && !selected.has('backend') && !selected.has('data') && !selected.has('agent')) {
    add('library', 'project manifests', 'library build system');
  }
  if (/\[lib\]/.test(ecosystemText) && ecosystemManifests.get('Cargo.toml')) {
    add('library', 'Cargo.toml', 'Rust library target');
  }
  if (ecosystemManifests.get('go.mod')
      && !selected.has('backend') && !selected.has('data') && !selected.has('agent')) {
    let rootGoFiles = [];
    try {
      rootGoFiles = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.go'))
        .map((entry) => path.join(root, entry.name));
    } catch {
      rootGoFiles = [];
    }
    if (rootGoFiles.some((file) => !/^\s*package\s+main\b/m.test(readPlainEvidenceFile(root, file) || ''))) {
      add('library', 'go.mod', 'Go module exposes a non-main root package');
    }
  }

  let workspaceSignal = null;
  if (rootPackage && rootPackage.workspaces) {
    const workspaces = Array.isArray(rootPackage.workspaces)
      ? rootPackage.workspaces
      : rootPackage.workspaces.packages;
    if (Array.isArray(workspaces)
        && workspaces.some((entry) => !normalizeWorkspaceEntry(entry).startsWith('!') && !isRootWorkspaceEntry(entry))) {
      workspaceSignal = 'package.json workspaces';
    }
  }
  const pnpmWorkspace = readPlainEvidenceFile(root, path.join(root, 'pnpm-workspace.yaml'));
  if (!workspaceSignal && pnpmWorkspace) {
    const packageLines = [];
    let inPackages = false;
    for (const line of pnpmWorkspace.split(/\r?\n/)) {
      if (/^packages:\s*(?:#.*)?$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (!inPackages) continue;
      if (/^[^\s#]/.test(line)) break;
      const match = line.match(/^\s*-\s*(.+?)\s*$/);
      if (!match) continue;
      packageLines.push(match[1]);
    }
    if (packageLines.some((line) => !normalizeWorkspaceEntry(line).startsWith('!') && !isRootWorkspaceEntry(line))) {
      workspaceSignal = 'pnpm-workspace.yaml';
    }
  }
  if (!workspaceSignal && packageFiles.length > 1) workspaceSignal = 'multiple package.json files';
  if (workspaceSignal || existingSignal(root, ['turbo.json', 'nx.json', 'lerna.json'])) {
    add('monorepo', workspaceSignal || 'workspace orchestrator config', 'multi-package workspace');
  }

  if (selected.has('frontend') && selected.has('backend')) {
    add('fullstack', 'derived:frontend+backend', 'frontend and backend capabilities coexist');
  }
  if (selected.size === 1) add('unknown', 'project root', 'no supported architecture signal detected');

  evidence.sort((left, right) => {
    const profileOrder = PROFILE_ORDER.indexOf(left.profile) - PROFILE_ORDER.indexOf(right.profile);
    if (profileOrder !== 0) return profileOrder;
    return `${left.source}:${left.signal}`.localeCompare(`${right.source}:${right.signal}`);
  });
  return { mode: 'auto', profiles: orderProfiles(selected), evidence };
}

function assertRelativeSourcePath(sourceRoot, relative, label) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = normalizeSlashes(relative);
  if (normalized.split('/').includes('..')) throw new Error(`${label} escapes canonical source: ${relative}`);
  const absolute = path.resolve(sourceRoot, ...normalized.split('/'));
  if (!pathIsInside(sourceRoot, absolute)) throw new Error(`${label} escapes canonical source: ${relative}`);
  return absolute;
}

function parseSkillFrontmatter(content, skillPath) {
  const normalized = normalizeLf(content);
  if (!normalized.startsWith('---\n')) throw new Error(`skill SKILL.md missing YAML frontmatter: ${skillPath}`);
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) throw new Error(`skill SKILL.md has unterminated frontmatter: ${skillPath}`);
  const frontmatter = normalized.slice(4, end);
  const name = frontmatter.match(/^name:\s*(.+)$/m);
  const description = frontmatter.match(/^description:\s*(.+)$/m);
  if (!name || !name[1].trim()) throw new Error(`skill frontmatter missing name: ${skillPath}`);
  if (!description || !description[1].trim()) throw new Error(`skill frontmatter missing description: ${skillPath}`);
}

function isForbiddenLocalAsset(assetPath) {
  const normalized = normalizeSlashes(String(assetPath)).toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const name = segments.at(-1) || '';
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment))
    || /^\.env(?:\..+)?$/.test(name)
    || name.startsWith('settings.local.')
    || name === '.ds_store'
    || name === 'thumbs.db'
    || name === '.git-credentials'
    || name === '.netrc'
    || name === '.npmrc'
    || name === '.pypirc'
    || name === 'credentials.json'
    || name === 'credential.json'
    || name === 'secrets.json'
    || name === 'secret.json'
    || name === 'service-account.json'
    || name === 'service_account.json'
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/.test(name)
    || name === 'package-lock.json'
    || name === 'pnpm-lock.yaml'
    || name === 'yarn.lock'
    || /-lock\.(?:json|ya?ml)$/.test(name)
    || /\.(?:lock|log|tmp|temp|swp|bak|pem|key|p12|pfx|jks|keystore)$/.test(name)
    || /(?:^|[-_.])(?:session|pid)(?:[-_.]|$)/.test(name);
}

function loadProjectStandardsCatalog(sourceRoot = path.resolve(__dirname, '..', 'project-level')) {
  const root = path.resolve(sourceRoot);
  assertPlainPath(root, root, 'project standards source');
  const catalogPath = path.join(root, 'profiles', 'catalog.json');
  assertPlainPath(root, catalogPath, 'project standards catalog');
  if (!pathExists(catalogPath) || !fs.lstatSync(catalogPath).isFile()) {
    throw new Error(`project standards catalog missing: ${catalogPath}`);
  }
  const catalog = safeJson(catalogPath);
  if (!catalog || catalog.schemaVersion !== 1 || !catalog.profiles || !catalog.shared) {
    throw new Error(`unsupported project standards catalog: ${catalogPath}`);
  }
  if (!Array.isArray(catalog.shared.commands) || !Array.isArray(catalog.shared.skills)) {
    throw new Error('project standards catalog shared commands/skills must be arrays');
  }
  if (catalog.legacyHashes !== undefined) {
    if (!catalog.legacyHashes || typeof catalog.legacyHashes !== 'object' || Array.isArray(catalog.legacyHashes)) {
      throw new Error('project standards catalog legacyHashes must be an object');
    }
    for (const [target, runtimes] of Object.entries(catalog.legacyHashes)) {
      if (!/^(?:rules|commands|skills)\/[A-Za-z0-9._/-]+$/.test(target)
          || !runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) {
        throw new Error(`invalid project standards legacy hash target: ${target}`);
      }
      for (const [runtime, hashes] of Object.entries(runtimes)) {
        if (!RUNTIMES.has(runtime) || !Array.isArray(hashes)
            || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
          throw new Error(`invalid project standards legacy hashes for ${target}/${runtime}`);
        }
      }
    }
  }
  if (catalog.legacyMarkerHashes !== undefined) {
    const markers = catalog.legacyMarkerHashes;
    if (!isPlainObject(markers)) throw new Error('project standards catalog legacyMarkerHashes must be an object');
    assertExactObjectKeys(markers, ['entrypoint', 'attributes'], [], 'legacyMarkerHashes');
    assertExactObjectKeys(markers.entrypoint, ['claude', 'codex'], [], 'legacyMarkerHashes.entrypoint');
    for (const [label, hashes] of [
      ['entrypoint/claude', markers.entrypoint.claude],
      ['entrypoint/codex', markers.entrypoint.codex],
      ['attributes', markers.attributes],
    ]) {
      if (!Array.isArray(hashes) || new Set(hashes).size !== hashes.length
          || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
        throw new Error(`invalid project standards legacy marker hashes: ${label}`);
      }
    }
  }
  for (const profile of PROFILE_ORDER) {
    const definition = catalog.profiles[profile];
    if (!definition || typeof definition.description !== 'string' || !definition.description.trim()) {
      throw new Error(`project standards catalog missing profile description: ${profile}`);
    }
    if (!Array.isArray(definition.scopes) || definition.scopes.length === 0
        || definition.scopes.some((scope) => typeof scope !== 'string' || !scope.trim())) {
      throw new Error(`project standards profile scopes must be non-empty: ${profile}`);
    }
    if (!Array.isArray(definition.rules) || definition.rules.length === 0) {
      throw new Error(`project standards profile rules must be non-empty: ${profile}`);
    }
    for (const rule of definition.rules) {
      const absolute = assertRelativeSourcePath(root, rule, `profile ${profile} rule`);
      assertPlainPath(root, absolute, `profile ${profile} rule`);
      if (!rule.endsWith('.md') || !pathExists(absolute) || !fs.lstatSync(absolute).isFile()) {
        throw new Error(`profile ${profile} rule must be a Markdown file: ${rule}`);
      }
    }
  }
  const unknownProfiles = Object.keys(catalog.profiles).filter((profile) => !PROFILE_SET.has(profile));
  if (unknownProfiles.length > 0) throw new Error(`unknown catalog profiles: ${unknownProfiles.join(', ')}`);

  for (const command of catalog.shared.commands) {
    const absolute = assertRelativeSourcePath(root, command, 'shared command');
    assertPlainPath(root, absolute, 'shared command');
    if (!command.endsWith('.md') || !pathExists(absolute) || !fs.lstatSync(absolute).isFile()) {
      throw new Error(`shared command must be a Markdown file: ${command}`);
    }
  }
  for (const skill of catalog.shared.skills) {
    const absolute = assertRelativeSourcePath(root, skill, 'shared skill');
    const files = assertPlainTree(root, absolute, 'shared skill');
    if (!fs.lstatSync(absolute).isDirectory() || files.length === 0) {
      throw new Error(`shared skill must be a non-empty directory: ${skill}`);
    }
    const skillFile = path.join(absolute, 'SKILL.md');
    if (!pathExists(skillFile)) throw new Error(`shared skill missing SKILL.md: ${skill}`);
    parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8'), skillFile);
    for (const file of files) {
      const skillRelative = relativePath(absolute, file);
      if (isForbiddenLocalAsset(skillRelative)) {
        throw new Error(`shared skill contains forbidden local/ephemeral asset: ${file}`);
      }
    }
  }
  if (catalog.retiredAssets !== undefined) {
    if (!Array.isArray(catalog.retiredAssets)) {
      throw new Error('project standards catalog retiredAssets must be an array');
    }
    const activePaths = new Set(resolveAssets({
      sourceRoot: root,
      catalog,
      profiles: PROFILE_ORDER,
      runtime: 'claude',
    }).map((asset) => asset.path));
    const seenRetiredPaths = new Set();
    const pathPrefixes = { rule: 'rules/', command: 'commands/', skill: 'skills/' };
    for (const [index, asset] of catalog.retiredAssets.entries()) {
      assertExactObjectKeys(
        asset,
        ['kind', 'profile', 'source', 'path', 'hashes'],
        [],
        `retired asset[${index}]`
      );
      const normalizedSource = normalizeSlashes(asset.source || '');
      const normalizedPath = normalizeSlashes(asset.path || '');
      const validProfile = asset.kind === 'rule'
        ? PROFILE_SET.has(asset.profile)
        : asset.profile === 'shared';
      const expectedTarget = asset.kind === 'rule'
        ? `rules/${path.posix.basename(normalizedSource)}`
        : asset.kind === 'command'
          ? `commands/${path.posix.basename(normalizedSource)}`
          : normalizedSource.startsWith('.claude/skills/')
            ? normalizedSource.slice('.claude/'.length)
            : null;
      if (!pathPrefixes[asset.kind] || !normalizedPath.startsWith(pathPrefixes[asset.kind])
          || normalizedPath !== asset.path || normalizedSource !== asset.source
          || normalizedPath !== expectedTarget
          || (asset.kind === 'rule' && !normalizedSource.startsWith(`profiles/${asset.profile}/rules/`))
          || (asset.kind === 'command' && !normalizedSource.startsWith('.claude/commands/'))
          || normalizedPath.split('/').includes('..') || normalizedSource.split('/').includes('..')
          || isForbiddenLocalAsset(normalizedPath) || !validProfile
          || (asset.kind !== 'skill' && !normalizedPath.endsWith('.md'))
          || seenRetiredPaths.has(normalizedPath) || activePaths.has(normalizedPath)) {
        throw new Error(`invalid project standards retired asset identity: ${normalizedPath || index}`);
      }
      if (!isPlainObject(asset.hashes) || Object.keys(asset.hashes).length === 0) {
        throw new Error(`invalid project standards retired asset hashes: ${normalizedPath}`);
      }
      for (const [runtime, hashes] of Object.entries(asset.hashes)) {
        if (!RUNTIMES.has(runtime) || !Array.isArray(hashes) || hashes.length === 0
            || new Set(hashes).size !== hashes.length
            || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
          throw new Error(`invalid project standards retired asset hashes: ${normalizedPath}/${runtime}`);
        }
      }
      seenRetiredPaths.add(normalizedPath);
    }
  }
  return catalog;
}

function runtimeContent(runtime, content) {
  const normalized = normalizeLf(content);
  let projected = runtime === 'codex' ? normalizeLf(convertCodexText(normalized)) : normalized;
  const placeholders = runtime === 'codex'
    ? {
      '{{RUNTIME_DIR}}': '.codex',
      '{{ENTRYPOINT}}': 'AGENTS.md',
      '{{SIBLING_RUNTIME_DIR}}': '.claude',
      '{{SIBLING_ENTRYPOINT}}': 'CLAUDE.md',
      '{{RUNTIME_NAME}}': 'Codex',
    }
    : {
      '{{RUNTIME_DIR}}': '.claude',
      '{{ENTRYPOINT}}': 'CLAUDE.md',
      '{{SIBLING_RUNTIME_DIR}}': '.codex',
      '{{SIBLING_ENTRYPOINT}}': 'AGENTS.md',
      '{{RUNTIME_NAME}}': 'Claude Code',
    };
  for (const [token, value] of Object.entries(placeholders)) projected = projected.split(token).join(value);
  if (/\{\{(?:RUNTIME|ENTRYPOINT|SIBLING)/.test(projected)) {
    throw new Error('unresolved project standards runtime placeholder');
  }
  return projected;
}

function resolveAssets({ sourceRoot, catalog, profiles, runtime }) {
  if (!RUNTIMES.has(runtime)) throw new Error(`unsupported project standards runtime: ${runtime}`);
  const assets = [];
  const targets = new Set();
  function addAsset({ kind, profile, source, targetPath }) {
    const absoluteSource = assertRelativeSourcePath(sourceRoot, source, `${kind} source`);
    assertPlainPath(sourceRoot, absoluteSource, `${kind} source`);
    const content = runtimeContent(runtime, fs.readFileSync(absoluteSource, 'utf8'));
    const normalizedTarget = normalizeSlashes(targetPath);
    if (targets.has(normalizedTarget)) throw new Error(`duplicate project standards target: ${normalizedTarget}`);
    targets.add(normalizedTarget);
    assets.push({
      kind,
      profile,
      source: normalizeSlashes(source),
      path: normalizedTarget,
      sha256: sha256(content),
      content,
    });
  }

  for (const profile of profiles) {
    const definition = catalog.profiles[profile];
    if (!definition) throw new Error(`selected project profile is missing from catalog: ${profile}`);
    for (const source of definition.rules) {
      addAsset({ kind: 'rule', profile, source, targetPath: `rules/${path.basename(source)}` });
    }
  }
  for (const source of catalog.shared.commands) {
    addAsset({ kind: 'command', profile: 'shared', source, targetPath: `commands/${path.basename(source)}` });
  }
  for (const skill of catalog.shared.skills) {
    const absoluteSkill = assertRelativeSourcePath(sourceRoot, skill, 'shared skill');
    const skillName = path.basename(skill);
    const files = assertPlainTree(sourceRoot, absoluteSkill, 'shared skill')
      .sort((left, right) => left.localeCompare(right));
    for (const file of files) {
      const relative = relativePath(absoluteSkill, file);
      const source = relativePath(sourceRoot, file);
      addAsset({
        kind: 'skill',
        profile: 'shared',
        source,
        targetPath: `skills/${skillName}/${relative}`,
      });
    }
  }
  const kindOrder = { rule: 0, command: 1, skill: 2 };
  assets.sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind]
    || left.path.localeCompare(right.path));
  return assets;
}

function managedEntryBlock(runtime) {
  const runtimeDir = runtime === 'codex' ? '.codex' : '.claude';
  const runtimeName = runtime === 'codex' ? 'Codex' : 'Claude Code';
  return [
    MANAGED_START,
    '## Project standards routing',
    '',
    `- Architecture evidence and the exact managed inventory live in \`${runtimeDir}/${MANIFEST_NAME}\`.`,
    `- Before architecture-sensitive work, ${runtimeName} must read that manifest and the listed rules for the active profiles.`,
    '- Treat detected profiles as evidence, not as a substitute for inspecting real manifests, source layout, tests, and repository-local instructions.',
    '- Use the project-local `project-standards` skill for a standards audit; `project-audit` is read-only and must not silently rewrite user-owned files.',
    MANAGED_END,
  ].join('\n');
}

function managedGitAttributesBlock(sourceRoot, catalog) {
  const paths = new Set([
    '/.gitattributes',
    '/AGENTS.md',
    '/CLAUDE.md',
    '/.claude/project-standards.json',
    '/.codex/project-standards.json',
  ]);
  const textExtensions = [
    'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'yaml', 'yml', 'toml',
    'txt', 'py', 'sh', 'ps1', 'css', 'scss', 'html', 'svg',
  ];
  for (const runtime of ['claude', 'codex']) {
    const runtimeDirectory = runtime === 'codex' ? '.codex' : '.claude';
    for (const extension of textExtensions) paths.add(`/${runtimeDirectory}/**/*.${extension}`);
  }
  return [
    ATTRIBUTES_START,
    ...[...paths].sort().map((assetPath) => `${assetPath} text eol=lf`),
    ATTRIBUTES_END,
  ].join('\n');
}

function updateManagedGitAttributes(projectRoot, sourceRoot, catalog, options = {}) {
  const target = path.join(projectRoot, '.gitattributes');
  assertPlainPath(projectRoot, target, '.gitattributes project standards block');
  const existing = safeRead(target);
  const current = existing === null ? '' : existing;
  const startCount = current.split(ATTRIBUTES_START).length - 1;
  const endCount = current.split(ATTRIBUTES_END).length - 1;
  if (startCount !== endCount || startCount > 1) {
    return { path: '.gitattributes', status: 'conflict', reason: 'malformed managed project standards attributes markers' };
  }
  const block = managedGitAttributesBlock(sourceRoot, catalog);
  let next;
  if (startCount === 1) {
    const start = current.indexOf(ATTRIBUTES_START);
    const end = current.indexOf(ATTRIBUTES_END, start) + ATTRIBUTES_END.length;
    const currentBlock = current.slice(start, end);
    if (current.slice(end).trim()) {
      return { path: '.gitattributes', status: 'conflict', reason: 'managed project standards attributes block must remain last' };
    }
    if (sha256(currentBlock) === sha256(block)) {
      next = current;
    } else if (options.previous && options.previous.attributes
        && options.previous.attributes.markerSha256 === sha256(currentBlock)) {
      next = `${current.slice(0, start)}${block}${current.slice(end)}`;
    } else {
      return { path: '.gitattributes', status: 'conflict', reason: 'managed project standards attributes block diverged' };
    }
  } else {
    next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`;
  }
  if (current === next) {
    return { path: '.gitattributes', status: 'unchanged', sha256: sha256(block) };
  }
  if (!options.dryRun) {
    writeFileAtomic(
      projectRoot,
      target,
      next,
      '.gitattributes project standards block',
      existing === null ? null : sha256(existing)
    );
  }
  return { path: '.gitattributes', status: 'updated', sha256: sha256(block) };
}

function updateManagedEntryPoint(projectRoot, runtime, options = {}) {
  const name = runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  const target = path.join(projectRoot, name);
  assertPlainPath(projectRoot, target, `${name} project standards block`);
  const existing = safeRead(target);
  const current = existing === null ? '' : existing;
  const startCount = current.split(MANAGED_START).length - 1;
  const endCount = current.split(MANAGED_END).length - 1;
  if (startCount !== endCount || startCount > 1) {
    return { path: name, status: 'conflict', reason: 'malformed managed project standards markers' };
  }
  const block = managedEntryBlock(runtime);
  let next;
  if (startCount === 1) {
    const start = current.indexOf(MANAGED_START);
    const end = current.indexOf(MANAGED_END, start) + MANAGED_END.length;
    const currentBlock = current.slice(start, end);
    if (sha256(currentBlock) === sha256(block)) {
      next = current;
    } else if (options.previous && options.previous.entrypoint
        && options.previous.entrypoint.markerSha256 === sha256(currentBlock)) {
      next = `${current.slice(0, start)}${block}${current.slice(end)}`;
    } else {
      return { path: name, status: 'conflict', reason: 'managed project standards routing block diverged' };
    }
  } else {
    next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`;
  }
  if (current === next) {
    return { path: name, status: 'unchanged', sha256: sha256(block) };
  }
  if (!options.dryRun) {
    writeFileAtomic(
      projectRoot,
      target,
      next,
      `${name} project standards block`,
      existing === null ? null : sha256(existing)
    );
  }
  return { path: name, status: 'updated', sha256: sha256(block) };
}

function trustedAssetIndex(sourceRoot, catalog, runtime) {
  return new Map(resolveAssets({
    sourceRoot,
    catalog,
    profiles: PROFILE_ORDER,
    runtime,
  }).map((asset) => [asset.path, asset]));
}

function validateManifestShape(manifest, runtime, sourceRoot, catalog, runtimeRoot) {
  assertExactObjectKeys(
    manifest,
    ['schemaVersion', 'owner', 'runtime', 'mode', 'profiles', 'scopes', 'evidence', 'assets', 'conflicts', 'entrypoint'],
    ['attributes'],
    'project standards manifest'
  );
  if (manifest.schemaVersion !== 1 || manifest.owner !== 'tech-persistence' || manifest.runtime !== runtime) {
    throw new Error('project standards manifest schema, owner, or runtime is unsupported');
  }
  if (!['auto', 'explicit'].includes(manifest.mode)) {
    throw new Error(`project standards manifest mode is invalid: ${manifest.mode}`);
  }
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0
      || manifest.profiles.some((profile) => !PROFILE_SET.has(profile))
      || new Set(manifest.profiles).size !== manifest.profiles.length) {
    throw new Error('project standards manifest profiles are invalid');
  }
  const normalizedProfiles = normalizeExplicitProfiles(manifest.profiles).profiles;
  if (JSON.stringify(normalizedProfiles) !== JSON.stringify(manifest.profiles)) {
    throw new Error('project standards manifest profiles are not canonical or dependency-complete');
  }
  if (!isPlainObject(manifest.scopes)
      || JSON.stringify(Object.keys(manifest.scopes)) !== JSON.stringify(manifest.profiles)
      || Object.values(manifest.scopes).some((scopes) => !Array.isArray(scopes) || scopes.length === 0
        || scopes.some((scope) => typeof scope !== 'string' || !scope.trim()))) {
    throw new Error('project standards manifest scopes are invalid');
  }
  if (!Array.isArray(manifest.evidence)) throw new Error('project standards manifest evidence must be an array');
  const evidencedProfiles = new Set();
  for (const [index, evidence] of manifest.evidence.entries()) {
    assertExactObjectKeys(evidence, ['profile', 'source', 'signal'], [], `manifest evidence[${index}]`);
    if (!manifest.profiles.includes(evidence.profile) || evidence.profile === 'base'
        || typeof evidence.source !== 'string' || !evidence.source.trim()
        || typeof evidence.signal !== 'string' || !evidence.signal.trim()) {
      throw new Error(`manifest evidence[${index}] is invalid`);
    }
    evidencedProfiles.add(evidence.profile);
  }
  if (manifest.profiles.some((profile) => profile !== 'base' && !evidencedProfiles.has(profile))) {
    throw new Error('project standards manifest evidence does not cover every non-base profile');
  }
  if (manifest.mode === 'explicit') {
    const expectedEvidence = normalizeExplicitProfiles(manifest.profiles).evidence;
    if (JSON.stringify(manifest.evidence) !== JSON.stringify(expectedEvidence)) {
      throw new Error('project standards explicit evidence is invalid');
    }
  }

  if (!Array.isArray(manifest.assets)) throw new Error('project standards manifest assets must be an array');
  const canonicalAssets = trustedAssetIndex(sourceRoot, catalog, runtime);
  const seenPaths = new Set();
  for (const [index, asset] of manifest.assets.entries()) {
    assertExactObjectKeys(asset, ['kind', 'profile', 'source', 'path', 'sha256'], [], `manifest asset[${index}]`);
    if (seenPaths.has(asset.path)) throw new Error(`duplicate manifest asset path: ${asset.path}`);
    seenPaths.add(asset.path);
    const canonical = canonicalAssets.get(asset.path);
    const retired = Array.isArray(catalog.retiredAssets)
      ? catalog.retiredAssets.find((candidate) => candidate.path === asset.path)
      : null;
    const trustedCurrent = canonical && canonical.kind === asset.kind
      && canonical.profile === asset.profile && canonical.source === asset.source;
    const trustedRetired = retired && retired.kind === asset.kind
      && retired.profile === asset.profile && retired.source === asset.source
      && retired.hashes && Array.isArray(retired.hashes[runtime])
      && retired.hashes[runtime].includes(asset.sha256);
    if ((!trustedCurrent && !trustedRetired)
        || (asset.profile !== 'shared' && !manifest.profiles.includes(asset.profile))) {
      throw new Error(`untrusted project standards manifest asset claim: ${asset.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error(`invalid project standards manifest asset hash: ${asset.path}`);
    }
  }
  const expectedInventory = resolveAssets({
    sourceRoot,
    catalog,
    profiles: manifest.profiles,
    runtime,
  });
  for (const expected of expectedInventory) {
    if (seenPaths.has(expected.path)) continue;
    const target = path.join(runtimeRoot, ...expected.path.split('/'));
    assertPlainPath(runtimeRoot, target, `${runtime} omitted manifest asset`);
    if (pathExists(target)) {
      throw new Error(`project standards manifest omits an existing canonical target: ${expected.path}`);
    }
  }

  if (!Array.isArray(manifest.conflicts)) throw new Error('project standards manifest conflicts must be an array');
  for (const [index, conflict] of manifest.conflicts.entries()) {
    assertExactObjectKeys(
      conflict,
      ['path', 'reason'],
      ['actualSha256', 'desiredSha256', 'backup'],
      `manifest conflict[${index}]`
    );
    if (typeof conflict.path !== 'string' || !conflict.path.trim()
        || typeof conflict.reason !== 'string' || !conflict.reason.trim()) {
      throw new Error(`manifest conflict[${index}] is invalid`);
    }
    for (const field of ['actualSha256', 'desiredSha256']) {
      if (conflict[field] !== undefined && conflict[field] !== null
          && !/^[a-f0-9]{64}$/.test(conflict[field])) {
        throw new Error(`manifest conflict[${index}].${field} is invalid`);
      }
    }
    if (conflict.backup !== undefined
        && (typeof conflict.backup !== 'string'
          || !conflict.backup.startsWith('tech-persistence-backups/')
          || conflict.backup.split('/').includes('..'))) {
      throw new Error(`manifest conflict[${index}].backup is invalid`);
    }
  }
  assertExactObjectKeys(manifest.entrypoint, ['path', 'markerSha256'], [], 'manifest entrypoint');
  const entrypointPath = runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  const allowedEntrypointMarkers = [
    sha256(managedEntryBlock(runtime)),
    ...((catalog.legacyMarkerHashes && catalog.legacyMarkerHashes.entrypoint
      && catalog.legacyMarkerHashes.entrypoint[runtime]) || []),
  ];
  if (manifest.entrypoint.path !== entrypointPath
      || !allowedEntrypointMarkers.includes(manifest.entrypoint.markerSha256)) {
    throw new Error('project standards manifest entrypoint is invalid');
  }
  if (manifest.attributes !== undefined) {
    assertExactObjectKeys(manifest.attributes, ['path', 'markerSha256'], [], 'manifest attributes');
    const allowedAttributeMarkers = [
      sha256(managedGitAttributesBlock(sourceRoot, catalog)),
      ...((catalog.legacyMarkerHashes && catalog.legacyMarkerHashes.attributes) || []),
    ];
    if (manifest.attributes.path !== '.gitattributes'
        || !allowedAttributeMarkers.includes(manifest.attributes.markerSha256)) {
      throw new Error('project standards manifest attributes are invalid');
    }
  }
  return manifest;
}

function readManifestSnapshot(runtimeRoot, runtime, sourceRoot, catalog) {
  const manifestPath = path.join(runtimeRoot, MANIFEST_NAME);
  if (!pathExists(manifestPath)) return { manifest: null, raw: null, sha256: null };
  assertPlainPath(runtimeRoot, manifestPath, 'project standards manifest');
  const raw = safeRead(manifestPath);
  const manifest = validateManifestShape(
    parseJsonText(raw, manifestPath),
    runtime,
    sourceRoot,
    catalog,
    runtimeRoot
  );
  return { manifest, raw, sha256: sha256(raw) };
}

function readPreviousManifest(runtimeRoot, runtime, sourceRoot, catalog) {
  return readManifestSnapshot(runtimeRoot, runtime, sourceRoot, catalog).manifest;
}

function isTrustedHistoricalAsset(asset, canonicalAssets, catalog, runtime) {
  const canonical = canonicalAssets.get(asset.path);
  if (canonical && canonical.kind === asset.kind && canonical.profile === asset.profile
      && canonical.source === asset.source) {
    const legacy = catalog.legacyHashes && catalog.legacyHashes[asset.path]
      && catalog.legacyHashes[asset.path][runtime];
    return asset.sha256 === canonical.sha256 || (Array.isArray(legacy) && legacy.includes(asset.sha256));
  }
  const retired = Array.isArray(catalog.retiredAssets)
    ? catalog.retiredAssets.find((candidate) => candidate.path === asset.path)
    : null;
  return Boolean(retired
    && retired.kind === asset.kind
    && retired.profile === asset.profile
    && retired.source === asset.source
    && retired.hashes
    && Array.isArray(retired.hashes[runtime])
    && retired.hashes[runtime].includes(asset.sha256));
}

function backupRootFor(runtimeRoot) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return path.join(
    runtimeRoot,
    'tech-persistence-backups',
    `project-standards-${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
}

function removeEmptyManagedParents(runtimeRoot, target) {
  const stopNames = new Set(['rules', 'commands', 'skills']);
  let current = path.dirname(target);
  while (pathIsInside(runtimeRoot, current) && current !== runtimeRoot) {
    if (stopNames.has(path.basename(current))) break;
    if (!pathExists(current) || fs.readdirSync(current).length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function retireOwnedFile(runtimeRoot, target, backup, expectedSha256) {
  const before = safeRead(target);
  if (before === null || sha256(before) !== expectedSha256) {
    return {
      retired: false,
      reason: 'obsolete managed file changed before retirement and was preserved',
      actualSha256: before === null ? null : sha256(before),
    };
  }
  fs.renameSync(target, backup);
  const moved = safeRead(backup);
  const movedSha256 = moved === null ? null : sha256(moved);
  if (movedSha256 === expectedSha256) return { retired: true };

  let restored = false;
  if (!pathExists(target) && pathExists(backup)) {
    try {
      fs.renameSync(backup, target);
      restored = true;
    } catch {
      restored = false;
    }
  }
  return {
    retired: false,
    reason: restored
      ? 'obsolete managed file changed during retirement; active path was restored'
      : 'obsolete managed file changed during retirement; active path or recoverable backup was preserved',
    actualSha256: movedSha256,
    backup: pathExists(backup) ? relativePath(runtimeRoot, backup) : null,
  };
}

function installRuntimeStandards({ projectRoot, sourceRoot, catalog, selection, runtime, dryRun = false }) {
  const runtimeRoot = path.join(projectRoot, runtime === 'codex' ? '.codex' : '.claude');
  if (!dryRun) fs.mkdirSync(runtimeRoot, { recursive: true });
  assertPlainPath(projectRoot, runtimeRoot, `${runtime} project standards root`);
  const runtimeGuardRoot = pathExists(runtimeRoot) ? runtimeRoot : projectRoot;
  function assertRuntimeTarget(target, label) {
    if (!pathIsInside(runtimeRoot, target)) throw new Error(`${label} escapes runtime root: ${target}`);
    return assertPlainPath(runtimeGuardRoot, target, label);
  }
  for (const directory of ['rules', 'commands', 'skills']) {
    const target = path.join(runtimeRoot, directory);
    if (!dryRun) fs.mkdirSync(target, { recursive: true });
    assertRuntimeTarget(target, `${runtime} ${directory}`);
  }
  const manifestSnapshot = readManifestSnapshot(runtimeRoot, runtime, sourceRoot, catalog);
  const previous = manifestSnapshot.manifest;
  const canonicalAssetHistory = trustedAssetIndex(sourceRoot, catalog, runtime);
  const previousByPath = new Map((previous ? previous.assets : []).map((asset) => [asset.path, asset]));
  const assets = resolveAssets({ sourceRoot, catalog, profiles: selection.profiles, runtime });
  const desiredPaths = new Set(assets.map((asset) => asset.path));
  const previousPaths = new Set(previous ? previous.assets.map((asset) => asset.path) : []);
  const created = [];
  const updated = [];
  const unchanged = [];
  const retired = [];
  const conflicts = [];
  let backupRoot = null;

  for (const [knownPath] of canonicalAssetHistory) {
    if (desiredPaths.has(knownPath) || previousPaths.has(knownPath)) continue;
    const target = path.join(runtimeRoot, ...knownPath.split('/'));
    assertRuntimeTarget(target, `${runtime} undeclared canonical asset`);
    if (pathExists(target)) {
      conflicts.push({
        path: knownPath,
        reason: 'reserved canonical target exists outside the managed manifest and was preserved',
        actualSha256: sha256(fs.readFileSync(target)),
        desiredSha256: null,
      });
    }
  }

  for (const asset of assets) {
    const target = path.join(runtimeRoot, ...asset.path.split('/'));
    assertRuntimeTarget(target, `${runtime} managed ${asset.kind}`);
    const current = safeRead(target);
    if (current === null) {
      if (!dryRun) writeFileAtomic(runtimeRoot, target, asset.content, `${runtime} managed ${asset.kind}`, null);
      created.push(asset.path);
      continue;
    }
    const actualSha256 = sha256(current);
    if (actualSha256 === asset.sha256) {
      unchanged.push(asset.path);
      continue;
    }
    const owned = previousByPath.get(asset.path);
    if (owned && owned.sha256 === actualSha256
        && isTrustedHistoricalAsset(owned, canonicalAssetHistory, catalog, runtime)) {
      if (!dryRun) writeFileAtomic(runtimeRoot, target, asset.content, `${runtime} managed ${asset.kind}`, actualSha256);
      updated.push(asset.path);
      continue;
    }
    const legacyHashes = catalog.legacyHashes
      && catalog.legacyHashes[asset.path]
      && catalog.legacyHashes[asset.path][runtime];
    if (Array.isArray(legacyHashes) && legacyHashes.includes(actualSha256)) {
      if (!dryRun) writeFileAtomic(runtimeRoot, target, asset.content, `${runtime} legacy managed ${asset.kind}`, actualSha256);
      updated.push(asset.path);
      continue;
    }
    conflicts.push({
      path: asset.path,
      reason: 'refusing to overwrite user-owned or diverged file',
      actualSha256,
      desiredSha256: asset.sha256,
    });
  }

  for (const obsolete of previous ? previous.assets : []) {
    if (desiredPaths.has(obsolete.path)) continue;
    const target = path.join(runtimeRoot, ...obsolete.path.split('/'));
    assertRuntimeTarget(target, `${runtime} obsolete managed asset`);
    const current = safeRead(target);
    if (current === null) continue;
    const actualSha256 = sha256(current);
    if (!isTrustedHistoricalAsset(obsolete, canonicalAssetHistory, catalog, runtime)) {
      conflicts.push({
        path: obsolete.path,
        reason: 'obsolete manifest ownership is not proven by canonical or allowlisted history',
        actualSha256,
        desiredSha256: null,
      });
      continue;
    }
    if (actualSha256 !== obsolete.sha256) {
      conflicts.push({
        path: obsolete.path,
        reason: 'obsolete managed file diverged and was preserved',
        actualSha256,
        desiredSha256: null,
      });
      continue;
    }
    if (!backupRoot) {
      backupRoot = dryRun
        ? path.join(runtimeRoot, 'tech-persistence-backups', 'project-standards-planned')
        : backupRootFor(runtimeRoot);
      if (!dryRun) {
        const backupParent = path.dirname(backupRoot);
        if (!pathExists(backupParent)) fs.mkdirSync(backupParent);
        assertPlainPath(runtimeRoot, backupParent, `${runtime} project standards backup parent`);
        assertPlainPath(runtimeRoot, backupRoot, `${runtime} project standards backup`);
        fs.mkdirSync(backupRoot);
        assertPlainPath(runtimeRoot, backupRoot, `${runtime} project standards backup`);
      }
    }
    const backup = path.join(backupRoot, ...obsolete.path.split('/'));
    if (!dryRun) {
      assertPlainPath(runtimeRoot, path.dirname(backup), `${runtime} project standards backup directory`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      assertPlainPath(runtimeRoot, backup, `${runtime} project standards backup`);
      const retirement = retireOwnedFile(runtimeRoot, target, backup, obsolete.sha256);
      if (!retirement.retired) {
        conflicts.push({
          path: obsolete.path,
          reason: retirement.reason,
          actualSha256: retirement.actualSha256,
          desiredSha256: null,
          ...(retirement.backup ? { backup: retirement.backup } : {}),
        });
        continue;
      }
      removeEmptyManagedParents(runtimeRoot, target);
    }
    retired.push({ path: obsolete.path, backup: relativePath(runtimeRoot, backup) });
  }

  const attributes = updateManagedGitAttributes(projectRoot, sourceRoot, catalog, { dryRun, previous });
  if (attributes.status === 'conflict') conflicts.push({ path: attributes.path, reason: attributes.reason });
  const entrypoint = updateManagedEntryPoint(projectRoot, runtime, { dryRun, previous });
  if (entrypoint.status === 'conflict') conflicts.push({ path: entrypoint.path, reason: entrypoint.reason });
  const manifest = {
    schemaVersion: 1,
    owner: 'tech-persistence',
    runtime,
    mode: selection.mode,
    profiles: selection.profiles,
    scopes: Object.fromEntries(selection.profiles.map((profile) => [
      profile,
      catalog.profiles[profile].scopes,
    ])),
    evidence: selection.evidence,
    assets: assets.map(({ content, ...asset }) => asset),
    conflicts,
    attributes: {
      path: attributes.path,
      markerSha256: sha256(managedGitAttributesBlock(sourceRoot, catalog)),
    },
    entrypoint: {
      path: entrypoint.path,
      markerSha256: sha256(managedEntryBlock(runtime)),
    },
  };
  const manifestPath = path.join(runtimeRoot, MANIFEST_NAME);
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!dryRun && manifestSnapshot.raw !== manifestContent) {
    writeFileAtomic(
      runtimeRoot,
      manifestPath,
      manifestContent,
      `${runtime} project standards manifest`,
      manifestSnapshot.sha256
    );
  } else if (!dryRun) {
    const currentManifest = safeRead(manifestPath);
    const currentSha256 = currentManifest === null ? null : sha256(currentManifest);
    if (currentSha256 !== manifestSnapshot.sha256) {
      throw new Error(`${runtime} project standards manifest changed during installation`);
    }
  }
  return {
    runtime,
    manifestPath,
    created,
    updated,
    unchanged,
    retired,
    conflicts,
    backupRoot,
    attributes,
    entrypoint,
  };
}

function resolveSelection(projectRoot, profiles, options = {}) {
  if (profiles !== undefined && profiles !== null && profiles !== 'auto') {
    return normalizeExplicitProfiles(profiles);
  }
  if (!options.refreshAuto && options.sourceRoot && options.catalog) {
    const explicitSelections = [];
    for (const runtime of ['claude', 'codex']) {
      const runtimeRoot = path.join(projectRoot, runtime === 'codex' ? '.codex' : '.claude');
      const manifestPath = path.join(runtimeRoot, MANIFEST_NAME);
      if (!pathExists(manifestPath)) continue;
      let manifest;
      try {
        manifest = readManifestSnapshot(
          runtimeRoot,
          runtime,
          options.sourceRoot,
          options.catalog
        ).manifest;
      } catch (error) {
        throw new Error(`cannot preserve existing ${runtime} profile selection: ${error.message}`);
      }
      if (manifest.mode === 'explicit') explicitSelections.push({ runtime, profiles: manifest.profiles });
    }
    if (explicitSelections.length > 0) {
      const expected = explicitSelections[0].profiles;
      const mismatch = explicitSelections.find(
        (selection) => JSON.stringify(selection.profiles) !== JSON.stringify(expected)
      );
      if (mismatch) {
        throw new Error('existing Claude/Codex explicit profile selections disagree; select profiles explicitly');
      }
      return normalizeExplicitProfiles(expected);
    }
  }
  return detectProjectProfiles(projectRoot);
}

function normalizeRuntimes(runtime = 'both') {
  if (runtime === 'both') return ['claude', 'codex'];
  if (!RUNTIMES.has(runtime)) throw new Error(`unsupported project standards runtime: ${runtime}`);
  return [runtime];
}

function planProjectStandards(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const sourceRoot = path.resolve(options.sourceRoot || path.join(__dirname, '..', 'project-level'));
  const catalog = loadProjectStandardsCatalog(sourceRoot);
  const selection = resolveSelection(projectRoot, options.profiles, {
    sourceRoot,
    catalog,
    refreshAuto: options.refreshAuto,
  });
  const assets = {};
  const results = {};
  for (const runtime of normalizeRuntimes(options.runtime)) {
    assets[runtime] = resolveAssets({ sourceRoot, catalog, profiles: selection.profiles, runtime })
      .map(({ content, ...asset }) => asset);
    results[runtime] = installRuntimeStandards({
      projectRoot,
      sourceRoot,
      catalog,
      selection,
      runtime,
      dryRun: true,
    });
  }
  return { projectRoot, sourceRoot, ...selection, assets, results };
}

function installProjectStandards(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const sourceRoot = path.resolve(options.sourceRoot || path.join(__dirname, '..', 'project-level'));
  assertPlainPath(projectRoot, projectRoot, 'project root');
  const catalog = loadProjectStandardsCatalog(sourceRoot);
  const selection = resolveSelection(projectRoot, options.profiles, {
    sourceRoot,
    catalog,
    refreshAuto: options.refreshAuto,
  });
  const results = {};
  for (const runtime of normalizeRuntimes(options.runtime)) {
    results[runtime] = installRuntimeStandards({
      projectRoot, sourceRoot, catalog, selection, runtime,
    });
  }
  return { projectRoot, sourceRoot, ...selection, results };
}

function assetShape(asset) {
  return {
    kind: asset.kind,
    profile: asset.profile,
    source: asset.source,
    path: asset.path,
    sha256: asset.sha256,
  };
}

function validateProjectStandards(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const sourceRoot = path.resolve(options.sourceRoot || path.join(__dirname, '..', 'project-level'));
  const runtime = options.runtime;
  if (!RUNTIMES.has(runtime)) throw new Error('validateProjectStandards requires runtime=claude or runtime=codex');
  const runtimeRoot = path.join(projectRoot, runtime === 'codex' ? '.codex' : '.claude');
  const issues = [];
  const manifestPath = path.join(runtimeRoot, MANIFEST_NAME);
  if (!pathExists(manifestPath)) {
    return { valid: false, issues: [{ path: relativePath(projectRoot, manifestPath), reason: 'manifest missing' }], manifest: null };
  }
  const catalog = loadProjectStandardsCatalog(sourceRoot);
  let manifest;
  try {
    assertPlainPath(projectRoot, runtimeRoot, `${runtime} project standards root`);
    manifest = readPreviousManifest(runtimeRoot, runtime, sourceRoot, catalog);
  } catch (error) {
    return { valid: false, issues: [{ path: relativePath(projectRoot, manifestPath), reason: error.message }], manifest: null };
  }
  const selection = manifest.mode === 'auto'
    ? detectProjectProfiles(projectRoot)
    : normalizeExplicitProfiles(manifest.profiles);
  if (options.profiles !== undefined && options.profiles !== null && options.profiles !== 'auto') {
    const requestedSelection = normalizeExplicitProfiles(options.profiles);
    if (JSON.stringify(requestedSelection.profiles) !== JSON.stringify(manifest.profiles)) {
      issues.push({
        path: MANIFEST_NAME,
        reason: `requested profile selection differs from manifest: ${requestedSelection.profiles.join(', ')}`,
      });
    }
  }
  if (JSON.stringify(selection.profiles) !== JSON.stringify(manifest.profiles)) {
    issues.push({
      path: MANIFEST_NAME,
      reason: `profile drift: expected ${selection.profiles.join(', ')}, manifest has ${manifest.profiles.join(', ')}`,
    });
  }
  const expectedScopes = Object.fromEntries(selection.profiles.map((profile) => [
    profile,
    catalog.profiles[profile].scopes,
  ]));
  if (JSON.stringify(expectedScopes) !== JSON.stringify(manifest.scopes)) {
    issues.push({ path: MANIFEST_NAME, reason: 'profile scope metadata differs from canonical catalog' });
  }
  if (JSON.stringify(selection.evidence) !== JSON.stringify(manifest.evidence)) {
    issues.push({ path: MANIFEST_NAME, reason: 'profile evidence differs from current canonical selection' });
  }
  const expectedAssets = resolveAssets({
    sourceRoot,
    catalog,
    profiles: selection.profiles,
    runtime,
  }).map(assetShape);
  if (JSON.stringify(expectedAssets) !== JSON.stringify(manifest.assets.map(assetShape))) {
    issues.push({ path: MANIFEST_NAME, reason: 'manifest asset inventory/hash differs from canonical source' });
  }
  if (Array.isArray(manifest.conflicts) && manifest.conflicts.length > 0) {
    for (const conflict of manifest.conflicts) issues.push({ path: conflict.path, reason: conflict.reason });
  }
  if (!manifest.attributes) {
    issues.push({ path: '.gitattributes', reason: 'manifest attributes ownership metadata missing' });
  }
  try {
    const attributes = updateManagedGitAttributes(projectRoot, sourceRoot, catalog, { dryRun: true });
    if (attributes.status !== 'unchanged') {
      issues.push({
        path: attributes.path,
        reason: attributes.reason || 'project standards LF attributes block missing',
      });
    }
  } catch (error) {
    issues.push({ path: '.gitattributes', reason: error.message });
  }
  for (const asset of expectedAssets) {
    const target = path.join(runtimeRoot, ...asset.path.split('/'));
    try {
      assertPlainPath(runtimeRoot, target, `${runtime} managed asset`);
      if (!pathExists(target)) {
        issues.push({ path: asset.path, reason: 'managed asset missing' });
        continue;
      }
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        issues.push({ path: asset.path, reason: 'managed asset must be a plain file' });
        continue;
      }
      const actual = sha256(fs.readFileSync(target));
      if (actual !== asset.sha256) issues.push({ path: asset.path, reason: 'managed asset hash mismatch' });
    } catch (error) {
      issues.push({ path: asset.path, reason: error.message });
    }
  }
  const expectedPaths = new Set(expectedAssets.map((asset) => asset.path));
  for (const [knownPath] of trustedAssetIndex(sourceRoot, catalog, runtime)) {
    if (expectedPaths.has(knownPath)) continue;
    const target = path.join(runtimeRoot, ...knownPath.split('/'));
    try {
      assertPlainPath(runtimeRoot, target, `${runtime} undeclared canonical asset`);
      if (pathExists(target)) {
        issues.push({ path: knownPath, reason: 'undeclared stale canonical asset remains in the runtime root' });
      }
    } catch (error) {
      issues.push({ path: knownPath, reason: error.message });
    }
  }
  const entryName = runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  const entryTarget = path.join(projectRoot, entryName);
  let entryContent = '';
  try {
    assertPlainPath(projectRoot, entryTarget, `${runtime} project standards entrypoint`);
    entryContent = safeRead(entryTarget) || '';
  } catch (error) {
    issues.push({ path: entryName, reason: error.message });
  }
  const entryStartCount = entryContent.split(MANAGED_START).length - 1;
  const entryEndCount = entryContent.split(MANAGED_END).length - 1;
  const entryStart = entryContent.indexOf(MANAGED_START);
  const entryEnd = entryContent.indexOf(MANAGED_END, entryStart);
  if (entryStartCount !== 1 || entryEndCount !== 1 || entryEnd < entryStart) {
    issues.push({ path: entryName, reason: 'project standards routing block missing' });
  } else {
    const actualBlock = entryContent.slice(entryStart, entryEnd + MANAGED_END.length);
    if (sha256(actualBlock) !== sha256(managedEntryBlock(runtime))) {
      issues.push({ path: entryName, reason: 'project standards routing block hash mismatch' });
    }
  }

  const sibling = runtime === 'codex' ? 'claude' : 'codex';
  const siblingRoot = path.join(projectRoot, sibling === 'codex' ? '.codex' : '.claude');
  const siblingManifestPath = path.join(siblingRoot, MANIFEST_NAME);
  if (!options.skipSibling && pathExists(siblingManifestPath)) {
    try {
      const siblingValidation = validateProjectStandards({
        projectRoot,
        sourceRoot,
        runtime: sibling,
        skipSibling: true,
      });
      for (const issue of siblingValidation.issues) {
        issues.push({ path: `${sibling}:${issue.path}`, reason: `sibling runtime: ${issue.reason}` });
      }
      const siblingManifest = siblingValidation.manifest;
      if (!siblingManifest) throw new Error(`${sibling} project standards manifest is invalid`);
      for (const field of ['schemaVersion', 'owner', 'mode']) {
        if (siblingManifest[field] !== manifest[field]) {
          issues.push({ path: MANIFEST_NAME, reason: `${runtime}/${sibling} ${field} parity mismatch` });
        }
      }
      if (JSON.stringify(siblingManifest.profiles) !== JSON.stringify(manifest.profiles)) {
        issues.push({ path: MANIFEST_NAME, reason: `${runtime}/${sibling} profile parity mismatch` });
      }
      if (JSON.stringify(siblingManifest.scopes) !== JSON.stringify(manifest.scopes)
          || JSON.stringify(siblingManifest.evidence) !== JSON.stringify(manifest.evidence)) {
        issues.push({ path: MANIFEST_NAME, reason: `${runtime}/${sibling} scope/evidence parity mismatch` });
      }
      if (JSON.stringify(siblingManifest.attributes) !== JSON.stringify(manifest.attributes)) {
        issues.push({ path: MANIFEST_NAME, reason: `${runtime}/${sibling} attributes parity mismatch` });
      }
      const semantic = (assets) => assets.map((asset) => [asset.kind, asset.profile, asset.source, asset.path]);
      if (JSON.stringify(semantic(siblingManifest.assets)) !== JSON.stringify(semantic(manifest.assets))) {
        issues.push({ path: MANIFEST_NAME, reason: `${runtime}/${sibling} asset parity mismatch` });
      }
    } catch (error) {
      issues.push({ path: relativePath(projectRoot, siblingManifestPath), reason: error.message });
    }
  }
  return { valid: issues.length === 0, issues, manifest };
}

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    sourceRoot: path.join(__dirname, '..', 'project-level'),
    runtime: 'both',
    profiles: 'auto',
    refreshAuto: false,
    detectOnly: false,
    check: false,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--project-root', '--source-root', '--runtime', '--profiles'].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--project-root') options.projectRoot = value;
      else if (argument === '--source-root') options.sourceRoot = value;
      else if (argument === '--runtime') options.runtime = value;
      else options.profiles = value;
    } else if (argument === '--detect-only') options.detectOnly = true;
    else if (argument === '--refresh-auto') options.refreshAuto = true;
    else if (argument === '--check') options.check = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function helpText() {
  return [
    'Usage: node scripts/project-standards.js [options]',
    '',
    '  --project-root <path>       Project to inspect/install (default: cwd)',
    '  --source-root <path>        Canonical project-level source root',
    '  --runtime claude|codex|both Projection target (default: both)',
    '  --profiles auto|a,b         Auto-detect or explicitly select profiles',
    '  --refresh-auto              Re-detect even when an explicit manifest selection exists',
    '  --detect-only               Print evidence without writing files',
    '  --dry-run                   Resolve the exact asset plan without writing',
    '  --check                     Validate installed assets and parity',
    '  --json                      Emit machine-readable JSON',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  let result;
  let exitCode = 0;
  if (options.detectOnly) {
    result = options.profiles === 'auto'
      ? detectProjectProfiles(options.projectRoot)
      : normalizeExplicitProfiles(options.profiles);
  } else if (options.dryRun) {
    result = planProjectStandards(options);
  } else if (options.check) {
    result = {};
    for (const runtime of normalizeRuntimes(options.runtime)) {
      result[runtime] = validateProjectStandards({ ...options, runtime });
      if (!result[runtime].valid) exitCode = 1;
    }
  } else {
    result = installProjectStandards(options);
    if (Object.values(result.results).some((runtime) => runtime.conflicts.length > 0)) exitCode = 2;
  }
  if (options.json) console.log(JSON.stringify(result));
  else if (options.detectOnly) console.log(`profiles=${result.profiles.join(',')} evidence=${result.evidence.length}`);
  else if (options.check) {
    for (const [runtime, validation] of Object.entries(result)) {
      console.log(`${validation.valid ? '[OK]' : '[FAIL]'} ${runtime} project standards (${validation.issues.length} issue(s))`);
      for (const issue of validation.issues) console.log(`  ${issue.path}: ${issue.reason}`);
    }
  } else {
    console.log(`[OK] project profiles: ${result.profiles.join(', ')}`);
    for (const [runtime, installed] of Object.entries(result.results)) {
      console.log(`[${installed.conflicts.length ? 'WARN' : 'OK'}] ${runtime}: ${installed.created.length} created, ${installed.updated.length} updated, ${installed.retired.length} retired, ${installed.conflicts.length} conflicts`);
    }
  }
  return exitCode;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  MANAGED_END,
  MANAGED_START,
  MANIFEST_NAME,
  PROFILE_ORDER,
  detectProjectProfiles,
  helpText,
  installProjectStandards,
  loadProjectStandardsCatalog,
  main,
  managedEntryBlock,
  normalizeExplicitProfiles,
  parseArgs,
  planProjectStandards,
  resolveAssets,
  validateProjectStandards,
};
