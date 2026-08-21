'use strict';

const crypto = require('crypto');
const path = require('path');
const { redactSensitiveText } = require('./redaction');

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_PATH_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
// Exact names cover canonical credential fields. The prefixed-name branch catches
// provider/application qualifiers such as `github_token` and `db_password`
// without treating non-secret metrics such as `token_count` as credentials.
const SENSITIVE_KEY_SUFFIX = '(?:authorization|api_key|apikey|access_token|refresh_token|session_token|auth_token|bearer_token|id_token|token|secret|client_secret|secret_key|secret_access_key|access_key_id|password|passwd|pwd|private_key|credential|credentials|cookie|cookies|set_cookie|connection_string|database_url)';
const SENSITIVE_KEY_PATTERN = new RegExp(`^(?:${SENSITIVE_KEY_SUFFIX}|(?:[a-z0-9]+_)+${SENSITIVE_KEY_SUFFIX})$`);

function normalizeSensitiveKeyName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isSensitiveKey(value) {
  return SENSITIVE_KEY_PATTERN.test(normalizeSensitiveKeyName(value));
}

function assertRedactionStableString(value, label = 'value') {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (redactSensitiveText(value) !== value) {
    throw new Error(`${label} contains sensitive or redacted content`);
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, seen = new Set(), label = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) throw new Error(`${label} must not contain undefined`);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${label} must not contain circular references`);
    seen.add(value);
    const normalized = value.map((entry, index) =>
      canonicalize(entry, seen, `${label}[${index}]`));
    seen.delete(value);
    return normalized;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${label} must contain only JSON-compatible plain objects`);
  }
  if (seen.has(value)) throw new Error(`${label} must not contain circular references`);
  seen.add(value);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(normalized, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: canonicalize(value[key], seen, `${label}.${key}`),
    });
  }
  seen.delete(value);
  return normalized;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function stableHash(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}

const hashObject = stableHash;

function assertExactKeys(value, expected, label = 'object') {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields do not match ${wanted.join(', ')}`);
  }
  return value;
}

function validateIdentifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is an invalid identifier`);
  }
  return value;
}

function validatePathSegment(value, label = 'path segment') {
  if (typeof value !== 'string' || !PATH_SEGMENT_PATTERN.test(value)
      || value === '.' || value === '..' || value.endsWith('.')
      || WINDOWS_RESERVED_PATH_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${label} is an invalid path segment`);
  }
  return value;
}

function validateHash(value, label = 'hash', options = {}) {
  if (options.nullable === true && value === null) return null;
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 hash`);
  }
  return value;
}

function normalizeTimestamp(value, label = 'timestamp') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be an ISO date-time string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a normalized ISO date-time string`);
  }
  return value;
}

function redactCanonicalValue(value, label = 'payload') {
  const normalized = canonicalize(value, new Set(), label);
  function redact(item) {
    if (typeof item === 'string') return redactSensitiveText(item);
    if (Array.isArray(item)) return item.map(redact);
    if (!isPlainObject(item)) {
      if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
      return canonicalize(item, new Set(), label);
    }
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? '[REDACTED]' : redact(child),
    ]));
  }
  return canonicalize(redact(normalized), new Set(), label);
}

function resolveInside(root, ...segments) {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('root path is required');
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`resolved path escapes root: ${candidate}`);
  }
  return candidate;
}

module.exports = {
  HASH_PATTERN,
  IDENTIFIER_PATTERN,
  PATH_SEGMENT_PATTERN,
  WINDOWS_RESERVED_PATH_SEGMENT_PATTERN,
  assertExactKeys,
  assertRedactionStableString,
  canonicalStringify,
  canonicalize,
  hashObject,
  isPlainObject,
  normalizeTimestamp,
  redactCanonicalValue,
  resolveInside,
  stableHash,
  validateHash,
  validateIdentifier,
  validatePathSegment,
};
