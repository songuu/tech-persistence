#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { defaultRunCodex } = require('./codex-plugin-cli');

const PLUGIN_NAME = 'tech-persistence';
const DEFAULT_CANONICAL_PLUGIN_ID = 'tech-persistence@local-plugins';
const DIRECT_OWNER_MANIFEST = 'tech-persistence-owner.json';
const MANAGED_SKILL_EXCLUSIONS_BEGIN = '# BEGIN tech-persistence managed Codex skill exclusions';
const MANAGED_SKILL_EXCLUSIONS_END = '# END tech-persistence managed Codex skill exclusions';

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/');
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalPathKey(value) {
  const normalized = normalizeSlashes(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function jsonReplacer(_key, value) {
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, item]) => ({ key, value: item }));
  }
  if (value instanceof Set) {
    return [...value].sort((left, right) => String(left).localeCompare(String(right)));
  }
  return value;
}

function hashPath(target, options = {}) {
  if (!fs.existsSync(target)) return null;
  const ignored = new Set(options.ignoreTopLevel || []);
  const stat = fs.lstatSync(target);
  if (stat.isFile()) return sha256(fs.readFileSync(target));
  if (!stat.isDirectory()) return sha256(`unsupported:${stat.mode}`);

  const root = path.resolve(target);
  const records = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeSlashes(path.relative(root, absolute));
      if (ignored.has(relative.split('/')[0])) continue;
      if (entry.isDirectory()) {
        records.push(`d:${relative}`);
        walk(absolute);
      } else if (entry.isFile()) {
        records.push(`f:${relative}:${sha256(fs.readFileSync(absolute))}`);
      } else if (entry.isSymbolicLink()) {
        records.push(`l:${relative}:${fs.readlinkSync(absolute)}`);
      }
    }
  }
  walk(root);
  return sha256(records.join('\n'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizePluginOwners(pluginList, pluginName = PLUGIN_NAME) {
  const installed = Array.isArray(pluginList)
    ? pluginList
    : Array.isArray(pluginList && pluginList.installed) ? pluginList.installed : [];
  return installed
    .filter((plugin) => plugin && plugin.name === pluginName)
    .filter((plugin) => plugin.installed !== false && plugin.enabled !== false)
    .map((plugin) => ({
      ...plugin,
      pluginId: plugin.pluginId || `${plugin.name}@${plugin.marketplaceName || 'unknown'}`,
    }))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function normalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (!value || typeof value !== 'object') return value;
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) normalized[key] = normalizeJsonValue(value[key]);
  }
  return normalized;
}

function pluginOwnerSnapshot(owner) {
  const identity = {
    pluginId: owner.pluginId,
    name: owner.name,
    marketplaceName: owner.marketplaceName || null,
    version: owner.version || null,
    source: normalizeJsonValue(owner.source || null),
    enabled: owner.enabled !== false,
  };
  return { ...identity, fingerprint: sha256(JSON.stringify(identity)) };
}

function pluginManifestVersion(pluginRoot) {
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = readJson(manifestPath);
  if (!manifest || manifest.name !== PLUGIN_NAME || typeof manifest.version !== 'string'
      || !manifest.version.trim()) {
    throw new Error(`invalid ${PLUGIN_NAME} manifest name/version: ${manifestPath}`);
  }
  return { manifestPath, version: manifest.version };
}

function safeCacheComponent(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)
      || value === '.' || value === '..') {
    throw new Error(`invalid plugin ${label}: ${value || '<missing>'}`);
  }
  return value;
}

function inspectPluginOwnerIntegrity(codexHome, owner) {
  const errors = [];
  const result = {
    pluginId: owner.pluginId,
    valid: false,
    ownerVersion: typeof owner.version === 'string' ? owner.version : null,
    sourceVersion: null,
    cacheVersion: null,
    sourceRoot: null,
    cacheRoot: null,
    sourceHash: null,
    cacheHash: null,
    errors,
  };
  try {
    const marketplaceName = safeCacheComponent(owner.marketplaceName, 'marketplace name');
    const pluginName = safeCacheComponent(owner.name, 'name');
    const ownerVersion = safeCacheComponent(owner.version, 'version');
    const sourcePath = owner.source && owner.source.path;
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      throw new Error('local plugin source path unavailable');
    }
    const sourceRoot = path.resolve(sourcePath);
    const sourceStat = fs.lstatSync(sourceRoot);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      throw new Error(`plugin source must be a plain directory: ${sourceRoot}`);
    }
    const cacheBase = path.resolve(codexHome, 'plugins', 'cache');
    const cacheRoot = path.resolve(cacheBase, marketplaceName, pluginName, ownerVersion);
    if (!pathIsInside(cacheBase, cacheRoot)) throw new Error(`plugin cache path escapes cache root: ${cacheRoot}`);
    const cacheStat = fs.lstatSync(cacheRoot);
    if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) {
      throw new Error(`plugin cache must be a plain directory: ${cacheRoot}`);
    }
    result.sourceRoot = sourceRoot;
    result.cacheRoot = cacheRoot;
    result.ownerVersion = ownerVersion;
    const sourceManifest = pluginManifestVersion(sourceRoot);
    const cacheManifest = pluginManifestVersion(cacheRoot);
    result.sourceVersion = sourceManifest.version;
    result.cacheVersion = cacheManifest.version;
    if (sourceManifest.version !== ownerVersion) {
      errors.push(`owner.version=${ownerVersion} differs from source manifest version=${sourceManifest.version}`);
    }
    if (cacheManifest.version !== ownerVersion) {
      errors.push(`owner.version=${ownerVersion} differs from cache manifest version=${cacheManifest.version}`);
    }
    result.sourceHash = hashPath(sourceRoot);
    result.cacheHash = hashPath(cacheRoot);
    if (result.sourceHash !== result.cacheHash) {
      errors.push(`cache content hash differs from source: source=${result.sourceHash} cache=${result.cacheHash}`);
    }
  } catch (error) {
    errors.push(error.message);
  }
  result.valid = errors.length === 0;
  return result;
}

function resolveManifestPath(pluginRoot, value, fallback) {
  const relative = typeof value === 'string' && value.trim() ? value : fallback;
  const resolved = path.resolve(pluginRoot, relative);
  if (!pathIsInside(pluginRoot, resolved)) throw new Error(`plugin manifest path escapes root: ${relative}`);
  return resolved;
}

function listSkills(skillsRoot) {
  const skills = new Map();
  if (!skillsRoot || !fs.existsSync(skillsRoot)) return skills;
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillRoot = path.join(skillsRoot, entry.name);
    if (!fs.existsSync(path.join(skillRoot, 'SKILL.md'))) continue;
    skills.set(entry.name, { name: entry.name, path: skillRoot, sha256: hashPath(skillRoot) });
  }
  return skills;
}

function acceptedSkillIndex(skillVariants) {
  const accepted = new Map();
  for (const variant of skillVariants) {
    for (const [name, skill] of variant.skills.entries()) {
      if (!accepted.has(name)) {
        accepted.set(name, { name, hashes: new Set(), variants: [] });
      }
      const entry = accepted.get(name);
      entry.hashes.add(skill.sha256);
      if (!entry.variants.some((item) => item.kind === variant.kind && item.path === skill.path)) {
        entry.variants.push({ kind: variant.kind, path: skill.path, sha256: skill.sha256 });
      }
    }
  }
  for (const entry of accepted.values()) {
    entry.variants.sort((left, right) => `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`));
  }
  return accepted;
}

function hookLogicalIds(configPath) {
  const ids = new Set();
  if (!configPath || !fs.existsSync(configPath)) return ids;
  const config = readJson(configPath);
  const hooks = config && config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  for (const event of Object.keys(hooks).sort()) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const entry of entries) {
      const matcher = entry && entry.matcher ? entry.matcher : '*';
      const commands = Array.isArray(entry && entry.hooks) ? entry.hooks : [];
      for (const hook of commands) {
        if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') continue;
        const scripts = hook.command.match(/[A-Za-z0-9._-]+\.(?:js|cmd|ps1|sh)/g) || [];
        const logicalCommand = scripts.length > 0
          ? scripts.join('>')
          : hook.command.replace(/["']/g, '').replace(/\\/g, '/').trim();
        ids.add(`${event}:${matcher}:${logicalCommand}`);
      }
    }
  }
  return ids;
}

function inspectPluginRoot(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`plugin manifest missing: ${manifestPath}`);
  const manifest = readJson(manifestPath);
  if (manifest.name !== PLUGIN_NAME) throw new Error(`unexpected plugin manifest name: ${manifest.name || '(missing)'}`);
  const skillsRoot = resolveManifestPath(root, manifest.skills, './skills/');
  const hooksConfigPath = resolveManifestPath(root, manifest.hooks, './hooks/hooks.json');
  if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
    throw new Error(`plugin skills root missing: ${skillsRoot}`);
  }
  if (!fs.existsSync(hooksConfigPath) || !fs.statSync(hooksConfigPath).isFile()) {
    throw new Error(`plugin hook config missing: ${hooksConfigPath}`);
  }
  const skills = listSkills(skillsRoot);
  if (skills.size === 0) throw new Error(`plugin skills root contains no skills: ${skillsRoot}`);
  const skillVariants = [{ kind: 'canonical', root: skillsRoot, skills }];
  const legacySkillsRoot = path.join(root, 'skills');
  if (path.resolve(legacySkillsRoot) !== path.resolve(skillsRoot) && fs.existsSync(legacySkillsRoot)) {
    skillVariants.push({ kind: 'legacy', root: legacySkillsRoot, skills: listSkills(legacySkillsRoot) });
  }
  const hookVariants = [];
  const hookCandidates = [
    { kind: 'canonical', configPath: hooksConfigPath },
    { kind: 'legacy', configPath: path.join(root, 'hooks', 'hooks.json') },
  ];
  const seenHookConfigs = new Set();
  for (const candidate of hookCandidates) {
    const key = canonicalPathKey(candidate.configPath);
    if (seenHookConfigs.has(key) || !fs.existsSync(candidate.configPath)) continue;
    seenHookConfigs.add(key);
    const hookRoot = path.dirname(candidate.configPath);
    hookVariants.push({
      kind: candidate.kind,
      configPath: candidate.configPath,
      hookRoot,
      configHash: hashPath(candidate.configPath),
      bundleHash: hashPath(hookRoot),
      ids: hookLogicalIds(candidate.configPath),
    });
  }
  const canonicalHook = hookVariants.find((variant) => variant.kind === 'canonical');
  return {
    root,
    manifestPath,
    skillsRoot,
    skills,
    skillVariants,
    acceptedSkills: acceptedSkillIndex(skillVariants),
    hooksConfigPath,
    hookRoot: path.dirname(hooksConfigPath),
    hookConfigHash: canonicalHook ? canonicalHook.configHash : null,
    hookBundleHash: canonicalHook ? canonicalHook.bundleHash : null,
    hookIds: canonicalHook ? canonicalHook.ids : new Set(),
    hookVariants,
    acceptedHookConfigHashes: new Set(hookVariants.map((variant) => variant.configHash).filter(Boolean)),
    acceptedHookBundleHashes: new Set(hookVariants.map((variant) => variant.bundleHash).filter(Boolean)),
    acceptedHookIds: new Set(hookVariants.flatMap((variant) => [...variant.ids])),
  };
}

