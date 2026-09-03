'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { runCanary, CASES } = require('./agent-orchestrator/native-runtime-canary');

(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/health') return response.end(JSON.stringify({ status: 'ok' }));
    if (request.url === '/v1/definitely-not-an-endpoint') { response.statusCode = 404; return response.end('{}'); }
    let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => {
      const payload = JSON.parse(body); const delay = payload.max_tokens === 256 ? 25 : 0;
      const repoHash = payload.response_format.json_schema.schema.properties.repoHash.const;
      setTimeout(() => response.end(JSON.stringify({ id: 'mock-id', choices: [{ message: {
        content: JSON.stringify({ ok: true, repoHash }),
      } }] })), delay);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const receipt = await runCanary({ baseUrl: `http://127.0.0.1:${address.port}`, model: 'mock', repoProbe: __filename,
      environment: { OPENAI_API_KEY: 'must-not-appear' } });
    assert.equal(receipt.status, 'passed');
    assert.deepEqual(receipt.cases.map((item) => item.id), CASES);
    assert.ok(!JSON.stringify(receipt).includes('must-not-appear'));
  } finally { await new Promise((resolve) => server.close(resolve)); }
  process.stdout.write('native runtime canary: passed\n');
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
