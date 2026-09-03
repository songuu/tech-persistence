'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createAuthServer, taskRoute } = require('./harness-web/auth-server');

const taskId = randomUUID(); const token = 'a'.repeat(64);
function call(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const headers = { Host: 'songuu.top', Cookie: `__Host-tp_session=${token}`, ...(options.headers || {}) };
    if (body !== null) Object.assign(headers, { Origin: 'https://songuu.top', 'X-TP-Client': '1',
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path,
      method: options.method || 'GET', headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject); request.end(body);
  });
}
test('task route parser accepts only canonical exact paths', () => {
  assert.deepEqual(taskRoute(`/tech-persistence/api/v1/tasks/${taskId}/confirm`), { operation: 'confirm', taskId });
  assert.deepEqual(taskRoute(`/tech-persistence/api/v1/tasks/${taskId}/transcript`), { operation: 'transcript', taskId });
  for (const path of [`/tech-persistence/api/v1/tasks/${taskId.toUpperCase()}`, `/tech-persistence/api/v1/tasks/${taskId}/confirm/`,
    `/tech-persistence/api/v1/tasks/${taskId}?owner=other`, '/tech-persistence/api/v1/tasks/../secret']) assert.equal(taskRoute(path), null);
});
test('HTTP task API dispatches only whitelisted projections and actions', async t => {
  const calls = []; const task = { id: taskId, state: 'needs_coordination' };
  const taskService = {
    projects: async supplied => { calls.push(['projects', supplied]); return [{ id: 'project', name: 'Project', canCreate: true, canExecute: true }]; },
    list: async supplied => { calls.push(['list', supplied]); return { items: [], nextCursor: null }; },
    get: async (supplied, id) => { calls.push(['get', supplied, id]); return task; },
    create: async (supplied, csrf, body) => { calls.push(['create', supplied, csrf, body]); return task; },
    enqueue: async (supplied, csrf, id, body) => { calls.push(['enqueue', supplied, csrf, id, body]); return task; },
    cancel: async (supplied, csrf, id, body) => { calls.push(['cancel', supplied, csrf, id, body]); return task; },
    confirm: async (supplied, csrf, id, body) => { calls.push(['confirm', supplied, csrf, id, body]); return task; },
    transcript: async (supplied, id) => { calls.push(['transcript', supplied, id]); return { status: 'synced', eventCount: 2, lastSyncedAt: new Date().toISOString() }; },
  };
  const service = { session: async () => ({}), login: async () => ({}), logout: async () => {} };
  const server = createAuthServer({ service, taskService, publicOrigin: 'https://songuu.top' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  assert.equal((await call(server, '/tech-persistence/api/v1/projects')).status, 200);
  assert.equal((await call(server, '/tech-persistence/api/v1/tasks')).status, 200);
  assert.equal((await call(server, `/tech-persistence/api/v1/tasks/${taskId}`)).status, 200);
  assert.equal((await call(server, `/tech-persistence/api/v1/tasks/${taskId}/transcript`)).status, 200);
  assert.equal((await call(server, '/tech-persistence/api/v1/tasks', { method: 'POST', body: { requirement: 'x' }, headers: { 'X-TP-CSRF': 'c' } })).status, 201);
  assert.equal((await call(server, `/tech-persistence/api/v1/tasks/${taskId}/confirm`, { method: 'POST', body: {}, headers: { 'X-TP-CSRF': 'c' } })).status, 200);
  assert.deepEqual(calls.map(value => value[0]), ['projects', 'list', 'get', 'transcript', 'create', 'confirm']);
  assert.ok(calls.every(value => value[1] === token));
  assert.equal((await call(server, `/tech-persistence/api/v1/tasks/${taskId}/confirm?x=1`, { method: 'POST', body: {} })).status, 404);
});
