'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const origin = 'https://songuu.top'; const api = `${origin}/tech-persistence/api/v1`;
let stage = 'credentials';
let qualificationCookie = null; let qualificationCsrf = null;
function credentials() {
  const values = Object.fromEntries(fs.readFileSync('/root/tech-persistence-qualification-login.txt', 'utf8').trim().split('\n').map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (values.URL !== `${origin}/tech-persistence/tasks/` || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(values.USERNAME)
      || !values.PASSWORD) throw new Error('invalid credential file');
  return values;
}
async function json(path, options = {}) {
  const response = await fetch(`${api}${path}`, { method: options.method || 'GET', redirect: 'error', cache: 'no-store',
    headers: { ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body ? {
      Origin: origin, 'X-TP-Client': '1', 'Content-Type': 'application/json', ...(options.csrf ? { 'X-TP-CSRF': options.csrf } : {}) } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result?.error || 'unknown'}`);
  return { result, response };
}
async function waitTask(taskId, cookie, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs; let task;
  while (Date.now() < deadline) {
    task = (await json(`/tasks/${taskId}`, { cookie })).result.task;
    if (predicate(task)) return task;
    if (['failed', 'cancelled'].includes(task.state)) throw new Error(`task terminal failure: ${task.state}/${task.terminalCode}`);
    await delay(2000);
  }
  throw new Error(`task wait timeout: ${task?.state || 'unknown'}/${task?.terminalCode || 'none'}`);
}
(async () => {
  const input = credentials();
  stage = 'login';
  const login = await json('/auth/login', { method: 'POST', body: { username: input.USERNAME, password: input.PASSWORD } });
  const cookie = String(login.response.headers.get('set-cookie')).split(';', 1)[0];
  qualificationCookie = cookie;
  if (!/^__Host-tp_session=[a-f0-9]{64}$/.test(cookie)) throw new Error('secure session cookie missing');
  stage = 'session';
  const session = (await json('/auth/session', { cookie })).result;
  qualificationCsrf = session.csrfToken;
  stage = 'projects';
  const projects = (await json('/projects', { cookie })).result.projects;
  if (!projects.some(project => project.id === 'qualification-project' && project.canCreate && project.canExecute)) throw new Error('qualified project unavailable');
  stage = 'create';
  const created = (await json('/tasks', { method: 'POST', cookie, csrf: session.csrfToken, body: {
    projectId: 'qualification-project', requirement: 'Create result.txt containing exactly HARNESS_FULL_CHAIN_OK followed by one newline. Do not modify any other tracked file. The existing node test.js validation checks both exact content and tracked-file integrity and must pass; use that exact command as the Oracle for both requirements.', idempotencyKey: randomUUID() } })).result.task;
  stage = 'execute';
  await json(`/tasks/${created.id}/execute`, { method: 'POST', cookie, csrf: session.csrfToken, body: { idempotencyKey: randomUUID() } });
  stage = 'await-spec';
  let task = await waitTask(created.id, cookie, value => value.state === 'succeeded' || value.confirmationRequired === true, 20 * 60 * 1000);
  let confirmed = false;
  if (task.confirmationRequired) {
    stage = 'confirm';
    await json(`/tasks/${created.id}/confirm`, { method: 'POST', cookie, csrf: session.csrfToken, body: {} }); confirmed = true;
    stage = 'await-completion';
    task = await waitTask(created.id, cookie, value => value.state === 'succeeded', 20 * 60 * 1000);
  }
  stage = 'transcript';
  let transcript;
  const transcriptDeadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < transcriptDeadline) {
    transcript = (await json(`/tasks/${created.id}/transcript`, { cookie })).result.transcript;
    if (transcript.status === 'synced' && transcript.eventCount > 0) break;
    await delay(3000);
  }
  if (!transcript || transcript.status !== 'synced' || transcript.eventCount < 1) throw new Error('Transcript did not reach independent reader');
  await json('/auth/logout', { method: 'POST', cookie, csrf: session.csrfToken, body: {} });
  process.stdout.write(`${JSON.stringify({ publicHttps: true, taskId: created.id, state: task.state,
    terminalCode: task.terminalCode, confirmationExercised: confirmed, transcript })}\n`);
})().catch(async error => {
  if (qualificationCookie && qualificationCsrf) {
    try { await json('/auth/logout', { method: 'POST', cookie: qualificationCookie, csrf: qualificationCsrf, body: {} }); } catch { /* Best-effort test cleanup. */ }
  }
  const match = /^HTTP (\d{3}): ([a-z0-9_]{1,64})$/.exec(String(error.message));
  const terminal = /^task terminal failure: (failed|cancelled)\/([a-z0-9_-]{1,64})$/.exec(String(error.message));
  process.stderr.write(`${JSON.stringify({ productionQualification: false, stage,
    errorCode: match ? `http_${match[1]}_${match[2]}` : terminal ? `task_${terminal[1]}_${terminal[2]}` : 'internal_failure' })}\n`);
  process.exitCode = 1;
});
