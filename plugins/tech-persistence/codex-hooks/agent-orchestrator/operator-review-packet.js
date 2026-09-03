'use strict';

const path = require('path');
const { redactSensitiveText } = require('../lib/redaction');
const {
  MAX_REASON_LENGTH,
  deriveSchedulerHint,
} = require('./scheduler-hint');

const SCHEMA_VERSION = 'operator-review-packet-v1';
const MAX_DECISION_LENGTH = 80;
const MAX_EVIDENCE_REFS = 8;
const MAX_EVIDENCE_REF_LENGTH = 256;
const MAX_NEXT_SAFE_ACTION_LENGTH = 320;
const MAX_SCOPE_REFS = 8;
const MAX_SCOPE_REF_LENGTH = 160;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function boundedPublicText(value, fallback, maxLength) {
  const text = redactSensitiveText(typeof value === 'string' ? value : '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = text || fallback;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function publicReference(value, maxLength) {
  let ref = boundedPublicText(value, '', maxLength);
  if (!ref) return '';

  // Absolute workstation paths are not suitable for a public-safe projection.
  if (/^[A-Za-z]:[\\/]/.test(ref) || /^\\\\/.test(ref)) {
    ref = `[LOCAL_PATH]/${path.win32.basename(ref)}`;
  } else if (/^file:\/\//i.test(ref)) {
    ref = `[LOCAL_PATH]/${path.basename(ref.replace(/^file:\/\//i, ''))}`;
  } else if (/^\/(?:home|root|Users)\//.test(ref)) {
    ref = `[LOCAL_PATH]/${path.posix.basename(ref)}`;
  } else if (/^https?:\/\//i.test(ref)) {
    try {
      const url = new URL(ref);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      ref = url.toString();
    } catch (_error) {
      // The already-redacted bounded text is safer than guessing URL structure.
    }
  }

  return boundedPublicText(ref, '', maxLength);
}

function normalizeReferenceList(value, maximum, maxLength) {
  if (!Array.isArray(value)) return [];
  const refs = value
    .map((item) => {
      if (typeof item === 'string') return publicReference(item, maxLength);
      const record = objectOrEmpty(item);
      return publicReference(
        record.ref || record.hash || record.path || record.id || '',
        maxLength
      );
    })
    .filter(Boolean);
  return [...new Set(refs)].sort().slice(0, maximum);
}

function normalizeFreshness(value) {
  const freshness = objectOrEmpty(value);
  const observedAt = typeof freshness.observedAt === 'string'
    && Number.isFinite(Date.parse(freshness.observedAt))
    ? new Date(freshness.observedAt).toISOString()
    : null;
  return {
    status: boundedPublicText(freshness.status, 'unknown', 64),
    observedAt,
    source: freshness.source
      ? boundedPublicText(freshness.source, 'unknown', 160)
      : null,
    stale: typeof freshness.stale === 'boolean' ? freshness.stale : null,
  };
}

function normalizeBoundary(value) {
  const boundary = objectOrEmpty(value);
  const intent = ['read-only', 'write'].includes(boundary.intent)
    ? boundary.intent
    : 'unknown';
  return {
    intent,
    writeAllowed: boundary.writeAllowed === true,
    requiresApproval: boundary.requiresApproval === undefined
      ? true
      : boundary.requiresApproval === true,
    scopes: normalizeReferenceList(
      boundary.scopes,
      MAX_SCOPE_REFS,
      MAX_SCOPE_REF_LENGTH
    ),
    reason: boundedPublicText(
      boundary.reason,
      'no explicit boundary reason was provided',
      MAX_REASON_LENGTH
    ),
  };
}

function decisionFor(action) {
  if (action === 'run-now') return 'continue';
  if (action === 'stop') return 'stop';
  return 'wait';
}

function nextSafeActionFor(hint) {
  if (hint.action === 'run-now') {
    return 'inspect the first runnable item and pass all existing gates before execution';
  }
  if (hint.action === 'backoff') {
    return 'recheck the bounded evidence or queue source after the scheduler backoff';
  }
  if (hint.action === 'stop') {
    return 'no further action is scheduled for this terminal run';
  }
  return 'inspect the existing gate or blocker and wait for its recorded resolution';
}

function buildOperatorReviewPacket(input = {}) {
  const source = objectOrEmpty(input);
  const schedulerHint = deriveSchedulerHint({
    run: source.run,
    queue: source.queue,
    userGate: source.userGate,
    evidenceWait: source.evidenceWait,
  });

  const layerSource = objectOrEmpty(source.evidenceLayers);
  const evidenceLayers = Object.fromEntries(
    ['local', 'artifact', 'runtime', 'user', 'production'].map((layer) => [
      layer,
      normalizeReferenceList(layerSource[layer], MAX_EVIDENCE_REFS, MAX_EVIDENCE_REF_LENGTH),
    ])
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    // This is a compact operator projection, never an approval or execution grant.
    permission: 'none',
    decision: boundedPublicText(
      source.decision,
      decisionFor(schedulerHint.action),
      MAX_DECISION_LENGTH
    ),
    reason: boundedPublicText(
      source.reason,
      schedulerHint.reason,
      MAX_REASON_LENGTH
    ),
    evidenceRefs: normalizeReferenceList(
      source.evidenceRefs,
      MAX_EVIDENCE_REFS,
      MAX_EVIDENCE_REF_LENGTH
    ),
    evidenceLayers,
    freshness: normalizeFreshness(source.freshness),
    boundary: normalizeBoundary(source.boundary),
    nextSafeAction: boundedPublicText(
      source.nextSafeAction,
      nextSafeActionFor(schedulerHint),
      MAX_NEXT_SAFE_ACTION_LENGTH
    ),
    schedulerHint,
  };
}

module.exports = {
  MAX_EVIDENCE_REFS,
  MAX_EVIDENCE_REF_LENGTH,
  MAX_NEXT_SAFE_ACTION_LENGTH,
  MAX_REASON_LENGTH,
  SCHEMA_VERSION,
  buildOperatorReviewPacket,
};
