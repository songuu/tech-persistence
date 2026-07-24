#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PLUGIN_NAME = 'tech-persistence';

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stripLeadingBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function marketplaceExpectationFromRaw(raw, posixMode = null) {
  if (raw === null || raw === undefined) {
    return { existed: false, sha256: null, rawBase64: null, posixMode: null };
  }
  const buffer = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(String(raw), 'utf8');
  return {
    existed: true,
    sha256: sha256(buffer),
    rawBase64: buffer.toString('base64'),
    posixMode,
  };
}

function normalizeExpectation(expectation) {
  if (!expectation || typeof expectation.existed !== 'boolean') {
    throw new Error('marketplace update requires an explicit expected raw/hash state');
  }
  if (!expectation.existed) {
    if (expectation.sha256 !== null || expectation.rawBase64 !== null) {
      throw new Error('absent marketplace expectation must not contain raw bytes or a hash');
    }
    return { ...expectation, raw: null };
  }
  if (!/^[0-9a-f]{64}$/.test(expectation.sha256 || '')) {
    throw new Error('marketplace expectation has an invalid SHA256');
  }
  if (typeof expectation.rawBase64 !== 'string') {
    throw new Error('marketplace expectation is missing rawBase64');
  }
  const raw = Buffer.from(expectation.rawBase64, 'base64');
  if (raw.toString('base64') !== expectation.rawBase64 || sha256(raw) !== expectation.sha256) {
    throw new Error('marketplace expectation raw bytes do not match the declared SHA256');
  }
  return { ...expectation, raw };
}

function marketplaceExpectationFromManifest(manifestPath, marketplacePath) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(stripLeadingBom(fs.readFileSync(resolvedManifest, 'utf8')));
  if (
    manifest.kind !== 'codex-user-install'
    || manifest.state !== 'activated'
    || path.resolve(manifest.manifestPath || '') !== resolvedManifest
    || path.resolve(manifest.transactionRoot || '') !== path.dirname(resolvedManifest)
    || path.resolve(manifest.inputs?.marketplacePath || '') !== path.resolve(marketplacePath)
  ) {
    throw new Error('marketplace expectation manifest is not the active bound installer transaction');
  }
  if (!manifest.lockPath || !pathExists(manifest.lockPath)) {
    throw new Error(`marketplace expectation transaction lock is missing: ${manifest.lockPath || '<none>'}`);
  }
  const lock = JSON.parse(stripLeadingBom(fs.readFileSync(manifest.lockPath, 'utf8')));
  if (
    path.resolve(lock.manifestPath || '') !== resolvedManifest
    || !manifest.lockToken
    || lock.token !== manifest.lockToken
  ) {
    throw new Error('marketplace expectation transaction lock is owned by another manifest');
  }
  const record = manifest.pre?.marketplaceFile;
  const expectation = normalizeExpectation(record);
  if (expectation.existed) {
    if (
      !record.backup
      || !pathIsInside(manifest.transactionRoot, record.backup)
      || !pathExists(record.backup)
    ) {
      throw new Error('marketplace expectation has no verified transaction backup');
    }
    const backupRaw = fs.readFileSync(record.backup);
    if (!backupRaw.equals(expectation.raw) || sha256(backupRaw) !== expectation.sha256) {
      throw new Error('marketplace expectation differs from its verified transaction backup');
    }
  }
  return expectation;
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalPluginEntry(pluginName = DEFAULT_PLUGIN_NAME) {
  return {
    name: pluginName,
    source: { source: 'local', path: `./plugins/${pluginName}` },
    policy: {
      installation: 'INSTALLED_BY_DEFAULT',
      authentication: 'ON_INSTALL',
    },
    category: 'Coding',
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function scanJsonString(text, start) {
  if (text[start] !== '"') throw new Error(`expected JSON string at offset ${start}`);
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
    } else if (text[index] === '"') {
      return index + 1;
    }
  }
  throw new Error(`unterminated JSON string at offset ${start}`);
}

function scanCompositeValue(text, start) {
  const opening = text[start];
  const stack = [opening];
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      index = scanJsonString(text, index) - 1;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) throw new Error(`mismatched JSON delimiter at offset ${index}`);
      if (stack.length === 0) return index + 1;
    }
  }
  throw new Error(`unterminated JSON value at offset ${start}`);
}

function scanJsonValue(text, start) {
  const valueStart = skipWhitespace(text, start);
  const character = text[valueStart];
  if (character === '"') return scanJsonString(text, valueStart);
  if (character === '{' || character === '[') return scanCompositeValue(text, valueStart);
  let end = valueStart;
  while (end < text.length && ![',', '}', ']'].includes(text[end])) end += 1;
  while (end > valueStart && /\s/.test(text[end - 1])) end -= 1;
  if (end === valueStart) throw new Error(`missing JSON value at offset ${valueStart}`);
  return end;
}

function scanObjectMembers(text) {
  let index = skipWhitespace(text, 0);
  if (text[index] !== '{') throw new Error('marketplace root must be a JSON object');
  index += 1;
  const members = [];
  while (true) {
    index = skipWhitespace(text, index);
    if (text[index] === '}') break;
    const keyStart = index;
    const keyEnd = scanJsonString(text, keyStart);
    const keyRaw = text.slice(keyStart, keyEnd);
    const key = JSON.parse(keyRaw);
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ':') throw new Error(`missing JSON colon after ${keyRaw}`);
    const valueStart = skipWhitespace(text, index + 1);
    const valueEnd = scanJsonValue(text, valueStart);
    members.push({ key, keyRaw, valueRaw: text.slice(valueStart, valueEnd) });
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ',') {
      index += 1;
      continue;
    }
    if (text[index] === '}') break;
    throw new Error(`invalid marketplace object delimiter at offset ${index}`);
  }
  return members;
}

function scanArrayElements(arrayText) {
  let index = skipWhitespace(arrayText, 0);
  if (arrayText[index] !== '[') throw new Error('plugins must be a JSON array');
  index += 1;
  const elements = [];
  while (true) {
    index = skipWhitespace(arrayText, index);
    if (arrayText[index] === ']') break;
    const valueStart = index;
    const valueEnd = scanJsonValue(arrayText, valueStart);
    elements.push(arrayText.slice(valueStart, valueEnd));
    index = skipWhitespace(arrayText, valueEnd);
    if (arrayText[index] === ',') {
      index += 1;
      continue;
    }
    if (arrayText[index] === ']') break;
    throw new Error(`invalid plugins array delimiter at offset ${index}`);
  }
  return elements;
}

function transformMarketplaceText(existingText, options = {}) {
  const pluginName = options.pluginName || DEFAULT_PLUGIN_NAME;
  const marketplaceName = options.marketplaceName || 'local-plugins';
  const marketplaceDisplayName = options.marketplaceDisplayName || 'Local Plugins';
  if (typeof existingText !== 'string') {
    return `${JSON.stringify(transformMarketplaceDocument(null, options), null, 2)}\n`;
  }

  const hadBom = existingText.charCodeAt(0) === 0xFEFF;
  const jsonText = stripLeadingBom(existingText);
  const parsed = JSON.parse(jsonText);
  if (!isJsonObject(parsed)) throw new Error('marketplace root must be a JSON object');
  const members = scanObjectMembers(jsonText);
  const outputMembers = members
    .filter((member) => !['name', 'interface', 'plugins'].includes(member.key))
    .map((member) => `  ${member.keyRaw}: ${member.valueRaw}`);
  outputMembers.push(`  "name": ${JSON.stringify(marketplaceName)}`);

  const interfaceMembers = members.filter((member) => member.key === 'interface');
  const interfaceRaw = isJsonObject(parsed.interface) && interfaceMembers.length > 0
    ? interfaceMembers[interfaceMembers.length - 1].valueRaw
    : JSON.stringify({ displayName: marketplaceDisplayName }, null, 2);
  outputMembers.push(`  "interface": ${interfaceRaw}`);

  const pluginMembers = members.filter((member) => member.key === 'plugins');
  const unrelatedRaw = Array.isArray(parsed.plugins) && pluginMembers.length > 0
    ? scanArrayElements(pluginMembers[pluginMembers.length - 1].valueRaw)
      .filter((raw) => {
        const plugin = JSON.parse(raw);
        return !(isJsonObject(plugin) && plugin.name === pluginName);
      })
    : [];
  unrelatedRaw.push(JSON.stringify(canonicalPluginEntry(pluginName), null, 2));
  outputMembers.push(`  "plugins": [\n${unrelatedRaw.map((raw) => `    ${raw}`).join(',\n')}\n  ]`);
  return `${hadBom ? '\uFEFF' : ''}{\n${outputMembers.join(',\n')}\n}\n`;
}

