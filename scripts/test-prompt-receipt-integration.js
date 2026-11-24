'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { enqueuePromptBehavior } = require('./prompt-submit');
const { drainProjectPromptReceipts } = require('./lib/prompt-receipt-worker');
const { readJournal, resolveStoreDir } = require('./lib/self-learning-store');
const { detectStableProjectIdentity } = require('./lib/project-identity');
const { enqueuePromptReceipt, hasPromptReceiptWorkerFailure } = require('./lib/prompt-receipt-outbox');
const { adaptClaudeHookEvent, isTrustedUserAuthorityEvent } = require('./lib/behavior-events');
const { hashObject, canonicalStringify } = require('./lib/self-learning-canonical');
const { NATIVE_CONTROL_PREFIX } = require('./lib/acceptance-user-confirmation-control');
const { resolvePromptTranscriptBinding } = require('./lib/prompt-transcript-binding');
const { supportsNodeSqlite } = require('./lib/self-learning-local-recovery-guard');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-prompt-handoff-'));
  const workspace = path.join(root, 'workspace');
  const baseDir = path.join(root, 'base');
  fs.mkdirSync(workspace);
  try { return fn({ root, workspace, baseDir, project: detectStableProjectIdentity(workspace) }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('durable handoff records redacted event and replay once after worker recovery', () => fixture(({ root, workspace, baseDir, project }) => {
  const secret = `glpat-${'S'.repeat(24)}`;
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'native-1', session_id: 'session-1', cwd: workspace, prompt: `check ${secret}` };
  const options = { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'failed' }) };
  assert.equal(enqueuePromptBehavior(payload, options).status, 'queued');
  assert.equal(enqueuePromptBehavior(payload, options).status, 'duplicate');
  const files = fs.readdirSync(root, { recursive: true }).map(String);
  for (const name of files) {
    const file = path.join(root, name);
    if (fs.statSync(file).isFile()) {
      const contents = fs.readFileSync(file, 'utf8');
      assert(!contents.includes(secret));
      assert(!contents.includes('native-1'));
    }
  }
  drainProjectPromptReceipts(baseDir, project.id);
  const journal = readJournal(resolveStoreDir(baseDir, project.id));
  assert.equal(journal.revision, 1);
  assert.equal(journal.records[0].payload.event_type, 'user.prompt');
  assert(!JSON.stringify(journal).includes(secret));
  assert.equal(enqueuePromptBehavior(payload, options).status, 'queued');
  drainProjectPromptReceipts(baseDir, project.id);
  assert.equal(readJournal(resolveStoreDir(baseDir, project.id)).revision, 1);
}));

test('explicitly disabled capture bypasses validation and never creates a queue', () => fixture(({ workspace, baseDir, project }) => {
  fs.mkdirSync(baseDir);
  for (const policy of [{ enabled: false }, { writer_enabled: false }, { mode: 'off' }]) {
    fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({ self_learning: policy }));
    assert.deepEqual(enqueuePromptBehavior(null, { baseDir, project, cwd: workspace }), {
      status: 'skipped', reason: 'writer-disabled',
    });
    assert.equal(fs.existsSync(path.join(baseDir, 'projects')), false);
  }
}));

test('native prompt id remains idempotent when a missing transcript is later created', () => fixture(({ root, workspace, baseDir, project }) => {
  const transcriptPath = path.join(root, 'transcript.jsonl');
  const options = { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'failed' }) };
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'native-first', session_id: 'native-session', cwd: workspace, transcript_path: transcriptPath, prompt: 'native first turn' };
  assert.equal(enqueuePromptBehavior(payload, options).status, 'queued');
  drainProjectPromptReceipts(baseDir, project.id);
  fs.writeFileSync(transcriptPath, '{"type":"user"}\n');
  assert.equal(enqueuePromptBehavior(payload, options).status, 'queued');
  drainProjectPromptReceipts(baseDir, project.id);
  const storeDir = resolveStoreDir(baseDir, project.id);
  assert.equal(readJournal(storeDir).revision, 1);
  assert.equal(enqueuePromptBehavior({ ...payload, prompt_id: 'native-second', prompt: 'native second turn' }, options).status, 'queued');
  drainProjectPromptReceipts(baseDir, project.id);
  const journal = readJournal(storeDir);
  assert.equal(journal.revision, 2);
  const first = journal.records[0].payload.details.prompt_receipt;
  const second = journal.records[1].payload.details.prompt_receipt;
  assert.equal(first.stream_ref, second.stream_ref);
  assert.equal(second.occurrence, 2);
  for (const name of fs.readdirSync(baseDir, { recursive: true })) {
    const file = path.join(baseDir, String(name));
    if (fs.statSync(file).isFile()) assert(!fs.readFileSync(file, 'utf8').includes(transcriptPath));
  }
  fs.renameSync(transcriptPath, `${transcriptPath}.old`);
  assert.equal(enqueuePromptBehavior({ ...payload, prompt_id: 'native-missing-after-pin' }, options).reason, 'untrusted-transcript');
  fs.writeFileSync(transcriptPath, '{"type":"user"}\n');
  assert.equal(enqueuePromptBehavior({ ...payload, prompt_id: 'native-third' }, options).reason, 'untrusted-transcript');
  assert.equal(readJournal(storeDir).revision, 2);
}));

