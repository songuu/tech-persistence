'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { requestText } = require('./lib/loopback-http');

test('loopback HTTP uses bounded core transport', async t => {
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await requestText(`http://127.0.0.1:${server.address().port}/health`, { timeoutMs: 1000, maxBytes: 100 });
  assert.deepEqual(result, { status: 200, ok: true, text: 'ok' });
});

test('loopback HTTP connects through an allowed Unix socket', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync('/run/tech-persistence-provider-broker/test.XXXXXX');
  const socketPath = path.join(root, 'responses.sock');
  const server = http.createServer((_request, response) => response.end('unix-ok'));
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const result = await requestText('http://127.0.0.1:8080/health', { socketPath, timeoutMs: 1000, maxBytes: 100 });
  assert.equal(result.text, 'unix-ok');
});
