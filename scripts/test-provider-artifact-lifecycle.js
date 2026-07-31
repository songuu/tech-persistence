#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('./agent-orchestrator/provider-lifecycle');
const { stableHash } = require('./agent-orchestrator/runtime-capabilities');

const before = {
  headSha: 'base',
  changedFiles: [],
  diffText: '',
};
const after = {
  headSha: 'base',
  changedFiles: [{ status: ' M', path: 'src/index.js' }],
  diffText: 'diff --git a/src/index.js b/src/index.js\n',
};
const partial = lifecycle.createEffectSnapshot(before, after);
assert.strictEqual(partial.state, 'partial');
assert.strictEqual(partial.refs.length, 1);
assert.strictEqual(partial.refs[0], partial.snapshotHash);

const inherited = lifecycle.createEffectSnapshot(after, after, {
  inheritedRecovery: {
    required: true,
    providerRef: 'codex:implementation:codex-exec',
    stage: 'implementation',
    effectsRef: partial.snapshotHash,
  },
});
assert.strictEqual(inherited.state, 'partial');

const clean = lifecycle.createEffectSnapshot(before, before);
assert.strictEqual(clean.state, 'none');
assert.deepStrictEqual(clean.refs, []);

const attempt = {
  providerRef: 'codex:implementation:codex-exec',
  profile: { runtime: 'codex' },
  capabilitySnapshot: { adapter: 'codex-exec' },
  task: { ref: 'task:run-1:implementation' },
};
const nativeRecovery = lifecycle.providerRecoveryRecord({
  runId: 'run-1',
  attempt,
  providerKey: 'implementation',
  stage: 'implementation',
  effects: partial,
  runtimeRefs: { threadId: 'thread-opaque', turnId: 'turn-opaque' },
  failureKind: 'schema-validation',
});
assert.strictEqual(nativeRecovery.required, true);
assert.strictEqual(nativeRecovery.resumeMode, 'native');
assert.strictEqual(nativeRecovery.runtimeRefs.threadId, 'thread-opaque');
assert.strictEqual(nativeRecovery.failureKind, 'schema-validation');

const reconcileRecovery = lifecycle.providerRecoveryRecord({
  runId: 'run-1',
  attempt,
  providerKey: 'implementation',
  stage: 'implementation',
  effects: partial,
  runtimeRefs: {},
  failureKind: 'parse',
});
assert.strictEqual(reconcileRecovery.resumeMode, 'reconcile');
assert.strictEqual(reconcileRecovery.reconcileRequired, true);

const acceptedArtifactFailure = lifecycle.providerRecoveryRecord({
  runId: 'run-1',
  attempt,
  providerKey: 'implementation',
  stage: 'implementation',
  effects: partial,
  runtimeRefs: { threadId: 'thread-opaque' },
  failureKind: 'post-acceptance-artifact',
  forceReconcile: true,
});
assert.strictEqual(acceptedArtifactFailure.resumeMode, 'reconcile');
assert.strictEqual(acceptedArtifactFailure.reconcileRequired, true);

const readOnlyAttempt = {
  ...attempt,
  providerRef: 'claude:spec:claude-print',
  profile: { runtime: 'claude' },
  capabilitySnapshot: { adapter: 'claude-print' },
  task: { ref: 'task:run-1:spec' },
};
const restartRecovery = lifecycle.providerRecoveryRecord({
  runId: 'run-1',
  attempt: readOnlyAttempt,
  providerKey: 'spec',
  stage: 'spec',
  effects: clean,
  runtimeRefs: {},
  failureKind: 'schema-validation',
});
assert.strictEqual(restartRecovery.required, true);
assert.strictEqual(restartRecovery.resumeMode, 'restart');
assert.strictEqual(restartRecovery.reconcileRequired, false);

assert.deepStrictEqual(lifecycle.providerResumeRefs(nativeRecovery, {
  runtime: 'codex',
  providerKey: 'implementation',
  stage: 'implementation',
}), { threadId: 'thread-opaque', turnId: 'turn-opaque' });
assert.deepStrictEqual(lifecycle.providerResumeRefs(nativeRecovery, {
  runtime: 'claude',
  providerKey: 'implementation',
  stage: 'implementation',
}), {});

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-provider-artifacts-'));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-provider-artifacts-outside-'));
try {
  const handoff = { summary: 'done', changedFiles: ['src/index.js'] };
  const validation = { status: 'passed', commands: [] };
  const diff = 'diff --git a/src/index.js b/src/index.js\n';
  fs.writeFileSync(path.join(runDir, 'handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'diff.patch'), diff);

  const evidence = {
    handoffHash: stableHash(handoff),
    validationHash: stableHash(validation),
    diffHash: stableHash(diff),
  };
  const manifest = lifecycle.createArtifactManifest(runDir, {
    handoff: {
      path: 'handoff.json',
      format: 'json',
      evidenceKey: 'handoffHash',
    },
    validation: {
      path: 'validation.json',
      format: 'json',
      evidenceKey: 'validationHash',
    },
    diff: {
      path: 'diff.patch',
      format: 'text',
      evidenceKey: 'diffHash',
    },
  }, evidence);
  assert.strictEqual(lifecycle.verifyArtifactManifest(runDir, manifest, evidence), true);

  fs.appendFileSync(path.join(runDir, 'diff.patch'), 'tampered\n');
  assert.throws(
    () => lifecycle.verifyArtifactManifest(runDir, manifest, evidence),
    /artifact diff content hash mismatch/
  );
  assert.throws(
    () => lifecycle.resolveArtifactPath(runDir, '../outside.json'),
    /escapes run directory/
  );

  const outsideArtifact = { secret: 'junction escape must not be readable' };
  fs.writeFileSync(
    path.join(outsideDir, 'outside.json'),
    `${JSON.stringify(outsideArtifact, null, 2)}\n`
  );
  fs.symlinkSync(
    outsideDir,
    path.join(runDir, 'junction-escape'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assert.throws(
    () => lifecycle.resolveArtifactPath(runDir, 'junction-escape/outside.json'),
    /escapes run directory through a link/
  );
  assert.throws(
    () => lifecycle.resolveArtifactPath(runDir, 'junction-escape/future.json'),
    /escapes run directory through a link/
  );

  const escapedArtifacts = {
    escaped: {
      path: 'junction-escape/outside.json',
      format: 'json',
      evidenceKey: 'escapedHash',
      hash: stableHash(outsideArtifact),
    },
  };
  const escapedManifest = {
    schemaVersion: 'provider-artifact-manifest-v1',
    artifacts: escapedArtifacts,
    manifestHash: stableHash(escapedArtifacts),
  };
  assert.throws(
    () => lifecycle.verifyArtifactManifest(runDir, escapedManifest, {
      escapedHash: stableHash(outsideArtifact),
    }),
    /escapes run directory through a link/
  );
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
}

console.log('provider-artifact-lifecycle: 26 passed');