test('missing transcript cannot downgrade permission errors to compatibility fallback', () => fixture(({ root, workspace, baseDir, project }) => {
  const transcriptPath = path.join(root, 'access-denied.jsonl');
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'native-first', session_id: 'native-session', cwd: workspace, transcript_path: transcriptPath, prompt: 'native prompt' };
  const original = fs.lstatSync;
  fs.lstatSync = (file, ...args) => {
    if (String(file) === transcriptPath) { const error = new Error('sensitive'); error.code = 'EACCES'; throw error; }
    return original(file, ...args);
  };
  try {
    assert.equal(enqueuePromptBehavior(payload, { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'failed' }) }).reason, 'untrusted-transcript');
    assert.equal(readJournal(resolveStoreDir(baseDir, project.id)).revision, 0);
  } finally { fs.lstatSync = original; }
}));

test('transcript disappearance after initial inspection cannot become compatibility fallback', () => fixture(({ root, workspace, baseDir, project }) => {
  const transcriptPath = path.join(root, 'disappeared.jsonl');
  fs.writeFileSync(transcriptPath, '{"type":"user"}\n');
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'native-first', session_id: 'native-session', cwd: workspace, transcript_path: transcriptPath, prompt: 'native prompt' };
  const original = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (String(file) === transcriptPath) { const error = new Error('disappeared'); error.code = 'ENOENT'; throw error; }
    return original(file, ...args);
  };
  try {
    assert.equal(enqueuePromptBehavior(payload, { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'failed' }) }).reason, 'untrusted-transcript');
    assert.equal(readJournal(resolveStoreDir(baseDir, project.id)).revision, 0);
  } finally { fs.openSync = original; }
}));

