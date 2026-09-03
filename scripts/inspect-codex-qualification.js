'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = '/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t';
if (process.platform !== 'linux' || process.argv.length !== 3) throw new Error('expected one Linux evidence directory');
const evidence = path.resolve(process.argv[2]);
if (path.dirname(evidence) !== root || !path.basename(evidence).startsWith('native-writer-evidence.')) throw new Error('invalid evidence directory');
const events = fs.readFileSync(path.join(evidence, 'codex.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const counts = {};
const itemCounts = {};
for (const event of events) {
  counts[event.type || 'missing'] = (counts[event.type || 'missing'] || 0) + 1;
  if (event.item && typeof event.item.type === 'string' && /^[a-z_]{1,64}$/.test(event.item.type)) {
    itemCounts[event.item.type] = (itemCounts[event.item.type] || 0) + 1;
  }
}
const error = [...events].reverse().find(event => event.type === 'error' || event.type === 'turn.failed');
const errorText = JSON.stringify(error || {});
const stderr = fs.readFileSync(path.join(evidence, 'codex.stderr'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const diagnostic = `${errorText}\n${stderr.toString('utf8')}`.toLowerCase();
const classes = ['connection', 'permission', 'authentication', 'model', 'tool', 'response', 'stream', 'decode', 'timeout', 'unsupported']
  .filter(value => diagnostic.includes(value));
process.stdout.write(`${JSON.stringify({ counts, itemCounts, errorKeys: Object.keys(error || {}).sort(), classes,
  errorBytes: Buffer.byteLength(errorText), errorHash: hash(errorText), stderrBytes: stderr.length, stderrHash: hash(stderr) })}\n`);
