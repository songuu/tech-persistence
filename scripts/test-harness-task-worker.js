'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { validateWorkerConfig, validateClaim, buildSandboxInvocation, classifyRecovery, prepareTaskFiles,
  gitSystemConfigForProjects, runBoundedProcess, runClaim, resumeClaim, safeWorkerErrorCode } = require('./harness-task-worker');

const root = path.resolve(path.sep, 'srv', 'tp');
const config = () => ({ version: 'harness-task-worker-v1', workerId: 'authority-1', sandboxRoot: path.join(root, 'sandboxes'),
  runtimeRoot: path.join(root, 'runtime'), externalRuntimeConfigPath: path.join(root, 'task-runtime-config', 'external-runtime.json'),
  runtimeCapabilityEvidencePath: path.join(root, 'task-runtime-config', 'runtime-capability-evidence.json'),
  codexCommandPath: path.join(root, 'runtime', 'scripts', 'codex-task-provider.sh'),
  launcherPath: path.join(root, 'launcher'), gitPath: path.resolve(path.sep, 'usr', 'bin', 'git'),
  gitConfigPath: path.join(root, 'git-system.config'), duPath: path.resolve(path.sep, 'usr', 'bin', 'du'),
  mkdirPath: path.resolve(path.sep, 'usr', 'bin', 'mkdir'), chmodPath: path.resolve(path.sep, 'usr', 'bin', 'chmod'),
  providerUid: 986, providerGid: 986, maxLogBytes: 1048576,
  maxWorkspaceBytes: 67108864, minimumFreeBytes: 16777216, idleMs: 1000,
  nodePath: path.resolve(path.sep, 'usr', 'bin', 'node'), orchestratorPath: path.join(root, 'runtime', 'scripts', 'agent-orchestrator.js'),
  heartbeatMs: 5000, projects: { 'project-one': { sourceRoot: path.join(root, 'projects', 'one'),
    timeoutMs: 120000, validationCommands: ['node test.js'] } } });
const claim = () => ({ taskId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', claimToken: '11111111-2222-4333-8444-555555555555',
  projectId: 'project-one', requirement: 'Implement exactly this\n--not-an-option', ownerId: '99999999-aaaa-4bbb-8ccc-dddddddddddd' });
function prepareTestRoot(directory) {
  if (process.platform === 'win32') return 986;
  const providerGid = process.getgid() === 0 ? config().providerGid : process.getgid();
  if (fs.statSync(directory).gid !== providerGid) fs.chownSync(directory, process.getuid(), providerGid);
  fs.chmodSync(directory, 0o2710); return providerGid;
}

