'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { translateRequest, translateResponse, validateChatRequest, upstreamChatRequest, executeUpstream, executeChatUpstream,
  diagnosticCode, createServer } = require('./openai-responses-broker');

const request = () => ({ model: 'fixed-model', instructions: 'Act as a coding agent.', stream: true, max_output_tokens: 100,
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'workspace' },
  ], tools: [{ type: 'function', name: 'shell', description: 'run fixed command', parameters: { type: 'object' }, strict: true }] });

test('responses request maps bounded messages and function tools to chat completions', () => {
  const output = translateRequest(request(), { model: 'fixed-model', maxTokens: 4096 });
  assert.equal(output.model, 'fixed-model'); assert.equal(output.stream, false); assert.equal(output.max_tokens, 100);
  assert.deepEqual(output.messages.map(item => item.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(output.messages[2].tool_calls[0].function.name, 'shell'); assert.equal(output.messages[3].tool_call_id, 'call_1');
  assert.deepEqual(output.tools[0].function.parameters, { type: 'object' });
});

test('responses named tool choice maps to the chat function envelope', () => {
  const output = translateRequest({ ...request(), tool_choice: { type: 'function', name: 'shell' } }, { model: 'fixed-model', maxTokens: 4096 });
  assert.deepEqual(output.tool_choice, { type: 'function', function: { name: 'shell' } });
});

test('Codex client metadata is bounded and never forwarded upstream', () => {
  const output = translateRequest({ ...request(), client_metadata: { originator: 'codex_cli_rs' } }, { model: 'fixed-model', maxTokens: 4096 });
  assert.equal(Object.hasOwn(output, 'client_metadata'), false);
  assert.throws(() => translateRequest({ ...request(), client_metadata: 'invalid' }, { model: 'fixed-model', maxTokens: 4096 }), /client metadata/);
});

test('Codex namespace tools flatten for Chat backends and disconnected web search is omitted', () => {
  const output = translateRequest({ ...request(), tools: [
    { type: 'namespace', name: 'collaboration', description: 'Agent tools', tools: [
      { type: 'function', name: 'list_agents', description: 'List agents', parameters: { type: 'object' }, strict: false },
      { type: 'function', name: 'deferred', description: '', parameters: { type: 'object' }, strict: false, defer_loading: true }
    ] },
    { type: 'web_search', external_web_access: false }
  ] }, { model: 'fixed-model', maxTokens: 4096 });
  assert.deepEqual(output.tools.map(tool => tool.function.name), ['collaboration__list_agents']);
  assert.match(output.tools[0].function.description, /Agent tools/);
});

test('external spec and review Chat request is fixed, bounded and tool-free', () => {
  const input = { model: 'fixed-model', messages: [{ role: 'user', content: 'bounded prompt' }], temperature: 0,
    max_tokens: 512, stream: false, response_format: { type: 'json_schema', json_schema: {
      name: 'harness_result', strict: true, schema: { type: 'object', additionalProperties: false } } } };
  assert.equal(validateChatRequest(input, { model: 'fixed-model', maxTokens: 4096 }), input);
  assert.equal(validateChatRequest({ ...input, stream: undefined, messages: [...input.messages,
    { role: 'assistant', content: '{}' }, { role: 'user', content: 'again' }],
    response_format: { ...input.response_format, json_schema: { ...input.response_format.json_schema, name: 'canary' } } },
  { model: 'fixed-model', maxTokens: 4096 }).messages.length, 3);
  assert.throws(() => validateChatRequest({ ...input, tools: [] }, { model: 'fixed-model', maxTokens: 4096 }), /chat request/);
  assert.throws(() => validateChatRequest({ ...input, model: 'drift' }, { model: 'fixed-model', maxTokens: 4096 }), /chat request/);
  assert.deepEqual(upstreamChatRequest(input, { model: 'fixed-model', maxTokens: 4096 }).response_format, { type: 'json_object' });
  assert.throws(() => validateChatRequest(input, { model: 'fixed-model', chatModel: 'read-model', maxTokens: 4096 }), /chat request/);
  assert.equal(validateChatRequest({ ...input, model: 'read-model' }, { model: 'fixed-model', chatModel: 'read-model', maxTokens: 4096 }).model, 'read-model');
});

test('responses request rejects model drift, unsupported content and unbounded output', () => {
  assert.throws(() => translateRequest({ ...request(), model: 'other' }, { model: 'fixed-model', maxTokens: 4096 }), /model/);
  assert.throws(() => translateRequest({ ...request(), max_output_tokens: 5000 }, { model: 'fixed-model', maxTokens: 4096 }), /token/);
  const image = request(); image.input[0].content = [{ type: 'input_image', image_url: 'https://example.invalid/x' }];
  assert.throws(() => translateRequest(image, { model: 'fixed-model', maxTokens: 4096 }), /content/);
});

test('chat completion maps text and tool calls to minimal Codex Responses SSE events', () => {
  const result = translateResponse({ id: 'chat-secret-id', model: 'fixed-model', choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: 'checking', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
  } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
  assert.equal(result.events.at(-1).type, 'response.completed'); assert.equal(result.events.at(-1).response.usage.total_tokens, 14);
  assert.ok(result.events.some(event => event.item?.type === 'message'));
  assert.ok(result.events.some(event => event.item?.type === 'function_call' && event.item.call_id === 'call_2'));
  assert.ok(!JSON.stringify(result).includes('chat-secret-id'));
});

test('upstream execution pins URL, credential and model without returning provider envelope', async () => {
  let observed;
  const fakeFetch = async (url, options) => { observed = { url, options }; return new Response(JSON.stringify({ id: 'secret', model: 'fixed-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  { status: 200, headers: { 'content-type': 'application/json' } }); };
  const result = await executeUpstream(request(), { baseUrl: 'https://provider.invalid/v1', apiKey: 'private-key', model: 'fixed-model',
    timeoutMs: 1000, maxTokens: 4096, maxResponseBytes: 65536 }, fakeFetch);
  assert.equal(observed.url, 'https://provider.invalid/v1/chat/completions');
  assert.equal(observed.options.headers.authorization, 'Bearer private-key');
  assert.equal(JSON.parse(observed.options.body).model, 'fixed-model');
  assert.ok(!result.body.includes('private-key')); assert.match(result.body, /response\.completed/);
});

test('broker diagnostics expose only fixed categories', () => {
  assert.equal(diagnosticCode(new Error('unsupported responses item')), 'unsupported_item');
  assert.equal(diagnosticCode(new SyntaxError('input fragment must not escape')), 'invalid_json');
  assert.equal(diagnosticCode(new Error('sensitive dynamic failure')), 'internal_error');
});

test('broker health is local-state only and never invokes upstream', async () => {
  const server = createServer({}); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}/health`, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject));
    assert.deepEqual(result, { status: 200, body: '{"status":"ok"}' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('broker bounds sequential admission independently of concurrency', async () => {
  const server = createServer({ maxRequestsPerWindow: 1, requestWindowMs: 60000, fetchImpl: async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } }), model: 'fixed-model', maxTokens: 4096,
  baseUrl: 'https://fixed.invalid/v1', apiKey: 'secret', timeoutMs: 1000, bodyTimeoutMs: 1000, maxResponseBytes: 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = () => new Promise((resolve, reject) => {
    const body = JSON.stringify(request());
    const call = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/responses', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    call.on('error', reject); call.end(body);
  });
  try { assert.equal(await post(), 200); assert.equal(await post(), 429); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('client cancellation is propagated to the fixed upstream request', async () => {
  const input = { model: 'fixed-model', messages: [{ role: 'user', content: 'bounded' }], temperature: 0,
    max_tokens: 16, stream: false, response_format: { type: 'json_schema', json_schema: {
      name: 'harness_result', strict: true, schema: { type: 'object' } } } };
  const client = new AbortController(); let upstreamAborted = false;
  const pending = executeChatUpstream(input, { model: 'fixed-model', maxTokens: 4096, timeoutMs: 5000,
    baseUrl: 'https://fixed.invalid/v1', apiKey: 'secret', maxResponseBytes: 1024 }, (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { upstreamAborted = true; const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    }), client.signal);
  client.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(upstreamAborted, true);
});
