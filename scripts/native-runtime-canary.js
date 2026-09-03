'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runCanary } = require('./agent-orchestrator/native-runtime-canary');

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

(async () => {
  const output = path.resolve(value('--output') || 'runtime-canary-receipt.json');
  const receipt = await runCanary({ baseUrl: value('--base-url'), model: value('--model'), repoProbe: value('--repo-probe'), environment: process.env });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: receipt.status, receiptHash: receipt.receiptHash, output })}\n`);
  if (receipt.status !== 'passed') process.exitCode = 1;
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
