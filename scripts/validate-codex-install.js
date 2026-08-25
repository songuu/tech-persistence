#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  hashPath,
  hookLogicalIds,
  inspectPluginOwnerIntegrity,
  inspectManagedSkillExclusions,
  normalizePluginOwners,
} = require('./codex-runtime-doctor');
const { inspectDisabledSkillPaths } = require('./install-managed-project-fallback');
const {
  MANAGED_END: PROJECT_STANDARDS_END,
  MANAGED_START: PROJECT_STANDARDS_START,
  validateProjectStandards,
} = require('./project-standards');

const repoRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const CANONICAL_PLUGIN_ID = 'tech-persistence@local-plugins';
const OWNER_MANIFEST = 'tech-persistence-owner.json';

let hasFailure = false;

function fail(message) {
  console.error(`[FAIL] ${message}`);
  hasFailure = true;
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function expandHome(value, homeDir) {
  if (!value) return value;
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  return value;
}

function readJson(file, label, onFailure = fail) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    onFailure(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function isFile(file, label) {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) {
    fail(`${label} missing or not a file`);
    return false;
  }
  ok(`${label} exists`);
  return true;
}

function isDirectory(dir, label) {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) {
    fail(`${label} missing or not a directory`);
    return false;
  }
  ok(`${label} exists`);
  return true;
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function listSkillDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function expectedUserCommands() {
  return listMarkdownFiles(path.join(repoRoot, 'user-level', 'commands'));
}

function expectedProjectCommands() {
  return listMarkdownFiles(path.join(repoRoot, 'project-level', '.claude', 'commands'));
}

function expectedUserRules() {
  return listMarkdownFiles(path.join(repoRoot, 'user-level', 'rules'));
}

function expectedProjectRules() {
  return listMarkdownFiles(path.join(repoRoot, 'project-level', '.claude', 'rules'));
}

function standardAssetNames(validation, kind) {
  if (!validation || !validation.manifest || !Array.isArray(validation.manifest.assets)) return [];
  return validation.manifest.assets
    .filter((asset) => asset.kind === kind)
    .map((asset) => path.basename(asset.path))
    .sort();
}

function union(left, right) {
  return [...new Set([...left, ...right])].sort();
}

function validateInventory(dir, expected, label) {
  if (!isDirectory(dir, label)) return;
  const actual = listMarkdownFiles(dir);
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    fail(`${label} inventory mismatch. Missing: ${missing.join(', ') || 'none'}; Extra: ${extra.join(', ') || 'none'}`);
  } else {
    ok(`${label} has ${expected.length} files`);
  }
}

function validateNativeCommands(commandRoot, label, onFailure = fail, onSuccess = ok) {
  const nativeRoot = path.join(repoRoot, 'codex-native', 'commands');
  let valid = true;
  for (const name of ['compound.md', 'plan.md', 'review.md', 'sprint.md', 'think.md', 'work.md']) {
    const expectedPath = path.join(nativeRoot, name);
    const installedPath = path.join(commandRoot, name);
    if (!fs.existsSync(installedPath)
        || !fs.readFileSync(expectedPath).equals(fs.readFileSync(installedPath))) {
      onFailure(`${label}/${name} does not byte-match codex-native/commands/${name}`);
      valid = false;
    }
  }
  if (valid) onSuccess(`${label} has byte-identical native think/plan/work/review/compound/sprint commands`);
  return valid;
}

function walkMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdownFiles(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

function validateCodexText(dir, label, options = {}) {
  const strictForbidden = /CLAUDE\.md|Claude Code|~\/\.claude|\.claude\/|Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/;
  const crossRuntimeForbidden = /Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/;
  const allowedFiles = new Set(
    (options.allowCrossRuntimeFiles || []).map((file) => String(file).replace(/\\/g, '/'))
  );
  const onFailure = options.onFailure || fail;
  for (const file of walkMarkdownFiles(dir)) {
    const relative = path.relative(dir, file).replace(/\\/g, '/');
    const forbidden = options.allowCrossRuntimeReferences || allowedFiles.has(relative)
      ? crossRuntimeForbidden
      : strictForbidden;
    if (forbidden.test(fs.readFileSync(file, 'utf8'))) {
      onFailure(`${label} contains unconverted or mojibake text: ${file}`);
    }
  }
}

function stripManagedSolutionIndex(content) {
  return content.replace(
    /<!-- BEGIN TECH_PERSISTENCE_SOLUTIONS_INDEX -->[\s\S]*?<!-- END TECH_PERSISTENCE_SOLUTIONS_INDEX -->/g,
    ''
  );
}

function validateCodexFile(file, label) {
  if (!fs.existsSync(file)) return;
  const forbidden = /CLAUDE\.md|Claude Code|~\/\.claude|\.claude\/|Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/;
  if (forbidden.test(stripManagedSolutionIndex(fs.readFileSync(file, 'utf8')))) {
    fail(`${label} contains unconverted or mojibake text`);
  }
}

function inspectMarketplace(marketplacePath) {
  if (!fs.existsSync(marketplacePath)) return { valid: false, errors: ['marketplace.json missing'] };
  let marketplace;
  try {
    marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  } catch (error) {
    return { valid: false, errors: [`invalid JSON: ${error.message}`] };
  }
  const entries = (Array.isArray(marketplace.plugins) ? marketplace.plugins : [])
    .filter((plugin) => plugin && plugin.name === 'tech-persistence');
  const errors = [];
  if (marketplace.name !== 'local-plugins') errors.push('marketplace name must be local-plugins');
  if (entries.length !== 1) errors.push(`expected one tech-persistence entry, found ${entries.length}`);
  const entry = entries[0];
  if (entry && entry.source?.source !== 'local') errors.push('plugin source must be local');
  if (entry && entry.source?.path !== './plugins/tech-persistence') {
    errors.push('plugin path must be ./plugins/tech-persistence');
  }
  return { valid: errors.length === 0, errors, marketplace, entry };
}

function ownerProbe({ pluginListFile, pluginListJson, codexHome } = {}) {
  if (pluginListFile || pluginListJson) {
    try {
      const pluginList = pluginListJson ? JSON.parse(pluginListJson) : JSON.parse(fs.readFileSync(pluginListFile, 'utf8'));
      const owners = normalizePluginOwners(pluginList);
      return {
        available: true,
        status: owners.length === 1 ? 0 : owners.length === 0 ? 2 : 3,
        ownerCount: owners.length,
        pluginIds: owners.map((owner) => owner.pluginId),
        owners,
        integrity: codexHome
          ? owners.map((owner) => inspectPluginOwnerIntegrity(codexHome, owner))
          : [],
        output: '',
      };
    } catch (error) {
      return { available: true, error: `invalid plugin list input: ${error.message}`, output: '' };
    }
  }
  const doctor = path.join(repoRoot, 'scripts', 'codex-runtime-doctor.js');
  const doctorArgs = [doctor, '--plugin-owner-status'];
  if (codexHome) doctorArgs.push('--codex-home', codexHome);
  doctorArgs.push('--json');
  const result = spawnSync(process.execPath, doctorArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const combined = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const jsonLine = combined.split(/\r?\n/).find((line) => line.trim().startsWith('{'));
  if ([0, 2, 3].includes(result.status) && jsonLine) {
    try {
      const payload = JSON.parse(jsonLine);
      return { available: true, status: result.status, ...payload, output: combined };
    } catch (error) {
      return { available: true, error: `invalid owner JSON: ${error.message}`, output: combined };
    }
  }
  const unavailable = Boolean(result.error)
    || /ENOENT|not found|is not recognized|failed to spawn codex|EPERM/i.test(combined);
  return unavailable
    ? { available: false, ownerCount: 0, pluginIds: [], output: combined, error: result.error?.message || null }
    : { available: true, error: combined || `owner probe exited ${result.status}` };
}

function validateNativeAgents(file, kind, label, onFailure = fail, onSuccess = ok) {
  const template = path.join(repoRoot, 'codex-native', 'agents', `${kind}.md`);
  if (!fs.existsSync(file) || !fs.existsSync(template)) return false;
  let actual = fs.readFileSync(file, 'utf8');
  const expected = fs.readFileSync(template, 'utf8');
  if (kind === 'project') {
    const start = actual.indexOf(PROJECT_STANDARDS_START);
    const end = actual.indexOf(PROJECT_STANDARDS_END, start);
    if (start >= 0 && end >= start) {
      actual = `${actual.slice(0, start).trimEnd()}\n${actual.slice(end + PROJECT_STANDARDS_END.length).trimStart()}`;
    }
  }
  if (actual.replace(/\r\n/g, '\n').trimEnd() !== expected.replace(/\r\n/g, '\n').trimEnd()) {
    onFailure(`${label} is preserved custom or stale generated content; Codex-native context optimization is not active`);
    return false;
  }
  onSuccess(`${label} matches the lean Codex-native ${kind} template${kind === 'project' ? ' plus the managed standards router' : ''}`);
  return true;
}

function validateOwnerIntegrity(owner, expectedSourceRoot, onFailure = fail, onSuccess = ok) {
  const records = Array.isArray(owner.integrity) ? owner.integrity : [];
  const record = records.find((item) => item && item.pluginId === CANONICAL_PLUGIN_ID);
  if (!record) {
    onFailure('canonical owner source/cache integrity evidence is missing');
    return false;
  }
  if (!record.valid) {
    onFailure(`canonical owner source/cache integrity failed: ${(record.errors || []).join('; ') || 'unknown drift'}`);
    return false;
  }
  if (expectedSourceRoot && path.resolve(record.sourceRoot) !== path.resolve(expectedSourceRoot)) {
    onFailure(`canonical owner source path differs from installed plugin root: ${record.sourceRoot}`);
    return false;
  }
  onSuccess(`owner/source/cache version ${record.ownerVersion} and content hash agree`);
  return true;
}

function validateDirectFallback({
  codexRoot,
  canonicalSkillsRoot,
  userCodexRoot = codexRoot,
  onFailure = fail,
  onSuccess = ok,
}) {
  const manifestPath = path.join(codexRoot, OWNER_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    onFailure(`${manifestPath} missing`);
    return false;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    onFailure(`${manifestPath} invalid JSON: ${error.message}`);
    return false;
  }
  if (manifest.schemaVersion !== 1 || manifest.owner !== 'tech-persistence'
      || manifest.mode !== 'project-direct-fallback' || !Array.isArray(manifest.managed)) {
    onFailure(`${manifestPath} has an unsupported owner manifest shape`);
    return false;
  }
  const canonicalNames = listSkillDirs(canonicalSkillsRoot);
  const entries = [...manifest.managed].sort((left, right) => String(left.path).localeCompare(String(right.path)));
  const managedNames = entries.map((entry) => String(entry.path || '').replace(/^skills\//, ''));
  if (JSON.stringify(managedNames) !== JSON.stringify(canonicalNames)) {
    onFailure(`fallback skill inventory mismatch. Expected: ${canonicalNames.join(', ')}; managed: ${managedNames.join(', ')}`);
    return false;
  }
  let valid = true;
  for (const entry of entries) {
    if (!/^skills\/[A-Za-z0-9._-]+$/.test(entry.path) || typeof entry.sha256 !== 'string') {
      onFailure(`unsafe fallback manifest entry: ${JSON.stringify(entry)}`);
      valid = false;
      continue;
    }
    const name = entry.path.slice('skills/'.length);
    const target = path.join(codexRoot, 'skills', name);
    const canonical = path.join(canonicalSkillsRoot, name);
    const actualHash = hashPath(target);
    const canonicalHash = hashPath(canonical);
    if (!actualHash || actualHash !== entry.sha256 || canonicalHash !== entry.sha256) {
      onFailure(`fallback hash mismatch: ${entry.path}`);
      valid = false;
    }
  }
  const disabled = inspectDisabledSkillPaths(path.join(userCodexRoot, 'config.toml'));
  if (disabled.invalid) {
    onFailure(`Codex skills.config cannot prove fallback activation: ${disabled.invalid}`);
    valid = false;
  } else {
    for (const entry of entries) {
      const skillFile = path.join(codexRoot, entry.path, 'SKILL.md');
      if ([...disabled.paths.values()].some((configuredPath) => samePath(configuredPath, skillFile))) {
        onFailure(`fallback skill is disabled by skills.config: ${skillFile}`);
        valid = false;
      }
    }
  }
  if (valid) onSuccess(`managed project fallback has ${entries.length} verified skills`);
  return valid;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isManagedExcluded(exclusions, skillFile) {
  return [...exclusions.paths.values()].some((configuredPath) => samePath(configuredPath, skillFile));
}

function hasActiveManagedFallback(codexRoot, exclusions = { paths: new Map() }) {
  const manifestPath = path.join(codexRoot, OWNER_MANIFEST);
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(manifest.managed)
      && manifest.managed.some((entry) => {
        if (typeof entry.path !== 'string') return false;
        const managedRoot = path.join(codexRoot, entry.path);
        const skillFile = path.join(managedRoot, 'SKILL.md');
        return fs.existsSync(managedRoot) && !isManagedExcluded(exclusions, skillFile);
      });
  } catch {
    return true;
  }
}

function findDirectCollisions(codexRoot, canonicalPluginRoot, options = {}) {
  const collisions = [];
  const exclusions = options.exclusions
    || inspectManagedSkillExclusions(options.userCodexRoot || codexRoot);
  if (exclusions.invalid) return ['config-exclusion-error:' + exclusions.invalid];
  const canonicalSkillsRoot = path.join(canonicalPluginRoot, 'codex-skills');
  for (const name of listSkillDirs(canonicalSkillsRoot)) {
    const skillFile = path.join(codexRoot, 'skills', name, 'SKILL.md');
    if (fs.existsSync(skillFile) && !isManagedExcluded(exclusions, skillFile)) {
      collisions.push(`skill:${name}`);
    }
  }

  const pluginManifestPath = path.join(canonicalPluginRoot, '.codex-plugin', 'plugin.json');
  if (!fs.existsSync(pluginManifestPath)) return collisions;
  try {
    const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8'));
    const canonicalHookConfig = path.resolve(canonicalPluginRoot, pluginManifest.hooks || './codex-hooks/hooks.json');
    const canonicalHookIds = hookLogicalIds(canonicalHookConfig);
    for (const candidate of [
      path.join(codexRoot, 'hooks.json'),
      path.join(codexRoot, 'tech-persistence-hooks', 'hooks.json'),
      path.join(codexRoot, 'skills', 'continuous-learning', 'hooks', 'hooks.json'),
    ]) {
      if (!fs.existsSync(candidate)) continue;
      const nestedSkillFile = path.join(codexRoot, 'skills', 'continuous-learning', 'SKILL.md');
      if (samePath(candidate, path.join(codexRoot, 'skills', 'continuous-learning', 'hooks', 'hooks.json'))
          && isManagedExcluded(exclusions, nestedSkillFile)) {
        continue;
      }
      const overlap = [...hookLogicalIds(candidate)].filter((id) => canonicalHookIds.has(id));
      if (overlap.length > 0) collisions.push(`hooks:${path.relative(codexRoot, candidate).replace(/\\/g, '/')}`);
    }
  } catch (error) {
    collisions.push(`hook-analysis-error:${error.message}`);
  }
  return collisions;
}

function validatePluginBundle(pluginRoot, label) {
  if (!isDirectory(pluginRoot, label)) return;
  if (fs.existsSync(path.join(pluginRoot, 'commands'))) {
    fail(`${label} must not contain legacy commands; Codex auto-migrates them into duplicate skills`);
  } else {
    ok(`${label} excludes legacy commands`);
  }
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  if (!isFile(manifestPath, `${label}/.codex-plugin/plugin.json`)) return;
  const manifest = readJson(manifestPath, manifestPath);
  if (!manifest) return;
  if (manifest.name !== 'tech-persistence') fail(`${label} manifest name must be tech-persistence`);
  if (manifest.skills !== './codex-skills/') fail(`${label} must expose ./codex-skills/`);
  if (manifest.hooks !== './codex-hooks/hooks.json') fail(`${label} must expose ./codex-hooks/hooks.json`);
  isDirectory(path.join(pluginRoot, 'codex-skills'), `${label}/codex-skills`);
  isFile(path.join(pluginRoot, 'codex-hooks', 'hooks.json'), `${label}/codex-hooks/hooks.json`);
}

function validateSharedHomunculusConfig(homeDir) {
  console.log('\nShared homunculus config:');
  const configPath = process.env.TECH_PERSISTENCE_CONFIG
    ? path.resolve(expandHome(process.env.TECH_PERSISTENCE_CONFIG, homeDir))
    : path.join(homeDir, '.tech-persistence', 'config.json');
  if (process.env.TECH_PERSISTENCE_HOME) {
    const target = path.resolve(expandHome(process.env.TECH_PERSISTENCE_HOME, homeDir));
    ok(`TECH_PERSISTENCE_HOME set: ${target}`);
    if (!fs.existsSync(target)) fail(`TECH_PERSISTENCE_HOME target missing: ${target}`);
    return;
  }
  if (!fs.existsSync(configPath)) {
    ok('not configured; Codex will use ~/.codex/homunculus');
    return;
  }
  const config = readJson(configPath, configPath);
  const configured = config && (config.homunculusHome || config.homunculusDir || config.vaultPath);
  if (!configured) return fail('shared config missing homunculusHome');
  const target = path.resolve(expandHome(configured, homeDir));
  ok(`shared homunculus configured: ${target}`);
  if (!fs.existsSync(target)) fail(`shared homunculus directory missing: ${target}`);
}

function validateUserInstall(context) {
  const { homeDir, userCodexRoot, pluginListFile, pluginListJson } = context;
  console.log('\nUser-level Codex install:');
  isFile(path.join(userCodexRoot, 'AGENTS.md'), '~/.codex/AGENTS.md');
  validateNativeAgents(path.join(userCodexRoot, 'AGENTS.md'), 'user', '~/.codex/AGENTS.md');
  validateInventory(path.join(userCodexRoot, 'commands'), expectedUserCommands(), '~/.codex/commands');
  validateNativeCommands(path.join(userCodexRoot, 'commands'), '~/.codex/commands');
  validateInventory(path.join(userCodexRoot, 'rules'), expectedUserRules(), '~/.codex/rules');
  validateCodexText(path.join(userCodexRoot, 'commands'), '~/.codex/commands');
  validateCodexText(path.join(userCodexRoot, 'rules'), '~/.codex/rules');

  const pluginRoot = path.join(homeDir, 'plugins', 'tech-persistence');
  validatePluginBundle(pluginRoot, '~/plugins/tech-persistence');
  const marketplacePath = path.join(homeDir, '.agents', 'plugins', 'marketplace.json');
  const marketplace = inspectMarketplace(marketplacePath);
  if (marketplace.valid) ok('one canonical user marketplace entry exists');
  else marketplace.errors.forEach((error) => fail(`user marketplace: ${error}`));

  const owner = ownerProbe({ pluginListFile, pluginListJson, codexHome: userCodexRoot });
  if (!owner.available) fail('Codex CLI unavailable; canonical plugin ownership cannot be verified');
  else if (owner.error) fail(`Codex owner probe failed: ${owner.error}`);
  else if (owner.ownerCount !== 1 || owner.pluginIds[0] !== CANONICAL_PLUGIN_ID) {
    fail(`expected only ${CANONICAL_PLUGIN_ID}; found ${owner.pluginIds.join(', ') || 'none'}`);
  } else {
    ok(`runtime owner is ${CANONICAL_PLUGIN_ID}`);
    validateOwnerIntegrity(owner, pluginRoot);
    const exclusions = inspectManagedSkillExclusions(userCodexRoot);
    if (exclusions.invalid) fail('managed skill exclusions invalid: ' + exclusions.invalid);
    else if (!exclusions.markerPresent) fail('managed skill exclusion block is missing');
    else ok(exclusions.paths.size + ' preserved direct/shared skills are explicitly excluded');
    const collisions = findDirectCollisions(userCodexRoot, pluginRoot, { exclusions });
    if (collisions.length > 0) fail(`user direct copies duplicate the plugin owner: ${collisions.join(', ')}`);
    else ok('preserved user direct copies are inactive');
  }
}

function validateProjectInstall(context) {
  const { projectRoot, projectCodexRoot, userCodexRoot, pluginListFile, pluginListJson } = context;
  console.log('\nProject-level Codex install:');
  isFile(path.join(projectRoot, 'AGENTS.md'), 'AGENTS.md');
  validateNativeAgents(path.join(projectRoot, 'AGENTS.md'), 'project', 'AGENTS.md');
  const standards = validateProjectStandards({
    projectRoot,
    sourceRoot: path.join(repoRoot, 'project-level'),
    runtime: 'codex',
  });
  if (standards.valid) ok('architecture-aware project standards are complete and hash-verified');
  else standards.issues.forEach((issue) => fail(`project standards ${issue.path}: ${issue.reason}`));
  validateInventory(
    path.join(projectCodexRoot, 'commands'),
    union(union(expectedUserCommands(), expectedProjectCommands()), standardAssetNames(standards, 'command')),
    '.codex/commands'
  );
  validateNativeCommands(path.join(projectCodexRoot, 'commands'), '.codex/commands');
  validateInventory(
    path.join(projectCodexRoot, 'rules'),
    union(union(expectedUserRules(), expectedProjectRules()), standardAssetNames(standards, 'rule')),
    '.codex/rules'
  );
  isDirectory(path.join(projectCodexRoot, 'plans'), '.codex/plans');
  validateCodexText(path.join(projectCodexRoot, 'commands'), '.codex/commands', {
    // Managed audit commands intentionally inspect the sibling Claude projection.
    allowCrossRuntimeFiles: standardAssetNames(standards, 'command')
      .filter((name) => name === 'project-audit.md'),
  });
  validateCodexText(path.join(projectCodexRoot, 'rules'), '.codex/rules', { allowCrossRuntimeReferences: true });
  validateCodexFile(path.join(projectRoot, 'AGENTS.md'), 'AGENTS.md');

  const owner = ownerProbe({ pluginListFile, pluginListJson, codexHome: userCodexRoot });
  if (owner.available && owner.error) {
    fail(`Codex owner probe failed: ${owner.error}`);
  } else if (owner.available && owner.ownerCount > 1) {
    fail(`multiple plugin owners detected: ${owner.pluginIds.join(', ')}`);
  } else if (owner.available && owner.ownerCount === 1) {
    if (owner.pluginIds[0] !== CANONICAL_PLUGIN_ID) {
      fail(`non-canonical plugin owner detected: ${owner.pluginIds[0]}`);
    } else {
      validateOwnerIntegrity(owner, null);
      const exclusions = inspectManagedSkillExclusions(userCodexRoot);
      const collisions = findDirectCollisions(
        projectCodexRoot,
        path.join(repoRoot, 'plugins', 'tech-persistence'),
        { exclusions }
      );
      if (collisions.length > 0 || hasActiveManagedFallback(projectCodexRoot, exclusions)) {
        fail(`project direct copies duplicate the canonical plugin owner: ${collisions.join(', ') || OWNER_MANIFEST}`);
      } else {
        ok('one canonical plugin owner is active; preserved project copies are inactive');
      }
    }
  } else {
    if (!owner.available) console.log('[WARN] Codex CLI unavailable; validating project fallback');
    validateDirectFallback({
      codexRoot: projectCodexRoot,
      canonicalSkillsRoot: path.join(repoRoot, 'plugins', 'tech-persistence', 'codex-skills'),
      userCodexRoot,
    });
  }
}

function validateAgentLoopAssets() {
  console.log('\nAgent loop v7 assets:');
  isFile(path.join(repoRoot, 'scripts', 'agent-orchestrator.js'), 'scripts/agent-orchestrator.js');
  for (const schema of [
    'requirement-spec.schema.json',
    'task-breakdown.schema.json',
    'agent-handoff.schema.json',
    'review-result.schema.json',
  ]) {
    isFile(path.join(repoRoot, 'schemas', 'agent-loop', schema), `schemas/agent-loop/${schema}`);
  }
}

function main() {
  hasFailure = false;
  const allowedArgs = new Set(['--help', '--user', '--project']);
  const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) fail(`unknown arguments: ${unknownArgs.join(', ')}`);
  if (args.has('--help')) {
    console.log('Usage: node scripts/validate-codex-install.js [--user] [--project]');
    return hasFailure ? 1 : 0;
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const projectRoot = process.cwd();
  const context = {
    homeDir,
    projectRoot,
    userCodexRoot: process.env.CODEX_HOME || path.join(homeDir, '.codex'),
    projectCodexRoot: path.join(projectRoot, '.codex'),
    pluginListFile: process.env.CODEX_PLUGIN_LIST_FILE || null,
    pluginListJson: process.env.CODEX_PLUGIN_LIST_JSON || null,
  };
  const validateUser = args.size === 0 || args.has('--user');
  const validateProject = args.size === 0 || args.has('--project');
  if (validateUser) validateUserInstall(context);
  if (validateProject) {
    validateProjectInstall(context);
    validateAgentLoopAssets();
  }
  validateSharedHomunculusConfig(homeDir);
  if (hasFailure) return 1;
  console.log('\n[OK] Codex install validation passed');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  findDirectCollisions,
  hasActiveManagedFallback,
  inspectMarketplace,
  main,
  ownerProbe,
  stripManagedSolutionIndex,
  validateDirectFallback,
  validateCodexText,
  validateNativeCommands,
  validateNativeAgents,
  validateOwnerIntegrity,
};
