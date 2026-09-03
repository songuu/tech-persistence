'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { runClaim } = require('./harness-task-worker');

if (process.platform !== 'linux' || process.argv.length !== 2 || process.getuid() !== 987) throw new Error('qualification requires tp-authority');
const taskId = crypto.randomUUID(); const claimToken = crypto.randomUUID(); const ownerId = crypto.randomUUID();
const spoolRoot = '/var/lib/tech-persistence/task-runtime/transcript-spool';
const before = new Set(fs.readdirSync(spoolRoot));
process.env.TP_HARNESS_PRIVATE_DIAGNOSTICS = '1';
const config = { version: 'harness-task-worker-v1', workerId: 'qualification-1',
  sandboxRoot: '/var/lib/tech-persistence/task-sandboxes',
  runtimeRoot: '/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3',
  externalRuntimeConfigPath: '/var/lib/tech-persistence/task-runtime/external-runtime.json',
  runtimeCapabilityEvidencePath: '/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.json',
  codexCommandPath: '/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3/scripts/codex-task-provider.sh',
  launcherPath: '/usr/local/libexec/tech-persistence/provider-identity-launcher', gitPath: '/usr/bin/git',
  gitConfigPath: '/var/lib/tech-persistence/task-runtime/qualification-git.config', duPath: '/usr/bin/du', mkdirPath: '/usr/bin/mkdir', chmodPath: '/usr/bin/chmod',
  nodePath: '/usr/bin/node', orchestratorPath: '/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3/scripts/agent-orchestrator.js',
  providerUid: 986, providerGid: 986, heartbeatMs: 1000, maxLogBytes: 4 * 1024 * 1024,
  maxWorkspaceBytes: 64 * 1024 * 1024, minimumFreeBytes: 16 * 1024 * 1024, idleMs: 1000,
  projects: { 'qualification-project': { sourceRoot: '/var/lib/tech-persistence/qualification-projects/full-harness-20260902',
    timeoutMs: 20 * 60 * 1000, validationCommands: ['node test.js'] } } };
const events = [];
const store = { heartbeat: async () => ({ owned: true, cancel: false }), start: async () => { events.push('start'); return true; },
  finish: async value => { events.push(value); return true; }, failBeforeDispatch: async value => { events.push(value); return true; },
  releaseBeforeDispatch: async () => true };

(async () => {
  const result = await runClaim(store, config, { taskId, claimToken, projectId: 'qualification-project', ownerId,
    requirement: 'Create result.txt containing exactly HARNESS_FULL_CHAIN_OK followed by one newline. Do not modify any other tracked file. The existing node test.js validation checks both exact content and tracked-file integrity and must pass; use that exact command as the Oracle for both requirements.' });
  const taskRoot = path.join(config.sandboxRoot, taskId, claimToken);
  const runId = `${taskId}-${claimToken}`;
  const runRoot = path.join(taskRoot, 'evidence', 'runs', runId);
  if (result.outcome !== 'needs_coordination' || JSON.parse(fs.readFileSync(path.join(runRoot, 'state.json'), 'utf8')).status !== 'spec-ready') {
    throw new Error(`full Harness qualification did not stop at the explicit spec freeze gate: ${result.outcome || 'unknown'}`);
  }
  const authorityEnv = { PATH: '/usr/bin:/bin', HOME: path.join(taskRoot, 'evidence', 'authority-home') };
  const baseArgs = ['--workdir', path.join(taskRoot, 'output', 'workspace'), '--run', runId,
    '--runs-dir', path.join(taskRoot, 'evidence', 'runs'), '--control-root', path.join(taskRoot, 'evidence', 'control')];
  const freeze = spawnSync(config.nodePath, [config.orchestratorPath, 'freeze', ...baseArgs, '--reviewer', 'authorized-user-20260903'],
    { cwd: path.join(taskRoot, 'output', 'workspace'), env: authorityEnv, encoding: 'utf8', timeout: config.projects['qualification-project'].timeoutMs, maxBuffer: config.maxLogBytes });
  if (freeze.status !== 0 || JSON.parse(fs.readFileSync(path.join(runRoot, 'state.json'), 'utf8')).status !== 'frozen') {
    throw new Error(`full Harness qualification could not record the explicit spec freeze: ${String(freeze.stderr || freeze.stdout || '').trim()}`);
  }
  const resumeArgs = [config.orchestratorPath, 'resume', ...baseArgs,
    '--external-stages', 'spec,review', '--external-runtime-config', config.externalRuntimeConfigPath,
    '--runtime-capability-evidence-file', config.runtimeCapabilityEvidencePath,
    '--capability-router', 'enforce', '--codex-command', config.codexCommandPath,
    '--provider-output-root', path.join(taskRoot, 'output', 'provider-output'), '--provider-uid', String(config.providerUid),
    '--provider-gid', String(config.providerGid), '--provider-home', path.join(taskRoot, 'output', 'provider-home'),
    '--provider-setpriv-path', config.launcherPath, '--require-provider-os-isolation', '--validation-command', 'node test.js'];
  const resume = spawnSync(config.nodePath, resumeArgs,
    { cwd: path.join(taskRoot, 'output', 'workspace'), env: authorityEnv, encoding: 'utf8', timeout: config.projects['qualification-project'].timeoutMs, maxBuffer: config.maxLogBytes });
  const resumedState = JSON.parse(fs.readFileSync(path.join(runRoot, 'state.json'), 'utf8'));
  if (resume.status !== 0 || resumedState.status !== 'completed') throw new Error(`full Harness qualification resume failed at ${resumedState.status || 'unknown'}: ${String(resume.stderr || resume.stdout || '').trim()}`);
  const workspaceFile = path.join(taskRoot, 'output', 'workspace', 'result.txt');
  if (fs.readFileSync(workspaceFile, 'utf8') !== 'HARNESS_FULL_CHAIN_OK\n' || fs.statSync(workspaceFile).uid !== config.providerUid) {
    throw new Error('provider writer evidence mismatch');
  }
  for (const name of ['state.json', 'completion-gate.json', 'handoff.json', 'review.json']) {
    const stat = fs.lstatSync(path.join(runRoot, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
      throw new Error('authority artifact ownership mismatch');
    }
  }
  const created = fs.readdirSync(spoolRoot).filter(name => !before.has(name));
  if (created.length < 4) throw new Error('Transcript spool evidence is incomplete');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  process.stdout.write(`${JSON.stringify({ fullHarness: true, taskId, providerUid: config.providerUid,
    workspaceHash: hash(workspaceFile), stateHash: hash(path.join(runRoot, 'state.json')),
    completionGateHash: hash(path.join(runRoot, 'completion-gate.json')), transcriptArtifacts: created.length })}\n`);
})().catch(error => { process.stderr.write(`full Harness qualification failed: ${error.message}\n`); process.exitCode = 1; });
