'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POINTER_VERSION = 1;
const POINTER_RELATIVE_PATH = 'docs/plans/.handoff/active-sprint.json';
const LOCK_RELATIVE_PATH = 'docs/plans/.handoff/active-sprint.lock';
const TRANSACTION_RELATIVE_PATH = 'docs/plans/.handoff/active-sprint.transaction.json';
const COMPLETION_RELATIVE_PATH = 'docs/plans/.handoff/active-sprint.completed.json';
const MIGRATION_RECEIPT_DIRECTORY_RELATIVE_PATH = 'docs/plans/.handoff';
const MIGRATION_RECEIPT_FILE_PREFIX = 'active-sprint.migration-receipt-';
const TRANSACTION_RELEASE_RELATIVE_PATH = `${TRANSACTION_RELATIVE_PATH}.release.tmp`;
const MAX_RECOVERY_BYTES = 32 * 1024;
// A v4 WAL embeds canonical receipt JSON as a JSON string; reserve bounded
// escaping overhead in addition to the receipt's own evidence budget.
const MAX_TRANSACTION_BYTES = MAX_RECOVERY_BYTES + (3 * 256 * 1024);
const POINTER_KEYS = new Set([
  'version', 'plan', 'phase', 'status', 'updated_at', 'next', 'block_reason',
  'acceptance_protocol', 'migration_receipt_sha256',
]);
const LEGACY_COMPLETION_RECORD_VERSION = 1;
const COMPLETION_RECORD_VERSION = 2;
const LEGACY_TRANSACTION_VERSION = 1;
const PAYLOAD_TRANSACTION_VERSION = 2;
const TRANSACTION_VERSION = 3;
const LINEAGE_TRANSACTION_VERSION = 4;
const SUPERSESSION_TRANSACTION_VERSION = 5;
const COMPLETION_TRANSACTION_VERSION = 6;
const INIT_COMPLETION_TRANSACTION_VERSION = 7;
const CLAIM_INTENT_VERSION = 1;
const CLAIM_INTENT_FILE = 'intent.json';
const CLAIM_VALUE_FILE = 'value';
const CLAIM_RESTORE_GUARD_FILE = 'restore-guard';
const CLAIM_DELETE_TOMBSTONE_FILE = 'delete-tombstone';
const CLAIM_SLOT_FILES = new Set([
  CLAIM_INTENT_FILE,
  CLAIM_VALUE_FILE,
  CLAIM_RESTORE_GUARD_FILE,
  CLAIM_DELETE_TOMBSTONE_FILE,
]);
const CLAIM_SLOT_PREFIX = 'active-sprint.claim-';
const CLAIM_INTENT_KEYS = new Set([
  'version', 'scope_token', 'artifact', 'source', 'disposition',
  'parent', 'parent_dev', 'parent_ino',
  'expected_dev', 'expected_ino', 'size', 'sha256',
]);
const CLAIM_ARTIFACTS = new Set([
  'lock',
  'pointer',
  'publish',
  'partial',
  'legacy-pointer',
  'legacy-partial',
  'legacy-partial-release',
  'legacy-partial-delete-a',
  'legacy-partial-delete-b',
  'transaction',
  'transaction-release',
  'completion',
  'prior-completion',
  'completion-stage',
  'migration-receipt-stage',
  'migration-receipt-final',
]);
const LEGACY_TRANSACTION_KEYS = new Set([
  'version', 'token', 'operation', 'claim', 'publish', 'expected_sha256',
  'replacement_sha256', 'plan', 'phase', 'started_at',
]);
const TRANSACTION_KEYS = new Set([
  ...LEGACY_TRANSACTION_KEYS,
  'partial',
  'replacement_raw',
]);
const LINEAGE_TRANSACTION_KEYS = new Set([
  ...TRANSACTION_KEYS,
  'migration_receipt',
]);
const COMPLETION_TRANSACTION_KEYS = new Set([
  ...LINEAGE_TRANSACTION_KEYS,
  'completion_plan',
]);
const INIT_COMPLETION_TRANSACTION_KEYS = new Set([
  ...TRANSACTION_KEYS,
  'prior_completion_sha256',
]);
const MAX_STATE_TEXT_CHARS = 500;
const ALLOWED_TRANSITIONS = Object.freeze({
  think: new Set(['plan']),
  plan: new Set(['work']),
  work: new Set(['review']),
  review: new Set(['work', 'compound']),
  compound: new Set(),
});
const MAX_POINTER_BYTES = 16 * 1024;
const MAX_PLAN_BYTES = 512 * 1024;
const MAX_MIGRATION_EVIDENCE_BYTES = 256 * 1024;
const MAX_RECEIPT_PREPARATION_SKEW_MS = 10 * 60 * 1000;
const VALID_PHASES = new Set(['think', 'plan', 'work', 'review', 'compound']);
const ACTIVE_META_KEYS = new Set([
  'status', 'tasks_completed', 'tasks_total', 'task_ids', 'open_task_ids', 'tags',
]);
const MAX_FRONTMATTER_LINES = 64;
const MAX_META_VALUE_CHARS = 500;

function unwrapSimpleScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length > MAX_META_VALUE_CHARS) return null;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    if (/[\\\r\n]/.test(inner)) return null;
    return inner;
  }
  return trimmed;
}

function parseActiveSprintFrontmatter(content) {
  try {
    const lines = String(content || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    if (lines[0] !== '---') return { meta: {} };
    const end = lines.slice(1, MAX_FRONTMATTER_LINES + 1).findIndex((line) => line === '---');
    if (end < 0) return { meta: {} };
    const meta = {};
    for (const line of lines.slice(1, end + 1)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (/^\s/.test(line)) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!match || !ACTIVE_META_KEYS.has(match[1])) continue;
      if (Object.hasOwn(meta, match[1])) return { meta: {} };
      const scalar = unwrapSimpleScalar(match[2]);
      if (scalar === null || /^(?:[|>&*!{])/.test(scalar)) continue;
      if (match[1] === 'status') {
        if (/^[A-Za-z0-9._ -]{1,64}$/.test(scalar)) meta.status = scalar;
      } else if (match[1] === 'tasks_completed' || match[1] === 'tasks_total') {
        if (/^\d{1,9}$/.test(scalar)) meta[match[1]] = scalar;
      } else if (/^\[[A-Za-z0-9._,'" -]{0,480}\]$/.test(scalar)
          || /^[A-Za-z0-9._,'" -]{1,480}$/.test(scalar)) {
        meta[match[1]] = scalar;
      }
    }
    return { meta };
  } catch {
    return { meta: {} };
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePlanPath(cwd, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const plansRoot = path.resolve(cwd, 'docs', 'plans');
  const absolute = path.resolve(cwd, value.trim());
  if (!isInside(plansRoot, absolute)) return null;
  const relativeToPlans = path.relative(plansRoot, absolute);
  if (!relativeToPlans || relativeToPlans.split(path.sep)[0] === '.handoff') return null;
  if (relativeToPlans.length > 900) return null;
  if (path.extname(absolute).toLowerCase() !== '.md') return null;
  return path.relative(cwd, absolute).replace(/\\/g, '/');
}

function parseCount(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function inspectBoundedWorkspaceFile(cwd, filePath, allowedRoot, maximumBytes, kind) {
  let stat;
  try {
    stat = lstatExactSync(filePath);
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === 'ENOENT' ? `missing-${kind}` : `unreadable-${kind}`,
    };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: `unsafe-${kind}-link` };
  if (!stat.isFile()) return { ok: false, reason: `unsafe-${kind}-type` };
  if (statSizeExceeds(stat, maximumBytes)) {
    return { ok: false, reason: `${kind}-too-large` };
  }

  try {
    const workspaceReal = fs.realpathSync(cwd);
    const allowedReal = fs.realpathSync(allowedRoot);
    const fileReal = fs.realpathSync(filePath);
    if (!isInside(workspaceReal, allowedReal) || !isInside(allowedReal, fileReal)) {
      return { ok: false, reason: `outside-${kind}-root` };
    }
    return { ok: true, fileReal, size: statSizeAsNumber(stat) };
  } catch {
    return { ok: false, reason: `unreadable-${kind}` };
  }
}

function validatePointerSchema(cwd, value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('pointer must be an object');
    }
    const keys = Object.keys(value);
    if (keys.some((key) => !POINTER_KEYS.has(key))) throw new Error('pointer has unknown fields');
    for (const key of ['version', 'plan', 'phase', 'status', 'updated_at', 'next']) {
      if (!Object.hasOwn(value, key)) throw new Error(`pointer is missing ${key}`);
    }
    if (value.version !== POINTER_VERSION) throw new Error('pointer version is unsupported');
    const plan = normalizePlanPath(cwd, value.plan);
    if (!plan) throw new Error('pointer plan is invalid');
    const phase = normalizeStatePhase(value.phase, 'pointer phase');
    if (value.status !== 'active' && value.status !== 'blocked') {
      throw new Error('pointer status must be active or blocked');
    }
    const updatedAt = normalizeStateTimestamp(value.updated_at);
    if (updatedAt !== value.updated_at) throw new Error('pointer timestamp must be canonical ISO-8601');
    const next = normalizeStateText(value.next, 'pointer next');
    if (next !== value.next) throw new Error('pointer next must already be normalized');
    let blockReason = '';
    if (value.status === 'blocked') {
      if (!Object.hasOwn(value, 'block_reason')) throw new Error('blocked pointer requires block_reason');
      blockReason = normalizeStateText(value.block_reason, 'pointer block_reason');
      if (blockReason !== value.block_reason) throw new Error('pointer block_reason must already be normalized');
    } else if (Object.hasOwn(value, 'block_reason')) {
      throw new Error('active pointer forbids block_reason');
    }
    const acceptanceProtocol = value.acceptance_protocol === undefined
      ? 'legacy'
      : value.acceptance_protocol;
    if (!['legacy', 'v1'].includes(acceptanceProtocol)) {
      throw new Error('pointer acceptance_protocol must be legacy or v1');
    }
    let migrationReceiptSha256;
    if (value.migration_receipt_sha256 !== undefined) {
      if (typeof value.migration_receipt_sha256 !== 'string'
          || !/^[a-f0-9]{64}$/.test(value.migration_receipt_sha256)) {
        throw new Error('pointer migration_receipt_sha256 must be a lowercase SHA-256 digest');
      }
      migrationReceiptSha256 = value.migration_receipt_sha256;
    }
    return {
      ok: true,
      pointer: {
        version: POINTER_VERSION,
        plan,
        phase,
        status: value.status,
        updated_at: updatedAt,
        next,
        ...(value.acceptance_protocol === undefined
          ? {}
          : { acceptance_protocol: acceptanceProtocol }),
        ...(migrationReceiptSha256
          ? { migration_receipt_sha256: migrationReceiptSha256 }
          : {}),
        ...(value.status === 'blocked' ? { block_reason: blockReason } : {}),
      },
    };
  } catch (error) {
    return { ok: false, reason: 'invalid-pointer-schema', detail: error.message };
  }
}

function readActiveSprintPointer(cwd = process.cwd()) {
  const pointerPath = path.resolve(cwd, POINTER_RELATIVE_PATH);
  const pointerInspection = inspectBoundedWorkspaceFile(
    cwd,
    pointerPath,
    path.dirname(pointerPath),
    MAX_POINTER_BYTES,
    'pointer'
  );
  if (!pointerInspection.ok) {
    return { active: false, reason: pointerInspection.reason, pointerPath };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  } catch {
    return { active: false, reason: 'invalid-pointer-json', pointerPath };
  }
  const validated = validatePointerSchema(cwd, parsed);
  if (!validated.ok) {
    return { active: false, reason: validated.reason, detail: validated.detail, pointerPath };
  }
  const pointer = validated.pointer;
  return {
    active: true,
    pointerPath,
    plan: pointer.plan,
    phase: pointer.phase,
    status: pointer.status,
    blockReason: pointer.block_reason || '',
    updatedAt: pointer.updated_at,
    next: pointer.next,
    acceptanceProtocol: pointer.acceptance_protocol || 'legacy',
    migrationReceiptSha256: pointer.migration_receipt_sha256 || '',
  };
}
function readPrivateClaimRecoveryStatus(cwd, stateDirectory, pointerPath) {
  let stateStat;
  try {
    stateStat = lstatExactSync(stateDirectory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return {
      active: false,
      reason: 'sprint-recovery-required',
      pointerPath,
      detail: 'unreadable-claim-parent',
    };
  }
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    return {
      active: false,
      reason: 'sprint-recovery-required',
      pointerPath,
      detail: 'unsafe-claim-parent',
    };
  }
  let entries;
  try {
    entries = fs.readdirSync(stateDirectory);
  } catch {
    return {
      active: false,
      reason: 'sprint-recovery-required',
      pointerPath,
      detail: 'unreadable-claim-parent',
    };
  }
  const claimName = entries.find((entry) => entry.startsWith(CLAIM_SLOT_PREFIX));
  if (!claimName) return null;
  const claimPath = path.join(stateDirectory, claimName);
  let detail = 'private-claim-pending';
  try {
    const claimStat = lstatExactSync(claimPath);
    const exactPrivateSlot = /^active-sprint\.claim-[a-f0-9]{32}-[a-z0-9-]+$/.test(claimName);
    if (!exactPrivateSlot || claimStat.isSymbolicLink() || !claimStat.isDirectory()) {
      detail = 'unsafe-or-legacy-claim-pending';
    }
  } catch {
    detail = 'unreadable-claim-pending';
  }
  return {
    active: false,
    reason: 'sprint-recovery-required',
    pointerPath,
    claimPath,
    detail,
  };
}
function readSprintRecoveryStatus(cwd, pointerPath, { includeCompletion = true } = {}) {
  const stateDirectory = path.resolve(cwd, 'docs', 'plans', '.handoff');
  const transactionPath = path.resolve(cwd, TRANSACTION_RELATIVE_PATH);
  const transactionReleasePath = path.resolve(cwd, TRANSACTION_RELEASE_RELATIVE_PATH);
  const completionPath = path.resolve(cwd, COMPLETION_RELATIVE_PATH);
  const transactionInspection = inspectBoundedWorkspaceFile(
    cwd,
    transactionPath,
    stateDirectory,
    MAX_TRANSACTION_BYTES,
    'recovery'
  );
  if (transactionInspection.ok) {
    return {
      active: false,
      reason: 'sprint-recovery-required',
      pointerPath,
      transactionPath,
    };
  }
  if (transactionInspection.reason !== 'missing-recovery') {
    return {
      active: false,
      reason: 'sprint-recovery-required',
      pointerPath,
      transactionPath,
      detail: transactionInspection.reason,
    };
  }
  const releaseInspection = inspectBoundedWorkspaceFile(
    cwd,
    transactionReleasePath,
    stateDirectory,
    MAX_TRANSACTION_BYTES,
    'recovery-release'
  );
  if (releaseInspection.ok || releaseInspection.reason !== 'missing-recovery-release') {
    return {
      active: false,
      reason: 'sprint-recovery-required',
      pointerPath,
      transactionReleasePath,
      detail: releaseInspection.ok ? 'transaction-cleanup-pending' : releaseInspection.reason,
    };
  }
  const claimStatus = readPrivateClaimRecoveryStatus(cwd, stateDirectory, pointerPath);
  if (claimStatus) return claimStatus;
  if (!includeCompletion) return null;

  const completionInspection = inspectBoundedWorkspaceFile(
    cwd,
    completionPath,
    stateDirectory,
    MAX_RECOVERY_BYTES,
    'completion'
  );
  if (!completionInspection.ok) {
    if (completionInspection.reason === 'missing-completion') return null;
    return {
      active: false,
      reason: 'sprint-recovery-required',
      pointerPath,
      completionPath,
      detail: completionInspection.reason,
    };
  }
  try {
    const completionSnapshot = readStableRecoverySnapshot(
      completionPath,
      MAX_RECOVERY_BYTES
    );
    const completion = parseCompletionRecord(
      { workspace: path.resolve(cwd) },
      completionSnapshot.bytes.toString('utf8')
    );
    const value = completion.value;
    return {
      active: false,
      reason: 'completed-sprint',
      pointerPath,
      completionPath,
      plan: value.plan,
      phase: value.phase,
      completedAt: typeof value.completed_at === 'string' ? value.completed_at : '',
      migrationReceiptSha256: value.migration_receipt_sha256 || '',
    };
  } catch (error) {
    return {
      active: false,
      reason: 'sprint-recovery-required',
      pointerPath,
      completionPath,
      detail: error.message,
    };
  }
}
function readActiveSprint(cwd = process.cwd()) {
  const pointerPath = path.resolve(cwd, POINTER_RELATIVE_PATH);
  const transactionStatus = readSprintRecoveryStatus(cwd, pointerPath, {
    includeCompletion: false,
  });
  if (transactionStatus) return transactionStatus;
  const pointer = readActiveSprintPointer(cwd);
  if (!pointer.active) {
    if (pointer.reason === 'missing-pointer') {
      return readSprintRecoveryStatus(cwd, pointer.pointerPath) || pointer;
    }
    return pointer;
  }
  const {
    plan, phase, status, blockReason, updatedAt, next, acceptanceProtocol,
    migrationReceiptSha256,
  } = pointer;

  const absolutePlanPath = path.resolve(cwd, plan);
  const planInspection = inspectBoundedWorkspaceFile(
    cwd,
    absolutePlanPath,
    path.resolve(cwd, 'docs', 'plans'),
    MAX_PLAN_BYTES,
    'plan'
  );
  if (!planInspection.ok) {
    return { active: false, reason: planInspection.reason, pointerPath, plan };
  }

  let parsed;
  try {
    parsed = parseActiveSprintFrontmatter(fs.readFileSync(absolutePlanPath, 'utf8'));
  } catch {
    return { active: false, reason: 'unreadable-plan', pointerPath, plan };
  }
  const meta = parsed.meta || {};
  let migrationReceipt;
  if (migrationReceiptSha256) {
    try {
      migrationReceipt = readMigrationReceipt(cwd, migrationReceiptSha256, { targetPlan: plan });
    } catch (error) {
      return {
        active: false,
        reason: 'invalid-migration-receipt',
        detail: error.message,
        pointerPath,
        plan,
        migrationReceiptSha256,
      };
    }
  }
  if (String(meta.status || '').toLowerCase() === 'completed') {
    return {
      active: false, reason: 'completed-plan', pointerPath, plan,
      phase, status, blockReason, updatedAt, next, meta,
      migrationReceiptSha256,
      migrationReceiptPath: migrationReceipt ? migrationReceipt.path : '',
    };
  }

  return {
    active: true,
    pointerPath,
    absolutePlanPath,
    plan,
    phase,
    status,
    blockReason,
    updatedAt,
    next,
    acceptanceProtocol,
    migrationReceiptSha256,
    migrationReceiptPath: migrationReceipt ? migrationReceipt.path : '',
    meta,
    tasksCompleted: parseCount(meta.tasks_completed),
    tasksTotal: parseCount(meta.tasks_total),
  };
}

function sprintStateError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeStatePhase(value, label) {
  if (typeof value !== 'string' || !VALID_PHASES.has(value)) {
    throw sprintStateError('INVALID_SPRINT_PHASE', `${label} must be one of ${[...VALID_PHASES].join('|')}`);
  }
  return value;
}

function normalizeStateText(value, label) {
  if (typeof value !== 'string') {
    throw sprintStateError('INVALID_SPRINT_TEXT', `${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_STATE_TEXT_CHARS || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw sprintStateError(
      'INVALID_SPRINT_TEXT',
      `${label} must be 1-${MAX_STATE_TEXT_CHARS} printable characters`
    );
  }
  return normalized;
}

function normalizeStateTimestamp(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw sprintStateError('INVALID_SPRINT_TIMESTAMP', 'now must be an ISO-8601 string');
  }
  const canonicalPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const timestamp = canonicalPattern.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw sprintStateError('INVALID_SPRINT_TIMESTAMP', 'now must be an ISO-8601 string');
  }
  return new Date(timestamp).toISOString();
}

function fsyncDirectoryIfSupported(directory) {
  let handle;
  try {
    handle = fs.openSync(directory, 'r');
    fs.fsyncSync(handle);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES', 'EBADF'].includes(error && error.code)) throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function ensureStateDirectory(cwd, { create = true } = {}) {
  const workspace = path.resolve(cwd);
  const plansRoot = path.resolve(workspace, 'docs', 'plans');
  const stateDirectory = path.resolve(plansRoot, '.handoff');
  let planStat;
  try {
    planStat = lstatExactSync(plansRoot);
  } catch {
    throw sprintStateError('INVALID_SPRINT_STATE_ROOT', 'docs/plans must already exist');
  }
  if (planStat.isSymbolicLink() || !planStat.isDirectory()) {
    throw sprintStateError('INVALID_SPRINT_STATE_ROOT', 'docs/plans must be a regular directory');
  }
  const workspaceReal = fs.realpathSync(workspace);
  const plansReal = fs.realpathSync(plansRoot);
  if (!isInside(workspaceReal, plansReal)) {
    throw sprintStateError('INVALID_SPRINT_STATE_ROOT', 'docs/plans escapes the workspace');
  }

  if (create) {
    try {
      fs.mkdirSync(stateDirectory, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  }
  let stateStat;
  try {
    stateStat = lstatExactSync(stateDirectory);
  } catch (error) {
    throw sprintStateError(
      'INVALID_SPRINT_STATE_ROOT',
      '.handoff must already exist for read-only inspection',
      { cause: error }
    );
  }
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw sprintStateError('INVALID_SPRINT_STATE_ROOT', '.handoff must be a regular directory');
  }
  const stateReal = fs.realpathSync(stateDirectory);
  if (!isInside(plansReal, stateReal)) {
    throw sprintStateError('INVALID_SPRINT_STATE_ROOT', '.handoff escapes docs/plans');
  }

  return {
    plansRoot,
    workspace,
    stateDirectory,
    stateDirectoryReal: stateReal,
    stateDirectoryIdentity: fileIdentity(stateStat),
    pointerPath: path.resolve(workspace, POINTER_RELATIVE_PATH),
    lockPath: path.resolve(workspace, LOCK_RELATIVE_PATH),
    transactionPath: path.resolve(workspace, TRANSACTION_RELATIVE_PATH),
    transactionReleasePath: path.resolve(workspace, TRANSACTION_RELEASE_RELATIVE_PATH),
    completionPath: path.resolve(workspace, COMPLETION_RELATIVE_PATH),
  };
}

function exactIntegerIdentity(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    return value;
  }
  throw recoveryError(`${label} is not an exact non-negative integer`);
}

function fileIdentity(stat) {
  if (!stat) throw recoveryError('file identity is missing');
  return {
    dev: exactIntegerIdentity(stat.dev, 'file device identity'),
    ino: exactIntegerIdentity(stat.ino, 'file inode identity'),
  };
}

function requireUsableFileIdentity(stat) {
  const identity = fileIdentity(stat);
  if (identity.ino === '0') {
    throw recoveryError('file inode identity is unavailable');
  }
  return identity;
}

function lstatExactSync(filePath) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  requireUsableFileIdentity(stat);
  return stat;
}

function fstatExactSync(handle) {
  const stat = fs.fstatSync(handle, { bigint: true });
  requireUsableFileIdentity(stat);
  return stat;
}

function exactStatInteger(value, label) {
  return BigInt(exactIntegerIdentity(value, label));
}

function statSizeExceeds(stat, maximumBytes) {
  return exactStatInteger(stat.size, 'file size') > BigInt(maximumBytes);
}

function statSizeEquals(stat, expectedBytes) {
  return exactStatInteger(stat.size, 'file size') === BigInt(expectedBytes);
}

function statSizeAsNumber(stat) {
  const size = exactStatInteger(stat.size, 'file size');
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw recoveryError('file size exceeds the exact numeric range');
  }
  return Number(size);
}

function statPermissionBits(stat) {
  return Number(exactStatInteger(stat.mode, 'file mode') & 0o777n);
}

function randomStateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  const leftIdentity = requireUsableFileIdentity(left);
  const rightIdentity = requireUsableFileIdentity(right);
  return leftIdentity.dev === rightIdentity.dev
    && leftIdentity.ino === rightIdentity.ino;
}

function hasUsableFileIdentity(stat) {
  if (!stat) return false;
  return requireUsableFileIdentity(stat).ino !== '0';
}

function readPlanIdentityIfAvailable(cwd, plan, code) {
  try {
    const stat = lstatExactSync(path.resolve(cwd, plan));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${plan} is not a regular plan file`);
    }
    return stat;
  } catch (error) {
    if (error && ['ENOENT', 'ENOSYS', 'ENOTSUP'].includes(error.code)) return null;
    throw sprintStateError(code, 'cannot verify distinct supersession plan identities', {
      cause: error,
    });
  }
}

function assertDistinctSupersessionPlanIdentity(cwd, sourcePlan, targetPlan, {
  code = 'ILLEGAL_SPRINT_SUPERSESSION', sourceStat, targetStat,
} = {}) {
  const normalizedSourcePlan = normalizePlanPath(cwd, sourcePlan);
  const normalizedTargetPlan = normalizePlanPath(cwd, targetPlan);
  if (!normalizedSourcePlan || !normalizedTargetPlan) return;
  const fail = () => {
    throw sprintStateError(
      code,
      'supersede source and target plans must be distinct files'
    );
  };
  if (normalizedSourcePlan === normalizedTargetPlan) fail();
  const sourceIdentity = sourceStat
    || readPlanIdentityIfAvailable(cwd, normalizedSourcePlan, code);
  const targetIdentity = targetStat
    || readPlanIdentityIfAvailable(cwd, normalizedTargetPlan, code);
  if (hasUsableFileIdentity(sourceIdentity)
      && hasUsableFileIdentity(targetIdentity)
      && sameFileIdentity(sourceIdentity, targetIdentity)) {
    fail();
  }
}

function claimSlotName(scopeToken, artifact) {
  if (!/^[a-f0-9]{32}$/.test(scopeToken || '') || !CLAIM_ARTIFACTS.has(artifact)) {
    throw recoveryError('private claim scope is invalid');
  }
  return `${CLAIM_SLOT_PREFIX}${scopeToken}-${artifact}`;
}

function claimSlotPaths(paths, scopeToken, artifact) {
  const slotName = claimSlotName(scopeToken, artifact);
  const slotPath = path.join(paths.stateDirectory, slotName);
  return {
    slotName,
    slotPath,
    intentPath: path.join(slotPath, CLAIM_INTENT_FILE),
    valuePath: path.join(slotPath, CLAIM_VALUE_FILE),
    restoreGuardPath: path.join(slotPath, CLAIM_RESTORE_GUARD_FILE),
    deleteTombstonePath: path.join(slotPath, CLAIM_DELETE_TOMBSTONE_FILE),
  };
}

function inspectClaimParent(paths) {
  let parentStat;
  let parentReal;
  try {
    parentStat = lstatExactSync(paths.stateDirectory);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error('state directory is not a regular directory');
    }
    parentReal = fs.realpathSync(paths.stateDirectory);
    const plansReal = fs.realpathSync(paths.plansRoot);
    const resolvedParent = path.resolve(paths.stateDirectory);
    const sameResolvedParent = process.platform === 'win32'
      ? parentReal.toLowerCase() === resolvedParent.toLowerCase()
      : parentReal === resolvedParent;
    const parentIdentity = requireUsableFileIdentity(parentStat);
    if (!sameResolvedParent || path.basename(resolvedParent) !== '.handoff'
        || !isInside(plansReal, parentReal)
        || path.dirname(parentReal) !== plansReal
        || (paths.stateDirectoryIdentity
          && (parentIdentity.dev !== paths.stateDirectoryIdentity.dev
            || parentIdentity.ino !== paths.stateDirectoryIdentity.ino))
        || (paths.stateDirectoryReal && parentReal !== paths.stateDirectoryReal)) {
      throw new Error('state directory realpath is outside docs/plans');
    }
  } catch (error) {
    throw recoveryError('private claim parent is unsafe', { cause: error });
  }
  return { stat: parentStat, real: parentReal };
}

function expectedClaimDisposition(artifact) {
  return artifact === 'pointer' || artifact === 'partial' || artifact === 'prior-completion'
    ? 'hold' : 'delete';
}

function maximumClaimBytes(artifact) {
  if (artifact === 'transaction' || artifact === 'transaction-release') {
    return MAX_TRANSACTION_BYTES;
  }
  return artifact === 'migration-receipt-stage' || artifact === 'migration-receipt-final'
    ? MAX_MIGRATION_EVIDENCE_BYTES
    : MAX_RECOVERY_BYTES;
}

function isAllowedClaimSource(intent) {
  if (intent.artifact === 'migration-receipt-final') {
    return /^active-sprint\.migration-receipt-[a-f0-9]{64}\.json$/.test(intent.source)
      && intent.disposition === expectedClaimDisposition(intent.artifact);
  }
  const token = intent.scope_token;
  const expected = {
    lock: path.basename(LOCK_RELATIVE_PATH),
    pointer: path.basename(POINTER_RELATIVE_PATH),
    publish: `active-sprint.publish-${token}.json`,
    partial: `active-sprint.publish-${token}.json`,
    'legacy-pointer': `active-sprint.claim-${token}.json`,
    'legacy-partial': `active-sprint.publish-${token}.partial`,
    'legacy-partial-release': `active-sprint.publish-${token}.partial.release.tmp`,
    'legacy-partial-delete-a': `active-sprint.publish-${token}.partial.delete-a.tmp`,
    'legacy-partial-delete-b': `active-sprint.publish-${token}.partial.delete-b.tmp`,
    transaction: path.basename(TRANSACTION_RELATIVE_PATH),
    'transaction-release': path.basename(TRANSACTION_RELEASE_RELATIVE_PATH),
    completion: path.basename(COMPLETION_RELATIVE_PATH),
    'prior-completion': path.basename(COMPLETION_RELATIVE_PATH),
    'completion-stage': `active-sprint.completed-${token}.tmp`,
    'migration-receipt-stage': `active-sprint.migration-${token}.json`,
  }[intent.artifact];
  return intent.source === expected
    && intent.disposition === expectedClaimDisposition(intent.artifact);
}

function canonicalClaimIntent(paths, {
  scopeToken,
  artifact,
  sourcePath,
  snapshot,
}) {
  const parent = inspectClaimParent(paths);
  const absoluteSource = path.resolve(sourcePath);
  if (path.dirname(absoluteSource) !== path.resolve(paths.stateDirectory)) {
    throw recoveryError('private claim source must be a direct state-directory child');
  }
  const source = path.basename(absoluteSource);
  const parentIdentity = requireUsableFileIdentity(parent.stat);
  const expectedIdentity = requireUsableFileIdentity(snapshot.stat);
  const intent = {
    version: CLAIM_INTENT_VERSION,
    scope_token: scopeToken,
    artifact,
    source,
    disposition: expectedClaimDisposition(artifact),
    parent: path.basename(paths.stateDirectory),
    parent_dev: parentIdentity.dev,
    parent_ino: parentIdentity.ino,
    expected_dev: expectedIdentity.dev,
    expected_ino: expectedIdentity.ino,
    size: snapshot.bytes.length,
    sha256: sha256(snapshot.bytes),
  };
  if (!isAllowedClaimSource(intent)) {
    throw recoveryError('private claim source is not allowed for its artifact');
  }
  return intent;
}

function parseClaimIntent(paths, slot, raw) {
  if (Buffer.byteLength(raw, 'utf8') > 4096) {
    throw recoveryError(`private claim intent is too large: ${slot.slotName}`);
  }
  let intent;
  try {
    intent = JSON.parse(raw);
  } catch (error) {
    throw recoveryError(`private claim intent JSON is invalid: ${slot.slotName}`, { cause: error });
  }
  const keys = intent && typeof intent === 'object' && !Array.isArray(intent)
    ? Object.keys(intent) : [];
  if (!intent || keys.length !== CLAIM_INTENT_KEYS.size
      || keys.some((key) => !CLAIM_INTENT_KEYS.has(key))
      || `${JSON.stringify(intent)}\n` !== raw
      || intent.version !== CLAIM_INTENT_VERSION
      || !/^[a-f0-9]{32}$/.test(intent.scope_token || '')
      || !CLAIM_ARTIFACTS.has(intent.artifact)
      || intent.parent !== path.basename(paths.stateDirectory)
      || intent.parent !== '.handoff'
      || !/^(?:0|[1-9]\d*)$/.test(intent.parent_dev || '')
      || !/^(?:0|[1-9]\d*)$/.test(intent.parent_ino || '')
      || !/^(?:0|[1-9]\d*)$/.test(intent.expected_dev || '')
      || !/^(?:0|[1-9]\d*)$/.test(intent.expected_ino || '')
      || !Number.isSafeInteger(intent.size) || intent.size < 0
      || intent.size > maximumClaimBytes(intent.artifact)
      || !/^[a-f0-9]{64}$/.test(intent.sha256 || '')
      || !isAllowedClaimSource(intent)
      || claimSlotName(intent.scope_token, intent.artifact) !== slot.slotName) {
    throw recoveryError(`private claim intent schema is invalid: ${slot.slotName}`);
  }
  const parent = inspectClaimParent(paths);
  const parentIdentity = requireUsableFileIdentity(parent.stat);
  if (intent.parent_dev !== parentIdentity.dev
      || intent.parent_ino !== parentIdentity.ino) {
    throw recoveryError(`private claim parent identity changed: ${slot.slotName}`);
  }
  return intent;
}

function readPrivateClaimSlot(paths, scopeToken, artifact, {
  allowMissing = true,
  allowValueMismatch = false,
} = {}) {
  const slot = claimSlotPaths(paths, scopeToken, artifact);
  let slotStat;
  try {
    slotStat = lstatExactSync(slot.slotPath);
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') return null;
    throw recoveryError(`cannot inspect private claim slot: ${slot.slotName}`, { cause: error });
  }
  if (slotStat.isSymbolicLink() || !slotStat.isDirectory()) {
    throw recoveryError(`private claim slot is not a regular directory: ${slot.slotName}`);
  }
  const parent = inspectClaimParent(paths);
  let slotReal;
  let entries;
  try {
    slotReal = fs.realpathSync(slot.slotPath);
    entries = fs.readdirSync(slot.slotPath).sort();
  } catch (error) {
    throw recoveryError(`cannot inspect private claim slot entries: ${slot.slotName}`, { cause: error });
  }
  if (path.dirname(slotReal) !== parent.real || !isInside(parent.real, slotReal)) {
    throw recoveryError(`private claim slot escapes the state directory: ${slot.slotName}`);
  }
  if (process.platform !== 'win32' && statPermissionBits(slotStat) !== 0o700) {
    throw recoveryError(`private claim slot permissions are unsafe: ${slot.slotName}`);
  }
  if (entries.length === 0) {
    return {
      ...slot,
      empty: true,
      intent: null,
      value: null,
      restoreGuard: null,
      deleteTombstone: null,
      heldValue: null,
      valueState: 'missing',
      slotStat,
    };
  }
  if (!entries.includes(CLAIM_INTENT_FILE)
      || entries.some((entry) => !CLAIM_SLOT_FILES.has(entry))) {
    throw recoveryError(`private claim slot has unknown or ambiguous entries: ${slot.slotName}`);
  }
  if (entries.includes(CLAIM_RESTORE_GUARD_FILE)
      && entries.includes(CLAIM_DELETE_TOMBSTONE_FILE)) {
    throw recoveryError(`private claim slot has ambiguous release phases: ${slot.slotName}`);
  }
  const intentStat = lstatExactSync(slot.intentPath);
  if (intentStat.isSymbolicLink() || !intentStat.isFile()
      || statSizeExceeds(intentStat, 4096)) {
    throw recoveryError(`private claim intent is not a bounded regular file: ${slot.slotName}`);
  }
  const intentRaw = fs.readFileSync(slot.intentPath, 'utf8');
  const intentAfter = lstatExactSync(slot.intentPath);
  const slotAfter = lstatExactSync(slot.slotPath);
  if (!sameFileIdentity(intentStat, intentAfter)
      || !statSizeEquals(intentAfter, Buffer.byteLength(intentRaw, 'utf8'))
      || !sameFileIdentity(slotStat, slotAfter)
      || slotAfter.isSymbolicLink() || !slotAfter.isDirectory()) {
    throw recoveryError(`private claim metadata changed while reading: ${slot.slotName}`);
  }
  const intent = parseClaimIntent(paths, slot, intentRaw);
  const readEntry = (entry, entryPath) => entries.includes(entry)
    ? readStableRecoverySnapshot(entryPath, maximumClaimBytes(artifact))
    : null;
  const value = readEntry(CLAIM_VALUE_FILE, slot.valuePath);
  const restoreGuard = readEntry(CLAIM_RESTORE_GUARD_FILE, slot.restoreGuardPath);
  const deleteTombstone = readEntry(
    CLAIM_DELETE_TOMBSTONE_FILE,
    slot.deleteTombstonePath
  );
  const heldValue = value || restoreGuard || deleteTombstone;
  for (const staged of [restoreGuard, deleteTombstone]) {
    if (value && staged
        && (!sameFileIdentity(value.stat, staged.stat) || !value.bytes.equals(staged.bytes))) {
      throw recoveryError(`private claim release anchor differs from value: ${slot.slotName}`);
    }
  }
  let valueState = 'missing';
  if (heldValue) {
    const heldIdentity = requireUsableFileIdentity(heldValue.stat);
    const matchesIntent = heldIdentity.dev === intent.expected_dev
      && heldIdentity.ino === intent.expected_ino
      && heldValue.bytes.length === intent.size
      && sha256(heldValue.bytes) === intent.sha256;
    valueState = matchesIntent ? 'expected' : 'intent-mismatch';
    if (!matchesIntent && !allowValueMismatch) {
      throw recoveryError(`private claim value does not match immutable intent: ${slot.slotName}`);
    }
  }
  return {
    ...slot,
    empty: false,
    intent,
    intentRaw,
    intentStat: intentAfter,
    slotStat: slotAfter,
    value,
    restoreGuard,
    deleteTombstone,
    heldValue,
    valueState,
  };
}

function removeEmptyPrivateClaimSlot(paths, slot) {
  const before = lstatExactSync(slot.slotPath);
  const entries = fs.readdirSync(slot.slotPath);
  const after = lstatExactSync(slot.slotPath);
  if (entries.length !== 0 || !sameFileIdentity(before, after)
      || (slot.slotStat && !sameFileIdentity(slot.slotStat, after))
      || after.isSymbolicLink() || !after.isDirectory()) {
    throw recoveryError(`private claim slot is not the verified empty directory: ${slot.slotName}`);
  }
  try {
    fs.rmdirSync(slot.slotPath);
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    throw recoveryError(`cannot remove empty private claim slot: ${slot.slotName}`, { cause: error });
  }
}

function removePrivateClaimMetadata(paths, claim) {
  const current = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false }
  );
  if (current.heldValue) {
    throw recoveryError(`private claim value or release anchor still exists: ${current.slotName}`);
  }
  try {
    const intentNow = lstatExactSync(current.intentPath);
    const slotNow = lstatExactSync(current.slotPath);
    if (!sameFileIdentity(current.intentStat, intentNow)
        || !sameFileIdentity(current.slotStat, slotNow)) {
      throw recoveryError(`private claim metadata identity changed: ${current.slotName}`);
    }
    fs.unlinkSync(current.intentPath);
    fsyncDirectoryIfSupported(current.slotPath);
    const slotAfterIntent = lstatExactSync(current.slotPath);
    const remaining = fs.readdirSync(current.slotPath);
    if (!sameFileIdentity(slotNow, slotAfterIntent) || remaining.length !== 0) {
      throw recoveryError(`private claim slot changed before rmdir: ${current.slotName}`);
    }
    fs.rmdirSync(current.slotPath);
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    throw recoveryError(`cannot remove private claim metadata: ${current.slotName}`, { cause: error });
  }
}

