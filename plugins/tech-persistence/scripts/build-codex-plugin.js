#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const canonicalPluginRoot = path.resolve(__dirname, '..');
let pluginRoot = canonicalPluginRoot;
const repoRoot = path.resolve(canonicalPluginRoot, '..', '..');
const RECOVERY_DIRECTORY_NAME = '.tech-persistence-publish-recovery';
const RECOVERY_ANCHOR_NAME = '.tech-persistence-publish-recovery-state.json';
const SOURCE_PROJECTION_CONTRACT = Object.freeze({
  mode: 'offline-source-projection',
  activeRuntime: 'installer-cache-only',
  liveReaderAtomicity: false,
});
const { buildPluginHookConfig } = require(path.join(repoRoot, 'scripts', 'lib', 'hook-registry'));
const {
  buildCodexPluginHookConfig,
  getCodexHookScriptNames,
} = require(path.join(repoRoot, 'scripts', 'lib', 'codex-hook-registry'));

const expectedCommands = [
  'agent-loop.md',
  'checkpoint.md',
  'compound.md',
  'evolve.md',
  'instinct-export.md',
  'instinct-import.md',
  'instinct-status.md',
  'learn.md',
  'plan.md',
  'prototype.md',
  'review.md',
  'review-learnings.md',
  'self-learning.md',
  'session-summary.md',
  'skill.md',
  'skill-diagnose.md',
  'skill-eval.md',
  'skill-improve.md',
  'skill-publish.md',
  'sprint.md',
  'test.md',
  'think.md',
  'work.md',
];

const expectedSkills = [
  'caveman',
  'caveman-commit',
  'caveman-compress',
  'caveman-help',
  'caveman-review',
  'memory',
  'continuous-learning',
  'prototype-workflow',
  'test-strategy',
  'context-handoff',
];

const expectedCommandSkillNames = expectedCommands.map((name) => path.basename(name, '.md'));
const expectedClaudeSkills = Array.from(new Set([
  ...expectedSkills,
  ...expectedCommandSkillNames,
])).sort();

if (expectedClaudeSkills.length !== expectedSkills.length + expectedCommandSkillNames.length) {
  throw new Error('Claude skill and command names must not overlap');
}

const utilityScripts = [
  'configure-shared-homunculus.js',
  'agent-orchestrator.js',
  'acceptance-postgres-authority.js',
  'acceptance-authority-os-boundary.js',
  'native-runtime-canary.js',
  'external-runtime-transport.js',
  'promote-external-runtime.js',
  'sync-runtime-transcripts.js',
  'sync-codex-transcripts.js',
  'codex-transcript-outbox.js',
  'codex-active-sprint-state.js',
  'sprint-evidence.js',
  'sync-solution-index.js',
  'update-codex-marketplace.js',
  'skill-eval-results.js',
  'skill-traces.js',
  'skill-eval-cases.js',
  'self-learning.js',
];

const replacements = [
  [/在 Claude Code runtime 下/g, '在支持 Agent spawn 的 runtime 下'],
  [/Claude Code runtime 下/g, '支持 Agent spawn 的 runtime 下'],
  [/仅对 Claude Code runtime 生效/g, '仅对支持 Agent spawn 的 runtime 生效'],
  [/Claude Code SlashCommand/g, 'non-Codex slash command'],
  [/CLAUDE\.md \/ AGENTS\.md/g, 'runtime instruction docs'],
  [/CLAUDE\.md \+ AGENTS\.md/g, 'runtime instruction docs'],
  [/CLAUDE-solutions-index/g, 'AGENTS-solutions-index'],
  [/node scripts\/archive-claude-solutions-index\.js/g, 'node scripts/archive-claude-solutions-index.js --claude-md AGENTS.md'],
  [/~\/\.claude\/homunculus/g, '~/.codex/homunculus'],
  [/~\/\.claude\/CLAUDE\.md/g, '~/.codex/AGENTS.md'],
  [/`~\/\.claude\/homunculus/g, '`~/.codex/homunculus'],
  [/~\/\.claude\/commands/g, '~/.codex commands via Tech Persistence plugin'],
  [/Claude Code/g, 'Codex'],
  [/Claude/g, 'Codex'],
  [/CLAUDE_PROJECT_DIR/g, 'CODEX_PROJECT_DIR'],
  [/CLAUDE\.md/g, 'AGENTS.md'],
  [/\.claude\/commands/g, '.codex/commands'],
  [/\.claude\/skills/g, '.codex/skills'],
  [/\.claude\/rules/g, '.codex/rules'],
  [/\.claude\/plans/g, '.codex/plans'],
  [/\.claude\/agents/g, '.codex/agents'],
  [/\.claude\//g, '.codex/'],
  [/\.claude\b/g, '.codex'],
];

const runHookJs = `#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const ALLOWED_SCRIPT_NAMES = new Set(["caveman-activate.js","codex-behavior-hook.js","codex-lifecycle-evidence.js","evaluate-session.js","guard-handoff-path-codex.js","guard-handoff-path.js","inject-context-codex.js","inject-context.js","observe.js","prompt-submit.js"]);
const DIAGNOSTIC_MAX_BYTES = 128;
const DIAGNOSTIC_CODES = new Set([
  'SCRIPT_NOT_ALLOWED',
  'SPAWN_FAILED',
  'CHILD_FAILED',
  'WRAPPER_FAILED',
]);

function writeDiagnostic(code) {
  const safeCode = DIAGNOSTIC_CODES.has(code) ? code : 'WRAPPER_FAILED';
  const bytes = Buffer.from('[run-hook] ' + safeCode + '\\n', 'utf8');
  try {
    process.stderr.write(bytes.subarray(0, DIAGNOSTIC_MAX_BYTES));
  } catch {}
}

function inferRuntime() {
  if (process.env.TECH_PERSISTENCE_RUNTIME) {
    return process.env.TECH_PERSISTENCE_RUNTIME.toLowerCase();
  }
  if (process.env.CODEX_HOME || process.env.CODEX_SESSION_ID || process.env.CODEX_PROJECT_DIR) {
    return 'codex';
  }
  if (
    process.env.CLAUDE_PLUGIN_ROOT
    || process.env.CLAUDE_SESSION_ID
    || process.env.CLAUDE_CONFIG_DIR
    || process.env.CLAUDE_PROJECT_DIR
  ) {
    return 'claude';
  }
  return 'codex';
}

function main() {
  const [, , scriptName, ...scriptArgs] = process.argv;
  if (!scriptName) return;
  if (!ALLOWED_SCRIPT_NAMES.has(scriptName)) {
    writeDiagnostic('SCRIPT_NOT_ALLOWED');
    return;
  }

  process.env.TECH_PERSISTENCE_RUNTIME = inferRuntime();
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    writeDiagnostic('SPAWN_FAILED');
    return;
  }
  if (result.signal || result.status !== 0) {
    writeDiagnostic('CHILD_FAILED');
    return;
  }
  if (result.stdout && result.stdout.length > 0) process.stdout.write(result.stdout);
}

try {
  main();
} catch {
  writeDiagnostic('WRAPPER_FAILED');
}
process.exitCode = 0;
`;

const runHookCmd = [
  '@echo off',
  'setlocal',
  'set "SCRIPT_DIR=%~dp0"',
  'node "%SCRIPT_DIR%run-hook.js" %*',
  'exit /b 0',
  '',
].join('\r\n');

// WHY: preserve the frozen legacy Claude wrapper surface while allowing the
// Codex-only SessionEnd outbox entrypoint in the Codex projection.
const codexRunHookJs = runHookJs.replace(
  '"codex-lifecycle-evidence.js",',
  '"codex-lifecycle-evidence.js","codex-transcript-outbox.js",'
);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function emptyDir(dir) {
  ensureDir(dir);
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function buildLockPath() {
  const key = crypto.createHash('sha256').update(canonicalPluginRoot).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), `tech-persistence-codex-build-${key}.lock`);
}

function inspectBuildLock(lockPath, staleMs) {
  const stat = fs.statSync(lockPath);
  const age = Date.now() - stat.mtimeMs;
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const pid = Number(owner.pid);
    return {
      removable: Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid),
      reason: 'dead-owner',
    };
  } catch {
    // A malformed lock has no trustworthy owner identity. Give a just-created
    // writer time to finish its write, then allow recovery under a separate
    // recovery mutex. Valid live owners are never evicted based on age.
    return { removable: age > staleMs, reason: 'invalid-stale-lock' };
  }
}

function tryRecoverBuildLock(lockPath, staleMs) {
  const recoveryPath = `${lockPath}.recovery`;
  let ownsRecovery = false;
  try {
    fs.writeFileSync(
      recoveryPath,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { flag: 'wx', mode: 0o600 }
    );
    ownsRecovery = true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }

  try {
    if (!fs.existsSync(lockPath)) return true;
    let inspection;
    try {
      inspection = inspectBuildLock(lockPath, staleMs);
    } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      throw error;
    }
    if (!inspection.removable) return false;
    fs.rmSync(lockPath, { force: false });
    return true;
  } finally {
    if (ownsRecovery) fs.rmSync(recoveryPath, { force: true });
  }
}

function acquireBuildLock(options = {}) {
  const lockPath = options.lockPath || buildLockPath();
  const timeoutMs = options.timeoutMs ?? 60000;
  const staleMs = options.staleMs ?? 10 * 60 * 1000;
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
        { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (current.token === token) fs.rmSync(lockPath, { force: true });
        } catch {}
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (tryRecoverBuildLock(lockPath, staleMs)) continue;
      sleepSync(50);
    }
  }
  throw new Error(`timed out waiting for Codex plugin build lock: ${lockPath}`);
}

function listTreeFiles(root, relative = '') {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`generated projection contains a symbolic link: ${absolute}`);
    if (entry.isDirectory()) files.push(...listTreeFiles(absolute, childRelative));
    else if (entry.isFile()) files.push(childRelative);
    else throw new Error(`unsupported generated projection entry: ${absolute}`);
  }
  return files;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertSafePublishTarget(target, allowedRoot) {
  const lexicalRoot = path.resolve(allowedRoot);
  const lexicalTarget = path.resolve(target);
  if (!isPathInside(lexicalRoot, lexicalTarget)) {
    throw new Error(`publish target is outside allowed publish root: ${lexicalTarget}`);
  }

  let rootStat;
  try {
    rootStat = fs.lstatSync(lexicalRoot);
  } catch (error) {
    throw new Error(`allowed publish root is unavailable: ${lexicalRoot}: ${error.message}`);
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`allowed publish root is a symbolic link or junction: ${lexicalRoot}`);
  }
  if (!rootStat.isDirectory()) throw new Error(`allowed publish root is not a directory: ${lexicalRoot}`);

  const realRoot = fs.realpathSync.native(lexicalRoot);
  let current = lexicalRoot;
  const relative = path.relative(lexicalRoot, lexicalTarget);
  const segments = relative ? relative.split(path.sep) : [];
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`publish target contains a symbolic link or junction: ${current}`);
    }
    const realCurrent = fs.realpathSync.native(current);
    if (!isPathInside(realRoot, realCurrent)) {
      throw new Error(`publish target resolves outside allowed publish root: ${current}`);
    }
  }
  return lexicalTarget;
}

function assertRegularSourceFile(source) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`publish source is a symbolic link: ${source}`);
  if (!stat.isFile()) throw new Error(`publish source is not a regular file: ${source}`);
  return stat;
}

function assertRegularSourceDirectory(source) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`publish source is a symbolic link: ${source}`);
  if (!stat.isDirectory()) throw new Error(`publish source is not a directory: ${source}`);
  listTreeFiles(source);
  return stat;
}

const ABSENT_FINGERPRINT = 'absent';
const EMPTY_DIRECTORY_FINGERPRINT = `directory:${crypto.createHash('sha256').update('').digest('hex')}`;

function fingerprintPath(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return ABSENT_FINGERPRINT;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to fingerprint symbolic link or junction: ${target}`);
  }
  if (stat.isFile()) {
    return `file:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
  }
  if (!stat.isDirectory()) throw new Error(`unsupported generated projection entry: ${target}`);

  const root = path.resolve(target);
  const records = [];
  function walk(current) {
    for (const name of fs.readdirSync(current).sort((left, right) => left.localeCompare(right))) {
      const absolute = path.join(current, name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const childStat = fs.lstatSync(absolute);
      if (childStat.isSymbolicLink()) {
        throw new Error(`refusing to fingerprint symbolic link or junction: ${absolute}`);
      }
      if (childStat.isDirectory()) {
        records.push(`d:${relative}`);
        walk(absolute);
      } else if (childStat.isFile()) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        records.push(`f:${relative}:${digest}`);
      } else {
        throw new Error(`unsupported generated projection entry: ${absolute}`);
      }
    }
  }
  walk(root);
  return `directory:${crypto.createHash('sha256').update(records.join('\n')).digest('hex')}`;
}

function shortFingerprint(value) {
  if (value === ABSENT_FINGERPRINT) return value;
  const [kind, digest = ''] = String(value).split(':');
  return `${kind}:${digest.slice(0, 12)}`;
}

function driftError(target, expected, actual, operation) {
  const error = new Error(
    `concurrent target drift detected before ${operation}: ${target} `
      + `(expected ${shortFingerprint(expected)}, actual ${shortFingerprint(actual)})`
  );
  error.code = 'TECH_PERSISTENCE_TARGET_DRIFT';
  error.target = target;
  error.expectedFingerprint = expected;
  error.actualFingerprint = actual;
  return error;
}

function assertExpectedFingerprint(target, expected, allowedRoot, operation) {
  assertSafePublishTarget(target, allowedRoot);
  const actual = fingerprintPath(target);
  if (actual !== expected) throw driftError(target, expected, actual, operation);
  return actual;
}

function pathIdentity(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`publish path contains a symbolic link or junction: ${target}`);
  }
  if (!stat.isDirectory()) throw new Error(`publish parent is not a directory: ${target}`);
  return {
    path: target,
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeMs: stat.birthtimeMs,
    realpath: fs.realpathSync.native(target),
  };
}

function captureParentPathGuard(target, allowedRoot) {
  assertSafePublishTarget(target, allowedRoot);
  const root = path.resolve(allowedRoot);
  const parent = path.dirname(path.resolve(target));
  if (!isPathInside(root, parent)) {
    throw new Error(`publish parent is outside allowed publish root: ${parent}`);
  }
  const relative = path.relative(root, parent);
  const guardedPaths = [root];
  if (relative) {
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      guardedPaths.push(current);
    }
  }
  return guardedPaths.map(pathIdentity);
}

function assertParentPathGuardUnchanged(guard, operation) {
  for (const expected of guard) {
    let actual;
    try {
      actual = pathIdentity(expected.path);
    } catch (error) {
      const guardError = new Error(
        `publish parent changed before ${operation}: ${expected.path}: ${error.message}`
      );
      guardError.code = 'TECH_PERSISTENCE_PATH_GUARD_CHANGED';
      guardError.cause = error;
      throw guardError;
    }
    if (
      actual.dev !== expected.dev
      || actual.ino !== expected.ino
      || actual.birthtimeMs !== expected.birthtimeMs
      || actual.realpath !== expected.realpath
    ) {
      const error = new Error(`publish parent changed before ${operation}: ${expected.path}`);
      error.code = 'TECH_PERSISTENCE_PATH_GUARD_CHANGED';
      throw error;
    }
  }
}

function invokeTestHook(options, name, context) {
  if (process.env.NODE_ENV !== 'test') return;
  const hook = options && options.testHooks && options.testHooks[name];
  if (typeof hook === 'function') hook(context);
}

function fsyncDirectoryIfSupported(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    // Windows does not consistently allow opening directories as fsync handles.
    // The manifest file itself is always fsynced before the atomic rename.
    const unsupported = new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'EPERM']);
    if (!error || !unsupported.has(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncTree(root) {
  if (fingerprintPath(root) === ABSENT_FINGERPRINT) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`refusing to fsync recovery symlink: ${root}`);
  if (stat.isFile()) {
    const descriptor = fs.openSync(root, process.platform === 'win32' ? 'r+' : 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return;
  }
  if (!stat.isDirectory()) throw new Error(`unsupported recovery entry: ${root}`);
  for (const entry of fs.readdirSync(root)) fsyncTree(path.join(root, entry));
  fsyncDirectoryIfSupported(root);
}

function renameDurableJsonWithRetry(
  temporary,
  target,
  parent,
  parentGuard,
  expectedTargetFingerprint
) {
  const temporaryFingerprint = fingerprintPath(temporary);
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertParentPathGuardUnchanged(parentGuard, 'durable JSON publish');
      assertExpectedFingerprint(
        temporary,
        temporaryFingerprint,
        parent,
        'durable JSON temporary publish'
      );
      assertExpectedFingerprint(
        target,
        expectedTargetFingerprint,
        parent,
        'durable JSON publish'
      );
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      const transientWindowsRename = process.platform === 'win32'
        && error
        && new Set(['EACCES', 'EBUSY', 'EPERM']).has(error.code);
      if (!transientWindowsRename || attempt === 19) throw error;
      lastError = error;
      sleepSync(25);
    }
  }
  throw lastError;
}

