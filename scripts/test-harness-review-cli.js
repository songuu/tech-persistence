'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { fixture } = require('./test-harness-runtime-wiring');
const fixtures = require('./test-agent-orchestrator-native-cli');
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'agent-orchestrator.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    child.on('error', reject); child.on('close', status => resolve({ status, output }));
  });
}
async function main() {
  if (process.platform !== 'linux') { console.log('Harness external review CLI: requires Linux descriptor boundary; skipped on this platform'); return; }
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.runtime-review-test-'));
  const prompts = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), prompt = body.messages[0].content; prompts.push(prompt);
    res.end(JSON.stringify({ id: `review-${prompts.length}`, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ decision: 'approved', compliant: true, findings: [], followUpTasks: [], contractRevisions: [] }) } }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(root, `http://127.0.0.1:${server.address().port}`);
    for (const pipeline of [false, true]) {
      const workdir = path.join(f.workdir, pipeline ? 'pipeline' : 'classic'); fs.mkdirSync(workdir);
      fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
      for (const args of [['init'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Harness test'], ['add', 'seed.txt'], ['commit', '-m', 'test: seed']]) {
        const git = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr);
      }
      const claude = path.join(root, `claude-${pipeline}.js`), codex = path.join(root, `codex-${pipeline}.js`);
      fs.writeFileSync(claude, pipeline ? fixtures.pipelineClaudeProviderScript(['git diff --check']) : fixtures.classicClaudeProviderScript());
      fs.writeFileSync(codex, fixtures.validImplementationProviderScript());
      const common = ['--workdir', workdir, '--runs-dir', '.runs', '--control-root', path.join(f.authority, `control-${pipeline}`),
        ...(pipeline ? ['--auto'] : []), '--allow-dirty', '--skip-cli-schema', '--validation-command', 'git diff --check', '--spec-command', `${process.execPath} ${claude}`, '--implementation-command', `${process.execPath} ${codex}`,
        '--external-stages', 'review', '--external-runtime-config', f.configFile, '--capability-router', 'shadow', '--turn-budget-slots', '20'];
      const first = await run(['run', '--run-id', 'review-flow', '--requirement', 'review bounded evidence', ...(pipeline ? ['--pipeline'] : []), ...common]);
      assert.equal(first.status, 0, first.output);
      if (!pipeline) {
        const frozen = await run(['freeze', '--run', 'review-flow', ...common]); assert.equal(frozen.status, 0, frozen.output);
      }
      const stateFile = path.join(workdir, '.runs', 'review-flow', 'state.json');
      let state = JSON.parse(fs.readFileSync(stateFile));
      for (let i = 0; i < 6 && state.status !== 'completed'; i++) {
        const next = await run(['resume', '--run', 'review-flow', ...common]); assert.equal(next.status, 0, next.output); state = JSON.parse(fs.readFileSync(stateFile));
      }
      assert.equal(state.status, 'completed');
      const reviewRuns = state.providerRuns.filter(record => record.runtime === 'openai-compatible');
      assert.equal(reviewRuns.length, pipeline ? 2 : 1); assert.ok(reviewRuns.every(record => record.acceptance.accepted));
    }
    assert.equal(prompts.length, 3);
    for (const prompt of prompts) {
      assert.match(prompt, /Current review evidence \([^\n]*diff\.patch, sha256:/);
      assert.match(prompt, /Current review evidence \([^\n]*handoff\.json, sha256:/);
      assert.match(prompt, /Current review evidence \([^\n]*validation\.json, sha256:/);
    }
    console.log('Harness external review: classic/slice/integration CLI dispatch + current artifacts + accepted results passed');
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