function inspectClaimSource(paths, claim) {
  const sourcePath = path.join(paths.stateDirectory, claim.intent.source);
  let source;
  try {
    source = readStableRecoverySnapshot(
      sourcePath,
      maximumClaimBytes(claim.intent.artifact)
    );
  } catch (error) {
    if (error && error.cause && error.cause.code === 'ENOENT') {
      return { state: 'missing', sourcePath, snapshot: null };
    }
    throw error;
  }
  const sourceIdentity = requireUsableFileIdentity(source.stat);
  const matches = sourceIdentity.dev === claim.intent.expected_dev
    && sourceIdentity.ino === claim.intent.expected_ino
    && source.bytes.length === claim.intent.size
    && sha256(source.bytes) === claim.intent.sha256;
  return { state: matches ? 'expected' : 'successor', sourcePath, snapshot: source };
}

function sameRecoverySnapshot(left, right) {
  return Boolean(left && right)
    && sameFileIdentity(left.stat, right.stat)
    && left.bytes.equals(right.bytes);
}

function convergeExactClaimSourceDuplicate(paths, claim, {
  allowedSourceHash = null,
  verifyBeforeDestroy = null,
} = {}) {
  if (!claim || claim.empty || !claim.intent || !claim.value) {
    throw recoveryError('private claim source convergence requires a held value');
  }
  if (verifyBeforeDestroy !== null && typeof verifyBeforeDestroy !== 'function') {
    throw new TypeError('verifyBeforeDestroy must be a function');
  }

  const readCurrent = () => {
    const current = readPrivateClaimSlot(
      paths,
      claim.intent.scope_token,
      claim.intent.artifact,
      { allowMissing: false }
    );
    if (current.empty || !current.value
        || current.restoreGuard || current.deleteTombstone) {
      throw recoveryError(
        `private claim is not a stable value/source pair: ${claim.slotName}`
      );
    }
    return current;
  };

  let current = readCurrent();
  if (!sameFileIdentity(claim.slotStat, current.slotStat)
      || claim.intentRaw !== current.intentRaw
      || !sameRecoverySnapshot(claim.value, current.value)) {
    throw recoveryError(
      `private claim changed before source convergence: ${claim.slotName}`
    );
  }

  let source = inspectClaimSource(paths, current);
  if (source.state === 'missing') return current;
  if (source.state !== 'expected'
      || !sameRecoverySnapshot(current.value, source.snapshot)) {
    const allowedSuccessor = source.state === 'successor'
      && source.snapshot
      && allowedSourceHash
      && sha256(source.snapshot.bytes) === allowedSourceHash;
    if (allowedSuccessor) return current;
    throw recoveryError(
      `private claim source successor was preserved: ${current.intent.source}`
    );
  }

  // The claim value must be the durable anchor before removing the duplicate
  // source name. Re-read every identity after the directory durability barrier.
  try {
    fsyncDirectoryIfSupported(current.slotPath);
  } catch (error) {
    throw recoveryError(
      `cannot persist private claim anchor before source convergence: ${current.slotName}`,
      { cause: error }
    );
  }
  const beforeDestroy = readCurrent();
  const sourceBeforeDestroy = inspectClaimSource(paths, beforeDestroy);
  if (!sameFileIdentity(current.slotStat, beforeDestroy.slotStat)
      || current.intentRaw !== beforeDestroy.intentRaw
      || !sameRecoverySnapshot(current.value, beforeDestroy.value)
      || sourceBeforeDestroy.state !== 'expected'
      || !sameRecoverySnapshot(source.snapshot, sourceBeforeDestroy.snapshot)
      || !sameRecoverySnapshot(beforeDestroy.value, sourceBeforeDestroy.snapshot)) {
    throw recoveryError(
      `private claim source duplicate changed before release: ${current.slotName}`
    );
  }

  // For committed cleanup this is intentionally adjacent to the destructive
  // unlink: the terminal proof must still hold at the release boundary.
  if (verifyBeforeDestroy) verifyBeforeDestroy();
  let unlinkError = null;
  try {
    fs.unlinkSync(sourceBeforeDestroy.sourcePath);
  } catch (error) {
    unlinkError = error;
  }

  let sourceAfterUnlink;
  try {
    sourceAfterUnlink = inspectClaimSource(paths, beforeDestroy);
  } catch (error) {
    throw recoveryError(
      `cannot verify private claim source after duplicate release: ${current.slotName}`,
      { cause: error, unlinkCause: unlinkError }
    );
  }
  if (sourceAfterUnlink.state !== 'missing') {
    if (unlinkError) {
      throw recoveryError(
        `cannot release exact private claim source duplicate: ${current.slotName}`,
        { cause: unlinkError }
      );
    }
    throw recoveryError(
      `private claim source successor appeared during convergence: ${current.intent.source}`
    );
  }

  try {
    fsyncDirectoryIfSupported(path.dirname(sourceBeforeDestroy.sourcePath));
  } catch (error) {
    const preserved = readCurrent();
    if (!sameFileIdentity(beforeDestroy.slotStat, preserved.slotStat)
        || beforeDestroy.intentRaw !== preserved.intentRaw
        || !sameRecoverySnapshot(beforeDestroy.value, preserved.value)) {
      throw recoveryError(
        `private claim anchor changed after source fsync failure: ${current.slotName}`,
        { cause: error, unlinkCause: unlinkError }
      );
    }
    throw recoveryError(
      `cannot persist private claim source convergence: ${current.slotName}`,
      { cause: error, unlinkCause: unlinkError }
    );
  }

  const converged = readCurrent();
  source = inspectClaimSource(paths, converged);
  if (!sameFileIdentity(beforeDestroy.slotStat, converged.slotStat)
      || beforeDestroy.intentRaw !== converged.intentRaw
      || !sameRecoverySnapshot(beforeDestroy.value, converged.value)
      || source.state !== 'missing') {
    throw recoveryError(
      'private claim source convergence did not reach a stable terminal state: '
        + current.slotName
    );
  }
  return converged;
}

function privateClaimStage(claim) {
  if (claim.restoreGuard) {
    return {
      key: 'restoreGuard',
      label: 'restore guard',
      path: claim.restoreGuardPath,
      snapshot: claim.restoreGuard,
    };
  }
  if (claim.deleteTombstone) {
    return {
      key: 'deleteTombstone',
      label: 'delete tombstone',
      path: claim.deleteTombstonePath,
      snapshot: claim.deleteTombstone,
    };
  }
  return null;
}

function unlinkVerifiedPrivateClaimEntry(
  paths,
  claim,
  entryPath,
  expected,
  label,
  {
    sync = false,
    verifyBeforeDestroy = null,
  } = {}
) {
  if (verifyBeforeDestroy !== null && typeof verifyBeforeDestroy !== 'function') {
    throw new TypeError('verifyBeforeDestroy must be a function');
  }
  const slotNow = lstatExactSync(claim.slotPath);
  if (!sameFileIdentity(claim.slotStat, slotNow)
      || slotNow.isSymbolicLink() || !slotNow.isDirectory()) {
    throw recoveryError(`private claim slot changed before ${label} release: ${claim.slotName}`);
  }
  const current = readStableRecoverySnapshot(
    entryPath,
    maximumClaimBytes(claim.intent.artifact)
  );
  if (!sameRecoverySnapshot(expected, current)) {
    throw recoveryError(`private claim ${label} changed before release: ${claim.slotName}`);
  }
  if (verifyBeforeDestroy) verifyBeforeDestroy();
  fs.unlinkSync(entryPath);
  fsyncDirectoryIfSupported(claim.slotPath);
  if (sync) fsyncDirectoryIfSupported(paths.stateDirectory);
}

function linkPrivateClaimStage(paths, claim, stageKey) {
  const stage = stageKey === 'restoreGuard'
    ? { label: 'restore guard', path: claim.restoreGuardPath }
    : { label: 'delete tombstone', path: claim.deleteTombstonePath };
  const valueBeforeLink = readStableRecoverySnapshot(
    claim.valuePath,
    maximumClaimBytes(claim.intent.artifact)
  );
  if (!sameRecoverySnapshot(claim.value, valueBeforeLink)) {
    throw recoveryError(`private claim value changed before ${stage.label}: ${claim.slotName}`);
  }
  try {
    fs.linkSync(claim.valuePath, stage.path);
    fsyncDirectoryIfSupported(claim.slotPath);
  } catch (error) {
    throw recoveryError(`cannot create private claim ${stage.label}: ${claim.slotName}`, {
      cause: error,
    });
  }
  const staged = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false, allowValueMismatch: true }
  );
  if (!staged.value || !staged[stageKey]
      || !sameRecoverySnapshot(valueBeforeLink, staged.value)
      || !sameRecoverySnapshot(valueBeforeLink, staged[stageKey])) {
    throw recoveryError(`private claim ${stage.label} readback mismatch: ${claim.slotName}`);
  }
  return staged;
}

function stageMatchesCanonicalSource(paths, claim, stage) {
  const sourcePath = path.join(paths.stateDirectory, claim.intent.source);
  let source;
  try {
    source = readStableRecoverySnapshot(
      sourcePath,
      maximumClaimBytes(claim.intent.artifact)
    );
  } catch (error) {
    if (error && error.cause && error.cause.code === 'ENOENT') return false;
    throw error;
  }
  return sameRecoverySnapshot(stage, source);
}

function normalizePrivateClaimStage(paths, claim, { allowValueMismatch = false } = {}) {
  if (!claim || claim.empty) return claim;
  const stage = privateClaimStage(claim);
  if (!stage) return claim;
  if (!claim.value && claim.valueState === 'intent-mismatch'
      && (!allowValueMismatch || !stageMatchesCanonicalSource(paths, claim, stage.snapshot))) {
    throw recoveryError(
      `private claim unbound release anchor was preserved: ${claim.slotName}`
    );
  }
  if (!claim.value) {
    try {
      fs.linkSync(stage.path, claim.valuePath);
      fsyncDirectoryIfSupported(claim.slotPath);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw recoveryError(`cannot recover private claim ${stage.label}: ${claim.slotName}`, {
          cause: error,
        });
      }
    }
  }
  const linked = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false, allowValueMismatch }
  );
  const linkedStage = linked[stage.key];
  if (!linked.value || !linkedStage || !sameRecoverySnapshot(linked.value, linkedStage)) {
    throw recoveryError(`private claim ${stage.label} recovery is ambiguous: ${claim.slotName}`);
  }
  unlinkVerifiedPrivateClaimEntry(
    paths,
    linked,
    stage.path,
    linkedStage,
    stage.label
  );
  return readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false, allowValueMismatch }
  );
}

function preservePrivateClaimValueFromStage(paths, claim, stageKey, expectedStage) {
  const current = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false, allowValueMismatch: true }
  );
  const stage = stageKey === 'restoreGuard'
    ? { label: 'restore guard', path: current.restoreGuardPath, snapshot: current.restoreGuard }
    : {
      label: 'delete tombstone',
      path: current.deleteTombstonePath,
      snapshot: current.deleteTombstone,
    };
  if (!stage.snapshot) {
    if (current.value) return current;
    if (!current.heldValue) return null;
    throw recoveryError(`private claim ${stage.label} was replaced: ${claim.slotName}`);
  }
  if (!sameFileIdentity(expectedStage.stat, stage.snapshot.stat)) {
    throw recoveryError(`private claim ${stage.label} identity changed: ${claim.slotName}`);
  }
  if (!current.value) {
    try {
      fs.linkSync(stage.path, current.valuePath);
      fsyncDirectoryIfSupported(current.slotPath);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw recoveryError(`cannot preserve private claim ${stage.label}: ${claim.slotName}`, {
          cause: error,
        });
      }
    }
  }
  const preserved = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false, allowValueMismatch: true }
  );
  if (!preserved.value || !preserved[stageKey]
      || !sameRecoverySnapshot(preserved.value, preserved[stageKey])) {
    throw recoveryError(`private claim ${stage.label} preservation is ambiguous: ${claim.slotName}`);
  }
  return preserved;
}

function claimSourceIsDeletable(source, allowedSourceHash) {
  return source.state === 'missing'
    || Boolean(source.snapshot && allowedSourceHash
      && sha256(source.snapshot.bytes) === allowedSourceHash);
}

function sameClaimSourceObservation(left, right) {
  if (!left || !right || left.state !== right.state) return false;
  if (left.state === 'missing') return true;
  return sameRecoverySnapshot(left.snapshot, right.snapshot);
}

function claimIntentMatchesSnapshot(claim, sourcePath, snapshot) {
  const snapshotIdentity = requireUsableFileIdentity(snapshot.stat);
  return claim.intent.source === path.basename(path.resolve(sourcePath))
    && claim.intent.expected_dev === snapshotIdentity.dev
    && claim.intent.expected_ino === snapshotIdentity.ino
    && claim.intent.size === snapshot.bytes.length
    && claim.intent.sha256 === sha256(snapshot.bytes);
}

function preparePrivateClaimForSource(paths, claim, {
  scopeToken,
  artifact,
  sourcePath,
  snapshot,
}) {
  let prepared = claim;
  if (claim.empty) {
    const current = readPrivateClaimSlot(paths, scopeToken, artifact, { allowMissing: false });
    if (!current.empty || !sameFileIdentity(claim.slotStat, current.slotStat)) {
      throw recoveryError(`private claim slot changed before intent: ${claim.slotName}`);
    }
    const intent = canonicalClaimIntent(paths, {
      scopeToken,
      artifact,
      sourcePath,
      snapshot,
    });
    const intentRaw = `${JSON.stringify(intent)}\n`;
    try {
      writeDurableStagedExclusive(
        current.intentPath,
        intentRaw,
        paths.stateDirectory,
        scopeToken
      );
      fsyncDirectoryIfSupported(paths.stateDirectory);
    } catch (error) {
      throw recoveryError(`cannot persist private claim intent: ${current.slotName}`, {
        cause: error,
      });
    }
    prepared = readPrivateClaimSlot(paths, scopeToken, artifact, { allowMissing: false });
  }
  if (!prepared.intent || prepared.heldValue
      || !claimIntentMatchesSnapshot(prepared, sourcePath, snapshot)) {
    throw recoveryError(`private claim intent differs from source snapshot: ${claim.slotName}`);
  }
  return prepared;
}

function movePreparedPrivateClaimSource(paths, prepared, sourcePath, snapshot, {
  removeIntentOnPreMoveFailure = false,
} = {}) {
  let sourceBeforeMove;
  try {
    sourceBeforeMove = readStableRecoverySnapshot(
      sourcePath,
      maximumClaimBytes(prepared.intent.artifact)
    );
  } catch (error) {
    if (removeIntentOnPreMoveFailure) removePrivateClaimMetadata(paths, prepared);
    throw recoveryError(
      'private claim source could not be rechecked before move: ' + prepared.intent.source,
      { cause: error }
    );
  }
  if (!sameRecoverySnapshot(snapshot, sourceBeforeMove)) {
    if (removeIntentOnPreMoveFailure) removePrivateClaimMetadata(paths, prepared);
    throw recoveryError(
      'private claim source changed before move; no bytes were moved: ' + prepared.intent.source
    );
  }
  try {
    fsyncDirectoryIfSupported(prepared.slotPath);
    fs.renameSync(sourcePath, prepared.valuePath);
    fsyncDirectoryIfSupported(prepared.slotPath);
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    if (error && error.code === 'SPRINT_RECOVERY_REQUIRED') throw error;
    throw recoveryError(`cannot move source into private claim: ${prepared.slotName}`, {
      cause: error,
    });
  }
  const claimed = readPrivateClaimSlot(
    paths,
    prepared.intent.scope_token,
    prepared.intent.artifact,
    { allowMissing: false, allowValueMismatch: true }
  );
  if (claimed.valueState === 'intent-mismatch') {
    recoverPrivateClaimIntentMismatch(paths, claimed);
    throw recoveryError(
      'private claim source changed during move; moved inode was restored: '
        + prepared.intent.source
    );
  }
  if (!claimed.value || !sameRecoverySnapshot(snapshot, claimed.value)) {
    throw recoveryError(`private claim changed during move: ${prepared.slotName}`);
  }
  const source = inspectClaimSource(paths, claimed);
  if (source.state !== 'missing') {
    throw recoveryError(`private claim source successor appeared: ${prepared.intent.source}`);
  }
  return claimed;
}

function createPrivateClaim(paths, {
  scopeToken,
  artifact,
  sourcePath,
  snapshot,
}) {
  const slot = claimSlotPaths(paths, scopeToken, artifact);
  try {
    fs.mkdirSync(slot.slotPath, { mode: 0o700 });
    fs.chmodSync(slot.slotPath, 0o700);
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    throw recoveryError(`cannot create private claim slot: ${slot.slotName}`, { cause: error });
  }
  const empty = readPrivateClaimSlot(paths, scopeToken, artifact, { allowMissing: false });
  const prepared = preparePrivateClaimForSource(paths, empty, {
    scopeToken,
    artifact,
    sourcePath,
    snapshot,
  });
  return movePreparedPrivateClaimSource(paths, prepared, sourcePath, snapshot, {
    removeIntentOnPreMoveFailure: true,
  });
}

function deletePrivateClaimValue(paths, claim, {
  sync = false,
  allowedSourceHash = null,
  verifyBeforeDestroy = null,
} = {}) {
  if (verifyBeforeDestroy !== null && typeof verifyBeforeDestroy !== 'function') {
    throw new TypeError('verifyBeforeDestroy must be a function');
  }
  let current = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false }
  );
  current = normalizePrivateClaimStage(paths, current);
  if (!current.value) {
    throw recoveryError(`private claim value is missing: ${current.slotName}`);
  }
  current = convergeExactClaimSourceDuplicate(paths, current, {
    allowedSourceHash,
    verifyBeforeDestroy,
  });
  const sourceBeforeRelease = inspectClaimSource(paths, current);
  if (!claimSourceIsDeletable(sourceBeforeRelease, allowedSourceHash)) {
    throw recoveryError(`private claim source successor was preserved: ${current.intent.source}`);
  }
  const staged = linkPrivateClaimStage(paths, current, 'deleteTombstone');
  const tombstone = staged.deleteTombstone;
  const preserve = (releaseError, message, { verifier = false } = {}) => {
    try {
      preservePrivateClaimValueFromStage(paths, staged, 'deleteTombstone', tombstone);
    } catch (preservationError) {
      throw recoveryError(`${message}; private claim evidence preservation failed`, {
        cause: preservationError,
        releaseCause: releaseError,
      });
    }
    if (verifier || (releaseError && releaseError.code === 'SPRINT_RECOVERY_REQUIRED')) {
      throw releaseError;
    }
    throw recoveryError(message, { cause: releaseError });
  };

  if (verifyBeforeDestroy) {
    try {
      verifyBeforeDestroy();
    } catch (error) {
      preserve(error, `private claim verification blocked value release: ${current.slotName}`, {
        verifier: true,
      });
    }
  }
  try {
    unlinkVerifiedPrivateClaimEntry(
      paths,
      staged,
      staged.valuePath,
      staged.value,
      'value',
      { sync }
    );
  } catch (error) {
    preserve(error, `cannot retire private claim value: ${current.slotName}`);
  }

  let sourceAfterRelease;
  try {
    sourceAfterRelease = inspectClaimSource(paths, staged);
    if (!claimSourceIsDeletable(sourceAfterRelease, allowedSourceHash)) {
      throw recoveryError(`private claim source successor was preserved: ${current.intent.source}`);
    }
  } catch (error) {
    preserve(error, `cannot verify private claim source after value release: ${current.slotName}`);
  }

  if (verifyBeforeDestroy) {
    try {
      verifyBeforeDestroy();
    } catch (error) {
      preserve(error, `private claim verification blocked tombstone release: ${current.slotName}`, {
        verifier: true,
      });
    }
  }
  try {
    const tombstoneBeforeDestroy = readStableRecoverySnapshot(
      staged.deleteTombstonePath,
      maximumClaimBytes(staged.intent.artifact)
    );
    if (!sameRecoverySnapshot(tombstone, tombstoneBeforeDestroy)) {
      throw recoveryError(`private claim tombstone changed before destroy: ${current.slotName}`);
    }
    const sourceBeforeDestroy = inspectClaimSource(paths, staged);
    if (!claimSourceIsDeletable(sourceBeforeDestroy, allowedSourceHash)
        || !sameClaimSourceObservation(sourceAfterRelease, sourceBeforeDestroy)) {
      throw recoveryError(
        `private claim source changed before tombstone destroy: ${current.intent.source}`
      );
    }
    unlinkVerifiedPrivateClaimEntry(
      paths,
      staged,
      staged.deleteTombstonePath,
      tombstoneBeforeDestroy,
      'delete tombstone',
      { sync, verifyBeforeDestroy }
    );
  } catch (error) {
    preserve(error, `cannot destroy private claim tombstone: ${current.slotName}`);
  }
  removePrivateClaimMetadata(paths, staged);
}