let durableWriteSequence = 0;
function writeJsonDurably(target, value) {
  const parent = path.dirname(target);
  ensureDir(parent);
  const parentGuard = captureParentPathGuard(target, parent);
  const expectedTargetFingerprint = fingerprintPath(target);
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.tmp-${process.pid}-${durableWriteSequence += 1}-`
      + crypto.randomBytes(8).toString('hex')
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertParentPathGuardUnchanged(parentGuard, 'durable JSON publish');
    assertSafePublishTarget(temporary, parent);
    assertSafePublishTarget(target, parent);
    assertExpectedFingerprint(
      target,
      expectedTargetFingerprint,
      parent,
      'durable JSON publish'
    );
    renameDurableJsonWithRetry(
      temporary,
      target,
      parent,
      parentGuard,
      expectedTargetFingerprint
    );
    fsyncDirectoryIfSupported(parent);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function recoveryPaths(allowedRoot) {
  const recoveryRoot = path.join(path.resolve(allowedRoot), RECOVERY_DIRECTORY_NAME);
  return {
    recoveryRoot,
    anchorPath: path.join(path.resolve(allowedRoot), RECOVERY_ANCHOR_NAME),
    manifestPath: path.join(recoveryRoot, 'manifest.json'),
    backupRoot: path.join(recoveryRoot, 'snapshots'),
    claimsRoot: path.join(recoveryRoot, 'claims'),
  };
}

function recoveryAnchorRecord(allowedRoot, transactionId, state, targets = []) {
  return {
    schemaVersion: 1,
    transactionId,
    allowedRoot: path.resolve(allowedRoot),
    allowedRootIdentity: pathIdentity(path.resolve(allowedRoot)),
    state,
    targets,
    updatedAt: new Date().toISOString(),
  };
}

function writeRecoveryAnchor(paths, value) {
  writeJsonDurably(paths.anchorPath, value);
}

function readAndValidateRecoveryAnchor(allowedRoot) {
  const paths = recoveryPaths(allowedRoot);
  if (!fs.existsSync(paths.anchorPath)) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery state anchor is missing');
  }
  let anchor;
  try {
    const stat = fs.lstatSync(paths.anchorPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('anchor is not a regular file');
    anchor = JSON.parse(fs.readFileSync(paths.anchorPath, 'utf8'));
  } catch (error) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery state anchor is unreadable', error);
  }
  assertPlainRecord(anchor, 'recovery state anchor', paths.manifestPath);
  assertExactKeys(anchor, new Set([
    'schemaVersion', 'transactionId', 'allowedRoot', 'allowedRootIdentity',
    'state', 'targets', 'updatedAt',
  ]), 'recovery state anchor', paths.manifestPath);
  if (anchor.schemaVersion !== 1
    || typeof anchor.transactionId !== 'string'
    || !/^[A-Za-z0-9-]{12,128}$/.test(anchor.transactionId)
    || anchor.allowedRoot !== path.resolve(allowedRoot)
    || !new Set(['preparing', 'active', 'cleanup-committed', 'cleanup-rolled-back'])
      .has(anchor.state)
    || !Array.isArray(anchor.targets)
    || Number.isNaN(Date.parse(anchor.updatedAt))) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery state anchor fields are invalid');
  }
  assertPlainRecord(anchor.allowedRootIdentity, 'anchor allowedRootIdentity', paths.manifestPath);
  assertExactKeys(anchor.allowedRootIdentity, new Set([
    'path', 'dev', 'ino', 'birthtimeMs', 'realpath',
  ]), 'anchor allowedRootIdentity', paths.manifestPath);
  const currentIdentity = pathIdentity(path.resolve(allowedRoot));
  if (Object.keys(currentIdentity).some(
    (key) => currentIdentity[key] !== anchor.allowedRootIdentity[key]
  )) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery state anchor root identity changed');
  }
  if ((anchor.state === 'preparing' || anchor.state === 'active') && anchor.targets.length !== 0) {
    throw recoveryRequiredError(paths.manifestPath, 'non-cleanup recovery anchor contains targets');
  }
  const targetSet = new Set();
  for (const [index, target] of anchor.targets.entries()) {
    assertPlainRecord(target, `anchor target ${index}`, paths.manifestPath);
    assertExactKeys(target, new Set(['path', 'fingerprint']), `anchor target ${index}`, paths.manifestPath);
    assertRecoveryPath(target.path, path.resolve(allowedRoot), `anchor target ${index}`, paths.manifestPath);
    if (target.path === paths.anchorPath
      || isPathInside(target.path, paths.recoveryRoot)
      || isPathInside(paths.recoveryRoot, target.path)
      || !isValidFingerprint(target.fingerprint)
      || targetSet.has(target.path)) {
      throw recoveryRequiredError(paths.manifestPath, `anchor target ${index} is invalid`);
    }
    assertSafePublishTarget(target.path, allowedRoot);
    targetSet.add(target.path);
  }
  return { ...paths, anchor };
}

function removeRecoveryAnchor(paths, allowedRoot) {
  assertSafePublishTarget(paths.anchorPath, allowedRoot);
  const expected = fingerprintPath(paths.anchorPath);
  if (expected === ABSENT_FINGERPRINT) return;
  const guard = captureParentPathGuard(paths.anchorPath, allowedRoot);
  assertParentPathGuardUnchanged(guard, 'recovery anchor cleanup');
  assertExpectedFingerprint(paths.anchorPath, expected, allowedRoot, 'recovery anchor cleanup');
  fs.unlinkSync(paths.anchorPath);
  fsyncDirectoryIfSupported(path.dirname(paths.anchorPath));
}

function removeRecoveryTree(paths, allowedRoot) {
  const expected = recoveryPaths(allowedRoot).recoveryRoot;
  if (path.resolve(paths.recoveryRoot) !== path.resolve(expected)) {
    throw new Error(`refusing unexpected recovery cleanup: ${paths.recoveryRoot}`);
  }
  assertSafePublishTarget(paths.recoveryRoot, allowedRoot);
  if (fs.existsSync(paths.recoveryRoot)) {
    fs.rmSync(paths.recoveryRoot, { recursive: true, force: true });
    fsyncDirectoryIfSupported(path.dirname(paths.recoveryRoot));
  }
}

function recoveryRequiredError(manifestPath, message, cause) {
  const error = new Error(`${message}; recovery manifest: ${manifestPath}`);
  error.code = 'TECH_PERSISTENCE_RECOVERY_REQUIRED';
  error.manifestPath = manifestPath;
  if (cause) error.cause = cause;
  return error;
}

function isValidFingerprint(value) {
  return value === ABSENT_FINGERPRINT
    || /^(?:file|directory):[0-9a-f]{64}$/.test(String(value));
}

function assertPlainRecord(value, label, manifestPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw recoveryRequiredError(manifestPath, `${label} must be a plain object`);
  }
}

function assertExactKeys(value, allowedKeys, label, manifestPath) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  const missing = [...allowedKeys].filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw recoveryRequiredError(
      manifestPath,
      `${label} keys are invalid (missing: ${missing.join(',') || 'none'}; `
        + `unexpected: ${unexpected.join(',') || 'none'})`
    );
  }
}

function assertRecoveryPath(target, parent, label, manifestPath, options = {}) {
  if (typeof target !== 'string' || target.length === 0 || path.resolve(target) !== target) {
    throw recoveryRequiredError(manifestPath, `${label} must be an absolute normalized path`);
  }
  if (!isPathInside(parent, target) || (!options.allowParent && path.resolve(target) === path.resolve(parent))) {
    throw recoveryRequiredError(manifestPath, `${label} is outside its recovery boundary`);
  }
}

function assertRecoveryTreeHasNoLinks(root, manifestPath) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    throw recoveryRequiredError(manifestPath, `recovery path is unavailable: ${root}`, error);
  }
  if (stat.isSymbolicLink()) {
    throw recoveryRequiredError(manifestPath, `recovery path is a symbolic link or junction: ${root}`);
  }
  if (stat.isFile()) return;
  if (!stat.isDirectory()) {
    throw recoveryRequiredError(manifestPath, `recovery path has an unsupported type: ${root}`);
  }
  for (const name of fs.readdirSync(root)) {
    assertRecoveryTreeHasNoLinks(path.join(root, name), manifestPath);
  }
}

function removeOrphanRecoveryTree(allowedRoot) {
  const paths = recoveryPaths(allowedRoot);
  const { anchor } = readAndValidateRecoveryAnchor(allowedRoot);
  if (anchor.state === 'active') {
    throw recoveryRequiredError(
      paths.manifestPath,
      'active recovery transaction lost its manifest; evidence was preserved'
    );
  }
  if (anchor.state === 'cleanup-committed' || anchor.state === 'cleanup-rolled-back') {
    if (anchor.targets.length === 0 || anchor.targets.some(
      (target) => fingerprintPath(target.path) !== target.fingerprint
    )) {
      throw recoveryRequiredError(
        paths.manifestPath,
        'cleanup recovery anchor does not match live target fingerprints'
      );
    }
    if (fs.existsSync(paths.recoveryRoot)) {
      assertSafePublishTarget(paths.recoveryRoot, allowedRoot);
      assertRecoveryTreeHasNoLinks(paths.recoveryRoot, paths.manifestPath);
      removeRecoveryTree(paths, allowedRoot);
    }
    removeRecoveryAnchor(paths, allowedRoot);
    return {
      action: 'finalized-manifest-less-cleanup',
      recoveryRoot: paths.recoveryRoot,
    };
  }
  if (fs.existsSync(paths.recoveryRoot)) {
    assertSafePublishTarget(paths.recoveryRoot, allowedRoot);
    assertRecoveryTreeHasNoLinks(paths.recoveryRoot, paths.manifestPath);
    const allowedEntries = new Set(['claims', 'snapshots']);
    const entries = fs.readdirSync(paths.recoveryRoot);
    const unexpected = entries.filter((name) => !allowedEntries.has(name));
    if (unexpected.length > 0) {
      throw recoveryRequiredError(
        paths.manifestPath,
        `manifest-less recovery directory contains unknown entries: ${unexpected.join(', ')}`
      );
    }
    for (const name of entries) {
      const target = path.join(paths.recoveryRoot, name);
      if (!fs.lstatSync(target).isDirectory()) {
        throw recoveryRequiredError(
          paths.manifestPath,
          `manifest-less recovery entry is not a regular directory: ${target}`
        );
      }
    }
    removeRecoveryTree(paths, allowedRoot);
  }
  removeRecoveryAnchor(paths, allowedRoot);
  return {
    action: 'removed-pre-manifest-recovery',
    recoveryRoot: paths.recoveryRoot,
  };
}

function readAndValidateRecoveryManifest(allowedRoot) {
  const safeAllowedRoot = path.resolve(allowedRoot);
  const paths = recoveryPaths(safeAllowedRoot);
  assertSafePublishTarget(paths.recoveryRoot, safeAllowedRoot);
  if (!fs.existsSync(paths.manifestPath)) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery directory exists without a manifest');
  }
  assertRecoveryTreeHasNoLinks(paths.recoveryRoot, paths.manifestPath);
  for (const [label, directory] of [
    ['snapshot root', paths.backupRoot],
    ['claim root', paths.claimsRoot],
  ]) {
    let stat;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      throw recoveryRequiredError(paths.manifestPath, `${label} is unavailable`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw recoveryRequiredError(paths.manifestPath, `${label} is not a regular directory`);
    }
  }
  if (!fs.lstatSync(paths.manifestPath).isFile()) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery manifest is not a regular file');
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'));
  } catch (error) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery manifest is unreadable', error);
  }
  assertPlainRecord(manifest, 'recovery manifest', paths.manifestPath);
  assertExactKeys(manifest, new Set([
    'schemaVersion', 'transactionId', 'allowedRoot', 'allowedRootIdentity',
    'contract', 'phase', 'sequence',
    'createdAt', 'updatedAt', 'currentOperation', 'claims', 'snapshots',
  ]), 'recovery manifest', paths.manifestPath);
  if (manifest.schemaVersion !== 1) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery manifest schemaVersion is unsupported');
  }
  if (typeof manifest.transactionId !== 'string' || !/^[A-Za-z0-9-]{12,128}$/.test(manifest.transactionId)) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery manifest transactionId is invalid');
  }
  if (manifest.allowedRoot !== safeAllowedRoot) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery manifest allowedRoot does not match');
  }
  assertPlainRecord(manifest.allowedRootIdentity, 'allowedRootIdentity', paths.manifestPath);
  assertExactKeys(manifest.allowedRootIdentity, new Set([
    'path', 'dev', 'ino', 'birthtimeMs', 'realpath',
  ]), 'allowedRootIdentity', paths.manifestPath);
  const currentAllowedRootIdentity = pathIdentity(safeAllowedRoot);
  if (Object.keys(currentAllowedRootIdentity).some(
    (key) => currentAllowedRootIdentity[key] !== manifest.allowedRootIdentity[key]
  )) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery allowedRoot identity changed');
  }
  if (manifest.contract !== SOURCE_PROJECTION_CONTRACT.mode) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery manifest contract does not match');
  }
  const fixedPhases = new Set([
    'prepared',
    'publish:directory-created',
    'publish:write-completed',
    'publish:remove-completed',
    'committed',
    'rollback:starting',
    'rollback-failed',
    'rollback:write-completed',
    'rollback:remove-completed',
    'rollback:directory-remove-completed',
    'rolled-back',
    'recovery:boundary-resolved',
    'recovery:temporary-cleaned',
    'recovery:directory-restore-starting',
    'recovery:directory-restore-completed',
    'recovery:rollback-starting',
    'recovery:rollback-failed',
  ]);
  const mutationPhase = /^(?:publish write|publish remove|publish directory|rollback write|rollback remove|rollback directory remove|recovery undo install|recovery claim restore|recovery claim release):(?:before-temporary-create|temporary-created|before-claim|claimed|before-install|installed|before-claim-release|claim-released|before-claim-delete|claim-restored|before-directory-create|directory-created|recovery-restore-prepared|recovery-restore-installed|recovery-release-prepared)$/;
  if (typeof manifest.phase !== 'string'
    || (!fixedPhases.has(manifest.phase) && !mutationPhase.test(manifest.phase))
    || !Number.isInteger(manifest.sequence) || manifest.sequence < 0
    || !Array.isArray(manifest.snapshots) || manifest.snapshots.length === 0
    || !Array.isArray(manifest.claims)) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery manifest transaction fields are invalid');
  }
  if (Number.isNaN(Date.parse(manifest.createdAt)) || Number.isNaN(Date.parse(manifest.updatedAt))) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery manifest timestamps are invalid');
  }
  if (manifest.currentOperation !== null) {
    assertPlainRecord(manifest.currentOperation, 'currentOperation', paths.manifestPath);
    const allowedOperationKeys = new Set([
      'state', 'phase', 'kind', 'target', 'claimPath', 'expectedFingerprint',
      'sourceFingerprint', 'actualFingerprint', 'temporary', 'published', 'removed',
      'publishFailure', 'rollbackFailure', 'evidencePath', 'failure',
    ]);
    const unexpectedOperationKeys = Object.keys(manifest.currentOperation)
      .filter((key) => !allowedOperationKeys.has(key));
    if (unexpectedOperationKeys.length > 0) {
      throw recoveryRequiredError(paths.manifestPath, 'currentOperation contains unknown fields');
    }
  }

  const targetSet = new Set();
  const backupSet = new Set();
  for (const [index, snapshot] of manifest.snapshots.entries()) {
    assertPlainRecord(snapshot, `snapshot ${index}`, paths.manifestPath);
    assertExactKeys(snapshot, new Set([
      'kind', 'target', 'existed', 'backup', 'expectedRoot', 'originalFingerprint',
      'expectedFingerprint', 'finalFingerprint',
    ]), `snapshot ${index}`, paths.manifestPath);
    if (snapshot.kind !== 'file' && snapshot.kind !== 'directory') {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} kind is invalid`);
    }
    if (typeof snapshot.existed !== 'boolean') {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} existed is invalid`);
    }
    assertRecoveryPath(snapshot.target, safeAllowedRoot, `snapshot ${index} target`, paths.manifestPath);
    if (isPathInside(snapshot.target, paths.recoveryRoot)
      || isPathInside(paths.recoveryRoot, snapshot.target)
      || snapshot.target === paths.anchorPath) {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} overlaps recovery evidence`);
    }
    const expectedBackup = path.join(paths.backupRoot, String(index));
    const expectedRoot = path.join(paths.backupRoot, 'expected', String(index));
    if (snapshot.backup !== expectedBackup || snapshot.expectedRoot !== expectedRoot) {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} recovery paths do not match`);
    }
    if (targetSet.has(snapshot.target) || backupSet.has(snapshot.backup)) {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} duplicates a protected path`);
    }
    targetSet.add(snapshot.target);
    backupSet.add(snapshot.backup);
    if (!isValidFingerprint(snapshot.originalFingerprint)
      || !isValidFingerprint(snapshot.expectedFingerprint)
      || (snapshot.finalFingerprint !== null && !isValidFingerprint(snapshot.finalFingerprint))) {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} fingerprints are invalid`);
    }
    if (snapshot.existed !== (snapshot.originalFingerprint !== ABSENT_FINGERPRINT)) {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} existence does not match its fingerprint`);
    }
    const backupFingerprint = fingerprintPath(snapshot.backup);
    const expectedBackupFingerprint = snapshot.existed
      ? snapshot.originalFingerprint
      : ABSENT_FINGERPRINT;
    if (backupFingerprint !== expectedBackupFingerprint) {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} backup hash does not match`);
    }
    assertSafePublishTarget(snapshot.target, safeAllowedRoot);
    const actualExpectedFingerprint = fingerprintPath(snapshot.expectedRoot);
    const operation = manifest.currentOperation;
    const operationBelongsToSnapshot = operation !== null
      && typeof operation.target === 'string'
      && (operation.target === snapshot.target
        || (snapshot.kind === 'directory' && isPathInside(snapshot.target, operation.target)));
    const liveOperationFingerprint = operationBelongsToSnapshot
      ? fingerprintPath(operation.target)
      : null;
    const operationEffectIsPresent = operationBelongsToSnapshot && (
      (isValidFingerprint(operation.sourceFingerprint)
        && liveOperationFingerprint === operation.sourceFingerprint)
      || ((operation.kind === 'remove-claim' || operation.kind === 'remove-directory')
        && liveOperationFingerprint === ABSENT_FINGERPRINT)
      || (operation.kind === 'mkdir' && liveOperationFingerprint === EMPTY_DIRECTORY_FINGERPRINT)
    );
    const pendingCoherentShadow = actualExpectedFingerprint !== snapshot.expectedFingerprint
      && operationEffectIsPresent
      && fingerprintPath(snapshot.target) === actualExpectedFingerprint;
    if (actualExpectedFingerprint !== snapshot.expectedFingerprint && !pendingCoherentShadow) {
      throw recoveryRequiredError(paths.manifestPath, `snapshot ${index} expected-state hash does not match`);
    }
  }

  const claimSet = new Set();
  const claimStatuses = new Set([
    'before-claim',
    'claimed',
    'before-claim-release',
    'before-claim-delete',
    'claim-released',
    'claim-restored',
    'recovery-restore-prepared',
    'recovery-restore-installed',
    'recovery-release-prepared',
  ]);
  for (const [index, claim] of manifest.claims.entries()) {
    assertPlainRecord(claim, `claim ${index}`, paths.manifestPath);
    assertExactKeys(claim, new Set([
      'target', 'claimPath', 'expectedFingerprint', 'claimFingerprint',
      'phase', 'status', 'updatedAt',
    ]), `claim ${index}`, paths.manifestPath);
    assertRecoveryPath(claim.target, safeAllowedRoot, `claim ${index} target`, paths.manifestPath);
    assertRecoveryPath(claim.claimPath, paths.claimsRoot, `claim ${index} path`, paths.manifestPath);
    const slot = path.dirname(claim.claimPath);
    if (path.basename(claim.claimPath) !== 'value' || path.dirname(slot) !== paths.claimsRoot) {
      throw recoveryRequiredError(paths.manifestPath, `claim ${index} path is not a canonical claim slot`);
    }
    if (!targetSet.has(claim.target) && !manifest.snapshots.some(
      (snapshot) => snapshot.kind === 'directory' && isPathInside(snapshot.target, claim.target)
    )) {
      throw recoveryRequiredError(paths.manifestPath, `claim ${index} target is outside all snapshots`);
    }
    if (claimSet.has(claim.claimPath)
      || !isValidFingerprint(claim.expectedFingerprint)
      || (claim.claimFingerprint !== null && !isValidFingerprint(claim.claimFingerprint))
      || (claim.claimFingerprint !== null && claim.claimFingerprint !== claim.expectedFingerprint)
      || typeof claim.phase !== 'string' || claim.phase.length === 0
      || !claimStatuses.has(claim.status)
      || Number.isNaN(Date.parse(claim.updatedAt))) {
      throw recoveryRequiredError(paths.manifestPath, `claim ${index} fields are invalid`);
    }
    claimSet.add(claim.claimPath);
    const actualClaimFingerprint = fingerprintPath(claim.claimPath);
    const released = claim.status === 'claim-released' || claim.status === 'claim-restored';
    if (released) {
      if (actualClaimFingerprint !== ABSENT_FINGERPRINT) {
        throw recoveryRequiredError(paths.manifestPath, `claim ${index} was released but still exists`);
      }
    } else if (claim.claimFingerprint === null) {
      if (claim.status !== 'before-claim'
        || (actualClaimFingerprint !== ABSENT_FINGERPRINT
          && actualClaimFingerprint !== claim.expectedFingerprint)) {
        throw recoveryRequiredError(paths.manifestPath, `claim ${index} appeared without a recorded hash`);
      }
    } else if (
      actualClaimFingerprint !== claim.claimFingerprint
      && !new Set([
        'before-claim-release',
        'before-claim-delete',
        'recovery-restore-prepared',
        'recovery-restore-installed',
        'recovery-release-prepared',
      ]).has(claim.status)
    ) {
      throw recoveryRequiredError(paths.manifestPath, `claim ${index} hash does not match`);
    } else if (
      actualClaimFingerprint !== ABSENT_FINGERPRINT
      && actualClaimFingerprint !== claim.claimFingerprint
    ) {
      throw recoveryRequiredError(paths.manifestPath, `claim ${index} has an invalid transitional hash`);
    }
  }

  if (manifest.currentOperation !== null) {
    const operation = manifest.currentOperation;
    if (typeof operation.state !== 'string' || typeof operation.kind !== 'string') {
      throw recoveryRequiredError(paths.manifestPath, 'currentOperation state or kind is invalid');
    }
    if (operation.target !== undefined && operation.target !== null) {
      assertRecoveryPath(
        operation.target,
        safeAllowedRoot,
        'currentOperation target',
        paths.manifestPath
      );
      if (!manifest.snapshots.some((snapshot) => (
        snapshot.target === operation.target
        || (snapshot.kind === 'directory' && isPathInside(snapshot.target, operation.target))
      ))) {
        throw recoveryRequiredError(
          paths.manifestPath,
          'currentOperation target is outside all snapshots'
        );
      }
    }
    if (operation.claimPath !== undefined && operation.claimPath !== null) {
      assertRecoveryPath(
        operation.claimPath,
        paths.claimsRoot,
        'currentOperation claimPath',
        paths.manifestPath
      );
      if (!manifest.claims.some((claim) => claim.claimPath === operation.claimPath)) {
        throw recoveryRequiredError(
          paths.manifestPath,
          'currentOperation claimPath is not present in claims'
        );
      }
    }
    if (operation.temporary !== undefined && operation.temporary !== null) {
      assertRecoveryPath(
        operation.temporary,
        safeAllowedRoot,
        'currentOperation temporary',
        paths.manifestPath
      );
      if (typeof operation.target !== 'string'
        || path.dirname(operation.temporary) !== path.dirname(operation.target)
        || !path.basename(operation.temporary).startsWith(`${path.basename(operation.target)}.tp-publish-`)) {
        throw recoveryRequiredError(
          paths.manifestPath,
          'currentOperation temporary is not adjacent to its target'
        );
      }
      const temporaryFingerprint = fingerprintPath(operation.temporary);
      if (temporaryFingerprint !== ABSENT_FINGERPRINT
        && temporaryFingerprint !== operation.sourceFingerprint) {
        throw recoveryRequiredError(
          paths.manifestPath,
          'currentOperation temporary hash does not match its source'
        );
      }
    }
    for (const key of ['expectedFingerprint', 'sourceFingerprint', 'actualFingerprint']) {
      if (operation[key] !== undefined
        && operation[key] !== null
        && !isValidFingerprint(operation[key])) {
        throw recoveryRequiredError(
          paths.manifestPath,
          `currentOperation ${key} is invalid`
        );
      }
    }
  }

  return { ...paths, allowedRoot: safeAllowedRoot, manifest };
}

function assertNoUnresolvedRecovery(allowedRoot) {
  const paths = recoveryPaths(allowedRoot);
  const recoveryExists = fs.existsSync(paths.recoveryRoot);
  const anchorExists = fs.existsSync(paths.anchorPath);
  if (!recoveryExists && !anchorExists) return;
  if (!recoveryExists || !anchorExists) {
    throw recoveryRequiredError(
      paths.manifestPath,
      'incomplete recovery state; run the builder with --recover'
    );
  }
  if (!fs.existsSync(paths.manifestPath)) {
    throw recoveryRequiredError(paths.manifestPath, 'recovery directory exists without a manifest');
  }
  const { anchor } = readAndValidateRecoveryAnchor(allowedRoot);
  if (anchor.state !== 'active') {
    throw recoveryRequiredError(paths.manifestPath, 'recovery cleanup is incomplete; run --recover');
  }
  readAndValidateRecoveryManifest(allowedRoot);
  throw recoveryRequiredError(
    paths.manifestPath,
    'unresolved source-projection transaction; run the builder with --recover'
  );
}

function initializeRecoveryContext(allowedRoot, changedPlans) {
  const paths = recoveryPaths(allowedRoot);
  for (const plan of changedPlans) {
    if (isPathInside(plan.target, paths.recoveryRoot)
      || isPathInside(paths.recoveryRoot, plan.target)
      || plan.target === paths.anchorPath) {
      throw new Error(`transaction target overlaps reserved recovery path: ${plan.target}`);
    }
  }
  const transactionId = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  writeRecoveryAnchor(
    paths,
    recoveryAnchorRecord(allowedRoot, transactionId, 'preparing')
  );
  let snapshots;
  try {
    fs.mkdirSync(paths.recoveryRoot, { mode: 0o700 });
    fs.mkdirSync(paths.backupRoot, { mode: 0o700 });
    fs.mkdirSync(paths.claimsRoot, { mode: 0o700 });
    snapshots = snapshotChangedTargets(changedPlans, paths.backupRoot, allowedRoot);
    for (const snapshot of snapshots) {
      if (snapshot.existed) fsyncTree(snapshot.backup);
    }
    fsyncDirectoryIfSupported(paths.backupRoot);
    const manifest = {
      schemaVersion: 1,
      transactionId,
      allowedRoot: path.resolve(allowedRoot),
      allowedRootIdentity: pathIdentity(path.resolve(allowedRoot)),
      contract: SOURCE_PROJECTION_CONTRACT.mode,
      phase: 'prepared',
      sequence: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentOperation: null,
      claims: [],
      snapshots: snapshots.map((snapshot) => ({
        kind: snapshot.kind,
        target: snapshot.target,
        existed: snapshot.existed,
        backup: snapshot.backup,
        expectedRoot: snapshot.expectedRoot,
        originalFingerprint: snapshot.originalFingerprint,
        expectedFingerprint: snapshot.originalFingerprint,
        finalFingerprint: null,
      })),
    };
    writeJsonDurably(paths.manifestPath, manifest);
    writeRecoveryAnchor(
      paths,
      recoveryAnchorRecord(allowedRoot, transactionId, 'active')
    );
    return { ...paths, allowedRoot, manifest, snapshots };
  } catch (error) {
    removeRecoveryTree(paths, allowedRoot);
    removeRecoveryAnchor(paths, allowedRoot);
    throw error;
  }
}

function checkpointRecovery(recovery, phase, currentOperation = null) {
  if (!recovery) return;
  recovery.manifest.phase = phase;
  recovery.manifest.sequence += 1;
  recovery.manifest.updatedAt = new Date().toISOString();
  recovery.manifest.currentOperation = currentOperation;
  writeJsonDurably(recovery.manifestPath, recovery.manifest);
}

function mergeRecoveryFailureOperation(recovery, fallbackState, details) {
  const current = recovery && recovery.manifest.currentOperation;
  if (current && typeof current.target === 'string') {
    return { ...current, ...details };
  }
  return { state: fallbackState, kind: 'rollback', ...details };
}

function updateRecoveryExpectedFingerprint(recovery, snapshot) {
  if (!recovery) return;
  const manifestSnapshot = recovery.manifest.snapshots.find(
    (candidate) => candidate.target === snapshot.target
  );
  if (!manifestSnapshot) {
    throw new Error(`recovery manifest is missing snapshot: ${snapshot.target}`);
  }
  manifestSnapshot.expectedFingerprint = fingerprintPath(snapshot.expectedRoot);
}

function checkpointMutation(options, state, context) {
  const recovery = options && options.recovery;
  if (recovery && context.claimPath) {
    const existing = recovery.manifest.claims.find(
      (claim) => claim.claimPath === context.claimPath
    );
    if (existing) {
      existing.status = state;
      if (context.actualFingerprint) existing.claimFingerprint = context.actualFingerprint;
      existing.updatedAt = new Date().toISOString();
    } else {
      recovery.manifest.claims.push({
        target: context.target,
        claimPath: context.claimPath,
        expectedFingerprint: context.expectedFingerprint || null,
        claimFingerprint: context.actualFingerprint || null,
        phase: context.phase,
        status: state,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  checkpointRecovery(recovery, `${context.phase}:${state}`, {
    state,
    phase: context.phase,
    kind: context.kind,
    target: context.target,
    claimPath: context.claimPath || null,
    expectedFingerprint: context.expectedFingerprint || null,
    sourceFingerprint: context.sourceFingerprint || null,
    actualFingerprint: context.actualFingerprint || null,
    temporary: context.temporary || null,
  });
  if (process.env.NODE_ENV === 'test'
    && process.env.TECH_PERSISTENCE_BUILD_TEST_HARD_EXIT_AFTER_CLAIM === '1'
    && state === 'claimed') {
    process.exit(88);
  }
}

function cleanupAdjacentTemporary(temporary, allowedRoot, guard) {
  try {
    assertParentPathGuardUnchanged(guard, 'temporary cleanup');
    assertSafePublishTarget(temporary, allowedRoot);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  } catch {
    // If an ancestor changed, leaving a private temporary file behind is safer
    // than following the new path and deleting an attacker's file.
  }
}

let publishSequence = 0;
function createClaimSlot(allowedRoot, options = {}) {
  let claimsRoot = options.recovery && options.recovery.claimsRoot;
  let ownsClaimsRoot = false;
  if (!claimsRoot) {
    claimsRoot = fs.mkdtempSync(path.join(allowedRoot, '.tp-publish-claims-'));
    fs.chmodSync(claimsRoot, 0o700);
    ownsClaimsRoot = true;
  }
  assertSafePublishTarget(claimsRoot, allowedRoot);
  const slot = fs.mkdtempSync(path.join(claimsRoot, 'claim-'));
  fs.chmodSync(slot, 0o700);
  const claim = {
    slot,
    path: path.join(slot, 'value'),
    claimsRoot,
    ownsClaimsRoot,
    allowedRoot,
    expectedFingerprint: null,
  };
  claim.guard = captureParentPathGuard(claim.path, allowedRoot);
  return claim;
}

function cleanupClaimSlot(claim) {
  if (!claim) return;
  assertParentPathGuardUnchanged(claim.guard, 'claim cleanup');
  assertSafePublishTarget(claim.path, claim.allowedRoot);
  if (fs.existsSync(claim.path) && claim.expectedFingerprint) {
    const actual = fingerprintPath(claim.path);
    if (actual !== claim.expectedFingerprint) {
      throw driftError(claim.path, claim.expectedFingerprint, actual, 'claim cleanup');
    }
  }
  if (fs.existsSync(claim.slot)) fs.rmSync(claim.slot, { recursive: true, force: true });
  if (claim.ownsClaimsRoot && fs.existsSync(claim.claimsRoot)) {
    fs.rmSync(claim.claimsRoot, { recursive: true, force: true });
  }
}

function retainClaimOnError(error, claim) {
  if (!claim || !fs.existsSync(claim.path)) return error;
  error.preservedPath = claim.path;
  error.claimPath = claim.path;
  return error;
}

function restoreClaimedFileNoClobber(claim, target, expectedFingerprint) {
  if (!fs.existsSync(claim.path)) return false;
  const stat = fs.lstatSync(claim.path);
  if (!stat.isFile()) return false;
  assertParentPathGuardUnchanged(claim.guard, 'claim restoration');
  assertSafePublishTarget(claim.path, claim.allowedRoot);
  assertSafePublishTarget(target, claim.allowedRoot);
  assertExpectedFingerprint(claim.path, expectedFingerprint, claim.allowedRoot, 'claim restoration source');
  assertExpectedFingerprint(target, ABSENT_FINGERPRINT, claim.allowedRoot, 'claim restoration target');
  try {
    fs.linkSync(claim.path, target);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
  const restored = fingerprintPath(target);
  if (restored !== expectedFingerprint) {
    throw driftError(target, expectedFingerprint, restored, 'claim restoration verification');
  }
  assertParentPathGuardUnchanged(claim.guard, 'claim restoration release');
  assertSafePublishTarget(claim.path, claim.allowedRoot);
  assertExpectedFingerprint(claim.path, expectedFingerprint, claim.allowedRoot, 'claim restoration release');
  assertExpectedFingerprint(target, expectedFingerprint, claim.allowedRoot, 'claim restoration release');
  fs.unlinkSync(claim.path);
  cleanupClaimSlot(claim);
  return true;
}

function claimExistingTarget(target, expectedFingerprint, allowedRoot, parentGuard, options = {}) {
  const phase = options.phase || 'claim';
  const claim = createClaimSlot(allowedRoot, options);
  claim.expectedFingerprint = expectedFingerprint;
  const context = {
    phase,
    kind: 'claim',
    target,
    claimPath: claim.path,
    expectedFingerprint,
    sourceFingerprint: options.sourceFingerprint || null,
    temporary: options.temporary || null,
  };
  checkpointMutation(options, 'before-claim', context);
  invokeTestHook(options, 'beforeTargetClaimRename', context);
  try {
    // The destination lives in a private, mode-0700 directory and does not
    // exist. The rename therefore captures whichever directory entry exists at
    // the syscall boundary instead of overwriting it in place.
    assertParentPathGuardUnchanged(parentGuard, `${phase} target claim`);
    assertParentPathGuardUnchanged(claim.guard, `${phase} claim slot`);
    assertSafePublishTarget(target, allowedRoot);
    assertSafePublishTarget(claim.path, allowedRoot);
    assertExpectedFingerprint(target, expectedFingerprint, allowedRoot, `${phase} target claim`);
    assertExpectedFingerprint(claim.path, ABSENT_FINGERPRINT, allowedRoot, `${phase} claim slot`);
    fs.renameSync(target, claim.path);
  } catch (error) {
    cleanupClaimSlot(claim);
    throw error;
  }

  const actualFingerprint = fingerprintPath(claim.path);
  checkpointMutation(options, 'claimed', { ...context, actualFingerprint });
  let parentError = null;
  try {
    assertParentPathGuardUnchanged(parentGuard, phase);
    assertSafePublishTarget(target, allowedRoot);
  } catch (error) {
    parentError = error;
  }
  if (parentError || actualFingerprint !== expectedFingerprint) {
    let restored = false;
    try {
      restored = restoreClaimedFileNoClobber(claim, target, actualFingerprint);
    } catch (restoreError) {
      parentError = parentError || restoreError;
    }
    const error = parentError || driftError(target, expectedFingerprint, actualFingerprint, phase);
    if (restored) checkpointMutation(options, 'claim-restored', context);
    if (!restored) retainClaimOnError(error, claim);
    throw error;
  }
  return claim;
}

function installPreparedFileNoClobber(temporary, target, sourceFingerprint, allowedRoot, parentGuard, options) {
  const phase = options.phase || 'publish';
  const context = {
    phase,
    kind: 'install',
    target,
    expectedFingerprint: ABSENT_FINGERPRINT,
    sourceFingerprint,
    temporary: options.temporary || null,
  };
  checkpointMutation(options, 'before-install', context);
  invokeTestHook(options, 'beforeNoClobberInstall', { ...context, temporary });
  try {
    // linkSync is an atomic create-if-absent operation on supported source
    // projection filesystems. It never replaces a concurrently created target.
    assertParentPathGuardUnchanged(parentGuard, `${phase} install`);
    assertSafePublishTarget(temporary, allowedRoot);
    assertSafePublishTarget(target, allowedRoot);
    assertExpectedFingerprint(temporary, sourceFingerprint, allowedRoot, `${phase} install source`);
    assertExpectedFingerprint(target, ABSENT_FINGERPRINT, allowedRoot, `${phase} install target`);
    fs.linkSync(temporary, target);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw driftError(target, ABSENT_FINGERPRINT, fingerprintPath(target), phase);
    }
    throw error;
  }
  checkpointMutation(options, 'installed', context);
  try {
    assertParentPathGuardUnchanged(parentGuard, phase);
    assertSafePublishTarget(target, allowedRoot);
  } catch (error) {
    // Once a parent identity changed, following the lexical target again could
    // mutate an attacker's replacement namespace. Keep recovery evidence and
    // fail closed without another path-based rename.
    throw error;
  }
}

function ensurePublishParentDirectories(target, allowedRoot, options = {}) {
  const safeAllowedRoot = path.resolve(allowedRoot);
  const targetParent = path.dirname(path.resolve(target));
  const missing = [];
  let current = targetParent;
  while (!fs.existsSync(current)) {
    if (!isPathInside(safeAllowedRoot, current) || current === safeAllowedRoot) {
      throw new Error(`publish parent is outside allowed publish root: ${current}`);
    }
    missing.push(current);
    current = path.dirname(current);
  }

  for (const directory of missing.reverse()) {
    assertSafePublishTarget(directory, safeAllowedRoot);
    assertExpectedFingerprint(
      directory,
      ABSENT_FINGERPRINT,
      safeAllowedRoot,
      `${options.phase || 'publish'} parent creation`
    );
    const parentGuard = captureParentPathGuard(directory, safeAllowedRoot);
    const context = {
      phase: options.phase || 'publish',
      kind: 'mkdir',
      target: directory,
      expectedFingerprint: ABSENT_FINGERPRINT,
    };
    checkpointMutation(options, 'before-directory-create', context);
    assertParentPathGuardUnchanged(parentGuard, `${options.phase || 'publish'} parent creation`);
    assertExpectedFingerprint(
      directory,
      ABSENT_FINGERPRINT,
      safeAllowedRoot,
      `${options.phase || 'publish'} parent creation`
    );
    fs.mkdirSync(directory);
    if (fingerprintPath(directory) !== EMPTY_DIRECTORY_FINGERPRINT) {
      throw new Error(`created publish parent is not empty: ${directory}`);
    }

    const recovery = options.recovery;
    if (recovery) {
      const snapshot = findRecoverySnapshot(
        recovery.snapshots || recovery.manifest.snapshots,
        directory
      );
      if (!snapshot) {
        throw new Error(`created publish parent has no recovery snapshot: ${directory}`);
      }
      const shadowDirectory = shadowTargetPath(snapshot, directory);
      if (fingerprintPath(shadowDirectory) !== ABSENT_FINGERPRINT) {
        throw new Error(`publish parent shadow already exists: ${shadowDirectory}`);
      }
      fs.mkdirSync(shadowDirectory);
      if (fingerprintPath(snapshot.target) !== fingerprintPath(snapshot.expectedRoot)) {
        throw new Error(`publish parent shadow verification failed: ${directory}`);
      }
      updateRecoveryExpectedFingerprint(recovery, snapshot);
    }
    checkpointMutation(options, 'directory-created', context);
  }
}

function publishFileAtomically(source, target, options = {}) {
  assertRegularSourceFile(source);
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(target));
  const sourceFingerprint = options.sourceFingerprint || fingerprintPath(source);
  const expectedFingerprint = options.expectedFingerprint ?? fingerprintPath(target);
  if (fingerprintPath(source) !== sourceFingerprint) {
    throw new Error(`publish source changed before copy: ${source}`);
  }
  assertSafePublishTarget(target, allowedRoot);
  ensurePublishParentDirectories(target, allowedRoot, options);
  // Re-check after directory creation so a pre-existing reparse point cannot be
  // hidden behind a previously missing ancestor.
  assertSafePublishTarget(target, allowedRoot);
  assertExpectedFingerprint(target, expectedFingerprint, allowedRoot, options.phase || 'publish');
  if (sourceFingerprint === expectedFingerprint) return false;
  const parentGuard = captureParentPathGuard(target, allowedRoot);
  const temporary = `${target}.tp-publish-${process.pid}-${publishSequence += 1}-`
    + crypto.randomBytes(12).toString('hex');
  assertSafePublishTarget(temporary, allowedRoot);
  let installed = false;
  let claim = null;
  try {
    const temporaryContext = {
      phase: options.phase || 'publish',
      kind: 'temporary',
      target,
      expectedFingerprint,
      sourceFingerprint,
      temporary,
    };
    checkpointMutation(options, 'before-temporary-create', temporaryContext);
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, fs.statSync(source).mode & 0o777);
    if (fingerprintPath(temporary) !== sourceFingerprint || fingerprintPath(source) !== sourceFingerprint) {
      throw new Error(`publish source changed while copying: ${source}`);
    }
    checkpointMutation(options, 'temporary-created', temporaryContext);
    assertExpectedFingerprint(target, expectedFingerprint, allowedRoot, options.phase || 'publish');
    // This hook remains before the final validation for path-swap regression
    // tests. beforeTargetClaimRename is the actual no-check syscall boundary.
    invokeTestHook(options, 'afterFinalSafetyCheck', {
      phase: options.phase || 'publish',
      source,
      target,
      temporary,
    });
    assertParentPathGuardUnchanged(parentGuard, options.phase || 'publish');
    assertSafePublishTarget(target, allowedRoot);
    assertExpectedFingerprint(target, expectedFingerprint, allowedRoot, options.phase || 'publish');
    const operationOptions = {
      ...options,
      sourceFingerprint,
      temporary,
    };
    if (expectedFingerprint !== ABSENT_FINGERPRINT) {
      claim = claimExistingTarget(
        target,
        expectedFingerprint,
        allowedRoot,
        parentGuard,
        operationOptions
      );
    }
    installPreparedFileNoClobber(
      temporary,
      target,
      sourceFingerprint,
      allowedRoot,
      parentGuard,
      operationOptions
    );
    installed = true;
    const committedFingerprint = fingerprintPath(target);
    if (committedFingerprint !== sourceFingerprint) {
      throw driftError(target, sourceFingerprint, committedFingerprint, `${options.phase || 'publish'} verification`);
    }
    if (claim) {
      checkpointMutation(options, 'before-claim-release', {
        phase: options.phase || 'publish',
        kind: 'claim-release',
        target,
        claimPath: claim.path,
        expectedFingerprint,
        sourceFingerprint,
        temporary,
      });
      cleanupClaimSlot(claim);
      checkpointMutation(options, 'claim-released', {
        phase: options.phase || 'publish',
        kind: 'claim-release',
        target,
        claimPath: claim.path,
        expectedFingerprint,
        sourceFingerprint,
        temporary,
      });
      claim = null;
    }
  } finally {
    cleanupAdjacentTemporary(temporary, allowedRoot, parentGuard);
    if (!installed && claim && fs.existsSync(claim.path) && !fs.existsSync(target)) {
      try {
        restoreClaimedFileNoClobber(claim, target, expectedFingerprint);
        checkpointMutation(options, 'claim-restored', {
          phase: options.phase || 'publish',
          kind: 'claim-restore',
          target,
          claimPath: claim.path,
          expectedFingerprint,
          sourceFingerprint,
          temporary,
        });
        claim = null;
      } catch {
        // The retained claim is referenced by the durable checkpoint/evidence.
      }
    }
  }
  return true;
}

function buildDirectoryPublishPlan(stageDir, targetDir, allowedRoot) {
  assertRegularSourceDirectory(stageDir);
  const safeTargetDir = assertSafePublishTarget(targetDir, allowedRoot);
  const targetExisted = fs.existsSync(safeTargetDir);
  if (targetExisted) {
    const targetStat = fs.lstatSync(safeTargetDir);
    if (!targetStat.isDirectory()) throw new Error(`managed target is not a directory: ${safeTargetDir}`);
  }
  const targetFingerprint = fingerprintPath(safeTargetDir);

  const expected = listTreeFiles(stageDir).map((name) => name.replace(/\\/g, '/'));
  const existing = targetExisted
    ? listTreeFiles(safeTargetDir).map((name) => name.replace(/\\/g, '/'))
    : [];
  const expectedSet = new Set(expected);
  const writes = [];
  for (const relative of expected) {
    const source = path.join(stageDir, ...relative.split('/'));
    const target = path.join(safeTargetDir, ...relative.split('/'));
    assertSafePublishTarget(target, allowedRoot);
    const sourceFingerprint = fingerprintPath(source);
    const expectedFingerprint = fingerprintPath(target);
    const isNew = expectedFingerprint === ABSENT_FINGERPRINT;
    if (sourceFingerprint !== expectedFingerprint) {
      writes.push({
        source,
        target,
        isNew,
        sourceFingerprint,
        expectedFingerprint,
        planTarget: safeTargetDir,
      });
    }
  }

  const removals = [];
  for (const relative of existing) {
    if (expectedSet.has(relative)) continue;
    const target = path.join(safeTargetDir, ...relative.split('/'));
    assertSafePublishTarget(target, allowedRoot);
    removals.push({
      target,
      expectedFingerprint: fingerprintPath(target),
      planTarget: safeTargetDir,
    });
  }

  return {
    kind: 'directory',
    target: safeTargetDir,
    targetExisted,
    targetFingerprint,
    writes,
    removals,
    changed: !targetExisted || writes.length > 0 || removals.length > 0,
  };
}

function buildFilePublishPlan(source, target, allowedRoot) {
  assertRegularSourceFile(source);
  const safeTarget = assertSafePublishTarget(target, allowedRoot);
  const targetExisted = fs.existsSync(safeTarget);
  if (targetExisted) {
    const targetStat = fs.lstatSync(safeTarget);
    if (!targetStat.isFile()) throw new Error(`managed target is not a regular file: ${safeTarget}`);
  }
  const sourceFingerprint = fingerprintPath(source);
  const targetFingerprint = fingerprintPath(safeTarget);
  const changed = sourceFingerprint !== targetFingerprint;
  return {
    kind: 'file',
    target: safeTarget,
    targetExisted,
    targetFingerprint,
    writes: changed ? [{
      source,
      target: safeTarget,
      isNew: !targetExisted,
      sourceFingerprint,
      expectedFingerprint: targetFingerprint,
      planTarget: safeTarget,
    }] : [],
    removals: [],
    changed,
  };
}

function assertNonOverlappingPlans(plans) {
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const left = plans[leftIndex];
      const right = plans[rightIndex];
      if (left.target === right.target) {
        throw new Error(`duplicate transaction target: ${left.target}`);
      }
      if (left.kind === 'directory' && isPathInside(left.target, right.target)) {
        throw new Error(`overlapping transaction targets: ${left.target} and ${right.target}`);
      }
      if (right.kind === 'directory' && isPathInside(right.target, left.target)) {
        throw new Error(`overlapping transaction targets: ${left.target} and ${right.target}`);
      }
    }
  }
}

function copyTreeStrict(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`refusing to snapshot symbolic link: ${source}`);
  if (stat.isFile()) {
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
    fs.chmodSync(target, stat.mode & 0o777);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`unsupported snapshot entry: ${source}`);
  fs.mkdirSync(target, { recursive: true });
  fs.chmodSync(target, stat.mode & 0o777);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const childSource = path.join(source, entry.name);
    const childTarget = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to snapshot symbolic link: ${childSource}`);
    copyTreeStrict(childSource, childTarget);
  }
}