test('binding recovers a process crash before and after atomic publication', { skip: process.platform !== 'win32' || !supportsNodeSqlite() }, (t) => fixture(({ root, baseDir, project }) => {
  const previous = process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
  process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT;
    else process.env.TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT = previous;
  });
  const storeDir = resolveStoreDir(baseDir, project.id);
  const transcriptPath = path.join(root, 'missing.jsonl');
  const modulePath = path.join(__dirname, 'lib', 'prompt-transcript-binding.js');
  const crashScript = `
    const fs = require('fs');
    const original = fs.linkSync;
    fs.linkSync = (...args) => {
      if (String(args[0]).includes('.binding-')) {
        if (process.argv[5] === 'before') process.exit(91);
        original(...args);
        process.exit(92);
      }
      return original(...args);
    };
    require(process.argv[1]).resolvePromptTranscriptBinding({
      storeDir: process.argv[2], projectId: process.argv[3], sessionId: process.argv[5],
      transcriptPath: process.argv[4], nativePromptId: 'native-id',
      inspectTranscript() { const e = new Error('missing'); e.code = 'SELF_LEARNING_TRANSCRIPT_MISSING'; throw e; },
    });
  `;
  for (const mode of ['before', 'after']) {
    const result = spawnSync(process.execPath, ['-e', crashScript, modulePath, storeDir, project.id, transcriptPath, mode], { encoding: 'utf8' });
    assert.equal(result.status, mode === 'before' ? 91 : 92);
    const binding = resolvePromptTranscriptBinding({
      storeDir, projectId: project.id, sessionId: mode, transcriptPath, nativePromptId: 'native-id',
      inspectTranscript() { const e = new Error('missing'); e.code = 'SELF_LEARNING_TRANSCRIPT_MISSING'; throw e; },
    });
    assert.match(binding.transcript_ref, /^sha256:[a-f0-9]{64}$/);
    const names = fs.readdirSync(path.join(storeDir, 'prompt-bindings'));
    assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 0);
  }
  const inodeRef = hashObject('future transcript identity');
  const initial = resolvePromptTranscriptBinding({
    storeDir, projectId: project.id, sessionId: 'pin-crash', transcriptPath, nativePromptId: 'native-id',
    inspectTranscript() { const e = new Error('missing'); e.code = 'SELF_LEARNING_TRANSCRIPT_MISSING'; throw e; },
  });
  const pinCrash = `
    const fs = require('fs');
    const original = fs.linkSync;
    fs.linkSync = (...args) => {
      const result = original(...args);
      if (String(args[0]).includes('.binding-')) process.exit(93);
      return result;
    };
    require(process.argv[1]).resolvePromptTranscriptBinding({
      storeDir: process.argv[2], projectId: process.argv[3], sessionId: 'pin-crash',
      transcriptPath: process.argv[4], nativePromptId: 'native-id',
      inspectTranscript() { return { transcript_ref: process.argv[5], cursor_ref: process.argv[5] }; },
    });
  `;
  const crashedPin = spawnSync(process.execPath, ['-e', pinCrash, modulePath, storeDir, project.id, transcriptPath, inodeRef], { encoding: 'utf8' });
  assert.equal(crashedPin.status, 93);
  const recovered = resolvePromptTranscriptBinding({
    storeDir, projectId: project.id, sessionId: 'pin-crash', transcriptPath, nativePromptId: 'native-id',
    inspectTranscript() { return { transcript_ref: inodeRef, cursor_ref: inodeRef }; },
  });
  assert.equal(recovered.transcript_ref, initial.transcript_ref);
  assert.equal(fs.readdirSync(path.join(storeDir, 'prompt-bindings')).filter((name) => name.endsWith('.tmp')).length, 0);
}));

test('binding rejects tampered stream identities for missing or existing transcripts', () => fixture(({ root, baseDir, project }) => {
  const storeDir = resolveStoreDir(baseDir, project.id);
  const transcriptPath = path.join(root, 'transcript.jsonl');
  const inodeRef = hashObject('existing inode');
  for (const kind of ['missing', 'existing']) {
    const input = {
      storeDir, projectId: project.id, sessionId: kind, transcriptPath, nativePromptId: 'native-id',
      inspectTranscript() {
        if (kind === 'existing') return { transcript_ref: inodeRef, cursor_ref: inodeRef };
        const error = new Error('missing'); error.code = 'SELF_LEARNING_TRANSCRIPT_MISSING'; throw error;
      },
    };
    resolvePromptTranscriptBinding(input);
    const sessionRef = hashObject({ schema_version: 'claude-transcript-session-v1', project_id: project.id, session_id: kind });
    const file = path.join(storeDir, 'prompt-bindings', `${sessionRef.slice(7)}.json`);
    const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
    binding.stream_ref = hashObject(`tampered-${kind}`);
    fs.writeFileSync(file, JSON.stringify(binding));
    assert.throws(() => resolvePromptTranscriptBinding(input), { code: 'SELF_LEARNING_TRANSCRIPT_UNSAFE' });
  }
}));