function resumeDeletePrivateClaim(paths, claim, expectedHash, {
  sync = false,
  verifyBeforeDestroy = null,
} = {}) {
  if (claim.empty) {
    removeEmptyPrivateClaimSlot(paths, claim);
    return { action: 'retry' };
  }
  if (claim.intent.disposition !== 'delete' || claim.intent.sha256 !== expectedHash) {
    throw recoveryError(`private delete claim does not match cleanup request: ${claim.slotName}`);
  }
  const source = inspectClaimSource(paths, claim);
  if (!claim.value) {
    if (source.state === 'successor') {
      throw recoveryError(`private delete claim source successor was preserved: ${claim.intent.source}`);
    }
    removePrivateClaimMetadata(paths, claim);
    return { action: source.state === 'expected' ? 'retry' : 'done' };
  }
  deletePrivateClaimValue(paths, claim, { sync, verifyBeforeDestroy });
  return { action: 'done' };
}

function parsePrivateClaimSlotName(name) {
  const match = String(name).match(/^active-sprint\.claim-([a-f0-9]{32})-([a-z0-9-]+)$/);
  if (!match || !CLAIM_ARTIFACTS.has(match[2])) return null;
  if (claimSlotName(match[1], match[2]) !== name) return null;
  return { scopeToken: match[1], artifact: match[2] };
}

function recoverStandaloneDeleteClaims(paths, {
  artifacts = null,
  excludeClaim = null,
} = {}) {
  let entries;
  try {
    entries = fs.readdirSync(paths.stateDirectory);
  } catch (error) {
    throw recoveryError('cannot scan private claim slots for recovery', { cause: error });
  }
  for (const entry of entries.sort()) {
    const parsed = parsePrivateClaimSlotName(entry);
    if (!parsed) {
      if (entry.startsWith(CLAIM_SLOT_PREFIX)
          && !/^active-sprint\.claim-[a-f0-9]{32}\.json$/.test(entry)) {
        throw recoveryError(`unknown private claim entry was preserved: ${entry}`);
      }
      continue;
    }
    if (artifacts && !artifacts.has(parsed.artifact)) continue;
    if (excludeClaim && excludeClaim(parsed)) continue;
    const claim = readRecoverablePrivateClaimSlot(paths, parsed.scopeToken, parsed.artifact, {
      allowMissing: false,
    });
    if (!claim) continue;
    if (claim.empty) {
      if (expectedClaimDisposition(parsed.artifact) === 'hold') continue;
      removeEmptyPrivateClaimSlot(paths, claim);
      continue;
    }
    if (claim.intent.disposition !== 'delete') continue;
    const resumed = resumeDeletePrivateClaim(paths, claim, claim.intent.sha256, { sync: true });
    if (resumed.action === 'retry') {
      // An intent-only claim means rename never happened. Metadata is gone and the
      // verified source remains for its owning operation to inspect normally.
      continue;
    }
  }
}
function removeVerifiedRecoveryFile(filePath, expectedHash, directory, {
  sync = false,
  scopeToken,
  artifact,
  maximumBytes = maximumClaimBytes(artifact),
  verifyBeforeDestroy = null,
} = {}) {
  const paths = {
    stateDirectory: path.resolve(directory),
    plansRoot: path.dirname(path.resolve(directory)),
  };
  const slot = readRecoverablePrivateClaimSlot(paths, scopeToken, artifact);
  if (slot) {
    const resumed = resumeDeletePrivateClaim(paths, slot, expectedHash, {
      sync,
      verifyBeforeDestroy,
    });
    if (resumed.action === 'done') return true;
  }
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(filePath, maximumBytes);
  } catch (error) {
    if (error && error.cause && error.cause.code === 'ENOENT') return false;
    throw error;
  }
  if (sha256(snapshot.bytes) !== expectedHash) {
    throw recoveryError(`recovery file changed before cleanup: ${path.basename(filePath)}`);
  }
  const claim = createPrivateClaim(paths, {
    scopeToken,
    artifact,
    sourcePath: filePath,
    snapshot,
  });
  deletePrivateClaimValue(paths, claim, { sync, verifyBeforeDestroy });
  return true;
}

function restorePrivateClaim(paths, claim, sourcePath, {
  allowValueMismatch = false,
  verifyBeforeDestroy = null,
} = {}) {
  if (verifyBeforeDestroy !== null && typeof verifyBeforeDestroy !== 'function') {
    throw new TypeError('verifyBeforeDestroy must be a function');
  }
  const intendedSourcePath = path.join(paths.stateDirectory, claim.intent.source);
  if (path.resolve(sourcePath) !== path.resolve(intendedSourcePath)) {
    throw recoveryError(
      'private claim restore target differs from intent: ' + claim.slotName
    );
  }
  let current = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false, allowValueMismatch }
  );
  current = normalizePrivateClaimStage(paths, current, { allowValueMismatch });
  if (!current.value) return false;
  const maximumBytes = maximumClaimBytes(current.intent.artifact);
  let restored;
  try {
    fs.linkSync(current.valuePath, sourcePath);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      restored = readStableRecoverySnapshot(sourcePath, maximumBytes);
      if (!sameRecoverySnapshot(current.value, restored)) {
        return false;
      }
    } else {
      throw recoveryError(`cannot restore private claim: ${current.slotName}`, { cause: error });
    }
  }
  try {
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    throw recoveryError(
      `cannot persist restored private claim source: ${current.slotName}`,
      { cause: error }
    );
  }
  if (!restored) restored = readStableRecoverySnapshot(sourcePath, maximumBytes);
  if (!sameRecoverySnapshot(current.value, restored)) {
    throw recoveryError(`restored private claim identity mismatch: ${current.slotName}`);
  }
  const staged = linkPrivateClaimStage(paths, current, 'restoreGuard');
  const guard = staged.restoreGuard;
  const verifyRestoredBoundary = () => {
    if (verifyBeforeDestroy) verifyBeforeDestroy();
    const sourceNow = readStableRecoverySnapshot(sourcePath, maximumBytes);
    if (!sameRecoverySnapshot(restored, sourceNow)) {
      throw recoveryError(
        `restored private claim changed at release boundary: ${current.slotName}`
      );
    }
  };
  const preserve = (releaseError, message) => {
    try {
      preservePrivateClaimValueFromStage(paths, staged, 'restoreGuard', guard);
    } catch (preservationError) {
      throw recoveryError(`${message}; private claim evidence preservation failed`, {
        cause: preservationError,
        releaseCause: releaseError,
      });
    }
    if (releaseError && releaseError.code === 'SPRINT_RECOVERY_REQUIRED') throw releaseError;
    throw recoveryError(message, { cause: releaseError });
  };
  try {
    const sourceBeforeRelease = readStableRecoverySnapshot(sourcePath, maximumBytes);
    if (!sameRecoverySnapshot(restored, sourceBeforeRelease)) {
      throw recoveryError(`restored private claim changed before release: ${current.slotName}`);
    }
    unlinkVerifiedPrivateClaimEntry(
      paths,
      staged,
      staged.valuePath,
      staged.value,
      'restore value',
      { verifyBeforeDestroy: verifyRestoredBoundary }
    );
    const sourceAfterRelease = readStableRecoverySnapshot(sourcePath, maximumBytes);
    if (!sameRecoverySnapshot(restored, sourceAfterRelease)) {
      throw recoveryError(`restored private claim successor was preserved: ${current.slotName}`);
    }
    const guardBeforeDestroy = readStableRecoverySnapshot(
      staged.restoreGuardPath,
      maximumBytes
    );
    if (!sameRecoverySnapshot(guard, guardBeforeDestroy)) {
      throw recoveryError(`private restore guard changed before destroy: ${current.slotName}`);
    }
    const sourceBeforeDestroy = readStableRecoverySnapshot(sourcePath, maximumBytes);
    if (!sameRecoverySnapshot(sourceAfterRelease, sourceBeforeDestroy)) {
      throw recoveryError(`restored private claim changed before guard destroy: ${current.slotName}`);
    }
    unlinkVerifiedPrivateClaimEntry(
      paths,
      staged,
      staged.restoreGuardPath,
      guardBeforeDestroy,
      'restore guard',
      { verifyBeforeDestroy: verifyRestoredBoundary }
    );
  } catch (error) {
    preserve(error, `cannot release restored private claim value: ${current.slotName}`);
  }
  removePrivateClaimMetadata(paths, staged);
  return true;
}

function recoverPrivateClaimIntentMismatch(paths, claim) {
  if (!claim || !claim.value || claim.valueState !== 'intent-mismatch') return claim;
  const sourcePath = path.join(paths.stateDirectory, claim.intent.source);
  if (!restorePrivateClaim(paths, claim, sourcePath, { allowValueMismatch: true })) {
    throw recoveryError(
      'private claim intent mismatch and source successor were both preserved: '
        + claim.slotName
    );
  }
  return null;
}

function readRecoverablePrivateClaimSlot(paths, scopeToken, artifact, options = {}) {
  let claim = readPrivateClaimSlot(paths, scopeToken, artifact, {
    ...options,
    allowValueMismatch: true,
  });
  claim = normalizePrivateClaimStage(paths, claim, { allowValueMismatch: true });
  return recoverPrivateClaimIntentMismatch(paths, claim);
}

function releaseOwnedLock(paths, ownership) {
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(paths.lockPath, 4096);
  } catch (error) {
    throw sprintStateError('SPRINT_LOCK_RELEASE_CONFLICT', 'cannot verify owned lock before release', {
      cause: error,
    });
  }
  if (!sameFileIdentity(ownership.stat, snapshot.stat)
      || (ownership.ready && snapshot.bytes.toString('utf8') !== ownership.content)) {
    throw sprintStateError('SPRINT_LOCK_RELEASE_CONFLICT', 'lock ownership changed before release', {
      expectedToken: ownership.token,
    });
  }
  let claim;
  try {
    claim = createPrivateClaim(paths, {
      scopeToken: ownership.token,
      artifact: 'lock',
      sourcePath: paths.lockPath,
      snapshot,
    });
    deletePrivateClaimValue(paths, claim, { sync: true });
  } catch (error) {
    if (error && error.code === 'SPRINT_RECOVERY_REQUIRED') {
      throw sprintStateError(
        'SPRINT_LOCK_RELEASE_CONFLICT',
        'owned lock release requires private-claim recovery',
        { cause: error, expectedToken: ownership.token, recoveryRequired: true }
      );
    }
    throw error;
  }
}
function releaseUncommittedOwnedLock(paths, ownership) {
  const snapshot = readStableRecoverySnapshot(paths.lockPath, 4096);
  if (!sameFileIdentity(ownership.stat, snapshot.stat)) {
    throw sprintStateError(
      'SPRINT_LOCK_RELEASE_CONFLICT',
      'uncommitted lock ownership changed before emergency release'
    );
  }
  const slot = claimSlotPaths(paths, ownership.token, 'lock');
  let claim = readPrivateClaimSlot(paths, ownership.token, 'lock');
  if (claim && !claim.empty) {
    throw sprintStateError(
      'SPRINT_LOCK_RELEASE_CONFLICT',
      'uncommitted lock already has ambiguous recovery metadata'
    );
  }
  if (!claim) {
    fs.mkdirSync(slot.slotPath, { mode: 0o700 });
    fs.chmodSync(slot.slotPath, 0o700);
    claim = readPrivateClaimSlot(paths, ownership.token, 'lock', { allowMissing: false });
  }
  const intent = canonicalClaimIntent(paths, {
    scopeToken: ownership.token,
    artifact: 'lock',
    sourcePath: paths.lockPath,
    snapshot,
  });
  // The acquisition fsync already failed, so durable recovery is impossible. This
  // bounded abort path still creates canonical metadata before moving the exact
  // inode and only ever unlinks private children.
  fs.writeFileSync(slot.intentPath, `${JSON.stringify(intent)}\n`, {
    flag: 'wx',
    mode: 0o600,
    encoding: 'utf8',
  });
  fs.renameSync(paths.lockPath, slot.valuePath);
  const moved = readPrivateClaimSlot(paths, ownership.token, 'lock', { allowMissing: false });
  if (!moved.value || !sameFileIdentity(snapshot.stat, moved.value.stat)
      || !snapshot.bytes.equals(moved.value.bytes)) {
    throw sprintStateError(
      'SPRINT_LOCK_RELEASE_CONFLICT',
      'uncommitted lock changed during emergency private claim'
    );
  }
  const valueNow = lstatExactSync(moved.valuePath);
  if (!sameFileIdentity(moved.value.stat, valueNow)
      || valueNow.isSymbolicLink() || !valueNow.isFile()) {
    throw sprintStateError(
      'SPRINT_LOCK_RELEASE_CONFLICT',
      'uncommitted lock private value changed before delete'
    );
  }
  fs.unlinkSync(moved.valuePath);
  if (inspectClaimSource(paths, moved).state !== 'missing') {
    throw sprintStateError(
      'SPRINT_LOCK_RELEASE_CONFLICT',
      'uncommitted lock successor was preserved during emergency release'
    );
  }
  const intentNow = lstatExactSync(moved.intentPath);
  const slotNow = lstatExactSync(moved.slotPath);
  if (!sameFileIdentity(moved.intentStat, intentNow)
      || !sameFileIdentity(moved.slotStat, slotNow)) {
    throw sprintStateError(
      'SPRINT_LOCK_RELEASE_CONFLICT',
      'uncommitted lock metadata identity changed before cleanup'
    );
  }
  fs.unlinkSync(moved.intentPath);
  const remaining = fs.readdirSync(moved.slotPath);
  const slotAfterIntent = lstatExactSync(moved.slotPath);
  if (remaining.length !== 0 || !sameFileIdentity(slotNow, slotAfterIntent)) {
    throw sprintStateError(
      'SPRINT_LOCK_RELEASE_CONFLICT',
      'uncommitted lock private slot did not become empty'
    );
  }
  fs.rmdirSync(moved.slotPath);
}
function closeLockHandle(handle) {
  if (handle === undefined) return null;
  try {
    fs.closeSync(handle);
    return null;
  } catch (error) {
    return error;
  }
}