function snapshotChangedTargets(plans, backupRoot, allowedRoot) {
  return plans.filter((plan) => plan.changed).map((plan, index) => {
    const backup = path.join(backupRoot, String(index));
    const expectedRoot = path.join(backupRoot, 'expected', String(index));
    assertExpectedFingerprint(plan.target, plan.targetFingerprint, allowedRoot, 'snapshot');
    if (plan.targetExisted) copyTreeStrict(plan.target, backup);
    assertExpectedFingerprint(plan.target, plan.targetFingerprint, allowedRoot, 'snapshot verification');
    if (plan.targetExisted && fingerprintPath(backup) !== plan.targetFingerprint) {
      throw new Error(`snapshot verification failed for ${plan.target}`);
    }
    if (plan.targetExisted) copyTreeStrict(backup, expectedRoot);
    return {
      plan,
      kind: plan.kind,
      target: plan.target,
      existed: plan.targetExisted,
      originalFingerprint: plan.targetFingerprint,
      backup,
      expectedRoot,
    };
  });
}

function removeExistingTarget(target, allowedRoot, options = {}) {
  const expectedFingerprint = options.expectedFingerprint ?? fingerprintPath(target);
  assertExpectedFingerprint(target, expectedFingerprint, allowedRoot, options.phase || 'remove');
  if (expectedFingerprint === ABSENT_FINGERPRINT) return false;
  const parentGuard = captureParentPathGuard(target, allowedRoot);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`refusing to remove generated symlink: ${target}`);
  if (stat.isDirectory() && fs.readdirSync(target).length > 0) {
    throw new Error(`refusing to remove non-empty generated directory: ${target}`);
  }
  assertSafePublishTarget(target, allowedRoot);
  invokeTestHook(options, 'afterFinalRemoveSafetyCheck', {
    phase: options.phase || 'remove',
    target,
  });
  assertParentPathGuardUnchanged(parentGuard, options.phase || 'remove');
  assertExpectedFingerprint(target, expectedFingerprint, allowedRoot, options.phase || 'remove');
  const claim = claimExistingTarget(target, expectedFingerprint, allowedRoot, parentGuard, options);
  const replacementFingerprint = fingerprintPath(target);
  if (replacementFingerprint !== ABSENT_FINGERPRINT) {
    const error = driftError(
      target,
      ABSENT_FINGERPRINT,
      replacementFingerprint,
      `${options.phase || 'remove'} no-clobber verification`
    );
    retainClaimOnError(error, claim);
    throw error;
  }
  checkpointMutation(options, 'before-claim-delete', {
    phase: options.phase || 'remove',
    kind: 'remove-claim',
    target,
    claimPath: claim.path,
    expectedFingerprint,
  });
  cleanupClaimSlot(claim);
  checkpointMutation(options, 'claim-released', {
    phase: options.phase || 'remove',
    kind: 'remove-claim',
    target,
    claimPath: claim.path,
    expectedFingerprint,
  });
  return true;
}

