'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { fixture } = require('./test-harness-runtime-wiring');
const { runWorker } = require('./lib/runtime-transcript-worker');
const adapter = require('./lib/transcript-source-adapters').sourceAdapter('harness-events-jsonl-v1');
const spec = { requirementSpec: { summary: 'read only integration', userValue: 'verified routing', scope: ['read'], acceptanceCriteria: ['route is accepted'] },
  acceptanceContract: { criteria: [{ id: 'ac-route', statement: 'route is accepted',
    sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
    oracle: { type: 'command', procedure: 'node --version', expected: 'exit code is zero' } }] },
  technicalDesign: { approach: 'no writes', files: [], risks: [], testStrategy: 'integration' },
  taskBreakdown: [{ id: 'T1', title: 'read', description: 'inspect context', dependencies: [], risk: 'L1', criterionIds: ['ac-route'], doneCriteria: ['done'] }],
  assumptions: [], outOfScope: [], humanReviewChecklist: [] };
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'agent-orchestrator.js'), ...args], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
async function main() {
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.runtime-cli-test-'));
  let mode = 'ok', calls = 0;
  const server = http.createServer(async (req, res) => {
    calls++; let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); assert.equal(input.stream, false); assert.equal(input.model, 'test-model');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `chat-${calls}`, choices: [{ finish_reason: mode === 'ok' ? 'stop' : 'length', message: { role: 'assistant', content: JSON.stringify(spec) } }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(root, `http://127.0.0.1:${server.address().port}`);
    const git = spawnSync('git', ['init', '--quiet', f.workdir], { encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    const runs = path.join(root, 'runs');
    const args = ['--workdir', f.workdir, '--runs-dir', runs, '--control-root', path.join(f.authority, 'control'),
      '--skip-git-repo-check', '--external-stages', 'spec', '--external-runtime-config', f.configFile, '--capability-router', 'enforce',
      '--validation-command', 'node --version'];
    const result = await run(['run', '--spec-only', '--run-id', 'main-flow', '--requirement', 'Plan a read-only context review', ...args]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(runs, 'main-flow', 'state.json')));
    assert.equal(state.status, 'spec-ready'); assert.equal(state.providerRuns[0].acceptance.accepted, true);
    assert.equal(state.providerRuns[0].runtime, 'openai-compatible'); assert.equal(state.providerRuns[0].transcript.status, 'queued');
    const plan = JSON.parse(fs.readFileSync(path.join(runs, 'main-flow', 'execution-plan.json')));
    assert.equal(plan.stages.spec.routeDecision.primary.runtime, 'openai-compatible');
    assert.equal(plan.stages.implementation.profile.runtime, 'codex');
    const file = path.join(f.spoolRoot, 'sources', fs.readdirSync(path.join(f.spoolRoot, 'sources'))[0]);
    const snapshot = await adapter.stream(file); assert.equal(snapshot.eventCount, 2);
    const fail = await runWorker({ root: f.spoolRoot, sync: async () => { throw new Error('DB offline'); } });
    assert.ok(fail.failed > 0); assert.equal(fs.readdirSync(path.join(f.spoolRoot, 'acks')).length, 0);
    const ok = await runWorker({ root: f.spoolRoot, sync: async ({ job }) => ({ verified: true, jobHash: job.jobHash, transcriptId: `openai-compatible:${job.sessionId}` }) });
    assert.equal(ok.failed, 0); assert.ok(ok.acknowledged > 0);
    assert.equal((await runWorker({ root: f.spoolRoot, sync: async () => { throw new Error('must not retry acknowledged jobs'); } })).attempted, 0);
    mode = 'bad';
    const failed = await run(['run', '--spec-only', '--run-id', 'failed-flow', '--requirement', 'Plan a read-only context review', ...args]);
    assert.equal(failed.status, 1); assert.equal(calls, 2);
    const all = [];
    for (const source of fs.readdirSync(path.join(f.spoolRoot, 'sources'))) await adapter.stream(path.join(f.spoolRoot, 'sources', source), { onEvents: events => all.push(...events) });
    assert.equal(all.length, 4); assert.equal(all.filter(event => event.outerType === 'error').length, 1);
    console.log('Harness main CLI: real dispatch/result/automatic transcript/retry/failure integration passed');
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
