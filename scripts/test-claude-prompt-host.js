'use strict';

// This exercises the actual Claude hook host with an isolated config and a
// localhost-only fake provider. No user configuration or remote model is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { resolveStoreDir } = require('./lib/self-learning-store');

const cli = process.env.TP_TEST_CLAUDE_CLI || 'claude';
const versionProbe = spawnSync(cli, ['--version'], { encoding: 'utf8', windowsHide: true });
const versionMatch = /^(\d+)\.(\d+)\.(\d+)/.exec(versionProbe.stdout || '');
const supported = versionProbe.status === 0 && versionMatch
  && (+versionMatch[1] > 2 || (+versionMatch[1] === 2 && (+versionMatch[2] > 1
    || (+versionMatch[2] === 1 && +versionMatch[3] >= 295))));
const skip = supported ? false : 'Claude Code 2.1.295 or later is unavailable';

function fixture(callback) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'tp-claude-host-test-'));
  const config = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const baseDir = path.join(root, 'homunculus');
  fs.mkdirSync(config);
  fs.mkdirSync(workspace);
  try {
    return callback({ root, config, workspace, baseDir });
  } finally {
    const relative = path.relative(tempRoot, root);
    if (!relative.startsWith('tp-claude-host-test-') || relative.includes(path.sep)) {
      throw new Error('unsafe Claude test cleanup target');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runHost(fixtureDirs, hookEntries) {
  const settings = { hooks: { UserPromptSubmit: [{ hooks: hookEntries }] } };
  fs.writeFileSync(path.join(fixtureDirs.config, 'settings.json'), JSON.stringify(settings));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: fixtureDirs.config,
    ANTHROPIC_API_KEY: 'synthetic-local-test',
    ANTHROPIC_AUTH_TOKEN: 'synthetic-local-test',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    TECH_PERSISTENCE_HOME: fixtureDirs.baseDir,
    TECH_PERSISTENCE_RUNTIME: 'claude',
    TECH_PERSISTENCE_DISABLE_PROMPT_RECALL: '1',
    NODE_NO_WARNINGS: '1',
    TP_HOST_TEST_ROOT: fixtureDirs.root,
  };
  for (const key of ['TP_SELF_LEARNING_BASE_DIR', 'TP_SELF_LEARNING_PROJECT_ID',
    'CLAUDE_SESSION_ID', 'CODEX_HOME', 'CODEX_SESSION_ID']) delete env[key];
  return spawnSync(cli, ['--setting-sources', 'user', '-p', 'isolated host probe'], {
    cwd: fixtureDirs.workspace,
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}

function nodeCommand(file) {
  return `node "${file.replace(/\\/g, '/')}"`;
}

test('real Claude first prompt with missing transcript durably enqueues', { skip, timeout: 40000 }, () => fixture((dirs) => {
  const probeFile = path.join(dirs.root, 'capture.js');
  const blockerFile = path.join(dirs.root, 'block.js');
  const hookPath = path.resolve(__dirname, 'prompt-submit.js');
  // Suppress detached worker only in this isolated test. It leaves the durable
  // job available for assertions and avoids a cleanup race with its child.
  const preload = path.join(dirs.root, 'preload.js');
  fs.writeFileSync(preload, `
    const cp = require('child_process');
    const original = cp.spawn;
    cp.spawn = function(command, args, options) {
      if (Array.isArray(args) && args.some(v => String(v).endsWith('prompt-receipt-worker.js'))) {
        return { pid: null, once() {} };
      }
      return original.call(this, command, args, options);
    };
  `);
  fs.writeFileSync(probeFile, `
    const fs = require('fs'); const cp = require('child_process'); const path = require('path');
    const raw = fs.readFileSync(0, 'utf8'); const p = JSON.parse(raw);
    const observed = { native_id: typeof p.prompt_id === 'string' && !!p.prompt_id,
      transcript_exists: typeof p.transcript_path === 'string' && fs.existsSync(p.transcript_path) };
    const child = cp.spawnSync(process.execPath, ['--require', ${JSON.stringify(preload)}, ${JSON.stringify(hookPath)}],
      { input: raw, encoding: 'utf8', windowsHide: true, env: process.env });
    observed.exit = child.status;
    try { observed.output = child.stdout ? JSON.parse(child.stdout) : {}; } catch { observed.output = null; }
    fs.writeFileSync(path.join(process.env.TP_HOST_TEST_ROOT, 'observed.json'), JSON.stringify(observed));
    if (child.stdout) process.stdout.write(child.stdout);
    process.exitCode = child.status === 0 ? 0 : 1;
  `);
  fs.writeFileSync(blockerFile, `process.stdout.write(JSON.stringify({decision:'block',reason:'local host probe',hookSpecificOutput:{hookEventName:'UserPromptSubmit',suppressOriginalPrompt:true}}));`);
  const result = runHost(dirs, [
    { type: 'command', command: nodeCommand(probeFile), timeout: 5, onFailure: 'block' },
    { type: 'command', command: nodeCommand(blockerFile), timeout: 5, onFailure: 'block' },
  ]);
  assert.ifError(result.error);
  assert.match(`${result.stdout}\n${result.stderr}`, /local host probe/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ECONNREFUSED|127\.0\.0\.1:1/i);
  const observed = JSON.parse(fs.readFileSync(path.join(dirs.root, 'observed.json'), 'utf8'));
  assert.equal(observed.native_id, true);
  assert.equal(observed.transcript_exists, false);
  assert.equal(observed.exit, 0);
  assert.notEqual(observed.output && observed.output.decision, 'block');
  const project = detectStableProjectIdentity(dirs.workspace);
  const jobs = path.join(resolveStoreDir(dirs.baseDir, project.id), 'prompt-outbox', 'jobs');
  assert.equal(fs.readdirSync(jobs).filter(name => /^\d{12}-[a-f0-9]{64}\.json$/.test(name)).length, 1);
}));

test('real Claude blocks a timed-out prompt hook with onFailure', { skip, timeout: 40000 }, () => fixture((dirs) => {
  const slow = path.join(dirs.root, 'slow.js');
  fs.writeFileSync(slow, 'setTimeout(() => {}, 4000);');
  const result = runHost(dirs, [{ type: 'command', command: nodeCommand(slow), timeout: 1, onFailure: 'block' }]);
  assert.ifError(result.error);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /timed out/i);
  assert.match(output, /block/i);
  assert.doesNotMatch(output, /127\.0\.0\.1:1|ECONNREFUSED/i);
}));