function shadowTargetPath(snapshot, target) {
  if (snapshot.kind === 'file') return snapshot.expectedRoot;
  const relative = path.relative(snapshot.target, target);
  if (!isPathInside(snapshot.target, target)) {
    throw new Error(`rollback target is outside snapshot root: ${target}`);
  }
  return relative ? path.join(snapshot.expectedRoot, relative) : snapshot.expectedRoot;
}

function updateShadowAfterWrite(snapshot, operation) {
  const shadowTarget = shadowTargetPath(snapshot, operation.target);
  assertRegularSourceFile(operation.source);
  ensureDir(path.dirname(shadowTarget));
  fs.copyFileSync(operation.source, shadowTarget);
  fs.chmodSync(shadowTarget, fs.statSync(operation.source).mode & 0o777);
  if (fingerprintPath(shadowTarget) !== operation.sourceFingerprint) {
    throw new Error(`transaction shadow write verification failed: ${operation.target}`);
  }
}

function updateShadowAfterRemoval(snapshot, target) {
  const shadowTarget = shadowTargetPath(snapshot, target);
  if (fingerprintPath(shadowTarget) === ABSENT_FINGERPRINT) return;
  const stat = fs.lstatSync(shadowTarget);
  if (stat.isDirectory()) fs.rmdirSync(shadowTarget);
  else fs.rmSync(shadowTarget, { force: false });
}