test('concurrent host hooks agree on one native prompt while transcript is absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-binding-race-'));
  const workspace = path.join(root, 'workspace');
  const baseDir = path.join(root, 'base');
  fs.mkdirSync(workspace);
  const project = detectStableProjectIdentity(workspace);
  const transcriptPath = path.join(root, 'not-yet-created.jsonl');
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'native-unique', session_id: 'native-session', cwd: workspace, transcript_path: transcriptPath, prompt: 'same real host input' };
  const script = `
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = require(process.argv[1]).enqueuePromptBehavior(data.payload, {
      baseDir: data.baseDir, cwd: data.workspace, workerLauncher: () => ({ status: 'started' }),
    });
    process.stdout.write(result.status);
  `;
  function producer() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, path.join(__dirname, 'prompt-submit.js')], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (bytes) => { stdout += bytes; });
      child.stderr.on('data', (bytes) => { stderr += bytes; });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`producer failed ${code}: ${stderr}`)));
      child.stdin.end(JSON.stringify({ payload, baseDir, workspace }));
    });
  }
  try {
    const statuses = await Promise.all([producer(), producer()]);
    assert.deepEqual(statuses.sort(), ['duplicate', 'queued']);
    drainProjectPromptReceipts(baseDir, project.id);
    assert.equal(readJournal(resolveStoreDir(baseDir, project.id)).revision, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('same replay with altered prompt is rejected without overwriting the first event', () => fixture(({ workspace, baseDir, project }) => {
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'native-2', session_id: 'session-1', cwd: workspace, prompt: 'first input' };
  const options = { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'failed' }) };
  assert.equal(enqueuePromptBehavior(payload, options).status, 'queued');
  assert.equal(enqueuePromptBehavior({ ...payload, prompt: 'different input' }, options).status, 'error');
  drainProjectPromptReceipts(baseDir, project.id);
  assert.equal(readJournal(resolveStoreDir(baseDir, project.id)).revision, 1);
}));

test('worker failure keeps the event, emits bounded status, and recovers after repair', () => fixture(({ workspace, baseDir, project }) => {
  const storeDir = resolveStoreDir(baseDir, project.id);
  const journalDir = path.join(storeDir, 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const badFile = path.join(journalDir, `000000000001-${'a'.repeat(64)}.json`);
  fs.writeFileSync(badFile, '{bad json');
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'native-error', session_id: 'session-1', cwd: workspace, prompt: 'retryable prompt' };
  const options = { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'failed' }) };
  assert.equal(enqueuePromptBehavior(payload, options).status, 'queued');
  const worker = path.join(__dirname, 'lib', 'prompt-receipt-worker.js');
  const failed = spawnSync(process.execPath, [worker, baseDir, project.id], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  const outboxDir = path.join(storeDir, 'prompt-outbox');
  assert.equal(hasPromptReceiptWorkerFailure(outboxDir), true);
  assert.equal(fs.readdirSync(path.join(outboxDir, 'jobs')).length, 1);
  fs.unlinkSync(badFile);
  const recovered = spawnSync(process.execPath, [worker, baseDir, project.id], { encoding: 'utf8' });
  assert.equal(recovered.status, 0);
  assert.equal(hasPromptReceiptWorkerFailure(outboxDir), false);
  assert.equal(readJournal(storeDir).revision, 1);
}));

test('worker rejects and preserves a job belonging to another project', () => fixture(({ root, baseDir, project }) => {
  const other = detectStableProjectIdentity(path.join(root, 'other-workspace'));
  const spec = { project_id: other.id, session_id: 's1', transcript_ref: hashObject('stream'), replay_ref: hashObject('replay') };
  const draft = adaptClaudeHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'another project' }, {
    project_id: other.id, session_id: 's1', source_event_id: 'native-source', occurred_at: '2000-01-01T00:00:00.000Z',
  });
  const storeDir = resolveStoreDir(baseDir, project.id);
  const outboxDir = path.join(storeDir, 'prompt-outbox');
  enqueuePromptReceipt(outboxDir, { receipt_spec: spec, event_draft: draft });
  assert.throws(() => drainProjectPromptReceipts(baseDir, project.id), /project does not match/);
  assert.equal(readJournal(storeDir).revision, 0);
  assert.equal(fs.readdirSync(path.join(outboxDir, 'jobs')).length, 1);
}));

test('queued approval is not authoritative until its native receipt reaches the journal', () => fixture(({ workspace, baseDir, project }) => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const prompt = NATIVE_CONTROL_PREFIX + canonicalStringify({
    action: 'confirm-acceptance', contract_hash: hash, criterion_id: 'ac-recovery',
    decision: 'accepted', oracle_hash: hash, subject_hash: hash,
  });
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'approval-1', session_id: 's1', cwd: workspace, prompt };
  assert.equal(enqueuePromptBehavior(payload, { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'failed' }) }).status, 'queued');
  const storeDir = resolveStoreDir(baseDir, project.id);
  assert.equal(readJournal(storeDir).revision, 0);
  drainProjectPromptReceipts(baseDir, project.id);
  const event = readJournal(storeDir).records[0].payload;
  assert.equal(event.event_type, 'user.approval');
  assert.equal(isTrustedUserAuthorityEvent(event, 'approval'), true);
}));

