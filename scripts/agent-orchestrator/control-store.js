'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTROL_STORE_SCHEMA_VERSION = 'agent-loop-control-store-v2';
const CONTROL_LOCATOR_SCHEMA_VERSION = 'agent-loop-control-locator-v1';
const CONTROL_IDENTITY_SCHEMA_VERSION = 'agent-loop-control-identity-v1';
const CONTROL_BINDING_FILE = 'run-binding.json';
const CONTROL_LOCATORS_DIR = 'locators';
const CONTROL_IDENTITIES_DIR = 'identities';
const DEFAULT_CONTROL_ROOT_SEGMENTS = ['.tech-persistence', 'agent-loop-control'];

function normalizeCanonicalPath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function stableRunLocator(runDir) {
  if (!String(runDir || '').trim()) throw new Error('control store runDir is required');
  // The lookup key must not follow provider-writable junctions. The first
  // authoritative binding records the resolved identity separately and rejects
  // later identity changes at this stable lexical location.
  return normalizeCanonicalPath(path.resolve(String(runDir)));
}

function canonicalRunDir(runDir) {
  if (!String(runDir || '').trim()) throw new Error('control store runDir is required');
  const resolved = path.resolve(String(runDir));
  let canonical;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    canonical = resolved;
  }
  return normalizeCanonicalPath(canonical);
}

function canonicalProviderRoot(providerRoot) {
  if (!String(providerRoot || '').trim()) {
    throw new Error('control store providerRoot must be a non-empty path');
  }
  const resolved = path.resolve(String(providerRoot));
  try {
    return normalizeCanonicalPath(fs.realpathSync.native(resolved));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return normalizeCanonicalPath(resolved);
  }
}

function canonicalPotentialPath(value) {
  const resolved = path.resolve(String(value));
  const missingSegments = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return normalizeCanonicalPath(resolved);
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalAncestor = fs.realpathSync.native(cursor);
  return normalizeCanonicalPath(path.join(canonicalAncestor, ...missingSegments));
}

function controlRunKey(runDir) {
  return crypto.createHash('sha256').update(stableRunLocator(runDir), 'utf8').digest('hex');
}

function canonicalIdentityKey(canonicalRun) {
  return crypto.createHash('sha256').update(canonicalRun, 'utf8').digest('hex');
}