function readDirectOwnerManifest(scopeRoot) {
  const manifestPath = path.join(scopeRoot, DIRECT_OWNER_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = readJson(manifestPath);
    if (manifest.schemaVersion !== 1 || manifest.owner !== PLUGIN_NAME || !Array.isArray(manifest.managed)) {
      return { manifestPath, invalid: 'unsupported manifest shape', entries: new Map() };
    }
    const entries = new Map();
    for (const item of manifest.managed) {
      if (!item || typeof item.path !== 'string' || typeof item.sha256 !== 'string') continue;
      const absolute = path.resolve(scopeRoot, item.path);
      if (!pathIsInside(scopeRoot, absolute)) continue;
      entries.set(normalizeSlashes(path.relative(scopeRoot, absolute)), item);
    }
    return { manifestPath, manifest, entries };
  } catch (error) {
    return { manifestPath, invalid: error.message, entries: new Map() };
  }
}

function inspectDirectScope({ scope, scopeRoot, reference, exclusions }) {
  const skillsRoot = path.join(scopeRoot, 'skills');
  const manifestInfo = readDirectOwnerManifest(scopeRoot);
  const artifacts = [];
  const skills = new Map();
  const activeSkills = new Map();
  const skillConflicts = [];
  const hooks = new Set();
  const combinedRoots = new Set();
  const excludedNestedHookRoots = new Set();

  const acceptedSkills = reference.acceptedSkills || acceptedSkillIndex([
    { kind: 'canonical', skills: reference.skills || new Map() },
  ]);
  const acceptedHookIds = reference.acceptedHookIds || reference.hookIds || new Set();
  const acceptedHookConfigHashes = reference.acceptedHookConfigHashes
    || new Set([reference.hookConfigHash].filter(Boolean));
  const acceptedHookBundleHashes = reference.acceptedHookBundleHashes
    || new Set([reference.hookBundleHash].filter(Boolean));

  for (const [name, accepted] of acceptedSkills.entries()) {
    const directPath = path.join(skillsRoot, name);
    if (!fs.existsSync(path.join(directPath, 'SKILL.md'))) continue;
    const actualHash = hashPath(directPath);
    const skillFile = path.join(directPath, 'SKILL.md');
    const managedExcluded = exclusions.paths.has(canonicalPathKey(skillFile));
    const expectedHashes = [...accepted.hashes].sort();
    let exact = accepted.hashes.has(actualHash);
    let logicalType = 'skill';
    const nestedHooks = path.join(directPath, 'hooks');
    if (name === 'continuous-learning' && fs.existsSync(nestedHooks)) {
      const skillWithoutHooks = hashPath(directPath, { ignoreTopLevel: ['hooks'] });
      if (accepted.hashes.has(skillWithoutHooks) && acceptedHookBundleHashes.has(hashPath(nestedHooks))) {
        exact = true;
        logicalType = 'skill+hooks';
        combinedRoots.add(path.resolve(nestedHooks));
      }
    }
    skills.set(name, { name, path: directPath, sha256: actualHash });
    if (!managedExcluded) activeSkills.set(name, { name, path: directPath, sha256: actualHash });
    skillConflicts.push({
      scope,
      name,
      path: directPath,
      skillFile,
      sha256: actualHash,
      exact,
      managedExcluded,
    });
    artifacts.push({
      scope, scopeRoot, logicalType, logicalName: name, path: directPath,
      skillFile, sha256: actualHash, expectedHash: expectedHashes[0] || null, expectedHashes,
      exact, managedExcluded,
    });
    const nestedConfig = path.join(nestedHooks, 'hooks.json');
    if (managedExcluded) {
      excludedNestedHookRoots.add(path.resolve(nestedHooks));
    } else if (fs.existsSync(nestedConfig)) {
      for (const id of hookLogicalIds(nestedConfig)) hooks.add(id);
    }
  }

  const configCandidates = [
    path.join(scopeRoot, 'hooks.json'),
    path.join(scopeRoot, 'tech-persistence-hooks', 'hooks.json'),
  ];
  const bundleCandidates = [
    path.join(scopeRoot, 'hooks'),
    path.join(scopeRoot, 'tech-persistence-hooks'),
    path.join(scopeRoot, 'skills', 'continuous-learning', 'hooks'),
  ];
  for (const configPath of configCandidates) {
    if (!fs.existsSync(configPath)) continue;
    const ids = hookLogicalIds(configPath);
    const overlap = [...ids].filter((id) => acceptedHookIds.has(id));
    if (overlap.length === 0) continue;
    overlap.forEach((id) => hooks.add(id));
    const actualHash = hashPath(configPath);
    const expectedHashes = [...acceptedHookConfigHashes].sort();
    artifacts.push({
      scope, scopeRoot, logicalType: 'hooks', logicalName: 'hooks.json', path: configPath,
      sha256: actualHash, expectedHash: expectedHashes[0] || null, expectedHashes,
      exact: acceptedHookConfigHashes.has(actualHash), nested: false,
    });
  }
  for (const hookRoot of bundleCandidates) {
    const resolvedHookRoot = path.resolve(hookRoot);
    if (!fs.existsSync(hookRoot) || combinedRoots.has(resolvedHookRoot)
        || excludedNestedHookRoots.has(resolvedHookRoot)) continue;
    const ids = hookLogicalIds(path.join(hookRoot, 'hooks.json'));
    const overlap = [...ids].filter((id) => acceptedHookIds.has(id));
    if (overlap.length === 0 && !fs.existsSync(path.join(hookRoot, 'run-hook.js'))) continue;
    overlap.forEach((id) => hooks.add(id));
    const actualHash = hashPath(hookRoot);
    const expectedHashes = [...acceptedHookBundleHashes].sort();
    artifacts.push({
      scope, scopeRoot, logicalType: 'hooks', logicalName: path.basename(hookRoot), path: hookRoot,
      sha256: actualHash, expectedHash: expectedHashes[0] || null, expectedHashes,
      exact: acceptedHookBundleHashes.has(actualHash),
      nested: pathIsInside(skillsRoot, hookRoot),
    });
  }
  return {
    id: `direct:${scope}`, kind: 'direct', scope, scopeRoot, manifestInfo,
    skills, activeSkills, skillConflicts, hooks, artifacts,
    active: activeSkills.size > 0 || hooks.size > 0,
  };
}

function addLogicalProviders(index, logicalNames, providerId) {
  for (const name of logicalNames) {
    if (!index.has(name)) index.set(name, new Set());
    index.get(name).add(providerId);
  }
}

function duplicateKeys(index) {
  return [...index.entries()]
    .filter(([, providers]) => providers.size > 1)
    .map(([name]) => name)
    .sort();
}

function managedBlockBounds(content) {
  const beginPositions = [];
  const endPositions = [];
  let cursor = 0;
  while ((cursor = content.indexOf(MANAGED_SKILL_EXCLUSIONS_BEGIN, cursor)) !== -1) {
    beginPositions.push(cursor);
    cursor += MANAGED_SKILL_EXCLUSIONS_BEGIN.length;
  }
  cursor = 0;
  while ((cursor = content.indexOf(MANAGED_SKILL_EXCLUSIONS_END, cursor)) !== -1) {
    endPositions.push(cursor);
    cursor += MANAGED_SKILL_EXCLUSIONS_END.length;
  }
  if (beginPositions.length === 0 && endPositions.length === 0) return null;
  if (beginPositions.length !== 1 || endPositions.length !== 1 || endPositions[0] < beginPositions[0]) {
    throw new Error('managed skill exclusion marker is missing or duplicated');
  }
  const begin = beginPositions[0];
  const end = endPositions[0];
  const beginLineStart = content.lastIndexOf('\n', begin - 1) + 1;
  const beginLineEndIndex = content.indexOf('\n', begin);
  const beginLineEnd = beginLineEndIndex === -1 ? content.length : beginLineEndIndex;
  const endLineStart = content.lastIndexOf('\n', end - 1) + 1;
  const endLineEndIndex = content.indexOf('\n', end);
  const endLineEnd = endLineEndIndex === -1 ? content.length : endLineEndIndex + 1;
  if (content.slice(beginLineStart, beginLineEnd).trim() !== MANAGED_SKILL_EXCLUSIONS_BEGIN
      || content.slice(endLineStart, endLineEnd).trim() !== MANAGED_SKILL_EXCLUSIONS_END) {
    throw new Error('managed skill exclusion markers must occupy complete lines');
  }
  return { start: beginLineStart, end: endLineEnd, blockStart: beginLineEnd, blockEnd: endLineStart };
}

function inspectManagedSkillExclusions(codexHome) {
  const configPath = path.join(codexHome, 'config.toml');
  const exists = fs.existsSync(configPath);
  const content = exists ? fs.readFileSync(configPath, 'utf8') : '';
  const paths = new Map();
  let markerPresent = false;
  let invalid = null;
  try {
    const bounds = managedBlockBounds(content);
    markerPresent = Boolean(bounds);
    if (bounds) {
      const body = content.slice(bounds.blockStart, bounds.blockEnd);
      const tables = body.split(/\[\[skills\.config\]\]/g).slice(1);
      for (const table of tables) {
        const pathMatch = table.match(/^\s*path\s*=\s*("(?:\\.|[^"\\])*")\s*$/m);
        const enabledMatch = table.match(/^\s*enabled\s*=\s*(true|false)\s*$/m);
        if (!pathMatch || !enabledMatch || enabledMatch[1] !== 'false') {
          throw new Error('managed skills.config entry must contain path and enabled = false');
        }
        let configuredPath;
        try {
          configuredPath = JSON.parse(pathMatch[1]);
        } catch (error) {
          throw new Error(`managed skills.config path is not a valid TOML basic string: ${error.message}`);
        }
        if (!path.isAbsolute(configuredPath) || path.basename(configuredPath).toLowerCase() !== 'skill.md') {
          throw new Error(`managed skills.config path must be an absolute SKILL.md path: ${configuredPath}`);
        }
        const absolute = path.resolve(configuredPath);
        paths.set(canonicalPathKey(absolute), absolute);
      }
    }
  } catch (error) {
    invalid = error.message;
  }
  return {
    configPath,
    exists,
    sha256: exists ? hashPath(configPath) : null,
    markerPresent,
    paths,
    invalid,
  };
}

