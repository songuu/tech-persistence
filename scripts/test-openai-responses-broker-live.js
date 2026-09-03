'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { executeUpstream, executeChatUpstream } = require('./openai-responses-broker');

async function main() {
  if (process.argv.length !== 2) throw new Error('live broker qualification accepts no arguments');
  const baseUrl = process.env.OPENAI_BASE_URL; const apiKey = process.env.OPENAI_API_KEY; const model = process.env.OPENAI_MODEL;
  if (!baseUrl || !apiKey || !model) throw new Error('approved Agent model configuration is incomplete');
  const base = new URL(baseUrl); assert.equal(base.protocol, 'https:');
  const config = { baseUrl: base.href.replace(/\/$/, ''), apiKey, model, timeoutMs: 120000, maxTokens: 256, maxResponseBytes: 512 * 1024 };
  const text = await executeUpstream({ model, stream: true, max_output_tokens: 32,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Return exactly BROKER_OK.' }] }] }, config);
  assert.match(text.body, /response\.output_item\.done/); assert.match(text.body, /response\.completed/);
  const tool = await executeUpstream({ model, stream: true, max_output_tokens: 128,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Call the probe tool exactly once with {"value":"ok"}. Do not answer in text.' }] }],
    tools: [{ type: 'function', name: 'probe', description: 'Qualification probe', parameters: { type: 'object', additionalProperties: false,
      properties: { value: { type: 'string' } }, required: ['value'] }, strict: true }], tool_choice: { type: 'function', name: 'probe' } }, config);
  assert.match(tool.body, /"type":"function_call"/); assert.match(tool.body, /response\.completed/);
  const chat = await executeChatUpstream({ model, messages: [{ role: 'user', content: 'Return JSON with ok set to true.' }],
    temperature: 0, max_tokens: 64, stream: false, response_format: { type: 'json_schema', json_schema: {
      name: 'harness_result', strict: true, schema: { type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } }, config);
  const chatEnvelope = JSON.parse(chat.body); const chatPayload = JSON.parse(chatEnvelope.choices?.[0]?.message?.content || '');
  assert.equal(chatPayload.ok, true);
  process.stdout.write(`${JSON.stringify({ textTranslation: true, toolTranslation: true, chatStructuredOutput: true,
    textEvidenceHash: crypto.createHash('sha256').update(text.body).digest('hex'),
    toolEvidenceHash: crypto.createHash('sha256').update(tool.body).digest('hex'),
    chatEvidenceHash: crypto.createHash('sha256').update(chat.body).digest('hex') })}\n`);
}
main().catch(error => { process.stderr.write(`live broker qualification failed: ${error.name === 'AbortError' ? 'timeout' : error.message}\n`); process.exitCode = 1; });
