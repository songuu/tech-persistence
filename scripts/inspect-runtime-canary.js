'use strict';
const fs = require('node:fs');
const path = require('node:path');

if (process.argv.length !== 3) throw new Error('expected one canary receipt path');
const file = path.resolve(process.argv[2]);
if (process.platform === 'linux' && !file.startsWith('/var/lib/tech-persistence/authority/')) throw new Error('invalid canary path');
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
process.stdout.write(`${JSON.stringify({ status: receipt.status, cases: Array.isArray(receipt.cases)
  ? receipt.cases.map(item => ({ id: item.id, status: item.status })) : [] })}\n`);