function collectDirectoryState(root) {
  if (fingerprintPath(root) === ABSENT_FINGERPRINT) {
    return { exists: false, directories: new Set(), files: new Map() };
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) throw new Error(`rollback projection is not a directory: ${root}`);
  const directories = new Set(['']);
  const files = new Map();
  function walk(current, relativeRoot) {
    for (const name of fs.readdirSync(current).sort((left, right) => left.localeCompare(right))) {
      const absolute = path.join(current, name);
      const relative = relativeRoot ? path.join(relativeRoot, name) : name;
      const childStat = fs.lstatSync(absolute);
      if (childStat.isSymbolicLink()) {
        throw new Error(`rollback projection contains a symbolic link or junction: ${absolute}`);
      }
      if (childStat.isDirectory()) {
        directories.add(relative);
        walk(absolute, relative);
      } else if (childStat.isFile()) {
        files.set(relative, fingerprintPath(absolute));
      } else {
        throw new Error(`unsupported rollback projection entry: ${absolute}`);
      }
    }
  }
  walk(root, '');
  return { exists: true, directories, files };
}

function prepareRollbackPlan(snapshots, backupRoot, allowedRoot) {
  const preparedRoot = path.join(backupRoot, 'prepared-restore');
  ensureDir(preparedRoot);
  const writes = [];
  const removals = [];
  const directoryRemovals = [];

  for (const [index, snapshot] of snapshots.entries()) {
    const prepared = path.join(preparedRoot, String(index));
    if (snapshot.existed) copyTreeStrict(snapshot.backup, prepared);
    if (fingerprintPath(prepared) !== snapshot.originalFingerprint) {
      throw new Error(`prepared rollback tree verification failed: ${snapshot.target}`);
    }
    const expectedLiveFingerprint = fingerprintPath(snapshot.expectedRoot);
    assertExpectedFingerprint(
      snapshot.target,
      expectedLiveFingerprint,
      allowedRoot,
      'rollback preflight'
    );

    if (snapshot.kind === 'file') {
      if (snapshot.existed) {
        const sourceFingerprint = fingerprintPath(prepared);
        if (sourceFingerprint !== expectedLiveFingerprint) {
          writes.push({
            source: prepared,
            target: snapshot.target,
            sourceFingerprint,
            expectedFingerprint: expectedLiveFingerprint,
            isNew: expectedLiveFingerprint === ABSENT_FINGERPRINT,
            snapshot,
          });
        }
      } else if (expectedLiveFingerprint !== ABSENT_FINGERPRINT) {
        removals.push({
          target: snapshot.target,
          expectedFingerprint: expectedLiveFingerprint,
          snapshot,
        });
      }
      continue;
    }

    const desired = collectDirectoryState(prepared);
    const current = collectDirectoryState(snapshot.expectedRoot);
    for (const [relative, sourceFingerprint] of desired.files.entries()) {
      const expectedFingerprint = current.files.get(relative) || ABSENT_FINGERPRINT;
      if (sourceFingerprint === expectedFingerprint) continue;
      writes.push({
        source: path.join(prepared, relative),
        target: path.join(snapshot.target, relative),
        sourceFingerprint,
        expectedFingerprint,
        isNew: expectedFingerprint === ABSENT_FINGERPRINT,
        snapshot,
      });
    }
    for (const [relative, expectedFingerprint] of current.files.entries()) {
      if (desired.files.has(relative)) continue;
      removals.push({
        target: path.join(snapshot.target, relative),
        expectedFingerprint,
        snapshot,
      });
    }
    for (const relative of current.directories) {
      if (desired.directories.has(relative)) continue;
      directoryRemovals.push({
        target: relative ? path.join(snapshot.target, relative) : snapshot.target,
        relative,
        snapshot,
      });
    }
  }

  return { preparedRoot, writes, removals, directoryRemovals };
}

function restoreSnapshots(snapshots, backupRoot, allowedRoot, options = {}) {
  try {
    const rollback = prepareRollbackPlan(snapshots, backupRoot, allowedRoot);
    invokeTestHook(options, 'afterRollbackPreflight', { snapshots, rollback });
    const writes = rollback.writes.sort((left, right) => {
      const priority = publicationPriority(left) - publicationPriority(right);
      return priority || left.target.localeCompare(right.target);
    });
    for (const operation of writes) {
      invokeTestHook(options, 'beforeRollbackOperation', { kind: 'write', operation });
      publishFileAtomically(operation.source, operation.target, {
        allowedRoot,
        expectedFingerprint: operation.expectedFingerprint,
        sourceFingerprint: operation.sourceFingerprint,
        phase: 'rollback write',
        testHooks: options.testHooks,
        recovery: options.recovery,
      });
      updateShadowAfterWrite(operation.snapshot, operation);
      updateRecoveryExpectedFingerprint(options.recovery, operation.snapshot);
      checkpointRecovery(options.recovery, 'rollback:write-completed', {
        state: 'completed',
        kind: 'write',
        target: operation.target,
      });
    }

    const removals = rollback.removals.sort((left, right) => {
      const priority = publicationPriority(right) - publicationPriority(left);
      return priority || left.target.localeCompare(right.target);
    });
    for (const operation of removals) {
      invokeTestHook(options, 'beforeRollbackOperation', { kind: 'remove', operation });
      removeExistingTarget(operation.target, allowedRoot, {
        expectedFingerprint: operation.expectedFingerprint,
        phase: 'rollback remove',
        testHooks: options.testHooks,
        recovery: options.recovery,
      });
      updateShadowAfterRemoval(operation.snapshot, operation.target);
      updateRecoveryExpectedFingerprint(options.recovery, operation.snapshot);
      checkpointRecovery(options.recovery, 'rollback:remove-completed', {
        state: 'completed',
        kind: 'remove',
        target: operation.target,
      });
    }

    const directoryRemovals = rollback.directoryRemovals.sort((left, right) => {
      const leftDepth = left.relative ? left.relative.split(path.sep).length : 0;
      const rightDepth = right.relative ? right.relative.split(path.sep).length : 0;
      const depth = rightDepth - leftDepth;
      return depth || left.target.localeCompare(right.target);
    });
    for (const operation of directoryRemovals) {
      const shadowTarget = shadowTargetPath(operation.snapshot, operation.target);
      const expectedFingerprint = fingerprintPath(shadowTarget);
      invokeTestHook(options, 'beforeRollbackOperation', { kind: 'remove-directory', operation });
      removeExistingTarget(operation.target, allowedRoot, {
        expectedFingerprint,
        phase: 'rollback directory remove',
        testHooks: options.testHooks,
        recovery: options.recovery,
      });
      updateShadowAfterRemoval(operation.snapshot, operation.target);
      updateRecoveryExpectedFingerprint(options.recovery, operation.snapshot);
      checkpointRecovery(options.recovery, 'rollback:directory-remove-completed', {
        state: 'completed',
        kind: 'remove-directory',
        target: operation.target,
      });
    }

    for (const snapshot of snapshots) {
      assertExpectedFingerprint(
        snapshot.target,
        snapshot.originalFingerprint,
        allowedRoot,
        'rollback final verification'
      );
      if (fingerprintPath(snapshot.expectedRoot) !== snapshot.originalFingerprint) {
        throw new Error(`rollback shadow verification failed: ${snapshot.target}`);
      }
    }
    return { ok: true, errors: [] };
  } catch (error) {
    return {
      ok: false,
      error,
      errors: [`${error.target || 'rollback'}: ${error.message}`],
    };
  }
}

function findRecoverySnapshot(snapshots, target) {
  return snapshots.find((snapshot) => (
    snapshot.target === target
    || (snapshot.kind === 'directory' && isPathInside(snapshot.target, target))
  ));
}

function runtimeRecoveryClaim(recovery, claimRecord) {
  const slot = path.dirname(claimRecord.claimPath);
  const claim = {
    slot,
    path: claimRecord.claimPath,
    claimsRoot: recovery.claimsRoot,
    ownsClaimsRoot: false,
    allowedRoot: recovery.allowedRoot,
    expectedFingerprint: claimRecord.claimFingerprint || claimRecord.expectedFingerprint,
  };
  claim.guard = captureParentPathGuard(claim.path, recovery.allowedRoot);
  return claim;
}

function checkpointRecoveryClaim(recovery, claimRecord, state, phase, actualFingerprint = null) {
  checkpointMutation({ recovery }, state, {
    phase,
    kind: 'recovery-claim',
    target: claimRecord.target,
    claimPath: claimRecord.claimPath,
    expectedFingerprint: claimRecord.expectedFingerprint,
    actualFingerprint,
  });
}

function releaseRecoveryClaim(recovery, claimRecord, finalState = 'claim-released') {
  const actual = fingerprintPath(claimRecord.claimPath);
  if (actual === ABSENT_FINGERPRINT) {
    checkpointRecoveryClaim(
      recovery,
      claimRecord,
      finalState,
      'recovery claim release'
    );
    return;
  }
  const expected = claimRecord.claimFingerprint || claimRecord.expectedFingerprint;
  if (actual !== expected) {
    throw recoveryFailure(
      recovery,
      `claim changed before recovery release: ${claimRecord.claimPath}`
    );
  }
  checkpointRecoveryClaim(
    recovery,
    claimRecord,
    'recovery-release-prepared',
    'recovery claim release',
    actual
  );
  const claim = runtimeRecoveryClaim(recovery, claimRecord);
  claim.expectedFingerprint = actual;
  cleanupClaimSlot(claim);
  checkpointRecoveryClaim(
    recovery,
    claimRecord,
    finalState,
    'recovery claim release'
  );
}

function restoreRecoveryClaim(recovery, claimRecord, target, desiredFingerprint) {
  let liveFingerprint = fingerprintPath(target);
  let claimFingerprint = fingerprintPath(claimRecord.claimPath);
  if (liveFingerprint !== ABSENT_FINGERPRINT && liveFingerprint !== desiredFingerprint) {
    throw recoveryFailure(
      recovery,
      `target changed before claim restoration: ${target}`
    );
  }
  if (claimFingerprint !== ABSENT_FINGERPRINT && claimFingerprint !== desiredFingerprint) {
    throw recoveryFailure(
      recovery,
      `claim does not contain the checkpointed target: ${claimRecord.claimPath}`
    );
  }
  if (liveFingerprint === ABSENT_FINGERPRINT && claimFingerprint === ABSENT_FINGERPRINT) {
    throw recoveryFailure(recovery, `both target and recovery claim are absent: ${target}`);
  }

  checkpointRecoveryClaim(
    recovery,
    claimRecord,
    'recovery-restore-prepared',
    'recovery claim restore',
    claimFingerprint === ABSENT_FINGERPRINT ? null : claimFingerprint
  );
  if (liveFingerprint === ABSENT_FINGERPRINT) {
    const claimStat = fs.lstatSync(claimRecord.claimPath);
    const targetGuard = captureParentPathGuard(target, recovery.allowedRoot);
    assertParentPathGuardUnchanged(targetGuard, 'recovery claim restoration');
    assertExpectedFingerprint(target, ABSENT_FINGERPRINT, recovery.allowedRoot, 'recovery claim restoration');
    if (claimStat.isFile()) {
      fs.linkSync(claimRecord.claimPath, target);
    } else if (claimStat.isDirectory() && fs.readdirSync(claimRecord.claimPath).length === 0) {
      fs.mkdirSync(target);
    } else {
      throw recoveryFailure(recovery, `unsupported recovery claim type: ${claimRecord.claimPath}`);
    }
    liveFingerprint = fingerprintPath(target);
    if (liveFingerprint !== desiredFingerprint) {
      throw recoveryFailure(recovery, `claim restoration verification failed: ${target}`);
    }
  }
  checkpointRecoveryClaim(
    recovery,
    claimRecord,
    'recovery-restore-installed',
    'recovery claim restore',
    claimFingerprint === ABSENT_FINGERPRINT ? null : claimFingerprint
  );
  claimFingerprint = fingerprintPath(claimRecord.claimPath);
  if (claimFingerprint !== ABSENT_FINGERPRINT) {
    releaseRecoveryClaim(recovery, claimRecord, 'claim-restored');
  } else {
    checkpointRecoveryClaim(
      recovery,
      claimRecord,
      'claim-restored',
      'recovery claim restore'
    );
  }
}

function operationEffectMatches(operation, actualFingerprint) {
  if (actualFingerprint === ABSENT_FINGERPRINT) {
    return operation.kind === 'claim'
      || operation.kind === 'remove-claim'
      || operation.kind === 'remove-directory'
      || operation.kind === 'install';
  }
  return (isValidFingerprint(operation.sourceFingerprint)
      && actualFingerprint === operation.sourceFingerprint)
    || (isValidFingerprint(operation.expectedFingerprint)
      && actualFingerprint === operation.expectedFingerprint)
    || operation.kind === 'mkdir';
}

function listSnapshotCheckpointDifferences(snapshot) {
  if (fingerprintPath(snapshot.target) === fingerprintPath(snapshot.expectedRoot)) return [];
  if (snapshot.kind === 'file') return [snapshot.target];

  const live = collectDirectoryState(snapshot.target);
  const expected = collectDirectoryState(snapshot.expectedRoot);
  if (live.exists !== expected.exists) return [snapshot.target];

  const differences = new Set();
  for (const relative of new Set([...live.directories, ...expected.directories])) {
    if (live.directories.has(relative) !== expected.directories.has(relative)) {
      differences.add(relative ? path.join(snapshot.target, relative) : snapshot.target);
    }
  }
  for (const relative of new Set([...live.files.keys(), ...expected.files.keys()])) {
    if (live.files.get(relative) !== expected.files.get(relative)) {
      differences.add(path.join(snapshot.target, relative));
    }
  }
  return [...differences].sort((left, right) => left.localeCompare(right));
}

function inferLegacyRollbackOperation(recovery, snapshots) {
  const current = recovery.manifest.currentOperation;
  if (current && typeof current.target === 'string') return current;
  if (recovery.manifest.phase !== 'rollback-failed'
    && recovery.manifest.phase !== 'recovery:rollback-failed') {
    return current;
  }

  const differences = snapshots.flatMap(listSnapshotCheckpointDifferences);
  if (differences.length === 0) return current;
  const candidates = [];
  for (const claim of recovery.manifest.claims) {
    if (claim.status !== 'before-claim-release' && claim.status !== 'before-claim-delete') continue;
    const snapshot = findRecoverySnapshot(snapshots, claim.target);
    if (!snapshot) continue;
    const checkpointFingerprint = fingerprintPath(shadowTargetPath(snapshot, claim.target));
    const claimFingerprint = fingerprintPath(claim.claimPath);
    if (claimFingerprint !== checkpointFingerprint
      || claim.expectedFingerprint !== checkpointFingerprint) {
      continue;
    }
    const liveFingerprint = fingerprintPath(claim.target);
    if (claim.status === 'before-claim-release') {
      if (!liveFingerprint.startsWith('file:') || liveFingerprint === checkpointFingerprint) continue;
      candidates.push({
        claim,
        liveFingerprint,
        kind: 'claim-release',
        sourceFingerprint: liveFingerprint,
      });
    } else if (liveFingerprint === ABSENT_FINGERPRINT) {
      candidates.push({
        claim,
        liveFingerprint,
        kind: 'remove-claim',
        sourceFingerprint: null,
      });
    }
  }

  if (candidates.length !== 1) {
    const reason = candidates.length > 1 ? 'ambiguous legacy recovery claims' : 'unexplained checkpoint drift';
    throw recoveryFailure(recovery, reason);
  }
  const [{ claim, liveFingerprint, kind, sourceFingerprint }] = candidates;
  if (differences.length !== 1 || differences[0] !== claim.target) {
    throw recoveryFailure(recovery, 'unexplained checkpoint drift outside the legacy recovery claim');
  }

  const inferred = {
    state: claim.status,
    phase: claim.phase,
    kind,
    target: claim.target,
    claimPath: claim.claimPath,
    expectedFingerprint: claim.expectedFingerprint,
    sourceFingerprint,
    actualFingerprint: liveFingerprint,
    temporary: null,
  };
  for (const key of ['publishFailure', 'rollbackFailure', 'evidencePath', 'failure']) {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) inferred[key] = current[key];
  }
  checkpointRecovery(recovery, 'recovery:boundary-resolved', inferred);
  return inferred;
}