function withSprintStateLock(cwd, operation) {
  const paths = ensureStateDirectory(cwd);
  recoverStandaloneDeleteClaims(paths, { artifacts: new Set(['lock']) });
  const token = randomStateToken();
  const content = `${JSON.stringify({
    version: 1,
    token,
    pid: process.pid,
    created_at: new Date().toISOString(),
  })}\n`;
  let lockHandle;
  let ownership;
  try {
    lockHandle = fs.openSync(paths.lockPath, 'wx', 0o600);
    ownership = { token, content, stat: fstatExactSync(lockHandle), ready: false };
    fs.writeFileSync(lockHandle, content, 'utf8');
    fs.fsyncSync(lockHandle);
    ownership.ready = true;
  } catch (error) {
    if (lockHandle === undefined && error && error.code === 'EEXIST') {
      throw sprintStateError(
        'SPRINT_STATE_LOCKED',
        `state lock already exists at ${LOCK_RELATIVE_PATH}`
      );
    }
    const closeError = closeLockHandle(lockHandle);
    if (ownership) {
      try {
        if (ownership.ready) releaseOwnedLock(paths, ownership);
        else releaseUncommittedOwnedLock(paths, ownership);
      } catch (releaseError) {
        releaseError.acquisitionError = error;
        releaseError.closeError = closeError;
        throw releaseError;
      }
    }
    throw error;
  }

  let value;
  let operationError;
  try {
    value = operation(paths);
  } catch (error) {
    operationError = error;
  }

  const closeError = closeLockHandle(lockHandle);
  let releaseError;
  try {
    releaseOwnedLock(paths, ownership);
  } catch (error) {
    releaseError = error;
  }
  if (closeError || releaseError) {
    const cause = releaseError || closeError;
    if (cause && cause.code === 'SPRINT_LOCK_RELEASE_CONFLICT') {
      cause.operationError = operationError;
      cause.closeError = closeError;
      throw cause;
    }
    throw sprintStateError('SPRINT_LOCK_RELEASE_FAILED', cause.message, {
      cause,
      operationError,
    });
  }
  if (operationError) throw operationError;
  return value;
}
function readPointerRaw(pointerPath) {
  let stat;
  try {
    stat = lstatExactSync(pointerPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw sprintStateError('INVALID_ACTIVE_SPRINT_POINTER', `cannot inspect pointer: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()
      || statSizeExceeds(stat, MAX_POINTER_BYTES)) {
    throw sprintStateError('INVALID_ACTIVE_SPRINT_POINTER', 'pointer must be a bounded regular file');
  }
  return fs.readFileSync(pointerPath, 'utf8');
}

function validatePlanForState(cwd, value) {
  const plan = normalizePlanPath(cwd, value);
  if (!plan) throw sprintStateError('INVALID_SPRINT_PLAN', 'plan must be a Markdown file inside docs/plans');
  const absolute = path.resolve(cwd, plan);
  const inspection = inspectBoundedWorkspaceFile(
    cwd,
    absolute,
    path.resolve(cwd, 'docs', 'plans'),
    MAX_PLAN_BYTES,
    'plan'
  );
  if (!inspection.ok) {
    throw sprintStateError('INVALID_SPRINT_PLAN', `plan is not safe to activate: ${inspection.reason}`);
  }
  return plan;
}

function readSprintStateSnapshot(cwd, pointerPath) {
  const raw = readPointerRaw(pointerPath);
  if (raw === null) throw sprintStateError('SPRINT_NOT_ACTIVE', 'active sprint pointer is missing');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw sprintStateError('INVALID_ACTIVE_SPRINT_POINTER', 'pointer JSON is invalid');
  }
  const validated = validatePointerSchema(cwd, parsed);
  if (!validated.ok) {
    throw sprintStateError('INVALID_ACTIVE_SPRINT_POINTER', validated.detail, {
      reason: validated.reason,
    });
  }
  const plan = validatePlanForState(cwd, validated.pointer.plan);
  if (validated.pointer.migration_receipt_sha256) {
    readMigrationReceipt(cwd, validated.pointer.migration_receipt_sha256, { targetPlan: plan });
  }
  return {
    raw,
    pointer: { ...validated.pointer, plan },
  };
}
function assertExpectedPhase(pointer, expectedPhase) {
  if (pointer.phase !== expectedPhase) {
    throw sprintStateError(
      'SPRINT_PHASE_CONFLICT',
      `expected current phase ${expectedPhase}, found ${pointer.phase}`,
      { expectedPhase, actualPhase: pointer.phase }
    );
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recoveryError(message, details = {}) {
  return sprintStateError('SPRINT_RECOVERY_REQUIRED', message, details);
}

function assertExactKeys(value, keys, label, code = 'INVALID_SPRINT_MIGRATION') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw sprintStateError(code, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw sprintStateError(code, `${label} fields are invalid`);
  }
  return value;
}

function normalizeSha256(value, label, code = 'INVALID_SPRINT_MIGRATION') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw sprintStateError(code, `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizeEvidencePath(cwd, value, label, code) {
  if (typeof value !== 'string' || !value.trim()) {
    throw sprintStateError(code, `${label} path is required`);
  }
  const stateDirectory = path.resolve(cwd, 'docs', 'plans', '.handoff');
  const absolute = path.resolve(cwd, value.trim());
  if (!isInside(stateDirectory, absolute)
      || path.dirname(absolute) !== stateDirectory
      || path.extname(absolute).toLowerCase() !== '.json') {
    throw sprintStateError(code, `${label} must be a direct JSON child of docs/plans/.handoff`);
  }
  return {
    absolute,
    relative: path.relative(cwd, absolute).replace(/\\/g, '/'),
    stateDirectory,
  };
}

function readCanonicalEvidence(cwd, relativePath, expectedSha256, label, code) {
  const normalized = normalizeEvidencePath(cwd, relativePath, label, code);
  const inspection = inspectBoundedWorkspaceFile(
    cwd,
    normalized.absolute,
    normalized.stateDirectory,
    MAX_MIGRATION_EVIDENCE_BYTES,
    label
  );
  if (!inspection.ok) {
    throw sprintStateError(code, `${label} is not safe to read: ${inspection.reason}`);
  }
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(
      normalized.absolute,
      MAX_MIGRATION_EVIDENCE_BYTES
    );
  } catch (error) {
    throw sprintStateError(code, `${label} changed while reading`, { cause: error });
  }
  const actualSha256 = sha256(snapshot.bytes);
  if (actualSha256 !== normalizeSha256(expectedSha256, `${label} sha256`, code)) {
    throw sprintStateError(code, `${label} sha256 does not match`);
  }
  const raw = snapshot.bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw sprintStateError(code, `${label} JSON is invalid`, { cause: error });
  }
  if (`${JSON.stringify(value)}\n` !== raw) {
    throw sprintStateError(code, `${label} JSON encoding is not canonical`);
  }
  return { ...normalized, snapshot, raw, value, sha256: actualSha256 };
}

function parsePlanTaskIds(value, label) {
  let ids;
  try {
    ids = JSON.parse(value);
  } catch (error) {
    throw sprintStateError(
      'INVALID_SPRINT_PLAN',
      `${label} must be a canonical JSON array`,
      { cause: error }
    );
  }
  if (!Array.isArray(ids)
      || ids.some((id) => typeof id !== 'string' || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(id))
      || new Set(ids).size !== ids.length
      || JSON.stringify(ids) !== value) {
    throw sprintStateError('INVALID_SPRINT_PLAN', `${label} is invalid or non-canonical`);
  }
  return ids;
}

function readCompletionPlanSnapshot(cwd, plan) {
  let normalizedPlan;
  let snapshot;
  try {
    normalizedPlan = validatePlanForState(cwd, plan);
    snapshot = readStableRecoverySnapshot(
      path.resolve(cwd, normalizedPlan),
      MAX_PLAN_BYTES
    );
  } catch (error) {
    throw sprintStateError(
      'ILLEGAL_SPRINT_COMPLETION',
      'completion requires a stable bounded plan snapshot',
      { cause: error }
    );
  }
  const raw = snapshot.bytes.toString('utf8');
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const taskKeys = new Set([
    'tasks_completed', 'tasks_total', 'task_ids', 'open_task_ids',
  ]);
  const fields = new Map();
  if (lines[0] === '---') {
    const endOffset = lines.slice(1, MAX_FRONTMATTER_LINES + 1)
      .findIndex((line) => line === '---');
    if (endOffset < 0) {
      throw sprintStateError(
        'ILLEGAL_SPRINT_COMPLETION',
        'completion plan frontmatter is missing its bounded closing delimiter'
      );
    }
    for (const line of lines.slice(1, endOffset + 1)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indentedField = line.match(/^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
      if (indentedField && taskKeys.has(indentedField[1])) {
        throw sprintStateError(
          'ILLEGAL_SPRINT_COMPLETION',
          `completion plan ${indentedField[1]} must use canonical unindented task metadata`
        );
      }
      if (/^\s/.test(line)) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!match || !taskKeys.has(match[1])) continue;
      if (fields.has(match[1])) {
        throw sprintStateError(
          'ILLEGAL_SPRINT_COMPLETION',
          `completion plan repeats ${match[1]}`
        );
      }
      const scalar = unwrapSimpleScalar(match[2]);
      if (scalar === null || /^(?:[|>&*!{])/.test(scalar)) {
        throw sprintStateError(
          'ILLEGAL_SPRINT_COMPLETION',
          `completion plan ${match[1]} is malformed`
        );
      }
      fields.set(match[1], scalar);
    }
  }
  const digest = sha256(snapshot.bytes);
  if (fields.size === 0) {
    return {
      plan: normalizedPlan,
      raw,
      snapshot,
      proof: {
        mode: 'legacy',
        sha256: digest,
        tasks_completed: null,
        tasks_total: null,
      },
    };
  }
  const hasCompleted = fields.has('tasks_completed');
  const hasTotal = fields.has('tasks_total');
  if (!hasCompleted || !hasTotal) {
    throw sprintStateError(
      'ILLEGAL_SPRINT_COMPLETION',
      'completion requires both tasks_completed and tasks_total when task metadata is declared'
    );
  }
  const countPattern = /^(?:0|[1-9]\d{0,8})$/;
  const completedRaw = fields.get('tasks_completed');
  const totalRaw = fields.get('tasks_total');
  if (!countPattern.test(completedRaw) || !countPattern.test(totalRaw)) {
    throw sprintStateError(
      'ILLEGAL_SPRINT_COMPLETION',
      'completion task counts must be canonical non-negative integers'
    );
  }
  const tasksCompleted = Number(completedRaw);
  const tasksTotal = Number(totalRaw);
  if (tasksCompleted !== tasksTotal) {
    throw sprintStateError(
      'ILLEGAL_SPRINT_COMPLETION',
      `completion requires all declared tasks complete, found ${tasksCompleted}/${tasksTotal}`
    );
  }
  const hasTaskIds = fields.has('task_ids');
  const hasOpenTaskIds = fields.has('open_task_ids');
  if (hasTaskIds !== hasOpenTaskIds) {
    throw sprintStateError(
      'ILLEGAL_SPRINT_COMPLETION',
      'completion requires task_ids and open_task_ids to be declared together'
    );
  }
  if (hasTaskIds) {
    let taskIds;
    let openTaskIds;
    try {
      taskIds = parsePlanTaskIds(fields.get('task_ids'), 'completion plan task_ids');
      openTaskIds = parsePlanTaskIds(
        fields.get('open_task_ids'),
        'completion plan open_task_ids'
      );
    } catch (error) {
      throw sprintStateError(
        'ILLEGAL_SPRINT_COMPLETION',
        'completion task identity metadata is invalid',
        { cause: error }
      );
    }
    const taskIdSet = new Set(taskIds);
    if (taskIds.length !== tasksTotal
        || openTaskIds.length !== 0
        || openTaskIds.some((id) => !taskIdSet.has(id))) {
      throw sprintStateError(
        'ILLEGAL_SPRINT_COMPLETION',
        'completion task identities do not prove an empty open-task set'
      );
    }
  }
  return {
    plan: normalizedPlan,
    raw,
    snapshot,
    proof: {
      mode: 'declared',
      sha256: digest,
      tasks_completed: tasksCompleted,
      tasks_total: tasksTotal,
    },
  };
}

function assertCompletionPlanProof(cwd, plan, proof) {
  const value = assertExactKeys(
    proof,
    ['mode', 'sha256', 'tasks_completed', 'tasks_total'],
    'completion plan proof',
    'SPRINT_RECOVERY_REQUIRED'
  );
  normalizeSha256(
    value.sha256,
    'completion plan proof sha256',
    'SPRINT_RECOVERY_REQUIRED'
  );
  const validLegacy = value.mode === 'legacy'
    && value.tasks_completed === null
    && value.tasks_total === null;
  const validDeclared = value.mode === 'declared'
    && Number.isSafeInteger(value.tasks_completed)
    && Number.isSafeInteger(value.tasks_total)
    && value.tasks_completed >= 0
    && value.tasks_completed === value.tasks_total;
  if (!validLegacy && !validDeclared) {
    throw recoveryError('completion plan proof schema is invalid');
  }
  let current;
  try {
    current = readCompletionPlanSnapshot(cwd, plan);
  } catch (error) {
    throw recoveryError('completion plan no longer proves terminal task state', {
      cause: error,
    });
  }
  if (JSON.stringify(current.proof) !== JSON.stringify(value)) {
    throw recoveryError('completion plan changed after terminal task validation');
  }
  return current;
}

function readPlanMigrationSnapshot(cwd, plan, expectedSha256, label) {
  const normalizedPlan = validatePlanForState(cwd, plan);
  const absolute = path.resolve(cwd, normalizedPlan);
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(absolute, MAX_PLAN_BYTES);
  } catch (error) {
    throw sprintStateError('INVALID_SPRINT_PLAN', `${label} changed while reading`, { cause: error });
  }
  const actualSha256 = sha256(snapshot.bytes);
  if (actualSha256 !== normalizeSha256(
    expectedSha256,
    `${label} sha256`,
    'INVALID_SPRINT_PLAN'
  )) {
    throw sprintStateError('INVALID_SPRINT_PLAN', `${label} sha256 does not match`);
  }
  const raw = snapshot.bytes.toString('utf8');
  const meta = parseActiveSprintFrontmatter(raw).meta || {};
  const tasksCompleted = parseCount(meta.tasks_completed);
  const tasksTotal = parseCount(meta.tasks_total);
  if (tasksCompleted === null || tasksTotal === null || tasksCompleted > tasksTotal) {
    throw sprintStateError(
      'INVALID_SPRINT_PLAN',
      `${label} requires valid tasks_completed/tasks_total frontmatter`
    );
  }
  const taskIds = parsePlanTaskIds(meta.task_ids, `${label} task_ids`);
  const openTaskIds = parsePlanTaskIds(meta.open_task_ids, `${label} open_task_ids`);
  const taskIdSet = new Set(taskIds);
  if (taskIds.length !== tasksTotal
      || openTaskIds.length !== tasksTotal - tasksCompleted
      || openTaskIds.some((id) => !taskIdSet.has(id))) {
    throw sprintStateError(
      'INVALID_SPRINT_PLAN',
      `${label} task_ids/open_task_ids do not match the declared counts`
    );
  }
  const openTaskIdSet = new Set(openTaskIds);
  return {
    absolute,
    plan: normalizedPlan,
    raw,
    sha256: actualSha256,
    snapshot,
    status: String(meta.status || ''),
    tasksCompleted,
    tasksTotal,
    taskIds,
    completedTaskIds: taskIds.filter((id) => !openTaskIdSet.has(id)),
    openTaskIds,
  };
}

function assertSupersessionPlanSnapshots(paths, receiptValue, targetPlan) {
  if (!receiptValue || receiptValue.kind !== 'supersede_with_open_tasks') {
    throw recoveryError('supersession WAL has no validated receipt plan proof');
  }
  try {
    const source = readPlanMigrationSnapshot(
      paths.workspace,
      receiptValue.source.plan,
      receiptValue.source.plan_sha256,
      'supersession source plan'
    );
    const target = readPlanMigrationSnapshot(
      paths.workspace,
      receiptValue.target.plan,
      receiptValue.target.plan_sha256,
      'supersession target plan'
    );
    assertDistinctSupersessionPlanIdentity(paths.workspace, source.plan, target.plan, {
      code: 'SPRINT_RECOVERY_REQUIRED',
      sourceStat: source.snapshot.stat,
      targetStat: target.snapshot.stat,
    });
    if (target.plan !== targetPlan
        || source.tasksCompleted !== receiptValue.source.tasks_completed
        || source.tasksTotal !== receiptValue.source.tasks_total
        || target.tasksCompleted !== receiptValue.target.tasks_completed
        || target.tasksTotal !== receiptValue.target.tasks_total) {
      throw new Error('supersession plan task state differs from receipt');
    }
    return { source, target };
  } catch (error) {
    if (error && error.code === 'SPRINT_RECOVERY_REQUIRED') throw error;
    throw recoveryError('supersession plan snapshots changed after approval', {
      cause: error,
    });
  }
}

function validateTaskMap(value, sourcePlan, targetPlan) {
  const code = 'INVALID_SPRINT_TASK_MAP';
  assertExactKeys(value, [
    'schema_version', 'source', 'target', 'source_tasks', 'target_tasks',
    'goal_preserved',
  ], 'task map', code);
  if (value.schema_version !== 'sprint-task-map/v1' || value.goal_preserved !== true) {
    throw sprintStateError(code, 'task map schema or goal preservation is invalid');
  }
  for (const [side, expected] of [['source', sourcePlan], ['target', targetPlan]]) {
    const item = assertExactKeys(
      value[side],
      ['plan', 'plan_sha256', 'tasks_completed', 'tasks_total'],
      `task map ${side}`,
      code
    );
    if (item.plan !== expected.plan
        || item.plan_sha256 !== expected.sha256
        || item.tasks_completed !== expected.tasksCompleted
        || item.tasks_total !== expected.tasksTotal) {
      throw sprintStateError(code, `task map ${side} does not match the plan snapshot`);
    }
  }
  if (!Array.isArray(value.source_tasks)
      || value.source_tasks.length !== sourcePlan.tasksTotal
      || !Array.isArray(value.target_tasks)
      || value.target_tasks.length !== targetPlan.tasksTotal) {
    throw sprintStateError(code, 'task map counts do not match plan totals');
  }
  const sourceById = new Map();
  for (const task of value.source_tasks) {
    assertExactKeys(task, ['id', 'disposition', 'target_ids'], 'source task', code);
    if (typeof task.id !== 'string' || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(task.id)
        || sourceById.has(task.id) || !Array.isArray(task.target_ids)
        || new Set(task.target_ids).size !== task.target_ids.length) {
      throw sprintStateError(code, 'source task identity or targets are invalid');
    }
    if (!['preserved_completed', 'migrated_open'].includes(task.disposition)) {
      throw sprintStateError(code, `source task ${task.id} has an invalid disposition`);
    }
    if ((task.disposition === 'preserved_completed' && task.target_ids.length !== 0)
        || (task.disposition === 'migrated_open' && task.target_ids.length === 0)) {
      throw sprintStateError(code, `source task ${task.id} has invalid carry-forward targets`);
    }
    sourceById.set(task.id, task);
  }
  if (sourcePlan.taskIds.some((id) => !sourceById.has(id))
      || [...sourceById].some(([id]) => !sourcePlan.taskIds.includes(id))) {
    throw sprintStateError(code, 'task map does not cover every source task exactly once');
  }
  const completed = [...sourceById.values()]
    .filter((task) => task.disposition === 'preserved_completed');
  const open = [...sourceById.values()]
    .filter((task) => task.disposition === 'migrated_open');
  if (completed.length !== sourcePlan.tasksCompleted
      || open.length !== sourcePlan.tasksTotal - sourcePlan.tasksCompleted
      || open.length === 0) {
    throw sprintStateError(code, 'task map source dispositions do not preserve open work');
  }
  for (const id of sourcePlan.completedTaskIds) {
    if (sourceById.get(id).disposition !== 'preserved_completed') {
      throw sprintStateError(code, `completed plan task ${id} cannot be migrated as open`);
    }
  }
  for (const id of sourcePlan.openTaskIds) {
    if (sourceById.get(id).disposition !== 'migrated_open') {
      throw sprintStateError(code, `open plan task ${id} must be migrated`);
    }
  }

  const targetById = new Map();
  for (const task of value.target_tasks) {
    assertExactKeys(task, ['id', 'status', 'origin', 'source_ids'], 'target task', code);
    if (typeof task.id !== 'string' || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(task.id)
        || targetById.has(task.id) || task.status !== 'open'
        || !['added', 'migrated'].includes(task.origin)
        || !Array.isArray(task.source_ids)
        || new Set(task.source_ids).size !== task.source_ids.length) {
      throw sprintStateError(code, 'target task identity, status, or origin is invalid');
    }
    if ((task.origin === 'added' && task.source_ids.length !== 0)
        || (task.origin === 'migrated' && task.source_ids.length === 0)) {
      throw sprintStateError(code, `target task ${task.id} has invalid source bindings`);
    }
    targetById.set(task.id, task);
  }
  if (targetPlan.taskIds.some((id) => !targetById.has(id))
      || [...targetById].some(([id]) => !targetPlan.taskIds.includes(id))) {
    throw sprintStateError(code, 'task map does not cover every target task exactly once');
  }
  for (const sourceTask of open) {
    for (const targetId of sourceTask.target_ids) {
      const targetTask = targetById.get(targetId);
      if (!targetTask || targetTask.origin !== 'migrated'
          || !targetTask.source_ids.includes(sourceTask.id)) {
        throw sprintStateError(code, `source task ${sourceTask.id} has a broken mapping edge`);
      }
    }
  }
  for (const targetTask of targetById.values()) {
    for (const sourceId of targetTask.source_ids) {
      const sourceTask = sourceById.get(sourceId);
      if (!sourceTask || sourceTask.disposition !== 'migrated_open'
          || !sourceTask.target_ids.includes(targetTask.id)) {
        throw sprintStateError(code, `target task ${targetTask.id} has a broken mapping edge`);
      }
    }
  }
  return {
    value,
    openTaskIds: [...sourcePlan.openTaskIds],
  };
}

function validateOwnerApproval(value, context) {
  const code = 'INVALID_SPRINT_APPROVAL';
  assertExactKeys(value, [
    'schema_version', 'decision', 'trust_boundary', 'cryptographic_verification',
    'source_assurance', 'message_locator', 'issued_at', 'expires_at',
    'source', 'target', 'task_map_sha256', 'goal_preserved',
  ], 'owner approval', code);
  if (value.schema_version !== 'sprint-owner-approval/v2'
      || value.decision !== 'approve_supersede'
      || value.trust_boundary !== 'local_host_observation'
      || value.cryptographic_verification !== false
      || value.source_assurance !== 'explicit'
      || value.goal_preserved !== true) {
    throw sprintStateError(code, 'owner approval decision or assurance is invalid');
  }
  const locator = assertExactKeys(value.message_locator, [
    'schema_version', 'thread_id', 'locator', 'message_sha256', 'hash_profile',
  ], 'owner approval message locator', code);
  if (locator.schema_version !== 'sprint-message-locator/v1'
      || locator.hash_profile !== 'sha256-utf8-v1') {
    throw sprintStateError(code, 'owner approval message locator schema is invalid');
  }
  let threadId;
  let messageLocation;
  try {
    threadId = normalizeStateText(locator.thread_id, 'owner approval message thread_id');
    messageLocation = normalizeStateText(locator.locator, 'owner approval message locator');
  } catch (error) {
    throw sprintStateError(code, 'owner approval message locator text is invalid', {
      cause: error,
    });
  }
  if (threadId !== locator.thread_id || messageLocation !== locator.locator) {
    throw sprintStateError(code, 'owner approval message locator text is not canonical');
  }
  const messageSha256 = normalizeSha256(
    locator.message_sha256,
    'owner approval message_sha256',
    code
  );
  const expectedMessageLocation = `thread:${threadId}#message-sha256:${messageSha256}`;
  if (messageLocation !== expectedMessageLocation) {
    throw sprintStateError(
      code,
      'owner approval message locator is not bound to its thread and message digest'
    );
  }
  let issuedAt;
  let expiresAt;
  try {
    issuedAt = normalizeStateTimestamp(value.issued_at);
    expiresAt = normalizeStateTimestamp(value.expires_at);
  } catch (error) {
    throw sprintStateError(code, 'owner approval timestamps are invalid', { cause: error });
  }
  if (typeof value.issued_at !== 'string' || issuedAt !== value.issued_at
      || typeof value.expires_at !== 'string' || expiresAt !== value.expires_at) {
    throw sprintStateError(code, 'owner approval timestamps are not canonical');
  }
  const effectiveAt = Date.parse(context.observedAt);
  if (Date.parse(issuedAt) > effectiveAt || effectiveAt > Date.parse(expiresAt)) {
    throw sprintStateError(code, 'owner approval is not currently valid');
  }
  const source = assertExactKeys(value.source, [
    'pointer_sha256', 'plan', 'plan_sha256', 'phase', 'status',
    'tasks_completed', 'tasks_total', 'open_task_ids',
  ], 'owner approval source', code);
  const target = assertExactKeys(value.target, [
    'plan', 'plan_sha256', 'phase', 'status', 'acceptance_protocol',
    'tasks_completed', 'tasks_total', 'next',
  ], 'owner approval target', code);
  if (!Array.isArray(source.open_task_ids)
      || source.open_task_ids.some((id) => typeof id !== 'string')
      || new Set(source.open_task_ids).size !== source.open_task_ids.length) {
    throw sprintStateError(code, 'owner approval source open_task_ids are invalid');
  }
  if (source.pointer_sha256 !== context.pointerSha256
      || source.plan !== context.sourcePlan.plan
      || source.plan_sha256 !== context.sourcePlan.sha256
      || source.phase !== 'compound' || source.status !== 'blocked'
      || source.tasks_completed !== context.sourcePlan.tasksCompleted
      || source.tasks_total !== context.sourcePlan.tasksTotal
      || JSON.stringify(source.open_task_ids) !== JSON.stringify(context.openTaskIds)
      || target.plan !== context.targetPlan.plan
      || target.plan_sha256 !== context.targetPlan.sha256
      || target.phase !== 'think' || target.status !== 'active'
      || target.acceptance_protocol !== 'v1'
      || target.tasks_completed !== context.targetPlan.tasksCompleted
      || target.tasks_total !== context.targetPlan.tasksTotal
      || target.next !== context.next
      || value.task_map_sha256 !== context.taskMapSha256) {
    throw sprintStateError(code, 'owner approval is not bound to this supersession');
  }
  return value;
}

function migrationReceiptDirectory(cwd) {
  return path.resolve(cwd, MIGRATION_RECEIPT_DIRECTORY_RELATIVE_PATH);
}

function migrationReceiptFile(cwd, digest) {
  return path.join(
    migrationReceiptDirectory(cwd),
    `${MIGRATION_RECEIPT_FILE_PREFIX}${digest}.json`
  );
}

function validateMigrationReceiptValue(cwd, value, { targetPlan } = {}) {
  const code = 'INVALID_SPRINT_MIGRATION_RECEIPT';
  const timestampField = value && value.schema_version === 'sprint-migration-receipt/v2'
    ? 'prepared_at' : 'observed_at';
  assertExactKeys(value, [
    'schema_version', 'kind', 'source', 'target', 'task_map', 'approval',
    'previous_migration_receipt_sha256', timestampField, 'goal_preserved',
  ], 'migration receipt', code);
  if (!['sprint-migration-receipt/v1', 'sprint-migration-receipt/v2']
    .includes(value.schema_version)
      || value.kind !== 'supersede_with_open_tasks'
      || value.goal_preserved !== true) {
    throw sprintStateError(code, 'migration receipt header is invalid');
  }
  const source = assertExactKeys(value.source, [
    'status', 'pointer_sha256', 'pointer_raw', 'pointer', 'plan', 'plan_sha256',
    'tasks_completed', 'tasks_total', 'open_task_ids',
  ], 'migration receipt source', code);
  const target = assertExactKeys(value.target, [
    'plan', 'plan_sha256', 'phase', 'status', 'acceptance_protocol',
    'tasks_completed', 'tasks_total', 'next',
  ], 'migration receipt target', code);
  const taskMap = assertExactKeys(
    value.task_map,
    ['path', 'sha256', 'value'],
    'migration receipt task_map',
    code
  );
  const approval = assertExactKeys(
    value.approval,
    ['path', 'sha256', 'value'],
    'migration receipt approval',
    code
  );
  normalizeSha256(source.pointer_sha256, 'receipt source pointer sha256', code);
  normalizeSha256(source.plan_sha256, 'receipt source plan sha256', code);
  normalizeSha256(target.plan_sha256, 'receipt target plan sha256', code);
  normalizeSha256(taskMap.sha256, 'receipt task map sha256', code);
  normalizeSha256(approval.sha256, 'receipt approval sha256', code);
  const evidenceAt = normalizeStateTimestamp(value[timestampField]);
  if (evidenceAt !== value[timestampField]) {
    throw sprintStateError(code, `migration receipt ${timestampField} is not canonical`);
  }
  if (typeof source.pointer_raw !== 'string'
      || sha256(source.pointer_raw) !== source.pointer_sha256) {
    throw sprintStateError(code, 'migration receipt source pointer proof is invalid');
  }
  let rawPointer;
  try {
    rawPointer = JSON.parse(source.pointer_raw);
  } catch (error) {
    throw sprintStateError(code, 'migration receipt source pointer JSON is invalid', { cause: error });
  }
  const validatedPointer = validatePointerSchema(cwd, rawPointer);
  if (!validatedPointer.ok
      || JSON.stringify(validatedPointer.pointer) !== JSON.stringify(source.pointer)
      || `${JSON.stringify(rawPointer)}\n` !== source.pointer_raw
      || source.pointer.plan !== source.plan) {
    throw sprintStateError(code, 'migration receipt source pointer is not canonical');
  }
  const normalizedSourcePlan = normalizePlanPath(cwd, source.plan);
  const normalizedTargetPlan = normalizePlanPath(cwd, target.plan);
  if (normalizedSourcePlan && normalizedSourcePlan === source.plan
      && normalizedTargetPlan && normalizedTargetPlan === target.plan) {
    assertDistinctSupersessionPlanIdentity(cwd, normalizedSourcePlan, normalizedTargetPlan, {
      code,
    });
  }
  const openTaskIdsValid = Array.isArray(source.open_task_ids)
    && source.open_task_ids.length > 0
    && source.open_task_ids.every((id) => (
      typeof id === 'string' && /^[A-Z][A-Z0-9_-]{0,31}$/.test(id)
    ))
    && new Set(source.open_task_ids).size === source.open_task_ids.length;
  if (!normalizedSourcePlan || normalizedSourcePlan !== source.plan
      || !normalizedTargetPlan || normalizedTargetPlan !== target.plan
      || (targetPlan && target.plan !== targetPlan)
      || source.pointer.phase !== 'compound' || source.pointer.status !== 'blocked'
      || target.phase !== 'think' || target.status !== 'active'
      || target.acceptance_protocol !== 'v1'
      || normalizeStateText(target.next, 'migration receipt target next') !== target.next
      || target.tasks_completed !== 0
      || !Number.isInteger(target.tasks_total) || target.tasks_total <= 0
      || source.status !== 'superseded_with_open_tasks'
      || !Number.isInteger(source.tasks_completed) || source.tasks_completed < 0
      || !Number.isInteger(source.tasks_total)
      || source.tasks_total <= source.tasks_completed
      || !openTaskIdsValid
      || source.tasks_total - source.tasks_completed !== source.open_task_ids.length
      || value.previous_migration_receipt_sha256 !== (
        source.pointer.migration_receipt_sha256 || null
      )) {
    throw sprintStateError(code, 'migration receipt lineage or task state is invalid');
  }
  if (value.previous_migration_receipt_sha256 !== null) {
    normalizeSha256(
      value.previous_migration_receipt_sha256,
      'previous migration receipt sha256',
      code
    );
  }
  normalizeEvidencePath(cwd, taskMap.path, 'receipt task map', code);
  normalizeEvidencePath(cwd, approval.path, 'receipt approval', code);
  const taskMapRaw = `${JSON.stringify(taskMap.value)}\n`;
  const approvalRaw = `${JSON.stringify(approval.value)}\n`;
  if (sha256(taskMapRaw) !== taskMap.sha256 || sha256(approvalRaw) !== approval.sha256) {
    throw sprintStateError(code, 'embedded migration evidence digest is invalid');
  }
  if (!taskMap.value || !Array.isArray(taskMap.value.source_tasks)
      || !Array.isArray(taskMap.value.target_tasks)) {
    throw sprintStateError(code, 'embedded task map is invalid');
  }
  const embeddedSourcePlan = {
    plan: source.plan,
    sha256: source.plan_sha256,
    tasksCompleted: source.tasks_completed,
    tasksTotal: source.tasks_total,
    taskIds: taskMap.value.source_tasks.map((task) => task && task.id),
    completedTaskIds: taskMap.value.source_tasks
      .filter((task) => task && task.disposition === 'preserved_completed')
      .map((task) => task.id),
    openTaskIds: [...source.open_task_ids],
  };
  const embeddedTargetPlan = {
    plan: target.plan,
    sha256: target.plan_sha256,
    tasksCompleted: target.tasks_completed,
    tasksTotal: target.tasks_total,
    taskIds: taskMap.value.target_tasks.map((task) => task && task.id),
    completedTaskIds: [],
    openTaskIds: taskMap.value.target_tasks.map((task) => task && task.id),
  };
  let validatedTaskMap;
  try {
    validatedTaskMap = validateTaskMap(
      taskMap.value,
      embeddedSourcePlan,
      embeddedTargetPlan
    );
    validateOwnerApproval(approval.value, {
      observedAt: evidenceAt,
      pointerSha256: source.pointer_sha256,
      sourcePlan: embeddedSourcePlan,
      targetPlan: embeddedTargetPlan,
      taskMapSha256: taskMap.sha256,
      openTaskIds: validatedTaskMap.openTaskIds,
      next: target.next,
    });
  } catch (error) {
    throw sprintStateError(code, 'embedded migration evidence is invalid', { cause: error });
  }
  if (JSON.stringify(validatedTaskMap.openTaskIds)
      !== JSON.stringify(source.open_task_ids)) {
    throw sprintStateError(code, 'receipt open task ids differ from the embedded task map');
  }
  return value;
}

function assertMigrationReceiptReference(cwd, relativePath, digest) {
  const code = 'INVALID_SPRINT_MIGRATION_RECEIPT';
  const normalizedDigest = normalizeSha256(digest, 'migration receipt sha256', code);
  const normalized = normalizeEvidencePath(cwd, relativePath, 'migration receipt', code);
  const expected = migrationReceiptFile(cwd, normalizedDigest);
  if (normalized.absolute !== expected
      || path.basename(normalized.absolute)
        !== `${MIGRATION_RECEIPT_FILE_PREFIX}${normalizedDigest}.json`) {
    throw sprintStateError(
      code,
      'migration receipt path must be the content-addressed direct child derived from its sha256'
    );
  }
  return { ...normalized, digest: normalizedDigest };
}

function readMigrationReceipt(cwd, digest, options = {}) {
  const normalizedDigest = normalizeSha256(
    digest,
    'migration receipt sha256',
    'INVALID_SPRINT_MIGRATION_RECEIPT'
  );
  const lineage = Array.isArray(options.lineage) ? options.lineage : [];
  if (lineage.includes(normalizedDigest) || lineage.length >= 64) {
    throw sprintStateError(
      'INVALID_SPRINT_MIGRATION_RECEIPT',
      'migration receipt lineage is cyclic or exceeds the bounded depth'
    );
  }
  const directory = migrationReceiptDirectory(cwd);
  const file = options.path
    ? assertMigrationReceiptReference(cwd, options.path, normalizedDigest).absolute
    : migrationReceiptFile(cwd, normalizedDigest);
  const inspection = inspectBoundedWorkspaceFile(
    cwd,
    file,
    directory,
    MAX_MIGRATION_EVIDENCE_BYTES,
    'migration-receipt'
  );
  if (!inspection.ok) {
    throw sprintStateError(
      'INVALID_SPRINT_MIGRATION_RECEIPT',
      `migration receipt is unavailable: ${inspection.reason}`
    );
  }
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(file, MAX_MIGRATION_EVIDENCE_BYTES);
  } catch (error) {
    throw sprintStateError(
      'INVALID_SPRINT_MIGRATION_RECEIPT',
      'migration receipt changed while reading',
      { cause: error }
    );
  }
  if (sha256(snapshot.bytes) !== normalizedDigest) {
    throw sprintStateError('INVALID_SPRINT_MIGRATION_RECEIPT', 'migration receipt hash is invalid');
  }
  const raw = snapshot.bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw sprintStateError(
      'INVALID_SPRINT_MIGRATION_RECEIPT',
      'migration receipt JSON is invalid',
      { cause: error }
    );
  }
  if (`${JSON.stringify(value)}\n` !== raw) {
    throw sprintStateError(
      'INVALID_SPRINT_MIGRATION_RECEIPT',
      'migration receipt encoding is not canonical'
    );
  }
  validateMigrationReceiptValue(cwd, value, options);
  if (value.previous_migration_receipt_sha256) {
    const previous = readMigrationReceipt(
      cwd,
      value.previous_migration_receipt_sha256,
      {
        targetPlan: value.source.plan,
        lineage: [...lineage, normalizedDigest],
      }
    );
    if (previous.digest !== value.previous_migration_receipt_sha256
        || previous.value.target.plan !== value.source.plan) {
      throw sprintStateError(
        'INVALID_SPRINT_MIGRATION_RECEIPT',
        'previous migration receipt does not terminate at the current source plan identity'
      );
    }
  }
  return { digest: normalizedDigest, path: file, raw, value, snapshot };
}

function prepareTransactionMigrationReceipt(paths, transaction) {
  const proof = transaction && transaction.migrationReceipt;
  if (!proof || !['prepare', 'reference'].includes(proof.mode)) return null;
  let receipt;
  try {
    receipt = readMigrationReceipt(paths.workspace, proof.sha256, {
      targetPlan: transaction.value.plan,
      ...(proof.path ? { path: proof.path } : {}),
    });
  } catch (error) {
    throw recoveryError('migration receipt reference is unavailable or invalid', { cause: error });
  }
  if (receipt.raw !== proof.raw) {
    throw recoveryError('migration receipt readback differs from WAL proof');
  }
  if (transaction.migrationReceiptStagePath) {
    const stageRaw = readOptionalRecoveryFile(
      transaction.migrationReceiptStagePath,
      MAX_MIGRATION_EVIDENCE_BYTES
    );
    if (stageRaw !== null) {
      if (stageRaw !== proof.raw) {
        throw recoveryError('legacy migration receipt stage differs from WAL proof');
      }
      removeVerifiedRecoveryFile(
        transaction.migrationReceiptStagePath,
        proof.sha256,
        paths.stateDirectory,
        {
          sync: true,
          scopeToken: transaction.value.token,
          artifact: 'migration-receipt-stage',
          maximumBytes: MAX_MIGRATION_EVIDENCE_BYTES,
        }
      );
    }
  }
  return receipt;
}

