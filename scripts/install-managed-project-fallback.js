#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  hashPath,
  inspectManagedSkillExclusions,
  renderManagedSkillExclusions,
} = require('./codex-runtime-doctor');

const OWNER_MANIFEST = 'tech-persistence-owner.json';

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/');
}

function canonicalPathKey(value) {
  const normalized = normalizeSlashes(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return canonicalPathKey(left) === canonicalPathKey(right);
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function pathEntryExists(target) {
  return lstatIfPresent(target) !== null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseTomlString(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  throw new Error('skills.config path must be a quoted TOML string');
}

function inspectDisabledSkillPaths(configPath) {
  const paths = new Map();
  if (!fs.existsSync(configPath)) return { paths, invalid: null };
  let invalid = null;
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const tables = content.split(/\[\[skills\.config\]\]/g).slice(1);
    for (const table of tables) {
      const enabledMatch = table.match(/^\s*enabled\s*=\s*(true|false)\s*$/m);
      if (!enabledMatch || enabledMatch[1] !== 'false') continue;
      const pathMatch = table.match(/^\s*path\s*=\s*(.+?)\s*$/m);
      if (!pathMatch) throw new Error('disabled skills.config entry is missing path');
      const configuredPath = parseTomlString(pathMatch[1]);
      if (!path.isAbsolute(configuredPath)
          || path.basename(configuredPath).toLowerCase() !== 'skill.md') {
        throw new Error(`disabled skills.config path must be an absolute SKILL.md path: ${configuredPath}`);
      }
      const absolute = path.resolve(configuredPath);
      paths.set(canonicalPathKey(absolute), absolute);
    }
  } catch (error) {
    invalid = error.message;
  }
  return { paths, invalid };
}

function existingAncestors(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!pathIsInside(absoluteRoot, absoluteCandidate)) {
    throw new Error(`path escapes managed root: ${absoluteCandidate}`);
  }
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  const parts = relative ? relative.split(path.sep) : [];
  const ancestors = [absoluteRoot];
  let current = absoluteRoot;
  for (const part of parts) {
    current = path.join(current, part);
    if (!pathEntryExists(current)) break;
    ancestors.push(current);
  }
  return ancestors;
}

function assertSafeManagedPath(root, candidate, label = 'managed path') {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const ancestors = existingAncestors(absoluteRoot, absoluteCandidate);
  if (!pathEntryExists(absoluteRoot)) {
    throw new Error(`${label} root does not exist: ${absoluteRoot}`);
  }
  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`${label} root is a symlink/junction/reparse point: ${absoluteRoot}`);
  }
  const realRoot = fs.realpathSync.native(absoluteRoot);
  for (const ancestor of ancestors) {
    const stat = fs.lstatSync(ancestor);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink/junction/reparse point: ${ancestor}`);
    }
    const real = fs.realpathSync.native(ancestor);
    if (!pathIsInside(realRoot, real)) {
      throw new Error(`${label} realpath escapes managed root: ${ancestor} -> ${real}`);
    }
  }
  return absoluteCandidate;
}

function assertSafeManagedTree(root, candidate, label = 'managed tree') {
  const absolute = assertSafeManagedPath(root, candidate, label);
  const stat = lstatIfPresent(absolute);
  if (!stat) return absolute;
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} contains a symlink/junction/reparse point: ${absolute}`);
  }
  if (stat.isFile()) return absolute;
  if (!stat.isDirectory()) throw new Error(`${label} contains an unsupported entry: ${absolute}`);
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink/junction/reparse point: ${child}`);
    }
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(`${label} contains an unsupported entry: ${child}`);
    }
    assertSafeManagedTree(root, child, label);
  }
  return absolute;
}

function assertHashUnchanged(target, expected, label) {
  const actual = hashPath(target);
  if (actual !== expected) {
    throw new Error(`${label} changed after preflight: ${target}`);
  }
}

function ensureDirectorySafely(root, target, label) {
  assertSafeManagedPath(root, target, label);
  assertSafeManagedPath(root, path.dirname(target), label);
  fs.mkdirSync(target, { recursive: true });
  assertSafeManagedPath(root, target, label);
}

function writeFileAtomically(root, target, content, label) {
  const directory = path.dirname(target);
  assertSafeManagedPath(root, directory, label);
  assertSafeManagedPath(root, target, label);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  assertSafeManagedPath(root, temporary, label);
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    if (pathEntryExists(target)) {
      const mode = fs.statSync(target).mode & 0o777;
      try { fs.chmodSync(temporary, mode); } catch (_) {}
    }
    assertSafeManagedPath(root, temporary, label);
    assertSafeManagedPath(root, target, label);
    fs.renameSync(temporary, target);
  } finally {
    if (pathEntryExists(temporary)) {
      assertSafeManagedPath(root, temporary, label);
      fs.rmSync(temporary, { force: true });
    }
  }
}

function readOwnerManifest(manifestPath, codexRoot) {
  if (!pathEntryExists(manifestPath)) return null;
  assertSafeManagedPath(codexRoot, manifestPath, 'owner manifest');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (parsed.schemaVersion !== 1
      || parsed.owner !== 'tech-persistence'
      || parsed.mode !== 'project-direct-fallback'
      || !Array.isArray(parsed.managed)) {
    throw new Error(`unsupported direct-owner manifest: ${manifestPath}`);
  }
  return parsed;
}

function validateManifestEntries(manifest) {
  const entries = new Map();
  for (const entry of manifest ? manifest.managed : []) {
    if (!entry
        || !/^skills\/[A-Za-z0-9._-]+$/.test(entry.path)
        || typeof entry.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`unsafe managed entry: ${JSON.stringify(entry)}`);
    }
    if (entries.has(entry.path)) throw new Error(`duplicate managed entry: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  return entries;
}