function cleanupRecoveryTemporary(recovery) {
  const operation = recovery.manifest.currentOperation;
  if (!operation || typeof operation.temporary !== 'string') return;
  const actual = fingerprintPath(operation.temporary);
  if (actual !== ABSENT_FINGERPRINT) {
    if (!isValidFingerprint(operation.sourceFingerprint)
      || actual !== operation.sourceFingerprint) {
      throw recoveryFailure(
        recovery,
        `temporary publish file changed before recovery cleanup: ${operation.temporary}`
      );
    }
    const guard = captureParentPathGuard(operation.temporary, recovery.allowedRoot);
    assertParentPathGuardUnchanged(guard, 'recovery temporary cleanup');
    assertSafePublishTarget(operation.temporary, recovery.allowedRoot);
    assertExpectedFingerprint(
      operation.temporary,
      operation.sourceFingerprint,
      recovery.allowedRoot,
      'recovery temporary cleanup'
    );
    fs.unlinkSync(operation.temporary);
  }
  checkpointRecovery(recovery, 'recovery:temporary-cleaned', {
    ...operation,
    state: 'temporary-cleaned',
  });
}

function adoptCoherentPendingShadow(recovery, snapshots) {
  const operation = recovery.manifest.currentOperation;
  if (!operation || typeof operation.target !== 'string') return;
  const snapshot = findRecoverySnapshot(snapshots, operation.target);
  if (!snapshot) return;
  const manifestSnapshot = recovery.manifest.snapshots.find(
    (candidate) => candidate.target === snapshot.target
  );
  const actualExpected = fingerprintPath(snapshot.expectedRoot);
  if (actualExpected === manifestSnapshot.expectedFingerprint) return;
  const liveOperation = fingerprintPath(operation.target);
  if (!operationEffectMatches(operation, liveOperation)
    || fingerprintPath(snapshot.target) !== actualExpected) {
    throw recoveryFailure(
      recovery,
      `shadow changed without a coherent live operation: ${snapshot.target}`
    );
  }
  manifestSnapshot.expectedFingerprint = actualExpected;
  checkpointRecovery(recovery, 'recovery:boundary-resolved', {
    state: 'adopted-coherent-shadow',
    kind: 'recovery',
    target: operation.target,
  });
}

function restoreOperationToCheckpoint(recovery, snapshots) {
  const operation = recovery.manifest.currentOperation;
  if (!operation || typeof operation.target !== 'string') return;
  const snapshot = findRecoverySnapshot(snapshots, operation.target);
  if (!snapshot) {
    throw recoveryFailure(recovery, `operation target has no snapshot: ${operation.target}`);
  }
  const desiredPath = shadowTargetPath(snapshot, operation.target);
  const desiredFingerprint = fingerprintPath(desiredPath);
  let liveFingerprint = fingerprintPath(operation.target);
  if (liveFingerprint !== desiredFingerprint && !operationEffectMatches(operation, liveFingerprint)) {
    const matchingClaim = recovery.manifest.claims.some((claim) => (
      claim.target === operation.target
      && claim.expectedFingerprint === liveFingerprint
    ));
    if (!matchingClaim) {
      throw recoveryFailure(
        recovery,
        `live operation state is not explained by its durable checkpoint: ${operation.target}`
      );
    }
  }

  if (liveFingerprint !== desiredFingerprint) {
    const restorableClaim = recovery.manifest.claims.find((claim) => (
      claim.target === operation.target
      && fingerprintPath(claim.claimPath) === desiredFingerprint
    ));
    if (liveFingerprint === ABSENT_FINGERPRINT && restorableClaim) {
      restoreRecoveryClaim(
        recovery,
        restorableClaim,
        operation.target,
        desiredFingerprint
      );
    } else if (desiredFingerprint === ABSENT_FINGERPRINT) {
      removeExistingTarget(operation.target, recovery.allowedRoot, {
        expectedFingerprint: liveFingerprint,
        phase: 'recovery undo install',
        recovery,
      });
    } else if (desiredFingerprint.startsWith('file:')) {
      publishFileAtomically(desiredPath, operation.target, {
        allowedRoot: recovery.allowedRoot,
        expectedFingerprint: liveFingerprint,
        sourceFingerprint: desiredFingerprint,
        phase: 'recovery undo install',
        recovery,
      });
    } else if (desiredFingerprint === EMPTY_DIRECTORY_FINGERPRINT
      && liveFingerprint === ABSENT_FINGERPRINT) {
      checkpointRecovery(recovery, 'recovery:directory-restore-starting', {
        state: 'starting',
        kind: 'recovery',
        target: operation.target,
      });
      const parentGuard = captureParentPathGuard(operation.target, recovery.allowedRoot);
      assertParentPathGuardUnchanged(parentGuard, 'recovery directory restoration');
      assertExpectedFingerprint(
        operation.target,
        ABSENT_FINGERPRINT,
        recovery.allowedRoot,
        'recovery directory restoration'
      );
      fs.mkdirSync(operation.target);
      checkpointRecovery(recovery, 'recovery:directory-restore-completed', {
        state: 'completed',
        kind: 'recovery',
        target: operation.target,
      });
    } else {
      throw recoveryFailure(
        recovery,
        `cannot safely restore operation checkpoint: ${operation.target}`
      );
    }
  }

  liveFingerprint = fingerprintPath(operation.target);
  if (liveFingerprint !== desiredFingerprint) {
    throw recoveryFailure(recovery, `operation checkpoint restoration failed: ${operation.target}`);
  }
  if (fingerprintPath(snapshot.target) !== fingerprintPath(snapshot.expectedRoot)) {
    throw recoveryFailure(recovery, `snapshot did not return to its checkpoint: ${snapshot.target}`);
  }
}

function settleRecoveryClaims(recovery, snapshots) {
  const allSnapshotsMatch = snapshots.every(
    (snapshot) => fingerprintPath(snapshot.target) === fingerprintPath(snapshot.expectedRoot)
  );
  if (!allSnapshotsMatch) {
    throw recoveryFailure(recovery, 'cannot release claims before every snapshot matches its checkpoint');
  }
  for (const claimRecord of recovery.manifest.claims) {
    const actual = fingerprintPath(claimRecord.claimPath);
    if (actual === ABSENT_FINGERPRINT
      && (claimRecord.status === 'claim-released' || claimRecord.status === 'claim-restored')) {
      continue;
    }
    releaseRecoveryClaim(recovery, claimRecord);
  }
}

function finalizeRecoveryCleanup(recovery, cleanupState) {
  const anchorState = cleanupState === 'committed'
    ? 'cleanup-committed'
    : 'cleanup-rolled-back';
  const expectedKey = cleanupState === 'committed'
    ? 'finalFingerprint'
    : 'originalFingerprint';
  const targets = recovery.manifest.snapshots.map((snapshot) => {
    const expected = snapshot[expectedKey];
    const actual = fingerprintPath(snapshot.target);
    if (!isValidFingerprint(expected) || actual !== expected) {
      throw recoveryRequiredError(
        recovery.manifestPath,
        `cannot finalize ${cleanupState} recovery with target drift: ${snapshot.target}`
      );
    }
    return { path: snapshot.target, fingerprint: actual };
  });
  writeRecoveryAnchor(
    recovery,
    recoveryAnchorRecord(
      recovery.allowedRoot,
      recovery.manifest.transactionId,
      anchorState,
      targets
    )
  );
  removeRecoveryTree(recovery, recovery.allowedRoot);
  removeRecoveryAnchor(recovery, recovery.allowedRoot);
}

function recoveryFailure(context, message, cause) {
  return recoveryRequiredError(
    context.manifestPath,
    `${message}; recovery evidence was preserved`,
    cause
  );
}

function recoverProjectionTransaction(allowedRoot) {
  const safeAllowedRoot = path.resolve(allowedRoot || canonicalPluginRoot);
  const expectedPaths = recoveryPaths(safeAllowedRoot);
  const recoveryRootExists = fs.existsSync(expectedPaths.recoveryRoot);
  const anchorExists = fs.existsSync(expectedPaths.anchorPath);
  if (!recoveryRootExists && !anchorExists) {
    return { action: 'none', recoveryRoot: expectedPaths.recoveryRoot };
  }
  if (anchorExists) {
    const { anchor: earlyAnchor } = readAndValidateRecoveryAnchor(safeAllowedRoot);
    if (earlyAnchor.state === 'cleanup-committed'
      || earlyAnchor.state === 'cleanup-rolled-back') {
      return removeOrphanRecoveryTree(safeAllowedRoot);
    }
  }
  if (!fs.existsSync(expectedPaths.manifestPath)) {
    return removeOrphanRecoveryTree(safeAllowedRoot);
  }

  let recovery;
  try {
    recovery = readAndValidateRecoveryManifest(safeAllowedRoot);
  } catch (error) {
    if (error && error.code === 'TECH_PERSISTENCE_RECOVERY_REQUIRED') throw error;
    throw recoveryRequiredError(
      expectedPaths.manifestPath,
      `recovery evidence validation failed: ${error.message}`,
      error
    );
  }

  const { manifest } = recovery;
  const { anchor } = readAndValidateRecoveryAnchor(safeAllowedRoot);
  if (anchor.transactionId !== manifest.transactionId) {
    throw recoveryFailure(recovery, 'recovery anchor transactionId does not match its manifest');
  }
  if (anchor.state === 'preparing') {
    writeRecoveryAnchor(
      recovery,
      recoveryAnchorRecord(
        safeAllowedRoot,
        manifest.transactionId,
        'active'
      )
    );
  } else if (anchor.state !== 'active'
    && !((manifest.phase === 'committed' && anchor.state === 'cleanup-committed')
      || (manifest.phase === 'rolled-back' && anchor.state === 'cleanup-rolled-back'))) {
    throw recoveryFailure(recovery, 'recovery anchor phase does not match its manifest');
  }
  const snapshots = manifest.snapshots.map((snapshot) => ({ ...snapshot }));
  const readLiveFingerprints = () => {
    const values = new Map();
    try {
      for (const snapshot of snapshots) {
        assertSafePublishTarget(snapshot.target, safeAllowedRoot);
        values.set(snapshot.target, fingerprintPath(snapshot.target));
      }
    } catch (error) {
      throw recoveryFailure(recovery, `live target validation failed: ${error.message}`, error);
    }
    return values;
  };
  const claimsAreAbsent = () => manifest.claims.every(
    (claim) => fingerprintPath(claim.claimPath) === ABSENT_FINGERPRINT
  );

  if (manifest.phase === 'committed') {
    const liveFingerprints = readLiveFingerprints();
    const finalIsProven = claimsAreAbsent() && snapshots.every((snapshot) => (
      isValidFingerprint(snapshot.finalFingerprint)
      && snapshot.expectedFingerprint === snapshot.finalFingerprint
      && liveFingerprints.get(snapshot.target) === snapshot.finalFingerprint
    ));
    if (!finalIsProven) {
      throw recoveryFailure(recovery, 'committed transaction does not match its final fingerprints');
    }
    finalizeRecoveryCleanup(recovery, 'committed');
    return {
      action: 'finalized',
      transactionId: manifest.transactionId,
      recoveredTargets: snapshots.length,
    };
  }

  if (manifest.phase === 'rolled-back') {
    const liveFingerprints = readLiveFingerprints();
    const rollbackIsProven = claimsAreAbsent() && snapshots.every((snapshot) => (
      snapshot.expectedFingerprint === snapshot.originalFingerprint
      && liveFingerprints.get(snapshot.target) === snapshot.originalFingerprint
    ));
    if (!rollbackIsProven) {
      throw recoveryFailure(recovery, 'rolled-back transaction does not match its original fingerprints');
    }
    finalizeRecoveryCleanup(recovery, 'rolled-back');
    return {
      action: 'finalized-rollback',
      transactionId: manifest.transactionId,
      recoveredTargets: snapshots.length,
    };
  }

  try {
    inferLegacyRollbackOperation(recovery, snapshots);
    cleanupRecoveryTemporary(recovery);
    adoptCoherentPendingShadow(recovery, snapshots);
    restoreOperationToCheckpoint(recovery, snapshots);
    settleRecoveryClaims(recovery, snapshots);
    for (const snapshot of snapshots) {
      const manifestSnapshot = manifest.snapshots.find(
        (candidate) => candidate.target === snapshot.target
      );
      snapshot.expectedFingerprint = manifestSnapshot.expectedFingerprint;
    }
    checkpointRecovery(recovery, 'recovery:boundary-resolved', {
      state: 'completed',
      kind: 'recovery',
    });
  } catch (error) {
    if (error && error.code === 'TECH_PERSISTENCE_RECOVERY_REQUIRED') throw error;
    throw recoveryFailure(recovery, `in-flight boundary recovery failed: ${error.message}`, error);
  }

  const liveFingerprints = readLiveFingerprints();

  // Recovery never guesses across an in-flight rename/link boundary. Only a
  // fully checkpointed partial state can be rolled back: every private claim is
  // absent, the expected shadow still hashes to the manifest value (validated
  // above), and each live snapshot exactly matches that same value.
  const partialIsProven = claimsAreAbsent() && snapshots.every(
    (snapshot) => liveFingerprints.get(snapshot.target) === snapshot.expectedFingerprint
  );
  if (!partialIsProven) {
    throw recoveryFailure(
      recovery,
      `transaction phase ${manifest.phase} is not a provable checkpointed partial state`
    );
  }

  const recoveryContext = {
    ...recovery,
    snapshots,
  };
  checkpointRecovery(recoveryContext, 'recovery:rollback-starting', {
    state: 'starting',
    kind: 'recovery',
  });
  const rollbackResult = restoreSnapshots(
    snapshots,
    recovery.backupRoot,
    safeAllowedRoot,
    { recovery: recoveryContext }
  );
  if (!rollbackResult.ok) {
    try {
      checkpointRecovery(recoveryContext, 'recovery:rollback-failed', {
        state: 'failed',
        kind: 'recovery',
        failure: rollbackResult.errors.join('; '),
      });
    } catch {}
    throw recoveryFailure(
      recovery,
      `safe recovery rollback failed: ${rollbackResult.errors.join('; ')}`,
      rollbackResult.error
    );
  }
  for (const snapshot of snapshots) {
    updateRecoveryExpectedFingerprint(recoveryContext, snapshot);
    if (fingerprintPath(snapshot.target) !== snapshot.originalFingerprint) {
      throw recoveryFailure(recovery, `recovery verification failed for ${snapshot.target}`);
    }
  }
  checkpointRecovery(recoveryContext, 'rolled-back', {
    state: 'completed',
    kind: 'recovery',
  });
  finalizeRecoveryCleanup(recoveryContext, 'rolled-back');
  return {
    action: 'restored-original',
    transactionId: manifest.transactionId,
    recoveredTargets: snapshots.length,
  };
}

function publicationPriority(operation) {
  const base = path.basename(operation.target).toLowerCase();
  const normalized = operation.target.replace(/\\/g, '/').toLowerCase();
  if (base === 'plugin.json') return 120;
  if (base === 'hooks.json' || base === 'skill.md') return 110;
  const javascriptEntrypoint = base.endsWith('.js')
    && !normalized.includes('/lib/')
    && !normalized.includes('/scripts/agent-orchestrator/');
  if (javascriptEntrypoint) return 100;
  if (['.json', '.toml', '.yaml', '.yml'].includes(path.extname(base))) return 80;
  return operation.isNew ? 0 : 20;
}

function maybeInjectPublishFailure(publishedCount) {
  if (process.env.NODE_ENV !== 'test') return;
  const failurePoint = Number(process.env.TECH_PERSISTENCE_BUILD_TEST_FAIL_AFTER_PUBLISH || 0);
  if (Number.isInteger(failurePoint) && failurePoint > 0 && publishedCount === failurePoint) {
    throw new Error(`injected publish failure after ${publishedCount} files`);
  }
}

function maybeHardExitAfterPublish(publishedCount) {
  if (process.env.NODE_ENV !== 'test') return;
  const failurePoint = Number(process.env.TECH_PERSISTENCE_BUILD_TEST_HARD_EXIT_AFTER_PUBLISH || 0);
  if (Number.isInteger(failurePoint) && failurePoint > 0 && publishedCount === failurePoint) {
    process.exit(86);
  }
}

function maybeHardExitAfterCommit() {
  if (process.env.NODE_ENV !== 'test') return;
  if (process.env.TECH_PERSISTENCE_BUILD_TEST_HARD_EXIT_AFTER_COMMIT === '1') {
    process.exit(87);
  }
}

function ensureManagedDirectory(plan, snapshot, allowedRoot, options) {
  if (plan.kind !== 'directory' || plan.targetExisted) return;
  assertExpectedFingerprint(plan.target, ABSENT_FINGERPRINT, allowedRoot, 'directory creation');
  const parentGuard = captureParentPathGuard(plan.target, allowedRoot);
  checkpointMutation(options, 'before-directory-create', {
    phase: 'publish directory',
    kind: 'mkdir',
    target: plan.target,
    expectedFingerprint: ABSENT_FINGERPRINT,
  });
  invokeTestHook(options, 'afterFinalDirectorySafetyCheck', { target: plan.target });
  assertParentPathGuardUnchanged(parentGuard, 'directory creation');
  assertExpectedFingerprint(plan.target, ABSENT_FINGERPRINT, allowedRoot, 'directory creation');
  fs.mkdirSync(plan.target);
  assertParentPathGuardUnchanged(parentGuard, 'directory creation verification');
  assertSafePublishTarget(plan.target, allowedRoot);
  fs.mkdirSync(snapshot.expectedRoot, { recursive: true });
  if (fingerprintPath(plan.target) !== fingerprintPath(snapshot.expectedRoot)) {
    throw new Error(`created directory verification failed: ${plan.target}`);
  }
  checkpointMutation(options, 'directory-created', {
    phase: 'publish directory',
    kind: 'mkdir',
    target: plan.target,
    expectedFingerprint: ABSENT_FINGERPRINT,
  });
}

