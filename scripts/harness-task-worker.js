'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const WORKER = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const CONFIG_KEYS = ['version', 'workerId', 'sandboxRoot', 'runtimeRoot', 'externalRuntimeConfigPath', 'runtimeCapabilityEvidencePath', 'codexCommandPath',
  'launcherPath', 'gitPath', 'gitConfigPath', 'duPath', 'mkdirPath', 'chmodPath', 'nodePath', 'orchestratorPath',
  'providerUid', 'providerGid', 'heartbeatMs', 'maxLogBytes', 'maxWorkspaceBytes', 'minimumFreeBytes', 'idleMs', 'projects'];
const PROJECT_KEYS = ['sourceRoot', 'timeoutMs', 'validationCommands'];
const CLAIM_KEYS = ['taskId', 'claimToken', 'projectId', 'requirement', 'ownerId'];
const RESUME_CLAIM_KEYS = [...CLAIM_KEYS, 'resumeClaimToken'];

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`invalid ${label}`);
  }
}
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}
function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid ${label}`);
  return value;
}
function validateWorkerConfig(input) {
  exactObject(input, CONFIG_KEYS, 'worker config');
  if (input.version !== 'harness-task-worker-v1' || typeof input.workerId !== 'string' || !WORKER.test(input.workerId)) throw new Error('invalid worker config');
  const sandboxRoot = absolute(input.sandboxRoot, 'sandboxRoot');
  const runtimeRoot = absolute(input.runtimeRoot, 'runtimeRoot');
  const externalRuntimeConfigPath = absolute(input.externalRuntimeConfigPath, 'externalRuntimeConfigPath');
  const runtimeCapabilityEvidencePath = absolute(input.runtimeCapabilityEvidencePath, 'runtimeCapabilityEvidencePath');
  const codexCommandPath = absolute(input.codexCommandPath, 'codexCommandPath');
  const launcherPath = absolute(input.launcherPath, 'launcherPath');
  const gitPath = absolute(input.gitPath, 'gitPath');
  const gitConfigPath = absolute(input.gitConfigPath, 'gitConfigPath');
  const duPath = absolute(input.duPath, 'duPath');
  const mkdirPath = absolute(input.mkdirPath, 'mkdirPath');
  const chmodPath = absolute(input.chmodPath, 'chmodPath');
  const nodePath = absolute(input.nodePath, 'nodePath');
  const orchestratorPath = absolute(input.orchestratorPath, 'orchestratorPath');
  if (!within(runtimeRoot, orchestratorPath)) throw new Error('orchestratorPath must be inside runtimeRoot');
  if (!within(runtimeRoot, codexCommandPath)) throw new Error('codexCommandPath must be inside runtimeRoot');
  const orchestratorRelative = path.relative(runtimeRoot, orchestratorPath);
  if (!orchestratorRelative || orchestratorRelative.startsWith('..') || path.isAbsolute(orchestratorRelative)) throw new Error('invalid orchestratorPath');
  integer(input.heartbeatMs, 100, 10000, 'heartbeat');
  integer(input.providerUid, 1, 2147483647, 'providerUid');
  integer(input.providerGid, 1, 2147483647, 'providerGid');
  integer(input.maxLogBytes, 4096, 16 * 1024 * 1024, 'maxLogBytes');
  integer(input.maxWorkspaceBytes, 1024 * 1024, 1024 * 1024 * 1024, 'maxWorkspaceBytes');
  integer(input.minimumFreeBytes, 16 * 1024 * 1024, 16 * 1024 * 1024 * 1024, 'minimumFreeBytes');
  integer(input.idleMs, 100, 60000, 'idleMs');
  if (!input.projects || typeof input.projects !== 'object' || Array.isArray(input.projects)
      || Object.keys(input.projects).length < 1 || Object.keys(input.projects).length > 100) throw new Error('invalid projects');
  const projects = {};
  for (const [projectId, project] of Object.entries(input.projects)) {
    if (!PROJECT.test(projectId)) throw new Error('invalid project identifier');
    exactObject(project, PROJECT_KEYS, 'project config');
    const sourceRoot = absolute(project.sourceRoot, 'sourceRoot');
    if (within(sandboxRoot, sourceRoot) || /[\0\r\n]/.test(sourceRoot)) throw new Error('sourceRoot must be outside sandboxRoot');
    integer(project.timeoutMs, 1000, 3600000, 'timeout');
    if (!Array.isArray(project.validationCommands) || project.validationCommands.length < 1 || project.validationCommands.length > 8
        || project.validationCommands.some(command => typeof command !== 'string' || !command.trim() || command.length > 512
          || /[\0\r\n]/.test(command))) throw new Error('invalid project validation commands');
    projects[projectId] = { ...project, sourceRoot, validationCommands: [...project.validationCommands] };
  }
  if (within(sandboxRoot, gitConfigPath)) throw new Error('gitConfigPath must be outside sandboxRoot');
  if (within(sandboxRoot, externalRuntimeConfigPath)) throw new Error('externalRuntimeConfigPath must be outside sandboxRoot');
  if (within(sandboxRoot, runtimeCapabilityEvidencePath)) throw new Error('runtimeCapabilityEvidencePath must be outside sandboxRoot');
  return { ...input, sandboxRoot, runtimeRoot, externalRuntimeConfigPath, runtimeCapabilityEvidencePath, codexCommandPath,
    launcherPath, gitPath, gitConfigPath, duPath, mkdirPath, chmodPath, nodePath, orchestratorPath,
    orchestratorRelative, projects };
}
function validateClaim(input) {
  exactObject(input, Object.hasOwn(input || {}, 'resumeClaimToken') ? RESUME_CLAIM_KEYS : CLAIM_KEYS, 'claim');
  if (![input.taskId, input.claimToken, input.ownerId].every(value => typeof value === 'string' && UUID.test(value))
      || !(input.resumeClaimToken === undefined || input.resumeClaimToken === null
        || (typeof input.resumeClaimToken === 'string' && UUID.test(input.resumeClaimToken)))
      || typeof input.projectId !== 'string' || !PROJECT.test(input.projectId)
      || typeof input.requirement !== 'string' || !input.requirement.trim() || input.requirement.includes('\0')
      || Buffer.byteLength(input.requirement) > 16384 || Buffer.from(input.requirement, 'utf8').toString('utf8') !== input.requirement) {
    throw new Error('invalid claim');
  }
  return { ...input, resumeClaimToken: input.resumeClaimToken || null };
}
function gitSystemConfigForProjects(projects) {
  const directories = Object.values(projects).map(project => project.sourceRoot).sort();
  return `[safe]\n${directories.flatMap(source => {
    const escaped = source.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return [`\tdirectory = "${escaped}"`, `\tdirectory = "${escaped}/.git"`];
  }).join('\n')}\n`;
}
function validateGitConfigFile(config) {
  const stat = fs.lstatSync(config.gitConfigPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(config.gitConfigPath) !== config.gitConfigPath
      || (process.platform !== 'win32' && (stat.uid !== 0 || (stat.mode & 0o7777) !== 0o444))
      || fs.readFileSync(config.gitConfigPath, 'utf8') !== gitSystemConfigForProjects(config.projects)) {
    throw new Error('unsafe git system configuration');
  }
}
function linuxJoin(...parts) { return `/${parts.map(value => String(value).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`; }
function launcherArgs(config, command, args) {
  return ['--reuid', String(config.providerUid), '--regid', String(config.providerGid), '--clear-groups', '--', command, ...args];
}
function buildSandboxInvocation(rawConfig, rawClaim) {
  const config = validateWorkerConfig(rawConfig); const claim = validateClaim(rawClaim);
  const project = config.projects[claim.projectId];
  if (!project) throw new Error('project is not qualified by the authority registry');
  const attemptToken = claim.resumeClaimToken || claim.claimToken;
  const taskRoot = path.join(config.sandboxRoot, claim.taskId, attemptToken);
  const inputRoot = path.join(taskRoot, 'input'); const outputRoot = path.join(taskRoot, 'output');
  const evidenceRoot = path.join(taskRoot, 'evidence'); const authorityHome = path.join(evidenceRoot, 'authority-home');
  const workspaceRoot = path.join(outputRoot, 'workspace');
  const providerHome = path.join(outputRoot, 'provider-home'); const providerOutputRoot = path.join(outputRoot, 'provider-output');
  const args = [config.orchestratorPath, 'run', '--workdir', workspaceRoot, '--run-id', `${claim.taskId}-${attemptToken}`,
    '--requirement-file', path.join(inputRoot, 'requirement.txt'), '--auto', '--external-stages', 'spec,review',
    '--external-runtime-config', config.externalRuntimeConfigPath, '--capability-router', 'enforce',
    '--runtime-capability-evidence-file', config.runtimeCapabilityEvidencePath,
    '--codex-command', config.codexCommandPath, '--runs-dir', path.join(evidenceRoot, 'runs'),
    '--control-root', path.join(evidenceRoot, 'control'), '--provider-output-root', providerOutputRoot,
    '--provider-uid', String(config.providerUid), '--provider-gid', String(config.providerGid),
    '--provider-home', providerHome, '--provider-setpriv-path', config.launcherPath, '--require-provider-os-isolation'];
  for (const command of project.validationCommands) args.push('--validation-command', command);
  return { command: config.nodePath, args, taskRoot, inputRoot, outputRoot, evidenceRoot, authorityHome, workspaceRoot, providerHome, providerOutputRoot,
    gitConfigPath: config.gitConfigPath,
    sourceRoot: project.sourceRoot, timeoutMs: project.timeoutMs };
}
function safeSandboxRoot(config) {
  const stat = fs.lstatSync(config.sandboxRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(config.sandboxRoot) !== config.sandboxRoot) throw new Error('unsafe sandbox root');
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid() || stat.gid !== config.providerGid || (stat.mode & 0o7777) !== 0o2710) throw new Error('unsafe sandbox root ownership or mode');
  }
}
function prepareTaskFiles(rawConfig, rawClaim) {
  const config = validateWorkerConfig(rawConfig); const claim = validateClaim(rawClaim); safeSandboxRoot(config);
  const invocation = buildSandboxInvocation(rawConfig, claim);
  if (fs.existsSync(invocation.taskRoot)) throw new Error('task sandbox already exists');
  const taskParent = path.dirname(invocation.taskRoot);
  if (!fs.existsSync(taskParent)) {
    fs.mkdirSync(taskParent, { mode: 0o710 });
    // A restrictive service umask must not erase the provider traversal bit required by this fixed boundary.
    if (process.platform !== 'win32') fs.chmodSync(taskParent, 0o2710);
  }
  const parentStat = fs.lstatSync(taskParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || (process.platform !== 'win32' && (parentStat.uid !== process.getuid() || parentStat.gid !== config.providerGid
        || (parentStat.mode & 0o7777) !== 0o2710))) throw new Error('unsafe task sandbox parent');
  fs.mkdirSync(invocation.taskRoot, { mode: 0o710 });
  fs.mkdirSync(invocation.inputRoot, { mode: 0o750 });
  const priorUmask = process.umask(0);
  try {
    fs.mkdirSync(invocation.outputRoot, { mode: 0o770 });
    fs.mkdirSync(invocation.providerOutputRoot, { mode: 0o770 });
  } finally { process.umask(priorUmask); }
  fs.mkdirSync(invocation.evidenceRoot, { mode: 0o700 });
  fs.mkdirSync(invocation.authorityHome, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(invocation.authorityHome, 0o700);
  if (process.platform !== 'win32') {
    for (const [directory, mode] of [[invocation.taskRoot, 0o2710], [invocation.inputRoot, 0o2750],
      [invocation.outputRoot, 0o2770], [invocation.providerOutputRoot, 0o2770],
      [invocation.evidenceRoot, 0o700], [invocation.authorityHome, 0o700]]) fs.chmodSync(directory, mode);
    for (const [directory, expectedMode, expectedGid] of [[invocation.taskRoot, 0o2710, config.providerGid],
      [invocation.inputRoot, 0o2750, config.providerGid], [invocation.outputRoot, 0o2770, config.providerGid],
      [invocation.providerOutputRoot, 0o2770, config.providerGid], [invocation.evidenceRoot, 0o700, config.providerGid],
      [invocation.authorityHome, 0o700, config.providerGid]]) {
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid()
          || directoryStat.gid !== expectedGid || (directoryStat.mode & 0o7777) !== expectedMode) {
        throw new Error('unsafe task sandbox directory');
      }
    }
  }
  const requirementPath = path.join(invocation.inputRoot, 'requirement.txt');
  const fd = fs.openSync(requirementPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o640);
  try { fs.writeFileSync(fd, claim.requirement, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform !== 'win32') fs.chmodSync(requirementPath, 0o440);
  const stat = fs.lstatSync(requirementPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(claim.requirement)) throw new Error('unsafe requirement file');
  return invocation;
}
function terminateTree(child, signal = 'SIGTERM') {
  if (!child || !Number.isSafeInteger(child.pid)) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function runBoundedProcess(command, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { shell: false, detached: process.platform !== 'win32', windowsHide: true,
        cwd: options.cwd || path.parse(path.resolve(command)).root, env: options.env || { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }
    const output = { stdout: [], stderr: [] }; let bytes = 0; let reason = null; let heartbeatBusy = false; let killTimer = null;
    const stop = value => {
      if (!reason) {
        reason = value; terminateTree(child);
        const killGraceMs = options.killGraceMs ?? 2000;
        if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 10 || killGraceMs > 5000) throw new Error('invalid kill grace');
        killTimer = setTimeout(() => terminateTree(child, 'SIGKILL'), killGraceMs); killTimer.unref?.();
      }
    };
    const collect = key => chunk => {
      const value = Buffer.from(chunk); bytes += value.length;
      if (bytes > options.maxLogBytes) { stop('output_limit'); return; }
      output[key].push(value);
    };
    child.stdout?.on('data', collect('stdout')); child.stderr?.on('data', collect('stderr'));
    child.once('error', error => { reason ||= 'spawn_error'; reject(error); });
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    const heartbeat = options.pulse ? setInterval(async () => {
      if (heartbeatBusy || reason) return;
      heartbeatBusy = true;
      try {
        const pulse = await options.pulse();
        if (!pulse || pulse.owned !== true) stop('lease_lost');
        else if (pulse.resourceLimit === true) stop('workspace_limit');
        else if (pulse.cancel === true) stop('cancelled');
      } catch { stop('heartbeat_failed'); }
      finally { heartbeatBusy = false; }
    }, options.heartbeatMs) : null;
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout); if (heartbeat) clearInterval(heartbeat); if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, signal, reason, stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr) });
    });
  });
}
function writePrivateLog(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function atWorkerPhase(phase, operation) {
  try { return await operation(); }
  catch (error) { error.workerPhase ||= phase; throw error; }
}
function readAuthorityJson(file, root) {
  const resolved = path.resolve(file);
  if (!within(root, resolved)) throw new Error('authority artifact escaped evidence root');
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024
      || (process.platform !== 'win32' && stat.uid !== process.getuid())) throw new Error('unsafe authority artifact');
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}
function classifyHarnessResult(invocation, claim, result) {
  if (result.reason === 'cancelled') return ['cancelled', 'cancelled'];
  if (result.reason) return ['needs_coordination', result.reason];
  if (result.exitCode !== 0) return ['failed', 'harness_exit_nonzero'];
  const runRoot = path.join(invocation.evidenceRoot, 'runs', `${claim.taskId}-${claim.claimToken}`);
  const state = readAuthorityJson(path.join(runRoot, 'state.json'), invocation.evidenceRoot);
  if (state.status === 'completed') {
    const gate = readAuthorityJson(path.join(runRoot, 'completion-gate.json'), invocation.evidenceRoot);
    return gate.ok === true ? ['succeeded', 'completed'] : ['needs_coordination', 'completion_gate_rejected'];
  }
  if (['blocked', 'needs-followup', 'spec-ready'].includes(state.status)) return ['needs_coordination', `harness_${state.status.replace(/-/g, '_')}`];
  return ['needs_coordination', 'harness_nonterminal'];
}
async function providerDirectoryBytes(config, invocation, runProcess = runBoundedProcess) {
  if (!fs.existsSync(invocation.workspaceRoot)) return 0;
  const measured = await runProcess(config.launcherPath, launcherArgs(config, config.duPath, ['-sb', '--', invocation.workspaceRoot]),
    { timeoutMs: 2000, heartbeatMs: config.heartbeatMs, maxLogBytes: 4096, env: { PATH: '/usr/bin:/bin' } });
  if (measured.reason) throw new Error('workspace measurement process failed');
  if (measured.exitCode !== 0) {
    const error = new Error('workspace measurement command failed');
    error.workerMeasureExit = Number.isInteger(measured.exitCode) && measured.exitCode >= 1 && measured.exitCode <= 255
      ? measured.exitCode : 0;
    throw error;
  }
  const match = /^(\d+)\t[^\r\n]+\n?$/.exec(measured.stdout.toString('utf8'));
  if (!match) throw new Error('invalid workspace measurement');
  const bytes = Number(match[1]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid workspace measurement');
  return bytes;
}
async function authorityDirectoryBytes(config, invocation, runProcess = runBoundedProcess) {
  if (!fs.existsSync(invocation.workspaceRoot)) return 0;
  const measured = await runProcess(config.duPath, ['-sb', '--', invocation.workspaceRoot],
    { timeoutMs: 2000, heartbeatMs: config.heartbeatMs, maxLogBytes: 4096, env: { PATH: '/usr/bin:/bin' } });
  if (measured.reason || measured.exitCode !== 0) throw new Error('authority workspace measurement failed');
  const match = /^(\d+)\t[^\r\n]+\n?$/.exec(measured.stdout.toString('utf8'));
  if (!match) throw new Error('invalid authority workspace measurement');
  const bytes = Number(match[1]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid authority workspace measurement');
  return bytes;
}
async function runClaim(store, rawConfig, rawClaim, dependencies = {}) {
  const config = validateWorkerConfig(rawConfig); const claim = validateClaim(rawClaim);
  const prepare = dependencies.prepareTaskFiles || prepareTaskFiles; const runProcess = dependencies.runBoundedProcess || runBoundedProcess;
  const invocation = await atWorkerPhase('prepare', () => prepare(rawConfig, claim));
  const resultRef = `sandbox:${claim.taskId}:${claim.claimToken}`;
  const statfsSync = dependencies.statfsSync || fs.statfsSync;
  const measureWorkspace = dependencies.measureWorkspace || (() => providerDirectoryBytes(config, invocation, runProcess));
  const measurePreparedWorkspace = dependencies.measurePreparedWorkspace
    || (() => authorityDirectoryBytes(config, invocation, runProcess));
  const fileSystem = statfsSync(invocation.taskRoot);
  if (Number(fileSystem.bavail) * Number(fileSystem.bsize) < config.minimumFreeBytes) {
    await store.failBeforeDispatch({ workerId: config.workerId, claimToken: claim.claimToken, code: 'insufficient_disk_reserve', resultRef });
    return { phase: 'workspace', reason: 'insufficient_disk_reserve', outcome: 'failed' };
  }
  const preparationPulse = async () => {
    if (dependencies.shouldStop?.()) return { owned: false, cancel: true };
    const state = await store.heartbeat(config.workerId, claim.claimToken);
    const currentFileSystem = statfsSync(invocation.taskRoot);
    if (state?.owned === true
      && Number(currentFileSystem.bavail) * Number(currentFileSystem.bsize) < config.minimumFreeBytes) {
      return { owned: true, cancel: true, resourceLimit: true };
    }
    return state;
  };
  const pulse = async () => {
    const state = await preparationPulse();
    if (state?.owned === true && state.cancel !== true && (await measureWorkspace()) > config.maxWorkspaceBytes) {
      return { owned: true, cancel: true, resourceLimit: true };
    }
    return state;
  };
  const clone = await runProcess(config.gitPath,
    ['clone', '--depth', '1', '--single-branch', '--no-local', '--no-hardlinks', '--quiet',
      config.projects[claim.projectId].sourceRoot, invocation.workspaceRoot],
    { timeoutMs: invocation.timeoutMs, heartbeatMs: config.heartbeatMs, maxLogBytes: config.maxLogBytes, pulse: preparationPulse,
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_SYSTEM: invocation.gitConfigPath } });
  if (clone.reason || clone.exitCode !== 0) {
    writePrivateLog(path.join(invocation.evidenceRoot, 'clone-stdout.log'), clone.stdout);
    writePrivateLog(path.join(invocation.evidenceRoot, 'clone-stderr.log'), clone.stderr);
    if (dependencies.shouldStop?.()) {
      const released = await store.releaseBeforeDispatch(config.workerId, claim.claimToken);
      return { phase: 'workspace', reason: 'worker_shutdown', outcome: released === true ? 'queued' : null };
    }
    const committed = await store.failBeforeDispatch({ workerId: config.workerId, claimToken: claim.claimToken,
      code: clone.reason || 'workspace_clone_failed', resultRef });
    return { phase: 'workspace', ...clone, outcome: committed === true ? 'failed' : null };
  }
  if ((await atWorkerPhase('authority_measure', measurePreparedWorkspace)) > config.maxWorkspaceBytes) {
    const committed = await store.failBeforeDispatch({ workerId: config.workerId, claimToken: claim.claimToken,
      code: 'workspace_limit', resultRef });
    return { phase: 'workspace', reason: 'workspace_limit', outcome: committed === true ? 'failed' : null };
  }
  const normalizedWorkspace = await runProcess(config.chmodPath,
    ['-R', 'u=rwX,g=rwX,o=', '--', invocation.workspaceRoot],
    { timeoutMs: 5000, heartbeatMs: config.heartbeatMs, maxLogBytes: 4096, pulse: preparationPulse, env: { PATH: '/usr/bin:/bin' } });
  if (normalizedWorkspace.reason || normalizedWorkspace.exitCode !== 0) {
    const committed = await store.failBeforeDispatch({ workerId: config.workerId, claimToken: claim.claimToken,
      code: normalizedWorkspace.reason || 'workspace_permissions_failed', resultRef });
    return { phase: 'workspace', ...normalizedWorkspace, outcome: committed === true ? 'failed' : null };
  }
  if ((await atWorkerPhase('provider_measure', measureWorkspace)) > config.maxWorkspaceBytes) {
    const committed = await store.failBeforeDispatch({ workerId: config.workerId, claimToken: claim.claimToken,
      code: 'workspace_limit', resultRef });
    return { phase: 'workspace', reason: 'workspace_limit', outcome: committed === true ? 'failed' : null };
  }
  const home = await atWorkerPhase('provider_home_launch', () => runProcess(config.launcherPath,
    launcherArgs(config, config.mkdirPath, ['-m', '0700', '--', invocation.providerHome]),
    { timeoutMs: 2000, heartbeatMs: config.heartbeatMs, maxLogBytes: 4096, pulse, env: { PATH: '/usr/bin:/bin' } }));
  if (home.reason || home.exitCode !== 0) {
    const committed = await store.failBeforeDispatch({ workerId: config.workerId, claimToken: claim.claimToken,
      code: home.reason || 'provider_home_failed', resultRef });
    return { phase: 'workspace', ...home, outcome: committed === true ? 'failed' : null };
  }
  // Linux setgid parents propagate the bit even when mkdir requests 0700; the provider must clear it itself.
  const normalizedHome = await atWorkerPhase('provider_home_normalize', () => runProcess(config.launcherPath,
    launcherArgs(config, config.chmodPath, ['0700', '--', invocation.providerHome]),
    { timeoutMs: 2000, heartbeatMs: config.heartbeatMs, maxLogBytes: 4096, pulse, env: { PATH: '/usr/bin:/bin' } }));
  if (normalizedHome.reason || normalizedHome.exitCode !== 0) {
    const committed = await store.failBeforeDispatch({ workerId: config.workerId, claimToken: claim.claimToken,
      code: normalizedHome.reason || 'provider_home_permissions_failed', resultRef });
    return { phase: 'workspace', ...normalizedHome, outcome: committed === true ? 'failed' : null };
  }
  const validateProviderHome = dependencies.validateProviderHome || (() => {
    const homeStat = fs.lstatSync(invocation.providerHome);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== config.providerUid
        || homeStat.gid !== config.providerGid || (homeStat.mode & 0o0777) !== 0o700
        || (homeStat.mode & 0o1000) !== 0) throw new Error('unsafe provider home');
  });
  if (process.platform !== 'win32') await atWorkerPhase('provider_home_validate', validateProviderHome);
  if (dependencies.shouldStop?.()) {
    const released = await store.releaseBeforeDispatch(config.workerId, claim.claimToken);
    return { phase: 'workspace', reason: 'worker_shutdown', outcome: released === true ? 'queued' : null };
  }
  if (!await atWorkerPhase('start', () => store.start(config.workerId, claim.claimToken))) return { phase: 'start', reason: 'claim_not_startable' };
  const result = await runProcess(invocation.command, invocation.args,
    { cwd: invocation.workspaceRoot, timeoutMs: invocation.timeoutMs, heartbeatMs: config.heartbeatMs,
      maxLogBytes: config.maxLogBytes, pulse, env: { PATH: '/usr/bin:/bin',
        HOME: invocation.authorityHome,
        ...(process.env.TP_HARNESS_PRIVATE_DIAGNOSTICS === '1' ? { AGENT_LOOP_DEBUG: '1' } : {}) } });
  writePrivateLog(path.join(invocation.evidenceRoot, 'stdout.log'), result.stdout);
  writePrivateLog(path.join(invocation.evidenceRoot, 'stderr.log'), result.stderr);
  let terminal;
  try { terminal = classifyHarnessResult(invocation, claim, result); }
  catch { terminal = ['needs_coordination', 'invalid_harness_evidence']; }
  const committed = await store.finish({ workerId: config.workerId, claimToken: claim.claimToken, outcome: terminal[0], code: terminal[1], resultRef });
  if (committed !== true) throw new Error('terminal transition rejected');
  return { phase: 'execution', ...result, outcome: terminal[0] };
}
async function resumeClaim(store, rawConfig, rawClaim, dependencies = {}) {
  const config = validateWorkerConfig(rawConfig); const claim = validateClaim(rawClaim);
  if (!claim.resumeClaimToken) throw new Error('resume claim token is required');
  const invocation = buildSandboxInvocation(rawConfig, claim); const runId = `${claim.taskId}-${claim.resumeClaimToken}`;
  const runRoot = path.join(invocation.evidenceRoot, 'runs', runId);
  const state = readAuthorityJson(path.join(runRoot, 'state.json'), invocation.evidenceRoot);
  if (state.status !== 'spec-ready' || state.specFrozenAt) throw new Error('resume source is not awaiting specification confirmation');
  if (!await store.start(config.workerId, claim.claimToken)) return { phase: 'start', reason: 'claim_not_startable' };
  const runProcess = dependencies.runBoundedProcess || runBoundedProcess;
  const pulse = async () => {
    if (dependencies.shouldStop?.()) return { owned: false, cancel: true };
    return store.heartbeat(config.workerId, claim.claimToken);
  };
  const common = ['--workdir', invocation.workspaceRoot, '--run', runId, '--runs-dir', path.join(invocation.evidenceRoot, 'runs'),
    '--control-root', path.join(invocation.evidenceRoot, 'control')];
  const processOptions = { cwd: invocation.workspaceRoot, timeoutMs: invocation.timeoutMs, heartbeatMs: config.heartbeatMs,
    maxLogBytes: config.maxLogBytes, pulse, env: { PATH: '/usr/bin:/bin', HOME: invocation.authorityHome } };
  const freeze = await runProcess(config.nodePath,
    [config.orchestratorPath, 'freeze', ...common, '--reviewer', claim.ownerId], processOptions);
  writePrivateLog(path.join(invocation.evidenceRoot, 'freeze-stdout.log'), freeze.stdout);
  writePrivateLog(path.join(invocation.evidenceRoot, 'freeze-stderr.log'), freeze.stderr);
  if (freeze.reason || freeze.exitCode !== 0) {
    const outcome = freeze.reason === 'cancelled' ? 'cancelled' : 'needs_coordination';
    await store.finish({ workerId: config.workerId, claimToken: claim.claimToken, outcome,
      code: freeze.reason || 'freeze_failed', resultRef: `sandbox:${claim.taskId}:${claim.resumeClaimToken}` });
    return { phase: 'freeze', ...freeze, outcome };
  }
  const resumeArgs = [config.orchestratorPath, 'resume', ...common, '--external-stages', 'spec,review',
    '--external-runtime-config', config.externalRuntimeConfigPath, '--runtime-capability-evidence-file', config.runtimeCapabilityEvidencePath,
    '--capability-router', 'enforce', '--codex-command', config.codexCommandPath,
    '--provider-output-root', invocation.providerOutputRoot, '--provider-uid', String(config.providerUid),
    '--provider-gid', String(config.providerGid), '--provider-home', invocation.providerHome,
    '--provider-setpriv-path', config.launcherPath, '--require-provider-os-isolation'];
  for (const command of config.projects[claim.projectId].validationCommands) resumeArgs.push('--validation-command', command);
  const result = await runProcess(config.nodePath, resumeArgs, processOptions);
  writePrivateLog(path.join(invocation.evidenceRoot, 'resume-stdout.log'), result.stdout);
  writePrivateLog(path.join(invocation.evidenceRoot, 'resume-stderr.log'), result.stderr);
  let terminal;
  try { terminal = classifyHarnessResult(invocation, { ...claim, claimToken: claim.resumeClaimToken }, result); }
  catch { terminal = ['needs_coordination', 'invalid_harness_evidence']; }
  const resultRef = `sandbox:${claim.taskId}:${claim.resumeClaimToken}`;
  const committed = await store.finish({ workerId: config.workerId, claimToken: claim.claimToken,
    outcome: terminal[0], code: terminal[1], resultRef });
  if (committed !== true) throw new Error('terminal transition rejected');
  return { phase: 'resume', ...result, outcome: terminal[0] };
}
function classifyRecovery(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.dispatchStarted !== 'boolean') throw new Error('invalid recovery evidence');
  if (input.state === 'claimed' && input.dispatchStarted === false) return 'requeue';
  if (input.state === 'running' && input.dispatchStarted === true) return 'needs_coordination';
  if (input.state === 'cancel_requested' && input.dispatchStarted === true) return 'cancel';
  throw new Error('invalid recovery evidence');
}
function authorityDatabaseConfig(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid authority database configuration'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || url.pathname !== '/tech_persistence' || decodeURIComponent(url.username) !== 'tp_task_authority'
      || !url.password || url.search || url.hash || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new Error('authority database must use its dedicated role and loopback database');
  }
  return { host: '127.0.0.1', port: Number(url.port), database: 'tech_persistence', user: 'tp_task_authority',
    password: decodeURIComponent(url.password), ssl: false, max: 2, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000,
    statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000, application_name: 'tp-task-authority' };
}
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function safeWorkerErrorCode(error) {
  const message = String(error && error.message || '');
  const sqlState = String(error && error.code || '');
  const databaseCodes = { '42501': 'worker_database_privilege', '23514': 'worker_database_constraint',
    '23503': 'worker_database_reference', 'P0400': 'worker_database_input', 'P0503': 'worker_database_isolation',
    '57P01': 'worker_database_unavailable', ECONNREFUSED: 'worker_database_unavailable' };
  if (databaseCodes[sqlState]) return databaseCodes[sqlState];
  if (Number.isInteger(error && error.workerMeasureExit)) return `worker_provider_measure_exit_${error.workerMeasureExit}`;
  const measurementCodes = [['workspace measurement process failed', 'worker_provider_measure_process'],
    ['workspace measurement command failed', 'worker_provider_measure_command'],
    ['invalid workspace measurement', 'worker_provider_measure_output']];
  const measurementCode = measurementCodes.find(([prefix]) => message.startsWith(prefix));
  if (measurementCode) return measurementCode[1];
  const phases = new Set(['prepare', 'authority_measure', 'provider_measure', 'provider_home_launch',
    'provider_home_normalize', 'provider_home_validate', 'start']);
  if (phases.has(error && error.workerPhase)) return `worker_${error.workerPhase}`;
  const known = [
    ['invalid claim', 'worker_claim'],
    ['invalid worker config', 'worker_config'],
    ['unsafe sandbox root', 'worker_sandbox_root'],
    ['unsafe task sandbox parent', 'worker_sandbox_parent'],
    ['unsafe task sandbox directory', 'worker_sandbox_layout'],
    ['unsafe requirement file', 'worker_task_input'],
    ['task sandbox already exists', 'worker_sandbox_exists'],
    ['project is not qualified', 'worker_project_unqualified'],
    ['unsafe git system configuration', 'worker_git_config'],
    ['workspace measurement process failed', 'worker_provider_measure_process'],
    ['workspace measurement command failed', 'worker_provider_measure_command'],
    ['invalid workspace measurement', 'worker_provider_measure_output'],
  ];
  return (known.find(([prefix]) => message.startsWith(prefix)) || [null, 'worker_internal_error'])[1];
}
async function workerLoop(store, config, control = {}) {
  while (!control.stopped) {
    const claim = await store.claim(config.workerId);
    if (!claim) { await (control.delay || delay)(config.idleMs); continue; }
    try {
      const execute = claim.resumeClaimToken ? resumeClaim : runClaim;
      await execute(store, config, claim, { shouldStop: () => control.stopped });
    }
    catch (error) {
      try { await store.failBeforeDispatch({ workerId: config.workerId, claimToken: claim.claimToken,
        code: safeWorkerErrorCode(error), resultRef: `sandbox:${claim.taskId}:${claim.claimToken}` }); } catch { /* Lease recovery remains fail-closed. */ }
    }
  }
}
async function main() {
  if (process.platform !== 'linux' || process.argv.length !== 2) throw new Error('task worker is a fixed Linux service with no CLI arguments');
  const configFile = process.env.TP_TASK_WORKER_CONFIG;
  const databaseUrl = process.env.TP_TASK_DATABASE_URL;
  if (!configFile || !databaseUrl) throw new Error('task worker protected configuration is required');
  const { readProtectedJson } = require('./agent-orchestrator/external-runtime-config');
  const rawConfig = readProtectedJson(configFile);
  const config = validateWorkerConfig(rawConfig);
  if ((fs.statSync(configFile).mode & 0o077) !== 0) throw new Error('task worker config must be owner-readable only');
  validateGitConfigFile(config);
  const { Pool } = require('pg'); const { createTaskAuthorityStore } = require('./harness-web/task-authority-store');
  const pool = new Pool(authorityDatabaseConfig(databaseUrl)); pool.on('error', () => process.stderr.write('task authority database unavailable\n'));
  const control = { stopped: false };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { control.stopped = true; });
  // Each claimed task revalidates the immutable raw schema; derived validation fields must never become untrusted input.
  try { await workerLoop(createTaskAuthorityStore(pool), rawConfig, control); } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => { process.stderr.write(`task worker failed: ${error.message}\n`); process.exitCode = 1; });
module.exports = { validateWorkerConfig, validateClaim, buildSandboxInvocation, launcherArgs, prepareTaskFiles, terminateTree, runBoundedProcess,
  gitSystemConfigForProjects, validateGitConfigFile, providerDirectoryBytes, authorityDirectoryBytes, readAuthorityJson, classifyHarnessResult,
  runClaim, resumeClaim, classifyRecovery, authorityDatabaseConfig, safeWorkerErrorCode, workerLoop };
