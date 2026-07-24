'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POINTER_VERSION = 1;
const POINTER_RELATIVE_PATH = 'docs/plans/.handoff/active-sprint.json';
const LOCK_RELATIVE_PATH = 'docs/plans/.handoff/active-sprint.lock';
const TRANSACTION_RELATIVE_PATH = 'docs/plans/.handoff/active-sprint.transaction.json';
const COMPLETION_RELATIVE_PATH = 'docs/plans/.handoff/active-sprint.completed.json';
const TRANSACTION_RELEASE_RELATIVE_PATH = `${TRANSACTION_RELATIVE_PATH}.release.tmp`;
const MAX_RECOVERY_BYTES = 32 * 1024;
const POINTER_KEYS = new Set(['version', 'plan', 'phase', 'status', 'updated_at', 'next', 'block_reason']);
const RECOVERY_VERSION = 1;
const LEGACY_TRANSACTION_VERSION = 1;
const PAYLOAD_TRANSACTION_VERSION = 2;
const TRANSACTION_VERSION = 3;
const CLAIM_INTENT_VERSION = 1;
const CLAIM_INTENT_FILE = 'intent.json';
const CLAIM_VALUE_FILE = 'value';
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
  'completion-stage',
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
const VALID_PHASES = new Set(['think', 'plan', 'work', 'review', 'compound']);
const ACTIVE_META_KEYS = new Set(['status', 'tasks_completed', 'tasks_total', 'tags']);
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
        meta.tags = scalar;
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
    stat = fs.lstatSync(filePath);
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === 'ENOENT' ? `missing-${kind}` : `unreadable-${kind}`,
    };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: `unsafe-${kind}-link` };
  if (!stat.isFile()) return { ok: false, reason: `unsafe-${kind}-type` };
  if (stat.size > maximumBytes) return { ok: false, reason: `${kind}-too-large` };

  try {
    const workspaceReal = fs.realpathSync(cwd);
    const allowedReal = fs.realpathSync(allowedRoot);
    const fileReal = fs.realpathSync(filePath);
    if (!isInside(workspaceReal, allowedReal) || !isInside(allowedReal, fileReal)) {
      return { ok: false, reason: `outside-${kind}-root` };
    }
    return { ok: true, fileReal, size: stat.size };
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
    return {
      ok: true,
      pointer: {
        version: POINTER_VERSION,
        plan,
        phase,
        status: value.status,
        updated_at: updatedAt,
        next,
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
  };
}
function readPrivateClaimRecoveryStatus(cwd, stateDirectory, pointerPath) {
  let stateStat;
  try {
    stateStat = fs.lstatSync(stateDirectory);
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
    const claimStat = fs.lstatSync(claimPath);
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
    MAX_RECOVERY_BYTES,
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
    MAX_RECOVERY_BYTES,
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
    const value = JSON.parse(fs.readFileSync(completionPath, 'utf8'));
    const plan = normalizePlanPath(cwd, value && value.plan);
    if (!value || value.version !== RECOVERY_VERSION
        || !/^[a-f0-9]{32}$/.test(value.token || '')
        || !/^[a-f0-9]{64}$/.test(value.expected_sha256 || '')
        || value.phase !== 'compound'
        || !plan) {
      throw new Error('invalid completion schema');
    }
    return {
      active: false,
      reason: 'completed-sprint',
      pointerPath,
      completionPath,
      plan,
      phase: value.phase,
      completedAt: typeof value.completed_at === 'string' ? value.completed_at : '',
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
  const { plan, phase, status, blockReason, updatedAt, next } = pointer;

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
  if (String(meta.status || '').toLowerCase() === 'completed') {
    return {
      active: false, reason: 'completed-plan', pointerPath, plan,
      phase, status, blockReason, updatedAt, next, meta,
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

function ensureStateDirectory(cwd) {
  const workspace = path.resolve(cwd);
  const plansRoot = path.resolve(workspace, 'docs', 'plans');
  const stateDirectory = path.resolve(plansRoot, '.handoff');
  let planStat;
  try {
    planStat = fs.lstatSync(plansRoot);
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

  try {
    fs.mkdirSync(stateDirectory, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const stateStat = fs.lstatSync(stateDirectory);
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
    pointerPath: path.resolve(workspace, POINTER_RELATIVE_PATH),
    lockPath: path.resolve(workspace, LOCK_RELATIVE_PATH),
    transactionPath: path.resolve(workspace, TRANSACTION_RELATIVE_PATH),
    transactionReleasePath: path.resolve(workspace, TRANSACTION_RELEASE_RELATIVE_PATH),
    completionPath: path.resolve(workspace, COMPLETION_RELATIVE_PATH),
  };
}

function randomStateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function sameFileIdentity(left, right) {
  return Boolean(left && right)
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
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
  };
}

function inspectClaimParent(paths) {
  let parentStat;
  let parentReal;
  try {
    parentStat = fs.lstatSync(paths.stateDirectory);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error('state directory is not a regular directory');
    }
    parentReal = fs.realpathSync(paths.stateDirectory);
    const plansReal = fs.realpathSync(paths.plansRoot);
    const resolvedParent = path.resolve(paths.stateDirectory);
    const sameResolvedParent = process.platform === 'win32'
      ? parentReal.toLowerCase() === resolvedParent.toLowerCase()
      : parentReal === resolvedParent;
    if (!sameResolvedParent || path.basename(resolvedParent) !== '.handoff'
        || !isInside(plansReal, parentReal)
        || path.dirname(parentReal) !== plansReal) {
      throw new Error('state directory realpath is outside docs/plans');
    }
  } catch (error) {
    throw recoveryError('private claim parent is unsafe', { cause: error });
  }
  return { stat: parentStat, real: parentReal };
}

function expectedClaimDisposition(artifact) {
  return artifact === 'pointer' || artifact === 'partial' ? 'hold' : 'delete';
}

function isAllowedClaimSource(intent) {
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
    'completion-stage': `active-sprint.completed-${token}.tmp`,
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
  const intent = {
    version: CLAIM_INTENT_VERSION,
    scope_token: scopeToken,
    artifact,
    source,
    disposition: expectedClaimDisposition(artifact),
    parent: path.basename(paths.stateDirectory),
    parent_dev: String(parent.stat.dev),
    parent_ino: String(parent.stat.ino),
    expected_dev: String(snapshot.stat.dev),
    expected_ino: String(snapshot.stat.ino),
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
      || !/^\d+$/.test(intent.parent_dev || '')
      || !/^\d+$/.test(intent.parent_ino || '')
      || !/^\d+$/.test(intent.expected_dev || '')
      || !/^\d+$/.test(intent.expected_ino || '')
      || !Number.isSafeInteger(intent.size) || intent.size < 0 || intent.size > MAX_RECOVERY_BYTES
      || !/^[a-f0-9]{64}$/.test(intent.sha256 || '')
      || !isAllowedClaimSource(intent)
      || claimSlotName(intent.scope_token, intent.artifact) !== slot.slotName) {
    throw recoveryError(`private claim intent schema is invalid: ${slot.slotName}`);
  }
  const parent = inspectClaimParent(paths);
  if (intent.parent_dev !== String(parent.stat.dev)
      || intent.parent_ino !== String(parent.stat.ino)) {
    throw recoveryError(`private claim parent identity changed: ${slot.slotName}`);
  }
  return intent;
}

function readPrivateClaimSlot(paths, scopeToken, artifact, { allowMissing = true } = {}) {
  const slot = claimSlotPaths(paths, scopeToken, artifact);
  let slotStat;
  try {
    slotStat = fs.lstatSync(slot.slotPath);
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
  if (process.platform !== 'win32' && (slotStat.mode & 0o777) !== 0o700) {
    throw recoveryError(`private claim slot permissions are unsafe: ${slot.slotName}`);
  }
  if (entries.length === 0) return { ...slot, empty: true, intent: null, value: null, slotStat };
  if (!entries.includes(CLAIM_INTENT_FILE)
      || entries.some((entry) => entry !== CLAIM_INTENT_FILE && entry !== CLAIM_VALUE_FILE)) {
    throw recoveryError(`private claim slot has unknown or ambiguous entries: ${slot.slotName}`);
  }
  const intentStat = fs.lstatSync(slot.intentPath);
  if (intentStat.isSymbolicLink() || !intentStat.isFile() || intentStat.size > 4096) {
    throw recoveryError(`private claim intent is not a bounded regular file: ${slot.slotName}`);
  }
  const intentRaw = fs.readFileSync(slot.intentPath, 'utf8');
  const intentAfter = fs.lstatSync(slot.intentPath);
  const slotAfter = fs.lstatSync(slot.slotPath);
  if (!sameFileIdentity(intentStat, intentAfter)
      || intentAfter.size !== Buffer.byteLength(intentRaw, 'utf8')
      || !sameFileIdentity(slotStat, slotAfter)
      || slotAfter.isSymbolicLink() || !slotAfter.isDirectory()) {
    throw recoveryError(`private claim metadata changed while reading: ${slot.slotName}`);
  }
  const intent = parseClaimIntent(paths, slot, intentRaw);
  let value = null;
  if (entries.includes(CLAIM_VALUE_FILE)) {
    value = readStableRecoverySnapshot(slot.valuePath, MAX_RECOVERY_BYTES);
    if (String(value.stat.dev) !== intent.expected_dev
        || String(value.stat.ino) !== intent.expected_ino
        || value.bytes.length !== intent.size
        || sha256(value.bytes) !== intent.sha256) {
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
  };
}

function removeEmptyPrivateClaimSlot(paths, slot) {
  const before = fs.lstatSync(slot.slotPath);
  const entries = fs.readdirSync(slot.slotPath);
  const after = fs.lstatSync(slot.slotPath);
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
  if (current.value) {
    throw recoveryError(`private claim value still exists: ${current.slotName}`);
  }
  try {
    const intentNow = fs.lstatSync(current.intentPath);
    const slotNow = fs.lstatSync(current.slotPath);
    if (!sameFileIdentity(current.intentStat, intentNow)
        || !sameFileIdentity(current.slotStat, slotNow)) {
      throw recoveryError(`private claim metadata identity changed: ${current.slotName}`);
    }
    fs.unlinkSync(current.intentPath);
    fsyncDirectoryIfSupported(current.slotPath);
    const slotAfterIntent = fs.lstatSync(current.slotPath);
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
    source = readStableRecoverySnapshot(sourcePath, MAX_RECOVERY_BYTES);
  } catch (error) {
    if (error && error.cause && error.cause.code === 'ENOENT') {
      return { state: 'missing', sourcePath, snapshot: null };
    }
    throw error;
  }
  const matches = String(source.stat.dev) === claim.intent.expected_dev
    && String(source.stat.ino) === claim.intent.expected_ino
    && source.bytes.length === claim.intent.size
    && sha256(source.bytes) === claim.intent.sha256;
  return { state: matches ? 'expected' : 'successor', sourcePath, snapshot: source };
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
  const intent = canonicalClaimIntent(paths, {
    scopeToken,
    artifact,
    sourcePath,
    snapshot,
  });
  const intentRaw = `${JSON.stringify(intent)}\n`;
  try {
    writeDurableExclusive(slot.intentPath, intentRaw, slot.slotPath);
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    throw recoveryError(`cannot persist private claim intent: ${slot.slotName}`, { cause: error });
  }
  try {
    fs.lstatSync(slot.valuePath);
    throw recoveryError(`private claim value unexpectedly exists: ${slot.slotName}`);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  try {
    fs.renameSync(sourcePath, slot.valuePath);
    fsyncDirectoryIfSupported(paths.stateDirectory);
    fsyncDirectoryIfSupported(slot.slotPath);
  } catch (error) {
    if (error && error.code === 'SPRINT_RECOVERY_REQUIRED') throw error;
    throw recoveryError(`cannot move source into private claim: ${slot.slotName}`, { cause: error });
  }
  const claimed = readPrivateClaimSlot(paths, scopeToken, artifact, { allowMissing: false });
  if (!claimed.value
      || !sameFileIdentity(snapshot.stat, claimed.value.stat)
      || !snapshot.bytes.equals(claimed.value.bytes)) {
    throw recoveryError(`private claim changed during move: ${slot.slotName}`);
  }
  const source = inspectClaimSource(paths, claimed);
  if (source.state !== 'missing') {
    throw recoveryError(`private claim source successor appeared: ${intent.source}`);
  }
  return claimed;
}

function deletePrivateClaimValue(paths, claim, { sync = false, allowedSourceHash = null } = {}) {
  const current = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false }
  );
  if (!current.value) {
    throw recoveryError(`private claim value is missing: ${current.slotName}`);
  }
  try {
    const valueNow = fs.lstatSync(current.valuePath);
    if (!sameFileIdentity(current.value.stat, valueNow)
        || valueNow.isSymbolicLink() || !valueNow.isFile()) {
      throw recoveryError(`private claim value identity changed before delete: ${current.slotName}`);
    }
    fs.unlinkSync(current.valuePath);
    fsyncDirectoryIfSupported(current.slotPath);
    if (sync) fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    throw recoveryError(`cannot delete private claim value: ${current.slotName}`, { cause: error });
  }
  const source = inspectClaimSource(paths, current);
  const allowedSource = source.snapshot && allowedSourceHash
    && sha256(source.snapshot.bytes) === allowedSourceHash;
  if (source.state !== 'missing' && !allowedSource) {
    throw recoveryError(`private claim source successor was preserved: ${current.intent.source}`);
  }
  removePrivateClaimMetadata(paths, current);
}

function resumeDeletePrivateClaim(paths, claim, expectedHash, { sync = false } = {}) {
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
  deletePrivateClaimValue(paths, claim, { sync });
  return { action: 'done' };
}

function parsePrivateClaimSlotName(name) {
  const match = String(name).match(/^active-sprint\.claim-([a-f0-9]{32})-([a-z0-9-]+)$/);
  if (!match || !CLAIM_ARTIFACTS.has(match[2])) return null;
  if (claimSlotName(match[1], match[2]) !== name) return null;
  return { scopeToken: match[1], artifact: match[2] };
}

function recoverStandaloneDeleteClaims(paths, { artifacts = null } = {}) {
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
    const claim = readPrivateClaimSlot(paths, parsed.scopeToken, parsed.artifact, {
      allowMissing: false,
    });
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
} = {}) {
  const paths = {
    stateDirectory: path.resolve(directory),
    plansRoot: path.dirname(path.resolve(directory)),
  };
  const slot = readPrivateClaimSlot(paths, scopeToken, artifact);
  if (slot) {
    const resumed = resumeDeletePrivateClaim(paths, slot, expectedHash, { sync });
    if (resumed.action === 'done') return true;
  }
  let snapshot;
  try {
    snapshot = readStableRecoverySnapshot(filePath, MAX_RECOVERY_BYTES);
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
  deletePrivateClaimValue(paths, claim, { sync });
  return true;
}

function restorePrivateClaim(paths, claim, sourcePath) {
  const current = readPrivateClaimSlot(
    paths,
    claim.intent.scope_token,
    claim.intent.artifact,
    { allowMissing: false }
  );
  if (!current.value) return false;
  try {
    fs.linkSync(current.valuePath, sourcePath);
    fsyncDirectoryIfSupported(paths.stateDirectory);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw recoveryError(`cannot restore private claim: ${current.slotName}`, { cause: error });
  }
  const restored = readStableRecoverySnapshot(sourcePath, MAX_RECOVERY_BYTES);
  if (!sameFileIdentity(current.value.stat, restored.stat)
      || !current.value.bytes.equals(restored.bytes)) {
    throw recoveryError(`restored private claim identity mismatch: ${current.slotName}`);
  }
  try {
    const sourceBeforeRelease = readStableRecoverySnapshot(sourcePath, MAX_RECOVERY_BYTES);
    if (!sameFileIdentity(restored.stat, sourceBeforeRelease.stat)
        || !restored.bytes.equals(sourceBeforeRelease.bytes)) {
      throw recoveryError(`restored private claim changed before release: ${current.slotName}`);
    }
    const valueBeforeRelease = fs.lstatSync(current.valuePath);
    if (!sameFileIdentity(current.value.stat, valueBeforeRelease)
        || valueBeforeRelease.isSymbolicLink() || !valueBeforeRelease.isFile()) {
      throw recoveryError(`private restore value changed before release: ${current.slotName}`);
    }
    fs.unlinkSync(current.valuePath);
    fsyncDirectoryIfSupported(current.slotPath);
    const sourceAfterRelease = readStableRecoverySnapshot(sourcePath, MAX_RECOVERY_BYTES);
    if (!sameFileIdentity(restored.stat, sourceAfterRelease.stat)
        || !restored.bytes.equals(sourceAfterRelease.bytes)) {
      throw recoveryError(`restored private claim successor was preserved: ${current.slotName}`);
    }
  } catch (error) {
    if (error && error.code === 'SPRINT_RECOVERY_REQUIRED') throw error;
    throw recoveryError(`cannot release restored private claim value: ${current.slotName}`, {
      cause: error,
    });
  }
  removePrivateClaimMetadata(paths, current);
  return true;
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
  const valueNow = fs.lstatSync(moved.valuePath);
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
  const intentNow = fs.lstatSync(moved.intentPath);
  const slotNow = fs.lstatSync(moved.slotPath);
  if (!sameFileIdentity(moved.intentStat, intentNow)
      || !sameFileIdentity(moved.slotStat, slotNow)) {
    throw sprintStateError(
      'SPRINT_LOCK_RELEASE_CONFLICT',
      'uncommitted lock metadata identity changed before cleanup'
    );
  }
  fs.unlinkSync(moved.intentPath);
  const remaining = fs.readdirSync(moved.slotPath);
  const slotAfterIntent = fs.lstatSync(moved.slotPath);
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
    ownership = { token, content, stat: fs.fstatSync(lockHandle), ready: false };
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
    stat = fs.lstatSync(pointerPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw sprintStateError('INVALID_ACTIVE_SPRINT_POINTER', `cannot inspect pointer: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_POINTER_BYTES) {
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

function readOptionalRecoveryFile(filePath, maximumBytes = MAX_RECOVERY_BYTES) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw recoveryError(`cannot inspect recovery file ${path.basename(filePath)}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximumBytes) {
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
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw new Error('exclusive state target is not a regular file');
    identity = { dev: String(stat.dev), ino: String(stat.ino) };
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

function parseTransaction(paths, raw) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECOVERY_BYTES) {
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
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !supportedVersions.has(value.version)
      || !tokenPattern.test(value.token || '')) {
    throw recoveryError('active sprint transaction header is invalid');
  }
  const expectedKeys = value.version === LEGACY_TRANSACTION_VERSION
    ? LEGACY_TRANSACTION_KEYS : TRANSACTION_KEYS;
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw recoveryError('active sprint transaction fields are invalid');
  }
  if (`${JSON.stringify(value)}\n` !== raw) {
    throw recoveryError('active sprint transaction encoding is not canonical');
  }
  if (!['init', 'replace', 'complete'].includes(value.operation)) {
    throw recoveryError('active sprint transaction operation is invalid');
  }
  const privatePaths = value.version === TRANSACTION_VERSION;
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
  } else if (!hashPattern.test(value.expected_sha256 || '')) {
    throw recoveryError('transaction expected hash is invalid');
  }
  const hasPayloadProof = value.version !== LEGACY_TRANSACTION_VERSION;
  let replacementRaw = null;
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
    }
  }
  return {
    raw,
    value,
    replacementRaw,
    privatePaths,
    claimPath: value.claim ? path.join(paths.stateDirectory, ...value.claim.split('/')) : null,
    publishPath: value.publish ? path.join(paths.stateDirectory, value.publish) : null,
    partialPath: value.version !== LEGACY_TRANSACTION_VERSION && value.partial
      ? path.join(paths.stateDirectory, ...value.partial.split('/')) : null,
  };
}
function readStableRecoverySnapshot(filePath, maximumBytes = MAX_RECOVERY_BYTES) {
  try {
    const before = fs.lstatSync(filePath);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maximumBytes) {
      throw recoveryError(`recovery file ${path.basename(filePath)} is not a bounded regular file`);
    }
    const bytes = fs.readFileSync(filePath);
    const after = fs.lstatSync(filePath);
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
  let claim = readPrivateClaimSlot(paths, transaction.value.token, 'pointer');
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
  if (!identity || transaction.value.operation !== 'init' || !transaction.partialPath
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
  let claim = readPrivateClaimSlot(paths, transaction.value.token, 'partial');
  if (!claim) return false;
  if (claim.empty) {
    removeEmptyPrivateClaimSlot(paths, claim);
    let publish;
    try {
      publish = readStableRecoverySnapshot(transaction.publishPath, MAX_POINTER_BYTES);
    } catch (error) {
      if (error && error.cause && error.cause.code === 'ENOENT') return true;
      throw error;
    }
    if (sha256(publish.bytes) === transaction.value.replacement_sha256) {
      return false;
    }
    if (!isStrictReplacementPrefix(publish, transaction)) {
      throw recoveryError(
        'publish candidate after empty partial claim is not an owned replacement prefix; evidence preserved'
      );
    }
    claim = createPrivateClaim(paths, {
      scopeToken: transaction.value.token,
      artifact: 'partial',
      sourcePath: transaction.publishPath,
      snapshot: publish,
    });
    if (path.resolve(claim.valuePath) !== path.resolve(transaction.partialPath)) {
      throw recoveryError('recreated private partial claim path differs from transaction');
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
  const source = inspectClaimSource(paths, claim);
  if (claim.value) {
    if (!claim.value.bytes.equals(expectedPrefix)) {
      throw recoveryError('private partial claim bytes are not an owned replacement prefix');
    }
    if (source.state !== 'missing') {
      throw recoveryError('partial publish source successor was preserved');
    }
    deletePrivateClaimValue(paths, claim, { sync: true });
    return true;
  }
  if (source.state === 'successor') {
    throw recoveryError('partial publish source successor was preserved');
  }
  removePrivateClaimMetadata(paths, claim);
  if (source.state === 'expected') {
    removeVerifiedRecoveryFile(
      source.sourcePath,
      claim.intent.sha256,
      paths.stateDirectory,
      {
        sync: true,
        scopeToken: transaction.value.token,
        artifact: 'publish',
      }
    );
  }
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
  const canonical = readStableRecoverySnapshot(paths.transactionPath);
  const release = readStableRecoverySnapshot(paths.transactionReleasePath);
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
  const surviving = readStableRecoverySnapshot(paths.transactionPath);
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
  const canonical = readStableRecoverySnapshot(paths.transactionPath);
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
    const claim = readPrivateClaimSlot(paths, parsed.scopeToken, parsed.artifact, {
      allowMissing: false,
    });
    const isHold = claim.empty
      ? expectedClaimDisposition(parsed.artifact) === 'hold'
      : claim.intent && claim.intent.disposition === 'hold';
    if (!isHold) continue;
    const bound = transaction
      && transaction.privatePaths
      && parsed.scopeToken === transaction.value.token
      && ((parsed.artifact === 'pointer' && transaction.value.operation !== 'init')
        || (parsed.artifact === 'partial' && transaction.value.operation === 'init'));
    if (!bound) {
      throw recoveryError(`orphan or mismatched private hold claim was preserved: ${entry}`);
    }
  }
}
function readTransaction(paths) {
  recoverStandaloneDeleteClaims(paths, {
    artifacts: new Set([...CLAIM_ARTIFACTS].filter((artifact) => artifact !== 'lock')),
  });
  let raw = readOptionalRecoveryFile(paths.transactionPath);
  const releaseRaw = readOptionalRecoveryFile(paths.transactionReleasePath);
  if (releaseRaw !== null) {
    raw = raw !== null
      ? convergeDuplicateTransactionMarkers(paths)
      : restoreLegacyTransactionRelease(paths, releaseRaw);
  }
  const transaction = raw === null ? null : parseTransaction(paths, raw);
  assertLegacyFlatClaimsBound(paths, transaction);
  assertPrivateHoldClaimsBound(paths, transaction);
  return transaction;
}

function cleanupPrivatePointerClaim(paths, transaction, expectedHash, allowedSourceHash = null) {
  let claim = readPrivateClaimSlot(paths, transaction.value.token, 'pointer');
  if (!claim) return false;
  if (claim.empty) {
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
    removePrivateClaimMetadata(paths, claim);
    return true;
  }
  deletePrivateClaimValue(paths, claim, {
    sync: true,
    allowedSourceHash,
  });
  return true;
}

function restoreTransactionClaim(paths, transaction, claimRaw) {
  if (transaction.privatePaths) {
    const state = readTransactionClaimState(paths, transaction);
    if (!state.claim || !state.claim.value) return false;
    return restorePrivateClaim(paths, state.claim, paths.pointerPath);
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
    }
  );
  return true;
}

function cleanupTransaction(paths, transaction, {
  claimHash,
  publishHash,
  allowedClaimSourceHash = null,
} = {}) {
  if (claimHash && transaction.claimPath) {
    if (transaction.privatePaths) {
      cleanupPrivatePointerClaim(
        paths,
        transaction,
        claimHash,
        allowedClaimSourceHash
      );
    } else {
      removeVerifiedRecoveryFile(
        transaction.claimPath,
        claimHash,
        paths.stateDirectory,
        {
          scopeToken: transaction.value.token,
          artifact: 'legacy-pointer',
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
      }
    );
  }
  removeVerifiedRecoveryFile(
    paths.transactionPath,
    sha256(transaction.raw),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: transaction.value.token,
      artifact: 'transaction',
    }
  );
}
function createTransaction(paths, { operation, expectedRaw, replacementRaw, plan, phase }) {
  if (readOptionalRecoveryFile(paths.transactionPath) !== null) {
    throw recoveryError('an unfinished active sprint transaction already exists');
  }
  const token = randomStateToken();
  const value = {
    version: TRANSACTION_VERSION,
    token,
    operation,
    claim: operation === 'init'
      ? null : `${claimSlotName(token, 'pointer')}/${CLAIM_VALUE_FILE}`,
    publish: operation === 'complete' ? null : `active-sprint.publish-${token}.json`,
    expected_sha256: expectedRaw === null ? null : sha256(expectedRaw),
    replacement_sha256: replacementRaw === null ? null : sha256(replacementRaw),
    plan: plan || null,
    phase: phase || null,
    started_at: new Date().toISOString(),
    partial: operation === 'complete'
      ? null : `${claimSlotName(token, 'partial')}/${CLAIM_VALUE_FILE}`,
    replacement_raw: replacementRaw,
  };
  const raw = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECOVERY_BYTES) {
    throw recoveryError('active sprint transaction exceeds recovery budget');
  }
  try {
    writeDurableExclusive(paths.transactionPath, raw, paths.stateDirectory);
  } catch (error) {
    throw recoveryError('cannot persist active sprint transaction', { cause: error });
  }
  const transaction = parseTransaction(paths, raw);
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

function recoverUnpublishedInitTransaction(paths, transaction) {
  const tokenClaimPath = path.join(
    paths.stateDirectory,
    `active-sprint.claim-${transaction.value.token}.json`
  );
  const transactionRaw = readOptionalRecoveryFile(paths.transactionPath);
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
  if (transactionRaw === null || transactionRaw !== transaction.raw) {
    throw recoveryError('unpublished init transaction changed before recovery');
  }
  if (canonicalRaw !== null || legacyClaimRaw !== null || publishRaw !== null
      || privatePointerClaim !== null || privatePartialClaim !== null
      || legacyPartialRaw !== null || legacyPartialReleaseRaw !== null) {
    throw recoveryError('unpublished init gained visible mutation evidence; evidence preserved');
  }
  removeVerifiedRecoveryFile(
    paths.transactionPath,
    sha256(transaction.raw),
    paths.stateDirectory,
    {
      sync: true,
      scopeToken: transaction.value.token,
      artifact: 'transaction',
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

function recoverNonCompletionTransaction(paths) {
  const transaction = readTransaction(paths);
  if (!transaction) return null;
  const state = transaction.value;
  if (state.operation === 'complete') return transaction;

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
    if (state.operation !== 'init' || canonicalRaw !== null || unexpectedInitClaim !== null) {
      throw recoveryError('partial publish evidence conflicts with visible state; evidence preserved');
    }
    cleanupOwnedPartialPublishCandidate(paths, transaction, publishRaw);
    publishRaw = readOptionalRecoveryFile(transaction.publishPath, MAX_POINTER_BYTES);
  }
  if (publishRaw !== null && sha256(publishRaw) !== state.replacement_sha256) {
    throw recoveryError('publish candidate bytes do not match transaction');
  }
  if (claimState.raw !== null && sha256(claimState.raw) !== state.expected_sha256) {
    if (canonicalRaw === null && restoreTransactionClaim(paths, transaction, claimState.raw)) {
      cleanupTransaction(paths, transaction, { publishHash: state.replacement_sha256 });
      return { action: 'restore-foreign-claim' };
    }
    throw recoveryError('claimed pointer bytes do not match transaction; evidence preserved');
  }

  if (canonicalRaw === null) {
    if (claimState.claim && claimState.claim.empty) {
      throw recoveryError('empty private pointer claim has no canonical recovery proof');
    }
    if (claimState.raw !== null) {
      restoreTransactionClaim(paths, transaction, claimState.raw);
      cleanupTransaction(paths, transaction, { publishHash: state.replacement_sha256 });
      return { action: 'restore-expected-pointer' };
    }
    if (state.operation === 'init' && publishRaw !== null) {
      try {
        fs.linkSync(transaction.publishPath, paths.pointerPath);
        fsyncDirectoryIfSupported(paths.stateDirectory);
      } catch (error) {
        if (!error || error.code !== 'EEXIST') {
          throw recoveryError('cannot recover interrupted sprint init', { cause: error });
        }
      }
      cleanupTransaction(paths, transaction, { publishHash: state.replacement_sha256 });
      return { action: 'finish-init' };
    }
    if (state.operation === 'init' && claimState.raw === null && publishRaw === null) {
      return recoverUnpublishedInitTransaction(paths, transaction);
    }
    throw recoveryError('transaction has neither canonical pointer nor recoverable claim');
  }

  const canonicalHash = sha256(canonicalRaw);
  if (claimState.claim) {
    if (claimState.claim.empty) {
      if (![state.expected_sha256, state.replacement_sha256].includes(canonicalHash)) {
        throw recoveryError('empty private pointer claim source successor was preserved');
      }
      removeEmptyPrivateClaimSlot(paths, claimState.claim);
    } else if (claimState.raw !== null) {
      if (canonicalHash !== state.replacement_sha256) {
        throw recoveryError('claimed pointer source successor was preserved');
      }
      cleanupPrivatePointerClaim(
        paths,
        transaction,
        state.expected_sha256,
        state.replacement_sha256
      );
    } else if (claimState.source) {
      const sourceHash = claimState.source.snapshot
        ? sha256(claimState.source.snapshot.bytes) : null;
      if (claimState.source.state === 'successor'
          && sourceHash !== state.replacement_sha256) {
        throw recoveryError('private pointer claim source successor was preserved');
      }
      cleanupPrivatePointerClaim(
        paths,
        transaction,
        state.expected_sha256,
        canonicalHash === state.replacement_sha256 ? state.replacement_sha256 : null
      );
    }
  } else if (claimState.raw !== null) {
    if (canonicalHash !== state.replacement_sha256) {
      throw recoveryError('legacy claimed pointer source successor was preserved');
    }
    removeVerifiedRecoveryFile(
      transaction.claimPath,
      state.expected_sha256,
      paths.stateDirectory,
      {
        scopeToken: state.token,
        artifact: 'legacy-pointer',
      }
    );
  }
  cleanupTransaction(paths, transaction, { publishHash: state.replacement_sha256 });
  return {
    action: canonicalHash === state.replacement_sha256 ? 'finish-replace' : 'abort-replace',
  };
}

function prepareNonCompletionMutation(paths) {
  const pending = recoverNonCompletionTransaction(paths);
  if (pending && pending.value && pending.value.operation === 'complete') {
    throw recoveryError(
      'an interrupted completion must be retried with complete --expected compound'
    );
  }
  if (readPointerRaw(paths.pointerPath) !== null) cleanupCompletionRecord(paths);
}

function atomicWriteSprintPointer(paths, pointer, expectedRaw) {
  const replacementRaw = `${JSON.stringify(pointer)}\n`;
  const operation = expectedRaw === null ? 'init' : 'replace';
  const transaction = createTransaction(paths, {
    operation,
    expectedRaw,
    replacementRaw,
    plan: pointer.plan,
    phase: pointer.phase,
  });
  let claimRaw = null;
  try {
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

    try {
      fs.linkSync(transaction.publishPath, paths.pointerPath);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw recoveryError('exclusive pointer publish failed', { cause: error });
      }
      throw recoveryError('a pointer successor appeared during exclusive publish; evidence preserved');
    }

    fsyncDirectoryIfSupported(paths.stateDirectory);
    cleanupTransaction(paths, transaction, {
      claimHash: claimRaw === null ? undefined : transaction.value.expected_sha256,
      publishHash: transaction.value.replacement_sha256,
      allowedClaimSourceHash: transaction.value.replacement_sha256,
    });
  } catch (error) {
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
function canonicalPointer({ plan, phase, status = 'active', next, now, blockReason }) {
  return {
    version: POINTER_VERSION,
    plan,
    phase,
    status,
    updated_at: now,
    next,
    ...(status === 'blocked' ? { block_reason: blockReason } : {}),
  };
}

function initActiveSprint({ cwd = process.cwd(), plan, restorePhase, next, now } = {}) {
  const normalizedPlan = validatePlanForState(cwd, plan);
  const initialPhase = restorePhase === undefined
    ? 'think' : normalizeStatePhase(restorePhase, 'restore phase');
  const normalizedNext = normalizeStateText(next, 'next');
  const normalizedNow = normalizeStateTimestamp(now);
  return withSprintStateLock(cwd, (paths) => {
    prepareNonCompletionMutation(paths);
    if (readPointerRaw(paths.pointerPath) !== null) {
      throw sprintStateError('SPRINT_ALREADY_ACTIVE', 'refusing to replace an active sprint pointer');
    }
    const pointer = canonicalPointer({
      plan: normalizedPlan,
      phase: initialPhase,
      next: normalizedNext,
      now: normalizedNow,
    });
    atomicWriteSprintPointer(paths, pointer, null);
    cleanupCompletionRecord(paths);
    return { action: 'init', pointer };
  });
}

function advanceActiveSprint({ cwd = process.cwd(), expectedPhase, toPhase, next, now } = {}) {
  const expected = normalizeStatePhase(expectedPhase, 'expected phase');
  const target = normalizeStatePhase(toPhase, 'target phase');
  const normalizedNext = normalizeStateText(next, 'next');
  const normalizedNow = normalizeStateTimestamp(now);
  return withSprintStateLock(cwd, (paths) => {
    prepareNonCompletionMutation(paths);
    const snapshot = readSprintStateSnapshot(cwd, paths.pointerPath);
    assertExpectedPhase(snapshot.pointer, expected);
    if (!ALLOWED_TRANSITIONS[expected].has(target)) {
      throw sprintStateError(
        'ILLEGAL_SPRINT_TRANSITION',
        `cannot advance from ${expected} to ${target}`
      );
    }
    const pointer = canonicalPointer({
      plan: snapshot.pointer.plan,
      phase: target,
      next: normalizedNext,
      now: normalizedNow,
    });
    atomicWriteSprintPointer(paths, pointer, snapshot.raw);
    return { action: 'advance', from: expected, to: target, pointer };
  });
}

function blockActiveSprint({ cwd = process.cwd(), expectedPhase, reason, next, now } = {}) {
  const expected = normalizeStatePhase(expectedPhase, 'expected phase');
  const normalizedReason = normalizeStateText(reason, 'reason');
  const normalizedNext = normalizeStateText(next, 'next');
  const normalizedNow = normalizeStateTimestamp(now);
  return withSprintStateLock(cwd, (paths) => {
    prepareNonCompletionMutation(paths);
    const snapshot = readSprintStateSnapshot(cwd, paths.pointerPath);
    assertExpectedPhase(snapshot.pointer, expected);
    const pointer = canonicalPointer({
      plan: snapshot.pointer.plan,
      phase: expected,
      status: 'blocked',
      blockReason: normalizedReason,
      next: normalizedNext,
      now: normalizedNow,
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
  if (!value || value.version !== RECOVERY_VERSION
      || !/^[a-f0-9]{32}$/.test(value.token || '')
      || !/^[a-f0-9]{64}$/.test(value.expected_sha256 || '')
      || value.phase !== 'compound'
      || typeof value.plan !== 'string') {
    throw recoveryError('completion record schema is invalid');
  }
  const plan = normalizePlanPath(paths.workspace, value.plan);
  if (!plan) throw recoveryError('completion record plan is invalid');
  return { raw, value: { ...value, plan } };
}

function readCompletionRecord(paths) {
  const raw = readOptionalRecoveryFile(paths.completionPath);
  return raw === null ? null : parseCompletionRecord(paths, raw);
}

function writeCompletionRecord(paths, transaction) {
  const stagePath = path.join(
    paths.stateDirectory,
    `active-sprint.completed-${transaction.value.token}.tmp`
  );
  const existing = readCompletionRecord(paths);
  if (existing) {
    if (existing.value.expected_sha256 === transaction.value.expected_sha256
        && existing.value.plan === transaction.value.plan
        && existing.value.phase === transaction.value.phase) {
      const stageRaw = readOptionalRecoveryFile(stagePath);
      if (stageRaw !== null) {
        if (sha256(stageRaw) !== sha256(existing.raw)) {
          throw recoveryError('completion staging bytes differ from completed record');
        }
        removeVerifiedRecoveryFile(stagePath, sha256(stageRaw), paths.stateDirectory, {
          scopeToken: transaction.value.token,
          artifact: 'completion-stage',
        });
      }
      return existing;
    }
    throw recoveryError('a different completion record already exists');
  }
  const value = {
    version: RECOVERY_VERSION,
    token: transaction.value.token,
    plan: transaction.value.plan,
    phase: transaction.value.phase,
    expected_sha256: transaction.value.expected_sha256,
    completed_at: new Date().toISOString(),
  };
  const raw = `${JSON.stringify(value)}\n`;
  try {

    writeDurableExclusive(stagePath, raw, paths.stateDirectory);
    try {
      fs.linkSync(stagePath, paths.completionPath);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const raced = readCompletionRecord(paths);
      if (!raced || raced.value.expected_sha256 !== transaction.value.expected_sha256) {
        throw recoveryError('completion record publish raced with different bytes');
      }
    }
    fsyncDirectoryIfSupported(paths.stateDirectory);
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

function cleanupCompletionRecord(paths) {
  const completion = readCompletionRecord(paths);
  if (!completion) return false;
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
  let canonicalRaw = readPointerRaw(paths.pointerPath);
  let claimState = readTransactionClaimState(paths, transaction);
  let claimConsumed = false;

  if (claimState.raw !== null
      && sha256(claimState.raw) !== transaction.value.expected_sha256) {
    const restored = canonicalRaw === null
      ? restoreTransactionClaim(paths, transaction, claimState.raw) : false;
    if (restored) {
      cleanupTransaction(paths, transaction);
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
    writeCompletionRecord(paths, transaction);
    if (claimState.raw !== null) {
      if (transaction.privatePaths) {
        cleanupPrivatePointerClaim(
          paths,
          transaction,
          transaction.value.expected_sha256
        );
      } else {
        removeVerifiedRecoveryFile(
          transaction.claimPath,
          transaction.value.expected_sha256,
          paths.stateDirectory,
          {
            sync: true,
            scopeToken: transaction.value.token,
            artifact: 'legacy-pointer',
          }
        );
      }
    }
    cleanupTransaction(paths, transaction);
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
    const transaction = createTransaction(paths, {
      operation: 'complete',
      expectedRaw: snapshot.raw,
      replacementRaw: null,
      plan: snapshot.pointer.plan,
      phase: snapshot.pointer.phase,
    });
    try {
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
  }),
};
