'use strict';

// Fixed child transport: no tools, filesystem access, environment credentials or redirects.
const { validateEndpoint, sha256 } = require('./agent-orchestrator/external-runtime-config');
const { requestText } = require('./lib/loopback-http');
function parseJson(value) { try { return JSON.parse(value); } catch { throw new Error('external response is invalid JSON'); } }
async function execute(input) {
  const baseUrl = validateEndpoint(input.baseUrl);
  if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > 192 * 1024) throw new Error('external prompt exceeds bounded context');
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 300000
      || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 4096) throw new Error('invalid transport resource limits');
  if (!input.schema || typeof input.schema !== 'object' || Array.isArray(input.schema)) throw new Error('invalid transport schema');
  const schemaInstruction = `\nReturn only JSON matching exactly this JSON Schema:\n${JSON.stringify(input.schema)}`;
  const fullPrompt = `${input.prompt}${schemaInstruction}`;
  if (Buffer.byteLength(fullPrompt) > 192 * 1024) throw new Error('external prompt and schema exceed bounded context');
  const body = { model: input.model, messages: [{ role: 'user', content: fullPrompt }],
      temperature: 0, max_tokens: input.maxTokens, stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'harness_result', strict: true, schema: input.schema } } };
    const response = await requestText(`${baseUrl}/v1/chat/completions`, { method: 'POST', socketPath: input.socketPath,
      timeoutMs: input.timeoutMs,
      maxBytes: 512 * 1024, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`external HTTP status ${response.status}`);
    const raw = response.text;
    const envelope = parseJson(raw);
    const choice = envelope.choices?.[0];
    if (typeof envelope.id !== 'string' || !envelope.id || envelope.choices?.length !== 1
        || choice.finish_reason !== 'stop' || choice.message?.role !== 'assistant'
        || choice.message.tool_calls || choice.message.function_call || choice.message.refusal
        || typeof choice.message.content !== 'string') throw new Error('external terminal response is not a completed text-only result');
    const payload = parseJson(choice.message.content);
    return { runtime: 'openai-compatible', adapter: 'openai-compatible-chat', status: 'succeeded', nativeAccepted: true,
      nativeAcceptanceErrors: [], terminalEvidence: { observed: true, event: 'chat.completion', status: 'stop' },
      runtimeRefs: { sessionId: input.sessionId, requestId: input.requestId, completionId: sha256(envelope.id) },
      payload, requestHash: sha256(JSON.stringify(body)), responseHash: sha256(raw) };
}
async function main() {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 512 * 1024) throw new Error('transport input too large'); }
  process.stdout.write(`${JSON.stringify(await execute(JSON.parse(raw)))}\n`);
}
if (require.main === module) main().catch((error) => { process.stderr.write(`external transport failed: ${error.name === 'AbortError' ? 'timeout' : error.message}\n`); process.exitCode = 1; });
module.exports = { execute };