function readOptionalRecoveryFile(filePath, maximumBytes = MAX_RECOVERY_BYTES) {
  let stat;
  try {
    stat = lstatExactSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw recoveryError(`cannot inspect recovery file ${path.basename(filePath)}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()
      || statSizeExceeds(stat, maximumBytes)) {
    throw recoveryError(`recovery file ${path.basename(filePath)} is not a bounded regular file`);
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw recoveryError(`cannot read recovery file ${path.basename(filePath)}`, { cause: error });
  }
}

function attachCreatedFileIdentity(error, identity, filePath) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (identity) {
    failure.sprintCreatedFileIdentity = identity;
    failure.sprintCreatedFilePath = path.resolve(filePath);
  }
  return failure;
}

function writeDurableExclusive(filePath, raw, directory) {
  let handle;
  let identity;
  let failure;
  try {
    handle = fs.openSync(filePath, 'wx', 0o600);
    const stat = fstatExactSync(handle);
    if (!stat.isFile()) throw new Error('exclusive state target is not a regular file');
    identity = requireUsableFileIdentity(stat);
    fs.writeFileSync(handle, raw, 'utf8');
    fs.fsyncSync(handle);
  } catch (error) {
    failure = error;
  }
  if (handle !== undefined) {
    try {
      fs.closeSync(handle);
    } catch (error) {
      if (!failure) failure = error;
      else failure.closeCause = error;
    }
  }
  if (failure) throw attachCreatedFileIdentity(failure, identity, filePath);
  try {
    fsyncDirectoryIfSupported(directory);
  } catch (error) {
    throw attachCreatedFileIdentity(error, identity, filePath);
  }
  return identity;
}

function removeOwnedStagedExclusiveFile(stagePath, identity, directory) {
  if (!identity) return false;
  let current;
  try {
    current = lstatExactSync(stagePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (current.isSymbolicLink() || !current.isFile()
      || !sameFileIdentity(current, identity)) {
    return false;
  }
  fs.unlinkSync(stagePath);
  fsyncDirectoryIfSupported(directory);
  return true;
}

function writeDurableStagedExclusive(filePath, raw, directory, scopeToken) {
  if (!/^[a-f0-9]{32}$/.test(scopeToken || '')) {
    throw new TypeError('staged exclusive write requires a canonical scope token');
  }
  const stagePath = path.join(
    directory,
    `.${path.basename(filePath)}.stage-${scopeToken}-${randomStateToken()}.tmp`
  );
  const expected = Buffer.from(raw, 'utf8');
  let stageIdentity;
  try {
    stageIdentity = writeDurableExclusive(stagePath, raw, directory);
    const staged = readStableRecoverySnapshot(stagePath, expected.length);
    if (!sameFileIdentity(stageIdentity, staged.stat) || !staged.bytes.equals(expected)) {
      throw recoveryError('staged exclusive write differs from intended bytes');
    }

    let linked = false;
    try {
      fs.linkSync(stagePath, filePath);
      linked = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    fsyncDirectoryIfSupported(path.dirname(filePath));

    const committed = readStableRecoverySnapshot(filePath, expected.length);
    if (!committed.bytes.equals(expected)
        || (linked && !sameFileIdentity(staged.stat, committed.stat))) {
      throw recoveryError('exclusive final readback differs from staged bytes');
    }
    removeOwnedStagedExclusiveFile(stagePath, stageIdentity, directory);
    return committed.stat;
  } catch (error) {
    const createdIdentity = stageIdentity
      || (error && error.sprintCreatedFileIdentity);
    try {
      removeOwnedStagedExclusiveFile(stagePath, createdIdentity, directory);
    } catch (cleanupError) {
      if (error && typeof error === 'object') error.cleanupCause = cleanupError;
    }
    throw error;
  }
}

function parseTransaction(paths, raw) {
  const transactionSize = Buffer.byteLength(raw, 'utf8');
  if (transactionSize > MAX_TRANSACTION_BYTES) {
    throw recoveryError('active sprint transaction exceeds recovery budget');
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw recoveryError('active sprint transaction JSON is invalid', { cause: error });
  }
  const tokenPattern = /^[a-f0-9]{32}$/;
  const hashPattern = /^[a-f0-9]{64}$/;
  const supportedVersions = new Set([
    LEGACY_TRANSACTION_VERSION,
    PAYLOAD_TRANSACTION_VERSION,
    TRANSACTION_VERSION,
    LINEAGE_TRANSACTION_VERSION,
    SUPERSESSION_TRANSACTION_VERSION,
    COMPLETION_TRANSACTION_VERSION,
    INIT_COMPLETION_TRANSACTION_VERSION,
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !supportedVersions.has(value.version)
      || !tokenPattern.test(value.token || '')) {
    throw recoveryError('active sprint transaction header is invalid');
  }
  if (![
    LINEAGE_TRANSACTION_VERSION,
    SUPERSESSION_TRANSACTION_VERSION,
    COMPLETION_TRANSACTION_VERSION,
  ].includes(value.version)
      && transactionSize > MAX_RECOVERY_BYTES) {
    throw recoveryError('legacy active sprint transaction exceeds recovery budget');
  }
  const expectedKeys = value.version === LEGACY_TRANSACTION_VERSION
    ? LEGACY_TRANSACTION_KEYS
    : (value.version === COMPLETION_TRANSACTION_VERSION
      ? COMPLETION_TRANSACTION_KEYS
      : (value.version === INIT_COMPLETION_TRANSACTION_VERSION
        ? INIT_COMPLETION_TRANSACTION_KEYS
        : ([LINEAGE_TRANSACTION_VERSION, SUPERSESSION_TRANSACTION_VERSION].includes(value.version)
          ? LINEAGE_TRANSACTION_KEYS
          : TRANSACTION_KEYS)));
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw recoveryError('active sprint transaction fields are invalid');
  }
  if (`${JSON.stringify(value)}\n` !== raw) {
    throw recoveryError('active sprint transaction encoding is not canonical');
  }
  if (!['init', 'replace', 'supersede', 'complete'].includes(value.operation)) {
    throw recoveryError('active sprint transaction operation is invalid');
  }
  if (value.operation === 'supersede'
      && value.version !== SUPERSESSION_TRANSACTION_VERSION) {
    throw recoveryError('supersede transaction version is invalid');
  }
  if (value.version === COMPLETION_TRANSACTION_VERSION
      && value.operation !== 'complete') {
    throw recoveryError('completion proof transaction operation is invalid');
  }
  if (value.version === INIT_COMPLETION_TRANSACTION_VERSION
      && value.operation !== 'init') {
    throw recoveryError('init prior-completion transaction operation is invalid');
  }
  const privatePaths = value.version >= TRANSACTION_VERSION;
  const expectedClaim = value.operation === 'init'
    ? null
    : (privatePaths
      ? `${claimSlotName(value.token, 'pointer')}/${CLAIM_VALUE_FILE}`
      : `active-sprint.claim-${value.token}.json`);
  const expectedPublish = value.operation === 'complete'
    ? null : `active-sprint.publish-${value.token}.json`;
  const expectedPartial = value.operation === 'complete'
    ? null
    : (privatePaths
      ? `${claimSlotName(value.token, 'partial')}/${CLAIM_VALUE_FILE}`
      : `active-sprint.publish-${value.token}.partial`);
  if (value.claim !== expectedClaim || value.publish !== expectedPublish) {
    throw recoveryError('active sprint transaction paths are invalid');
  }
  if (value.version !== LEGACY_TRANSACTION_VERSION && value.partial !== expectedPartial) {
    throw recoveryError('active sprint transaction partial path is invalid');
  }
  const plan = normalizePlanPath(paths.workspace, value.plan);
  if (!plan || plan !== value.plan || !VALID_PHASES.has(value.phase)) {
    throw recoveryError('active sprint transaction state is invalid');
  }
  let startedAt;
  try {
    startedAt = normalizeStateTimestamp(value.started_at);
  } catch (error) {
    throw recoveryError('active sprint transaction timestamp is invalid', { cause: error });
  }
  if (startedAt !== value.started_at) {
    throw recoveryError('active sprint transaction timestamp is not canonical');
  }
  if (value.operation === 'init') {
    if (value.expected_sha256 !== null) throw recoveryError('init transaction expected hash is invalid');
    if (value.version === INIT_COMPLETION_TRANSACTION_VERSION
        && !hashPattern.test(value.prior_completion_sha256 || '')) {
      throw recoveryError('init prior-completion hash is invalid');
    }
  } else if (!hashPattern.test(value.expected_sha256 || '')) {
    throw recoveryError('transaction expected hash is invalid');
  }
  const hasPayloadProof = value.version !== LEGACY_TRANSACTION_VERSION;
  let replacementRaw = null;
  let replacementPointer = null;
  if (value.operation === 'complete') {
    if (value.replacement_sha256 !== null) throw recoveryError('complete replacement hash is invalid');
    if (hasPayloadProof && value.replacement_raw !== null) {
      throw recoveryError('complete replacement payload is invalid');
    }
  } else {
    if (!hashPattern.test(value.replacement_sha256 || '')) {
      throw recoveryError('transaction replacement hash is invalid');
    }
    if (hasPayloadProof) {
      replacementRaw = value.replacement_raw;
      if (typeof replacementRaw !== 'string'
          || Buffer.byteLength(replacementRaw, 'utf8') > MAX_POINTER_BYTES
          || sha256(replacementRaw) !== value.replacement_sha256) {
        throw recoveryError('transaction replacement payload proof is invalid');
      }
      let replacementValue;
      try {
        replacementValue = JSON.parse(replacementRaw);
      } catch (error) {
        throw recoveryError('transaction replacement payload JSON is invalid', { cause: error });
      }
      const validated = validatePointerSchema(paths.workspace, replacementValue);
      if (!validated.ok
          || `${JSON.stringify(validated.pointer)}\n` !== replacementRaw
          || validated.pointer.plan !== value.plan
          || validated.pointer.phase !== value.phase) {
        throw recoveryError('transaction replacement payload is not canonical pointer state');
      }
      replacementPointer = validated.pointer;
      if (validated.pointer.migration_receipt_sha256
          && ![LINEAGE_TRANSACTION_VERSION, SUPERSESSION_TRANSACTION_VERSION]
            .includes(value.version)) {
        try {
          readMigrationReceipt(
            paths.workspace,
            validated.pointer.migration_receipt_sha256,
            { targetPlan: validated.pointer.plan }
          );
        } catch (error) {
          throw recoveryError('transaction migration receipt proof is invalid', { cause: error });
        }
      }
    }
  }
  let completionPlan = null;
  if (value.version === COMPLETION_TRANSACTION_VERSION) {
    completionPlan = assertCompletionPlanProof(
      paths.workspace,
      value.plan,
      value.completion_plan
    );
  }
  let migrationReceipt = null;
  let migrationReceiptValue = null;
  if (value.version === LINEAGE_TRANSACTION_VERSION) {
    migrationReceipt = assertExactKeys(value.migration_receipt, [
      'mode', 'sha256', 'raw', 'stage',
    ], 'transaction migration receipt', 'SPRINT_RECOVERY_REQUIRED');
    normalizeSha256(
      migrationReceipt.sha256,
      'transaction migration receipt sha256',
      'SPRINT_RECOVERY_REQUIRED'
    );
    if (migrationReceipt.mode === 'prepare') {
      const expectedStage = `active-sprint.migration-${value.token}.json`;
      if (value.operation !== 'replace'
          || ![null, expectedStage].includes(migrationReceipt.stage)
          || typeof migrationReceipt.raw !== 'string'
          || Buffer.byteLength(migrationReceipt.raw, 'utf8') > MAX_MIGRATION_EVIDENCE_BYTES
          || sha256(migrationReceipt.raw) !== migrationReceipt.sha256
          || !replacementPointer
          || replacementPointer.migration_receipt_sha256 !== migrationReceipt.sha256) {
        throw recoveryError('transaction migration receipt preparation proof is invalid');
      }
      let receiptValue;
      try {
        receiptValue = JSON.parse(migrationReceipt.raw);
      } catch (error) {
        throw recoveryError('transaction migration receipt JSON is invalid', { cause: error });
      }
      if (`${JSON.stringify(receiptValue)}\n` !== migrationReceipt.raw) {
        throw recoveryError('transaction migration receipt encoding is not canonical');
      }
      try {
        validateMigrationReceiptValue(
          paths.workspace,
          receiptValue,
          { targetPlan: replacementPointer.plan }
        );
      } catch (error) {
        throw recoveryError('transaction migration receipt payload is invalid', { cause: error });
      }
      migrationReceiptValue = receiptValue;
      assertSupersessionPlanSnapshots(paths, migrationReceiptValue, value.plan);
    } else if (migrationReceipt.mode === 'lineage') {
      if (value.operation !== 'complete'
          || migrationReceipt.raw !== null
          || migrationReceipt.stage !== null) {
        throw recoveryError('completion migration lineage proof is invalid');
      }
      try {
        readMigrationReceipt(
          paths.workspace,
          migrationReceipt.sha256,
          { targetPlan: value.plan }
        );
      } catch (error) {
        throw recoveryError('completion migration lineage receipt is invalid', { cause: error });
      }
    } else {
      throw recoveryError('transaction migration receipt mode is invalid');
    }
  } else if (value.version === SUPERSESSION_TRANSACTION_VERSION) {
    migrationReceipt = assertExactKeys(value.migration_receipt, [
      'mode', 'sha256', 'raw', 'path', 'validated_at',
    ], 'transaction migration receipt', 'SPRINT_RECOVERY_REQUIRED');
    normalizeSha256(
      migrationReceipt.sha256,
      'transaction migration receipt sha256',
      'SPRINT_RECOVERY_REQUIRED'
    );
    let validatedAt;
    try {
      validatedAt = normalizeStateTimestamp(migrationReceipt.validated_at);
    } catch (error) {
      throw recoveryError('supersede validation timestamp is invalid', { cause: error });
    }
    if (migrationReceipt.mode !== 'reference'
        || value.operation !== 'supersede'
        || migrationReceipt.validated_at !== validatedAt
        || value.started_at !== validatedAt
        || typeof migrationReceipt.raw !== 'string'
        || Buffer.byteLength(migrationReceipt.raw, 'utf8') > MAX_MIGRATION_EVIDENCE_BYTES
        || sha256(migrationReceipt.raw) !== migrationReceipt.sha256
        || !replacementPointer
        || replacementPointer.migration_receipt_sha256 !== migrationReceipt.sha256) {
      throw recoveryError('supersede migration receipt reference proof is invalid');
    }
    try {
      assertMigrationReceiptReference(
        paths.workspace,
        migrationReceipt.path,
        migrationReceipt.sha256
      );
      migrationReceiptValue = JSON.parse(migrationReceipt.raw);
      if (`${JSON.stringify(migrationReceiptValue)}\n` !== migrationReceipt.raw
          || migrationReceiptValue.schema_version !== 'sprint-migration-receipt/v2') {
        throw new Error('supersede receipt must be canonical v2 JSON');
      }
      validateMigrationReceiptValue(
        paths.workspace,
        migrationReceiptValue,
        { targetPlan: replacementPointer.plan }
      );
      const preparedAt = Date.parse(migrationReceiptValue.prepared_at);
      const trustedAt = Date.parse(validatedAt);
      const approval = migrationReceiptValue.approval.value;
      if (Math.abs(trustedAt - preparedAt) > MAX_RECEIPT_PREPARATION_SKEW_MS
          || Date.parse(approval.issued_at) > trustedAt
          || trustedAt > Date.parse(approval.expires_at)
          || migrationReceiptValue.source.pointer_sha256 !== value.expected_sha256
          || migrationReceiptValue.target.plan !== replacementPointer.plan
          || migrationReceiptValue.target.phase !== replacementPointer.phase
          || migrationReceiptValue.target.status !== replacementPointer.status
          || migrationReceiptValue.target.acceptance_protocol
            !== replacementPointer.acceptance_protocol
          || migrationReceiptValue.target.next !== replacementPointer.next) {
        throw new Error('supersede receipt does not match the trusted WAL decision');
      }
      assertSupersessionPlanSnapshots(paths, migrationReceiptValue, value.plan);
    } catch (error) {
      throw recoveryError('supersede migration receipt reference is invalid', { cause: error });
    }
  } else if (value.version === COMPLETION_TRANSACTION_VERSION) {
    if (value.migration_receipt !== null) {
      migrationReceipt = assertExactKeys(value.migration_receipt, [
        'mode', 'sha256', 'raw', 'stage',
      ], 'completion migration receipt', 'SPRINT_RECOVERY_REQUIRED');
      normalizeSha256(
        migrationReceipt.sha256,
        'completion migration receipt sha256',
        'SPRINT_RECOVERY_REQUIRED'
      );
      if (migrationReceipt.mode !== 'lineage'
          || migrationReceipt.raw !== null
          || migrationReceipt.stage !== null) {
        throw recoveryError('completion migration lineage proof is invalid');
      }
      try {
        readMigrationReceipt(
          paths.workspace,
          migrationReceipt.sha256,
          { targetPlan: value.plan }
        );
      } catch (error) {
        throw recoveryError('completion migration lineage receipt is invalid', { cause: error });
      }
    }
  }
  return {
    raw,
    value,
    replacementRaw,
    replacementPointer,
    migrationReceipt,
    migrationReceiptValue,
    completionPlan,
    priorCompletionSha256: value.version === INIT_COMPLETION_TRANSACTION_VERSION
      ? value.prior_completion_sha256 : null,
    migrationReceiptStagePath: migrationReceipt
      && migrationReceipt.mode === 'prepare'
      && migrationReceipt.stage
      ? path.join(paths.stateDirectory, migrationReceipt.stage)
      : null,
    privatePaths,
    claimPath: value.claim ? path.join(paths.stateDirectory, ...value.claim.split('/')) : null,
    publishPath: value.publish ? path.join(paths.stateDirectory, value.publish) : null,
    partialPath: value.version !== LEGACY_TRANSACTION_VERSION && value.partial
      ? path.join(paths.stateDirectory, ...value.partial.split('/')) : null,
  };
}
function readStableRecoverySnapshot(filePath, maximumBytes = MAX_RECOVERY_BYTES) {
  try {
    const before = lstatExactSync(filePath);
    if (before.isSymbolicLink() || !before.isFile()
        || statSizeExceeds(before, maximumBytes)) {
      throw recoveryError(`recovery file ${path.basename(filePath)} is not a bounded regular file`);
    }
    const bytes = fs.readFileSync(filePath);
    const after = lstatExactSync(filePath);
    if (!sameFileIdentity(before, after) || bytes.length > maximumBytes) {
      throw recoveryError(`recovery file ${path.basename(filePath)} changed while reading`);
    }
    return { bytes, stat: after };
  } catch (error) {
    if (error && error.code === 'SPRINT_RECOVERY_REQUIRED') throw error;
    throw recoveryError(`cannot verify recovery file ${path.basename(filePath)}`, { cause: error });
  }
}

function isStrictReplacementPrefix(snapshot, transaction) {
  if (!transaction.replacementRaw) return false;
  const expected = Buffer.from(transaction.replacementRaw, 'utf8');
  return snapshot.bytes.length < expected.length
    && snapshot.bytes.equals(expected.subarray(0, snapshot.bytes.length));
}

function readTransactionClaimState(paths, transaction) {
  if (!transaction.claimPath) return { claim: null, raw: null, source: null };
  if (!transaction.privatePaths) {
    return {
      claim: null,
      raw: readOptionalRecoveryFile(transaction.claimPath, MAX_POINTER_BYTES),
      source: null,
    };
  }
  let claim = readRecoverablePrivateClaimSlot(paths, transaction.value.token, 'pointer');
  if (!claim) return { claim: null, raw: null, source: null };
  if (claim.empty) {
    return { claim, raw: null, source: null, empty: true };
  }
  if (claim.intent.sha256 !== transaction.value.expected_sha256
      || claim.intent.size > MAX_POINTER_BYTES) {
    throw recoveryError('private pointer claim does not match transaction');
  }
  const source = inspectClaimSource(paths, claim);
  return {
    claim,
    raw: claim.value ? claim.value.bytes.toString('utf8') : null,
    source,
  };
}

function claimOwnedPartialPublishCandidate(paths, transaction, writeError) {
  const identity = writeError && writeError.sprintCreatedFileIdentity;
  const supportsOwnedPartial = ['init', 'replace', 'supersede']
    .includes(transaction.value.operation);
  if (!identity || !supportsOwnedPartial || !transaction.partialPath
      || !transaction.privatePaths
      || writeError.sprintCreatedFilePath !== path.resolve(transaction.publishPath)) {
    return false;
  }
  const publish = readStableRecoverySnapshot(transaction.publishPath, MAX_POINTER_BYTES);
  if (!sameFileIdentity(identity, publish.stat)) {
    throw recoveryError('publish candidate identity changed after write failure; evidence preserved');
  }
  if (sha256(publish.bytes) === transaction.value.replacement_sha256) return false;
  if (!isStrictReplacementPrefix(publish, transaction)) {
    throw recoveryError('failed publish candidate is not owned replacement prefix; evidence preserved');
  }
  const claim = createPrivateClaim(paths, {
    scopeToken: transaction.value.token,
    artifact: 'partial',
    sourcePath: transaction.publishPath,
    snapshot: publish,
  });
  if (path.resolve(claim.valuePath) !== path.resolve(transaction.partialPath)) {
    throw recoveryError('private partial claim path differs from transaction');
  }
  return true;
}

function cleanupPrivatePartialPublishCandidate(paths, transaction) {
  let claim = readRecoverablePrivateClaimSlot(paths, transaction.value.token, 'partial');
  if (!claim) return false;
  if (claim.empty) {
    let publish;
    try {
      publish = readStableRecoverySnapshot(transaction.publishPath, MAX_POINTER_BYTES);
    } catch (error) {
      if (error && error.cause && error.cause.code === 'ENOENT') {
        removeEmptyPrivateClaimSlot(paths, claim);
        return true;
      }
      throw error;
    }
    if (sha256(publish.bytes) === transaction.value.replacement_sha256) {
      removeEmptyPrivateClaimSlot(paths, claim);
      return false;
    }
    if (!isStrictReplacementPrefix(publish, transaction)) {
      removeEmptyPrivateClaimSlot(paths, claim);
      throw recoveryError(
        'publish candidate after empty partial claim is not an owned replacement prefix; evidence preserved'
      );
    }
    claim = preparePrivateClaimForSource(paths, claim, {
      scopeToken: transaction.value.token,
      artifact: 'partial',
      sourcePath: transaction.publishPath,
      snapshot: publish,
    });
    claim = movePreparedPrivateClaimSource(
      paths,
      claim,
      transaction.publishPath,
      publish
    );
    if (path.resolve(claim.valuePath) !== path.resolve(transaction.partialPath)) {
      throw recoveryError('adopted private partial claim path differs from transaction');
    }
    deletePrivateClaimValue(paths, claim, { sync: true });
    return true;
  }
  if (claim.intent.size >= Buffer.byteLength(transaction.replacementRaw, 'utf8')) {
    throw recoveryError('private partial claim is not a strict replacement prefix');
  }
  const expectedPrefix = Buffer.from(transaction.replacementRaw, 'utf8')
    .subarray(0, claim.intent.size);
  if (sha256(expectedPrefix) !== claim.intent.sha256) {
    throw recoveryError('private partial claim intent is not an owned replacement prefix');
  }
  if (claim.value) {
    if (!claim.value.bytes.equals(expectedPrefix)) {
      throw recoveryError('private partial claim bytes are not an owned replacement prefix');
    }
    deletePrivateClaimValue(paths, claim, { sync: true });
    return true;
  }
  const source = inspectClaimSource(paths, claim);
  if (source.state === 'successor') {
    throw recoveryError('partial publish source successor was preserved');
  }
  if (source.state === 'expected') {
    claim = movePreparedPrivateClaimSource(
      paths,
      claim,
      source.sourcePath,
      source.snapshot
    );
    if (path.resolve(claim.valuePath) !== path.resolve(transaction.partialPath)) {
      throw recoveryError('resumed private partial claim path differs from transaction');
    }
    deletePrivateClaimValue(paths, claim, { sync: true });
    return true;
  }
  removePrivateClaimMetadata(paths, claim);
  return true;
}

function legacyPartialArtifacts(paths, transaction) {
  return [
    { path: `${transaction.partialPath}.delete-a.tmp`, artifact: 'legacy-partial-delete-a' },
    { path: `${transaction.partialPath}.delete-b.tmp`, artifact: 'legacy-partial-delete-b' },
    { path: transaction.partialPath, artifact: 'legacy-partial' },
    { path: `${transaction.partialPath}.release.tmp`, artifact: 'legacy-partial-release' },
  ];
}

function cleanupLegacyPartialPublishCandidate(paths, transaction, publishRaw) {
  if (!transaction.partialPath || !transaction.replacementRaw) return false;
  const existing = [];
  for (const candidate of legacyPartialArtifacts(paths, transaction)) {
    const raw = readOptionalRecoveryFile(candidate.path, MAX_POINTER_BYTES);
    if (raw !== null) {
      const snapshot = readStableRecoverySnapshot(candidate.path, MAX_POINTER_BYTES);
      if (!isStrictReplacementPrefix(snapshot, transaction)) {
        throw recoveryError(`legacy partial artifact is not owned: ${path.basename(candidate.path)}`);
      }
      existing.push({ ...candidate, snapshot });
    }
  }
  if (existing.length === 0) return false;
  const first = existing[0].snapshot;
  const duplicateDeleteClaims = existing.filter(({ artifact }) =>
    artifact === 'legacy-partial-delete-a' || artifact === 'legacy-partial-delete-b'
  ).length > 1;
  const ambiguousEvidence = existing.some(({ snapshot }) =>
    !sameFileIdentity(first.stat, snapshot.stat) || !first.bytes.equals(snapshot.bytes)
  );
  if (duplicateDeleteClaims || ambiguousEvidence) {
    throw recoveryError('legacy partial cleanup markers are ambiguous; evidence preserved');
  }
  if (publishRaw !== null) {
    const publish = readStableRecoverySnapshot(transaction.publishPath, MAX_POINTER_BYTES);
    const owned = existing.some(({ snapshot }) => sameFileIdentity(snapshot.stat, publish.stat)
      && snapshot.bytes.equals(publish.bytes));
    if (!owned) {
      throw recoveryError('publish path no longer matches legacy partial evidence');
    }
    removeVerifiedRecoveryFile(
      transaction.publishPath,
      sha256(publish.bytes),
      paths.stateDirectory,
      {
        sync: true,
        scopeToken: transaction.value.token,
        artifact: 'publish',
      }
    );
  }
  for (const candidate of existing) {
    removeVerifiedRecoveryFile(
      candidate.path,
      sha256(candidate.snapshot.bytes),
      paths.stateDirectory,
      {
        sync: true,
        scopeToken: transaction.value.token,
        artifact: candidate.artifact,
      }
    );
  }
  return true;
}

function cleanupOwnedPartialPublishCandidate(paths, transaction, publishRaw) {
  if (transaction.privatePaths) {
    return cleanupPrivatePartialPublishCandidate(paths, transaction);
  }
  return cleanupLegacyPartialPublishCandidate(paths, transaction, publishRaw);
}

function convergeDuplicateTransactionMarkers(paths) {
  const canonical = readStableRecoverySnapshot(paths.transactionPath, MAX_TRANSACTION_BYTES);
  const release = readStableRecoverySnapshot(paths.transactionReleasePath, MAX_TRANSACTION_BYTES);
  if (!sameFileIdentity(canonical.stat, release.stat)
      || !canonical.bytes.equals(release.bytes)) {
    throw recoveryError('transaction and legacy cleanup marker conflict; evidence preserved');
  }
  const transaction = parseTransaction(paths, canonical.bytes.toString('utf8'));
  removeVerifiedRecoveryFile(
    paths.transactionReleasePath,
    sha256(release.bytes),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: transaction.value.token,
      artifact: 'transaction-release',
    }
  );
  const surviving = readStableRecoverySnapshot(paths.transactionPath, MAX_TRANSACTION_BYTES);
  if (!sameFileIdentity(canonical.stat, surviving.stat)
      || !canonical.bytes.equals(surviving.bytes)) {
    throw recoveryError('transaction marker changed while converging legacy cleanup marker');
  }
  return surviving.bytes.toString('utf8');
}

function restoreLegacyTransactionRelease(paths, releaseRaw) {
  const transaction = parseTransaction(paths, releaseRaw);
  try {
    fs.linkSync(paths.transactionReleasePath, paths.transactionPath);
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw recoveryError('cannot restore legacy transaction cleanup marker', { cause: error });
    }
  }
  const canonical = readStableRecoverySnapshot(paths.transactionPath, MAX_TRANSACTION_BYTES);
  if (canonical.bytes.toString('utf8') !== releaseRaw) {
    throw recoveryError('restored transaction differs from legacy cleanup marker');
  }
  removeVerifiedRecoveryFile(
    paths.transactionReleasePath,
    sha256(releaseRaw),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: transaction.value.token,
      artifact: 'transaction-release',
    }
  );
  return releaseRaw;
}

function assertLegacyFlatClaimsBound(paths, transaction) {
  const entries = fs.readdirSync(paths.stateDirectory);
  for (const entry of entries) {
    const match = entry.match(/^active-sprint\.claim-([a-f0-9]{32})\.json$/);
    if (!match) continue;
    const bound = transaction
      && !transaction.privatePaths
      && transaction.value.operation !== 'init'
      && transaction.value.token === match[1]
      && transaction.value.claim === entry;
    if (!bound) {
      throw recoveryError(`orphan or mismatched legacy pointer claim was preserved: ${entry}`);
    }
  }
}
function assertPrivateHoldClaimsBound(paths, transaction) {
  const entries = fs.readdirSync(paths.stateDirectory);
  for (const entry of entries) {
    const parsed = parsePrivateClaimSlotName(entry);
    if (!parsed) continue;
    const claim = readRecoverablePrivateClaimSlot(paths, parsed.scopeToken, parsed.artifact, {
      allowMissing: false,
    });
    if (!claim) continue;
    const isHold = claim.empty
      ? expectedClaimDisposition(parsed.artifact) === 'hold'
      : claim.intent && claim.intent.disposition === 'hold';
    if (!isHold) continue;
    const bound = transaction
      && transaction.privatePaths
      && parsed.scopeToken === transaction.value.token
      && ((parsed.artifact === 'pointer' && transaction.value.operation !== 'init')
        || (parsed.artifact === 'partial'
          && ['init', 'replace', 'supersede'].includes(transaction.value.operation))
        || (parsed.artifact === 'prior-completion'
          && transaction.value.operation === 'init'
          && transaction.value.version === INIT_COMPLETION_TRANSACTION_VERSION
          && transaction.priorCompletionSha256 !== null));
    if (!bound) {
      throw recoveryError(`orphan or mismatched private hold claim was preserved: ${entry}`);
    }
  }
}

function readClaimedTransactionMarker(paths) {
  const candidates = fs.readdirSync(paths.stateDirectory)
    .map((entry) => ({ entry, parsed: parsePrivateClaimSlotName(entry) }))
    .filter(({ parsed }) => parsed && parsed.artifact === 'transaction');
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw recoveryError('multiple claimed active sprint transactions were preserved');
  }
  const [{ parsed }] = candidates;
  const claim = readPrivateClaimSlot(paths, parsed.scopeToken, 'transaction', {
    allowMissing: false,
  });
  if (claim.empty) return null;
  if (claim.intent.disposition !== 'delete') {
    throw recoveryError('claimed active sprint transaction disposition is invalid');
  }
  // No held bytes means the WAL was already verified and destroyed; only
  // private-claim metadata cleanup remains, so standalone recovery is safe.
  if (!claim.heldValue) return null;
  const transaction = parseTransaction(paths, claim.heldValue.bytes.toString('utf8'));
  if (transaction.value.token !== parsed.scopeToken) {
    throw recoveryError('claimed active sprint transaction token differs from its WAL');
  }
  return transaction;
}

function readTransaction(paths) {
  let raw = readOptionalRecoveryFile(paths.transactionPath, MAX_TRANSACTION_BYTES);
  let releaseRaw = readOptionalRecoveryFile(
    paths.transactionReleasePath,
    MAX_TRANSACTION_BYTES
  );
  if (releaseRaw !== null) {
    raw = raw !== null
      ? convergeDuplicateTransactionMarkers(paths)
      : restoreLegacyTransactionRelease(paths, releaseRaw);
  }
  let transaction = raw === null ? readClaimedTransactionMarker(paths) : parseTransaction(paths, raw);
  const recoverableArtifacts = new Set(
    [...CLAIM_ARTIFACTS].filter((artifact) => artifact !== 'lock')
  );
  if (transaction) {
    const terminalArtifacts = new Set(['transaction', 'publish', 'legacy-pointer']);
    recoverStandaloneDeleteClaims(paths, {
      artifacts: recoverableArtifacts,
      excludeClaim: ({ scopeToken, artifact }) => scopeToken === transaction.value.token
        && terminalArtifacts.has(artifact),
    });
  } else {
    recoverStandaloneDeleteClaims(paths, { artifacts: recoverableArtifacts });
    raw = readOptionalRecoveryFile(paths.transactionPath, MAX_TRANSACTION_BYTES);
    releaseRaw = readOptionalRecoveryFile(
      paths.transactionReleasePath,
      MAX_TRANSACTION_BYTES
    );
    if (releaseRaw !== null) {
      raw = raw !== null
        ? convergeDuplicateTransactionMarkers(paths)
        : restoreLegacyTransactionRelease(paths, releaseRaw);
    }
    transaction = raw === null ? null : parseTransaction(paths, raw);
  }
  assertLegacyFlatClaimsBound(paths, transaction);
  assertPrivateHoldClaimsBound(paths, transaction);
  return transaction;
}

function cleanupPrivatePointerClaim(
  paths,
  transaction,
  expectedHash,
  allowedSourceHash = null,
  verifyBeforeDestroy = null
) {
  let claim = readRecoverablePrivateClaimSlot(paths, transaction.value.token, 'pointer');
  if (!claim) return false;
  if (claim.empty) {
    if (verifyBeforeDestroy) verifyBeforeDestroy();
    removeEmptyPrivateClaimSlot(paths, claim);
    return false;
  }
  if (claim.intent.sha256 !== expectedHash) {
    throw recoveryError('private pointer claim hash differs from transaction');
  }
  const source = inspectClaimSource(paths, claim);
  if (!claim.value) {
    const allowed = source.snapshot && allowedSourceHash
      && sha256(source.snapshot.bytes) === allowedSourceHash;
    if (source.state === 'successor' && !allowed) {
      throw recoveryError('private pointer claim source successor was preserved');
    }
    if (verifyBeforeDestroy) verifyBeforeDestroy();
    removePrivateClaimMetadata(paths, claim);
    return true;
  }
  deletePrivateClaimValue(paths, claim, {
    sync: true,
    allowedSourceHash,
    verifyBeforeDestroy,
  });
  return true;
}

function restoreTransactionClaim(paths, transaction, claimRaw, {
  verifyBeforeDestroy,
} = {}) {
  if (typeof verifyBeforeDestroy !== 'function') {
    throw recoveryError('transaction claim restore requires a terminal-state verifier');
  }
  if (transaction.privatePaths) {
    const state = readTransactionClaimState(paths, transaction);
    if (!state.claim || !state.claim.value) return false;
    return restorePrivateClaim(paths, state.claim, paths.pointerPath, {
      verifyBeforeDestroy,
    });
  }
  try {
    fs.linkSync(transaction.claimPath, paths.pointerPath);
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw recoveryError('cannot restore legacy claimed sprint pointer', { cause: error });
  }
  const restored = readStableRecoverySnapshot(paths.pointerPath, MAX_POINTER_BYTES);
  if (sha256(restored.bytes) !== sha256(claimRaw)) {
    throw recoveryError('restored legacy pointer claim differs from expected bytes');
  }
  removeVerifiedRecoveryFile(
    transaction.claimPath,
    sha256(claimRaw),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: transaction.value.token,
      artifact: 'legacy-pointer',
      verifyBeforeDestroy,
    }
  );
  return true;
}

function cleanupTransaction(paths, transaction, {
  claimHash,
  publishHash,
  allowedClaimSourceHash = null,
  verifyTerminalState,
} = {}) {
  if (typeof verifyTerminalState !== 'function') {
    throw recoveryError('transaction cleanup requires an explicit terminal-state verifier');
  }
  if (claimHash && transaction.claimPath) {
    if (transaction.privatePaths) {
      cleanupPrivatePointerClaim(
        paths,
        transaction,
        claimHash,
        allowedClaimSourceHash,
        verifyTerminalState
      );
    } else {
      removeVerifiedRecoveryFile(
        transaction.claimPath,
        claimHash,
        paths.stateDirectory,
        {
          scopeToken: transaction.value.token,
          artifact: 'legacy-pointer',
          verifyBeforeDestroy: verifyTerminalState,
        }
      );
    }
  }
  if (publishHash && transaction.publishPath) {
    removeVerifiedRecoveryFile(
      transaction.publishPath,
      publishHash,
      paths.stateDirectory,
      {
        scopeToken: transaction.value.token,
        artifact: 'publish',
        verifyBeforeDestroy: verifyTerminalState,
      }
    );
  }
  verifyTerminalState();
  removeVerifiedRecoveryFile(
    paths.transactionPath,
    sha256(transaction.raw),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: transaction.value.token,
      artifact: 'transaction',
      verifyBeforeDestroy: verifyTerminalState,
    }
  );
}

function assertExactPointerRaw(paths, expectedRaw, message) {
  if (typeof expectedRaw !== 'string') {
    throw recoveryError(`${message} has no exact pointer payload proof`);
  }
  const pointer = readStableRecoverySnapshot(paths.pointerPath, MAX_POINTER_BYTES);
  if (pointer.bytes.toString('utf8') !== expectedRaw) {
    throw recoveryError(`${message} differs from its exact pointer payload`);
  }
  return pointer;
}

function assertCommittedPointer(paths, transaction, fallbackRaw = null) {
  if (transaction.value.operation === 'complete') {
    throw recoveryError('committed pointer verification cannot verify completion');
  }
  const expectedRaw = transaction.replacementRaw === null
    ? fallbackRaw : transaction.replacementRaw;
  const pointer = assertExactPointerRaw(paths, expectedRaw, 'committed sprint pointer');
  if (sha256(pointer.bytes) !== transaction.value.replacement_sha256) {
    throw recoveryError('committed sprint pointer hash differs from its WAL proof');
  }
  return pointer;
}

function publishTransactionPointer(paths, transaction) {
  if (!transaction.publishPath || transaction.value.operation === 'complete') {
    throw recoveryError('pointer publish requires a transaction publish candidate');
  }
  const before = readStableRecoverySnapshot(transaction.publishPath, MAX_POINTER_BYTES);
  const candidateRaw = before.bytes.toString('utf8');
  if (sha256(before.bytes) !== transaction.value.replacement_sha256
      || (transaction.replacementRaw !== null
        && candidateRaw !== transaction.replacementRaw)) {
    throw recoveryError('publish candidate differs from its WAL payload proof');
  }

  let linked = false;
  try {
    fs.linkSync(transaction.publishPath, paths.pointerPath);
    linked = true;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw recoveryError('exclusive pointer publish failed', { cause: error });
    }
  }
  fsyncDirectoryIfSupported(paths.stateDirectory);

  const after = readStableRecoverySnapshot(transaction.publishPath, MAX_POINTER_BYTES);
  if (!sameFileIdentity(before.stat, after.stat) || !before.bytes.equals(after.bytes)) {
    throw recoveryError('publish candidate identity changed during exclusive publish');
  }
  const pointer = assertExactPointerRaw(
    paths,
    candidateRaw,
    'exclusive pointer publish readback'
  );
  if (sha256(pointer.bytes) !== transaction.value.replacement_sha256
      || ((linked || transaction.privatePaths)
        && !sameFileIdentity(before.stat, pointer.stat))) {
    throw recoveryError('exclusive pointer publish readback is not the verified candidate');
  }
  return { candidate: after, pointer, raw: candidateRaw, linked };
}

function assertCommittedSupersession(paths, transaction) {
  const isV5Reference = transaction.value.version === SUPERSESSION_TRANSACTION_VERSION
    && transaction.value.operation === 'supersede'
    && transaction.migrationReceipt
    && transaction.migrationReceipt.mode === 'reference';
  const isV4Prepare = transaction.value.version === LINEAGE_TRANSACTION_VERSION
    && transaction.value.operation === 'replace'
    && transaction.migrationReceipt
    && transaction.migrationReceipt.mode === 'prepare';
  if (!isV5Reference && !isV4Prepare) {
    throw recoveryError('committed supersession verification requires a v4/v5 WAL');
  }
  assertSupersessionPlanSnapshots(
    paths,
    transaction.migrationReceiptValue,
    transaction.value.plan
  );
  const pointer = readStableRecoverySnapshot(paths.pointerPath, MAX_POINTER_BYTES);
  if (sha256(pointer.bytes) !== transaction.value.replacement_sha256
      || pointer.bytes.toString('utf8') !== transaction.replacementRaw) {
    throw recoveryError('committed supersession pointer differs from its WAL payload');
  }
  let receipt;
  try {
    receipt = readMigrationReceipt(
      paths.workspace,
      transaction.migrationReceipt.sha256,
      {
        targetPlan: transaction.value.plan,
        ...(transaction.migrationReceipt.path
          ? { path: transaction.migrationReceipt.path }
          : {}),
      }
    );
  } catch (error) {
    throw recoveryError('committed supersession receipt is unavailable or invalid', {
      cause: error,
    });
  }
  if (receipt.raw !== transaction.migrationReceipt.raw
      || receipt.digest !== transaction.migrationReceipt.sha256) {
    throw recoveryError('committed supersession receipt differs from its WAL proof');
  }
  return { pointer, receipt };
}
function createTransaction(paths, {
  operation,
  expectedRaw,
  replacementRaw,
  plan,
  phase,
  migrationReceiptRaw = null,
  migrationReceiptReference = null,
  completionMigrationReceiptSha256 = null,
  completionPlanProof = null,
  priorCompletionSha256 = null,
}) {
  if (readOptionalRecoveryFile(paths.transactionPath, MAX_TRANSACTION_BYTES) !== null) {
    throw recoveryError('an unfinished active sprint transaction already exists');
  }
  if ([migrationReceiptRaw, migrationReceiptReference, completionMigrationReceiptSha256]
    .filter((entry) => entry !== null).length > 1) {
    throw recoveryError('transaction cannot prepare and complete migration lineage together');
  }
  if (completionPlanProof !== null && operation !== 'complete') {
    throw recoveryError('completion plan proof is only valid for completion transactions');
  }
  if (priorCompletionSha256 !== null && operation !== 'init') {
    throw recoveryError('prior completion proof is only valid for init transactions');
  }
  const normalizedPriorCompletionSha256 = priorCompletionSha256 === null
    ? null
    : normalizeSha256(
      priorCompletionSha256,
      'prior completion sha256',
      'SPRINT_RECOVERY_REQUIRED'
    );
  const token = randomStateToken();
  const hasLineage = migrationReceiptRaw !== null
    || migrationReceiptReference !== null
    || completionMigrationReceiptSha256 !== null;
  const migrationReceipt = migrationReceiptReference !== null
    ? {
      mode: 'reference',
      sha256: normalizeSha256(
        migrationReceiptReference.sha256,
        'migration receipt reference sha256',
        'SPRINT_RECOVERY_REQUIRED'
      ),
      raw: migrationReceiptReference.raw,
      path: migrationReceiptReference.path,
      validated_at: normalizeStateTimestamp(migrationReceiptReference.validatedAt),
    }
    : (migrationReceiptRaw !== null
    ? {
      mode: 'prepare',
      sha256: sha256(migrationReceiptRaw),
      raw: migrationReceiptRaw,
      stage: null,
    }
    : (completionMigrationReceiptSha256 !== null
      ? {
        mode: 'lineage',
        sha256: normalizeSha256(
          completionMigrationReceiptSha256,
          'completion migration receipt sha256',
          'SPRINT_RECOVERY_REQUIRED'
        ),
        raw: null,
        stage: null,
      }
      : null));
  const transactionVersion = completionPlanProof !== null
    ? COMPLETION_TRANSACTION_VERSION
    : (normalizedPriorCompletionSha256 !== null
      ? INIT_COMPLETION_TRANSACTION_VERSION
      : (migrationReceiptReference !== null
        ? SUPERSESSION_TRANSACTION_VERSION
        : (hasLineage ? LINEAGE_TRANSACTION_VERSION : TRANSACTION_VERSION)));
  const startedAt = migrationReceiptReference !== null
    ? migrationReceipt.validated_at : new Date().toISOString();
  const value = {
    version: transactionVersion,
    token,
    operation,
    claim: operation === 'init'
      ? null : `${claimSlotName(token, 'pointer')}/${CLAIM_VALUE_FILE}`,
    publish: operation === 'complete' ? null : `active-sprint.publish-${token}.json`,
    expected_sha256: expectedRaw === null ? null : sha256(expectedRaw),
    replacement_sha256: replacementRaw === null ? null : sha256(replacementRaw),
    plan: plan || null,
    phase: phase || null,
    started_at: startedAt,
    partial: operation === 'complete'
      ? null : `${claimSlotName(token, 'partial')}/${CLAIM_VALUE_FILE}`,
    replacement_raw: replacementRaw,
    ...(transactionVersion === INIT_COMPLETION_TRANSACTION_VERSION
      ? { prior_completion_sha256: normalizedPriorCompletionSha256 }
      : {}),
    ...(transactionVersion === COMPLETION_TRANSACTION_VERSION
      ? {
        migration_receipt: migrationReceipt,
        completion_plan: completionPlanProof,
      }
      : (hasLineage ? { migration_receipt: migrationReceipt } : {})),
  };
  const raw = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(raw, 'utf8') > MAX_TRANSACTION_BYTES) {
    throw recoveryError('active sprint transaction exceeds recovery budget');
  }
  try {
    writeDurableStagedExclusive(
      paths.transactionPath,
      raw,
      paths.stateDirectory,
      token
    );
  } catch (error) {
    throw recoveryError('cannot persist active sprint transaction', { cause: error });
  }
  const transaction = parseTransaction(paths, raw);
  if (migrationReceiptRaw !== null || migrationReceiptReference !== null) {
    prepareTransactionMigrationReceipt(paths, transaction);
  }
  if (replacementRaw !== null) {
    try {
      writeDurableExclusive(transaction.publishPath, replacementRaw, paths.stateDirectory);
    } catch (error) {
      try {
        claimOwnedPartialPublishCandidate(paths, transaction, error);
      } catch (claimError) {
        if (claimError && claimError.code === 'SPRINT_RECOVERY_REQUIRED') throw claimError;
        throw recoveryError('cannot preserve failed publish candidate evidence', {
          cause: claimError,
        });
      }
      throw recoveryError('cannot persist active sprint publish candidate', { cause: error });
    }
  }
  return transaction;
}

function isInitPriorCompletionTransaction(transaction) {
  return Boolean(transaction
    && transaction.value.version === INIT_COMPLETION_TRANSACTION_VERSION
    && transaction.value.operation === 'init'
    && transaction.priorCompletionSha256);
}

function readInitPriorCompletionSnapshot(paths, transaction) {
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(paths.completionPath, MAX_RECOVERY_BYTES);
  } catch (error) {
    if (error && error.cause && error.cause.code === 'ENOENT') return null;
    throw error;
  }
  if (sha256(snapshot.bytes) !== transaction.priorCompletionSha256) {
    throw recoveryError('prior completion source differs from its init WAL proof');
  }
  return snapshot;
}

function readInitPriorCompletionClaim(paths, transaction) {
  if (!isInitPriorCompletionTransaction(transaction)) return null;
  const claim = readRecoverablePrivateClaimSlot(
    paths,
    transaction.value.token,
    'prior-completion'
  );
  if (!claim || claim.empty) return claim;
  if (claim.intent.disposition !== 'hold'
      || claim.intent.sha256 !== transaction.priorCompletionSha256
      || claim.intent.size > MAX_RECOVERY_BYTES) {
    throw recoveryError('prior completion claim differs from its init WAL proof');
  }
  return claim;
}

function claimInitPriorCompletion(paths, transaction, expectedCompletion = null) {
  if (!isInitPriorCompletionTransaction(transaction)) return null;
  let claim = readInitPriorCompletionClaim(paths, transaction);
  if (claim && !claim.empty) {
    if (claim.value) {
      claim = convergeExactClaimSourceDuplicate(paths, claim);
      if (inspectClaimSource(paths, claim).state !== 'missing') {
        throw recoveryError('prior completion claim source successor was preserved');
      }
      return claim;
    }
    const source = inspectClaimSource(paths, claim);
    if (source.state !== 'expected') {
      throw recoveryError('prior completion intent has no exact recoverable source');
    }
    return movePreparedPrivateClaimSource(
      paths,
      claim,
      source.sourcePath,
      source.snapshot
    );
  }

  const snapshot = readInitPriorCompletionSnapshot(paths, transaction);
  if (!snapshot) {
    throw recoveryError('init WAL prior completion source is missing');
  }
  if (expectedCompletion
      && snapshot.bytes.toString('utf8') !== expectedCompletion.raw) {
    throw recoveryError('prior completion changed after init WAL preparation');
  }
  if (claim && claim.empty) {
    claim = preparePrivateClaimForSource(paths, claim, {
      scopeToken: transaction.value.token,
      artifact: 'prior-completion',
      sourcePath: paths.completionPath,
      snapshot,
    });
    return movePreparedPrivateClaimSource(
      paths,
      claim,
      paths.completionPath,
      snapshot
    );
  }
  return createPrivateClaim(paths, {
    scopeToken: transaction.value.token,
    artifact: 'prior-completion',
    sourcePath: paths.completionPath,
    snapshot,
  });
}

function restoreInitPriorCompletion(paths, transaction, {
  verifyBeforeDestroy,
} = {}) {
  if (!isInitPriorCompletionTransaction(transaction)) return false;
  if (typeof verifyBeforeDestroy !== 'function') {
    throw recoveryError('prior completion restore requires a terminal-state verifier');
  }
  const verifyRestoredPriorCompletion = () => {
    verifyBeforeDestroy();
    if (readInitPriorCompletionSnapshot(paths, transaction) === null) {
      throw recoveryError('prior completion changed at its restore boundary');
    }
  };
  const claim = readInitPriorCompletionClaim(paths, transaction);
  if (claim) {
    if (claim.empty) {
      verifyRestoredPriorCompletion();
      removeEmptyPrivateClaimSlot(paths, claim);
    } else if (claim.value) {
      if (!restorePrivateClaim(paths, claim, paths.completionPath, {
        verifyBeforeDestroy: verifyRestoredPriorCompletion,
      })) {
        throw recoveryError('prior completion claim could not be restored');
      }
    } else {
      const source = inspectClaimSource(paths, claim);
      if (source.state !== 'expected') {
        throw recoveryError('prior completion intent cannot restore an exact source');
      }
      verifyRestoredPriorCompletion();
      removePrivateClaimMetadata(paths, claim);
    }
  }
  verifyRestoredPriorCompletion();
  return true;
}

function assertTransactionEvidenceExact(paths, transaction) {
  const canonicalRaw = readOptionalRecoveryFile(
    paths.transactionPath,
    MAX_TRANSACTION_BYTES
  );
  if (canonicalRaw !== null) {
    if (canonicalRaw !== transaction.raw) {
      throw recoveryError('canonical WAL differs from the active transaction');
    }
    return true;
  }
  const claim = readPrivateClaimSlot(paths, transaction.value.token, 'transaction');
  if (!claim || !claim.heldValue
      || claim.heldValue.bytes.toString('utf8') !== transaction.raw) {
    throw recoveryError('active transaction has no exact WAL evidence');
  }
  return true;
}

function retireInitPriorCompletion(paths, transaction) {
  if (!isInitPriorCompletionTransaction(transaction)) return false;
  const verifyCommit = () => {
    assertTransactionEvidenceExact(paths, transaction);
    assertCommittedPointer(paths, transaction, transaction.replacementRaw);
  };
  let claim = readInitPriorCompletionClaim(paths, transaction);
  if (!claim) {
    const snapshot = readInitPriorCompletionSnapshot(paths, transaction);
    if (!snapshot) return false;
    claim = createPrivateClaim(paths, {
      scopeToken: transaction.value.token,
      artifact: 'prior-completion',
      sourcePath: paths.completionPath,
      snapshot,
    });
  } else if (claim.empty) {
    const snapshot = readInitPriorCompletionSnapshot(paths, transaction);
    if (!snapshot) {
      verifyCommit();
      removeEmptyPrivateClaimSlot(paths, claim);
      claim = null;
    } else {
      claim = preparePrivateClaimForSource(paths, claim, {
        scopeToken: transaction.value.token,
        artifact: 'prior-completion',
        sourcePath: paths.completionPath,
        snapshot,
      });
      claim = movePreparedPrivateClaimSource(
        paths,
        claim,
        paths.completionPath,
        snapshot
      );
    }
  } else if (!claim.value) {
    const source = inspectClaimSource(paths, claim);
    if (source.state === 'missing') {
      verifyCommit();
      removePrivateClaimMetadata(paths, claim);
      claim = null;
    } else if (source.state !== 'expected') {
      throw recoveryError('prior completion intent has no exact source to retire');
    } else {
      claim = movePreparedPrivateClaimSource(
        paths,
        claim,
        source.sourcePath,
        source.snapshot
      );
    }
  }
  if (claim) {
    deletePrivateClaimValue(paths, claim, {
      sync: true,
      verifyBeforeDestroy: verifyCommit,
    });
  }
  if (readInitPriorCompletionSnapshot(paths, transaction) !== null
      || readPrivateClaimSlot(
        paths,
        transaction.value.token,
        'prior-completion'
      ) !== null) {
    throw recoveryError('prior completion retirement did not reach terminal state');
  }
  return true;
}

function assertCommittedInitWithPriorCompletion(paths, transaction) {
  assertTransactionEvidenceExact(paths, transaction);
  const pointer = assertCommittedPointer(paths, transaction, transaction.replacementRaw);
  let completionRaw;
  try {
    completionRaw = readOptionalRecoveryFile(paths.completionPath, MAX_RECOVERY_BYTES);
  } catch (error) {
    throw recoveryError('cannot verify retired prior completion', { cause: error });
  }
  if (completionRaw !== null
      || readPrivateClaimSlot(
        paths,
        transaction.value.token,
        'prior-completion'
      ) !== null) {
    throw recoveryError('committed init still exposes prior completion evidence');
  }
  return pointer;
}

function recoverUnpublishedInitTransaction(paths, transaction) {
  const tokenClaimPath = path.join(
    paths.stateDirectory,
    `active-sprint.claim-${transaction.value.token}.json`
  );
  const transactionRaw = readOptionalRecoveryFile(paths.transactionPath, MAX_TRANSACTION_BYTES);
  let claimedTransaction = null;
  if (transactionRaw === null && transaction.privatePaths) {
    claimedTransaction = readPrivateClaimSlot(
      paths,
      transaction.value.token,
      'transaction'
    );
  }
  if ((transactionRaw !== null && transactionRaw !== transaction.raw)
      || (transactionRaw === null
        && (!claimedTransaction || !claimedTransaction.heldValue
          || claimedTransaction.heldValue.bytes.toString('utf8') !== transaction.raw))) {
    throw recoveryError('unpublished init transaction changed before recovery');
  }
  const verifyNoMutationEvidence = () => {
    assertTransactionEvidenceExact(paths, transaction);
    const canonicalRaw = readPointerRaw(paths.pointerPath);
    const legacyClaimRaw = readOptionalRecoveryFile(tokenClaimPath, MAX_POINTER_BYTES);
    const publishRaw = readOptionalRecoveryFile(transaction.publishPath, MAX_POINTER_BYTES);
    const privatePointerClaim = transaction.privatePaths
      ? readPrivateClaimSlot(paths, transaction.value.token, 'pointer') : null;
    const privatePartialClaim = transaction.privatePaths
      ? readPrivateClaimSlot(paths, transaction.value.token, 'partial') : null;
    const legacyPartialRaw = !transaction.privatePaths && transaction.partialPath
      ? readOptionalRecoveryFile(transaction.partialPath, MAX_POINTER_BYTES) : null;
    const legacyPartialReleaseRaw = !transaction.privatePaths && transaction.partialPath
      ? readOptionalRecoveryFile(`${transaction.partialPath}.release.tmp`, MAX_POINTER_BYTES) : null;
    if (canonicalRaw !== null || legacyClaimRaw !== null || publishRaw !== null
        || privatePointerClaim !== null || privatePartialClaim !== null
        || legacyPartialRaw !== null || legacyPartialReleaseRaw !== null) {
      throw recoveryError('unpublished init gained visible mutation evidence; evidence preserved');
    }
    if (isInitPriorCompletionTransaction(transaction)
        && readInitPriorCompletionSnapshot(paths, transaction) === null) {
      throw recoveryError('unpublished init prior completion changed during WAL cleanup');
    }
  };
  if (isInitPriorCompletionTransaction(transaction)) {
    restoreInitPriorCompletion(paths, transaction, {
      verifyBeforeDestroy: verifyNoMutationEvidence,
    });
  }
  verifyNoMutationEvidence();
  removeVerifiedRecoveryFile(
    paths.transactionPath,
    sha256(transaction.raw),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: transaction.value.token,
      artifact: 'transaction',
      verifyBeforeDestroy: verifyNoMutationEvidence,
    }
  );
  return { action: 'abort-unpublished-init' };
}

function privatePartialEvidence(paths, transaction) {
  if (!transaction.partialPath) return false;
  if (transaction.privatePaths) {
    return readPrivateClaimSlot(paths, transaction.value.token, 'partial') !== null;
  }
  return legacyPartialArtifacts(paths, transaction)
    .some((candidate) => readOptionalRecoveryFile(candidate.path, MAX_POINTER_BYTES) !== null);
}

function isSupersessionTransaction(transaction) {
  return Boolean(transaction
    && (transaction.value.operation === 'supersede'
      || (transaction.migrationReceipt
        && transaction.migrationReceipt.mode === 'prepare')));
}

function recoverNonCompletionTransaction(paths, { allowSupersession = false } = {}) {
  const transaction = readTransaction(paths);
  if (!transaction) return null;
  const state = transaction.value;
  if (state.operation === 'complete') return transaction;
  if (isSupersessionTransaction(transaction) && !allowSupersession) {
    throw recoveryError(
      'an interrupted supersession must be retried with the exact original supersede parameters'
    );
  }
  if (transaction.migrationReceipt
      && ['prepare', 'reference'].includes(transaction.migrationReceipt.mode)) {
    prepareTransactionMigrationReceipt(paths, transaction);
  }

  let canonicalRaw = readPointerRaw(paths.pointerPath);
  let claimState = readTransactionClaimState(paths, transaction);
  const tokenClaimPath = path.join(
    paths.stateDirectory,
    `active-sprint.claim-${state.token}.json`
  );
  const unexpectedInitClaim = state.operation === 'init'
    ? readOptionalRecoveryFile(tokenClaimPath, MAX_POINTER_BYTES) : claimState.raw;
  let publishRaw = readOptionalRecoveryFile(transaction.publishPath, MAX_POINTER_BYTES);
  if (privatePartialEvidence(paths, transaction)) {
    const initStateMatches = state.operation === 'init'
      && canonicalRaw === null
      && unexpectedInitClaim === null;
    const replaceStateMatches = transaction.privatePaths
      && ['replace', 'supersede'].includes(state.operation)
      && canonicalRaw !== null
      && sha256(canonicalRaw) === state.expected_sha256
      && claimState.claim === null
      && claimState.raw === null;
    if (!initStateMatches && !replaceStateMatches) {
      throw recoveryError('partial publish evidence conflicts with visible state; evidence preserved');
    }
    cleanupOwnedPartialPublishCandidate(paths, transaction, publishRaw);
    publishRaw = readOptionalRecoveryFile(transaction.publishPath, MAX_POINTER_BYTES);
  }
  if (publishRaw !== null && sha256(publishRaw) !== state.replacement_sha256) {
    throw recoveryError('publish candidate bytes do not match transaction');
  }
  const restoredPointerVerifier = (restoredRaw, label) => () => {
    assertTransactionEvidenceExact(paths, transaction);
    return assertExactPointerRaw(paths, restoredRaw, label);
  };
  if (transaction.privatePaths
      && canonicalRaw !== null
      && claimState.claim && claimState.claim.value
      && claimState.raw !== null
      && claimState.source && claimState.source.state === 'expected'
      && canonicalRaw === claimState.raw
      && sha256(canonicalRaw) === state.expected_sha256) {
    const restoredRaw = claimState.raw;
    const verifyTerminalState = restoredPointerVerifier(
      restoredRaw,
      'restored exact duplicate sprint pointer'
    );
    if (!restoreTransactionClaim(paths, transaction, restoredRaw, {
      verifyBeforeDestroy: verifyTerminalState,
    })) {
      throw recoveryError(
        'exact duplicate pointer claim could not be merged into the restored source'
      );
    }
    cleanupTransaction(paths, transaction, {
      publishHash: publishRaw === null ? undefined : state.replacement_sha256,
      verifyTerminalState,
    });
    return { action: 'restore-expected-pointer' };
  }
  if (claimState.raw !== null && sha256(claimState.raw) !== state.expected_sha256) {
    const restoredRaw = claimState.raw;
    const verifyTerminalState = restoredPointerVerifier(
      restoredRaw,
      'restored foreign sprint pointer'
    );
    if (canonicalRaw === null && restoreTransactionClaim(
      paths,
      transaction,
      restoredRaw,
      { verifyBeforeDestroy: verifyTerminalState }
    )) {
      cleanupTransaction(paths, transaction, {
        publishHash: publishRaw === null ? undefined : state.replacement_sha256,
        verifyTerminalState,
      });
      return { action: 'restore-foreign-claim' };
    }
    throw recoveryError('claimed pointer bytes do not match transaction; evidence preserved');
  }

  if (canonicalRaw === null) {
    if (claimState.claim && claimState.claim.empty) {
      throw recoveryError('empty private pointer claim has no canonical recovery proof');
    }
    if (claimState.raw !== null) {
      const restoredRaw = claimState.raw;
      const verifyTerminalState = restoredPointerVerifier(
        restoredRaw,
        'restored expected sprint pointer'
      );
      restoreTransactionClaim(paths, transaction, claimState.raw, {
        verifyBeforeDestroy: verifyTerminalState,
      });
      cleanupTransaction(paths, transaction, {
        publishHash: publishRaw === null ? undefined : state.replacement_sha256,
        verifyTerminalState,
      });
      return { action: 'restore-expected-pointer' };
    }
    if (state.operation === 'init' && publishRaw !== null) {
      if (isInitPriorCompletionTransaction(transaction)) {
        claimInitPriorCompletion(paths, transaction);
      }
      const published = publishTransactionPointer(paths, transaction);
      if (isInitPriorCompletionTransaction(transaction)) {
        retireInitPriorCompletion(paths, transaction);
      }
      const verifyTerminalState = isInitPriorCompletionTransaction(transaction)
        ? () => assertCommittedInitWithPriorCompletion(paths, transaction)
        : () => assertCommittedPointer(
          paths,
          transaction,
          published.raw
        );
      cleanupTransaction(paths, transaction, {
        publishHash: state.replacement_sha256,
        verifyTerminalState,
      });
      return { action: 'finish-init' };
    }
    if (state.operation === 'init' && claimState.raw === null && publishRaw === null) {
      return recoverUnpublishedInitTransaction(paths, transaction);
    }
    throw recoveryError('transaction has neither canonical pointer nor recoverable claim');
  }

  const canonicalHash = sha256(canonicalRaw);
  const committed = canonicalHash === state.replacement_sha256;
  const restored = state.expected_sha256 !== null
    && canonicalHash === state.expected_sha256;
  if (!committed && !restored) {
    if (isInitPriorCompletionTransaction(transaction)) {
      const observedPointerRaw = canonicalRaw;
      const verifyPriorCompletionAbort = () => {
        assertTransactionEvidenceExact(paths, transaction);
        return assertExactPointerRaw(
          paths,
          observedPointerRaw,
          'pointer observed while restoring prior completion'
        );
      };
      restoreInitPriorCompletion(paths, transaction, {
        verifyBeforeDestroy: verifyPriorCompletionAbort,
      });
    }
    throw recoveryError('transaction pointer successor differs from all WAL terminal states');
  }
  if (committed && publishRaw !== null && transaction.privatePaths) {
    const candidate = readStableRecoverySnapshot(transaction.publishPath, MAX_POINTER_BYTES);
    const pointer = assertCommittedPointer(paths, transaction, publishRaw);
    if (!sameFileIdentity(candidate.stat, pointer.stat)) {
      throw recoveryError('committed pointer is not the WAL-owned publish candidate');
    }
  }
  let claimHash;
  if (claimState.claim) {
    if (claimState.claim.empty) {
      claimHash = state.expected_sha256;
    } else if (claimState.raw !== null) {
      if (!committed) {
        throw recoveryError('claimed pointer source successor was preserved');
      }
      claimHash = state.expected_sha256;
    } else if (claimState.source) {
      const sourceHash = claimState.source.snapshot
        ? sha256(claimState.source.snapshot.bytes) : null;
      if (claimState.source.state === 'successor'
          && sourceHash !== state.replacement_sha256) {
        throw recoveryError('private pointer claim source successor was preserved');
      }
      claimHash = state.expected_sha256;
    }
  } else if (claimState.raw !== null) {
    if (!committed) {
      throw recoveryError('legacy claimed pointer source successor was preserved');
    }
    claimHash = state.expected_sha256;
  }
  if (committed && isInitPriorCompletionTransaction(transaction)) {
    retireInitPriorCompletion(paths, transaction);
  }
  const verifyTerminalState = committed
    ? (isInitPriorCompletionTransaction(transaction)
      ? () => assertCommittedInitWithPriorCompletion(paths, transaction)
      : (isSupersessionTransaction(transaction)
      ? () => assertCommittedSupersession(paths, transaction)
      : () => assertCommittedPointer(
        paths,
        transaction,
        publishRaw === null ? canonicalRaw : publishRaw
      )))
    : () => assertExactPointerRaw(
      paths,
      canonicalRaw,
      'aborted transaction pointer'
    );
  cleanupTransaction(paths, transaction, {
    claimHash,
    publishHash: publishRaw === null ? undefined : state.replacement_sha256,
    allowedClaimSourceHash: committed ? state.replacement_sha256 : null,
    verifyTerminalState,
  });
  return {
    action: committed
      ? (state.operation === 'init' ? 'finish-init' : 'finish-replace')
      : 'abort-replace',
  };
}

function inferTransactionExpectedPhase(paths, transaction) {
  if (!transaction || transaction.value.operation === 'init') return null;
  const candidates = [];
  const claimState = readTransactionClaimState(paths, transaction);
  if (claimState.raw !== null
      && sha256(claimState.raw) === transaction.value.expected_sha256) {
    candidates.push(claimState.raw);
  }
  const canonicalRaw = readPointerRaw(paths.pointerPath);
  if (canonicalRaw !== null
      && sha256(canonicalRaw) === transaction.value.expected_sha256) {
    candidates.push(canonicalRaw);
  }
  for (const candidateRaw of candidates) {
    let value;
    try {
      value = JSON.parse(candidateRaw);
    } catch (error) {
      throw recoveryError('transaction expected pointer JSON is invalid', { cause: error });
    }
    const validated = validatePointerSchema(paths.workspace, value);
    if (!validated.ok || `${JSON.stringify(validated.pointer)}\n` !== candidateRaw) {
      throw recoveryError('transaction expected pointer proof is not canonical');
    }
    return validated.pointer.phase;
  }
  if (transaction.replacementPointer
      && transaction.replacementPointer.status === 'blocked') {
    return transaction.replacementPointer.phase;
  }
  const target = transaction.replacementPointer && transaction.replacementPointer.phase;
  const predecessors = [...VALID_PHASES]
    .filter((phase) => ALLOWED_TRANSITIONS[phase].has(target));
  return predecessors.length === 1 ? predecessors[0] : null;
}

function exactRecoveredPointerMutation(prepared, {
  operation,
  expectedPhase,
  replacementRaw,
}) {
  if (!prepared || !prepared.transaction || !prepared.recovery) return null;
  const transaction = prepared.transaction;
  const expectedAction = operation === 'init' ? 'finish-init' : 'finish-replace';
  if (transaction.value.operation !== operation
      || prepared.recovery.action !== expectedAction
      || transaction.replacementRaw !== replacementRaw
      || (operation !== 'init' && prepared.expectedPhase !== expectedPhase)) {
    return null;
  }
  assertCommittedPointer(prepared.paths, transaction, replacementRaw);
  return transaction.replacementPointer;
}

function prepareNonCompletionMutation(paths) {
  const pending = readTransaction(paths);
  if (pending && pending.value.operation === 'complete') {
    throw recoveryError(
      'an interrupted completion must be retried with complete --expected compound'
    );
  }
  const prepared = pending ? {
    paths,
    transaction: pending,
    expectedPhase: inferTransactionExpectedPhase(paths, pending),
  } : null;
  const recovery = pending ? recoverNonCompletionTransaction(paths) : null;
  if (readPointerRaw(paths.pointerPath) !== null) cleanupCompletionRecord(paths);
  return prepared ? { ...prepared, recovery } : null;
}

function atomicWriteSprintPointer(
  paths,
  pointer,
  expectedRaw,
  {
    migrationReceiptRaw = null,
    migrationReceiptReference = null,
    initPriorCompletion = null,
  } = {}
) {
  const replacementRaw = `${JSON.stringify(pointer)}\n`;
  const operation = migrationReceiptReference
    ? 'supersede' : (expectedRaw === null ? 'init' : 'replace');
  const transaction = createTransaction(paths, {
    operation,
    expectedRaw,
    replacementRaw,
    plan: pointer.plan,
    phase: pointer.phase,
    migrationReceiptRaw,
    migrationReceiptReference,
    priorCompletionSha256: initPriorCompletion
      ? sha256(initPriorCompletion.raw)
      : null,
  });
  let claimRaw = null;
  try {
    if (transaction.migrationReceipt
        && ['prepare', 'reference'].includes(transaction.migrationReceipt.mode)) {
      prepareTransactionMigrationReceipt(paths, transaction);
    }
    if (expectedRaw !== null) {
      const snapshot = readStableRecoverySnapshot(paths.pointerPath, MAX_POINTER_BYTES);
      if (sha256(snapshot.bytes) !== transaction.value.expected_sha256) {
        throw sprintStateError(
          'SPRINT_STATE_CONFLICT',
          'pointer changed before private claim; no bytes were deleted'
        );
      }
      const claim = createPrivateClaim(paths, {
        scopeToken: transaction.value.token,
        artifact: 'pointer',
        sourcePath: paths.pointerPath,
        snapshot,
      });
      claimRaw = claim.value.bytes.toString('utf8');
    }
    if (isInitPriorCompletionTransaction(transaction)) {
      claimInitPriorCompletion(paths, transaction, initPriorCompletion);
    }

    const published = publishTransactionPointer(paths, transaction);
    if (isInitPriorCompletionTransaction(transaction)) {
      retireInitPriorCompletion(paths, transaction);
    }
    const verifyTerminalState = isInitPriorCompletionTransaction(transaction)
      ? () => assertCommittedInitWithPriorCompletion(paths, transaction)
      : (transaction.value.version === SUPERSESSION_TRANSACTION_VERSION
        ? () => assertCommittedSupersession(paths, transaction)
        : () => assertCommittedPointer(paths, transaction, published.raw));
    if (transaction.value.version === SUPERSESSION_TRANSACTION_VERSION) {
      verifyTerminalState();
    }
    cleanupTransaction(paths, transaction, {
      claimHash: claimRaw === null ? undefined : transaction.value.expected_sha256,
      publishHash: transaction.value.replacement_sha256,
      allowedClaimSourceHash: transaction.value.replacement_sha256,
      verifyTerminalState,
    });
  } catch (error) {
    if (isInitPriorCompletionTransaction(transaction)) {
      try {
        const currentRaw = readPointerRaw(paths.pointerPath);
        if (currentRaw !== transaction.replacementRaw) {
          const verifyPriorCompletionAbort = () => {
            assertTransactionEvidenceExact(paths, transaction);
            const pointerNow = readPointerRaw(paths.pointerPath);
            if (pointerNow !== currentRaw
                || pointerNow === transaction.replacementRaw) {
              throw recoveryError(
                'init pointer changed while restoring its prior completion'
              );
            }
          };
          restoreInitPriorCompletion(paths, transaction, {
            verifyBeforeDestroy: verifyPriorCompletionAbort,
          });
        }
      } catch (restoreError) {
        if (error && typeof error === 'object') {
          error.priorCompletionRecoveryCause = restoreError;
        }
      }
    }
    if (error && [
      'SPRINT_STATE_CONFLICT',
      'SPRINT_RECOVERY_REQUIRED',
    ].includes(error.code)) {
      throw error;
    }
    throw recoveryError('active sprint pointer transaction did not finish cleanly', {
      cause: error,
    });
  }
}
function canonicalPointer({
  plan, phase, status = 'active', next, now, blockReason, acceptanceProtocol,
  migrationReceiptSha256,
}) {
  return {
    version: POINTER_VERSION,
    plan,
    phase,
    status,
    updated_at: now,
    next,
    ...(acceptanceProtocol ? { acceptance_protocol: acceptanceProtocol } : {}),
    ...(migrationReceiptSha256
      ? { migration_receipt_sha256: migrationReceiptSha256 }
      : {}),
    ...(status === 'blocked' ? { block_reason: blockReason } : {}),
  };
}

function initActiveSprint({
  cwd = process.cwd(), plan, restorePhase, next, now, acceptanceProtocol = 'legacy',
} = {}) {
  const normalizedPlan = validatePlanForState(cwd, plan);
  const initialPhase = restorePhase === undefined
    ? 'think' : normalizeStatePhase(restorePhase, 'restore phase');
  const normalizedNext = normalizeStateText(next, 'next');
  const normalizedNow = normalizeStateTimestamp(now);
  if (!['legacy', 'v1'].includes(acceptanceProtocol)) {
    throw sprintStateError(
      'INVALID_SPRINT_ACCEPTANCE_PROTOCOL',
      'acceptanceProtocol must be legacy or v1'
    );
  }
  return withSprintStateLock(cwd, (paths) => {
    const prepared = prepareNonCompletionMutation(paths);
    const pointer = canonicalPointer({
      plan: normalizedPlan,
      phase: initialPhase,
      next: normalizedNext,
      now: normalizedNow,
      acceptanceProtocol: acceptanceProtocol === 'v1' ? 'v1' : undefined,
    });
    const recoveredPointer = exactRecoveredPointerMutation(prepared, {
      operation: 'init',
      expectedPhase: null,
      replacementRaw: `${JSON.stringify(pointer)}\n`,
    });
    if (recoveredPointer) {
      return { action: 'init', pointer: recoveredPointer, recovered: true };
    }
    if (readPointerRaw(paths.pointerPath) !== null) {
      throw sprintStateError('SPRINT_ALREADY_ACTIVE', 'refusing to replace an active sprint pointer');
    }
    const priorCompletion = readCompletionRecord(paths);
    atomicWriteSprintPointer(paths, pointer, null, { initPriorCompletion: priorCompletion });
    return { action: 'init', pointer };
  });
}

function assertSupersessionReceiptMatches(receipt, context, code = 'INVALID_SPRINT_MIGRATION_RECEIPT') {
  const value = receipt.value;
  if (value.schema_version !== 'sprint-migration-receipt/v2'
      || receipt.digest !== context.receiptSha256
      || receipt.path !== context.receiptPath
      || value.source.pointer_sha256 !== context.pointerSha256
      || value.source.pointer_raw !== context.pointerRaw
      || JSON.stringify(value.source.pointer) !== JSON.stringify(context.pointer)
      || value.source.plan !== context.sourcePlan.plan
      || value.source.plan_sha256 !== context.sourcePlan.sha256
      || value.source.tasks_completed !== context.sourcePlan.tasksCompleted
      || value.source.tasks_total !== context.sourcePlan.tasksTotal
      || JSON.stringify(value.source.open_task_ids)
        !== JSON.stringify(context.openTaskIds)
      || value.target.plan !== context.targetPlan.plan
      || value.target.plan_sha256 !== context.targetPlan.sha256
      || value.target.tasks_completed !== context.targetPlan.tasksCompleted
      || value.target.tasks_total !== context.targetPlan.tasksTotal
      || value.target.next !== context.next
      || value.task_map.path !== context.taskMap.relative
      || value.task_map.sha256 !== context.taskMap.sha256
      || JSON.stringify(value.task_map.value) !== JSON.stringify(context.taskMap.value)
      || value.approval.path !== context.approval.relative
      || value.approval.sha256 !== context.approval.sha256
      || JSON.stringify(value.approval.value) !== JSON.stringify(context.approval.value)
      || value.previous_migration_receipt_sha256
        !== (context.pointer.migration_receipt_sha256 || null)) {
    throw sprintStateError(code, 'migration receipt is not bound to the exact supersession inputs');
  }
  return value;
}

function assertPendingSupersessionMatches(paths, transaction, context) {
  if (!isSupersessionTransaction(transaction)
      || !transaction.migrationReceipt
      || !transaction.migrationReceiptValue) {
    throw recoveryError('pending transaction is not an exact supersession recovery candidate');
  }
  const proof = transaction.migrationReceipt;
  const value = transaction.migrationReceiptValue;
  const proofPath = proof.path || path.relative(
    paths.workspace,
    migrationReceiptFile(paths.workspace, proof.sha256)
  ).replace(/\\/g, '/');
  if (proof.sha256 !== context.receiptSha256
      || proofPath !== context.receiptPath
      || transaction.value.expected_sha256 !== context.pointerSha256
      || transaction.value.plan !== context.targetPlan
      || value.source.plan_sha256 !== context.oldPlanSha256
      || value.target.plan_sha256 !== context.newPlanSha256
      || value.target.next !== context.next
      || value.task_map.path !== context.taskMapPath
      || value.task_map.sha256 !== context.taskMapSha256
      || value.approval.path !== context.approvalPath
      || value.approval.sha256 !== context.approvalSha256) {
    throw sprintStateError(
      'SPRINT_STATE_CONFLICT',
      'pending supersession belongs to different hash, evidence, or next parameters'
    );
  }
  prepareTransactionMigrationReceipt(paths, transaction);
  return transaction;
}

function inspectPendingV4Supersession(cwd = process.cwd()) {
  const paths = ensureStateDirectory(cwd, { create: false });
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(paths.transactionPath, MAX_TRANSACTION_BYTES);
  } catch (error) {
    throw recoveryError('a stable pending transaction is required for v4 inspection', {
      cause: error,
    });
  }
  const raw = snapshot.bytes.toString('utf8');
  const transaction = parseTransaction(paths, raw);
  if (transaction.value.version !== LINEAGE_TRANSACTION_VERSION
      || transaction.value.operation !== 'replace'
      || !transaction.migrationReceipt
      || transaction.migrationReceipt.mode !== 'prepare'
      || !transaction.migrationReceiptValue) {
    throw recoveryError('pending transaction is not a legacy v4 supersession');
  }
  const receiptPath = path.relative(
    paths.workspace,
    migrationReceiptFile(paths.workspace, transaction.migrationReceipt.sha256)
  ).replace(/\\/g, '/');
  return {
    action: 'inspect-v4-supersede-recovery',
    transactionSha256: sha256(raw),
    transactionPath: paths.transactionPath,
    receipt: {
      path: receiptPath,
      sha256: transaction.migrationReceipt.sha256,
      raw: transaction.migrationReceipt.raw,
    },
  };
}

function prepareSupersessionProposal({
  cwd = process.cwd(), expectedPhase, expectedPointerSha256, oldPlanSha256,
  plan, newPlanSha256, taskMap, taskMapSha256, approvalReceipt,
  approvalSha256, next,
} = {}) {
  const expected = normalizeStatePhase(expectedPhase, 'expected phase');
  if (expected !== 'compound') {
    throw sprintStateError(
      'ILLEGAL_SPRINT_SUPERSESSION',
      'supersede proposal requires expected phase compound'
    );
  }
  const expectedPointerHash = normalizeSha256(
    expectedPointerSha256,
    'expected pointer sha256'
  );
  const expectedOldPlanHash = normalizeSha256(oldPlanSha256, 'old plan sha256');
  const expectedNewPlanHash = normalizeSha256(newPlanSha256, 'new plan sha256');
  const expectedTaskMapHash = normalizeSha256(taskMapSha256, 'task map sha256');
  const expectedApprovalHash = normalizeSha256(approvalSha256, 'approval sha256');
  const normalizedTargetPlan = validatePlanForState(cwd, plan);
  const normalizedNext = normalizeStateText(next, 'next');
  const normalizedTaskMap = normalizeEvidencePath(
    cwd,
    taskMap,
    'task map',
    'INVALID_SPRINT_TASK_MAP'
  );
  const normalizedApproval = normalizeEvidencePath(
    cwd,
    approvalReceipt,
    'owner approval',
    'INVALID_SPRINT_APPROVAL'
  );
  const paths = ensureStateDirectory(cwd, { create: false });
  const recovery = readSprintRecoveryStatus(cwd, paths.pointerPath, {
    includeCompletion: true,
  });
  if (recovery) {
    throw recoveryError(
      `supersede proposal requires a clean active pointer: ${recovery.reason}`
    );
  }
  const snapshot = readSprintStateSnapshot(cwd, paths.pointerPath);
  assertExpectedPhase(snapshot.pointer, expected);
  if (snapshot.pointer.status !== 'blocked') {
    throw sprintStateError(
      'ILLEGAL_SPRINT_SUPERSESSION',
      'supersede proposal requires a blocked compound sprint'
    );
  }
  if (sha256(snapshot.raw) !== expectedPointerHash) {
    throw sprintStateError(
      'SPRINT_STATE_CONFLICT',
      'active sprint raw pointer sha256 does not match the proposed predecessor'
    );
  }
  const sourcePlan = readPlanMigrationSnapshot(
    cwd,
    snapshot.pointer.plan,
    expectedOldPlanHash,
    'source plan'
  );
  const previousReceipt = snapshot.pointer.migration_receipt_sha256
    ? readMigrationReceipt(
      cwd,
      snapshot.pointer.migration_receipt_sha256,
      { targetPlan: sourcePlan.plan }
    )
    : null;
  const targetPlan = readPlanMigrationSnapshot(
    cwd,
    normalizedTargetPlan,
    expectedNewPlanHash,
    'target plan'
  );
  assertDistinctSupersessionPlanIdentity(cwd, sourcePlan.plan, targetPlan.plan, {
    sourceStat: sourcePlan.snapshot.stat,
    targetStat: targetPlan.snapshot.stat,
  });
  if (String(sourcePlan.status).toLowerCase() === 'completed'
      || String(targetPlan.status).toLowerCase() === 'completed'
      || targetPlan.tasksCompleted !== 0) {
    throw sprintStateError(
      'ILLEGAL_SPRINT_SUPERSESSION',
      'supersede proposal requires an unfinished predecessor and a zero-complete successor'
    );
  }
  const taskMapEvidence = readCanonicalEvidence(
    cwd,
    normalizedTaskMap.relative,
    expectedTaskMapHash,
    'task map',
    'INVALID_SPRINT_TASK_MAP'
  );
  const validatedTaskMap = validateTaskMap(
    taskMapEvidence.value,
    sourcePlan,
    targetPlan
  );
  const approvalEvidence = readCanonicalEvidence(
    cwd,
    normalizedApproval.relative,
    expectedApprovalHash,
    'owner approval',
    'INVALID_SPRINT_APPROVAL'
  );
  const observedAt = new Date().toISOString();
  validateOwnerApproval(approvalEvidence.value, {
    observedAt,
    pointerSha256: expectedPointerHash,
    sourcePlan,
    targetPlan,
    taskMapSha256: expectedTaskMapHash,
    openTaskIds: validatedTaskMap.openTaskIds,
    next: normalizedNext,
  });
  const sourceBeforeOutput = readPlanMigrationSnapshot(
    cwd,
    sourcePlan.plan,
    sourcePlan.sha256,
    'source plan'
  );
  const targetBeforeOutput = readPlanMigrationSnapshot(
    cwd,
    targetPlan.plan,
    targetPlan.sha256,
    'target plan'
  );
  const taskMapBeforeOutput = readCanonicalEvidence(
    cwd,
    taskMapEvidence.relative,
    taskMapEvidence.sha256,
    'task map',
    'INVALID_SPRINT_TASK_MAP'
  );
  const approvalBeforeOutput = readCanonicalEvidence(
    cwd,
    approvalEvidence.relative,
    approvalEvidence.sha256,
    'owner approval',
    'INVALID_SPRINT_APPROVAL'
  );
  const previousReceiptBeforeOutput = previousReceipt
    ? readMigrationReceipt(cwd, previousReceipt.digest, { targetPlan: sourcePlan.plan })
    : null;
  if (!sameFileIdentity(sourcePlan.snapshot.stat, sourceBeforeOutput.snapshot.stat)
      || !sameFileIdentity(targetPlan.snapshot.stat, targetBeforeOutput.snapshot.stat)
      || !sameFileIdentity(taskMapEvidence.snapshot.stat, taskMapBeforeOutput.snapshot.stat)
      || !sameFileIdentity(approvalEvidence.snapshot.stat, approvalBeforeOutput.snapshot.stat)
      || sourcePlan.raw !== sourceBeforeOutput.raw
      || targetPlan.raw !== targetBeforeOutput.raw
      || taskMapEvidence.raw !== taskMapBeforeOutput.raw
      || approvalEvidence.raw !== approvalBeforeOutput.raw
      || (previousReceipt && (
        !sameFileIdentity(
          previousReceipt.snapshot.stat,
          previousReceiptBeforeOutput.snapshot.stat
        )
        || previousReceipt.raw !== previousReceiptBeforeOutput.raw
      ))
      || readPointerRaw(paths.pointerPath) !== snapshot.raw) {
    throw sprintStateError(
      'SPRINT_STATE_CONFLICT',
      'supersede proposal inputs changed while preparing the receipt'
    );
  }
  const value = {
    schema_version: 'sprint-migration-receipt/v2',
    kind: 'supersede_with_open_tasks',
    source: {
      status: 'superseded_with_open_tasks',
      pointer_sha256: expectedPointerHash,
      pointer_raw: snapshot.raw,
      pointer: snapshot.pointer,
      plan: sourcePlan.plan,
      plan_sha256: sourcePlan.sha256,
      tasks_completed: sourcePlan.tasksCompleted,
      tasks_total: sourcePlan.tasksTotal,
      open_task_ids: validatedTaskMap.openTaskIds,
    },
    target: {
      plan: targetPlan.plan,
      plan_sha256: targetPlan.sha256,
      phase: 'think',
      status: 'active',
      acceptance_protocol: 'v1',
      tasks_completed: targetPlan.tasksCompleted,
      tasks_total: targetPlan.tasksTotal,
      next: normalizedNext,
    },
    task_map: {
      path: taskMapEvidence.relative,
      sha256: taskMapEvidence.sha256,
      value: taskMapEvidence.value,
    },
    approval: {
      path: approvalEvidence.relative,
      sha256: approvalEvidence.sha256,
      value: approvalEvidence.value,
    },
    previous_migration_receipt_sha256:
      snapshot.pointer.migration_receipt_sha256 || null,
    prepared_at: observedAt,
    goal_preserved: true,
  };
  const raw = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(raw, 'utf8') > MAX_MIGRATION_EVIDENCE_BYTES) {
    throw sprintStateError(
      'INVALID_SPRINT_MIGRATION_RECEIPT',
      'supersede proposal exceeds the migration evidence budget'
    );
  }
  const digest = sha256(raw);
  const receiptAbsolutePath = migrationReceiptFile(paths.workspace, digest);
  const receiptPath = path.relative(paths.workspace, receiptAbsolutePath).replace(/\\/g, '/');
  validateMigrationReceiptValue(cwd, value, { targetPlan: targetPlan.plan });
  assertSupersessionReceiptMatches({
    digest,
    path: receiptAbsolutePath,
    raw,
    value,
  }, {
    receiptSha256: digest,
    receiptPath: receiptAbsolutePath,
    pointerSha256: expectedPointerHash,
    pointerRaw: snapshot.raw,
    pointer: snapshot.pointer,
    sourcePlan,
    targetPlan,
    openTaskIds: validatedTaskMap.openTaskIds,
    taskMap: taskMapEvidence,
    approval: approvalEvidence,
    next: normalizedNext,
  });
  return {
    action: 'prepare-supersede-proposal',
    observedAt,
    receipt: {
      path: receiptPath,
      sha256: digest,
      raw,
      value,
    },
  };
}

function supersedeActiveSprint({
  cwd = process.cwd(), expectedPhase, expectedPointerSha256, oldPlanSha256,
  plan, newPlanSha256, taskMap, taskMapSha256, approvalReceipt,
  approvalSha256, migrationReceipt, migrationReceiptSha256, next,
} = {}) {
  const expected = normalizeStatePhase(expectedPhase, 'expected phase');
  if (expected !== 'compound') {
    throw sprintStateError(
      'ILLEGAL_SPRINT_SUPERSESSION',
      'supersede requires expected phase compound'
    );
  }
  const expectedPointerHash = normalizeSha256(
    expectedPointerSha256,
    'expected pointer sha256'
  );
  const expectedOldPlanHash = normalizeSha256(oldPlanSha256, 'old plan sha256');
  const expectedNewPlanHash = normalizeSha256(newPlanSha256, 'new plan sha256');
  const expectedTaskMapHash = normalizeSha256(taskMapSha256, 'task map sha256');
  const expectedApprovalHash = normalizeSha256(approvalSha256, 'approval sha256');
  const expectedReceiptHash = normalizeSha256(
    migrationReceiptSha256,
    'migration receipt sha256',
    'INVALID_SPRINT_MIGRATION_RECEIPT'
  );
  const normalizedTargetPlan = validatePlanForState(cwd, plan);
  const activeBeforeLock = readActiveSprintPointer(cwd);
  if (activeBeforeLock.active
      && activeBeforeLock.phase === 'compound'
      && activeBeforeLock.status === 'blocked') {
    assertDistinctSupersessionPlanIdentity(
      cwd,
      activeBeforeLock.plan,
      normalizedTargetPlan
    );
  }
  const normalizedNext = normalizeStateText(next, 'next');
  const normalizedTaskMap = normalizeEvidencePath(
    cwd,
    taskMap,
    'task map',
    'INVALID_SPRINT_TASK_MAP'
  );
  const normalizedApproval = normalizeEvidencePath(
    cwd,
    approvalReceipt,
    'owner approval',
    'INVALID_SPRINT_APPROVAL'
  );
  const normalizedReceipt = assertMigrationReceiptReference(
    cwd,
    migrationReceipt,
    expectedReceiptHash
  );

  return withSprintStateLock(cwd, (paths) => {
    const pending = readTransaction(paths);
    if (pending && isSupersessionTransaction(pending)) {
      assertPendingSupersessionMatches(paths, pending, {
        pointerSha256: expectedPointerHash,
        oldPlanSha256: expectedOldPlanHash,
        targetPlan: normalizedTargetPlan,
        newPlanSha256: expectedNewPlanHash,
        taskMapPath: normalizedTaskMap.relative,
        taskMapSha256: expectedTaskMapHash,
        approvalPath: normalizedApproval.relative,
        approvalSha256: expectedApprovalHash,
        receiptPath: normalizedReceipt.relative,
        receiptSha256: expectedReceiptHash,
        next: normalizedNext,
      });
    }
    const recovered = recoverNonCompletionTransaction(paths, {
      allowSupersession: Boolean(pending && isSupersessionTransaction(pending)),
    });
    if (recovered && recovered.value && recovered.value.operation === 'complete') {
      throw recoveryError('an interrupted completion cannot be superseded');
    }
    if (readCompletionRecord(paths)) {
      throw recoveryError('completion evidence conflicts with an active supersession');
    }
    const snapshot = readSprintStateSnapshot(cwd, paths.pointerPath);
    if (snapshot.pointer.plan === normalizedTargetPlan
        && snapshot.pointer.migration_receipt_sha256) {
      if (snapshot.pointer.migration_receipt_sha256 !== expectedReceiptHash) {
        throw sprintStateError(
          'SPRINT_STATE_CONFLICT',
          'active successor references a different migration receipt'
        );
      }
      const prior = readMigrationReceipt(
        cwd,
        expectedReceiptHash,
        { targetPlan: normalizedTargetPlan, path: normalizedReceipt.relative }
      );
      const value = prior.value;
      if (value.source.pointer_sha256 !== expectedPointerHash
          || value.source.plan_sha256 !== expectedOldPlanHash
          || value.target.plan_sha256 !== expectedNewPlanHash
          || value.target.next !== normalizedNext
          || value.task_map.path !== normalizedTaskMap.relative
          || value.task_map.sha256 !== expectedTaskMapHash
          || value.approval.path !== normalizedApproval.relative
          || value.approval.sha256 !== expectedApprovalHash) {
        throw sprintStateError(
          'SPRINT_STATE_CONFLICT',
          'active successor belongs to a different migration'
        );
      }
      return {
        action: 'supersede',
        alreadySuperseded: true,
        pointer: snapshot.pointer,
        migrationReceiptSha256: prior.digest,
        migrationReceiptPath: prior.path,
      };
    }

    assertExpectedPhase(snapshot.pointer, expected);
    if (snapshot.pointer.status !== 'blocked') {
      throw sprintStateError(
        'ILLEGAL_SPRINT_SUPERSESSION',
        'supersede requires a blocked compound sprint'
      );
    }
    if (sha256(snapshot.raw) !== expectedPointerHash) {
      throw sprintStateError(
        'SPRINT_STATE_CONFLICT',
        'active sprint raw pointer sha256 does not match the approved predecessor'
      );
    }

    const sourcePlan = readPlanMigrationSnapshot(
      cwd,
      snapshot.pointer.plan,
      expectedOldPlanHash,
      'source plan'
    );
    const targetPlan = readPlanMigrationSnapshot(
      cwd,
      normalizedTargetPlan,
      expectedNewPlanHash,
      'target plan'
    );
    assertDistinctSupersessionPlanIdentity(cwd, sourcePlan.plan, targetPlan.plan, {
      sourceStat: sourcePlan.snapshot.stat,
      targetStat: targetPlan.snapshot.stat,
    });
    if (String(sourcePlan.status).toLowerCase() === 'completed'
        || String(targetPlan.status).toLowerCase() === 'completed'
        || targetPlan.tasksCompleted !== 0) {
      throw sprintStateError(
        'ILLEGAL_SPRINT_SUPERSESSION',
        'supersede requires an unfinished predecessor and a zero-complete successor'
      );
    }
    const taskMapEvidence = readCanonicalEvidence(
      cwd,
      taskMap,
      expectedTaskMapHash,
      'task map',
      'INVALID_SPRINT_TASK_MAP'
    );
    const validatedTaskMap = validateTaskMap(
      taskMapEvidence.value,
      sourcePlan,
      targetPlan
    );
    const approvalEvidence = readCanonicalEvidence(
      cwd,
      approvalReceipt,
      expectedApprovalHash,
      'owner approval',
      'INVALID_SPRINT_APPROVAL'
    );
    const trustedAt = new Date().toISOString();
    const approval = validateOwnerApproval(approvalEvidence.value, {
      observedAt: trustedAt,
      pointerSha256: expectedPointerHash,
      sourcePlan,
      targetPlan,
      taskMapSha256: expectedTaskMapHash,
      openTaskIds: validatedTaskMap.openTaskIds,
      next: normalizedNext,
    });
    const receiptEvidence = readMigrationReceipt(cwd, expectedReceiptHash, {
      targetPlan: targetPlan.plan,
      path: normalizedReceipt.relative,
    });
    assertSupersessionReceiptMatches(receiptEvidence, {
      receiptSha256: expectedReceiptHash,
      receiptPath: normalizedReceipt.absolute,
      pointerSha256: expectedPointerHash,
      pointerRaw: snapshot.raw,
      pointer: snapshot.pointer,
      sourcePlan,
      targetPlan,
      openTaskIds: validatedTaskMap.openTaskIds,
      taskMap: taskMapEvidence,
      approval: approvalEvidence,
      next: normalizedNext,
    });
    if (Math.abs(Date.parse(trustedAt) - Date.parse(receiptEvidence.value.prepared_at))
        > MAX_RECEIPT_PREPARATION_SKEW_MS) {
      throw sprintStateError(
        'INVALID_SPRINT_MIGRATION_RECEIPT',
        'migration receipt prepared_at is outside the trusted validation skew'
      );
    }
    const sourceBeforeCommit = readPlanMigrationSnapshot(
      cwd,
      sourcePlan.plan,
      sourcePlan.sha256,
      'source plan'
    );
    const targetBeforeCommit = readPlanMigrationSnapshot(
      cwd,
      targetPlan.plan,
      targetPlan.sha256,
      'target plan'
    );
    const taskMapBeforeCommit = readCanonicalEvidence(
      cwd,
      taskMapEvidence.relative,
      taskMapEvidence.sha256,
      'task map',
      'INVALID_SPRINT_TASK_MAP'
    );
    const approvalBeforeCommit = readCanonicalEvidence(
      cwd,
      approvalEvidence.relative,
      approvalEvidence.sha256,
      'owner approval',
      'INVALID_SPRINT_APPROVAL'
    );
    const receiptBeforeCommit = readMigrationReceipt(cwd, expectedReceiptHash, {
      targetPlan: targetPlan.plan,
      path: normalizedReceipt.relative,
    });
    if (!sameFileIdentity(sourcePlan.snapshot.stat, sourceBeforeCommit.snapshot.stat)
        || !sameFileIdentity(targetPlan.snapshot.stat, targetBeforeCommit.snapshot.stat)
        || !sameFileIdentity(taskMapEvidence.snapshot.stat, taskMapBeforeCommit.snapshot.stat)
        || !sameFileIdentity(approvalEvidence.snapshot.stat, approvalBeforeCommit.snapshot.stat)
        || !sameFileIdentity(receiptEvidence.snapshot.stat, receiptBeforeCommit.snapshot.stat)
        || receiptEvidence.raw !== receiptBeforeCommit.raw
        || readPointerRaw(paths.pointerPath) !== snapshot.raw) {
      throw sprintStateError(
        'SPRINT_STATE_CONFLICT',
        'supersession inputs changed before pointer commit'
      );
    }

    const pointer = canonicalPointer({
      plan: targetPlan.plan,
      phase: 'think',
      status: 'active',
      next: normalizedNext,
      now: trustedAt,
      acceptanceProtocol: 'v1',
      migrationReceiptSha256: receiptEvidence.digest,
    });
    atomicWriteSprintPointer(
      paths,
      pointer,
      snapshot.raw,
      {
        migrationReceiptReference: {
          path: normalizedReceipt.relative,
          sha256: receiptEvidence.digest,
          raw: receiptEvidence.raw,
          validatedAt: trustedAt,
        },
      }
    );
    const receipt = readMigrationReceipt(cwd, pointer.migration_receipt_sha256, {
      targetPlan: targetPlan.plan,
      path: normalizedReceipt.relative,
    });
    const committed = readSprintStateSnapshot(cwd, paths.pointerPath);
    if (committed.pointer.migration_receipt_sha256 !== receipt.digest
        || committed.pointer.plan !== targetPlan.plan
        || committed.pointer.phase !== 'think'
        || committed.pointer.status !== 'active') {
      throw recoveryError('supersession pointer readback is incomplete');
    }
    return {
      action: 'supersede',
      alreadySuperseded: false,
      pointer: committed.pointer,
      migrationReceiptSha256: receipt.digest,
      migrationReceiptPath: receipt.path,
    };
  });
}

function advanceActiveSprint({
  cwd = process.cwd(), expectedPhase, toPhase, next, now, controlRoot,
} = {}) {
  const expected = normalizeStatePhase(expectedPhase, 'expected phase');
  const target = normalizeStatePhase(toPhase, 'target phase');
  const normalizedNext = normalizeStateText(next, 'next');
  const normalizedNow = normalizeStateTimestamp(now);
  return withSprintStateLock(cwd, (paths) => {
    const prepared = prepareNonCompletionMutation(paths);
    if (prepared && prepared.transaction.replacementPointer) {
      const replacement = prepared.transaction.replacementPointer;
      const requestedPointer = canonicalPointer({
        plan: replacement.plan,
        phase: target,
        next: normalizedNext,
        now: normalizedNow,
        acceptanceProtocol: replacement.acceptance_protocol,
        migrationReceiptSha256: replacement.migration_receipt_sha256,
      });
      const recoveredPointer = exactRecoveredPointerMutation(prepared, {
        operation: 'replace',
        expectedPhase: expected,
        replacementRaw: `${JSON.stringify(requestedPointer)}\n`,
      });
      if (recoveredPointer) {
        return {
          action: 'advance',
          from: expected,
          to: target,
          pointer: recoveredPointer,
          recovered: true,
        };
      }
    }
    const snapshot = readSprintStateSnapshot(cwd, paths.pointerPath);
    assertExpectedPhase(snapshot.pointer, expected);
    if (!ALLOWED_TRANSITIONS[expected].has(target)) {
      throw sprintStateError(
        'ILLEGAL_SPRINT_TRANSITION',
        `cannot advance from ${expected} to ${target}`
      );
    }
    if ((snapshot.pointer.acceptance_protocol || 'legacy') === 'v1') {
      const requiresFreeze = expected === 'plan' && target === 'work';
      const requiresPassedReceipt = expected === 'review' && target === 'compound';
      const planFile = path.resolve(cwd, snapshot.pointer.plan);
      const hasExplicitHarnessBinding = fs.existsSync(`${planFile}.acceptance.json`);
      if (hasExplicitHarnessBinding && (requiresFreeze || requiresPassedReceipt)) {
        if (typeof controlRoot !== 'string' || !controlRoot.trim()) {
          throw sprintStateError(
            'SPRINT_ACCEPTANCE_REQUIRED',
            'Harness-bound sprint transition requires --control-root'
          );
        }
        try {
          loadSprintAcceptanceAdapter().verifySprintAcceptance({
            cwd,
            plan: snapshot.pointer.plan,
            controlRoot,
            requirePassed: requiresPassedReceipt,
          });
        } catch (error) {
          throw sprintStateError('SPRINT_ACCEPTANCE_REQUIRED', error.message);
        }
      }
    }
    const pointer = canonicalPointer({
      plan: snapshot.pointer.plan,
      phase: target,
      next: normalizedNext,
      now: normalizedNow,
      acceptanceProtocol: snapshot.pointer.acceptance_protocol,
      migrationReceiptSha256: snapshot.pointer.migration_receipt_sha256,
    });
    atomicWriteSprintPointer(paths, pointer, snapshot.raw);
    return { action: 'advance', from: expected, to: target, pointer };
  });
}

function loadSprintAcceptanceAdapter() {
  const candidates = [
    path.join(__dirname, 'codex-sprint-acceptance.js'),
    path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'codex-sprint-acceptance.js'),
  ];
  const adapter = candidates.find((candidate) => fs.existsSync(candidate));
  if (!adapter) {
    throw new Error('explicit Harness acceptance adapter is unavailable');
  }
  return require(adapter);
}

function blockActiveSprint({ cwd = process.cwd(), expectedPhase, reason, next, now } = {}) {
  const expected = normalizeStatePhase(expectedPhase, 'expected phase');
  const normalizedReason = normalizeStateText(reason, 'reason');
  const normalizedNext = normalizeStateText(next, 'next');
  const normalizedNow = normalizeStateTimestamp(now);
  return withSprintStateLock(cwd, (paths) => {
    const prepared = prepareNonCompletionMutation(paths);
    if (prepared && prepared.transaction.replacementPointer) {
      const replacement = prepared.transaction.replacementPointer;
      const requestedPointer = canonicalPointer({
        plan: replacement.plan,
        phase: expected,
        status: 'blocked',
        blockReason: normalizedReason,
        next: normalizedNext,
        now: normalizedNow,
        acceptanceProtocol: replacement.acceptance_protocol,
        migrationReceiptSha256: replacement.migration_receipt_sha256,
      });
      const recoveredPointer = exactRecoveredPointerMutation(prepared, {
        operation: 'replace',
        expectedPhase: expected,
        replacementRaw: `${JSON.stringify(requestedPointer)}\n`,
      });
      if (recoveredPointer) {
        return { action: 'block', pointer: recoveredPointer, recovered: true };
      }
    }
    const snapshot = readSprintStateSnapshot(cwd, paths.pointerPath);
    assertExpectedPhase(snapshot.pointer, expected);
    const pointer = canonicalPointer({
      plan: snapshot.pointer.plan,
      phase: expected,
      status: 'blocked',
      blockReason: normalizedReason,
      next: normalizedNext,
      now: normalizedNow,
      acceptanceProtocol: snapshot.pointer.acceptance_protocol,
      migrationReceiptSha256: snapshot.pointer.migration_receipt_sha256,
    });
    atomicWriteSprintPointer(paths, pointer, snapshot.raw);
    return { action: 'block', pointer };
  });
}

function parseCompletionRecord(paths, raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw recoveryError('completion record JSON is invalid', { cause: error });
  }
  const baseKeys = new Set([
    'version', 'token', 'plan', 'phase', 'expected_sha256', 'completed_at',
  ]);
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value)
    : [];
  const hasMigrationLineage = Object.hasOwn(value || {}, 'migration_receipt_sha256');
  const hasCompletionPlanProof = value
    && value.version === COMPLETION_RECORD_VERSION;
  const allowedExtraKeys = new Set([
    'migration_receipt_sha256',
    ...(hasCompletionPlanProof ? ['completion_plan'] : []),
  ]);
  if (keys.some((key) => !baseKeys.has(key) && !allowedExtraKeys.has(key))
      || keys.length !== baseKeys.size
        + (hasMigrationLineage ? 1 : 0)
        + (hasCompletionPlanProof ? 1 : 0)
      || [...baseKeys].some((key) => !Object.hasOwn(value || {}, key))
      || (hasCompletionPlanProof && !Object.hasOwn(value, 'completion_plan'))
      || `${JSON.stringify(value)}\n` !== raw) {
    throw recoveryError('completion record fields or encoding are invalid');
  }
  if (!value || ![
    LEGACY_COMPLETION_RECORD_VERSION,
    COMPLETION_RECORD_VERSION,
  ].includes(value.version)
      || !/^[a-f0-9]{32}$/.test(value.token || '')
      || !/^[a-f0-9]{64}$/.test(value.expected_sha256 || '')
      || value.phase !== 'compound'
      || typeof value.plan !== 'string'
      || (value.migration_receipt_sha256 !== undefined
        && !/^[a-f0-9]{64}$/.test(value.migration_receipt_sha256))) {
    throw recoveryError('completion record schema is invalid');
  }
  const plan = normalizePlanPath(paths.workspace, value.plan);
  if (!plan || plan !== value.plan) {
    throw recoveryError('completion record plan is invalid or non-canonical');
  }
  if (hasCompletionPlanProof) {
    assertCompletionPlanProof(paths.workspace, plan, value.completion_plan);
  }
  try {
    if (normalizeStateTimestamp(value.completed_at) !== value.completed_at) {
      throw new Error('completion timestamp is not canonical');
    }
  } catch (error) {
    throw recoveryError('completion record timestamp is invalid', { cause: error });
  }
  if (value.migration_receipt_sha256) {
    try {
      readMigrationReceipt(
        paths.workspace,
        value.migration_receipt_sha256,
        { targetPlan: plan }
      );
    } catch (error) {
      throw recoveryError('completion migration receipt lineage is invalid', { cause: error });
    }
  }
  return { raw, value: { ...value, plan } };
}

function readCompletionRecord(paths) {
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(paths.completionPath, MAX_RECOVERY_BYTES);
  } catch (error) {
    if (error && error.cause && error.cause.code === 'ENOENT') return null;
    throw error;
  }
  return parseCompletionRecord(paths, snapshot.bytes.toString('utf8'));
}

function transactionCompletionPlanProof(transaction) {
  if (transaction.value.version === COMPLETION_TRANSACTION_VERSION) {
    return transaction.value.completion_plan;
  }
  return transaction.completionPlanProof || null;
}

function canonicalV2CompletionRaw(transaction) {
  if (transaction.value.version !== COMPLETION_TRANSACTION_VERSION) {
    throw recoveryError('canonical v2 completion requires a v6 WAL');
  }
  const migrationReceiptSha256 = transaction.migrationReceipt
    && transaction.migrationReceipt.mode === 'lineage'
    ? transaction.migrationReceipt.sha256
    : null;
  const value = {
    version: COMPLETION_RECORD_VERSION,
    token: transaction.value.token,
    plan: transaction.value.plan,
    phase: transaction.value.phase,
    expected_sha256: transaction.value.expected_sha256,
    completed_at: transaction.value.started_at,
    completion_plan: transaction.value.completion_plan,
    ...(migrationReceiptSha256
      ? { migration_receipt_sha256: migrationReceiptSha256 }
      : {}),
  };
  return JSON.stringify(value) + '\n';
}

function readCompletionStageSnapshot(stagePath) {
  try {
    return readStableRecoverySnapshot(stagePath, MAX_RECOVERY_BYTES);
  } catch (error) {
    if (error && error.cause && error.cause.code === 'ENOENT') return null;
    throw error;
  }
}

function isStrictCompletionPrefix(snapshot, expectedRaw) {
  const expected = Buffer.from(expectedRaw, 'utf8');
  return snapshot.bytes.length < expected.length
    && snapshot.bytes.equals(expected.subarray(0, snapshot.bytes.length));
}

function removeCompletionStage(paths, transaction, stagePath, snapshot) {
  removeVerifiedRecoveryFile(
    stagePath,
    sha256(snapshot.bytes),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: transaction.value.token,
      artifact: 'completion-stage',
    }
  );
}

function completionRecordMatchesTransaction(record, transaction) {
  if (transaction.value.version === COMPLETION_TRANSACTION_VERSION) {
    return Boolean(record) && record.raw === canonicalV2CompletionRaw(transaction);
  }
  const migrationReceiptSha256 = transaction.migrationReceipt
    && transaction.migrationReceipt.mode === 'lineage'
    ? transaction.migrationReceipt.sha256
    : null;
  const completionPlanProof = transactionCompletionPlanProof(transaction);
  return Boolean(record)
    && record.value.version === LEGACY_COMPLETION_RECORD_VERSION
    && record.value.token === transaction.value.token
    && record.value.expected_sha256 === transaction.value.expected_sha256
    && record.value.plan === transaction.value.plan
    && record.value.phase === transaction.value.phase
    && JSON.stringify(record.value.completion_plan || null)
      === JSON.stringify(completionPlanProof)
    && (record.value.migration_receipt_sha256 || null) === migrationReceiptSha256;
}

function assertCommittedCompletion(paths, transaction) {
  if (transaction.value.operation !== 'complete') {
    throw recoveryError('committed completion verification requires a completion WAL');
  }
  try {
    lstatExactSync(paths.pointerPath);
    throw recoveryError('committed completion pointer is still present');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const record = readCompletionRecord(paths);
  if (!record || !completionRecordMatchesTransaction(record, transaction)) {
    throw recoveryError('committed completion record differs from its WAL proof');
  }
  if (transaction.value.version === COMPLETION_TRANSACTION_VERSION) {
    assertCompletionPlanProof(
      paths.workspace,
      transaction.value.plan,
      transaction.value.completion_plan
    );
  }
  return record;
}

function writeCompletionRecord(paths, transaction) {
  const stagePath = path.join(
    paths.stateDirectory,
    `active-sprint.completed-${transaction.value.token}.tmp`
  );
  const existing = readCompletionRecord(paths);
  const migrationReceiptSha256 = transaction.migrationReceipt
    && transaction.migrationReceipt.mode === 'lineage'
    ? transaction.migrationReceipt.sha256
    : null;
  const completionPlanProof = transactionCompletionPlanProof(transaction);
  const canonicalV2Raw = transaction.value.version === COMPLETION_TRANSACTION_VERSION
    ? canonicalV2CompletionRaw(transaction)
    : null;
  if (existing) {
    if (completionRecordMatchesTransaction(existing, transaction)) {
      const stage = readCompletionStageSnapshot(stagePath);
      if (stage !== null) {
        if (!stage.bytes.equals(Buffer.from(existing.raw, 'utf8'))
            && !(canonicalV2Raw && isStrictCompletionPrefix(stage, canonicalV2Raw))) {
          throw recoveryError('completion staging bytes differ from completed record');
        }
        removeCompletionStage(paths, transaction, stagePath, stage);
      }
      return existing;
    }
    throw recoveryError('a different completion record already exists');
  }
  let priorStage = readCompletionStageSnapshot(stagePath);
  let raw;
  if (canonicalV2Raw) {
    raw = canonicalV2Raw;
    if (priorStage !== null
        && !priorStage.bytes.equals(Buffer.from(raw, 'utf8'))) {
      if (!isStrictCompletionPrefix(priorStage, raw)) {
        throw recoveryError('completion staging record differs from its transaction');
      }
      removeCompletionStage(paths, transaction, stagePath, priorStage);
      priorStage = null;
    }
  } else if (priorStage !== null) {
    const parsedStage = parseCompletionRecord(paths, priorStage.bytes.toString('utf8'));
    if (!completionRecordMatchesTransaction(parsedStage, transaction)) {
      throw recoveryError('completion staging record differs from its transaction');
    }
    raw = parsedStage.raw;
  } else {
    const value = {
      version: completionPlanProof
        ? COMPLETION_RECORD_VERSION
        : LEGACY_COMPLETION_RECORD_VERSION,
      token: transaction.value.token,
      plan: transaction.value.plan,
      phase: transaction.value.phase,
      expected_sha256: transaction.value.expected_sha256,
      completed_at: new Date().toISOString(),
      ...(completionPlanProof ? { completion_plan: completionPlanProof } : {}),
      ...(migrationReceiptSha256
        ? { migration_receipt_sha256: migrationReceiptSha256 }
        : {}),
    };
    raw = `${JSON.stringify(value)}\n`;
  }
  try {
    if (priorStage === null) {
      writeDurableExclusive(stagePath, raw, paths.stateDirectory);
    }
    try {
      fs.linkSync(stagePath, paths.completionPath);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const raced = readCompletionRecord(paths);
      if (!raced || raced.raw !== raw) {
        throw recoveryError('completion record publish raced with different bytes');
      }
    }
    fsyncDirectoryIfSupported(paths.stateDirectory);
    const committed = readCompletionRecord(paths);
    if (!committed || committed.raw !== raw) {
      throw recoveryError('completion record readback differs from intended bytes');
    }
    removeVerifiedRecoveryFile(stagePath, sha256(raw), paths.stateDirectory, {
      scopeToken: transaction.value.token,
      artifact: 'completion-stage',
    });
  } catch (error) {
    if (error && error.code === 'SPRINT_RECOVERY_REQUIRED') throw error;
    throw recoveryError('cannot persist completion record', { cause: error });
  }
  return parseCompletionRecord(paths, raw);
}

function cleanupCompletionRecord(paths, expectedCompletion = null) {
  const completion = readCompletionRecord(paths);
  if (!completion) return false;
  if (expectedCompletion && completion.raw !== expectedCompletion.raw) {
    throw recoveryError('completion record changed before exact cleanup');
  }
  removeVerifiedRecoveryFile(
    paths.completionPath,
    sha256(completion.raw),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: completion.value.token,
      artifact: 'completion',
    }
  );
  return true;
}

function finalizeCompletionTransaction(paths, transaction, { recovered = false } = {}) {
  if (transaction.value.operation !== 'complete'
      || transaction.value.phase !== 'compound') {
    throw recoveryError('completion transaction is invalid');
  }
  if (transaction.value.version !== COMPLETION_TRANSACTION_VERSION) {
    const historicalRecord = readCompletionRecord(paths);
    if (!historicalRecord
        || !completionRecordMatchesTransaction(historicalRecord, transaction)) {
      throw recoveryError(
        'legacy uncommitted completion WAL requires operator recovery; no task state was accepted'
      );
    }
  }
  if (transaction.value.version === COMPLETION_TRANSACTION_VERSION) {
    assertCompletionPlanProof(
      paths.workspace,
      transaction.value.plan,
      transaction.value.completion_plan
    );
  }
  let canonicalRaw = readPointerRaw(paths.pointerPath);
  let claimState = readTransactionClaimState(paths, transaction);
  let claimConsumed = false;

  if (canonicalRaw !== null
      && claimState.claim && claimState.claim.value
      && claimState.raw !== null
      && claimState.source && claimState.source.state === 'expected'
      && canonicalRaw === claimState.raw
      && sha256(claimState.raw) === transaction.value.expected_sha256) {
    convergeExactClaimSourceDuplicate(paths, claimState.claim);
    canonicalRaw = readPointerRaw(paths.pointerPath);
    claimState = readTransactionClaimState(paths, transaction);
  }

  if (claimState.raw !== null
      && sha256(claimState.raw) !== transaction.value.expected_sha256) {
    const restoredRaw = claimState.raw;
    const verifyTerminalState = () => {
      assertTransactionEvidenceExact(paths, transaction);
      return assertExactPointerRaw(
        paths,
        restoredRaw,
        'restored completion-conflict pointer'
      );
    };
    const restored = canonicalRaw === null
      ? restoreTransactionClaim(paths, transaction, restoredRaw, {
        verifyBeforeDestroy: verifyTerminalState,
      }) : false;
    if (restored) {
      cleanupTransaction(paths, transaction, {
        verifyTerminalState,
      });
      throw sprintStateError(
        'SPRINT_STATE_CONFLICT',
        'completion claimed a changed pointer; it was restored'
      );
    }
    throw recoveryError('completion claim bytes changed; evidence preserved');
  }

  if (claimState.claim && claimState.claim.empty) {
    if (canonicalRaw !== null) {
      if (sha256(canonicalRaw) !== transaction.value.expected_sha256) {
        throw recoveryError('completion pointer successor was preserved');
      }
      removeEmptyPrivateClaimSlot(paths, claimState.claim);
      claimState = { claim: null, raw: null, source: null };
    } else {
      const completed = readCompletionRecord(paths);
      if (!completed) {
        throw recoveryError('empty completion pointer claim has no completion record');
      }
      removeEmptyPrivateClaimSlot(paths, claimState.claim);
      claimConsumed = true;
      claimState = { claim: null, raw: null, source: null };
    }
  }

  if (claimState.claim && !claimState.raw) {
    if (claimState.source && claimState.source.state === 'successor') {
      throw recoveryError('completion pointer successor was preserved');
    }
    if (claimState.source && claimState.source.state === 'expected') {
      removePrivateClaimMetadata(paths, claimState.claim);
      claimState = { claim: null, raw: null, source: null };
    } else if (claimState.source && claimState.source.state === 'missing') {
      removePrivateClaimMetadata(paths, claimState.claim);
      claimConsumed = true;
      claimState = { claim: null, raw: null, source: null };
    }
  }

  if (claimState.raw === null && canonicalRaw !== null
      && sha256(canonicalRaw) === transaction.value.expected_sha256) {
    const snapshot = readStableRecoverySnapshot(paths.pointerPath, MAX_POINTER_BYTES);
    if (sha256(snapshot.bytes) !== transaction.value.expected_sha256) {
      throw sprintStateError(
        'SPRINT_STATE_CONFLICT',
        'pointer changed while retrying completion private claim'
      );
    }
    const claim = createPrivateClaim(paths, {
      scopeToken: transaction.value.token,
      artifact: 'pointer',
      sourcePath: paths.pointerPath,
      snapshot,
    });
    claimState = {
      claim,
      raw: claim.value.bytes.toString('utf8'),
      source: inspectClaimSource(paths, claim),
    };
    canonicalRaw = readPointerRaw(paths.pointerPath);
  }

  if (canonicalRaw !== null) {
    throw recoveryError('completion pointer successor was preserved');
  }
  if (claimState.raw === null && !claimConsumed) {
    const completed = readCompletionRecord(paths);
    if (!completed) {
      throw recoveryError('completion transaction has no pointer claim or completion record');
    }
  }

  try {
    // Persist proof before destructive claim cleanup. A value/intent/directory/fsync
    // split can otherwise leave no durable way to distinguish completion from loss.
    if (transaction.value.version === COMPLETION_TRANSACTION_VERSION) {
      assertCompletionPlanProof(
        paths.workspace,
        transaction.value.plan,
        transaction.value.completion_plan
      );
    }
    writeCompletionRecord(paths, transaction);
    if (transaction.value.version === COMPLETION_TRANSACTION_VERSION) {
      assertCompletionPlanProof(
        paths.workspace,
        transaction.value.plan,
        transaction.value.completion_plan
      );
    }
    const verifyTerminalState = () => assertCommittedCompletion(paths, transaction);
    cleanupTransaction(paths, transaction, {
      claimHash: claimState.raw === null
        ? undefined : transaction.value.expected_sha256,
      verifyTerminalState,
    });
  } catch (error) {
    if (error && error.code === 'SPRINT_RECOVERY_REQUIRED') throw error;
    throw recoveryError('completion requires recovery before it can be retried', {
      cause: error,
    });
  }
  return {
    action: 'complete',
    plan: transaction.value.plan,
    phase: 'compound',
    recovered,
    successorPreserved: false,
  };
}
function completeActiveSprint({ cwd = process.cwd(), expectedPhase } = {}) {
  const expected = normalizeStatePhase(expectedPhase, 'expected phase');

  return withSprintStateLock(cwd, (paths) => {
    const pending = readTransaction(paths);
    if (pending) {
      if (pending.value.operation !== 'complete') {
        recoverNonCompletionTransaction(paths);
      } else {
        if (pending.value.phase !== expected) {
          throw sprintStateError(
            'SPRINT_PHASE_CONFLICT',
            `expected current phase ${expected}, found ${pending.value.phase}`
          );
        }
        return finalizeCompletionTransaction(paths, pending, { recovered: true });
      }
    }

    const completed = readCompletionRecord(paths);
    if (completed && readPointerRaw(paths.pointerPath) === null) {
      if (completed.value.phase !== expected) {
        throw sprintStateError('SPRINT_PHASE_CONFLICT', 'completion record phase conflicts');
      }
      return {
        action: 'complete',
        plan: completed.value.plan,
        phase: completed.value.phase,
        recovered: true,
        alreadyCompleted: true,
      };
    }

    if (readPointerRaw(paths.pointerPath) !== null) cleanupCompletionRecord(paths);
    const snapshot = readSprintStateSnapshot(cwd, paths.pointerPath);
    assertExpectedPhase(snapshot.pointer, expected);
    if (expected !== 'compound') {
      throw sprintStateError(
        'ILLEGAL_SPRINT_COMPLETION',
        `completion requires compound, found ${expected}`
      );
    }
    const completionPlan = readCompletionPlanSnapshot(cwd, snapshot.pointer.plan);
    const transaction = createTransaction(paths, {
      operation: 'complete',
      expectedRaw: snapshot.raw,
      replacementRaw: null,
      plan: snapshot.pointer.plan,
      phase: snapshot.pointer.phase,
      completionMigrationReceiptSha256:
        snapshot.pointer.migration_receipt_sha256 || null,
      completionPlanProof: completionPlan.proof,
    });
    try {
      const completionPlanBeforeClaim = assertCompletionPlanProof(
        cwd,
        snapshot.pointer.plan,
        completionPlan.proof
      );
      if (!sameFileIdentity(
        completionPlan.snapshot.stat,
        completionPlanBeforeClaim.snapshot.stat
      ) || !completionPlan.snapshot.bytes.equals(completionPlanBeforeClaim.snapshot.bytes)) {
        throw sprintStateError(
          'SPRINT_STATE_CONFLICT',
          'completion plan identity changed before pointer claim'
        );
      }
      const pointerSnapshot = readStableRecoverySnapshot(paths.pointerPath, MAX_POINTER_BYTES);
      if (sha256(pointerSnapshot.bytes) !== transaction.value.expected_sha256) {
        throw sprintStateError(
          'SPRINT_STATE_CONFLICT',
          'pointer changed before completion private claim; no bytes were deleted'
        );
      }
      createPrivateClaim(paths, {
        scopeToken: transaction.value.token,
        artifact: 'pointer',
        sourcePath: paths.pointerPath,
        snapshot: pointerSnapshot,
      });
      return finalizeCompletionTransaction(paths, transaction);
    } catch (error) {
      if (error && [
        'SPRINT_STATE_CONFLICT',
        'SPRINT_RECOVERY_REQUIRED',
      ].includes(error.code)) {
        throw error;
      }
      throw recoveryError('completion transaction was interrupted', { cause: error });
    }
  });
}
function tagsFromActiveSprint(activeSprint) {
  if (!activeSprint || !activeSprint.active) return [];
  const raw = String(activeSprint.meta.tags || '');
  const tags = raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((tag) => tag.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return [...new Set(['sprint', activeSprint.phase, ...tags])].slice(0, 12);
}

module.exports = {
  COMPLETION_RELATIVE_PATH,
  MIGRATION_RECEIPT_DIRECTORY_RELATIVE_PATH,
  TRANSACTION_RELATIVE_PATH,
  MAX_PLAN_BYTES,
  ALLOWED_TRANSITIONS,
  LOCK_RELATIVE_PATH,
  MAX_POINTER_BYTES,
  POINTER_RELATIVE_PATH,
  POINTER_VERSION,
  VALID_PHASES,
  inspectBoundedWorkspaceFile,
  normalizePlanPath,
  advanceActiveSprint,
  blockActiveSprint,
  completeActiveSprint,
  initActiveSprint,
  inspectPendingV4Supersession,
  prepareSupersessionProposal,
  supersedeActiveSprint,
  parseActiveSprintFrontmatter,
  readActiveSprint,
  readActiveSprintPointer,
  readSprintRecoveryStatus,
  sprintStateError,
  validatePointerSchema,
  tagsFromActiveSprint,
  __privateClaimTesting: Object.freeze({
    claimSlotName,
    createPrivateClaim,
    deletePrivateClaimValue,
    ensureStateDirectory,
    readPrivateClaimSlot,
    readStableRecoverySnapshot,
    recoverStandaloneDeleteClaims,
    removePrivateClaimMetadata,
    removeVerifiedRecoveryFile,
    restorePrivateClaim,
    sha256,
    writeDurableStagedExclusive,
  }),
};
