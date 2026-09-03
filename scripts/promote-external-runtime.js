'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promotionDecision } = require('./agent-orchestrator/external-runtime-governance');

function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
try {
  const canaryFile = path.resolve(argument('--canary'));
  const output = path.resolve(argument('--output'));
  const receipt = promotionDecision({ descriptorId: argument('--descriptor'), registered: true,
    observedCapability: true, explicitPromotion: process.argv.includes('--explicit-promotion'),
    environmentKeys: String(argument('--environment-keys') || '').split(',').filter(Boolean),
    canary: JSON.parse(fs.readFileSync(canaryFile, 'utf8')) });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ route: receipt.route, eligible: receipt.eligible, receiptHash: receipt.receiptHash })}\n`);
  if (!receipt.eligible) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