function transformMarketplaceDocument(existing, options = {}) {
  const pluginName = options.pluginName || DEFAULT_PLUGIN_NAME;
  const marketplaceName = options.marketplaceName || 'local-plugins';
  const marketplaceDisplayName = options.marketplaceDisplayName || 'Local Plugins';
  const root = isJsonObject(existing) ? cloneJson(existing) : {};
  const previousPlugins = Array.isArray(root.plugins) ? root.plugins : [];

  root.name = marketplaceName;
  if (!isJsonObject(root.interface)) {
    root.interface = { displayName: marketplaceDisplayName };
  }
  root.plugins = previousPlugins
    .filter((plugin) => !(isJsonObject(plugin) && plugin.name === pluginName));
  root.plugins.push(canonicalPluginEntry(pluginName));
  return root;
}

function invalidJsonBackupPath(marketplacePath) {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${marketplacePath}.bak.${timestamp}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'ENOTSUP'].includes(error && error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function syncParentDirectory(target) {
  syncDirectory(path.dirname(target));
}

function assertNoLinkComponents(directory) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!pathExists(current)) throw new Error(`publish parent component is missing: ${current}`);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`publish parent crosses a symbolic link or junction: ${current}`);
    }
  }
}

function captureParentIdentity(target) {
  const parent = path.dirname(path.resolve(target));
  assertNoLinkComponents(parent);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`publish parent must be a plain directory: ${parent}`);
  }
  return {
    path: parent,
    realPath: fs.realpathSync.native(parent),
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function assertParentIdentity(identity) {
  assertNoLinkComponents(identity.path);
  const stat = fs.lstatSync(identity.path);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || fs.realpathSync.native(identity.path) !== identity.realPath
    || String(stat.dev) !== identity.dev
    || String(stat.ino) !== identity.ino
  ) {
    throw compareAndSwapError(`publish parent identity changed: ${identity.path}`, identity.path);
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function publishJournalPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.tech-persistence-cas-recovery.json`
  );
}

function writeDurableJson(target, value, createOnly = false) {
  if (!createOnly) {
    throw new Error('durable recovery evidence is immutable and cannot be overwritten');
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  syncDirectory(parent);
}

function plainFileHash(target) {
  if (!pathExists(target)) return null;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) return 'unsupported';
  return sha256(fs.readFileSync(target));
}

function readPlainFileSnapshot(target, label, preservedPath = target) {
  let before;
  let raw;
  let after;
  try {
    before = fs.lstatSync(target);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw compareAndSwapError(`${label} is not a plain file: ${target}`, preservedPath);
    }
    raw = fs.readFileSync(target);
    after = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'CODEX_COMPARE_AND_SWAP_CONFLICT') throw error;
    if (error && error.code === 'ENOENT') {
      throw compareAndSwapError(`${label} disappeared during verification: ${target}`, preservedPath);
    }
    throw error;
  }
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || String(before.dev) !== String(after.dev)
    || String(before.ino) !== String(after.ino)
  ) {
    throw compareAndSwapError(`${label} identity changed during verification: ${target}`, preservedPath);
  }
  return {
    identity: { dev: String(after.dev), ino: String(after.ino) },
    raw,
    sha256: sha256(raw),
  };
}

function assertPlainFileContent(target, expectedRaw, expectedSha256, label, preservedPath = target) {
  const snapshot = readPlainFileSnapshot(target, label, preservedPath);
  if (!snapshot.raw.equals(expectedRaw) || snapshot.sha256 !== expectedSha256) {
    throw compareAndSwapError(`${label} raw bytes or SHA256 drifted: ${target}`, preservedPath);
  }
  return snapshot;
}

function comparablePath(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
  );
}

function capturePlainDirectoryIdentity(target, label, preservedPath = target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw compareAndSwapError(`${label} is missing: ${target}`, preservedPath);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw compareAndSwapError(`${label} is not a plain directory: ${target}`, preservedPath);
  }
  return {
    path: path.resolve(target),
    realPath: fs.realpathSync.native(target),
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function assertPlainDirectoryIdentity(identity, label, preservedPath = identity.path) {
  const current = capturePlainDirectoryIdentity(identity.path, label, preservedPath);
  if (
    current.realPath !== identity.realPath
    || current.dev !== identity.dev
    || current.ino !== identity.ino
  ) {
    throw compareAndSwapError(`${label} identity changed: ${identity.path}`, preservedPath);
  }
  return current;
}

function isValidClaimDirectoryName(claimDirectory, target) {
  const targetName = path.basename(target);
  const claimName = path.basename(claimDirectory);
  const prefix = `.${targetName}.`;
  if (!claimName.startsWith(prefix)) return false;
  const suffix = claimName.slice(prefix.length);
  const separator = suffix.lastIndexOf('.');
  if (separator <= 0) return false;
  const label = suffix.slice(0, separator);
  const random = suffix.slice(separator + 1);
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(label)
    && /^[A-Za-z0-9_-]{6,}$/.test(random);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidTemporaryName(temporaryPath, target, ownerPid) {
  const targetName = path.basename(target);
  const pattern = new RegExp(
    `^${escapeRegExp(targetName)}\\.install\\.([1-9][0-9]*)\\.([1-9][0-9]*)\\.([0-9a-f]{8})\\.tmp$`
  );
  const match = pattern.exec(path.basename(temporaryPath));
  return Boolean(match && Number(match[1]) === ownerPid);
}

function validatePublishJournal(journalPath, target, options = {}) {
  const snapshot = readPlainFileSnapshot(
    journalPath,
    'recovery journal',
    journalPath
  );
  const journal = JSON.parse(stripLeadingBom(snapshot.raw.toString('utf8')));
  const resolvedTarget = path.resolve(target);
  const parent = path.dirname(resolvedTarget);
  const pathFields = ['target', 'journalPath', 'claimDirectory', 'previousPath', 'temporaryPath'];
  const hasPathStrings = pathFields.every((field) => (
    typeof journal[field] === 'string' && path.isAbsolute(journal[field])
  ));
  if (!hasPathStrings) {
    throw compareAndSwapError(`recovery journal is invalid and was preserved: ${journalPath}`, journalPath);
  }

  const physicalJournalPath = path.resolve(journalPath);
  const logicalJournalPath = path.resolve(options.logicalJournalPath || journalPath);
  const resolvedPaths = pathFields.map((field) => path.resolve(journal[field]));
  const distinctPaths = new Set(resolvedPaths.map(comparablePath)).size === resolvedPaths.length;
  const claimDirectory = path.resolve(journal.claimDirectory);
  const previousPath = path.resolve(journal.previousPath);
  const temporaryPath = path.resolve(journal.temporaryPath);
  if (
    journal.schemaVersion !== 1
    || journal.kind !== 'tech-persistence-file-cas'
    || comparablePath(journal.target) !== comparablePath(resolvedTarget)
    || comparablePath(journal.journalPath) !== comparablePath(logicalJournalPath)
    || comparablePath(logicalJournalPath) !== comparablePath(publishJournalPath(resolvedTarget))
    || comparablePath(physicalJournalPath) === comparablePath(resolvedTarget)
    || !distinctPaths
    || !/^[0-9a-f]{32}$/.test(journal.token || '')
    || !Number.isSafeInteger(journal.ownerPid)
    || journal.ownerPid <= 0
    || !/^[0-9a-f]{64}$/.test(journal.expectedSha256 || '')
    || !/^[0-9a-f]{64}$/.test(journal.replacementSha256 || '')
    || typeof journal.retainPrevious !== 'boolean'
    || (journal.expectedAbsent !== undefined && journal.expectedAbsent !== true)
    || (
      journal.expectedAbsent === true
      && (
        journal.expectedSha256 !== '0'.repeat(64)
        || journal.stage !== 'published'
        || journal.retainPrevious
        || journal.cleanupComplete !== true
      )
    )
    || (journal.cleanupComplete !== undefined && journal.cleanupComplete !== true)
    || (journal.cleanupComplete === true && journal.stage !== 'published')
    || !pathIsInside(parent, claimDirectory)
    || comparablePath(path.dirname(claimDirectory)) !== comparablePath(parent)
    || !isValidClaimDirectoryName(claimDirectory, resolvedTarget)
    || comparablePath(path.dirname(previousPath)) !== comparablePath(claimDirectory)
    || path.basename(previousPath) !== path.basename(resolvedTarget)
    || comparablePath(path.dirname(temporaryPath)) !== comparablePath(parent)
    || !isValidTemporaryName(temporaryPath, resolvedTarget, journal.ownerPid)
    || !['prepared', 'claimed', 'published'].includes(journal.stage)
  ) {
    throw compareAndSwapError(`recovery journal is invalid and was preserved: ${journalPath}`, journalPath);
  }
  Object.defineProperty(journal, '__fileIdentity', {
    configurable: false,
    enumerable: false,
    value: snapshot.identity,
    writable: false,
  });
  return journal;
}

function assertRecoveryJournalMatches(expectedJournal, expectedIdentity = null) {
  const current = validatePublishJournal(expectedJournal.journalPath, expectedJournal.target);
  if (JSON.stringify(current) !== JSON.stringify(expectedJournal)) {
    throw compareAndSwapError(
      `recovery journal changed during reconciliation: ${expectedJournal.journalPath}`,
      expectedJournal.journalPath
    );
  }
  if (expectedIdentity && !sameFileIdentity(current.__fileIdentity, expectedIdentity)) {
    throw compareAndSwapError(
      `recovery journal identity changed during reconciliation: ${expectedJournal.journalPath}`,
      expectedJournal.journalPath
    );
  }
  return current;
}

function readOptionalPlainSnapshot(target, expectedSha256, label, preservedPath) {
  if (!pathExists(target)) return null;
  const snapshot = readPlainFileSnapshot(target, label, preservedPath);
  if (expectedSha256 !== undefined && snapshot.sha256 !== expectedSha256) {
    throw compareAndSwapError(`${label} drifted: ${target}`, preservedPath);
  }
  return snapshot;
}

function assertExpectedIdentity(snapshot, expectedIdentity, label, target, preservedPath) {
  if (expectedIdentity && (!snapshot || !sameFileIdentity(snapshot.identity, expectedIdentity))) {
    throw compareAndSwapError(`${label} identity changed: ${target}`, preservedPath);
  }
}

function preflightRecoveryArtifacts(journal, options = {}) {
  const parentIdentity = options.parentIdentity || captureParentIdentity(journal.target);
  assertParentIdentity(parentIdentity);
  const currentJournal = assertRecoveryJournalMatches(journal, options.journalIdentity || null);
  const journalIdentity = currentJournal.__fileIdentity;
  const preservedPath = currentJournal.journalPath;

  let targetSnapshot = null;
  if (options.targetSha256 === null) {
    if (pathExists(currentJournal.target)) {
      throw compareAndSwapError(
        `recovery target should be absent: ${currentJournal.target}`,
        preservedPath
      );
    }
  } else {
    targetSnapshot = readOptionalPlainSnapshot(
      currentJournal.target,
      options.targetSha256,
      'recovery target',
      preservedPath
    );
    if (!targetSnapshot) {
      throw compareAndSwapError(`recovery target is missing: ${currentJournal.target}`, preservedPath);
    }
    assertExpectedIdentity(
      targetSnapshot,
      options.targetIdentity,
      'recovery target',
      currentJournal.target,
      preservedPath
    );
  }

  const temporarySnapshot = readOptionalPlainSnapshot(
    currentJournal.temporaryPath,
    currentJournal.replacementSha256,
    'recovery temporary file',
    preservedPath
  );
  if (options.temporaryPresence === 'required' && !temporarySnapshot) {
    throw compareAndSwapError(
      `recovery temporary file is missing: ${currentJournal.temporaryPath}`,
      preservedPath
    );
  }
  if (options.temporaryPresence === 'absent' && temporarySnapshot) {
    throw compareAndSwapError(
      `recovery temporary file unexpectedly exists: ${currentJournal.temporaryPath}`,
      preservedPath
    );
  }
  assertExpectedIdentity(
    temporarySnapshot,
    options.temporaryIdentity,
    'recovery temporary file',
    currentJournal.temporaryPath,
    preservedPath
  );

  let claimIdentity = null;
  let previousSnapshot = null;
  if (pathExists(currentJournal.claimDirectory)) {
    claimIdentity = options.claimIdentity
      ? assertPlainDirectoryIdentity(
        options.claimIdentity,
        'recovery claim directory',
        preservedPath
      )
      : capturePlainDirectoryIdentity(
        currentJournal.claimDirectory,
        'recovery claim directory',
        preservedPath
      );
    const entries = fs.readdirSync(currentJournal.claimDirectory).sort();
    assertPlainDirectoryIdentity(claimIdentity, 'recovery claim directory', preservedPath);
    const previousName = path.basename(currentJournal.previousPath);
    const allowedEmpty = entries.length === 0;
    const allowedPrevious = entries.length === 1 && entries[0] === previousName;
    if (!allowedEmpty && !allowedPrevious) {
      throw compareAndSwapError(
        `recovery claim directory contains unexpected entries: ${currentJournal.claimDirectory}`,
        preservedPath
      );
    }
    previousSnapshot = readOptionalPlainSnapshot(
      currentJournal.previousPath,
      currentJournal.expectedSha256,
      'recovery previous file',
      preservedPath
    );
    if (allowedPrevious !== Boolean(previousSnapshot)) {
      throw compareAndSwapError(
        `recovery claim directory inventory changed: ${currentJournal.claimDirectory}`,
        preservedPath
      );
    }
    assertPlainDirectoryIdentity(claimIdentity, 'recovery claim directory', preservedPath);
  } else if (options.claimIdentity || !options.allowMissingClaimDirectory) {
    throw compareAndSwapError(
      `recovery claim directory is missing: ${currentJournal.claimDirectory}`,
      preservedPath
    );
  }

  if (options.previousPresence === 'required' && !previousSnapshot) {
    throw compareAndSwapError(
      `recovery previous file is missing: ${currentJournal.previousPath}`,
      preservedPath
    );
  }
  if (options.previousPresence === 'absent' && previousSnapshot) {
    throw compareAndSwapError(
      `recovery previous file unexpectedly exists: ${currentJournal.previousPath}`,
      preservedPath
    );
  }
  assertExpectedIdentity(
    previousSnapshot,
    options.previousIdentity,
    'recovery previous file',
    currentJournal.previousPath,
    preservedPath
  );
  assertParentIdentity(parentIdentity);
  return {
    claimIdentity,
    journalIdentity,
    parentIdentity,
    previousSnapshot,
    targetSnapshot,
    temporarySnapshot,
  };
}

function cleanupClaimDirectoryFor(sourcePath, cleanupParent, label, claimToken) {
  return path.join(
    path.resolve(cleanupParent),
    `.${path.basename(sourcePath)}.${label}.${claimToken}`
  );
}

function discoverAndRestoreJournalCleanupClaim(target, parentIdentity) {
  const resolvedTarget = path.resolve(target);
  const cleanupParent = path.dirname(resolvedTarget);
  const journalPath = publishJournalPath(resolvedTarget);
  const prefix = `.${path.basename(journalPath)}.journal-cleanup.`;
  assertParentIdentity(parentIdentity);
  const matches = fs.readdirSync(cleanupParent, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(prefix));
  assertParentIdentity(parentIdentity);
  if (matches.length === 0) return false;
  if (matches.length !== 1) {
    throw compareAndSwapError(
      `ambiguous interrupted journal cleanup claims for ${journalPath}`,
      cleanupParent
    );
  }

  const entry = matches[0];
  const claimToken = entry.name.slice(prefix.length);
  const cleanupDirectory = path.join(cleanupParent, entry.name);
  if (!/^[0-9a-f]{32}$/.test(claimToken)) {
    throw compareAndSwapError(
      `interrupted journal cleanup claim has an invalid token: ${cleanupDirectory}`,
      cleanupDirectory
    );
  }
  let cleanupStat;
  try {
    cleanupStat = fs.lstatSync(cleanupDirectory);
  } catch (error) {
    throw compareAndSwapError(
      `interrupted journal cleanup claim disappeared: ${cleanupDirectory}: ${error.message}`,
      cleanupDirectory
    );
  }
  if (
    cleanupStat.isSymbolicLink()
    || !cleanupStat.isDirectory()
    || (process.platform !== 'win32' && (cleanupStat.mode & 0o777) !== 0o700)
  ) {
    throw compareAndSwapError(
      `interrupted journal cleanup claim is not a plain 0700 directory: ${cleanupDirectory}`,
      cleanupDirectory
    );
  }
  const cleanupIdentity = capturePlainDirectoryIdentity(
    cleanupDirectory,
    'interrupted journal cleanup claim directory',
    cleanupDirectory
  );
  const inventory = fs.readdirSync(cleanupDirectory);
  const expectedName = path.basename(journalPath);
  if (inventory.length !== 1 || inventory[0] !== expectedName) {
    throw compareAndSwapError(
      `interrupted journal cleanup claim inventory drifted: ${cleanupDirectory}`,
      cleanupDirectory
    );
  }
  const claimedPath = path.join(cleanupDirectory, expectedName);
  let claimedJournal;
  let claimedSnapshot;
  try {
    claimedJournal = validatePublishJournal(claimedPath, resolvedTarget, {
      logicalJournalPath: journalPath,
    });
    claimedSnapshot = readPlainFileSnapshot(
      claimedPath,
      'interrupted journal cleanup claim',
      cleanupDirectory
    );
  } catch (error) {
    if (error && error.code === 'CODEX_COMPARE_AND_SWAP_CONFLICT') throw error;
    throw compareAndSwapError(
      `interrupted journal cleanup claim is invalid and was preserved: ${claimedPath}: ${error.message}`,
      cleanupDirectory
    );
  }
  if (
    claimedJournal.token !== claimToken
    || comparablePath(cleanupClaimDirectoryFor(
      journalPath,
      cleanupParent,
      'journal-cleanup',
      claimedJournal.token
    )) !== comparablePath(cleanupDirectory)
    || !sameFileIdentity(claimedJournal.__fileIdentity, claimedSnapshot.identity)
  ) {
    throw compareAndSwapError(
      `interrupted journal cleanup claim identity does not match its journal: ${cleanupDirectory}`,
      cleanupDirectory
    );
  }
  if (isProcessAlive(claimedJournal.ownerPid)) {
    throw compareAndSwapError(
      `another live publisher owns interrupted journal cleanup claim ${cleanupDirectory}`,
      cleanupDirectory
    );
  }
  assertPlainDirectoryIdentity(
    cleanupIdentity,
    'interrupted journal cleanup claim directory',
    cleanupDirectory
  );
  assertParentIdentity(parentIdentity);
  restoreInterruptedCleanupClaim(journalPath, {
    claimToken,
    cleanupParent,
    description: 'interrupted recovery journal cleanup claim',
    expectedSha256: claimedSnapshot.sha256,
    label: 'journal-cleanup',
    parentIdentity,
    validateClaimed(candidatePath, candidateSnapshot) {
      const candidateJournal = validatePublishJournal(candidatePath, resolvedTarget, {
        logicalJournalPath: journalPath,
      });
      if (
        candidateJournal.token !== claimToken
        || !sameFileIdentity(candidateSnapshot.identity, claimedSnapshot.identity)
        || !candidateSnapshot.raw.equals(claimedSnapshot.raw)
      ) {
        throw compareAndSwapError(
          `interrupted recovery journal changed during restore: ${candidatePath}`,
          cleanupDirectory
        );
      }
    },
  });
  return true;
}

function restoreInterruptedCleanupClaim(sourcePath, options = {}) {
  const source = path.resolve(sourcePath);
  const cleanupDirectory = cleanupClaimDirectoryFor(
    source,
    options.cleanupParent,
    options.label,
    options.claimToken
  );
  if (!pathExists(cleanupDirectory)) return false;
  if (options.parentIdentity) assertParentIdentity(options.parentIdentity);
  const cleanupIdentity = capturePlainDirectoryIdentity(
    cleanupDirectory,
    'interrupted cleanup claim directory',
    cleanupDirectory
  );
  const entries = fs.readdirSync(cleanupDirectory);
  if (entries.length === 0) {
    fs.rmdirSync(cleanupDirectory);
    return true;
  }
  if (entries.length !== 1 || entries[0] !== path.basename(source)) {
    throw compareAndSwapError(
      `interrupted cleanup claim inventory drifted: ${cleanupDirectory}`,
      cleanupDirectory
    );
  }
  const claimedPath = path.join(cleanupDirectory, entries[0]);
  const claimed = readPlainFileSnapshot(
    claimedPath,
    options.description || 'interrupted cleanup claim',
    claimedPath
  );
  if (options.expectedSha256 && claimed.sha256 !== options.expectedSha256) {
    throw compareAndSwapError(
      `interrupted cleanup claim SHA256 drifted: ${claimedPath}`,
      claimedPath
    );
  }
  if (typeof options.validateClaimed === 'function') options.validateClaimed(claimedPath, claimed);
  if (!pathExists(source)) {
    try {
      fs.linkSync(claimedPath, source);
    } catch (error) {
      throw compareAndSwapError(
        `could not restore interrupted cleanup claim ${claimedPath}: ${error.message}`,
        claimedPath
      );
    }
  }
  const restored = readPlainFileSnapshot(
    source,
    options.description || 'restored cleanup artifact',
    claimedPath
  );
  if (
    !sameFileIdentity(restored.identity, claimed.identity)
    || (options.expectedSha256 && restored.sha256 !== options.expectedSha256)
  ) {
    throw compareAndSwapError(
      `restored cleanup artifact identity drifted: ${source}`,
      claimedPath
    );
  }
  assertPlainDirectoryIdentity(
    cleanupIdentity,
    'interrupted cleanup claim directory',
    claimedPath
  );
  fs.unlinkSync(claimedPath);
  if (fs.readdirSync(cleanupDirectory).length !== 0) {
    throw compareAndSwapError(
      `interrupted cleanup claim changed during restore: ${cleanupDirectory}`,
      cleanupDirectory
    );
  }
  fs.rmdirSync(cleanupDirectory);
  syncDirectory(path.dirname(source));
  if (options.parentIdentity) assertParentIdentity(options.parentIdentity);
  return true;
}

function restoreInterruptedArtifactClaims(journal, parentIdentity) {
  const cleanupParent = path.dirname(journal.target);
  if (journal.expectedAbsent !== true) {
    restoreInterruptedCleanupClaim(journal.target, {
      claimToken: journal.token,
      cleanupParent,
      description: 'interrupted canonical ownership claim',
      expectedSha256: journal.expectedSha256,
      label: 'canonical-claim',
      parentIdentity,
    });
  }
  restoreInterruptedCleanupClaim(journal.temporaryPath, {
    claimToken: journal.token,
    cleanupParent,
    description: 'interrupted temporary cleanup claim',
    expectedSha256: journal.replacementSha256,
    label: 'temporary-cleanup',
    parentIdentity,
  });
  restoreInterruptedCleanupClaim(journal.previousPath, {
    claimToken: journal.token,
    cleanupParent,
    description: 'interrupted previous cleanup claim',
    expectedSha256: journal.expectedSha256,
    label: 'previous-cleanup',
    parentIdentity,
  });
}
function claimAndRemoveVerifiedFile(sourcePath, options = {}) {
  const source = path.resolve(sourcePath);
  const cleanupParent = path.resolve(options.cleanupParent || path.dirname(source));
  if (options.parentIdentity) assertParentIdentity(options.parentIdentity);
  const claimPrefix = path.join(
    cleanupParent,
    `.${path.basename(source)}.${options.label || 'cleanup'}.`
  );
  let cleanupDirectory;
  if (options.claimToken) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(options.claimToken))) {
      throw new Error('cleanup claim token contains unsupported path characters');
    }
    cleanupDirectory = `${claimPrefix}${options.claimToken}`;
    try {
      fs.mkdirSync(cleanupDirectory, { mode: 0o700 });
    } catch (error) {
      throw compareAndSwapError(
        `cleanup claim destination is already occupied: ${cleanupDirectory}: ${error.message}`,
        cleanupDirectory
      );
    }
  } else {
    cleanupDirectory = fs.mkdtempSync(claimPrefix);
  }
  if (process.platform !== 'win32') fs.chmodSync(cleanupDirectory, 0o700);
  const cleanupIdentity = capturePlainDirectoryIdentity(
    cleanupDirectory,
    'artifact cleanup claim directory',
    cleanupDirectory
  );
  const claimedPath = path.join(cleanupDirectory, path.basename(source));
  try {
    assertPlainDirectoryIdentity(
      cleanupIdentity,
      'artifact cleanup claim directory',
      cleanupDirectory
    );
    if (fs.readdirSync(cleanupDirectory).length !== 0) {
      throw compareAndSwapError(
        `artifact cleanup claim directory is not empty: ${cleanupDirectory}`,
        cleanupDirectory
      );
    }
    fs.renameSync(source, claimedPath);
    if (typeof options.afterClaim === 'function') options.afterClaim(claimedPath);
  } catch (error) {
    if (error && error.code === 'CODEX_COMPARE_AND_SWAP_CONFLICT') throw error;
    throw compareAndSwapError(
      `could not atomically claim cleanup artifact ${source}: ${error.message}`,
      pathExists(claimedPath) ? claimedPath : source
    );
  }

  function validateClaimedArtifact() {
    assertPlainDirectoryIdentity(
      cleanupIdentity,
      'artifact cleanup claim directory',
      claimedPath
    );
    const entries = fs.readdirSync(cleanupDirectory);
    if (entries.length !== 1 || entries[0] !== path.basename(claimedPath)) {
      throw compareAndSwapError(
        `artifact cleanup claim inventory drifted: ${cleanupDirectory}`,
        claimedPath
      );
    }
    const snapshot = readPlainFileSnapshot(
      claimedPath,
      options.description || 'claimed cleanup artifact',
      claimedPath
    );
    if (options.expectedIdentity && !sameFileIdentity(snapshot.identity, options.expectedIdentity)) {
      throw compareAndSwapError(
        `claimed cleanup artifact identity drifted: ${claimedPath}`,
        claimedPath
      );
    }
    if (options.expectedSha256 && snapshot.sha256 !== options.expectedSha256) {
      throw compareAndSwapError(
        `claimed cleanup artifact SHA256 drifted: ${claimedPath}`,
        claimedPath
      );
    }
    if (options.expectedRaw && !snapshot.raw.equals(options.expectedRaw)) {
      throw compareAndSwapError(
        `claimed cleanup artifact raw bytes drifted: ${claimedPath}`,
        claimedPath
      );
    }
    if (typeof options.validateClaimed === 'function') options.validateClaimed(claimedPath, snapshot);
    assertPlainDirectoryIdentity(
      cleanupIdentity,
      'artifact cleanup claim directory',
      claimedPath
    );
    return snapshot;
  }

  try {
    validateClaimedArtifact();
    validateClaimedArtifact();
  } catch (error) {
    if (error && error.code === 'CODEX_COMPARE_AND_SWAP_CONFLICT') throw error;
    throw compareAndSwapError(
      `claimed cleanup artifact validation failed: ${claimedPath}: ${error.message}`,
      claimedPath
    );
  }
  fs.unlinkSync(claimedPath);
  assertPlainDirectoryIdentity(
    cleanupIdentity,
    'artifact cleanup claim directory',
    cleanupDirectory
  );
  if (fs.readdirSync(cleanupDirectory).length !== 0) {
    throw compareAndSwapError(
      `artifact cleanup claim directory changed after unlink: ${cleanupDirectory}`,
      cleanupDirectory
    );
  }
  fs.rmdirSync(cleanupDirectory);
  syncDirectory(path.dirname(source));
  if (path.dirname(source) !== cleanupParent) syncDirectory(cleanupParent);
  if (options.parentIdentity) assertParentIdentity(options.parentIdentity);
  return { claimedPath, removed: true };
}
function cleanupRecoveredPublish(journal, options = {}) {
  const keepPrevious = Boolean(options.keepPrevious);
  const hooks = options.testHooks || {};
  const initialPreviousPresence = options.previousPresence || (keepPrevious ? 'required' : 'optional');
  const common = {
    parentIdentity: options.parentIdentity || captureParentIdentity(journal.target),
    targetSha256: options.targetSha256,
    previousPresence: initialPreviousPresence,
    temporaryPresence: 'optional',
    allowMissingClaimDirectory: Boolean(options.allowMissingClaimDirectory),
  };
  let state = preflightRecoveryArtifacts(journal, common);
  const stable = {
    ...common,
    claimIdentity: state.claimIdentity,
    journalIdentity: state.journalIdentity,
    previousIdentity: state.previousSnapshot && state.previousSnapshot.identity,
    targetIdentity: state.targetSnapshot && state.targetSnapshot.identity,
    temporaryIdentity: state.temporarySnapshot && state.temporarySnapshot.identity,
  };

  if (state.temporarySnapshot) {
    state = preflightRecoveryArtifacts(journal, stable);
    claimAndRemoveVerifiedFile(journal.temporaryPath, {
      afterClaim: hooks.afterTemporaryCleanupClaim,
      claimToken: journal.token,
      cleanupParent: path.dirname(journal.target),
      description: 'recovery temporary file cleanup claim',
      expectedIdentity: state.temporarySnapshot.identity,
      expectedRaw: state.temporarySnapshot.raw,
      expectedSha256: journal.replacementSha256,
      label: 'temporary-cleanup',
      parentIdentity: stable.parentIdentity,
    });
    stable.temporaryPresence = 'absent';
    stable.temporaryIdentity = null;
    if (typeof hooks.afterTemporaryUnlink === 'function') hooks.afterTemporaryUnlink();
  } else {
    stable.temporaryPresence = 'absent';
  }

  state = preflightRecoveryArtifacts(journal, stable);
  if (!keepPrevious && state.previousSnapshot) {
    if (typeof hooks.beforePreviousUnlink === 'function') hooks.beforePreviousUnlink();
    state = preflightRecoveryArtifacts(journal, stable);
    claimAndRemoveVerifiedFile(journal.previousPath, {
      claimToken: journal.token,
      cleanupParent: path.dirname(journal.target),
      description: 'recovery previous file cleanup claim',
      expectedIdentity: state.previousSnapshot.identity,
      expectedRaw: state.previousSnapshot.raw,
      expectedSha256: journal.expectedSha256,
      label: 'previous-cleanup',
      parentIdentity: stable.parentIdentity,
    });
    if (typeof hooks.afterPreviousUnlink === 'function') hooks.afterPreviousUnlink();
    stable.previousPresence = 'absent';
    stable.previousIdentity = null;
  }

  state = preflightRecoveryArtifacts(journal, stable);
  if (!keepPrevious && state.claimIdentity) {
    fs.rmdirSync(journal.claimDirectory);
    if (typeof hooks.afterClaimDirectoryRemove === 'function') hooks.afterClaimDirectoryRemove();
    stable.claimIdentity = null;
    stable.allowMissingClaimDirectory = true;
  }

  state = preflightRecoveryArtifacts(journal, stable);
  if (typeof hooks.beforeJournalUnlink === 'function') hooks.beforeJournalUnlink();
  state = preflightRecoveryArtifacts(journal, stable);
  // Persist every artifact deletion while the recovery journal still exists.
  syncParentDirectory(journal.target);
  state = preflightRecoveryArtifacts(journal, stable);
  claimAndRemoveVerifiedFile(journal.journalPath, {
    claimToken: journal.token,
    cleanupParent: path.dirname(journal.target),
    afterClaim: hooks.afterJournalCleanupClaim,
    description: 'recovery journal cleanup claim',
    expectedIdentity: state.journalIdentity,
    label: 'journal-cleanup',
    parentIdentity: stable.parentIdentity,
    validateClaimed(claimedPath) {
      const claimedJournal = validatePublishJournal(claimedPath, journal.target, {
        logicalJournalPath: journal.journalPath,
      });
      if (JSON.stringify(claimedJournal) !== JSON.stringify(journal)) {
        throw compareAndSwapError(
          `claimed recovery journal content drifted: ${claimedPath}`,
          claimedPath
        );
      }
    },
  });

  let durabilityWarning = null;
  try {
    if (typeof hooks.beforeFinalJournalSync === 'function') hooks.beforeFinalJournalSync();
    syncParentDirectory(journal.target);
  } catch (error) {
    let recoveryMarkerPath = null;
    let recoveryMarkerError = null;
    if (options.committedOutcome) {
      const marker = {
        ...journal,
        stage: 'published',
        cleanupComplete: true,
        updatedAt: new Date().toISOString(),
      };
      try {
        writeDurableJson(marker.journalPath, marker, true);
      } catch (markerError) {
        recoveryMarkerError = markerError.message;
      }
      if (pathExists(marker.journalPath)) {
        try {
          const recoveredMarker = validatePublishJournal(marker.journalPath, marker.target);
          if (JSON.stringify(recoveredMarker) === JSON.stringify(marker)) {
            recoveryMarkerPath = marker.journalPath;
          }
        } catch (markerValidationError) {
          recoveryMarkerError = recoveryMarkerError || markerValidationError.message;
        }
      }
    }
    durabilityWarning = {
      phase: 'post-commit-directory-sync',
      code: error && error.code ? error.code : 'UNKNOWN',
      message: error && error.message ? error.message : String(error),
      recoveryMarkerPath,
      recoveryMarkerError,
    };
  }
  return {
    commitState: options.committedOutcome ? 'committed' : undefined,
    durabilityWarning,
    previousPath: keepPrevious ? journal.previousPath : null,
    state,
  };
}

function inferRecoveryStage(journal, targetHash, previousHash) {
  if (journal.stage !== 'prepared' || journal.cleanupComplete === true) return journal.stage;
  if (
    targetHash === journal.replacementSha256
    && (
      (journal.retainPrevious && previousHash === journal.expectedSha256)
      || (!journal.retainPrevious && [null, journal.expectedSha256].includes(previousHash))
    )
  ) {
    return 'published';
  }
  if (targetHash === null && previousHash === journal.expectedSha256) return 'claimed';
  return 'prepared';
}

function recoveryConflict(journal, targetHash, previousHash, effectiveStage = journal.stage) {
  return compareAndSwapError(
    `interrupted publish contains external drift; stage=${effectiveStage} target=${targetHash || '<absent>'} claim=${previousHash || '<absent>'}`,
    journal.journalPath
  );
}

function reconcilePublishJournal(target, options = {}) {
  const resolvedTarget = path.resolve(target);
  const parentIdentity = options.parentIdentity || captureParentIdentity(resolvedTarget);
  assertParentIdentity(parentIdentity);
  const journalPath = publishJournalPath(resolvedTarget);
  discoverAndRestoreJournalCleanupClaim(resolvedTarget, parentIdentity);
  if (!pathExists(journalPath)) return { recovered: false, previousPath: null };
  let journal;
  try {
    journal = validatePublishJournal(journalPath, resolvedTarget);
  } catch (error) {
    if (error && error.code === 'CODEX_COMPARE_AND_SWAP_CONFLICT') throw error;
    throw compareAndSwapError(
      `recovery journal cannot be parsed and was preserved: ${journalPath}: ${error.message}`,
      journalPath
    );
  }
  const pairFields = ['expectedSha256', 'replacementSha256', 'retainPrevious'];
  const suppliedPairFields = pairFields.filter((field) => (
    Object.prototype.hasOwnProperty.call(options, field)
  ));
  if (suppliedPairFields.length > 0 && suppliedPairFields.length !== pairFields.length) {
    throw new Error('recovery reconciliation requires a complete expected/replacement/retention pair');
  }
  const logicalExpectedSha256 = journal.expectedAbsent === true ? null : journal.expectedSha256;
  const exactPairSupplied = suppliedPairFields.length === pairFields.length
    && options.expectedSha256 === logicalExpectedSha256
    && options.replacementSha256 === journal.replacementSha256
    && Boolean(options.retainPrevious) === journal.retainPrevious;
  if (suppliedPairFields.length === pairFields.length && !exactPairSupplied) {
    throw compareAndSwapError(
      `recovery journal belongs to a different expected/replacement pair: ${journalPath}`,
      journalPath
    );
  }
  const resumableCommittedMarker = journal.cleanupComplete === true && exactPairSupplied;
  if (isProcessAlive(journal.ownerPid) && !resumableCommittedMarker) {
    throw compareAndSwapError(
      `another live publisher owns recovery journal ${journalPath}`,
      journalPath
    );
  }

  restoreInterruptedArtifactClaims(journal, parentIdentity);
  const targetHash = plainFileHash(resolvedTarget);
  const previousHash = plainFileHash(journal.previousPath);
  const effectiveStage = inferRecoveryStage(journal, targetHash, previousHash);
  const previousPresence = effectiveStage === 'prepared'
    ? 'optional'
    : (effectiveStage === 'published' && !journal.retainPrevious ? 'optional' : 'required');
  const allowMissingClaimDirectory = effectiveStage === 'published'
    && !journal.retainPrevious
    && previousHash === null;
  const initial = preflightRecoveryArtifacts(journal, {
    parentIdentity,
    targetSha256: targetHash,
    previousPresence,
    temporaryPresence: 'optional',
    allowMissingClaimDirectory,
  });
  const cleanupBase = {
    parentIdentity,
    testHooks: options.testHooks,
  };

  if (effectiveStage === 'prepared') {
    if (
      targetHash === journal.expectedSha256
      && [null, journal.expectedSha256].includes(previousHash)
    ) {
      cleanupRecoveredPublish(journal, {
        ...cleanupBase,
        targetSha256: journal.expectedSha256,
        previousPresence: 'optional',
      });
      return { recovered: true, outcome: 'restored', previousPath: null };
    }
    if (targetHash === null && previousHash === journal.expectedSha256) {
      if (!restoreClaimedFile(journal.previousPath, resolvedTarget)) {
        throw compareAndSwapError(
          `canonical target changed while restoring prepared publish: ${resolvedTarget}`,
          journal.previousPath
        );
      }
      cleanupRecoveredPublish(journal, {
        ...cleanupBase,
        targetSha256: journal.expectedSha256,
        previousPresence: 'required',
      });
      return { recovered: true, outcome: 'restored', previousPath: null };
    }
    throw recoveryConflict(journal, targetHash, previousHash, effectiveStage);
  }

  if (effectiveStage === 'claimed') {
    if (targetHash === null && previousHash === journal.expectedSha256) {
      preflightRecoveryArtifacts(journal, {
        parentIdentity,
        targetSha256: null,
        previousPresence: 'required',
        temporaryPresence: 'optional',
        claimIdentity: initial.claimIdentity,
        journalIdentity: initial.journalIdentity,
        previousIdentity: initial.previousSnapshot.identity,
        temporaryIdentity: initial.temporarySnapshot && initial.temporarySnapshot.identity,
      });
      if (!restoreClaimedFile(journal.previousPath, resolvedTarget)) {
        throw compareAndSwapError(
          `canonical target changed while restoring interrupted publish: ${resolvedTarget}`,
          journal.previousPath
        );
      }
      if (plainFileHash(resolvedTarget) !== journal.expectedSha256) {
        throw compareAndSwapError(
          `restored canonical bytes do not match the journal expectation: ${resolvedTarget}`,
          journal.previousPath
        );
      }
      cleanupRecoveredPublish(journal, {
        ...cleanupBase,
        targetSha256: journal.expectedSha256,
        previousPresence: 'required',
      });
      return { recovered: true, outcome: 'restored', previousPath: null };
    }
    if (targetHash === journal.expectedSha256 && previousHash === journal.expectedSha256) {
      cleanupRecoveredPublish(journal, {
        ...cleanupBase,
        targetSha256: journal.expectedSha256,
        previousPresence: 'required',
      });
      return { recovered: true, outcome: 'restored', previousPath: null };
    }
    if (targetHash === journal.replacementSha256 && previousHash === journal.expectedSha256) {
      const cleanup = cleanupRecoveredPublish(journal, {
        ...cleanupBase,
        committedOutcome: true,
        keepPrevious: journal.retainPrevious,
        targetSha256: journal.replacementSha256,
        previousPresence: 'required',
      });
      return {
        commitState: 'committed',
        durabilityWarning: cleanup.durabilityWarning,
        recovered: true,
        outcome: 'published',
        previousPath: journal.retainPrevious ? journal.previousPath : null,
      };
    }
    throw recoveryConflict(journal, targetHash, previousHash, effectiveStage);
  }

  if (targetHash !== journal.replacementSha256) {
    throw recoveryConflict(journal, targetHash, previousHash, effectiveStage);
  }
  if (journal.retainPrevious && previousHash !== journal.expectedSha256) {
    throw recoveryConflict(journal, targetHash, previousHash, effectiveStage);
  }
  if (!journal.retainPrevious && ![null, journal.expectedSha256].includes(previousHash)) {
    throw recoveryConflict(journal, targetHash, previousHash, effectiveStage);
  }
  const cleanup = cleanupRecoveredPublish(journal, {
    ...cleanupBase,
    committedOutcome: true,
    keepPrevious: journal.retainPrevious,
    targetSha256: journal.replacementSha256,
    previousPresence: journal.retainPrevious ? 'required' : 'optional',
    allowMissingClaimDirectory: !journal.retainPrevious && previousHash === null,
  });
  return {
    commitState: 'committed',
    durabilityWarning: cleanup.durabilityWarning,
    recovered: true,
    outcome: 'published',
    previousPath: journal.retainPrevious ? journal.previousPath : null,
  };
}
function createStagedFile(target, content, mode, parentIdentity) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${target}.install.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let descriptor;
  try {
    if (parentIdentity) assertParentIdentity(parentIdentity);
    descriptor = fs.openSync(temporary, 'wx', mode || 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { }
    }
    // Never delete an unclaimed path after an error; a concurrent replacement is evidence.
    throw error;
  }
}

function compareAndSwapError(message, preservedPath = null) {
  const suffix = preservedPath ? `; displaced bytes preserved at ${preservedPath}` : '';
  const error = new Error(`file compare-and-swap rejected concurrent state: ${message}${suffix}`);
  error.code = 'CODEX_COMPARE_AND_SWAP_CONFLICT';
  error.preservedPath = preservedPath;
  return error;
}

function readExpectedFile(target, expectation) {
  if (!pathExists(target)) {
    if (expectation.existed) throw compareAndSwapError(`expected file is missing: ${target}`);
    return { mode: 0o600 };
  }
  if (!expectation.existed) throw compareAndSwapError(`expected absence but file exists: ${target}`);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw compareAndSwapError(`target is not a plain file: ${target}`);
  }
  const raw = fs.readFileSync(target);
  if (!raw.equals(expectation.raw) || sha256(raw) !== expectation.sha256) {
    throw compareAndSwapError(`raw bytes or SHA256 changed: ${target}`);
  }
  return { mode: process.platform === 'win32' ? 0o600 : stat.mode & 0o777 };
}

function restoreClaimedFile(previousPath, target) {
  if (pathExists(target)) return false;
  try {
    fs.linkSync(previousPath, target);
    syncParentDirectory(target);
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
}

function inspectOwnedAbsentPublication(
  target,
  temporary,
  contentBuffer,
  replacementSha256,
  temporaryIdentity,
  parentIdentity
) {
  assertParentIdentity(parentIdentity);
  if (!pathExists(target)) return { state: 'absent' };
  try {
    const temporarySnapshot = assertPlainFileContent(
      temporary,
      contentBuffer,
      replacementSha256,
      'staged temporary file during absent publish compensation',
      temporary
    );
    const targetSnapshot = assertPlainFileContent(
      target,
      contentBuffer,
      replacementSha256,
      'published target during absent publish compensation',
      target
    );
    if (
      !sameFileIdentity(temporarySnapshot.identity, temporaryIdentity)
      || !sameFileIdentity(targetSnapshot.identity, temporaryIdentity)
    ) {
      return { state: 'unknown' };
    }
    assertParentIdentity(parentIdentity);
    return { state: 'owned', targetIdentity: targetSnapshot.identity };
  } catch {
    return { state: 'unknown' };
  }
}

function createAbsentCommitMarker(options) {
  const parent = path.dirname(options.target);
  const targetName = path.basename(options.target);
  const claimDirectory = path.join(
    parent,
    `.${targetName}.absent.${crypto.randomBytes(3).toString('hex')}`
  );
  const timestamp = new Date().toISOString();
  const marker = {
    schemaVersion: 1,
    kind: 'tech-persistence-file-cas',
    token: crypto.randomBytes(16).toString('hex'),
    ownerPid: process.pid,
    createdAt: timestamp,
    updatedAt: timestamp,
    stage: 'published',
    target: options.target,
    journalPath: publishJournalPath(options.target),
    claimDirectory,
    previousPath: path.join(claimDirectory, targetName),
    temporaryPath: options.temporary,
    expectedAbsent: true,
    expectedSha256: '0'.repeat(64),
    replacementSha256: options.replacementSha256,
    retainPrevious: false,
    cleanupComplete: true,
  };
  let markerError = null;
  try {
    writeDurableJson(marker.journalPath, marker, true);
  } catch (error) {
    markerError = error.message;
  }
  let recoveryMarkerPath = null;
  if (pathExists(marker.journalPath)) {
    try {
      const validated = validatePublishJournal(marker.journalPath, marker.target);
      if (JSON.stringify(validated) === JSON.stringify(marker)) {
        recoveryMarkerPath = marker.journalPath;
      }
    } catch (error) {
      markerError = markerError || error.message;
    }
  }
  return { markerError, recoveryMarkerPath };
}
function absentPublishUnknownError(syncError, compensation, target) {
  const error = new Error(
    `absent-target publish commit state is unknown after durability failure: ${syncError.message}`
  );
  error.code = 'CODEX_PUBLISH_COMMIT_STATE_UNKNOWN';
  error.commitState = 'unknown';
  error.retryable = false;
  error.preservedPath = pathExists(target) ? target : null;
  error.durabilityWarning = {
    phase: 'absent-publish-directory-sync',
    code: syncError && syncError.code ? syncError.code : 'UNKNOWN',
    message: syncError && syncError.message ? syncError.message : String(syncError),
    rollbackError: compensation.rollbackError || null,
  };
  return error;
}
function publishTextCompareAndSwap(target, content, expectation, options = {}) {
  const resolvedTarget = path.resolve(target);
  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true, mode: 0o700 });
  const parentIdentity = captureParentIdentity(resolvedTarget);
  const normalized = normalizeExpectation(expectation);
  const contentBuffer = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content), 'utf8');
  const replacementSha256 = sha256(contentBuffer);
  const recovery = reconcilePublishJournal(resolvedTarget, {
    expectedSha256: normalized.sha256,
    parentIdentity,
    replacementSha256,
    retainPrevious: Boolean(options.retainPrevious),
    testHooks: options.testHooks,
  });
  if (recovery.outcome === 'published') {
    return {
      commitState: 'committed',
      durabilityWarning: recovery.durabilityWarning,
      previousPath: recovery.previousPath,
      recovered: true,
    };
  }

  assertParentIdentity(parentIdentity);
  const checked = readExpectedFile(resolvedTarget, normalized);
  const temporary = createStagedFile(
    resolvedTarget,
    contentBuffer,
    normalized.posixMode || checked.mode || 0o600,
    parentIdentity
  );
  const temporaryIdentity = assertPlainFileContent(
    temporary,
    contentBuffer,
    replacementSha256,
    'staged temporary file',
    temporary
  ).identity;
  const hooks = options.testHooks || {};
  let claimDirectory = null;
  let claimIdentity = null;
  let previousPath = null;
  let journal = null;
  let published = false;
  let replacementLinked = false;
  let retainClaim = false;
  try {
    if (typeof hooks.beforeClaim === 'function') hooks.beforeClaim();
    assertParentIdentity(parentIdentity);
    readExpectedFile(resolvedTarget, normalized);
    if (!normalized.existed) {
      if (typeof hooks.beforePublish === 'function') hooks.beforePublish();
      assertParentIdentity(parentIdentity);
      readExpectedFile(resolvedTarget, normalized);
      try {
        assertParentIdentity(parentIdentity);
        fs.linkSync(temporary, resolvedTarget);
        replacementLinked = true;
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          throw compareAndSwapError(`another writer created ${resolvedTarget} before publish`);
        }
        throw error;
      }
      if (typeof hooks.afterPublish === 'function') hooks.afterPublish();
      assertParentIdentity(parentIdentity);
      try {
        if (typeof hooks.beforePublishSync === 'function') hooks.beforePublishSync();
        syncParentDirectory(resolvedTarget);
      } catch (syncError) {
        const inspect = () => inspectOwnedAbsentPublication(
          resolvedTarget,
          temporary,
          contentBuffer,
          replacementSha256,
          temporaryIdentity,
          parentIdentity
        );
        const first = inspect();
        const second = inspect();
        if (
          first.state === 'owned'
          && second.state === 'owned'
          && sameFileIdentity(first.targetIdentity, second.targetIdentity)
        ) {
          const marker = createAbsentCommitMarker({
            replacementSha256,
            target: resolvedTarget,
            temporary,
          });
          published = true;
          return {
            commitState: 'committed',
            durabilityWarning: {
              phase: 'absent-publish-directory-sync',
              code: syncError && syncError.code ? syncError.code : 'UNKNOWN',
              message: syncError && syncError.message ? syncError.message : String(syncError),
              recoveryMarkerError: marker.markerError,
              recoveryMarkerPath: marker.recoveryMarkerPath,
            },
            previousPath: null,
          };
        }
        throw absentPublishUnknownError(
          syncError,
          { rollbackError: 'published target ownership could not be confirmed twice' },
          resolvedTarget
        );
      }
      assertParentIdentity(parentIdentity);
      assertPlainFileContent(
        resolvedTarget,
        contentBuffer,
        replacementSha256,
        'published target',
        resolvedTarget
      );
      published = true;
      return { commitState: 'committed', previousPath: null };
    }

    const label = options.previousLabel || 'cas';
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(label)) {
      throw new Error(`invalid compare-and-swap previous label: ${label}`);
    }
    assertParentIdentity(parentIdentity);
    claimDirectory = fs.mkdtempSync(
      path.join(path.dirname(resolvedTarget), `.${path.basename(resolvedTarget)}.${label}.`)
    );
    if (process.platform !== 'win32') fs.chmodSync(claimDirectory, 0o700);
    claimIdentity = capturePlainDirectoryIdentity(
      claimDirectory,
      'compare-and-swap claim directory',
      claimDirectory
    );
    previousPath = path.join(claimDirectory, path.basename(resolvedTarget));
    journal = {
      schemaVersion: 1,
      kind: 'tech-persistence-file-cas',
      token: crypto.randomBytes(16).toString('hex'),
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stage: 'prepared',
      target: resolvedTarget,
      journalPath: publishJournalPath(resolvedTarget),
      claimDirectory,
      previousPath,
      temporaryPath: temporary,
      expectedSha256: normalized.sha256,
      replacementSha256,
      retainPrevious: Boolean(options.retainPrevious),
    };
    assertParentIdentity(parentIdentity);
    writeDurableJson(journal.journalPath, journal, true);
    journal = validatePublishJournal(journal.journalPath, resolvedTarget);
    if (typeof hooks.afterJournalPrepared === 'function') hooks.afterJournalPrepared();
    try {
      assertParentIdentity(parentIdentity);
      assertRecoveryJournalMatches(journal, journal.__fileIdentity);
      readExpectedFile(resolvedTarget, normalized);
      assertPlainDirectoryIdentity(claimIdentity, 'compare-and-swap claim directory', claimDirectory);
      assertParentIdentity(parentIdentity);
      fs.linkSync(resolvedTarget, previousPath);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        retainClaim = true;
        throw compareAndSwapError(
          `another writer occupied no-clobber previous path ${previousPath}`,
          previousPath
        );
      }
      if (error && error.code === 'ENOENT') {
        throw compareAndSwapError(`another writer removed ${resolvedTarget} before claim`);
      }
      throw error;
    }
    const linkedPrevious = assertPlainFileContent(
      previousPath,
      normalized.raw,
      normalized.sha256,
      'no-clobber linked previous',
      previousPath
    );
    const canonicalBeforeClaim = assertPlainFileContent(
      resolvedTarget,
      normalized.raw,
      normalized.sha256,
      'canonical target before atomic claim',
      previousPath
    );
    if (!sameFileIdentity(linkedPrevious.identity, canonicalBeforeClaim.identity)) {
      retainClaim = true;
      throw compareAndSwapError(
        'canonical target changed after the no-clobber previous link',
        previousPath
      );
    }
    if (typeof hooks.beforeCanonicalClaim === 'function') hooks.beforeCanonicalClaim();
    assertRecoveryJournalMatches(journal, journal.__fileIdentity);
    claimAndRemoveVerifiedFile(resolvedTarget, {
      claimToken: journal.token,
      cleanupParent: path.dirname(resolvedTarget),
      description: 'canonical target ownership claim',
      expectedIdentity: canonicalBeforeClaim.identity,
      expectedRaw: normalized.raw,
      expectedSha256: normalized.sha256,
      label: 'canonical-claim',
      parentIdentity,
    });
    syncDirectory(claimDirectory);
    syncParentDirectory(resolvedTarget);
    assertRecoveryJournalMatches(journal, journal.__fileIdentity);

    const previousStat = fs.lstatSync(previousPath);
    const claimedRaw = previousStat.isFile() && !previousStat.isSymbolicLink()
      ? fs.readFileSync(previousPath)
      : null;
    if (!claimedRaw || !claimedRaw.equals(normalized.raw) || sha256(claimedRaw) !== normalized.sha256) {
      retainClaim = true;
      restoreClaimedFile(previousPath, resolvedTarget);
      throw compareAndSwapError('the claimed bytes differ from the manifest expectation', previousPath);
    }

    if (typeof hooks.beforePublish === 'function') hooks.beforePublish();
    assertParentIdentity(parentIdentity);
    assertRecoveryJournalMatches(journal, journal.__fileIdentity);
    try {
      assertParentIdentity(parentIdentity);
      fs.linkSync(temporary, resolvedTarget);
      replacementLinked = true;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        retainClaim = true;
        throw compareAndSwapError(
          `another writer created ${resolvedTarget} after the expected bytes were claimed`,
          previousPath
        );
      }
      throw error;
    }
    if (typeof hooks.afterPublish === 'function') hooks.afterPublish();
    assertParentIdentity(parentIdentity);
    syncParentDirectory(resolvedTarget);
    try {
      assertParentIdentity(parentIdentity);
      assertPlainFileContent(
        resolvedTarget,
        contentBuffer,
        replacementSha256,
        'published target',
        previousPath
      );
      assertPlainFileContent(
        previousPath,
        normalized.raw,
        normalized.sha256,
        'claimed previous',
        previousPath
      );
    } catch (error) {
      retainClaim = true;
      throw error;
    }
    assertRecoveryJournalMatches(journal, journal.__fileIdentity);

    retainClaim = true;
    const cleanup = cleanupRecoveredPublish(journal, {
      committedOutcome: true,
      keepPrevious: Boolean(options.retainPrevious),
      parentIdentity,
      previousPresence: 'required',
      targetSha256: replacementSha256,
      testHooks: hooks,
    });
    published = true;
    if (options.retainPrevious) {
      return {
        commitState: 'committed',
        durabilityWarning: cleanup.durabilityWarning,
        previousPath: cleanup.previousPath,
      };
    }
    retainClaim = false;
    claimDirectory = null;
    claimIdentity = null;
    previousPath = null;
    return {
      commitState: 'committed',
      durabilityWarning: cleanup.durabilityWarning,
      previousPath: null,
    };
  } catch (error) {
    let parentStillOwned = false;
    try {
      assertParentIdentity(parentIdentity);
      parentStillOwned = true;
    } catch (identityError) {
      error.message = `${error.message}; ${identityError.message}`;
    }
    if (parentStillOwned && previousPath && pathExists(previousPath) && !published) {
      retainClaim = true;
      if (!replacementLinked) {
        try {
          restoreClaimedFile(previousPath, resolvedTarget);
        } catch (restoreError) {
          error.message = `${error.message}; failed to restore claimed bytes: ${restoreError.message}`;
        }
      }
      if (!error.preservedPath) {
        error.preservedPath = previousPath;
        error.message = `${error.message}; claimed bytes preserved at ${previousPath}`;
      }
    }
    if (
      parentStillOwned
      && !replacementLinked
      && !retainClaim
      && journal
      && pathExists(journal.journalPath)
      && pathExists(resolvedTarget)
      && plainFileHash(resolvedTarget) === normalized.sha256
      && !pathExists(previousPath)
    ) {
      try {
        cleanupRecoveredPublish(journal, {
          parentIdentity,
          previousPresence: 'absent',
          targetSha256: normalized.sha256,
        });
        claimDirectory = null;
        claimIdentity = null;
        previousPath = null;
      } catch (cleanupError) {
        retainClaim = true;
        error.message = `${error.message}; recovery evidence cleanup failed: ${cleanupError.message}`;
      }
    }
    throw error;
  } finally {
    let parentStillOwned = false;
    try {
      assertParentIdentity(parentIdentity);
      parentStillOwned = true;
    } catch { }
    if (parentStillOwned && pathExists(temporary)) {
      try {
        const finalTemporary = readPlainFileSnapshot(
          temporary,
          'staged temporary file before final cleanup claim',
          temporary
        );
        if (
          sameFileIdentity(finalTemporary.identity, temporaryIdentity)
          && finalTemporary.sha256 === replacementSha256
          && finalTemporary.raw.equals(contentBuffer)
        ) {
          claimAndRemoveVerifiedFile(temporary, {
            claimToken: journal ? journal.token : sha256(`${process.pid}:${temporaryIdentity.dev}:${temporaryIdentity.ino}`).slice(0, 32),
            cleanupParent: path.dirname(resolvedTarget),
            description: 'staged temporary file final cleanup claim',
            expectedIdentity: temporaryIdentity,
            expectedRaw: contentBuffer,
            expectedSha256: replacementSha256,
            label: 'final-temporary-cleanup',
            parentIdentity,
          });
        }
      } catch {
        // Drifted or externally replaced evidence is preserved in its unique cleanup claim.
      }
    }
    if (parentStillOwned && claimDirectory && !retainClaim && pathExists(claimDirectory)) {
      try {
        assertPlainDirectoryIdentity(
          claimIdentity,
          'compare-and-swap claim directory during cleanup',
          claimDirectory
        );
        fs.rmdirSync(claimDirectory);
      } catch {
        // A changed or non-empty claim directory is evidence and must not be removed recursively.
      }
    }
  }
}
function atomicWriteText(target, text, expectation, options = {}) {
  return publishTextCompareAndSwap(target, text, expectation, options);
}

function updateMarketplaceFile(options = {}) {
  if (!options.marketplacePath) throw new Error('marketplacePath is required');
  const marketplacePath = path.resolve(options.marketplacePath);
  if (options.manifestPath && options.expectation) {
    throw new Error('marketplace update accepts either manifestPath or expectation, not both');
  }
  const expectation = options.manifestPath
    ? marketplaceExpectationFromManifest(options.manifestPath, marketplacePath)
    : normalizeExpectation(options.expectation);
  let existingText = expectation.existed ? expectation.raw.toString('utf8') : null;
  let backupPath = null;

  if (expectation.existed) {
    try {
      const existing = JSON.parse(stripLeadingBom(existingText));
      if (!isJsonObject(existing)) throw new Error('marketplace root must be a JSON object');
    } catch {
      backupPath = invalidJsonBackupPath(marketplacePath);
      publishTextCompareAndSwap(
        backupPath,
        expectation.raw,
        marketplaceExpectationFromRaw(null)
      );
      existingText = null;
    }
  }

  const text = transformMarketplaceText(existingText, options);
  const document = JSON.parse(stripLeadingBom(text));
  const publish = publishTextCompareAndSwap(marketplacePath, text, expectation, {
    testHooks: options.testHooks,
  });
  return { marketplacePath, backupPath, document, publish };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--path', '--name', '--display-name', '--plugin-name', '--manifest'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === '--path') options.marketplacePath = value;
    else if (argument === '--name') options.marketplaceName = value;
    else if (argument === '--display-name') options.marketplaceDisplayName = value;
    else if (argument === '--plugin-name') options.pluginName = value;
    else if (argument === '--manifest') options.manifestPath = value;
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const result = updateMarketplaceFile(parseArgs(argv));
  process.stdout.write(`${JSON.stringify({
    marketplacePath: result.marketplacePath,
    backupPath: result.backupPath,
  })}\n`);
  return 0;
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
  atomicWriteText,
  canonicalPluginEntry,
  marketplaceExpectationFromManifest,
  marketplaceExpectationFromRaw,
  reconcilePublishJournal,
  publishTextCompareAndSwap,
  stripLeadingBom,
  transformMarketplaceDocument,
  transformMarketplaceText,
  updateMarketplaceFile,
};
