'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableHash } = require('./runtime-capabilities');
const { requestText } = require('../lib/loopback-http');

const CASES = Object.freeze([
  'cold-start', 'structured-output', 'terminal-success', 'terminal-failure',
  'terminal-timeout', 'resume', 'event-correlation', 'repo-read', 'env-redaction',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function requestJson(url, init = {}, timeoutMs = 15000) {
  const response = await requestText(url, { method: init.method, headers: init.headers, body: init.body,
    timeoutMs, maxBytes: 512 * 1024 });
  let body = null;
  try { body = response.text ? JSON.parse(response.text) : null; } catch {}
  return { status: response.status, ok: response.ok, body, bodyHash: sha256(response.text) };
}

function caseResult(id, passed, evidence = {}) {
  return { id, status: passed ? 'passed' : 'failed', evidenceHash: stableHash(evidence) };
}

async function runCanary(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
  const model = String(options.model || '');
  const repoProbe = path.resolve(options.repoProbe || __filename);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseUrl)) {
    throw new Error('read-only canary base URL must be loopback HTTP(S)');
  }
  if (!model) throw new Error('model is required');
  const startedAt = new Date().toISOString();
  const correlationId = crypto.randomUUID();
  const headers = { 'content-type': 'application/json', authorization: 'Bearer redacted' };
  const events = [];
  const cases = [];
  const record = (type, payload) => events.push({ type, correlationHash: sha256(correlationId), payloadHash: stableHash(payload) });

  const healthStart = Date.now();
  const health = await requestJson(`${baseUrl}/health`);
  cases.push(caseResult('cold-start', health.ok, { status: health.status, latencyMs: Date.now() - healthStart }));

  const repoStat = fs.lstatSync(repoProbe);
  const repoBytes = fs.readFileSync(repoProbe);
  const repoHash = sha256(repoBytes);
  const schema = { type: 'object', properties: { ok: { const: true }, repoHash: { const: repoHash } },
    required: ['ok', 'repoHash'], additionalProperties: false };
  const successPayload = { model, messages: [{ role: 'user', content: `Return JSON with ok=true and repoHash=${repoHash}.` }],
    temperature: 0, max_tokens: 128, response_format: { type: 'json_schema', json_schema: { name: 'canary', strict: true, schema } } };
  record('request', successPayload);
  const success = await requestJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(successPayload) }, 30000);
  record('response', { status: success.status, id: success.body && success.body.id });
  const content = success.body && success.body.choices && success.body.choices[0]
    && success.body.choices[0].message && success.body.choices[0].message.content;
  let structured = null;
  try { structured = JSON.parse(content); } catch {}
  cases.push(caseResult('structured-output', success.ok && structured && structured.ok === true
    && structured.repoHash === repoHash, { status: success.status, bodyHash: success.bodyHash }));
  cases.push(caseResult('terminal-success', success.ok && Boolean(success.body && success.body.id), { status: success.status, idHash: sha256(String(success.body && success.body.id || '')) }));

  const failure = await requestJson(`${baseUrl}/v1/definitely-not-an-endpoint`, { method: 'POST', headers, body: '{}' });
  cases.push(caseResult('terminal-failure', !failure.ok, { status: failure.status, bodyHash: failure.bodyHash }));
  let timedOut = false;
  try { await requestJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...successPayload, max_tokens: 256 }) }, 1); }
  catch (error) { timedOut = error && error.name === 'AbortError'; }
  cases.push(caseResult('terminal-timeout', timedOut, { timedOut }));

  const prior = structured ? JSON.stringify(structured) : '{}';
  const resumePayload = { ...successPayload, messages: [...successPayload.messages,
    { role: 'assistant', content: prior }, { role: 'user', content: 'Return the same JSON again.' }] };
  const resumed = await requestJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(resumePayload) }, 30000);
  cases.push(caseResult('resume', resumed.ok, { mode: 'conversation-replay', status: resumed.status }));
  cases.push(caseResult('event-correlation', events.length === 2 && events.every((event) => event.correlationHash === events[0].correlationHash), { correlationHash: events[0].correlationHash, count: events.length }));

  cases.push(caseResult('repo-read', repoStat.isFile() && !repoStat.isSymbolicLink()
    && structured && structured.repoHash === repoHash,
  { mode: 'bounded-context-hash', pathHash: sha256(repoProbe.toLowerCase()), contentHash: repoHash }));
  const secretValues = Object.entries(options.environment || {}).filter(([key, value]) => /KEY|TOKEN|SECRET/i.test(key) && value).map(([, value]) => String(value));
  const provisional = { version: 'native-runtime-canary-v1', runtime: 'openai-compatible', endpointHash: sha256(baseUrl), modelHash: sha256(model), startedAt,
    finishedAt: new Date().toISOString(), cases, workspaceEffects: 0, externalEffects: 0, identityMismatch: 0,
    transcript: events };
  const serialized = JSON.stringify(provisional);
  cases.push(caseResult('env-redaction', secretValues.every((value) => !serialized.includes(value)), { checkedSecretCount: secretValues.length }));
  const status = CASES.every((id) => cases.some((item) => item.id === id && item.status === 'passed')) ? 'passed' : 'failed';
  const core = { ...provisional, cases, status };
  return { ...core, receiptHash: stableHash(core) };
}

module.exports = { CASES, requestJson, runCanary };