function resolveControlRoot(options = {}) {
  const configured = options.controlRoot === undefined || options.controlRoot === null
    ? path.join(os.homedir(), ...DEFAULT_CONTROL_ROOT_SEGMENTS)
    : String(options.controlRoot);
  if (!configured.trim()) throw new Error('controlRoot must be a non-empty path');
  return canonicalPotentialPath(configured);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertExternalControlRoot(runDir, controlRoot, options = {}) {
  const canonicalRun = canonicalRunDir(runDir);
  if (options.providerRoot !== undefined && options.providerRoot !== null) {
    const providerRoot = canonicalProviderRoot(options.providerRoot);
    if (isWithin(providerRoot, controlRoot) || isWithin(controlRoot, providerRoot)) {
      throw new Error('controlRoot must be outside the provider workspace');
    }
  }
  if (isWithin(canonicalRun, controlRoot) || isWithin(controlRoot, canonicalRun)) {
    throw new Error('controlRoot must be external to the provider-visible runDir');
  }
}

function bindingPath(controlDir) {
  return path.join(controlDir, CONTROL_BINDING_FILE);
}

function expectedLocatorBinding(runDir) {
  const canonicalRun = canonicalRunDir(runDir);
  return {
    schemaVersion: CONTROL_LOCATOR_SCHEMA_VERSION,
    controlKey: controlRunKey(runDir),
    runLocator: stableRunLocator(runDir),
    canonicalRunDirAtCreation: canonicalRun,
    identityKey: canonicalIdentityKey(canonicalRun),
  };
}

function expectedAuthorityBinding(identity) {
  return {
    schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
    controlKey: identity.authorityControlKey,
    runLocator: identity.authorityRunLocator,
    canonicalRunDirAtCreation: identity.canonicalRunDirAtCreation,
  };
}

function assertAuthoritativeControlPath(runDir, candidate, options = {}) {
  const controlRoot = resolveControlRoot(options);
  assertExternalControlRoot(runDir, controlRoot, options);
  const canonicalCandidate = canonicalPotentialPath(candidate);
  if (!isWithin(controlRoot, canonicalCandidate)) {
    throw new Error('authoritative control path escaped the external control root');
  }
  if (options.providerRoot !== undefined && options.providerRoot !== null) {
    const providerRoot = canonicalProviderRoot(options.providerRoot);
    if (isWithin(providerRoot, canonicalCandidate) || isWithin(canonicalCandidate, providerRoot)) {
      throw new Error('authoritative control path must be outside the provider workspace');
    }
  }
  return canonicalCandidate;
}

function validateBinding(actual, expected) {
  if (!actual || actual.schemaVersion !== expected.schemaVersion
      || actual.controlKey !== expected.controlKey
      || actual.runLocator !== expected.runLocator
      || typeof actual.runIdentity !== 'string'
      || !/^[a-f0-9]{32}$/.test(actual.runIdentity)) {
    throw new Error('control store run binding does not match the stable run locator');
  }
  if (actual.canonicalRunDirAtCreation !== expected.canonicalRunDirAtCreation) {
    throw new Error('control store run identity changed after its authoritative binding was created');
  }
  return actual;
}

function validateLocatorBinding(actual, expected) {
  if (!actual || actual.schemaVersion !== expected.schemaVersion
      || actual.controlKey !== expected.controlKey
      || actual.runLocator !== expected.runLocator
      || actual.identityKey !== expected.identityKey
      || actual.canonicalRunDirAtCreation !== expected.canonicalRunDirAtCreation) {
    throw new Error('control store run locator changed its canonical identity');
  }
  return actual;
}

function validateIdentityBinding(actual, expected) {
  if (!actual || actual.schemaVersion !== CONTROL_IDENTITY_SCHEMA_VERSION
      || actual.identityKey !== expected.identityKey
      || actual.canonicalRunDirAtCreation !== expected.canonicalRunDirAtCreation
      || typeof actual.authorityControlKey !== 'string'
      || !/^[a-f0-9]{64}$/.test(actual.authorityControlKey)
      || typeof actual.authorityRunLocator !== 'string'
      || !actual.authorityRunLocator
      || crypto.createHash('sha256')
        .update(actual.authorityRunLocator, 'utf8')
        .digest('hex') !== actual.authorityControlKey) {
    throw new Error('control store canonical run identity binding is invalid');
  }
  return actual;
}

function readAuthoritativeJson(runDir, file, options) {
  assertAuthoritativeControlPath(runDir, file, options);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertAuthoritativeControlPath(runDir, file, options);
  return parsed;
}

function claimAuthoritativeJson(runDir, file, value, options) {
  assertAuthoritativeControlPath(runDir, file, options);
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readAuthoritativeJson(runDir, file, options);
}

function ensureAuthoritativeDirectory(runDir, directory, options) {
  assertAuthoritativeControlPath(runDir, directory, options);
  fs.mkdirSync(directory, { recursive: true });
  assertAuthoritativeControlPath(runDir, directory, options);
  return directory;
}

function locatorPath(controlRoot, controlKey) {
  return path.join(controlRoot, CONTROL_LOCATORS_DIR, `${controlKey}.json`);
}

function identityPath(controlRoot, identityKey) {
  return path.join(controlRoot, CONTROL_IDENTITIES_DIR, `${identityKey}.json`);
}

function controlRunDir(runDir, options = {}) {
  const controlRoot = resolveControlRoot(options);
  assertExternalControlRoot(runDir, controlRoot, options);
  const locatorExpected = expectedLocatorBinding(runDir);
  const locatorFile = locatorPath(controlRoot, locatorExpected.controlKey);
  let locator = locatorExpected;
  if (fs.existsSync(locatorFile)) {
    locator = validateLocatorBinding(
      readAuthoritativeJson(runDir, locatorFile, options),
      locatorExpected
    );
  }
  const identityFile = identityPath(controlRoot, locator.identityKey);
  if (!fs.existsSync(identityFile)) {
    return path.join(controlRoot, 'runs', locator.controlKey);
  }
  const identity = validateIdentityBinding(
    readAuthoritativeJson(runDir, identityFile, options),
    locator
  );
  return path.join(controlRoot, 'runs', identity.authorityControlKey);
}

function ensureControlRunDir(runDir, options = {}) {
  const initialRoot = resolveControlRoot(options);
  assertExternalControlRoot(runDir, initialRoot, options);
  fs.mkdirSync(initialRoot, { recursive: true });
  // Re-resolve after creation so a concurrently created junction/symlink cannot
  // move the authoritative store into the provider-visible workspace.
  const verifiedRoot = resolveControlRoot({ ...options, controlRoot: initialRoot });
  assertExternalControlRoot(runDir, verifiedRoot, options);
  const verifiedOptions = { ...options, controlRoot: verifiedRoot };
  const runsDir = ensureAuthoritativeDirectory(
    runDir,
    path.join(verifiedRoot, 'runs'),
    verifiedOptions
  );
  const locatorsDir = ensureAuthoritativeDirectory(
    runDir,
    path.join(verifiedRoot, CONTROL_LOCATORS_DIR),
    verifiedOptions
  );
  const identitiesDir = ensureAuthoritativeDirectory(
    runDir,
    path.join(verifiedRoot, CONTROL_IDENTITIES_DIR),
    verifiedOptions
  );

  // A locator binding never follows a changed junction target. A separate
  // canonical identity claim makes every alias share the first locator's
  // authoritative control directory and therefore the same locks and Goal.
  const locatorExpected = expectedLocatorBinding(runDir);
  const locatorFile = path.join(locatorsDir, `${locatorExpected.controlKey}.json`);
  const locator = validateLocatorBinding(
    claimAuthoritativeJson(runDir, locatorFile, locatorExpected, verifiedOptions),
    locatorExpected
  );
  const identityCandidate = {
    schemaVersion: CONTROL_IDENTITY_SCHEMA_VERSION,
    identityKey: locator.identityKey,
    canonicalRunDirAtCreation: locator.canonicalRunDirAtCreation,
    authorityControlKey: locator.controlKey,
    authorityRunLocator: locator.runLocator,
  };
  const identityFile = path.join(identitiesDir, `${locator.identityKey}.json`);
  const identity = validateIdentityBinding(
    claimAuthoritativeJson(runDir, identityFile, identityCandidate, verifiedOptions),
    locator
  );
  const authorityLocatorFile = path.join(
    locatorsDir,
    `${identity.authorityControlKey}.json`
  );
  if (!fs.existsSync(authorityLocatorFile)) {
    throw new Error('control store authority locator binding is missing');
  }
  validateLocatorBinding(
    readAuthoritativeJson(runDir, authorityLocatorFile, verifiedOptions),
    {
      schemaVersion: CONTROL_LOCATOR_SCHEMA_VERSION,
      controlKey: identity.authorityControlKey,
      runLocator: identity.authorityRunLocator,
      canonicalRunDirAtCreation: identity.canonicalRunDirAtCreation,
      identityKey: identity.identityKey,
    }
  );

  const controlDir = ensureAuthoritativeDirectory(
    runDir,
    path.join(runsDir, identity.authorityControlKey),
    verifiedOptions
  );
  const expected = expectedAuthorityBinding(identity);
  const file = bindingPath(controlDir);
  if (fs.existsSync(file)) {
    const actual = readAuthoritativeJson(runDir, file, verifiedOptions);
    validateBinding(actual, expected);
    validateLocatorBinding(locator, expectedLocatorBinding(runDir));
    return controlDir;
  }
  const binding = {
    ...expected,
    runIdentity: crypto.randomBytes(16).toString('hex'),
  };
  validateBinding(
    claimAuthoritativeJson(runDir, file, binding, verifiedOptions),
    expected
  );
  validateLocatorBinding(locator, expectedLocatorBinding(runDir));
  return controlDir;
}

module.exports = {
  CONTROL_BINDING_FILE,
  CONTROL_IDENTITY_SCHEMA_VERSION,
  CONTROL_LOCATOR_SCHEMA_VERSION,
  CONTROL_STORE_SCHEMA_VERSION,
  assertAuthoritativeControlPath,
  canonicalPotentialPath,
  canonicalProviderRoot,
  canonicalRunDir,
  canonicalIdentityKey,
  controlRunDir,
  controlRunKey,
  ensureControlRunDir,
  resolveControlRoot,
  stableRunLocator,
};
