'use strict';
const { AuthError, validToken, tokenHash, checkCsrf } = require('./auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const DATABASE_ERRORS = Object.freeze({ P0400: [400, 'invalid_request'], P0401: [401, 'unauthorized'],
  P0403: [403, 'forbidden'], P0404: [404, 'not_found'], P0409: [409, 'conflict'],
  P0429: [429, 'task_limit'], P0503: [503, 'execution_unavailable'] });
function invalid() { throw new AuthError(400, 'invalid_request'); }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function requirement(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > 16384
      || Buffer.from(value, 'utf8').toString('utf8') !== value) invalid();
  return value;
}
function timestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid stored timestamp');
  return new Date(value).toISOString();
}
function publicTask(row, detail, replay) {
  if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.projectId !== 'string'
      || !PROJECT.test(row.projectId) || !['draft', 'queued', 'claimed', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'needs_coordination'].includes(row.state)
      || (row.state === 'draft' ? row.queuedAt !== null : row.queuedAt === null)) throw new Error('invalid stored task');
  const result = { id: row.id, projectId: row.projectId, state: row.state,
    createdAt: timestamp(row.createdAt), queuedAt: timestamp(row.queuedAt, true) };
  if (detail) {
    // Stored data is not implicitly trusted as a public response contract.
    if (typeof row.requirement !== 'string' || Buffer.byteLength(row.requirement) > 16384) throw new Error('invalid stored requirement');
    result.requirement = row.requirement;
    if (!(row.terminalCode === null || (typeof row.terminalCode === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.terminalCode)))
        || typeof row.confirmationRequired !== 'boolean') throw new Error('invalid stored task detail');
    result.terminalCode = row.terminalCode;
    result.confirmationRequired = row.confirmationRequired;
  }
  if (replay) { if (typeof row.replayed !== 'boolean') throw new Error('invalid stored replay'); result.replayed = row.replayed; }
  return result;
}
function createTaskService(store) {
  let active = 0;
  async function invoke(token, operation) {
    if (!validToken(token)) throw new AuthError(401, 'unauthorized');
    if (active >= 8) throw new AuthError(429, 'task_busy');
    active++;
    try { return await operation(tokenHash(token)); }
    catch (error) {
      if (error instanceof AuthError) throw error;
      const mapped = Object.hasOwn(DATABASE_ERRORS, error?.code || '') ? DATABASE_ERRORS[error.code] : [503, 'tasks_unavailable'];
      throw new AuthError(...mapped);
    } finally { active--; }
  }
  return {
    create(token, csrf, input) {
      return invoke(token, async sessionHash => {
        checkCsrf(token, csrf); object(input, ['projectId', 'requirement', 'idempotencyKey']);
        if (typeof input.projectId !== 'string' || !PROJECT.test(input.projectId)) invalid();
        const result = await store.create({ sessionHash, projectId: input.projectId,
          requirement: requirement(input.requirement), creationKey: uuid(input.idempotencyKey) });
        return publicTask(result, true, true);
      });
    },
    enqueue(token, csrf, taskId, input) {
      return invoke(token, async sessionHash => {
        checkCsrf(token, csrf); object(input, ['idempotencyKey']);
        return publicTask(await store.enqueue({ sessionHash, taskId: uuid(taskId), executionKey: uuid(input.idempotencyKey) }), true, true);
      });
    },
    cancel(token, csrf, taskId, input) {
      return invoke(token, async sessionHash => {
        checkCsrf(token, csrf); object(input, []);
        return publicTask(await store.cancel({ sessionHash, taskId: uuid(taskId) }), true, false);
      });
    },
    confirm(token, csrf, taskId, input) {
      return invoke(token, async sessionHash => {
        checkCsrf(token, csrf); object(input, []);
        return publicTask(await store.confirm({ sessionHash, taskId: uuid(taskId) }), true, false);
      });
    },
    get(token, taskId) { return invoke(token, async sessionHash => publicTask(await store.get({ sessionHash, taskId: uuid(taskId) }), true, false)); },
    transcript(token, taskId) {
      return invoke(token, async sessionHash => {
        const result = await store.transcript({ sessionHash, taskId: uuid(taskId) });
        if (!result || !['pending', 'synced'].includes(result.status) || !Number.isSafeInteger(result.eventCount) || result.eventCount < 0
            || !(result.lastSyncedAt === null || (typeof result.lastSyncedAt === 'string' && Number.isFinite(Date.parse(result.lastSyncedAt))))) {
          throw new Error('invalid transcript status');
        }
        return { status: result.status, eventCount: result.eventCount,
          lastSyncedAt: result.lastSyncedAt === null ? null : new Date(result.lastSyncedAt).toISOString() };
      });
    },
    list(token, input = {}) {
      return invoke(token, async sessionHash => {
        object(input, [], ['after', 'limit']);
        const limit = input.limit === undefined ? 20 : input.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid();
        const after = input.after === undefined ? null : uuid(input.after);
        const result = await store.list({ sessionHash, limit, after });
        if (!result || !Array.isArray(result.items) || result.items.length > limit
            || !(result.nextCursor === null || (typeof result.nextCursor === 'string' && UUID.test(result.nextCursor)))) throw new Error('invalid stored page');
        return { items: result.items.map(row => publicTask(row, false, false)), nextCursor: result.nextCursor };
      });
    },
    projects(token) {
      return invoke(token, async sessionHash => {
        const rows = await store.projects({ sessionHash });
        if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid stored projects');
        return rows.map(row => {
          if (!row || typeof row.id !== 'string' || !PROJECT.test(row.id) || typeof row.name !== 'string'
              || !row.name || [...row.name].length > 128 || typeof row.canCreate !== 'boolean' || typeof row.canExecute !== 'boolean') throw new Error('invalid stored project');
          return { id: row.id, name: row.name, canCreate: row.canCreate, canExecute: row.canExecute };
        });
      });
    },
  };
}
module.exports = { createTaskService };