test('conflicting replay blocks its stream but permits unrelated prompts to commit', () => fixture(({ workspace, baseDir, project }) => {
  const options = { baseDir, project, cwd: workspace, workerLauncher: () => ({ status: 'failed' }) };
  const payload = { hook_event_name: 'UserPromptSubmit', prompt_id: 'conflicted', session_id: 's1', cwd: workspace, prompt: 'first event' };
  enqueuePromptBehavior(payload, options);
  drainProjectPromptReceipts(baseDir, project.id);
  enqueuePromptBehavior({ ...payload, prompt: 'altered replay' }, options);
  enqueuePromptBehavior({ ...payload, prompt_id: 'next', prompt: 'same stream later' }, options);
  enqueuePromptBehavior({ ...payload, session_id: 's2', prompt_id: 'other', prompt: 'different stream' }, options);
  drainProjectPromptReceipts(baseDir, project.id);
  const storeDir = resolveStoreDir(baseDir, project.id);
  const journal = readJournal(storeDir);
  assert.equal(journal.revision, 2);
  assert(journal.records.some((entry) => entry.payload.session_id === 's2'));
  assert.equal(journal.records.filter((entry) => entry.payload.session_id === 's1').length, 1);
  const outboxDir = path.join(storeDir, 'prompt-outbox');
  assert.equal(hasPromptReceiptWorkerFailure(outboxDir), true);
  assert.equal(fs.readdirSync(path.join(outboxDir, 'jobs')).filter((name) => name.endsWith('.json')).length, 2);
  enqueuePromptBehavior({ ...payload, session_id: 's2', prompt_id: 'other-2', prompt: 'another stream event' }, options);
  drainProjectPromptReceipts(baseDir, project.id);
  const afterRestart = readJournal(storeDir);
  assert.equal(afterRestart.revision, 3);
  assert.equal(afterRestart.records.filter((entry) => entry.payload.session_id === 's1').length, 1);
  assert.equal(fs.readdirSync(path.join(outboxDir, 'jobs')).filter((name) => name.endsWith('.json')).length, 2);
}));

