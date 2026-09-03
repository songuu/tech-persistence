'use strict';
const crypto = require('node:crypto');

async function main() {
  if (process.argv.length !== 2) throw new Error('responses probe accepts no arguments');
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const configuredBase = process.env.OPENAI_BASE_URL;
  if (!apiKey || !model || !configuredBase) throw new Error('approved runner model configuration is incomplete');
  const base = new URL(configuredBase);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('unsafe upstream origin');
  const prefix = base.pathname.replace(/\/$/, '');
  const endpoint = new URL(`${prefix}/responses`, base.origin);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: 'Return exactly OK.', max_output_tokens: 16, stream: false }) });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 65536) { controller.abort(); throw new Error('responses probe body exceeded limit'); }
      chunks.push(chunk);
    }
    const contentType = response.headers.get('content-type') || '';
    const requestId = response.headers.get('x-request-id') || '';
    process.stdout.write(`${JSON.stringify({ status: response.status, ok: response.ok, bytes,
      json: /^application\/json(?:;|$)/i.test(contentType), requestIdHash: requestId ? crypto.createHash('sha256').update(requestId).digest('hex') : null })}\n`);
  } finally { clearTimeout(timer); }
}
main().catch(error => { process.stderr.write(`responses probe failed: ${error.name === 'AbortError' ? 'timeout' : error.message}\n`); process.exitCode = 1; });