function evidenceFingerprint(target) {
  try {
    return fingerprintPath(target);
  } catch (error) {
    return `unavailable:${error.message}`;
  }
}

function writeRollbackEvidence(backupRoot, publishError, rollbackResult, snapshots) {
  const evidencePath = path.join(backupRoot, 'rollback-evidence.json');
  const evidence = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    backupRoot,
    publishFailure: {
      name: publishError.name,
      code: publishError.code || null,
      message: publishError.message,
    },
    rollbackFailure: {
      name: rollbackResult.error && rollbackResult.error.name,
      code: rollbackResult.error && rollbackResult.error.code || null,
      message: rollbackResult.error && rollbackResult.error.message,
    },
    snapshots: snapshots.map((snapshot) => ({
      target: snapshot.target,
      backup: snapshot.backup,
      originalFingerprint: snapshot.originalFingerprint,
      expectedLiveFingerprint: evidenceFingerprint(snapshot.expectedRoot),
    })),
  };
  writeJsonDurably(evidencePath, evidence);
  return evidencePath;
}

function publishProjectionTransaction(options = {}) {
  const allowedRoot = path.resolve(options.allowedRoot || canonicalPluginRoot);
  assertSafePublishTarget(allowedRoot, allowedRoot);
  assertNoUnresolvedRecovery(allowedRoot);
  const directories = options.directories || [];
  const files = options.files || [];
  const plans = [
    ...directories.map(({ stageDir, targetDir }) => buildDirectoryPublishPlan(
      path.resolve(stageDir),
      path.resolve(targetDir),
      allowedRoot
    )),
    ...files.map(({ source, target }) => buildFilePublishPlan(
      path.resolve(source),
      path.resolve(target),
      allowedRoot
    )),
  ];
  assertNonOverlappingPlans(plans);
  const changedPlans = plans.filter((plan) => plan.changed);
  if (changedPlans.length === 0) return { published: 0, removed: 0, changedTargets: 0 };

  // Snapshot every changed projection, then fsync the recovery manifest before
  // the first live mutation. A later process must resolve or explicitly clear
  // this transaction; it may never plan from a partial live tree.
  const recovery = initializeRecoveryContext(allowedRoot, changedPlans);
  const { backupRoot, snapshots } = recovery;
  const transactionOptions = { ...options, recovery };
  const snapshotByTarget = new Map(snapshots.map((snapshot) => [snapshot.target, snapshot]));
  let published = 0;
  let removed = 0;
  let commitCheckpointDurable = false;
  try {
    for (const plan of changedPlans.filter((candidate) => candidate.kind === 'directory')) {
      ensureManagedDirectory(
        plan,
        snapshotByTarget.get(plan.target),
        allowedRoot,
        transactionOptions
      );
      const snapshot = snapshotByTarget.get(plan.target);
      updateRecoveryExpectedFingerprint(recovery, snapshot);
      checkpointRecovery(recovery, 'publish:directory-created', {
        state: 'completed',
        kind: 'mkdir',
        target: plan.target,
        published,
        removed,
      });
    }

    const writes = changedPlans.flatMap((plan) => plan.writes)
      .sort((left, right) => {
        const priority = publicationPriority(left) - publicationPriority(right);
        return priority || left.target.localeCompare(right.target);
      });
    for (const operation of writes) {
      const snapshot = snapshotByTarget.get(operation.planTarget);
      if (publishFileAtomically(operation.source, operation.target, {
        allowedRoot,
        expectedFingerprint: operation.expectedFingerprint,
        sourceFingerprint: operation.sourceFingerprint,
        phase: 'publish write',
        testHooks: options.testHooks,
        recovery,
      })) {
        updateShadowAfterWrite(snapshot, operation);
        updateRecoveryExpectedFingerprint(recovery, snapshot);
        published += 1;
        checkpointRecovery(recovery, 'publish:write-completed', {
          state: 'completed',
          kind: 'write',
          target: operation.target,
          published,
          removed,
        });
        maybeHardExitAfterPublish(published);
        maybeInjectPublishFailure(published);
      }
    }

    const removals = changedPlans.flatMap((plan) => plan.removals)
      .sort((left, right) => {
        const priority = publicationPriority(right) - publicationPriority(left);
        return priority || left.target.localeCompare(right.target);
      });
    for (const operation of removals) {
      const snapshot = snapshotByTarget.get(operation.planTarget);
      if (removeExistingTarget(operation.target, allowedRoot, {
        expectedFingerprint: operation.expectedFingerprint,
        phase: 'publish remove',
        testHooks: options.testHooks,
        recovery,
      })) {
        updateShadowAfterRemoval(snapshot, operation.target);
        updateRecoveryExpectedFingerprint(recovery, snapshot);
        removed += 1;
        checkpointRecovery(recovery, 'publish:remove-completed', {
          state: 'completed',
          kind: 'remove',
          target: operation.target,
          published,
          removed,
        });
      }
    }
    for (const snapshot of snapshots) {
      const expectedFinalFingerprint = fingerprintPath(snapshot.expectedRoot);
      assertExpectedFingerprint(
        snapshot.target,
        expectedFinalFingerprint,
        allowedRoot,
        'publish final verification'
      );
      const manifestSnapshot = recovery.manifest.snapshots.find(
        (candidate) => candidate.target === snapshot.target
      );
      manifestSnapshot.finalFingerprint = expectedFinalFingerprint;
      manifestSnapshot.expectedFingerprint = expectedFinalFingerprint;
    }
    checkpointRecovery(recovery, 'committed', {
      state: 'completed',
      kind: 'transaction',
      published,
      removed,
    });
    commitCheckpointDurable = true;
    maybeHardExitAfterCommit();
    finalizeRecoveryCleanup(recovery, 'committed');
    return { published, removed, changedTargets: changedPlans.length };
  } catch (error) {
    if (commitCheckpointDurable) {
      const cleanupError = new Error(
        `source projection committed but recovery cleanup failed: ${error.message}; `
          + `recovery manifest: ${recovery.manifestPath}`
      );
      cleanupError.code = 'TECH_PERSISTENCE_COMMITTED_CLEANUP_FAILED';
      cleanupError.cause = error;
      cleanupError.committed = true;
      cleanupError.recoveryRoot = recovery.recoveryRoot;
      cleanupError.manifestPath = recovery.manifestPath;
      throw cleanupError;
    }
    try {
      checkpointRecovery(
        recovery,
        'rollback:starting',
        mergeRecoveryFailureOperation(recovery, 'starting', {
          publishFailure: error.message,
        })
      );
    } catch (checkpointError) {
      error.checkpointFailure = checkpointError;
    }
    const rollbackResult = restoreSnapshots(
      snapshots,
      backupRoot,
      allowedRoot,
      transactionOptions
    );
    if (!rollbackResult.ok) {
      let evidencePath = null;
      let evidenceFailure = null;
      try {
        evidencePath = writeRollbackEvidence(backupRoot, error, rollbackResult, snapshots);
      } catch (evidenceError) {
        evidenceFailure = evidenceError.message;
      }
      try {
        checkpointRecovery(
          recovery,
          'rollback-failed',
          mergeRecoveryFailureOperation(recovery, 'failed', {
            publishFailure: error.message,
            rollbackFailure: rollbackResult.errors.join('; '),
            evidencePath,
          })
        );
      } catch (checkpointError) {
        evidenceFailure = [evidenceFailure, `manifest checkpoint failed: ${checkpointError.message}`]
          .filter(Boolean)
          .join('; ');
      }
      const rollbackError = new Error(
        `projection publish failed (${error.message}); rollback failed: ${rollbackResult.errors.join('; ')}; `
          + `backup retained at ${backupRoot}; `
          + (evidencePath ? `evidence: ${evidencePath}` : `evidence write failed: ${evidenceFailure}`)
      );
      rollbackError.cause = error;
      rollbackError.rollbackCause = rollbackResult.error;
      rollbackError.backupRoot = backupRoot;
      rollbackError.evidencePath = evidencePath;
      rollbackError.recoveryRoot = recovery.recoveryRoot;
      rollbackError.manifestPath = recovery.manifestPath;
      throw rollbackError;
    }
    checkpointRecovery(recovery, 'rolled-back', {
      state: 'completed',
      kind: 'rollback',
      publishFailure: error.message,
    });
    finalizeRecoveryCleanup(recovery, 'rolled-back');
    throw error;
  }
}

function syncManagedDirectory(stageDir, targetDir, options = {}) {
  return publishProjectionTransaction({
    ...options,
    allowedRoot: options.allowedRoot || targetDir,
    directories: [{ stageDir, targetDir }],
  });
}

function transform(content) {
  return replacements.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    content
  );
}

function preserveAgentLoopProviderProvenance(content) {
  return content
    .replace(
      /pipeline 模式先由 Codex 生成全局契约/g,
      'pipeline 模式先由 Claude Code provider 生成全局契约'
    )
    .replace(
      /最后由 Codex 做 integration review/g,
      '最后由 Claude Code provider 做 integration review'
    )
    .replace(
      /Codex 的 `\/agent-loop` 与 Codex 的 `\$agent-loop`/g,
      'Claude Code plugin 的 `/agent-loop` 与 Codex 的 `$agent-loop`'
    );
}

function replaceCompoundProjectionLine(content, expected, replacement) {
  const first = content.indexOf(expected);
  if (first === -1 || content.indexOf(expected, first + expected.length) !== -1) {
    throw new Error(`compound projection contract changed: expected exactly one ${expected}`);
  }
  return content.slice(0, first) + replacement + content.slice(first + expected.length);
}

function transformCompoundCommandContent(content) {
  let projected = normalizeLf(transform(content));
  const projectionReplacements = [
    [
      '| 解决方案 | `docs/solutions/` + `docs/solutions/index.jsonl` + AGENTS.md 有界投影（Codex 按需读取 canonical index） |',
      '| 解决方案 | `docs/solutions/` + `docs/solutions/index.jsonl`（Codex 按需读取；AGENTS.md 无静态索引） |',
    ],
    [
      '`docs/solutions/*.md` 是唯一详情源；`docs/solutions/index.jsonl` 是唯一摘要索引缓存。AGENTS.md 仅保留 Codex 的有界 runtime 投影；Codex 不再把解决方案索引静态写入 AGENTS.md，而是按需读取 canonical index。',
      '`docs/solutions/*.md` 是唯一详情源；`docs/solutions/index.jsonl` 是唯一摘要索引缓存。Codex 按需读取 canonical index 或详情文档；AGENTS.md 不承载静态 solution index。',
    ],
    [
      'node scripts/sync-solution-index.js --all  # idempotent；同步 canonical index + Codex runtime projection；Codex 保持按需读取',
      'node scripts/sync-solution-index.js --all  # idempotent；重建 canonical index；Codex 按需读取；AGENTS.md 仅做 legacy block remove-only 迁移',
    ],
    [
      '- AGENTS.md 的 `### 解决方案索引` managed block 始终保留**最近 5 条**；AGENTS.md 不再承载解决方案索引',
      '- AGENTS.md 不承载解决方案索引；若检测到唯一且有序的 legacy managed block，仅删除该 block；缺失文件不创建，畸形 marker fail closed',
    ],
    [
      '- Codex always-on 注入保持有界，Codex solution index 的 always-on 注入为 0（设计参考 `docs/plans/2026-05-14-claude-md-index-via-prompt-recall.md`）',
      '- Codex solution index 的 always-on 注入为 0；仅在当前任务相关时读取 `docs/solutions/index.jsonl`',
    ],
    [
      '- Codex 的老条目仍可被 **prompt recall hook**（UserPromptSubmit）按当轮 prompt 召回；Codex 仅在相关任务中按需检索 `docs/solutions/index.jsonl` 或详情文档',
      '- Codex 仅在相关任务中按需检索 `docs/solutions/index.jsonl` 或具体 solution 文档',
    ],
    [
      '- 两个 runtime 共享同一 canonical summary；只有 Codex 保留有界静态投影',
      '- canonical summary 保持单一来源；Codex 不维护静态 runtime-doc projection',
    ],
    [
      '报告中加一行 `Solution index: synced <N> entries → docs/solutions/index.jsonl + AGENTS.md (Codex on-demand)`。',
      '报告中加一行 `Solution index: <updated|unchanged|failed> <N> entries -> docs/solutions/index.jsonl; Codex recall: on-demand; AGENTS projection: disabled`。',
    ],
  ];
  for (const [expected, replacement] of projectionReplacements) {
    projected = replaceCompoundProjectionLine(projected, expected, replacement);
  }
  return projected;
}
function transformCommandContent(name, content) {
  // agent-loop is intentionally cross-runtime: Claude remains the analysis/review
  // provider while Codex is the implementation provider. A blanket Claude→Codex
  // rewrite changes ownership semantics, so only normalize its line endings.
  if (name === 'agent-loop.md') return normalizeLf(content);
  const transformed = name === 'compound.md'
    ? transformCompoundCommandContent(content)
    : normalizeLf(transform(content));
  return transformed;
}

function normalizeLf(content) {
  return content.replace(/\r\n/g, '\n');
}

function normalizeMarkdownEof(content) {
  return `${normalizeLf(content).replace(/\n+$/, '')}\n`;
}

function copyTextFile(source, target, shouldTransform = true) {
  ensureDir(path.dirname(target));
  const content = fs.readFileSync(source, 'utf-8');
  fs.writeFileSync(target, normalizeLf(shouldTransform ? transform(content) : content));
}

function writeTextFile(target, content) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, content);
}

function copyFilePreservingType(
  source,
  target,
  shouldTransformText = true,
  canonicalizeMarkdownEof = false
) {
  const extension = path.extname(source).toLowerCase();
  if (canonicalizeMarkdownEof && extension === '.md') {
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, normalizeMarkdownEof(fs.readFileSync(source, 'utf8')));
    return;
  }
  const shouldTransform = shouldTransformText && ['.md', '.txt', '.json', '.toml'].includes(extension);
  if (shouldTransform) {
    copyTextFile(source, target, true);
    return;
  }
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function copyDirectoryRecursive(sourceDir, targetDir, options = {}) {
  ensureDir(targetDir);
  fs.readdirSync(sourceDir, { withFileTypes: true }).forEach((entry) => {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(source, target, options);
      return;
    }
    if (entry.isFile()) {
      copyFilePreservingType(
        source,
        target,
        options.transformText !== false,
        options.canonicalizeMarkdownEof === true
      );
    }
  });
}

function copyHookLibs(targetDir, options = {}) {
  const sourceLibDir = path.join(repoRoot, 'scripts', 'lib');
  const targetLibDir = path.join(targetDir, 'lib');
  emptyDir(targetLibDir);

  const libFiles = fs
    .readdirSync(sourceLibDir)
    .filter((name) => name.endsWith('.js'))
    // Codex-only helpers must never leak into the legacy Claude hook/MCP
    // projection. Keeping the projection byte-stable lets the two runtimes
    // evolve independently and makes Claude regressions mechanically visible.
    .filter((name) => options.includeCodexOnly || !name.startsWith('codex-'))
    .sort();

  libFiles.forEach((name) => {
    copyTextFile(path.join(sourceLibDir, name), path.join(targetLibDir, name), false);
  });

  return libFiles.length;
}

function assertInventory(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} inventory mismatch. Missing: ${missing.join(', ') || 'none'}; Extra: ${extra.join(', ') || 'none'}`
    );
  }
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    return { data: {}, body: content };
  }

  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    return { data: {}, body: content };
  }

  const raw = content.slice(4, end).trim();
  const body = content.slice(end + '\n---'.length).replace(/^\s*\n/, '');
  const data = {};
  raw.split('\n').forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return;
    const [, key, value] = match;
    data[key] = value.replace(/^"(.*)"$/, '$1');
  });
  return { data, body };
}

function titleFromCommandName(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function commandToSkill(name, content) {
  const commandName = path.basename(name, '.md');
  const { data, body } = parseFrontmatter(transformCommandContent(name, content));
  const commandBody = body.trimEnd();
  const description = data.description
    || `Run the former /${commandName} workflow in Codex.`;
  const title = titleFromCommandName(commandName);

  return normalizeLf(`---
name: ${commandName}
description: Codex-compatible entry point for the former /${commandName} command. ${description}
---

# ${title}

Codex CLI currently registers plugin bundles as skills, apps, and MCP servers. It does not register custom plugin \`commands/*.md\` files as interactive slash commands in the TUI, so use this skill as the supported Codex entry point for the former \`/${commandName}\` command.

## Invocation

Use \`$${commandName} <arguments>\` or select this skill through Codex's \`@\` picker. Treat the user's text after the skill name as the command arguments.

When the command instructions below mention \`/${commandName}\`, interpret that as this \`$${commandName}\` skill invocation while running in Codex.

## Command Instructions

${commandBody}
`);
}

