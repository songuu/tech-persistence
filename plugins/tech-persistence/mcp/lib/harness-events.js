'use strict';
const crypto = require('node:crypto');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function projectHarnessEvent(input = {}) {
  if (!input.kind || !input.sourceId || !input.source) throw new Error('kind, sourceId and source are required');
  const sourceHash = sha256(canonical(input.source));
  const identity = { kind: input.kind, sourceId: input.sourceId, sourceHash };
  return Object.freeze({
    version: 'harness-event-v1', id: sha256(canonical(identity)), ...identity,
    observedAt: input.observedAt || new Date(0).toISOString(),
    links: Object.freeze({ ...(input.links || {}) }),
    summary: Object.freeze({ ...(input.summary || {}) }),
  });
}

function projectMany(inputs = []) {
  return inputs.flatMap((input) => {
    try { return [projectHarnessEvent(input)]; } catch { return []; }
  }).sort((a, b) => a.id.localeCompare(b.id));
}
module.exports = { canonical, projectHarnessEvent, projectMany, sha256 };