test('parallel native producers and worker processes retain every prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-prompt-process-race-'));
  const workspace = path.join(root, 'workspace');
  const baseDir = path.join(root, 'base');
  fs.mkdirSync(workspace);
  const project = detectStableProjectIdentity(workspace);
  const hook = path.join(__dirname, 'prompt-submit.js');
  const worker = path.join(__dirname, 'lib', 'prompt-receipt-worker.js');
  const producerSource = `
    const fs = require('fs');
    const { enqueuePromptBehavior } = require(process.argv[1]);
    const p = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = enqueuePromptBehavior(p.payload, {
      baseDir: p.baseDir, cwd: p.workspace,
      workerLauncher: () => ({ status: 'started' }),
    });
    if (result.status !== 'queued') process.exit(1);
  `;
  function run(file, args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd: __dirname, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`child failed: ${code} ${stderr}`)));
      child.stdin.end(input);
    });
  }
  try {
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const payload = {
        hook_event_name: 'UserPromptSubmit', prompt_id: `parallel-${index}`,
        session_id: `session-${index}`, cwd: workspace, prompt: `prompt ${index}`,
      };
      await run(process.execPath, ['-e', producerSource, hook], JSON.stringify({ payload, workspace, baseDir }));
      await run(process.execPath, [worker, baseDir, project.id], '');
    }));
    const journal = readJournal(resolveStoreDir(baseDir, project.id));
    assert.equal(journal.revision, 8);
    assert.equal(new Set(journal.records.map((entry) => entry.record_id)).size, 8);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plugin wrapper delivers sanitized queue warnings in structured hook output', () => fixture(({ root, workspace, baseDir }) => {
  const hooks = path.join(root, 'plugin', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.cpSync(path.join(__dirname, 'lib'), path.join(hooks, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'prompt-submit.js'), path.join(hooks, 'prompt-submit.js'));
  fs.copyFileSync(path.join(__dirname, 'inject-context.js'), path.join(hooks, 'inject-context.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'plugins', 'tech-persistence', 'hooks', 'run-hook.js'), path.join(hooks, 'run-hook.js'));
  fs.writeFileSync(path.join(hooks, 'lib', 'prompt-receipt-worker.js'),
    "module.exports = { startPromptReceiptWorker() { return { status: 'failed' }; } };\n");
  const secret = `glpat-${'X'.repeat(24)}`;
  const result = spawnSync(process.execPath, [path.join(hooks, 'run-hook.js'), 'prompt-submit.js'], {
    cwd: workspace,
    env: { ...process.env, TP_SELF_LEARNING_BASE_DIR: baseDir, TECH_PERSISTENCE_DISABLE_PROMPT_RECALL: '1' },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt_id: 'wrapped-1', session_id: 's1', cwd: workspace, prompt: `test ${secret}` }),
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /worker could not start/);
  assert(!result.stdout.includes(secret));
  assert(!result.stdout.includes(baseDir));
  const unsafeTranscript = path.join(root, `missing-${secret}.jsonl`);
  const unsafe = spawnSync(process.execPath, [path.join(hooks, 'run-hook.js'), 'prompt-submit.js'], {
    cwd: workspace,
    env: { ...process.env, TP_SELF_LEARNING_BASE_DIR: baseDir, TECH_PERSISTENCE_DISABLE_PROMPT_RECALL: '1' },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: workspace, transcript_path: unsafeTranscript, prompt: `test ${secret}` }),
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(unsafe.status, 0);
  assert.equal(unsafe.stderr, '');
  const blocked = JSON.parse(unsafe.stdout);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /transcript.*not.*safe/i);
  assert.equal(blocked.hookSpecificOutput.suppressOriginalPrompt, true);
  assert(!unsafe.stdout.includes(secret));
  assert(!unsafe.stdout.includes(unsafeTranscript));
  assert(!unsafe.stdout.includes(baseDir));
  const disabledBase = path.join(root, 'disabled-base');
  fs.mkdirSync(disabledBase);
  fs.writeFileSync(path.join(disabledBase, 'config.json'), JSON.stringify({ self_learning: { enabled: false } }));
  const disabled = spawnSync(process.execPath, [path.join(hooks, 'run-hook.js'), 'prompt-submit.js'], {
    cwd: workspace,
    env: { ...process.env, TP_SELF_LEARNING_BASE_DIR: disabledBase, TECH_PERSISTENCE_DISABLE_PROMPT_RECALL: '1' },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: workspace, transcript_path: unsafeTranscript, prompt: `test ${secret}` }),
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(disabled.status, 0);
  assert.equal(disabled.stdout, '');
  assert.equal(fs.existsSync(path.join(disabledBase, 'projects')), false);
  for (const code of ['PROMPT_OUTBOX_FULL', 'EACCES', 'SELF_LEARNING_LOCKED', 'ENOSPC', 'SELF_LEARNING_RECOVERY_UNAVAILABLE']) {
    fs.writeFileSync(path.join(hooks, 'lib', 'prompt-receipt-outbox.js'), `
      module.exports = {
        enqueuePromptReceipt() { const e = new Error(${JSON.stringify(secret)}); e.code = ${JSON.stringify(code)}; throw e; },
        hasPromptReceiptWorkerFailure() { return false; },
      };
    `);
    const failed = spawnSync(process.execPath, [path.join(hooks, 'run-hook.js'), 'prompt-submit.js'], {
      cwd: workspace,
      env: { ...process.env, TP_SELF_LEARNING_BASE_DIR: baseDir, TECH_PERSISTENCE_DISABLE_PROMPT_RECALL: '1' },
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt_id: `failure-${code}`, session_id: 's1', cwd: workspace, prompt: `test ${secret}` }),
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(failed.status, 0);
    assert.equal(failed.stderr, '');
    const output = JSON.parse(failed.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /retry/i);
    if (code === 'SELF_LEARNING_RECOVERY_UNAVAILABLE') {
      assert.match(output.reason, /device-local.*TP_SELF_LEARNING_LOCAL_RECOVERY_ROOT/i);
      assert.match(output.reason, /node:sqlite available and enabled/i);
    }
    assert.equal(output.hookSpecificOutput.suppressOriginalPrompt, true);
    assert(!failed.stdout.includes(secret));
    assert(!failed.stdout.includes(baseDir));
  }
}));
