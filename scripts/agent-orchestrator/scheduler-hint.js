'use strict';

const { redactSensitiveText } = require('../lib/redaction');
const { stableHash } = require('./runtime-capabilities');

const SCHEMA_VERSION = 'scheduler-hint-v1';
const MAX_REASON_LENGTH = 240;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_EVIDENCE_BACKOFF_MS = 300_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 86_400_000;

const TERMINAL_RUN_STATUSES = new Set([
  'abandoned',
  'completed',
  'dry-run',
]);

const BLOCKED_RUN_STATUSES = new Set([
  'blocked',
  'contract-conflict',
  'preflight-failed',
  'spec-ready',
]);

const RUNNABLE_RUN_STATUSES = new Set([
  'draft',
  'frozen',
  'global-contract-frozen',
  'global-contract-ready',
  'implemented',
  'integration-ready',
  'needs-followup',
  'planning-slices',
  'preflight-ready',
]);

const INACTIVE_CONDITION_STATUSES = new Set([
  'approved',
  'cancelled',
  'cleared',
  'closed',
  'complete',
  'completed',
  'disabled',
  'done',
  'resolved',
]);

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function boundedPublicText(value, fallback, maxLength = MAX_REASON_LENGTH) {
  const text = redactSensitiveText(typeof value === 'string' ? value : '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = text || fallback;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function statusOf(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function queueItems(queue, key) {
  return Array.isArray(queue[key]) ? queue[key] : [];
}

function itemIdentity(item) {
  if (typeof item === 'string') return boundedPublicText(item, 'unknown', 128);
  const value = objectOrEmpty(item);
  const ref = value.sliceId || value.ref || value.id || value.taskId || 'unknown';
  const status = value.status ? `:${statusOf(value.status)}` : '';
  return `${boundedPublicText(String(ref), 'unknown', 96)}${status}`;
}

function queueIdentity(queue) {
  return Object.fromEntries([
    'pending',
    'ready',
    'running',
    'completed',
    'blocked',
    'rejected',
    'abandoned',
  ].map((key) => [key, queueItems(queue, key).map(itemIdentity).sort()]));
}

function isActiveCondition(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.active === false || value.resolved === true) return false;
  if (value.active === true) return true;
  const status = statusOf(value.status);
  if (INACTIVE_CONDITION_STATUSES.has(status)) return false;
  return Boolean(status || value.reason || value.ref || value.id);
}

function retryAfterMs(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(MIN_RETRY_AFTER_MS, Math.round(value))
  );
}

function resetToken(identity) {
  return `reset:${stableHash(identity).slice('sha256:'.length)}`;
}

function hint(action, reason, identity, retryMs) {
  const result = {
    schemaVersion: SCHEMA_VERSION,
    // A scheduler hint controls cadence only. Existing gates remain authoritative.
    permission: 'none',
    action,
    reason: boundedPublicText(reason, 'scheduler state is unknown'),
  };
  if (action === 'backoff') result.retryAfterMs = retryMs;
  if (action !== 'stop') {
    result.resetToken = resetToken({
      schemaVersion: SCHEMA_VERSION,
      action,
      reason: result.reason,
      ...identity,
    });
  }
  return result;
}

function deriveSchedulerHint(input = {}) {
  const source = objectOrEmpty(input);
  const run = objectOrEmpty(source.run);
  const queue = objectOrEmpty(source.queue);
  const userGate = objectOrEmpty(source.userGate);
  const evidenceWait = objectOrEmpty(source.evidenceWait);
  const runStatus = statusOf(run.status) || 'unknown';
  const queues = queueIdentity(queue);
  const identity = {
    runStatus,
    runRef: boundedPublicText(String(run.runId || run.ref || 'unknown'), 'unknown', 128),
    queues,
  };

  if (TERMINAL_RUN_STATUSES.has(runStatus)) {
    return hint(
      'stop',
      `run is terminal (${runStatus})`,
      identity
    );
  }

  if (isActiveCondition(source.userGate)) {
    const gateReason = boundedPublicText(
      userGate.reason,
      userGate.status ? `user gate is ${statusOf(userGate.status)}` : 'user decision is required'
    );
    return hint('wait', `waiting for user gate: ${gateReason}`, {
      ...identity,
      userGate: {
        status: statusOf(userGate.status) || 'active',
        ref: boundedPublicText(String(userGate.ref || userGate.id || 'unknown'), 'unknown', 128),
      },
    });
  }

  if (isActiveCondition(source.evidenceWait)) {
    const waitReason = boundedPublicText(
      evidenceWait.reason,
      evidenceWait.status
        ? `evidence wait is ${statusOf(evidenceWait.status)}`
        : 'fresh evidence is not available'
    );
    return hint(
      'backoff',
      `waiting for evidence: ${waitReason}`,
      {
        ...identity,
        evidenceWait: {
          status: statusOf(evidenceWait.status) || 'active',
          ref: boundedPublicText(
            String(evidenceWait.ref || evidenceWait.id || 'unknown'),
            'unknown',
            128
          ),
        },
      },
      retryAfterMs(evidenceWait.retryAfterMs, DEFAULT_EVIDENCE_BACKOFF_MS)
    );
  }

  if (queues.running.length > 0) {
    return hint('run-now', 'queue has running work to resume', identity);
  }
  if (queues.ready.length > 0) {
    return hint('run-now', 'queue has ready work', identity);
  }

  if (queues.blocked.length > 0) {
    return hint('wait', 'queue has blocked work and no runnable item', identity);
  }
  if (queues.pending.length > 0) {
    return hint('wait', 'queue has pending work with unmet dependencies', identity);
  }

  if (BLOCKED_RUN_STATUSES.has(runStatus)) {
    const reason = runStatus === 'spec-ready'
      ? 'run is waiting at an existing gate (spec-ready)'
      : `run is blocked (${runStatus})`;
    return hint('wait', reason, identity);
  }

  if (RUNNABLE_RUN_STATUSES.has(runStatus)) {
    return hint('run-now', `run state can advance (${runStatus})`, identity);
  }

  return hint(
    'backoff',
    `no runnable work is visible for active run (${runStatus})`,
    identity,
    DEFAULT_BACKOFF_MS
  );
}

module.exports = {
  DEFAULT_BACKOFF_MS,
  DEFAULT_EVIDENCE_BACKOFF_MS,
  MAX_REASON_LENGTH,
  SCHEMA_VERSION,
  deriveSchedulerHint,
};
