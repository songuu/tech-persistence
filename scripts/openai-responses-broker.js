'use strict';
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const RESPONSES_KEYS = ['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'max_output_tokens',
  'previous_response_id', 'reasoning', 'text', 'store', 'include', 'prompt_cache_key', 'client_metadata'];

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`invalid ${label}`);
  }
}
function boundedText(value, maximum, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || value.includes('\0')) throw new Error(`invalid ${label}`);
  return value;
}
function messageContent(content) {
  if (typeof content === 'string') return boundedText(content, 256 * 1024, 'message content');
  if (!Array.isArray(content) || content.length > 64) throw new Error('unsupported message content');
  return content.map(part => {
    exactKeys(part, ['type', 'text'], 'message content');
    if (!['input_text', 'output_text'].includes(part.type)) throw new Error('unsupported message content');
    return boundedText(part.text, 256 * 1024, 'message content');
  }).join('');
}
function translateRequest(input, config) {
  exactKeys(input, RESPONSES_KEYS, 'responses request');
  if (input.client_metadata !== undefined && (!input.client_metadata || typeof input.client_metadata !== 'object'
      || Array.isArray(input.client_metadata) || Buffer.byteLength(JSON.stringify(input.client_metadata)) > 8192)) {
    throw new Error('invalid client metadata');
  }
  if (input.model !== config.model) throw new Error('responses model differs from fixed model');
  if (input.stream !== true || !Array.isArray(input.input) || input.input.length > 256) throw new Error('invalid responses input');
  const maxTokens = input.max_output_tokens ?? config.maxTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > config.maxTokens) throw new Error('invalid responses token limit');
  const messages = [];
  if (input.instructions !== undefined) messages.push({ role: 'system', content: boundedText(input.instructions, 128 * 1024, 'instructions') });
  for (const item of input.input) {
    exactKeys(item, ['type', 'role', 'content', 'id', 'status', 'call_id', 'name', 'arguments', 'output'], 'responses item');
    if (item.type === 'message') {
      if (!['user', 'assistant', 'developer', 'system'].includes(item.role)) throw new Error('unsupported message role');
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: messageContent(item.content) });
    } else if (item.type === 'function_call') {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: boundedText(item.call_id, 200, 'call id'), type: 'function',
        function: { name: boundedText(item.name, 128, 'tool name'), arguments: boundedText(item.arguments, 128 * 1024, 'tool arguments') } }] });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: boundedText(item.call_id, 200, 'call id'), content: boundedText(item.output, 256 * 1024, 'tool output') });
    } else if (item.type !== 'reasoning') throw new Error('unsupported responses item');
  }
  const tools = [];
  const addFunction = (tool, namespace = null) => {
    exactKeys(tool, namespace ? ['type', 'name', 'description', 'parameters', 'strict', 'defer_loading']
      : ['type', 'name', 'description', 'parameters', 'strict'], 'responses tool');
    if (tool.type !== 'function' || !tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) {
      throw new Error('unsupported responses tool');
    }
    if (tool.defer_loading === true) return;
    const localName = boundedText(tool.name, 128, 'tool name');
    const name = namespace ? `${namespace.name}__${localName}` : localName;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error('invalid tool name');
    const description = namespace ? `${namespace.description}\n${tool.description || ''}` : (tool.description || '');
    tools.push({ type: 'function', function: { name, description: boundedText(description, 32 * 1024, 'tool description'),
      parameters: tool.parameters, strict: tool.strict === true } });
  };
  for (const tool of input.tools || []) {
    if (tool?.type === 'function') addFunction(tool);
    else if (tool?.type === 'namespace') {
      exactKeys(tool, ['type', 'name', 'description', 'tools'], 'responses namespace');
      const namespace = { name: boundedText(tool.name, 64, 'namespace name'),
        description: boundedText(tool.description || '', 1024, 'namespace description') };
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace.name) || !Array.isArray(tool.tools) || tool.tools.length > 64) {
        throw new Error('unsupported responses namespace');
      }
      for (const child of tool.tools) addFunction(child, namespace);
    } else if (tool?.type === 'web_search') {
      exactKeys(tool, ['type', 'external_web_access'], 'responses web search');
      if (tool.external_web_access !== undefined && typeof tool.external_web_access !== 'boolean') throw new Error('unsupported web search');
    } else throw new Error('unsupported responses tool');
  }
  if (tools.length > 64 || Buffer.byteLength(JSON.stringify({ messages, tools })) > 768 * 1024) throw new Error('responses request exceeds limit');
  let toolChoice = input.tool_choice || 'auto';
  if (toolChoice && typeof toolChoice === 'object') {
    exactKeys(toolChoice, ['type', 'name'], 'tool choice');
    if (toolChoice.type !== 'function') throw new Error('unsupported tool choice');
    toolChoice = { type: 'function', function: { name: boundedText(toolChoice.name, 128, 'tool name') } };
  } else if (!['auto', 'none', 'required'].includes(toolChoice)) throw new Error('unsupported tool choice');
  return { model: config.model, messages, tools, tool_choice: toolChoice, parallel_tool_calls: input.parallel_tool_calls !== false,
    temperature: 0, max_tokens: maxTokens, stream: false };
}
function translateResponse(envelope) {
  const choice = envelope?.choices?.[0]; const message = choice?.message;
  if (!message || envelope.choices.length !== 1 || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('invalid chat terminal response');
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`; const events = [{ type: 'response.created', response: { id: responseId } }];
  let outputIndex = 0;
  if (typeof message.content === 'string' && message.content) events.push({ type: 'response.output_item.done', output_index: outputIndex++,
    item: { type: 'message', role: 'assistant', id: `msg_${crypto.randomUUID().replace(/-/g, '')}`, status: 'completed',
      content: [{ type: 'output_text', text: message.content, annotations: [] }] } });
  for (const tool of message.tool_calls || []) {
    if (tool.type !== 'function' || typeof tool.id !== 'string' || typeof tool.function?.name !== 'string' || typeof tool.function?.arguments !== 'string') {
      throw new Error('invalid chat tool call');
    }
    events.push({ type: 'response.output_item.done', output_index: outputIndex++, item: { type: 'function_call',
      id: `fc_${crypto.randomUUID().replace(/-/g, '')}`, call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments, status: 'completed' } });
  }
  const usage = envelope.usage || {};
  events.push({ type: 'response.completed', response: { id: responseId, status: 'completed', output: [], usage: {
    input_tokens: Number(usage.prompt_tokens) || 0, input_tokens_details: null, output_tokens: Number(usage.completion_tokens) || 0,
    output_tokens_details: null, total_tokens: Number(usage.total_tokens) || 0 } } });
  return { events };
}
function sse(events) { return `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n')}\n`; }
function validateChatRequest(input, config) {
  exactKeys(input, ['model', 'messages', 'temperature', 'max_tokens', 'stream', 'response_format'], 'chat request');
  if (input.model !== (config.chatModel || config.model) || input.temperature !== 0 || (input.stream !== undefined && input.stream !== false)
      || !Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > config.maxTokens
      || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 8) throw new Error('invalid chat request');
  for (const message of input.messages) {
    exactKeys(message, ['role', 'content'], 'chat message');
    if (!['user', 'assistant'].includes(message.role)) throw new Error('invalid chat message');
    boundedText(message.content, 192 * 1024, 'chat content');
  }
  exactKeys(input.response_format, ['type', 'json_schema'], 'chat response format');
  exactKeys(input.response_format.json_schema, ['name', 'strict', 'schema'], 'chat JSON schema');
  if (input.response_format.type !== 'json_schema' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.response_format.json_schema.name)
      || input.response_format.json_schema.strict !== true || !input.response_format.json_schema.schema
      || typeof input.response_format.json_schema.schema !== 'object' || Array.isArray(input.response_format.json_schema.schema)
      || Buffer.byteLength(JSON.stringify(input)) > 768 * 1024) throw new Error('invalid chat response format');
  return input;
}
function upstreamChatRequest(input, config) {
  const validated = validateChatRequest(input, config);
  return { ...validated, response_format: { type: 'json_object' } };
}
async function fetchChat(body, config, fetchImpl = fetch, externalSignal = null) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('upstream rejected request');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > config.maxResponseBytes) throw new Error('upstream response exceeds limit'); chunks.push(chunk); }
    const raw = Buffer.concat(chunks).toString('utf8');
    return { raw, envelope: JSON.parse(raw) };
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); }
}
async function executeUpstream(input, config, fetchImpl = fetch, signal = null) {
  const result = await fetchChat(translateRequest(input, config), config, fetchImpl, signal);
  return { status: 200, body: sse(translateResponse(result.envelope).events) };
}
async function executeChatUpstream(input, config, fetchImpl = fetch, signal = null) {
  const result = await fetchChat(upstreamChatRequest(input, config), config, fetchImpl, signal);
  return { status: 200, body: result.raw };
}
function loadConfig(env = process.env) {
  const allowed = ['TP_BROKER_SOCKET', 'TP_UPSTREAM_BASE_URL', 'TP_UPSTREAM_MODEL', 'TP_UPSTREAM_API_KEY'];
  if (allowed.some(key => !env[key])) throw new Error('broker configuration is incomplete');
  const base = new URL(env.TP_UPSTREAM_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('invalid upstream URL');
  if (!env.TP_BROKER_SOCKET.startsWith('/run/tech-persistence-provider-broker/')) throw new Error('invalid broker socket path');
  return { socketPath: env.TP_BROKER_SOCKET, baseUrl: base.href.replace(/\/$/, ''), model: boundedText(env.TP_UPSTREAM_MODEL, 200, 'model'),
    chatModel: boundedText(env.TP_UPSTREAM_CHAT_MODEL || env.TP_UPSTREAM_MODEL, 200, 'chat model'),
    apiKey: env.TP_UPSTREAM_API_KEY, timeoutMs: 240000, bodyTimeoutMs: 10000, maxTokens: 4096,
    maxResponseBytes: 512 * 1024, requestWindowMs: 10 * 60 * 1000, maxRequestsPerWindow: 120 };
}
function diagnosticCode(error) {
  const message = error instanceof Error ? error.message : '';
  const exact = new Map([
    ['invalid responses request', 'invalid_request_shape'], ['responses model differs from fixed model', 'model_drift'],
    ['invalid responses input', 'invalid_input'], ['invalid responses token limit', 'invalid_token_limit'],
    ['unsupported message content', 'unsupported_message_content'], ['unsupported message role', 'unsupported_message_role'],
    ['unsupported responses item', 'unsupported_item'], ['unsupported responses tool', 'unsupported_tool'],
    ['unsupported tool choice', 'unsupported_tool_choice'], ['responses request exceeds limit', 'request_limit'],
    ['invalid instructions', 'invalid_instructions'], ['invalid message content', 'invalid_message_content'],
    ['invalid responses item', 'invalid_item_shape'], ['invalid responses tool', 'invalid_tool_shape'],
    ['invalid tool choice', 'invalid_tool_choice_shape'],
    ['invalid call id', 'invalid_call_id'], ['invalid tool arguments', 'invalid_tool_arguments'],
    ['invalid tool output', 'invalid_tool_output'], ['invalid tool name', 'invalid_tool_name'],
    ['invalid tool description', 'invalid_tool_description'], ['invalid client metadata', 'invalid_client_metadata'],
    ['upstream rejected request', 'upstream_rejected'], ['upstream response exceeds limit', 'upstream_response_limit'],
    ['invalid chat terminal response', 'invalid_upstream_terminal'], ['invalid chat tool call', 'invalid_upstream_tool']
  ]);
  if (exact.has(message)) return exact.get(message);
  if (message.startsWith('invalid ')) return 'invalid_bounded_field';
  if (error?.name === 'AbortError') return 'upstream_timeout';
  if (error instanceof SyntaxError) return 'invalid_json';
  return 'internal_error';
}
function createServer(config) {
  let active = null;
  let waiting = false;
  let requestTimes = [];
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      config.onAccess?.('health');
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"status":"ok"}');
      return;
    }
    if (active) {
      if (waiting) { response.writeHead(429).end(); return; }
      waiting = true;
      try {
        for (let count = 0; count < 20 && active; count += 1) await new Promise(resolve => setTimeout(resolve, 5));
      } finally { waiting = false; }
      if (active) { response.writeHead(429).end(); return; }
    }
    const route = request.url === '/v1/responses' ? 'responses' : request.url === '/v1/chat/completions' ? 'chat' : null;
    if (request.method !== 'POST' || !route || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
      response.writeHead(404).end(); return;
    }
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > 1024 * 1024)) {
      response.writeHead(413).end(); return;
    }
    const now = Date.now();
    const requestWindowMs = config.requestWindowMs || 10 * 60 * 1000;
    const maxRequestsPerWindow = config.maxRequestsPerWindow || 120;
    requestTimes = requestTimes.filter(value => now - value < requestWindowMs);
    if (requestTimes.length >= maxRequestsPerWindow) { response.writeHead(429).end(); return; }
    requestTimes.push(now);
    const token = { controller: new AbortController() };
    active = token;
    const abandon = () => {
      if (response.writableEnded || active !== token) return;
      active = null;
      token.controller.abort();
    };
    request.once('aborted', abandon);
    response.once('close', abandon);
    let input;
    const bodyTimer = setTimeout(() => request.destroy(new Error('request body timeout')), config.bodyTimeoutMs || 10000);
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('request exceeds limit'); chunks.push(chunk); }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const fetchImpl = config.fetchImpl || fetch;
      const result = route === 'responses' ? await executeUpstream(input, config, fetchImpl, token.controller.signal)
        : await executeChatUpstream(input, config, fetchImpl, token.controller.signal);
      response.writeHead(result.status, { 'content-type': route === 'responses' ? 'text/event-stream' : 'application/json',
        'cache-control': 'no-store' }).end(result.body);
    } catch (error) {
      const code = diagnosticCode(error);
      const unknownKeys = code === 'invalid_request_shape' && input && typeof input === 'object' && !Array.isArray(input)
        ? Object.keys(input).filter(key => !RESPONSES_KEYS.includes(key) && /^[a-z_]{1,64}$/.test(key)).sort() : [];
      const toolShapes = code === 'invalid_tool_shape' && Array.isArray(input?.tools) ? input.tools.slice(0, 64).map(tool => ({
        type: typeof tool?.type === 'string' && /^[a-z_]{1,64}$/.test(tool.type) ? tool.type : 'invalid',
        keys: tool && typeof tool === 'object' && !Array.isArray(tool)
          ? Object.keys(tool).filter(key => /^[a-z_]{1,64}$/.test(key)).sort() : []
      })) : [];
      config.onDiagnostic?.(code, { unknownKeys, toolShapes });
      if (!response.destroyed && !response.writableEnded) response.writeHead(502, { 'content-type': 'application/json',
        'cache-control': 'no-store' }).end('{"error":{"message":"provider unavailable"}}');
    }
    finally {
      clearTimeout(bodyTimer);
      request.removeListener('aborted', abandon); response.removeListener('close', abandon);
      if (active === token) active = null;
    }
  });
}
async function main() {
  if (process.platform !== 'linux' || process.argv.length !== 2) throw new Error('broker is a fixed Linux service');
  const config = { ...loadConfig(), onAccess: route => process.stderr.write(`broker access: ${route}\n`),
    onDiagnostic: (code, details) => process.stderr.write(
    `broker request failed: ${code}${details.unknownKeys.length ? ` unknown_keys=${details.unknownKeys.join(',')}` : ''}`
    + `${details.toolShapes.length ? ` tool_shapes=${JSON.stringify(details.toolShapes)}` : ''}\n`) };
  if (fs.existsSync(config.socketPath)) throw new Error('broker socket already exists');
  const server = createServer(config);
  server.on('clientError', () => process.stderr.write('broker request failed: client_error\n'));
  server.listen(config.socketPath, () => fs.chmodSync(config.socketPath, 0o660));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close();
    server.closeAllConnections?.();
  });
}
if (require.main === module) main().catch(error => { process.stderr.write(`provider broker failed: ${error.message}\n`); process.exitCode = 1; });
module.exports = { translateRequest, translateResponse, validateChatRequest, upstreamChatRequest, executeUpstream, executeChatUpstream,
  loadConfig, diagnosticCode, createServer, sse, main };
