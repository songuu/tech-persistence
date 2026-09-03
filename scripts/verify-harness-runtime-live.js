'use strict';
// Operator-invoked, append-only live proof. This never enables a public model endpoint.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runCanary } = require('./agent-orchestrator/native-runtime-canary');
const { promotionDecision } = require('./agent-orchestrator/external-runtime-governance');
const { protectedPath } = require('./agent-orchestrator/external-runtime-config');
const { privateDirectory, durableCreate } = require('./lib/runtime-transcript-spool');
const { runWorker } = require('./lib/runtime-transcript-worker');
const { openTranscriptPostgres } = require('./lib/codex-transcript-postgres');
const { loadEnvFile } = require('./sync-codex-transcripts');
function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }
function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'agent-orchestrator.js'), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    child.on('error', reject); child.on('close', status => resolve({ status, output }));
  });
}
async function main() {
  if (!process.argv.includes('--execute-live')) throw new Error('explicit --execute-live is required');
  const evidence = path.resolve(argument('--evidence-root')), spoolRoot = path.resolve(argument('--outbox')),
    workdir = path.resolve(argument('--workdir')), envFile = path.resolve(argument('--env-file'));
  privateDirectory(evidence); privateDirectory(spoolRoot); protectedPath(evidence, workdir, true); protectedPath(envFile, workdir);
  const canaryFile = path.join(evidence, 'canary.json'), promotionFile = path.join(evidence, 'promotion.json'), configFile = path.join(evidence, 'config.json');
  const baseUrl = argument('--base-url'), model = argument('--model');
  const canary = await runCanary({ baseUrl, model, repoProbe: __filename, environment: {} }); durableCreate(canaryFile, canary);
  const promotion = promotionDecision({ descriptorId: 'openai-compatible-chat-v1', registered: true, observedCapability: true, explicitPromotion: true, environmentKeys: [], canary });
  durableCreate(promotionFile, promotion);
  if (!promotion.eligible) throw new Error('live canary did not authorize promotion');
  durableCreate(configFile, { version: 'external-runtime-config-v1', descriptorId: promotion.descriptorId, baseUrl, model,
    canaryFile, promotionFile, spoolRoot, timeoutMs: 120000, maxTokens: Number(argument('--max-tokens') || 1024), contextFiles: [] });
  const runs = path.join(evidence, 'runs');
  const processResult = await run(['run', '--spec-only', '--run-id', 'live-main', '--workdir', workdir, '--runs-dir', runs,
    '--control-root', path.join(evidence, 'control'), '--skip-git-repo-check', '--capability-router', 'enforce',
    '--external-stages', 'spec', '--external-runtime-config', configFile,
    '--requirement', 'Plan exactly one L1 task to read README.md. Do not change files. Be concise. Use short nonempty strings and empty optional arrays.'], workdir);
  // CLI logs remain in the protected run directory; the proof contains no model output.
  loadEnvFile(envFile, process.env);
  const db = await openTranscriptPostgres({ env: process.env });
  let worker;
  try { worker = await runWorker({ root: spoolRoot, writer: db.writer, reader: db.reader }); }
  finally { await db.close(); }
  const state = JSON.parse(fs.readFileSync(path.join(runs, 'live-main', 'state.json'), 'utf8'));
  const proof = { version: 'harness-transcript-live-proof-v1', verifiedAt: new Date().toISOString(),
    canaryReceiptHash: canary.receiptHash, promotionReceiptHash: promotion.receiptHash,
    cliExitCode: processResult.status, harnessStatus: state.status, worker,
    externalRuns: (state.providerRuns || []).map(record => ({ runtime: record.runtime, taskHash: record.taskEnvelopeHash,
      routeHash: record.routeDecisionHash, resultHash: record.resultEnvelopeHash || null,
      accepted: record.acceptance?.accepted === true, transcript: record.transcript })) };
  durableCreate(path.join(evidence, 'live-proof.json'), proof);
  process.stdout.write(`${JSON.stringify(proof)}\n`);
  if (processResult.status !== 0 || state.status !== 'spec-ready' || !proof.externalRuns.some(record => record.accepted)
      || worker.failed || !worker.acknowledged) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { process.stderr.write(`live proof failed: ${error.message}\n`); process.exitCode = 1; });
