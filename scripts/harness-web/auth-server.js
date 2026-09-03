'use strict';
const http = require('node:http');
const { AuthError, SESSION_TTL_SECONDS } = require('./auth');
const PREFIX = '/tech-persistence/api/v1';
const COOKIE_NAME = '__Host-tp_session';
const SECURITY_HEADERS = new Set(['host', 'origin', 'cookie', 'content-type', 'content-length', 'x-tp-client', 'x-tp-csrf', 'sec-fetch-site']);
function sessionCookie(token, clear = false) {
  return `${COOKIE_NAME}=${clear ? '' : token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_TTL_SECONDS}`;
}
function sessionToken(request) {
  const cookies = String(request.headers.cookie || '').split(';').map(item => item.trim());
  const matches = cookies.filter(item => item.split('=')[0] === COOKIE_NAME);
  if (matches.length > 1) throw new AuthError(400, 'duplicate_cookie');
  return matches.length ? matches[0].slice(COOKIE_NAME.length + 1) : null;
}
function requestGate(request, origin) {
  const seen = new Set();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    if (SECURITY_HEADERS.has(name) && seen.has(name)) throw new AuthError(400, 'duplicate_header');
    seen.add(name);
  }
  if (request.headers.host !== origin.host) throw new AuthError(403, 'forbidden_host');
  const suppliedOrigin = request.headers.origin;
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin.origin) throw new AuthError(403, 'forbidden_origin');
  if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') throw new AuthError(403, 'forbidden_origin');
  if (request.method !== 'GET' && (suppliedOrigin !== origin.origin || request.headers['x-tp-client'] !== '1')) {
    throw new AuthError(403, 'forbidden_origin');
  }
}
async function readBody(request) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) throw new AuthError(415, 'json_required');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 32768) throw new AuthError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AuthError(400, 'invalid_json'); }
}
function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(status === 204 ? undefined : JSON.stringify(body));
}
function taskRoute(url) {
  if (url === `${PREFIX}/projects`) return { operation: 'projects' };
  if (url === `${PREFIX}/tasks`) return { operation: 'tasks' };
  const match = new RegExp(`^${PREFIX}/tasks/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:/(execute|cancel|confirm|transcript))?$`).exec(url);
  return match ? { operation: match[2] || 'task', taskId: match[1] } : null;
}
function createAuthServer({ service, taskService = null, publicOrigin }) {
  const origin = new URL(publicOrigin);
  let activeRequests = 0;
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('public origin must be an HTTPS origin');
  }
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000,
    connectionsCheckingInterval: 250 }, async (request, response) => {
    let admitted = false;
    try {
      requestGate(request, origin);
      // Exact raw paths reject traversal, queries and alternate URL interpretations.
      const routes = { [`${PREFIX}/auth/login`]: 'POST', [`${PREFIX}/auth/session`]: 'GET', [`${PREFIX}/auth/logout`]: 'POST' };
      const task = taskService && taskRoute(request.url);
      const taskMethods = { projects: 'GET', task: 'GET', transcript: 'GET', execute: 'POST', cancel: 'POST', confirm: 'POST' };
      const method = routes[request.url] || (task && task.operation === 'tasks'
        ? (['GET', 'POST'].includes(request.method) ? request.method : 'GET, POST') : task && taskMethods[task.operation]);
      if (!method) throw new AuthError(404, 'not_found');
      if (request.method !== method) { response.setHeader('Allow', method); throw new AuthError(405, 'method_not_allowed'); }
      const token = sessionToken(request);
      // Socket limits do not bound abandoned requests still waiting on the database.
      if (activeRequests >= 16) throw new AuthError(429, 'auth_busy');
      activeRequests++; admitted = true;
      if (request.url.endsWith('/session')) return sendJson(response, 200, await service.session(token));
      if (task) {
        if (task.operation === 'projects') return sendJson(response, 200, { projects: await taskService.projects(token) });
        if (task.operation === 'tasks' && request.method === 'GET') return sendJson(response, 200, await taskService.list(token));
        if (task.operation === 'task') return sendJson(response, 200, { task: await taskService.get(token, task.taskId) });
        if (task.operation === 'transcript') return sendJson(response, 200, { transcript: await taskService.transcript(token, task.taskId) });
        const body = await readBody(request);
        const csrf = request.headers['x-tp-csrf'];
        if (task.operation === 'tasks') return sendJson(response, 201, { task: await taskService.create(token, csrf, body) });
        if (task.operation === 'execute') return sendJson(response, 200, { task: await taskService.enqueue(token, csrf, task.taskId, body) });
        if (task.operation === 'cancel') return sendJson(response, 200, { task: await taskService.cancel(token, csrf, task.taskId, body) });
        return sendJson(response, 200, { task: await taskService.confirm(token, csrf, task.taskId, body) });
      }
      const body = await readBody(request);
      if (request.url.endsWith('/login')) {
        const result = await service.login(body);
        response.setHeader('Set-Cookie', sessionCookie(result.token));
        const { token: ignored, ...publicResult } = result;
        return sendJson(response, 200, publicResult);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new AuthError(400, 'invalid_request');
      await service.logout(token, request.headers['x-tp-csrf']);
      response.setHeader('Set-Cookie', sessionCookie('', true));
      return sendJson(response, 204);
    } catch (error) {
      response.setHeader('Connection', 'close');
      if (error instanceof AuthError && error.status === 429) response.setHeader('Retry-After', '60');
      sendJson(response, error instanceof AuthError ? error.status : 503,
        { error: error instanceof AuthError ? error.code : 'auth_unavailable' });
    } finally { if (admitted) activeRequests--; }
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(5000, socket => socket.destroy());
  return server;
}
module.exports = { createAuthServer, requestGate, readBody, sessionToken, sessionCookie, taskRoute };