function callStep(options, step, details = {}) {
  if (typeof options.onStep === 'function') options.onStep(step, details);
  if (options.failAt === step) throw new Error(`injected failure at ${step}`);
}

function restoreFileSnapshot({
  root,
  target,
  snapshot,
  writtenHash,
  label,
}) {
  const exists = pathEntryExists(target);
  if (exists) {
    assertSafeManagedPath(root, target, label);
    if (writtenHash && hashPath(target) !== writtenHash) {
      throw new Error(`${label} changed during rollback: ${target}`);
    }
  }
  if (snapshot.exists) {
    writeFileAtomically(root, target, snapshot.content, `${label} rollback`);
  } else if (exists) {
    assertSafeManagedPath(root, target, `${label} rollback`);
    fs.rmSync(target, { force: false });
  }
}

function copyVerifiedFile(source, target, expectedHash, targetRoot, label) {
  assertSafeManagedPath(targetRoot, path.dirname(target), label);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  if (hashPath(target) !== expectedHash) {
    throw new Error(`${label} backup verification failed: ${source}`);
  }
}

function installManagedProjectFallback(options) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const codexRoot = path.resolve(options.codexRoot);
  const userCodexHome = path.resolve(options.userCodexHome);
  const manifestPath = path.join(codexRoot, OWNER_MANIFEST);
  const skillsRoot = path.join(codexRoot, 'skills');
  const configPath = path.join(userCodexHome, 'config.toml');
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const transactionId = `${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const projectBackupRoot = path.join(codexRoot, 'tech-persistence-backups', transactionId);
  const configBackupRoot = path.join(userCodexHome, 'fallback-backups', transactionId);
  const stageRoot = path.join(codexRoot, `.tech-persistence-stage-${transactionId}`);

  if (!pathEntryExists(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`missing fallback source: ${sourceRoot}`);
  }
  assertSafeManagedTree(sourceRoot, sourceRoot, 'fallback source');
  fs.mkdirSync(codexRoot, { recursive: true });
  assertSafeManagedPath(codexRoot, codexRoot, '.codex');
  ensureDirectorySafely(codexRoot, skillsRoot, 'skills root');
  fs.mkdirSync(userCodexHome, { recursive: true });
  assertSafeManagedPath(userCodexHome, userCodexHome, 'user Codex home');
  if (pathEntryExists(configPath)) assertSafeManagedPath(userCodexHome, configPath, 'Codex config');

  const names = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && fs.existsSync(path.join(sourceRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) throw new Error(`fallback source has no skills: ${sourceRoot}`);
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`unsafe skill name: ${name}`);
    assertSafeManagedTree(sourceRoot, path.join(sourceRoot, name), `fallback source ${name}`);
  }

  const oldManifest = readOwnerManifest(manifestPath, codexRoot);
  const oldEntries = validateManifestEntries(oldManifest);
  const desired = names.map((name) => {
    const relative = `skills/${name}`;
    const source = path.join(sourceRoot, name);
    const target = path.join(codexRoot, ...relative.split('/'));
    assertSafeManagedPath(codexRoot, target, `fallback skill ${name}`);
    if (pathEntryExists(target)) {
      assertSafeManagedTree(codexRoot, target, `fallback skill ${name}`);
    }
    const sourceHash = hashPath(source);
    const actualHash = hashPath(target);
    const previous = oldEntries.get(relative);
    if (actualHash && actualHash !== sourceHash && (!previous || previous.sha256 !== actualHash)) {
      throw new Error(`refusing to overwrite diverged fallback skill: ${target}`);
    }
    return {
      name,
      relative,
      source,
      target,
      skillFile: path.join(target, 'SKILL.md'),
      sha256: sourceHash,
      actual: actualHash,
    };
  });

  const desiredPaths = new Set(desired.map((entry) => entry.relative));
  const obsolete = [];
  for (const [relative, previous] of oldEntries) {
    if (desiredPaths.has(relative)) continue;
    const target = path.join(codexRoot, ...relative.split('/'));
    assertSafeManagedPath(codexRoot, target, `obsolete fallback ${relative}`);
    const actual = hashPath(target);
    if (actual && actual !== previous.sha256) {
      throw new Error(`refusing to move diverged obsolete fallback skill: ${target}`);
    }
    if (actual) obsolete.push({ relative, target, sha256: actual });
  }

  const replacements = desired.filter((entry) => entry.actual && entry.actual !== entry.sha256);
  const moves = [
    ...replacements.map((entry) => ({
      relative: entry.relative,
      target: entry.target,
      sha256: entry.actual,
    })),
    ...obsolete,
  ];
  const manifest = {
    schemaVersion: 1,
    owner: 'tech-persistence',
    mode: 'project-direct-fallback',
    managed: desired.map(({ relative, sha256: skillHash }) => ({
      path: relative,
      sha256: skillHash,
    })),
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSnapshot = {
    exists: pathEntryExists(manifestPath),
    content: pathEntryExists(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '',
    hash: pathEntryExists(manifestPath) ? hashPath(manifestPath) : null,
  };

  const managedExclusions = inspectManagedSkillExclusions(userCodexHome);
  if (managedExclusions.invalid) {
    throw new Error(`managed skill exclusions are invalid: ${managedExclusions.invalid}`);
  }
  const fallbackSkillKeys = new Set(desired.map((entry) => canonicalPathKey(entry.skillFile)));
  const removedExclusions = [...managedExclusions.paths.entries()]
    .filter(([key]) => fallbackSkillKeys.has(key))
    .map(([, skillPath]) => skillPath);
  const remainingExclusions = [...managedExclusions.paths.entries()]
    .filter(([key]) => !fallbackSkillKeys.has(key))
    .map(([, skillPath]) => skillPath);
  const configSnapshot = {
    exists: pathEntryExists(configPath),
    content: pathEntryExists(configPath) ? fs.readFileSync(configPath, 'utf8') : '',
    hash: pathEntryExists(configPath) ? hashPath(configPath) : null,
  };
  const configContent = removedExclusions.length > 0
    ? renderManagedSkillExclusions(configSnapshot.content, remainingExclusions)
    : configSnapshot.content;
  const configNeedsUpdate = configContent !== configSnapshot.content;

  const disabledBefore = inspectDisabledSkillPaths(configPath);
  if (disabledBefore.invalid) {
    throw new Error(`Codex skills.config is invalid: ${disabledBefore.invalid}`);
  }
  const unmanagedDisabled = [...fallbackSkillKeys].filter((key) => {
    return disabledBefore.paths.has(key) && !managedExclusions.paths.has(key);
  });
  if (unmanagedDisabled.length > 0) {
    throw new Error(
      `fallback activation blocked by user-managed disabled skills.config paths: ${unmanagedDisabled
        .map((key) => disabledBefore.paths.get(key)).join(', ')}`
    );
  }

  const projectBackupNeeded = moves.length > 0
    || (manifestSnapshot.exists && manifestSnapshot.content !== manifestContent);
  if (pathEntryExists(path.join(codexRoot, 'tech-persistence-backups'))) {
    assertSafeManagedPath(
      codexRoot,
      path.join(codexRoot, 'tech-persistence-backups'),
      'project fallback backup root'
    );
  }
  if (configNeedsUpdate && pathEntryExists(path.join(userCodexHome, 'fallback-backups'))) {
    assertSafeManagedPath(
      userCodexHome,
      path.join(userCodexHome, 'fallback-backups'),
      'config fallback backup root'
    );
  }

  const moved = [];
  const installed = [];
  let manifestWrittenHash = null;
  let configWrittenHash = null;
  let projectBackupCreated = false;
  let configBackupCreated = false;

  try {
    ensureDirectorySafely(codexRoot, stageRoot, 'fallback stage');
    for (const entry of desired) {
      const staged = path.join(stageRoot, entry.name);
      assertSafeManagedPath(codexRoot, staged, `staged fallback ${entry.name}`);
      fs.cpSync(entry.source, staged, { recursive: true, errorOnExist: true });
      assertSafeManagedTree(codexRoot, staged, `staged fallback ${entry.name}`);
      if (hashPath(staged) !== entry.sha256) {
        throw new Error(`staged hash mismatch: ${entry.name}`);
      }
    }

    if (projectBackupNeeded) {
      ensureDirectorySafely(codexRoot, projectBackupRoot, 'project fallback backup');
      projectBackupCreated = true;
      if (manifestSnapshot.exists) {
        const manifestBackup = path.join(projectBackupRoot, 'owner-manifest.json');
        copyVerifiedFile(
          manifestPath,
          manifestBackup,
          manifestSnapshot.hash,
          codexRoot,
          'owner manifest'
        );
      }
    }
    if (configNeedsUpdate) {
      ensureDirectorySafely(userCodexHome, configBackupRoot, 'config fallback backup');
      configBackupCreated = true;
      const configBackup = path.join(configBackupRoot, 'config.toml');
      copyVerifiedFile(
        configPath,
        configBackup,
        configSnapshot.hash,
        userCodexHome,
        'Codex config'
      );
    }

    for (const move of moves) {
      callStep(options, 'before-move-existing', { move });
      assertSafeManagedTree(codexRoot, move.target, `fallback move ${move.relative}`);
      assertHashUnchanged(move.target, move.sha256, 'fallback skill');
      const destination = path.join(projectBackupRoot, ...move.relative.split('/'));
      ensureDirectorySafely(codexRoot, path.dirname(destination), 'fallback backup destination');
      assertSafeManagedPath(codexRoot, destination, 'fallback backup destination');
      fs.renameSync(move.target, destination);
      moved.push({ ...move, destination });
    }

    for (const entry of desired) {
      const staged = path.join(stageRoot, entry.name);
      if (hashPath(entry.target) === entry.sha256) {
        callStep(options, 'before-remove-redundant-stage', { entry, staged });
        assertSafeManagedTree(codexRoot, staged, `redundant stage ${entry.name}`);
        fs.rmSync(staged, { recursive: true, force: false });
        continue;
      }
      callStep(options, 'before-install-staged', { entry, staged });
      assertSafeManagedTree(codexRoot, staged, `staged fallback ${entry.name}`);
      assertSafeManagedPath(codexRoot, entry.target, `fallback target ${entry.name}`);
      if (pathEntryExists(entry.target)) {
        throw new Error(`fallback target unexpectedly exists: ${entry.target}`);
      }
      fs.renameSync(staged, entry.target);
      installed.push(entry);
    }

    if (manifestSnapshot.exists) {
      assertHashUnchanged(manifestPath, manifestSnapshot.hash, 'owner manifest');
    } else if (pathEntryExists(manifestPath)) {
      throw new Error(`owner manifest appeared after preflight: ${manifestPath}`);
    }
    callStep(options, 'before-manifest-write', { manifestPath });
    writeFileAtomically(codexRoot, manifestPath, manifestContent, 'owner manifest');
    manifestWrittenHash = hashPath(manifestPath);
    callStep(options, 'after-manifest-write', { manifestPath });

    if (configNeedsUpdate) {
      if (!configSnapshot.exists || hashPath(configPath) !== configSnapshot.hash) {
        throw new Error(`Codex config changed after preflight: ${configPath}`);
      }
      callStep(options, 'before-config-write', { configPath });
      writeFileAtomically(userCodexHome, configPath, configContent, 'Codex config');
      configWrittenHash = hashPath(configPath);
      const disabledAfter = inspectDisabledSkillPaths(configPath);
      if (disabledAfter.invalid) {
        throw new Error(`updated Codex skills.config is invalid: ${disabledAfter.invalid}`);
      }
      const stillDisabled = desired.filter((entry) => {
        return disabledAfter.paths.has(canonicalPathKey(entry.skillFile));
      });
      if (stillDisabled.length > 0) {
        throw new Error(
          `fallback skills remain disabled after config update: ${stillDisabled
            .map((entry) => entry.skillFile).join(', ')}`
        );
      }
      callStep(options, 'after-config-write', { configPath });
    }

    if (projectBackupCreated) {
      writeFileAtomically(
        codexRoot,
        path.join(projectBackupRoot, 'manifest.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          moved: moved.map(({ relative, sha256: movedHash, destination }) => ({
            path: relative,
            sha256: movedHash,
            backup: normalizeSlashes(destination),
          })),
          ownerManifestBackup: manifestSnapshot.exists
            ? normalizeSlashes(path.join(projectBackupRoot, 'owner-manifest.json'))
            : null,
        }, null, 2)}\n`,
        'project fallback backup manifest'
      );
    }
    callStep(options, 'completed', { manifestPath, configPath });
    return {
      owner: 'direct-fallback',
      skills: desired.length,
      removedExclusions,
      projectBackupRoot: projectBackupCreated ? projectBackupRoot : null,
      configBackupRoot: configBackupCreated ? configBackupRoot : null,
    };
  } catch (error) {
    const rollbackErrors = [];
    if (configWrittenHash) {
      try {
        restoreFileSnapshot({
          root: userCodexHome,
          target: configPath,
          snapshot: configSnapshot,
          writtenHash: configWrittenHash,
          label: 'Codex config',
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    if (manifestWrittenHash) {
      try {
        restoreFileSnapshot({
          root: codexRoot,
          target: manifestPath,
          snapshot: manifestSnapshot,
          writtenHash: manifestWrittenHash,
          label: 'owner manifest',
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    for (const entry of installed.reverse()) {
      try {
        callStep(options, 'before-rollback-remove-installed', { entry });
        assertSafeManagedTree(codexRoot, entry.target, `rollback installed ${entry.name}`);
        if (hashPath(entry.target) !== entry.sha256) {
          throw new Error(`installed fallback changed during rollback: ${entry.target}`);
        }
        fs.rmSync(entry.target, { recursive: true, force: false });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    for (const move of moved.reverse()) {
      try {
        callStep(options, 'before-rollback-restore-move', { move });
        assertSafeManagedPath(codexRoot, move.target, `rollback target ${move.relative}`);
        assertSafeManagedTree(codexRoot, move.destination, `rollback backup ${move.relative}`);
        if (pathEntryExists(move.target)) {
          throw new Error(`rollback target already exists: ${move.target}`);
        }
        assertHashUnchanged(move.destination, move.sha256, 'fallback backup');
        fs.mkdirSync(path.dirname(move.target), { recursive: true });
        assertSafeManagedPath(codexRoot, path.dirname(move.target), `rollback target ${move.relative}`);
        fs.renameSync(move.destination, move.target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    const rollbackMessage = rollbackErrors.length === 0
      ? 'rollback completed'
      : `rollback failed: ${rollbackErrors.join('; ')}`;
    const failure = new Error(`${error.message}; ${rollbackMessage}`);
    failure.cause = error;
    failure.rollbackErrors = rollbackErrors;
    throw failure;
  } finally {
    if (pathEntryExists(stageRoot)) {
      assertSafeManagedTree(codexRoot, stageRoot, 'fallback stage cleanup');
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = {
      '--source': 'sourceRoot',
      '--codex-dir': 'codexRoot',
      '--user-codex-home': 'userCodexHome',
    }[arg];
    if (!key) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    parsed[key] = value;
    index += 1;
  }
  for (const key of ['sourceRoot', 'codexRoot', 'userCodexHome']) {
    if (!parsed[key]) throw new Error(`missing required argument: ${key}`);
  }
  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const result = installManagedProjectFallback(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  OWNER_MANIFEST,
  assertSafeManagedPath,
  assertSafeManagedTree,
  inspectDisabledSkillPaths,
  installManagedProjectFallback,
  parseArgs,
};
