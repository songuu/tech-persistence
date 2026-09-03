'use strict';

const crypto = require('node:crypto');

const REGISTRY_MODE = 'checked-in-v1';
const ADAPTERS = Object.freeze({
  'openai-compatible-chat': Object.freeze({ id: 'openai-compatible-chat', runtime: 'openai-compatible', mode: 'chat', maturity: 'experimental' }),
  'claude-print': Object.freeze({ id: 'claude-print', runtime: 'claude', mode: 'print', maturity: 'stable' }),
  'claude-bare': Object.freeze({ id: 'claude-bare', runtime: 'claude', mode: 'bare', maturity: 'stable' }),
  'codex-exec': Object.freeze({ id: 'codex-exec', runtime: 'codex', mode: 'exec', maturity: 'stable' }),
  'codex-app-server': Object.freeze({ id: 'codex-app-server', runtime: 'codex', mode: 'app-server', maturity: 'experimental' }),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function registryHash() {
  return crypto.createHash('sha256').update(canonical({ mode: REGISTRY_MODE, adapters: ADAPTERS })).digest('hex');
}

function descriptor(adapterId) {
  const value = ADAPTERS[adapterId];
  if (!value) throw new Error(`Unknown provider adapter: ${adapterId}`);
  return value;
}

function adapterId(runtime, mode) {
  const candidate = `${runtime}-${mode}`;
  descriptor(candidate);
  return candidate;
}

module.exports = { ADAPTERS, REGISTRY_MODE, adapterId, descriptor, registryHash };