test('worker config accepts a fixed server-owned project registry', () => assert.equal(validateWorkerConfig(config()).workerId, 'authority-1'));
test('worker generates an exact non-wildcard protected Git allowlist', () => {
  const value = gitSystemConfigForProjects(validateWorkerConfig(config()).projects);
  const escaped = config().projects['project-one'].sourceRoot.replace(/\\/g, '\\\\');
  assert.match(value, /\[safe\]/); assert.ok(value.includes(escaped)); assert.ok(!value.includes('*'));
});
test('worker config rejects unknown top-level fields', () => assert.throws(() => validateWorkerConfig({ ...config(), command: 'sh' }), /config/));
test('worker config rejects relative authority paths', () => assert.throws(() => validateWorkerConfig({ ...config(), sandboxRoot: '../tmp' }), /absolute/));
test('worker config rejects project traversal identifiers', () => {
  const value = config(); value.projects = { '../root': value.projects['project-one'] }; assert.throws(() => validateWorkerConfig(value), /project/);
});
test('worker config rejects shell and arbitrary command fields in projects', () => {
  const value = config(); value.projects['project-one'].command = 'sh'; assert.throws(() => validateWorkerConfig(value), /project config/);
});
test('worker config requires bounded authority-owned validation commands', () => {
  for (const validationCommands of [[], ['ok', 'x\ny'], ['x'.repeat(513)]]) {
    const value = config(); value.projects['project-one'].validationCommands = validationCommands;
    assert.throws(() => validateWorkerConfig(value), /validation commands/);
  }
});
test('worker config rejects source roots nested in the sandbox output', () => {
  const value = config(); value.projects['project-one'].sourceRoot = path.join(value.sandboxRoot, 'source'); assert.throws(() => validateWorkerConfig(value), /sourceRoot/);
});
test('worker config bounds heartbeat and task timeout', () => {
  for (const heartbeatMs of [99, 10001, 1.5]) assert.throws(() => validateWorkerConfig({ ...config(), heartbeatMs }), /heartbeat/);
  for (const timeoutMs of [999, 3600001, 1.5]) { const value = config(); value.projects['project-one'].timeoutMs = timeoutMs; assert.throws(() => validateWorkerConfig(value), /timeout/); }
});
test('claim accepts only authority-issued primitive fields', () => assert.equal(validateClaim(claim()).projectId, 'project-one'));
test('claim rejects browser-controlled execution fields', () => {
  for (const field of ['command', 'args', 'env', 'path', 'model', 'provider', 'accepted']) assert.throws(() => validateClaim({ ...claim(), [field]: 'x' }), /claim/);
});
test('claim rejects malformed identifiers and oversized requirements', () => {
  for (const value of [{ ...claim(), taskId: '../x' }, { ...claim(), ownerId: [] }, { ...claim(), requirement: '' },
    { ...claim(), requirement: 'x'.repeat(16385) }]) assert.throws(() => validateClaim(value), /claim/);
});
test('sandbox invocation keeps requirement out of argv and selects the registry project', () => {
  const invocation = buildSandboxInvocation(config(), claim());
  assert.equal(invocation.command, path.resolve(path.sep, 'usr', 'bin', 'node'));
  assert.ok(!invocation.args.join('\n').includes(claim().requirement));
  assert.ok(invocation.args.includes('--requirement-file')); assert.ok(invocation.args.includes(path.join(invocation.inputRoot, 'requirement.txt')));
});
test('authority invocation exposes only task-scoped paths and registry-selected source stays out of argv', () => {
  const invocation = buildSandboxInvocation(config(), claim()); const joined = invocation.args.join('\n');
  assert.match(joined, /aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/); assert.ok(!joined.includes(claim().ownerId));
  assert.ok(!joined.includes(config().projects['project-one'].sourceRoot));
  assert.ok(invocation.args.includes(invocation.workspaceRoot));
});
test('sandbox invocation refuses claims for projects absent from the registry', () => {
  assert.throws(() => buildSandboxInvocation(config(), { ...claim(), projectId: 'project-two' }), /not qualified/);
});
test('authority invocation pins private state and delegates only provider children', () => {
  const invocation = buildSandboxInvocation(config(), claim()); const joined = invocation.args.join('\n');
  assert.match(joined, /--provider-uid\n986/); assert.match(joined, /--provider-gid\n986/);
  assert.ok(invocation.args.includes('--require-provider-os-isolation'));
  assert.match(joined, /--runs-dir/); assert.ok(joined.includes(invocation.evidenceRoot));
  assert.match(joined, /--provider-output-root/); assert.ok(joined.includes(invocation.providerOutputRoot));
  assert.deepEqual(invocation.args.slice(-2), ['--validation-command', 'node test.js']);
});
test('authority invocation executes the fixed orchestrator and provider wrapper paths', () => {
  const invocation = buildSandboxInvocation(config(), claim());
  assert.ok(invocation.args.includes(config().orchestratorPath));
  assert.ok(invocation.args.includes(config().externalRuntimeConfigPath));
  assert.ok(invocation.args.includes(config().codexCommandPath));
});
test('unknown pre-dispatch recovery is safe to requeue', () => assert.equal(classifyRecovery({ state: 'claimed', dispatchStarted: false }), 'requeue'));
test('expired dispatch is never automatically replayed', () => assert.equal(classifyRecovery({ state: 'running', dispatchStarted: true }), 'needs_coordination'));
test('cancel-requested dispatch resolves to cancellation, not replay', () => assert.equal(classifyRecovery({ state: 'cancel_requested', dispatchStarted: true }), 'cancel'));
test('invalid recovery evidence fails closed', () => {
  for (const value of [null, {}, { state: 'queued', dispatchStarted: true }, { state: 'running', dispatchStarted: 'yes' }]) assert.throws(() => classifyRecovery(value), /recovery/);
});
test('worker errors expose only fixed infrastructure categories', () => {
  assert.equal(safeWorkerErrorCode(new Error('invalid claim')), 'worker_claim');
  assert.equal(safeWorkerErrorCode(new Error('invalid worker config')), 'worker_config');
  assert.equal(safeWorkerErrorCode(new Error('unsafe task sandbox directory: /private/path')), 'worker_sandbox_layout');
  assert.equal(safeWorkerErrorCode(new Error('postgres://secret@host')), 'worker_internal_error');
  assert.equal(safeWorkerErrorCode(Object.assign(new Error('private query'), { code: '42501' })), 'worker_database_privilege');
});
test('task preparation creates a fresh bounded input/output layout and exact requirement bytes', t => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-')); t.after(() => fs.rmSync(sandboxRoot, { recursive: true, force: true }));
  const providerGid = prepareTestRoot(sandboxRoot);
  const prepared = prepareTaskFiles({ ...config(), sandboxRoot, providerGid }, claim());
  assert.equal(fs.readFileSync(path.join(prepared.inputRoot, 'requirement.txt'), 'utf8'), claim().requirement);
  assert.equal(fs.existsSync(prepared.workspaceRoot), false, 'workspace remains absent until fixed git clone');
  assert.throws(() => prepareTaskFiles({ ...config(), sandboxRoot, providerGid }, claim()), /already exists/);
});
test('task preparation restores the fixed parent mode under a restrictive service umask', { skip: process.platform === 'win32' }, t => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-umask-')); t.after(() => fs.rmSync(sandboxRoot, { recursive: true, force: true }));
  const providerGid = prepareTestRoot(sandboxRoot); const prior = process.umask(0o077);
  try {
    const prepared = prepareTaskFiles({ ...config(), sandboxRoot, providerGid }, claim());
    assert.equal(fs.statSync(path.dirname(prepared.taskRoot)).mode & 0o7777, 0o2710);
  } finally { process.umask(prior); }
});
test('task preparation rejects a symlink sandbox root', { skip: process.platform === 'win32' }, t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-link-')); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const real = path.join(parent, 'real'); fs.mkdirSync(real); const providerGid = prepareTestRoot(real);
  const link = path.join(parent, 'link'); fs.symlinkSync(real, link, 'dir');
  assert.throws(() => prepareTaskFiles({ ...config(), sandboxRoot: link, providerGid }, claim()), /sandbox root/);
});
test('bounded process captures finite output without a shell', async () => {
  const result = await runBoundedProcess(process.execPath, ['-e', "process.stdout.write('ok'); process.stderr.write('warn')"],
    { timeoutMs: 1000, heartbeatMs: 100, maxLogBytes: 4096, env: process.env });
  assert.equal(result.exitCode, 0); assert.equal(result.reason, null); assert.equal(result.stdout.toString(), 'ok'); assert.equal(result.stderr.toString(), 'warn');
});
test('bounded process terminates excessive output', async () => {
  const result = await runBoundedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000)"],
    { timeoutMs: 1000, heartbeatMs: 100, maxLogBytes: 4096, env: process.env });
  assert.equal(result.reason, 'output_limit');
});
test('bounded process consumes cancellation returned by authority heartbeat', async () => {
  const result = await runBoundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { timeoutMs: 1000, heartbeatMs: 10, maxLogBytes: 4096, env: process.env, pulse: async () => ({ owned: true, cancel: true }) });
  assert.equal(result.reason, 'cancelled');
});
test('bounded process escalates to SIGKILL when a child ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const started = Date.now();
  const result = await runBoundedProcess(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
    { timeoutMs: 30, heartbeatMs: 100, maxLogBytes: 4096, killGraceMs: 20, env: process.env });
  assert.equal(result.reason, 'timeout'); assert.ok(Date.now() - started < 1000);
});
test('runClaim orders clone, durable start, sandbox execution and fail-closed terminal result', async t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-run-')); t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const events = []; const store = {
    heartbeat: async () => ({ owned: true, cancel: false }), start: async () => { events.push('start'); return true; },
    finish: async input => { events.push(['finish', input]); return true; }, failBeforeDispatch: async () => assert.fail('unexpected predispatch failure'),
  };
  const result = await runClaim(store, config(), claim(), {
    statfsSync: () => ({ bavail: 1024 * 1024, bsize: 4096 }),
    validateProviderHome: () => {},
    measureWorkspace: async () => 0,
    measurePreparedWorkspace: async () => 0,
    prepareTaskFiles: () => ({ ...buildSandboxInvocation(config(), claim()), outputRoot, evidenceRoot: outputRoot,
      workspaceRoot: path.join(outputRoot, 'workspace'), taskRoot: outputRoot }),
    runBoundedProcess: async (command, args) => {
      events.push(['run', command, args]);
      if (command === config().nodePath) {
        const runRoot = path.join(outputRoot, 'runs', `${claim().taskId}-${claim().claimToken}`); fs.mkdirSync(runRoot, { recursive: true });
        fs.writeFileSync(path.join(runRoot, 'state.json'), JSON.stringify({ status: 'completed' }));
        fs.writeFileSync(path.join(runRoot, 'completion-gate.json'), JSON.stringify({ ok: true }));
      }
      return { exitCode: 0, signal: null, reason: null, stdout: Buffer.from('out'), stderr: Buffer.alloc(0) };
    },
  });
  assert.deepEqual(events.map(item => Array.isArray(item) ? item[0] : item), ['run', 'run', 'run', 'run', 'start', 'run', 'finish']);
  assert.equal(result.outcome, 'succeeded'); assert.equal(events[6][1].code, 'completed');
  assert.equal(fs.readFileSync(path.join(outputRoot, 'stdout.log'), 'utf8'), 'out');
});
test('runClaim records clone failure before dispatch and never starts provider', async t => {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-clone-fail-'));
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  const events = []; const store = { heartbeat: async () => ({ owned: true, cancel: false }), start: async () => assert.fail('must not start'),
    finish: async () => assert.fail('must not finish running'), failBeforeDispatch: async input => { events.push(input); return true; } };
  const result = await runClaim(store, config(), claim(), { statfsSync: () => ({ bavail: 1024 * 1024, bsize: 4096 }),
    measureWorkspace: async () => 0,
    measurePreparedWorkspace: async () => 0,
    prepareTaskFiles: () => ({ ...buildSandboxInvocation(config(), claim()), taskRoot: evidenceRoot, evidenceRoot, workspaceRoot: '/unused' }),
    runBoundedProcess: async () => ({ exitCode: 1, signal: null, reason: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) });
  assert.equal(result.phase, 'workspace'); assert.equal(events[0].code, 'workspace_clone_failed');
});
test('runClaim uses a shallow isolated clone and a claim-token-specific attempt root', async () => {
  const calls = []; const store = { heartbeat: async () => ({ owned: true, cancel: false }), start: async () => false,
    finish: async () => true, failBeforeDispatch: async () => true };
  const invocation = buildSandboxInvocation(config(), claim()); assert.ok(invocation.taskRoot.endsWith(path.join(claim().taskId, claim().claimToken)));
  await runClaim(store, config(), claim(), { statfsSync: () => ({ bavail: 1024 * 1024, bsize: 4096 }), measureWorkspace: async () => 0,
    measurePreparedWorkspace: async () => 0, prepareTaskFiles: () => invocation,
    validateProviderHome: () => {},
    runBoundedProcess: async (command, args) => { calls.push(args); return { exitCode: 0, reason: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } });
  assert.ok(calls[0].includes('--depth')); assert.ok(calls[0].includes('1')); assert.ok(calls[0].includes('--single-branch'));
  assert.ok(calls[1].includes('u=rwX,g=rwX,o=')); assert.ok(calls[2].includes('0700'));
  assert.deepEqual(calls[3].slice(-4), [config().chmodPath, '0700', '--', invocation.providerHome]);
});
test('runClaim never invokes provider measurement before restrictive clone permissions are normalized', async t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-normalize-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  let normalized = false; let providerMeasurements = 0;
  const store = { heartbeat: async () => ({ owned: true, cancel: false }), start: async () => false,
    finish: async () => true, failBeforeDispatch: async () => true };
  await runClaim(store, config(), claim(), {
    statfsSync: () => ({ bavail: 1024 * 1024, bsize: 4096 }),
    measurePreparedWorkspace: async () => 1,
    measureWorkspace: async () => {
      assert.equal(normalized, true, 'provider measurement requires normalized group traversal');
      providerMeasurements += 1; return 1;
    },
    prepareTaskFiles: () => ({ ...buildSandboxInvocation(config(), claim()), outputRoot, evidenceRoot: outputRoot,
      workspaceRoot: path.join(outputRoot, 'workspace'), taskRoot: outputRoot }),
    validateProviderHome: () => {},
    runBoundedProcess: async (command, args, options) => {
      if (options.pulse) await options.pulse();
      if (command === config().chmodPath) normalized = true;
      return { exitCode: 0, signal: null, reason: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(providerMeasurements, 3, 'provider measurement runs only after workspace chmod and during later provider-home pulses');
});
test('resumeClaim revalidates the raw worker config without feeding derived fields back into the strict schema', async t => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-resume-'));
  t.after(() => fs.rmSync(sandboxRoot, { recursive: true, force: true }));
  const rawConfig = { ...config(), sandboxRoot };
  const resume = { ...claim(), resumeClaimToken: '99999999-9999-4999-8999-999999999999' };
  const invocation = buildSandboxInvocation(rawConfig, resume);
  const runRoot = path.join(invocation.evidenceRoot, 'runs', `${resume.taskId}-${resume.resumeClaimToken}`);
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(path.join(runRoot, 'state.json'), JSON.stringify({ status: 'spec-ready' }));
  const result = await resumeClaim({ start: async () => false }, rawConfig, resume);
  assert.deepEqual(result, { phase: 'start', reason: 'claim_not_startable' });
});
test('authority database config is pinned to loopback, database and dedicated role', () => {
  const { authorityDatabaseConfig } = require('./harness-task-worker');
  const parsed = authorityDatabaseConfig('postgresql://tp_task_authority:secret@127.0.0.1:55433/tech_persistence');
  assert.equal(parsed.user, 'tp_task_authority'); assert.equal(parsed.ssl, false); assert.equal(parsed.max, 2);
  for (const value of ['postgresql://other:x@127.0.0.1:55433/tech_persistence', 'postgresql://tp_task_authority:x@db:5432/tech_persistence',
    'postgresql://tp_task_authority:x@127.0.0.1:55433/other', 'postgresql://tp_task_authority@127.0.0.1:55433/tech_persistence']) {
    assert.throws(() => authorityDatabaseConfig(value), /authority database/);
  }
});