function renderManagedSkillExclusions(content, skillPaths) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const sortedPaths = [...new Map(skillPaths.map((skillPath) => [
    canonicalPathKey(skillPath), path.resolve(skillPath),
  ])).values()].sort((left, right) => canonicalPathKey(left).localeCompare(canonicalPathKey(right)));
  const lines = [
    MANAGED_SKILL_EXCLUSIONS_BEGIN,
    '# Managed by scripts/codex-runtime-doctor.js; preserved skill directories are never moved.',
  ];
  for (const skillPath of sortedPaths) {
    lines.push('', '[[skills.config]]', `path = ${JSON.stringify(normalizeSlashes(skillPath))}`, 'enabled = false');
  }
  lines.push(MANAGED_SKILL_EXCLUSIONS_END);
  const block = `${lines.join(eol)}${eol}`;
  const bounds = managedBlockBounds(content);
  if (bounds) return `${content.slice(0, bounds.start)}${block}${content.slice(bounds.end)}`;
  if (!content) return block;
  const separator = content.endsWith('\n') || content.endsWith('\r') ? eol : `${eol}${eol}`;
  return `${content}${separator}${block}`;
}

function inspectSharedSkillConflicts({ codexHome, projectRoot, pluginSkillNames, exclusions }) {
  const roots = [
    { scope: 'user-agents', root: path.join(path.dirname(codexHome), '.agents', 'skills') },
    { scope: 'project-agents', root: path.join(projectRoot, '.agents', 'skills') },
  ];
  const conflicts = [];
  for (const shared of roots) {
    for (const [name, skill] of listSkills(shared.root).entries()) {
      if (!pluginSkillNames.has(name)) continue;
      const skillFile = path.join(skill.path, 'SKILL.md');
      conflicts.push({
        scope: shared.scope,
        name,
        path: skill.path,
        skillFile,
        sha256: skill.sha256,
        managedExcluded: exclusions.paths.has(canonicalPathKey(skillFile)),
      });
    }
  }
  return conflicts.sort((left, right) => `${left.scope}:${left.name}:${left.path}`
    .localeCompare(`${right.scope}:${right.name}:${right.path}`));
}

function defaultReferencePluginRoot(codexHome) {
  return path.join(path.dirname(path.resolve(codexHome)), 'plugins', PLUGIN_NAME);
}

function analyzeRuntime(options) {
  const codexHome = path.resolve(options.codexHome);
  const projectRoot = path.resolve(options.projectRoot);
  const canonicalPluginId = options.canonicalPluginId || DEFAULT_CANONICAL_PLUGIN_ID;
  const pluginOwners = normalizePluginOwners(options.pluginList);
  const analysisErrors = [];
  const pluginProviders = [];
  for (const owner of pluginOwners) {
    const integrity = inspectPluginOwnerIntegrity(codexHome, owner);
    if (!integrity.valid) {
      analysisErrors.push(...integrity.errors.map((error) => `${owner.pluginId}: ${error}`));
    }
    const pluginRoot = owner.source && owner.source.path;
    if (!pluginRoot) {
      analysisErrors.push(`${owner.pluginId}: local plugin source path unavailable`);
      pluginProviders.push({ id: `plugin:${owner.pluginId}`, owner, integrity, skills: new Map(), hooks: new Set() });
      continue;
    }
    try {
      const inspected = inspectPluginRoot(pluginRoot);
      pluginProviders.push({ id: `plugin:${owner.pluginId}`, owner, integrity, ...inspected, hooks: inspected.hookIds });
    } catch (error) {
      analysisErrors.push(`${owner.pluginId}: ${error.message}`);
      pluginProviders.push({ id: `plugin:${owner.pluginId}`, owner, integrity, skills: new Map(), hooks: new Set() });
    }
  }

  let reference = pluginProviders.find((provider) => provider.owner.pluginId === canonicalPluginId && provider.root)
    || pluginProviders.find((provider) => provider.root);
  if (!reference) {
    const referenceRoot = options.referencePluginRoot || defaultReferencePluginRoot(codexHome);
    try {
      reference = inspectPluginRoot(referenceRoot);
    } catch (error) {
      analysisErrors.push(`reference plugin: ${error.message}`);
      reference = {
        root: path.resolve(referenceRoot), skills: new Map(), hookIds: new Set(), hooks: new Set(),
        acceptedSkills: new Map(), hookConfigHash: null, hookBundleHash: null,
        acceptedHookIds: new Set(), acceptedHookConfigHashes: new Set(), acceptedHookBundleHashes: new Set(),
      };
    }
  }
  if (!reference.hooks) reference.hooks = reference.hookIds || new Set();
  const managedSkillExclusions = inspectManagedSkillExclusions(codexHome);
  if (managedSkillExclusions.invalid) {
    analysisErrors.push(`config.toml: ${managedSkillExclusions.invalid}`);
  }
  const directScopes = [
    inspectDirectScope({ scope: 'user', scopeRoot: codexHome, reference, exclusions: managedSkillExclusions }),
    inspectDirectScope({
      scope: 'project',
      scopeRoot: path.join(projectRoot, '.codex'),
      reference,
      exclusions: managedSkillExclusions,
    }),
  ];
  const directOwners = directScopes.filter((provider) => provider.active);
  const skillProviders = new Map();
  const hookProviders = new Map();
  for (const provider of pluginProviders) {
    addLogicalProviders(skillProviders, provider.skills.keys(), provider.id);
    addLogicalProviders(hookProviders, provider.hooks, provider.id);
  }
  for (const provider of directOwners) {
    addLogicalProviders(skillProviders, provider.activeSkills.keys(), provider.id);
    addLogicalProviders(hookProviders, provider.hooks, provider.id);
  }
  const pluginSkillNames = new Set((reference.skills || new Map()).keys());
  const sharedSkillConflicts = inspectSharedSkillConflicts({
    codexHome, projectRoot, pluginSkillNames, exclusions: managedSkillExclusions,
  });
  const unmanagedSharedSkillConflicts = sharedSkillConflicts.filter((conflict) => !conflict.managedExcluded);
  for (const conflict of unmanagedSharedSkillConflicts) {
    addLogicalProviders(skillProviders, [conflict.name], `shared:${conflict.scope}:${normalizeSlashes(conflict.path)}`);
  }
  const directArtifacts = directScopes.flatMap((owner) => owner.artifacts);
  const directSkillConflicts = directScopes.flatMap((owner) => owner.skillConflicts);
  const unmanagedDirectSkillConflicts = directSkillConflicts.filter((conflict) => !conflict.managedExcluded);
  const standaloneDirectHookArtifacts = directArtifacts
    .filter((artifact) => artifact.logicalType === 'hooks' && !artifact.nested);
  const managedCopies = directArtifacts.filter((artifact) => artifact.exact);
  const divergedCopies = directArtifacts.filter((artifact) => !artifact.exact);
  const ownerCount = pluginOwners.length + directOwners.length;
  const duplicateSkills = duplicateKeys(skillProviders);
  const duplicateHooks = duplicateKeys(hookProviders);
  const canonicalOwnerPresent = pluginOwners.some((owner) => owner.pluginId === canonicalPluginId);
  const canonicalDrift = pluginOwners.length > 0 && !canonicalOwnerPresent;
  const healthy = ownerCount === 1 && duplicateSkills.length === 0 && duplicateHooks.length === 0
    && unmanagedDirectSkillConflicts.length === 0 && unmanagedSharedSkillConflicts.length === 0
    && standaloneDirectHookArtifacts.length === 0
    && analysisErrors.length === 0 && !canonicalDrift;
  return {
    pluginName: PLUGIN_NAME, canonicalPluginId, codexHome, projectRoot,
    referencePluginRoot: reference.root, pluginOwners, pluginProviders, directScopes, directOwners, ownerCount,
    canonicalOwnerPresent, canonicalDrift, duplicateSkills, duplicateHooks,
    managedCopies, divergedCopies, managedSkillExclusions,
    directSkillConflicts, unmanagedDirectSkillConflicts, standaloneDirectHookArtifacts,
    sharedSkillConflicts, unmanagedSharedSkillConflicts, analysisErrors, healthy,
  };
}

function buildRepairPlan(report, options = {}) {
  if (report.analysisErrors.length > 0) {
    throw new Error(`repair blocked by incomplete analysis: ${report.analysisErrors.join('; ')}`);
  }
  if (report.standaloneDirectHookArtifacts.length > 0) {
    throw new Error(`repair blocked by standalone direct hooks that cannot be safely excluded: ${report.standaloneDirectHookArtifacts.map((copy) => copy.path).join(', ')}`);
  }
  const canonicalPluginId = options.canonicalPluginId || report.canonicalPluginId;
  const installCanonicalRequested = options.installCanonical === true;
  const canonicalPresent = report.pluginOwners.some((owner) => owner.pluginId === canonicalPluginId);
  const pluginRemovals = report.pluginOwners
    .filter((owner) => owner.pluginId !== canonicalPluginId)
    .map((owner) => owner.pluginId);
  // This is an actionable manual proposal only. Doctor never executes it.
  const pluginAdd = !canonicalPresent
    && (installCanonicalRequested || report.pluginOwners.length > 0)
    ? canonicalPluginId : null;
  const moves = [];
  const proposedOwnerCommands = pluginRemovals
    .map((pluginId) => ['plugin', 'remove', pluginId, '--json']);
  if (pluginAdd) proposedOwnerCommands.push(['plugin', 'add', pluginAdd, '--json']);
  const configUpdate = canonicalPresent && (
    report.unmanagedDirectSkillConflicts.length > 0
    || report.unmanagedSharedSkillConflicts.length > 0
  ) ? {
    configPath: report.managedSkillExclusions.configPath,
    existed: report.managedSkillExclusions.exists,
    sha256: report.managedSkillExclusions.sha256,
    managedPaths: [...new Map([
      ...report.managedSkillExclusions.paths.values(),
      ...report.directSkillConflicts.map((conflict) => conflict.skillFile),
      ...report.sharedSkillConflicts.map((conflict) => conflict.skillFile),
    ].map((skillPath) => [canonicalPathKey(skillPath), path.resolve(skillPath)])).values()]
      .sort((left, right) => canonicalPathKey(left).localeCompare(canonicalPathKey(right))),
  } : null;
  return {
    schemaVersion: 1, pluginName: PLUGIN_NAME, canonicalPluginId, createdAt: new Date().toISOString(),
    codexHome: report.codexHome, projectRoot: report.projectRoot,
    backupRoot: path.resolve(options.backupRoot || path.join(
      report.codexHome, 'doctor-backups', new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
    )),
    preflight: {
      ownerCount: report.ownerCount,
      pluginOwnerCount: report.pluginOwners.length,
      directOwnerCount: report.directOwners.length,
      canonicalOwnerPresent: canonicalPresent,
      standaloneDirectHookCount: report.standaloneDirectHookArtifacts.length,
      reportHealthy: report.healthy,
      duplicateSkills: report.duplicateSkills,
      duplicateHooks: report.duplicateHooks, divergedCopies: report.divergedCopies.map((copy) => copy.path),
      analysisErrors: [],
      unmanagedDirectSkillConflicts: report.unmanagedDirectSkillConflicts.map((conflict) => conflict.skillFile),
      unmanagedSharedSkillConflicts: report.unmanagedSharedSkillConflicts.map((conflict) => conflict.skillFile),
    },
    pluginStateBefore: report.pluginOwners.map(pluginOwnerSnapshot),
    moves, configUpdate, pluginRemovals, pluginAdd, installCanonicalRequested,
    proposedOwnerCommands,
    needsRepair: moves.length > 0 || Boolean(configUpdate)
      || proposedOwnerCommands.length > 0 || !report.healthy,
  };
}

