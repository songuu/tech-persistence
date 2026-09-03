'use strict';
const fs = require('node:fs');
if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 3) throw new Error('root and one output path required');
const baseUrl = process.env.OPENAI_BASE_URL; const apiKey = process.env.OPENAI_API_KEY; const current = process.env.OPENAI_MODEL;
if (![baseUrl, apiKey, current].every(value => typeof value === 'string' && value && !/[\r\n\0]/.test(value))) throw new Error('model source is invalid');
const family = id => /qwen/i.test(id) ? 'qwen' : /deepseek/i.test(id) ? 'deepseek-chat' : 'other';
const score = id => /qwen.*turbo/i.test(id) ? 0 : /qwen.*plus/i.test(id) ? 1 : /qwen3.*30b.*instruct/i.test(id) ? 2
  : /qwen3.*14b.*instruct/i.test(id) ? 3 : /deepseek.*v3/i.test(id) ? 4 : /deepseek.*chat/i.test(id) ? 5 : /qwen.*instruct/i.test(id) ? 6 : 99;
async function probe(model) {
  const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model,
        messages: [{ role: 'user', content: 'Return only this JSON object: {"ok":true}' }], temperature: 0, max_tokens: 64,
        stream: false, response_format: { type: 'json_object' } }) });
    const raw = await response.text(); let valid = false;
    if (response.ok) { try { valid = JSON.parse(JSON.parse(raw).choices[0].message.content).ok === true; } catch {} }
    return { model, family: family(model), ok: response.ok && valid, elapsedMs: Date.now() - started };
  } catch (error) { return { model, family: family(model), ok: false, elapsedMs: Date.now() - started,
    errorClass: error.name === 'AbortError' ? 'timeout' : 'transport' }; }
  finally { clearTimeout(timer); }
}
(async () => {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error('model inventory failed');
  const inventory = await response.json(); const ids = (inventory.data || []).map(value => String(value.id || '')).filter(Boolean)
    .filter(id => !/(reason|\br1\b|embed|vision|audio|image|vl\b)/i.test(id)).sort((a, b) => score(a) - score(b));
  const candidates = [...new Set([current, ...ids.filter(id => score(id) < 99)])].slice(0, 5);
  const results = [];
  for (const model of candidates) results.push(await probe(model));
  const successful = results.filter(value => value.ok).sort((a, b) => a.elapsedMs - b.elapsedMs);
  if (!successful.length) throw new Error('no bounded read model passed');
  fs.writeFileSync(process.argv[2], `${successful[0].model}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ selectedFamily: successful[0].family,
    probes: results.map(({ model, ...value }, index) => ({ index, ...value })) })}\n`);
})().catch(error => { process.stderr.write(`read model selection failed: ${error.message}\n`); process.exitCode = 1; });