function copyCommands(targetPluginRoot = pluginRoot) {
  const sourceDir = path.join(repoRoot, 'user-level', 'commands');
  const targetDir = path.join(targetPluginRoot, 'commands');
  const commandFiles = fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.md'))
    .sort();

  assertInventory('commands', commandFiles, expectedCommands);
  // Claude Code discovers plugin-native skills from skills/<name>/SKILL.md.
  // Publishing flat commands here is unsafe on Windows: commands/skill.md is
  // indistinguishable from commands/SKILL.md to a case-insensitive discovery
  // walk, which shadows every sibling command as a single "commands" skill.
  // Keep an empty staged directory solely so the transactional publisher can
  // remove command files from older plugin bundles.
  emptyDir(targetDir);
  return 0;
}

function removeRetiredLegacyCommandsDirectory() {
  const targetDir = assertSafePublishTarget(
    path.join(canonicalPluginRoot, 'commands'),
    canonicalPluginRoot
  );
  if (!fs.existsSync(targetDir)) return false;
  if (!fs.lstatSync(targetDir).isDirectory()) {
    throw new Error(`retired legacy commands target is not a directory: ${targetDir}`);
  }
  const entries = fs.readdirSync(targetDir);
  if (entries.length !== 0) {
    throw new Error(`retired legacy commands target is not empty: ${targetDir}`);
  }
  fs.rmdirSync(targetDir);
  return true;
}

function copySkills(targetPluginRoot = pluginRoot) {
  const sourceDir = path.join(repoRoot, 'user-level', 'skills');
  const targetDir = path.join(targetPluginRoot, 'skills');
  const skillDirs = fs.readdirSync(sourceDir)
    .filter((name) => {
      const skillDir = path.join(sourceDir, name);
      return fs.lstatSync(skillDir).isDirectory()
        && fs.existsSync(path.join(skillDir, 'SKILL.md'));
    })
    .sort();

  assertInventory('skills', skillDirs, expectedSkills);
  emptyDir(targetDir);
  skillDirs.forEach((name) => {
    copyDirectoryRecursive(
      path.join(sourceDir, name),
      path.join(targetDir, name),
      { transformText: false }
    );
  });
  expectedCommands.forEach((name) => {
    copyTextFile(
      path.join(repoRoot, 'user-level', 'commands', name),
      path.join(targetDir, path.basename(name, '.md'), 'SKILL.md'),
      false
    );
  });
  const copiedSkills = fs.readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(targetDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  assertInventory('generated Claude skills', copiedSkills, expectedClaudeSkills);
  return copiedSkills.length;
}

function copyClaudeAgents(targetPluginRoot = pluginRoot) {
  const sourceDir = path.join(repoRoot, 'user-level', 'agents');
  const targetDir = path.join(targetPluginRoot, 'agents');
  const agentFiles = fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.md'))
    .sort();
  const expected = [
    'claude-explorer.md',
    'claude-implementer.md',
    'claude-reviewer.md',
  ];
  assertInventory('Claude agents', agentFiles, expected);
  emptyDir(targetDir);
  agentFiles.forEach((name) => {
    copyTextFile(path.join(sourceDir, name), path.join(targetDir, name), false);
  });
  return agentFiles.length;
}

function copyCodexAgents(targetPluginRoot = pluginRoot) {
  const sourceDir = path.join(repoRoot, 'codex-native', 'agents');
  const targetDir = path.join(targetPluginRoot, 'codex-agents');
  const agentFiles = ['explorer.toml', 'implementer.toml', 'reviewer.toml'];
  emptyDir(targetDir);
  agentFiles.forEach((name) => {
    copyTextFile(path.join(sourceDir, name), path.join(targetDir, name), false);
  });
  writeTextFile(path.join(targetDir, 'config.example.toml'), normalizeLf(`# Codex plugin manifests do not register custom agent roles.
# Replace <plugin-root> with this installed plugin's absolute directory, then
# merge these tables into a trusted project or user config.toml.

[agents.tp_explorer]
description = "Bounded read-only repository discovery and evidence collection"
config_file = "<plugin-root>/codex-agents/explorer.toml"

[agents.tp_implementer]
description = "Scoped implementation in the active workspace with explicit verification"
config_file = "<plugin-root>/codex-agents/implementer.toml"

[agents.tp_reviewer]
description = "Independent read-only review against the frozen contract and evidence"
config_file = "<plugin-root>/codex-agents/reviewer.toml"
`));
  writeTextFile(path.join(targetDir, 'README.md'), normalizeLf(`# Codex native roles

Codex custom roles are configured through \`[agents.<name>].config_file\`.
The plugin manifest does not register roles, so use \`config.example.toml\` as
an explicit opt-in configuration snippet. Relative role paths resolve from the
config file that declares the role; the example therefore uses a plugin-root
placeholder instead of guessing an install location.
`));
  return agentFiles.length;
}

function copyCodexSprintRuntime(sprintSkillDir) {
  const runtimeDir = path.join(sprintSkillDir, 'runtime');
  emptyDir(runtimeDir);
  copyFilePreservingType(path.join(repoRoot, 'scripts', 'codex-active-sprint-state.js'), path.join(runtimeDir, 'codex-active-sprint-state.js'), false);
  copyFilePreservingType(path.join(repoRoot, 'scripts', 'lib', 'codex-active-sprint.js'), path.join(runtimeDir, 'lib', 'codex-active-sprint.js'), false);
}


function copyCodexSkills(targetPluginRoot = pluginRoot) {
  const canonicalSkillDir = path.join(repoRoot, 'user-level', 'skills');
  const nativeDir = path.join(repoRoot, 'codex-native', 'skills');
  const targetDir = path.join(targetPluginRoot, 'codex-skills');
  emptyDir(targetDir);

  fs.readdirSync(canonicalSkillDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(canonicalSkillDir, entry.name, 'SKILL.md')))
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((entry) => {
      copyDirectoryRecursive(
        path.join(canonicalSkillDir, entry.name),
        path.join(targetDir, entry.name),
        { transformText: !entry.name.startsWith('caveman') }
      );
    });

  expectedCommands.forEach((name) => {
    const source = path.join(repoRoot, 'user-level', 'commands', name);
    const target = path.join(targetDir, path.basename(name, '.md'), 'SKILL.md');
    const content = fs.readFileSync(source, 'utf-8');
    writeTextFile(target, commandToSkill(name, content));
  });

  fs.readdirSync(nativeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(nativeDir, entry.name, 'SKILL.md')))
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((entry) => {
      const target = path.join(targetDir, entry.name);
      emptyDir(target);
      copyDirectoryRecursive(
        path.join(nativeDir, entry.name),
        target,
        { transformText: false }
      );
    });
  copyCodexSprintRuntime(path.join(targetDir, 'sprint'));


  const copiedSkills = fs.readdirSync(targetDir)
    .filter((name) => fs.existsSync(path.join(targetDir, name, 'SKILL.md')))
    .sort();
  const expectedCodexSkills = [...new Set([
    ...expectedSkills,
    ...expectedCommands.map((name) => path.basename(name, '.md')),
  ])].sort();
  assertInventory('generated codex skills', copiedSkills, expectedCodexSkills);
  return copiedSkills.length;
}

function syncCodexSkill(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid Codex skill name: ${name}`);
  }
  const nativeSource = path.join(repoRoot, 'codex-native', 'skills', name);
  const canonicalSkillSource = path.join(repoRoot, 'user-level', 'skills', name);
  const commandSource = path.join(repoRoot, 'user-level', 'commands', `${name}.md`);
  const hasNativeSource = fs.existsSync(path.join(nativeSource, 'SKILL.md'));
  const hasCanonicalSkillSource = fs.existsSync(path.join(canonicalSkillSource, 'SKILL.md'));
  const hasCommandSource = fs.existsSync(commandSource);
  if (!hasNativeSource && !hasCanonicalSkillSource && !hasCommandSource) {
    throw new Error(`missing Codex skill source: ${name}`);
  }

  const releaseLock = acquireBuildLock();
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tech-persistence-codex-skill-${name}-`));
  try {
    if (hasNativeSource) {
      copyDirectoryRecursive(nativeSource, stageRoot, { transformText: false });
    } else if (hasCanonicalSkillSource) {
      copyDirectoryRecursive(
        canonicalSkillSource,
        stageRoot,
        { transformText: !name.startsWith('caveman') }
      );
    } else {
      const content = fs.readFileSync(commandSource, 'utf8');
      writeTextFile(path.join(stageRoot, 'SKILL.md'), commandToSkill(`${name}.md`, content));
    }
    if (name === 'sprint') copyCodexSprintRuntime(stageRoot);
    syncManagedDirectory(
      stageRoot,
      path.join(canonicalPluginRoot, 'codex-skills', name),
      { allowedRoot: canonicalPluginRoot }
    );
  } finally {
    if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
    releaseLock();
  }
}

function copyHooks() {
  const targetDir = path.join(pluginRoot, 'hooks');
  emptyDir(targetDir);
  writeTextFile(
    path.join(targetDir, 'hooks.json'),
    `${JSON.stringify(buildPluginHookConfig(), null, 2)}\n`
  );
  const hookScripts = [
    'caveman-activate.js',
    'inject-context.js',
    'guard-handoff-path.js',
    'observe.js',
    'evaluate-session.js',
    'prompt-submit.js',
  ];
  hookScripts.forEach((name) => {
    copyTextFile(path.join(repoRoot, 'scripts', name), path.join(targetDir, name), false);
  });
  const hookLibCount = copyHookLibs(targetDir, { includeCodexOnly: false });
  writeTextFile(path.join(targetDir, 'run-hook.js'), runHookJs);
  writeTextFile(path.join(targetDir, 'run-hook.cmd'), runHookCmd);
  return hookScripts.length + hookLibCount + 3;
}

function copyCodexHooks() {
  const targetDir = path.join(pluginRoot, 'codex-hooks');
  emptyDir(targetDir);
  writeTextFile(
    path.join(targetDir, 'hooks.json'),
    `${JSON.stringify(buildCodexPluginHookConfig(), null, 2)}\n`
  );
  const hookScripts = getCodexHookScriptNames();
  hookScripts.forEach((name) => {
    copyTextFile(path.join(repoRoot, 'scripts', name), path.join(targetDir, name), false);
  });
  const hookLibCount = copyHookLibs(targetDir, { includeCodexOnly: true });
  const sprintBridgeDependencies = fs.readdirSync(path.join(repoRoot, 'scripts', 'agent-orchestrator'))
    .filter((name) => name.endsWith('.js'))
    .sort();
  const bridgeTarget = path.join(targetDir, 'agent-orchestrator');
  ensureDir(bridgeTarget);
  sprintBridgeDependencies.forEach((name) => copyTextFile(
    path.join(repoRoot, 'scripts', 'agent-orchestrator', name),
    path.join(bridgeTarget, name),
    false
  ));
  writeTextFile(path.join(targetDir, 'run-hook.js'), codexRunHookJs);
  writeTextFile(path.join(targetDir, 'run-hook.cmd'), runHookCmd);
  return hookScripts.length + hookLibCount + sprintBridgeDependencies.length + 3;
}

function copyHomunculusTemplate() {
  const targetDir = path.join(pluginRoot, 'codex-homunculus-template');
  emptyDir(targetDir);
  copyTextFile(
    path.join(repoRoot, 'user-level', 'homunculus', 'config.json'),
    path.join(targetDir, 'config.json')
  );
  return 1;
}

function copyMcpRuntime() {
  const targetDir = path.join(pluginRoot, 'mcp');
  emptyDir(targetDir);
  copyTextFile(
    path.join(repoRoot, 'scripts', 'memory-mcp-server.js'),
    path.join(targetDir, 'memory-mcp-server.js'),
    false
  );
  const libCount = copyHookLibs(targetDir, { includeCodexOnly: false });
  return 1 + libCount;
}

function copyUtilityScripts(targetPluginRoot = pluginRoot) {
  utilityScripts.forEach((name) => {
    copyTextFile(
      path.join(repoRoot, 'scripts', name),
      path.join(targetPluginRoot, 'scripts', name),
      false
    );
  });
  copyAgentOrchestratorSubmodules(targetPluginRoot);
  // utility 脚本里的 require('./lib/*') 相对脚本自身解析到 plugin scripts/lib，
  // 必须独立于 hooks/lib、mcp/lib 单独落一份——否则 plugin 副本运行时
  // Cannot find module './lib/...'（A3 给 agent-orchestrator 首次引入 ./lib 依赖后实证回归）。
  // The installed builder imports codex-hook-registry, so its own scripts/lib
  // closure contains both runtime families. This is tooling, not a Claude hook
  // projection.
  const utilityLibCount = copyHookLibs(
    path.join(targetPluginRoot, 'scripts'),
    { includeCodexOnly: true }
  );
  return utilityScripts.length + 1 + utilityLibCount;
}

function copyAgentOrchestratorSubmodules(targetPluginRoot = pluginRoot) {
  const sourceDir = path.join(repoRoot, 'scripts', 'agent-orchestrator');
  if (!fs.existsSync(sourceDir)) return;
  const targetDir = path.join(targetPluginRoot, 'scripts', 'agent-orchestrator');
  emptyDir(targetDir);
  fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .forEach((name) => {
      copyTextFile(
        path.join(sourceDir, name),
        path.join(targetDir, name),
        false
      );
    });
}

function copySchemas(targetPluginRoot = pluginRoot) {
  const sourceDir = path.join(repoRoot, 'schemas');
  const targetDir = path.join(targetPluginRoot, 'schemas');
  emptyDir(targetDir);
  copyDirectoryRecursive(sourceDir, targetDir, { transformText: false });
  return listTreeFiles(targetDir).filter((name) => name.endsWith('.json')).length;
}

function main() {
  const releaseLock = acquireBuildLock();
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tech-persistence-codex-build-stage-'));
  let counts;
  try {
    const previousRoot = pluginRoot;
    pluginRoot = stageRoot;
    try {
      counts = {
        commandCount: copyCommands(),
        skillCount: copySkills(),
        claudeAgentCount: copyClaudeAgents(),
        codexSkillCount: copyCodexSkills(),
        codexAgentCount: copyCodexAgents(),
        hookCount: copyHooks(),
        codexHookCount: copyCodexHooks(),
        mcpCount: copyMcpRuntime(),
        utilityCount: copyUtilityScripts(),
        schemaCount: copySchemas(),
      };
      copyHomunculusTemplate();
    } finally {
      pluginRoot = previousRoot;
    }

    const projectionDirectories = [
      'commands', 'skills', 'agents', 'codex-skills', 'codex-agents', 'hooks', 'codex-hooks', 'mcp', 'codex-homunculus-template',
      'scripts/lib', 'scripts/agent-orchestrator', 'schemas',
    ];
    // OFFLINE SOURCE-PROJECTION CONTRACT: this repository tree is never an
    // active runtime root. Installers must publish a fully staged cache tree
    // behind their own atomic cache boundary before Codex reads it.
    publishProjectionTransaction({
      allowedRoot: canonicalPluginRoot,
      directories: projectionDirectories.map((directory) => ({
        stageDir: path.join(stageRoot, directory),
        targetDir: path.join(canonicalPluginRoot, directory),
      })),
      files: utilityScripts.map((name) => ({
        source: path.join(stageRoot, 'scripts', name),
        target: path.join(canonicalPluginRoot, 'scripts', name),
      })),
    });
    removeRetiredLegacyCommandsDirectory();
  } finally {
    if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
    releaseLock();
  }

  const {
    commandCount, skillCount, claudeAgentCount, codexSkillCount, codexAgentCount, hookCount, codexHookCount,
    mcpCount, utilityCount, schemaCount,
  } = counts;

  console.log(`[OK] generated ${commandCount} legacy Claude commands`);
  console.log('[OK] retired flat Claude command projection');
  console.log(`[OK] generated ${skillCount} skills`);
  console.log(`[OK] generated ${claudeAgentCount} Claude agents`);
  console.log(`[OK] generated ${codexSkillCount} codex skills`);
  console.log(`[OK] generated ${codexAgentCount} Codex agents`);
  console.log(`[OK] generated ${hookCount} hook files`);
  console.log(`[OK] generated ${codexHookCount} codex hook files`);
  console.log(`[OK] generated ${mcpCount} mcp runtime files`);
  console.log(`[OK] generated ${utilityCount} utility scripts`);
  console.log(`[OK] generated ${schemaCount} schemas`);
  console.log('[OK] generated codex homunculus template');
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--recover') {
      const releaseLock = acquireBuildLock();
      try {
        const result = recoverProjectionTransaction(canonicalPluginRoot);
        console.log(`[OK] recovery action: ${result.action}`);
      } finally {
        releaseLock();
      }
    } else if (args.length > 0) {
      throw new Error('usage: build-codex-plugin.js [--recover]');
    } else {
      main();
    }
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  main,
  transform,
  normalizeLf,
  commandToSkill,
  parseFrontmatter,
  replacements,
  expectedCommands,
  expectedSkills,
  expectedClaudeSkills,
  removeRetiredLegacyCommandsDirectory,
  utilityScripts,
  RECOVERY_DIRECTORY_NAME,
  SOURCE_PROJECTION_CONTRACT,
  acquireBuildLock,
  copyHookLibs,
  preserveAgentLoopProviderProvenance,
  transformCompoundCommandContent,
  transformCommandContent,
  copyCommands,
  copySkills,
  copyClaudeAgents,
  copyCodexSkills,
  copyCodexAgents,
  copyCodexHooks,
  copyUtilityScripts,
  copySchemas,
  syncCodexSkill,
  assertSafePublishTarget,
  publishFileAtomically,
  publishProjectionTransaction,
  recoverProjectionTransaction,
  syncManagedDirectory,
};