function nearestExistingParent(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function inspectSafeRegularTarget(target, context, label) {
  const stat = lstatIfPresent(target);
  if (!stat) return { exists: false, sha256: null };
  if (stat.isSymbolicLink()) {
    throw new Error(`${context}: ${label} target is a symbolic link, junction, or reparse point: ${target}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${context}: ${label} target is not a regular file: ${target}`);
  }

  // lstat identifies symlinks and junctions on supported platforms. Comparing
  // against the resolved parent also catches name-surrogate reparse targets
  // without rejecting a deliberately linked parent directory.
  const realParent = fs.realpathSync.native(path.dirname(target));
  const expectedRealPath = path.join(realParent, path.basename(target));
  const actualRealPath = fs.realpathSync.native(target);
  if (canonicalPathKey(actualRealPath) !== canonicalPathKey(expectedRealPath)) {
    throw new Error(`${context}: ${label} target resolves through a symbolic link, junction, or reparse point: ${target}`);
  }
  return { exists: true, sha256: hashPath(target) };
}

function inspectSafeConfigTarget(target, context) {
  return inspectSafeRegularTarget(target, context, 'config.toml');
}

function assertConfigState(target, expectedExisted, expectedSha256, context) {
  const current = inspectSafeConfigTarget(target, context);
  if (current.exists !== expectedExisted) {
    throw new Error(`${context}: config existence changed: ${target}`);
  }
  if (expectedExisted && current.sha256 !== expectedSha256) {
    throw new Error(`${context}: config hash changed: ${target}`);
  }
  return current;
}

function preflightRepairPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('preflight failed: repair plan must be an object');
  if (!Array.isArray(plan.moves) || !Array.isArray(plan.pluginRemovals)
      || !Array.isArray(plan.proposedOwnerCommands) || !plan.preflight) {
    throw new Error('preflight failed: repair plan schema is incomplete');
  }
  if (plan.moves.length > 0) {
    throw new Error('preflight failed: direct artifact moves are disabled; use managed skill exclusions');
  }
  const originalOwners = [...expectedPluginOwnerSnapshots(plan).values()];
  const expectedRemovals = originalOwners
    .filter((owner) => owner.pluginId !== plan.canonicalPluginId)
    .map((owner) => owner.pluginId)
    .sort();
  const actualRemovals = [...new Set(plan.pluginRemovals)].sort();
  if (JSON.stringify(actualRemovals) !== JSON.stringify(expectedRemovals)
      || actualRemovals.length !== plan.pluginRemovals.length) {
    throw new Error('preflight failed: pluginRemovals do not match the immutable original owner snapshots');
  }
  const canonicalPresent = originalOwners.some((owner) =>
    owner.pluginId === plan.canonicalPluginId);
  if (typeof plan.installCanonicalRequested !== 'boolean') {
    throw new Error('preflight failed: installCanonicalRequested must be boolean');
  }
  const expectedAdd = !canonicalPresent
    && (plan.installCanonicalRequested || originalOwners.length > 0)
    ? plan.canonicalPluginId : null;
  if (plan.pluginAdd !== expectedAdd) {
    throw new Error('preflight failed: pluginAdd does not match the immutable original owner snapshots');
  }
  const derivedOwnerCommands = expectedRemovals
    .map((pluginId) => ['plugin', 'remove', pluginId, '--json']);
  if (expectedAdd) derivedOwnerCommands.push(['plugin', 'add', expectedAdd, '--json']);
  if (JSON.stringify(plan.proposedOwnerCommands) !== JSON.stringify(derivedOwnerCommands)) {
    throw new Error('preflight failed: proposedOwnerCommands do not match owner metadata');
  }
  for (const command of derivedOwnerCommands) {
    const supportedAction = Array.isArray(command) && ['remove', 'add'].includes(command[1]);
    const expectedPlugin = supportedAction && (
      (command[1] === 'remove' && plan.pluginRemovals.includes(command[2]))
      || (command[1] === 'add' && command[2] === plan.pluginAdd && command[2] === plan.canonicalPluginId)
    );
    if (!supportedAction || command.length !== 4 || command[0] !== 'plugin'
        || command[3] !== '--json' || !expectedPlugin) {
      throw new Error(`preflight failed: unsupported Codex command: ${JSON.stringify(command)}`);
    }
  }
  const signalArrays = [
    plan.preflight.duplicateSkills,
    plan.preflight.duplicateHooks,
    plan.preflight.unmanagedDirectSkillConflicts,
    plan.preflight.unmanagedSharedSkillConflicts,
  ];
  if (signalArrays.some((value) => !Array.isArray(value))) {
    throw new Error('preflight failed: repair plan health metadata is incomplete');
  }
  const countFields = [
    'ownerCount',
    'pluginOwnerCount',
    'directOwnerCount',
    'standaloneDirectHookCount',
  ];
  if (countFields.some((field) => !Number.isSafeInteger(plan.preflight[field])
      || plan.preflight[field] < 0)) {
    throw new Error('preflight failed: health counts must be non-negative safe integers');
  }
  if (plan.preflight.pluginOwnerCount !== originalOwners.length) {
    throw new Error('preflight failed: pluginOwnerCount does not match immutable owner snapshots');
  }
  if (plan.preflight.ownerCount
      !== plan.preflight.pluginOwnerCount + plan.preflight.directOwnerCount) {
    throw new Error('preflight failed: ownerCount does not match plugin and direct owner counts');
  }
  if (typeof plan.preflight.canonicalOwnerPresent !== 'boolean'
      || plan.preflight.canonicalOwnerPresent !== canonicalPresent) {
    throw new Error('preflight failed: canonicalOwnerPresent does not match immutable owner snapshots');
  }
  if (typeof plan.preflight.reportHealthy !== 'boolean') {
    throw new Error('preflight failed: reportHealthy must be boolean');
  }
  if (!Array.isArray(plan.preflight.analysisErrors)
      || plan.preflight.analysisErrors.length > 0) {
    throw new Error('preflight failed: analysisErrors must be an empty array');
  }
  const derivedHealthy = plan.preflight.pluginOwnerCount + plan.preflight.directOwnerCount === 1
    && signalArrays.every((value) => value.length === 0)
    && plan.preflight.standaloneDirectHookCount === 0
    && !(plan.preflight.pluginOwnerCount > 0
      && plan.preflight.canonicalOwnerPresent !== true);
  if (plan.preflight.reportHealthy !== derivedHealthy) {
    throw new Error('preflight failed: reportHealthy does not match immutable health metadata');
  }
  const expectedNeedsRepair = plan.moves.length > 0
    || Boolean(plan.configUpdate)
    || derivedOwnerCommands.length > 0
    || !derivedHealthy;
  if (typeof plan.needsRepair !== 'boolean' || plan.needsRepair !== expectedNeedsRepair) {
    throw new Error('preflight failed: needsRepair does not match immutable repair inputs');
  }
  if (!expectedNeedsRepair) return;
  const hasMaterialAction = plan.moves.length > 0
    || Boolean(plan.configUpdate)
    || derivedOwnerCommands.length > 0;
  if (!hasMaterialAction) {
    const error = new Error(
      'preflight failed: runtime is unhealthy but no safe automatic repair exists; current fallback files and owner state were preserved unchanged'
    );
    error.code = 'CODEX_REPAIR_REQUIRES_MANUAL';
    error.manualRecovery = {
      required: true,
      automaticExecutionForbidden: true,
      ownerCount: plan.preflight.ownerCount,
      pluginOwnerCount: plan.preflight.pluginOwnerCount,
      directOwnerCount: plan.preflight.directOwnerCount,
      instruction: 'Inspect the dry-run report and choose the intended canonical plugin or direct fallback owner before making changes.',
    };
    throw error;
  }
  if (derivedOwnerCommands.length > 0) {
    const error = new Error(
      'preflight failed: automatic plugin owner add/remove is disabled because the official Codex CLI has no atomic version/source compare-and-swap; inspect the proposed commands and repair owners manually after stopping concurrent installers/doctors'
    );
    error.code = 'CODEX_OWNER_MUTATION_REQUIRES_MANUAL';
    error.manualRecovery = {
      required: true,
      originalOwners,
      proposedCommands: derivedOwnerCommands.map((args) => ['codex', ...args]),
      precondition: 'Stop concurrent installers/doctors, run codex plugin list --json, and compare full id/version/source/enabled fingerprints before every command.',
      automaticExecutionForbidden: true,
    };
    throw error;
  }
  if (fs.existsSync(plan.backupRoot)) throw new Error(`preflight failed: backup root already exists: ${plan.backupRoot}`);
  if (plan.configUpdate) {
    const update = plan.configUpdate;
    if (path.resolve(update.configPath) !== path.resolve(path.join(plan.codexHome, 'config.toml'))) {
      throw new Error(`preflight failed: unsupported config target: ${update.configPath}`);
    }
    assertConfigState(
      update.configPath,
      update.existed,
      update.sha256,
      'preflight failed'
    );
    const exclusionRoots = [
      path.join(plan.codexHome, 'skills'),
      path.join(plan.projectRoot, '.codex', 'skills'),
      path.join(path.dirname(plan.codexHome), '.agents', 'skills'),
      path.join(plan.projectRoot, '.agents', 'skills'),
    ];
    for (const skillFile of update.managedPaths) {
      if (!path.isAbsolute(skillFile) || path.basename(skillFile).toLowerCase() !== 'skill.md') {
        throw new Error(`preflight failed: exclusion is not an absolute SKILL.md path: ${skillFile}`);
      }
      if (!exclusionRoots.some((root) => pathIsInside(root, skillFile))) {
        throw new Error(`preflight failed: exclusion outside managed skill roots: ${skillFile}`);
      }
      if (!fs.existsSync(skillFile)) {
        throw new Error(`preflight failed: shared skill disappeared: ${skillFile}`);
      }
    }
  }
  fs.accessSync(nearestExistingParent(plan.backupRoot), fs.constants.W_OK);
  return true;
}

function directoryIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function inspectSafeDirectory(target, context) {
  const stat = lstatIfPresent(target);
  if (!stat) throw new Error(`${context}: directory is missing: ${target}`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${context}: directory is a link, junction, reparse point, or non-directory: ${target}`);
  }
  const parent = path.dirname(target);
  const actualRealPath = fs.realpathSync.native(target);
  if (parent !== target) {
    const expectedRealPath = path.join(fs.realpathSync.native(parent), path.basename(target));
    if (canonicalPathKey(actualRealPath) !== canonicalPathKey(expectedRealPath)) {
      throw new Error(`${context}: directory resolves through a link, junction, or reparse point: ${target}`);
    }
  }
  return { path: path.resolve(target), identity: directoryIdentity(stat) };
}

function ensureSafeDirectory(target, context) {
  const absolute = path.resolve(target);
  const existing = lstatIfPresent(absolute);
  if (existing) return inspectSafeDirectory(absolute, context);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error(`${context}: cannot create filesystem root`);
  ensureSafeDirectory(parent, context);
  try {
    fs.mkdirSync(absolute, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  return inspectSafeDirectory(absolute, context);
}

function createDirectoryBinding(directory, label) {
  const claimPath = path.join(directory, '.tech-persistence-directory-claim');
  const claimContent = crypto.randomBytes(32);
  fs.writeFileSync(claimPath, claimContent, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(claimPath, 0o600);
  const inspected = inspectSafeRegularTarget(
    claimPath,
    `${label} binding validation failed`,
    'directory claim'
  );
  return { claimPath, claimHash: inspected.sha256 };
}

function assertDirectoryBinding(binding, label) {
  const inspected = inspectSafeRegularTarget(
    binding.claimPath,
    `${label} binding validation failed`,
    'directory claim'
  );
  if (!inspected.exists || inspected.sha256 !== binding.claimHash) {
    throw new Error(`${label} binding changed: ${binding.claimPath}`);
  }
}

function claimBackupRoot(backupRoot, options = {}) {
  const root = path.resolve(backupRoot);
  ensureSafeDirectory(path.dirname(root), 'backup root parent validation failed');
  if (typeof options.beforeBackupClaim === 'function') options.beforeBackupClaim({ backupRoot: root });
  try {
    fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new Error(`backup root exclusive claim failed: ${root}: ${error.message}`);
  }
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const inspected = inspectSafeDirectory(root, 'backup root claim validation failed');
  const binding = createDirectoryBinding(root, 'backup root');
  const verified = inspectSafeDirectory(root, 'backup root post-binding validation failed');
  if (verified.identity !== inspected.identity) {
    throw new Error(`backup root identity changed while binding: ${root}`);
  }
  return {
    root,
    rootIdentity: inspected.identity,
    rootBinding: binding,
    manifestPath: path.join(root, 'manifest.json'),
    manifestHash: null,
    writeCount: 0,
    journalErrors: [],
    manifestWriteHook: options.manifestWriteHook || null,
    subdirectories: new Map(),
  };
}

function assertBackupRootIdentity(journal, context) {
  const current = inspectSafeDirectory(journal.root, context);
  if (current.identity !== journal.rootIdentity) {
    throw new Error(`${context}: backup root identity changed: ${journal.root}`);
  }
  assertDirectoryBinding(journal.rootBinding, 'backup root');
  return current;
}

function ensureBackupSubdirectory(journal, relativePath) {
  assertBackupRootIdentity(journal, 'backup subdirectory root validation failed');
  const target = path.resolve(journal.root, relativePath);
  if (!pathIsInside(journal.root, target) || target === journal.root) {
    throw new Error(`backup subdirectory escapes claimed root: ${relativePath}`);
  }
  if (lstatIfPresent(target)) {
    throw new Error(`backup subdirectory already exists before claim: ${target}`);
  }
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o700);
  const inspected = inspectSafeDirectory(target, 'backup subdirectory claim validation failed');
  const binding = createDirectoryBinding(target, 'backup subdirectory');
  journal.subdirectories.set(canonicalPathKey(target), {
    identity: inspected.identity,
    binding,
  });
  assertBackupRootIdentity(journal, 'backup subdirectory post-claim validation failed');
  return target;
}

function assertBackupSubdirectoryIdentity(journal, target, context) {
  assertBackupRootIdentity(journal, context);
  const expected = journal.subdirectories.get(canonicalPathKey(target));
  const current = inspectSafeDirectory(target, context);
  if (!expected || current.identity !== expected.identity) {
    throw new Error(`${context}: backup subdirectory identity changed: ${target}`);
  }
  assertDirectoryBinding(expected.binding, 'backup subdirectory');
}

function writeManifest(journal, manifest, phase) {
  assertBackupRootIdentity(journal, `manifest ${phase} root validation failed`);
  if (journal.manifestWriteHook) {
    journal.manifestWriteHook({
      phase,
      writeCount: journal.writeCount,
      manifestPath: journal.manifestPath,
      manifest,
    });
  }
  assertBackupRootIdentity(journal, `manifest ${phase} post-hook root validation failed`);
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const intendedHash = sha256(Buffer.from(content));
  const current = inspectSafeRegularTarget(
    journal.manifestPath,
    `manifest ${phase} pre-write validation failed`,
    'manifest.json'
  );
  if (journal.manifestHash === null) {
    if (current.exists) throw new Error(`manifest first write refused existing target: ${journal.manifestPath}`);
  } else if (!current.exists || current.sha256 !== journal.manifestHash) {
    throw new Error(`manifest CAS failed: expected ${journal.manifestHash}, actual ${current.sha256 || '(missing)'}`);
  }

  const stagedPath = uniqueSiblingPath(journal.manifestPath, 'manifest-staged');
  let claimPath = null;
  try {
    assertBackupRootIdentity(journal, `manifest ${phase} staging root validation failed`);
    fs.writeFileSync(stagedPath, content, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(stagedPath, 0o600);
    if (journal.manifestHash !== null) {
      claimPath = claimExpectedConfig(
        journal.manifestPath,
        journal.manifestHash,
        `manifest ${phase} CAS failed`
      );
    }
    assertBackupRootIdentity(journal, `manifest ${phase} pre-publish root validation failed`);
    publishStagedConfigNoReplace(
      stagedPath,
      journal.manifestPath,
      `manifest ${phase} no-replace publish failed`,
      { claimPath }
    );
    const published = inspectSafeRegularTarget(
      journal.manifestPath,
      `manifest ${phase} post-write validation failed`,
      'manifest.json'
    );
    if (published.sha256 !== intendedHash) {
      throw new Error(`manifest ${phase} hash mismatch after publish`);
    }
    if (process.platform !== 'win32' && posixFileMode(journal.manifestPath) !== 0o600) {
      throw new Error(`manifest ${phase} mode mismatch after publish`);
    }
    fs.unlinkSync(stagedPath);
    if (claimPath) {
      fs.unlinkSync(claimPath);
      claimPath = null;
    }
    journal.manifestHash = intendedHash;
    journal.writeCount += 1;
    assertBackupRootIdentity(journal, `manifest ${phase} post-publish root validation failed`);
  } catch (error) {
    if (claimPath && lstatIfPresent(claimPath)) {
      const preservation = preserveClaimWithoutOverwrite(claimPath, journal.manifestPath);
      if (preservation.recoveryPath) attachRecoveryPath(error, preservation.recoveryPath);
    }
    throw error;
  } finally {
    if (lstatIfPresent(stagedPath)) fs.rmSync(stagedPath, { force: true });
  }
}

function bestEffortManifestWrite(journal, manifest, phase) {
  try {
    writeManifest(journal, manifest, phase);
    return true;
  } catch (error) {
    journal.journalErrors.push(`${phase}: ${error.message}`);
    return false;
  }
}

function requiredManifestWrite(journal, manifest, phase) {
  try {
    writeManifest(journal, manifest, phase);
  } catch (error) {
    journal.journalErrors.push(`${phase}: ${error.message}`);
    throw error;
  }
}

function posixFileMode(target) {
  if (process.platform === 'win32' || !fs.existsSync(target)) return null;
  return fs.statSync(target).mode & 0o777;
}

function uniqueSiblingPath(target, label) {
  return `${target}.tech-persistence-${label}-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
}

function configCasError(message, recoveryPaths = []) {
  const uniqueRecoveryPaths = [...new Set(recoveryPaths.filter(Boolean))];
  const recoverySuffix = uniqueRecoveryPaths.length > 0
    ? `; claimed content preserved at ${uniqueRecoveryPaths.join(', ')}` : '';
  const error = new Error(`${message}${recoverySuffix}`);
  error.code = 'CODEX_CONFIG_CAS_CONFLICT';
  error.recoveryPaths = uniqueRecoveryPaths;
  return error;
}

function attachRecoveryPath(error, recoveryPath) {
  if (!recoveryPath) return error;
  error.recoveryPaths = [...new Set([...(error.recoveryPaths || []), recoveryPath])];
  if (!error.message.includes(recoveryPath)) {
    error.message += `; claimed content preserved at ${recoveryPath}`;
  }
  return error;
}

function preserveClaimWithoutOverwrite(claimPath, target) {
  if (!lstatIfPresent(claimPath)) return { restored: false, recoveryPath: null };
  if (lstatIfPresent(target)) return { restored: false, recoveryPath: claimPath };
  const claimStat = fs.lstatSync(claimPath);
  try {
    if (claimStat.isFile()) {
      fs.linkSync(claimPath, target);
    } else if (claimStat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(claimPath);
      fs.symlinkSync(linkTarget, target, process.platform === 'win32' ? 'file' : undefined);
    } else {
      return { restored: false, recoveryPath: claimPath };
    }
  } catch (error) {
    // link/symlink creation is a no-replace operation. EEXIST means a newer
    // writer won the target path; all other failures retain the claim file.
    return { restored: false, recoveryPath: claimPath, error: error.message };
  }
  try {
    fs.unlinkSync(claimPath);
    return { restored: true, recoveryPath: null };
  } catch (error) {
    // Both names now reference the same content. Keeping the unpredictable
    // claim name is safer than risking deletion of either path.
    return { restored: true, recoveryPath: claimPath, error: error.message };
  }
}

function claimExpectedConfig(target, expectedSha256, context, options = {}) {
  const claimPath = uniqueSiblingPath(target, 'claim');
  if (typeof options.beforeClaim === 'function') options.beforeClaim({ target, claimPath });
  try {
    fs.renameSync(target, claimPath);
  } catch (error) {
    throw configCasError(`${context}: unable to claim expected config without overwrite: ${error.message}`);
  }

  const claimStat = fs.lstatSync(claimPath);
  const claimedHash = claimStat.isFile() ? hashPath(claimPath) : null;
  if (!claimStat.isFile() || claimedHash !== expectedSha256) {
    const preservation = preserveClaimWithoutOverwrite(claimPath, target);
    const kind = claimStat.isSymbolicLink()
      ? 'symbolic link, junction, or reparse point'
      : claimStat.isFile() ? `hash ${claimedHash}` : 'non-regular file';
    throw configCasError(
      `${context}: CAS claim captured ${kind}, expected hash ${expectedSha256}`,
      [preservation.recoveryPath]
    );
  }
  return claimPath;
}

function publishStagedConfigNoReplace(stagedPath, target, context, options = {}) {
  if (typeof options.beforePublish === 'function') {
    options.beforePublish({ target, stagedPath, claimPath: options.claimPath || null });
  }
  try {
    // source and target are siblings, so hard-link creation is same-volume and
    // atomic. Unlike rename on POSIX, link fails with EEXIST and never replaces
    // a config created by a concurrent writer.
    fs.linkSync(stagedPath, target);
  } catch (error) {
    throw configCasError(`${context}: no-replace publish failed: ${error.message}`);
  }
}

function writeFileAtomically(target, content, options = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const context = options.context || 'atomic config write refused';
  const expectedExisted = typeof options.expectedExisted === 'boolean'
    ? options.expectedExisted : Boolean(lstatIfPresent(target));
  const initialState = assertConfigState(
    target,
    expectedExisted,
    expectedExisted ? options.expectedSha256 : null,
    context
  );
  const temporary = uniqueSiblingPath(target, 'staged');
  const requestedMode = Number.isInteger(options.mode) ? options.mode & 0o777 : null;
  const expectedMode = process.platform === 'win32'
    ? null
    : (requestedMode ?? (initialState.exists ? posixFileMode(target) : null) ?? 0o600);
  const intendedSha256 = sha256(Buffer.isBuffer(content) ? content : Buffer.from(content));
  let claimPath = null;
  try {
    fs.writeFileSync(temporary, content, {
      flag: 'wx',
      ...(expectedMode === null ? {} : { mode: expectedMode }),
    });
    if (expectedMode !== null) {
      // chmod defeats a permissive or restrictive umask and makes the intended
      // replacement mode mechanically verifiable before activation.
      fs.chmodSync(temporary, expectedMode);
      if (posixFileMode(temporary) !== expectedMode) {
        throw new Error(`temporary config mode verification failed: ${temporary}`);
      }
    }
    if (expectedExisted) {
      claimPath = claimExpectedConfig(target, options.expectedSha256, context, {
        beforeClaim: options.beforeClaim,
      });
    } else if (typeof options.beforeClaim === 'function') {
      options.beforeClaim({ target, claimPath: null });
    }
    publishStagedConfigNoReplace(temporary, target, context, {
      beforePublish: options.beforePublish,
      claimPath,
    });
    const published = inspectSafeConfigTarget(target, `${context}: publish verification failed`);
    if (published.sha256 !== intendedSha256) {
      throw configCasError(`${context}: published config hash ${published.sha256} does not match intended hash ${intendedSha256}`);
    }
    if (expectedMode !== null && posixFileMode(target) !== expectedMode) {
      throw new Error(`config mode verification failed after publish: ${target}`);
    }
    fs.unlinkSync(temporary);
    if (claimPath) {
      fs.unlinkSync(claimPath);
      claimPath = null;
    }
  } catch (error) {
    if (claimPath && lstatIfPresent(claimPath)) {
      const preservation = preserveClaimWithoutOverwrite(claimPath, target);
      if (preservation.recoveryPath) attachRecoveryPath(error, preservation.recoveryPath);
      if (preservation.restored && !preservation.recoveryPath) claimPath = null;
    }
    throw error;
  } finally {
    if (lstatIfPresent(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function removeExpectedConfigNoOverwrite(target, expectedSha256, context, options = {}) {
  assertConfigState(target, true, expectedSha256, context);
  const claimPath = claimExpectedConfig(target, expectedSha256, context, {
    beforeClaim: options.beforeClaim,
  });
  const competingTarget = lstatIfPresent(target);
  if (competingTarget) {
    throw configCasError(
      `${context}: a concurrent config appeared after the delete claim`,
      [claimPath]
    );
  }
  // The random claim is the exact doctor-owned version verified above. Once
  // unlinked, a later writer may create target but can never be overwritten by
  // this deletion transaction.
  fs.unlinkSync(claimPath);
}

function invokeCodex(runCodex, args) {
  try {
    const result = runCodex(args) || {};
    return {
      result,
      record: {
        command: ['codex', ...args],
        status: Number.isInteger(result.status) ? result.status : null,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error ? result.error.message || String(result.error) : null,
      },
    };
  } catch (error) {
    return {
      result: { status: null, stdout: '', stderr: '', error },
      record: {
        command: ['codex', ...args],
        status: null,
        stdout: '',
        stderr: '',
        error: error.message || String(error),
      },
    };
  }
}

function codexInvocationSucceeded(invocation) {
  return !invocation.result.error && invocation.result.status === 0;
}

function expectedPluginOwnerSnapshots(plan) {
  const owners = (plan.pluginStateBefore || [])
    .filter((owner) => owner && owner.enabled !== false && owner.name === PLUGIN_NAME);
  const snapshots = new Map();
  for (const owner of owners) {
    if (typeof owner.pluginId !== 'string' || !owner.pluginId.startsWith(`${PLUGIN_NAME}@`)) {
      throw new Error(`rollback blocked by invalid original plugin id: ${owner.pluginId}`);
    }
    const verified = pluginOwnerSnapshot(owner);
    if (!owner.fingerprint || verified.fingerprint !== owner.fingerprint) {
      throw new Error(`rollback blocked by invalid original owner fingerprint: ${owner.pluginId}`);
    }
    snapshots.set(owner.pluginId, owner);
  }
  return snapshots;
}

function ownerSnapshotsFromPluginList(invocation) {
  if (!codexInvocationSucceeded(invocation)) {
    throw new Error(`official Codex owner probe failed: ${invocation.record.error || invocation.record.stderr || invocation.record.status}`);
  }
  let pluginList;
  try {
    pluginList = JSON.parse(invocation.result.stdout || '');
  } catch (error) {
    throw new Error(`official Codex owner probe returned invalid JSON: ${error.message}`);
  }
  return normalizePluginOwners(pluginList).map(pluginOwnerSnapshot)
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function appendRollbackResult(journal, manifest, result) {
  manifest.rollbackResults.push(result);
  bestEffortManifestWrite(
    journal,
    manifest,
    `rollback-${result.step}-${manifest.rollbackResults.length}`
  );
}

function restoreConfigFromBackup(plan, journal, manifest) {
  if (!plan.configUpdate) return;
  const update = plan.configUpdate;
  const backup = manifest.configBackup;
  const attempt = manifest.configUpdateAttempt;
  const result = {
    step: 'restore-config',
    target: update.configPath,
    expectedExisted: update.existed,
    doctorWriteSha256: attempt && attempt.intendedSha256 || null,
    doctorWriteActivated: Boolean(attempt && attempt.activated),
    ok: false,
  };
  try {
    const current = inspectSafeConfigTarget(
      update.configPath,
      'config rollback safety check failed'
    );
    result.currentExisted = current.exists;
    result.currentSha256 = current.sha256;
    const originalStateIntact = current.exists === update.existed
      && (!current.exists || current.sha256 === update.sha256);
    const doctorWritePresent = Boolean(
      attempt && attempt.intendedSha256 && current.exists
      && current.sha256 === attempt.intendedSha256
    );

    if (attempt && attempt.activated && !doctorWritePresent) {
      throw new Error(`config rollback CAS failed: current hash ${current.sha256 || '(missing)'} does not match doctor write ${attempt.intendedSha256}`);
    }
    if ((!attempt || !attempt.activated) && !doctorWritePresent) {
      if (!originalStateIntact) {
        throw new Error(`config rollback CAS failed: current hash ${current.sha256 || '(missing)'} is neither the original nor the doctor write`);
      }
      result.skippedBeforeDoctorWrite = true;
      result.ok = true;
      appendRollbackResult(journal, manifest, result);
      return;
    }

    if (update.existed) {
      if (!backup || !backup.backup || !fs.existsSync(backup.backup)) {
        throw new Error('verified config backup is missing');
      }
      assertBackupSubdirectoryIdentity(
        journal,
        path.dirname(backup.backup),
        'config backup rollback validation failed'
      );
      inspectSafeRegularTarget(
        backup.backup,
        'config backup rollback validation failed',
        'backed-up config.toml'
      );
      if (hashPath(backup.backup) !== update.sha256) {
        throw new Error('config backup hash changed before rollback');
      }
      writeFileAtomically(
        update.configPath,
        fs.readFileSync(backup.backup),
        {
          mode: backup.posixMode,
          expectedExisted: true,
          expectedSha256: attempt.intendedSha256,
          context: 'config rollback CAS failed',
        }
      );
      if (hashPath(update.configPath) !== update.sha256) {
        throw new Error('restored config hash does not match the preflight hash');
      }
      if (backup.posixMode !== null && posixFileMode(update.configPath) !== backup.posixMode) {
        throw new Error('restored config mode does not match the original mode');
      }
      result.sha256 = update.sha256;
      result.posixMode = backup.posixMode;
    } else if (current.exists) {
      removeExpectedConfigNoOverwrite(
        update.configPath,
        attempt.intendedSha256,
        'config rollback CAS failed'
      );
      if (lstatIfPresent(update.configPath)) throw new Error('new config still exists after rollback');
      result.removedNewConfig = true;
    } else {
      result.removedNewConfig = false;
    }
    result.ok = true;
  } catch (error) {
    result.error = error.message;
  }
  appendRollbackResult(journal, manifest, result);
  if (!result.ok) throw new Error(`config rollback failed: ${result.error}`);
}

function queryPluginOwnersForRollback(runCodex, journal, manifest, step) {
  const invocation = invokeCodex(runCodex, ['plugin', 'list', '--json']);
  const result = { step, ...invocation.record, ok: false };
  try {
    result.owners = ownerSnapshotsFromPluginList(invocation);
    result.ownerIds = result.owners.map((owner) => owner.pluginId);
    result.ok = true;
  } catch (error) {
    result.error = error.message;
  }
  appendRollbackResult(journal, manifest, result);
  if (!result.ok) throw new Error(result.error);
  return result.owners;
}

function restorePluginOwners(plan, runCodex, journal, manifest) {
  const forwardCommandEvidence = (manifest.commandResults || [])
    .filter((result) => result && Array.isArray(result.args));
  let expected = new Map();
  let originalOwnersValidationError = null;
  try {
    expected = expectedPluginOwnerSnapshots(plan);
  } catch (error) {
    originalOwnersValidationError = error.message;
  }
  let current = null;
  let currentOwnersProbeError = null;
  try {
    current = queryPluginOwnersForRollback(
      runCodex, journal, manifest, 'probe-plugin-owners-before-rollback'
    );
  } catch (error) {
    currentOwnersProbeError = error.message;
  }

  // The official Codex plugin CLI mutates owners by plugin id only. It does
  // not expose an atomic version/source fingerprint compare-and-swap. Even a
  // probe immediately before an inverse remove/add therefore has a TOCTOU
  // window in which a concurrent owner with the same id can be destroyed.
  // Once any forward owner command was attempted, preserve the current owner
  // state and fail closed with complete recovery evidence instead of issuing
  // a potentially destructive inverse command.
  if (forwardCommandEvidence.length > 0) {
    const manualActions = forwardCommandEvidence.map((evidence) => {
      const action = evidence.args[1];
      const pluginId = evidence.args[2];
      const original = expected.get(pluginId) || null;
      return {
        pluginId,
        forwardCommand: evidence.command,
        forwardSucceeded: evidence.succeeded === true,
        candidateRecoveryCommand: action === 'remove'
          ? ['codex', 'plugin', 'add', pluginId, '--json']
          : ['codex', 'plugin', 'remove', pluginId, '--json'],
        expectedOriginalFingerprint: original ? original.fingerprint : null,
        expectedDoctorFingerprint: evidence.postOwnerFingerprint || null,
        precondition: 'Stop concurrent installers/doctors, re-run codex plugin list --json, and compare the full id/version/source/enabled fingerprint with this manifest before deciding whether the candidate command is still valid.',
        automaticExecutionForbidden: true,
      };
    });
    const result = {
      step: 'owner-compensation-skipped-unsafe',
      ok: false,
      reason: 'official Codex plugin CLI has no atomic version/source compare-and-swap',
      originalOwners: [...expected.values()],
      originalOwnersValidationError,
      currentOwners: current,
      currentOwnersProbeError,
      forwardCommandEvidence,
      manualRecovery: {
        required: true,
        instruction: 'Inspect originalOwners, currentOwners, forwardCommandEvidence, and actions; stop concurrent installers/doctors and re-probe full owner fingerprints before executing any candidate command.',
        actions: manualActions,
      },
    };
    manifest.ownerCompensation = result;
    appendRollbackResult(journal, manifest, result);
    throw new Error('plugin owner compensation skipped unsafe: forward owner command executed; manual recovery required');
  }

  if (originalOwnersValidationError) throw new Error(originalOwnersValidationError);
  if (currentOwnersProbeError) throw new Error(currentOwnersProbeError);

  const failures = [];
  const verifiedById = new Map(current.map((owner) => [owner.pluginId, owner]));
  for (const [pluginId, original] of expected.entries()) {
    const actual = verifiedById.get(pluginId);
    if (!actual) {
      failures.push(`${pluginId}: original owner missing after rollback`);
    } else if (actual.fingerprint !== original.fingerprint) {
      failures.push(`${pluginId}: original owner fingerprint mismatch after rollback; expected=${original.fingerprint} actual=${actual.fingerprint}`);
    }
  }
  const verificationResult = {
    step: 'verify-original-plugin-owner-fingerprints',
    originalOwnerFingerprints: [...expected.values()].map((owner) => ({
      pluginId: owner.pluginId,
      fingerprint: owner.fingerprint,
    })),
    actualOwners: current,
    concurrentOwnerIdsPreserved: current
      .filter((owner) => !expected.has(owner.pluginId))
      .map((owner) => owner.pluginId),
    ok: failures.length === 0,
  };
  if (!verificationResult.ok) verificationResult.error = failures.join('; ');
  appendRollbackResult(journal, manifest, verificationResult);
  if (failures.length > 0) throw new Error(`plugin owner verification failed: ${failures.join('; ')}`);
}

function compensateRepair(plan, runCodex, journal, manifest, error) {
  manifest.state = 'rollback-in-progress';
  manifest.failedAt = new Date().toISOString();
  manifest.error = error.message;
  bestEffortManifestWrite(journal, manifest, 'rollback-start');
  const rollbackErrors = [];
  try {
    restoreConfigFromBackup(plan, journal, manifest);
  } catch (rollbackError) {
    rollbackErrors.push(rollbackError.message);
  }
  try {
    restorePluginOwners(plan, runCodex, journal, manifest);
  } catch (rollbackError) {
    rollbackErrors.push(rollbackError.message);
  }
  manifest.rollbackCompletedAt = new Date().toISOString();
  manifest.rollbackErrors = rollbackErrors;
  manifest.rollbackJournalErrors = [...new Set(journal.journalErrors)];
  manifest.state = rollbackErrors.length === 0 && manifest.rollbackJournalErrors.length === 0
    ? 'rolled-back' : 'rollback-failed';
  const finalManifestPersisted = bestEffortManifestWrite(journal, manifest, 'rollback-final');
  manifest.rollbackJournalErrors = [...new Set(journal.journalErrors)];
  const rollbackSucceeded = rollbackErrors.length === 0
    && manifest.rollbackJournalErrors.length === 0;
  const rollbackMessage = rollbackSucceeded
    ? 'compensating rollback completed; rollback journal completed'
    : `compensating rollback failed: recovery=${rollbackErrors.length === 0 ? 'completed' : rollbackErrors.join('; ')}; journal=${manifest.rollbackJournalErrors.length === 0 ? 'completed' : manifest.rollbackJournalErrors.join('; ')}`;
  let evidencePath = null;
  let evidencePersistenceError = null;
  if (finalManifestPersisted) {
    try {
      const evidence = inspectSafeRegularTarget(
        journal.manifestPath,
        'final recovery evidence validation failed',
        'manifest.json'
      );
      if (!evidence.exists || evidence.sha256 !== journal.manifestHash) {
        throw new Error('final recovery manifest is missing or its hash is not the final journal hash');
      }
      const parsed = JSON.parse(fs.readFileSync(journal.manifestPath, 'utf8'));
      if (parsed.state !== manifest.state) {
        throw new Error(`final recovery manifest state mismatch: ${parsed.state} != ${manifest.state}`);
      }
      evidencePath = journal.manifestPath;
    } catch (evidenceError) {
      evidencePersistenceError = evidenceError.message;
    }
  } else {
    evidencePersistenceError = 'final recovery manifest could not be persisted';
  }
  const evidenceMessage = evidencePath
    ? `recovery evidence: ${evidencePath}`
    : `recovery evidence unavailable (intended path: ${journal.manifestPath}; ${evidencePersistenceError})`;
  const failure = new Error(`${error.message}; ${rollbackMessage}; ${evidenceMessage}`);
  failure.cause = error;
  failure.rollbackFailed = rollbackErrors.length > 0 || manifest.rollbackJournalErrors.length > 0;
  failure.rollbackRecoveryFailed = rollbackErrors.length > 0;
  failure.rollbackJournalFailed = manifest.rollbackJournalErrors.length > 0;
  failure.rollbackErrors = rollbackErrors;
  failure.rollbackJournalErrors = manifest.rollbackJournalErrors;
  failure.manifestPath = journal.manifestPath;
  failure.evidencePath = evidencePath;
  failure.evidencePersistenceError = evidencePersistenceError;
  failure.recoveryState = JSON.parse(JSON.stringify({
    state: manifest.state,
    configUpdateAttempt: manifest.configUpdateAttempt || null,
    configBackup: manifest.configBackup || null,
    rollbackResults: manifest.rollbackResults,
    rollbackErrors: manifest.rollbackErrors,
    rollbackJournalErrors: manifest.rollbackJournalErrors,
    ownerCompensation: manifest.ownerCompensation || null,
  }));
  failure.ownerCompensation = manifest.ownerCompensation
    ? JSON.parse(JSON.stringify(manifest.ownerCompensation)) : null;
  failure.manualRecovery = failure.ownerCompensation
    ? failure.ownerCompensation.manualRecovery : null;
  return failure;
}

function applyRepairPlan(plan, options = {}) {
  // Work from an immutable JSON snapshot so caller callbacks cannot inject an
  // owner proposal or alter config targets after preflight.
  plan = JSON.parse(JSON.stringify(plan));
  preflightRepairPlan(plan);
  if (!plan.needsRepair) {
    return { ok: true, noop: true, manifestPath: null, manifest: null };
  }
  if (typeof options.verify !== 'function') {
    const error = new Error('repair verification callback is required before any mutation');
    error.code = 'CODEX_REPAIR_VERIFIER_REQUIRED';
    throw error;
  }
  const runCodex = options.runCodex || defaultRunCodex;
  const journal = claimBackupRoot(plan.backupRoot, {
    beforeBackupClaim: options.beforeBackupClaim,
    manifestWriteHook: options.manifestWriteHook,
  });
  const manifestPath = journal.manifestPath;
  const manifest = {
    ...plan, state: 'prepared', preparedAt: new Date().toISOString(),
    commandResults: [], rollbackResults: [],
  };
  try {
    requiredManifestWrite(journal, manifest, 'prepared');
    if (plan.configUpdate) {
      const configBackupDirectory = plan.configUpdate.existed
        ? ensureBackupSubdirectory(journal, 'codex-config') : null;
      const configBackup = configBackupDirectory
        ? path.join(configBackupDirectory, 'config.toml') : null;
      if (plan.configUpdate.existed) {
        assertConfigState(
          plan.configUpdate.configPath,
          true,
          plan.configUpdate.sha256,
          'config backup safety check failed'
        );
        assertBackupSubdirectoryIdentity(
          journal,
          configBackupDirectory,
          'config backup pre-copy validation failed'
        );
        fs.copyFileSync(plan.configUpdate.configPath, configBackup, fs.constants.COPYFILE_EXCL);
        assertBackupSubdirectoryIdentity(
          journal,
          configBackupDirectory,
          'config backup post-copy validation failed'
        );
        inspectSafeRegularTarget(
          configBackup,
          'config backup post-copy validation failed',
          'backed-up config.toml'
        );
        if (hashPath(configBackup) !== plan.configUpdate.sha256) {
          throw new Error(`config backup verification failed: ${plan.configUpdate.configPath}`);
        }
      }
      manifest.configBackup = {
        source: plan.configUpdate.configPath,
        existed: plan.configUpdate.existed,
        sha256: plan.configUpdate.sha256,
        backup: plan.configUpdate.existed ? configBackup : null,
        posixMode: plan.configUpdate.existed ? posixFileMode(plan.configUpdate.configPath) : null,
      };
      manifest.state = 'config-backed-up';
      requiredManifestWrite(journal, manifest, 'config-backed-up');
    }
    if (plan.configUpdate) {
      assertConfigState(
        plan.configUpdate.configPath,
        plan.configUpdate.existed,
        plan.configUpdate.sha256,
        'config changed after preflight'
      );
      const currentContent = plan.configUpdate.existed
        ? fs.readFileSync(plan.configUpdate.configPath, 'utf8')
        : '';
      const updatedContent = renderManagedSkillExclusions(currentContent, plan.configUpdate.managedPaths);
      manifest.configUpdateAttempt = {
        path: plan.configUpdate.configPath,
        intendedSha256: sha256(Buffer.from(updatedContent, 'utf8')),
        activated: false,
      };
      requiredManifestWrite(journal, manifest, 'config-update-prepared');
      writeFileAtomically(plan.configUpdate.configPath, updatedContent, {
        expectedExisted: plan.configUpdate.existed,
        expectedSha256: plan.configUpdate.sha256,
        context: 'config write safety check failed',
      });
      const activatedHash = hashPath(plan.configUpdate.configPath);
      if (activatedHash !== manifest.configUpdateAttempt.intendedSha256) {
        throw new Error(`config activation hash mismatch: ${plan.configUpdate.configPath}`);
      }
      manifest.configUpdateAttempt.activated = true;
      manifest.configUpdateAttempt.activatedSha256 = activatedHash;
      manifest.configUpdate = {
        path: plan.configUpdate.configPath,
        sha256: activatedHash,
        managedPaths: plan.configUpdate.managedPaths,
      };
      manifest.state = 'config-updated';
      requiredManifestWrite(journal, manifest, 'config-updated');
    }
    let verificationResult = null;
    if (typeof options.verify === 'function') {
      try {
        verificationResult = options.verify();
      } catch (verificationError) {
        manifest.state = 'verification-failed';
        manifest.verification = { healthy: false, error: verificationError.message };
        requiredManifestWrite(journal, manifest, 'verification-exception');
        throw new Error(`repair verification failed: ${verificationError.message}`);
      }
      manifest.verification = verificationResult && verificationResult.verification || null;
      if (!verificationResult || verificationResult.verified !== true) {
        manifest.state = 'verification-failed';
        requiredManifestWrite(journal, manifest, 'verification-failed');
        throw new Error(verificationResult && verificationResult.errorMessage
          ? verificationResult.errorMessage
          : 'repair verification failed: verifier did not confirm a healthy runtime');
      }
    }
    manifest.state = 'completed';
    manifest.completedAt = new Date().toISOString();
    requiredManifestWrite(journal, manifest, 'completed');
    return { ok: true, manifestPath, manifest, verificationResult };
  } catch (error) {
    throw compensateRepair(plan, runCodex, journal, manifest, error);
  }
}

function readPluginListWithCodex() {
  const result = defaultRunCodex(['plugin', 'list', '--json']);
  if (result.error || result.status !== 0) {
    throw new Error(`codex plugin list --json failed: ${result.error ? result.error.message : result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`codex plugin list --json returned invalid JSON: ${error.message}`);
  }
}

function evaluateRepairVerification(finalReport, canonicalPluginId) {
  const verification = {
    healthy: finalReport.healthy,
    ownerCount: finalReport.ownerCount,
    canonicalPluginOwners: finalReport.pluginOwners
      .filter((owner) => owner.pluginId === canonicalPluginId).map((owner) => owner.pluginId),
    directOwners: finalReport.directOwners.map((owner) => owner.scope),
    duplicateSkills: finalReport.duplicateSkills,
    duplicateHooks: finalReport.duplicateHooks,
    divergedCopies: finalReport.divergedCopies.map((copy) => copy.path),
    preservedDirectSkills: finalReport.directSkillConflicts.map((conflict) => ({
      path: conflict.path,
      exact: conflict.exact,
      managedExcluded: conflict.managedExcluded,
    })),
    unmanagedDirectSkillConflicts: finalReport.unmanagedDirectSkillConflicts
      .map((conflict) => conflict.skillFile),
    unmanagedSharedSkillConflicts: finalReport.unmanagedSharedSkillConflicts
      .map((conflict) => conflict.skillFile),
  };
  const verified = verification.healthy
    && finalReport.pluginOwners.length === 1
    && verification.canonicalPluginOwners.length === 1
    && verification.directOwners.length === 0
    && verification.unmanagedDirectSkillConflicts.length === 0
    && verification.unmanagedSharedSkillConflicts.length === 0;
  const errorMessage = `repair verification failed: ownerCount=${finalReport.ownerCount}, canonicalOwners=${verification.canonicalPluginOwners.length}, directOwners=${verification.directOwners.length}, directSkillConflicts=${verification.unmanagedDirectSkillConflicts.length}, sharedConflicts=${verification.unmanagedSharedSkillConflicts.length}`;
  return { finalReport, verification, verified, errorMessage };
}

function runDoctor(options = {}) {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(homeDir, '.codex'));
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const canonicalPluginId = options.canonicalPluginId || DEFAULT_CANONICAL_PLUGIN_ID;
  const readPluginList = options.readPluginList || readPluginListWithCodex;
  const report = analyzeRuntime({
    pluginList: readPluginList(), codexHome, projectRoot,
    referencePluginRoot: options.referencePluginRoot, canonicalPluginId,
  });
  let plan = null;
  let planningError = null;
  try {
    plan = buildRepairPlan(report, {
      backupRoot: options.backupRoot, installCanonical: options.installCanonical, canonicalPluginId,
    });
  } catch (error) {
    planningError = error;
  }
  if (!options.fix) {
    return { mode: 'dry-run', report, plan, blocked: planningError ? planningError.message : null };
  }
  if (planningError) throw planningError;
  let finalState = null;
  const verify = () => {
    const finalReport = analyzeRuntime({
      pluginList: readPluginList(), codexHome, projectRoot,
      referencePluginRoot: options.referencePluginRoot, canonicalPluginId,
    });
    finalState = evaluateRepairVerification(finalReport, canonicalPluginId);
    return finalState;
  };
  const repair = applyRepairPlan(plan, { runCodex: options.runCodex, verify });
  if (!finalState) finalState = verify();
  if (!finalState.verified) throw new Error(finalState.errorMessage);
  const { finalReport, verification } = finalState;
  return { mode: 'fix', report, plan, repair, finalReport, verification };
}

function summary(result) {
  const report = result.report;
  const lines = [
    `Codex runtime doctor (${result.mode})`,
    `ownerCount=${report.ownerCount}`,
    `pluginOwners=${report.pluginOwners.map((owner) => owner.pluginId).join(',') || 'none'}`,
    `directOwners=${report.directOwners.map((owner) => owner.scope).join(',') || 'none'}`,
    `duplicateSkills=${report.duplicateSkills.join(',') || 'none'}`,
    `duplicateHooks=${report.duplicateHooks.join(',') || 'none'}`,
    `managedCopies=${report.managedCopies.length}`,
    `divergedCopies=${report.divergedCopies.map((copy) => copy.path).join(',') || 'none'}`,
    `preservedDirectSkills=${report.directSkillConflicts.length}`,
    `unmanagedDirectSkillConflicts=${report.unmanagedDirectSkillConflicts.map((conflict) => conflict.skillFile).join(',') || 'none'}`,
    `standaloneDirectHooks=${report.standaloneDirectHookArtifacts.map((copy) => copy.path).join(',') || 'none'}`,
    `sharedSkillConflicts=${report.sharedSkillConflicts.length}`,
    `unmanagedSharedSkillConflicts=${report.unmanagedSharedSkillConflicts.map((conflict) => conflict.skillFile).join(',') || 'none'}`,
  ];
  if (result.blocked) lines.push(`blocked=${result.blocked}`);
  if (result.plan) {
    lines.push(`plannedMoves=${result.plan.moves.length}`);
    lines.push(`plannedConfigExclusions=${result.plan.configUpdate ? result.plan.configUpdate.managedPaths.length : 0}`);
    lines.push(`plannedOwnerActions=${result.plan.proposedOwnerCommands.map((args) => ['codex', ...args].join(' ')).join(' | ') || 'none'}`);
  }
  if (result.repair) lines.push(`manifest=${result.repair.manifestPath}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const parsed = { fix: false, json: false, installCanonical: false, canonicalPluginId: DEFAULT_CANONICAL_PLUGIN_ID };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fix') parsed.fix = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--install-canonical') parsed.installCanonical = true;
    else if (arg === '--plugin-owner-status') parsed.pluginOwnerStatus = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (['--codex-home', '--project-root', '--reference-plugin-root', '--backup-root', '--canonical-plugin-id', '--plugin-list-file'].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      const key = {
        '--codex-home': 'codexHome', '--project-root': 'projectRoot',
        '--reference-plugin-root': 'referencePluginRoot', '--backup-root': 'backupRoot',
        '--canonical-plugin-id': 'canonicalPluginId', '--plugin-list-file': 'pluginListFile',
      }[arg];
      parsed[key] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function showHelp() {
  console.log([
    'Usage: node scripts/codex-runtime-doctor.js [--fix] [--json]',
    '       node scripts/codex-runtime-doctor.js --plugin-owner-status [--json]',
    '',
    'Default mode is read-only dry-run. --fix requires complete hash preflight,',
    'preserves direct skill files in place, and backs up config before adding full',
    'SKILL.md exclusions. Plugin owner add/remove is never automated because the',
    'official CLI has no atomic version/source compare-and-swap.',
  ].join('\n'));
}

function formatCliFailure(error, json = false) {
  const payload = {
    ok: false,
    error: error.message,
    code: error.code || null,
    evidencePath: error.evidencePath || null,
    intendedManifestPath: error.manifestPath || null,
    evidencePersistenceError: error.evidencePersistenceError || null,
    recoveryState: error.recoveryState || null,
    ownerCompensation: error.ownerCompensation || null,
    manualRecovery: error.manualRecovery || null,
  };
  if (json) return JSON.stringify(payload, null, 2);
  const code = payload.code ? ` code=${payload.code}` : '';
  const evidence = payload.evidencePath ? ` evidence=${payload.evidencePath}` : '';
  const manual = payload.manualRecovery
    ? `\nmanualRecovery=${JSON.stringify(payload.manualRecovery)}` : '';
  const inMemory = !payload.evidencePath && payload.recoveryState
    ? `\nrecoveryState=${JSON.stringify(payload.recoveryState)}` : '';
  return `[FAIL] ${payload.error}${code}${evidence}${manual}${inMemory}`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { showHelp(); return 0; }
  if (options.pluginListFile) {
    const fixturePath = path.resolve(options.pluginListFile);
    options.readPluginList = () => readJson(fixturePath);
    if (options.fix) throw new Error('--plugin-list-file is dry-run only');
  }
  if (options.pluginOwnerStatus) {
    const pluginList = (options.readPluginList || readPluginListWithCodex)();
    const owners = normalizePluginOwners(pluginList);
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(homeDir, '.codex'));
    const payload = {
      ownerCount: owners.length,
      pluginIds: owners.map((owner) => owner.pluginId),
      owners: owners.map(pluginOwnerSnapshot),
      integrity: owners.map((owner) => inspectPluginOwnerIntegrity(codexHome, owner)),
    };
    console.log(options.json ? JSON.stringify(payload) : `pluginOwnerCount=${payload.ownerCount}`);
    if (owners.length === 1) return 0;
    return owners.length === 0 ? 2 : 3;
  }
  const result = runDoctor(options);
  console.log(options.json ? JSON.stringify(result, jsonReplacer, 2) : summary(result));
  if (result.mode === 'dry-run' && (!result.report.healthy || result.blocked)) return 1;
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); }
  catch (error) {
    console.error(formatCliFailure(error, process.argv.includes('--json')));
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_CANONICAL_PLUGIN_ID,
  DIRECT_OWNER_MANIFEST,
  MANAGED_SKILL_EXCLUSIONS_BEGIN,
  MANAGED_SKILL_EXCLUSIONS_END,
  analyzeRuntime,
  applyRepairPlan,
  buildRepairPlan,
  formatCliFailure,
  hashPath,
  hookLogicalIds,
  inspectPluginRoot,
  inspectManagedSkillExclusions,
  jsonReplacer,
  main,
  normalizePluginOwners,
  inspectPluginOwnerIntegrity,
  parseArgs,
  renderManagedSkillExclusions,
  runDoctor,
  writeFileAtomically,
};
