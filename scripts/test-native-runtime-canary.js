#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const canary = require('./agent-orchestrator/native-runtime-canary');

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-native-canary-'));
const cliFile = path.join(__dirname, 'native-runtime-canary.js');
let passed = 0;

function test(name, callback) {
  callback();
  passed += 1;
  process.stdout.write(`ok - ${name}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runCli(args) {
  return spawnSync(process.execPath, [cliFile, ...args], { encoding: 'utf8' });
}

try {
  const derivedRoot = path.join(temporaryDir, 'derived');
  const records = canary.deriveCanaryRecords(derivedRoot);

  test('derives all six fixed canary cases from a fresh artifact root', () => {
    assert.deepStrictEqual(records.map((record) => record.caseId), canary.CASES);
    assert.deepStrictEqual(canary.checkRecords(records), {
      ok: true,
      cases: canary.CASES,
      records: 6,
    });
  });

  test('attaches offline deterministic provenance and real files to every case', () => {
    for (const record of records) {
      assert.strictEqual(record.provenance.kind, 'deterministic-module-artifacts');
      assert.strictEqual(record.provenance.scope, 'offline-contract-only');
      assert.strictEqual(record.provenance.artifactRoot, path.resolve(derivedRoot));
      assert.ok(record.provenance.artifacts.length > 0);
      for (const artifact of record.provenance.artifacts) {
        assert.strictEqual(fs.statSync(artifact.path).isFile(), true);
        assert.match(artifact.hash, /^sha256:[a-f0-9]{64}$/);
      }
    }
  });

  test('verifies and deduplicates the artifact hashes', () => {
    const result = canary.verifyArtifactProvenance(records);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records, 6);
    assert.ok(result.artifacts >= 15);
  });

  test('uses deterministic capability artifacts rather than claiming live probes', () => {
    const review = records.find((record) =>
      record.caseId === 'cross-runtime-read-only-review');
    const capabilityFiles = review.provenance.artifacts
      .filter((artifact) => artifact.role.endsWith('-capability'));
    assert.strictEqual(capabilityFiles.length, 2);
    for (const artifact of capabilityFiles) {
      const snapshot = readJson(artifact.path);
      assert.strictEqual(snapshot.source, 'deterministic-canary');
    }
  });

  test('derives the partial-effects block from persisted route and result artifacts', () => {
    const record = records.find((entry) => entry.caseId === 'partial-effects');
    const byRole = new Map(record.provenance.artifacts.map((artifact) =>
      [artifact.role, artifact.path]));
    const result = readJson(byRole.get('partial-result'));
    const route = readJson(byRole.get('partial-resume-route'));
    assert.strictEqual(result.effects.state, 'partial');
    assert.strictEqual(route.status, 'blocked');
    assert.deepStrictEqual(route.fallbacks, []);
    assert.strictEqual(record.evidence.reconciliationRequired, true);
  });

  test('derives duplicate rejection from an exclusive canonical write', () => {
    const record = records.find((entry) => entry.caseId === 'duplicate-result');
    const attemptFile = record.provenance.artifacts.find((artifact) =>
      artifact.role === 'duplicate-attempt').path;
    const attempt = readJson(attemptFile);
    assert.strictEqual(attempt.sameIdempotencyKey, true);
    assert.strictEqual(attempt.secondWriteError, 'EEXIST');
    assert.strictEqual(record.evidence.canonicalWrites, 1);
  });

  test('rejects tampered artifact provenance even when caller booleans still pass', () => {
    const worktree = records.find((record) => record.caseId === 'worktree-handoff');
    const diff = worktree.provenance.artifacts.find((artifact) =>
      artifact.role === 'worktree-diff');
    fs.appendFileSync(diff.path, '+tampered\n');
    assert.strictEqual(canary.checkRecords(records).ok, true);
    assert.throws(
      () => canary.verifyArtifactProvenance(records),
      /provenance hash mismatch/
    );
  });

  test('keeps focused evaluator negative cases explicit', () => {
    assert.strictEqual(canary.evaluateCase('partial-effects', {
      status: 'partial-effects',
      fallbackAttempted: true,
      reconciliationRequired: true,
    }).passed, false);
    assert.strictEqual(canary.evaluateCase('duplicate-result', {
      firstAccepted: true,
      secondAccepted: true,
      canonicalWrites: 2,
    }).passed, false);
    assert.throws(() => canary.evaluateCase('unknown', {}), /unknown canary case/);
    assert.throws(
      () => canary.checkRecords(records.slice(0, 5)),
      /missing canary cases/
    );
  });

  test('requires a fresh artifact directory to preserve evidence immutability', () => {
    assert.throws(
      () => canary.deriveCanaryRecords(derivedRoot),
      /artifact root must be empty/
    );
  });

  const runnerRoot = path.join(temporaryDir, 'runner');
  const runnerResult = canary.runDeterministicCanary({ artifactRoot: runnerRoot });
  test('runner serializes and re-verifies artifact-derived records', () => {
    assert.strictEqual(runnerResult.ok, true);
    assert.strictEqual(runnerResult.mode, 'deterministic-artifact-derived');
    assert.strictEqual(runnerResult.evidenceTrust, 'artifact-derived-verified');
    assert.strictEqual(runnerResult.artifactRoot, path.resolve(runnerRoot));
    assert.strictEqual(fs.statSync(runnerResult.recordsFile).isFile(), true);
    assert.strictEqual(readJson(runnerResult.recordsFile).length, 6);
    assert.ok(runnerResult.artifactsVerified >= 15);
  });

  test('self-test mode is ephemeral and explicitly offline', () => {
    const cli = runCli(['self-test']);
    assert.strictEqual(cli.status, 0, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.strictEqual(output.command, 'self-test');
    assert.strictEqual(output.mode, 'deterministic-artifact-derived');
    assert.strictEqual(output.evidenceTrust, 'artifact-derived-verified');
    assert.strictEqual(output.artifactRoot, null);
    assert.strictEqual(output.recordsFile, null);
  });

  const cliRoot = path.join(temporaryDir, 'cli-run');
  test('run mode persists inspectable evidence in an explicit empty root', () => {
    const cli = runCli(['run', '--artifact-root', cliRoot]);
    assert.strictEqual(cli.status, 0, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.strictEqual(output.command, 'run');
    assert.strictEqual(output.artifactRoot, path.resolve(cliRoot));
    assert.strictEqual(fs.statSync(output.recordsFile).isFile(), true);
  });

  test('check mode labels caller-supplied records as unverified', () => {
    const cli = runCli(['check', '--file', runnerResult.recordsFile]);
    assert.strictEqual(cli.status, 0, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.mode, 'caller-supplied-record-validator');
    assert.strictEqual(output.evidenceTrust, 'caller-supplied-unverified');
  });

  test('check rejects a caller-supplied false evidence field', () => {
    const invalidRecords = readJson(runnerResult.recordsFile);
    invalidRecords[0].evidence.writerCount = 2;
    const invalidFile = path.join(temporaryDir, 'invalid-records.json');
    fs.writeFileSync(invalidFile, JSON.stringify(invalidRecords));
    const cli = runCli(['check', '--file', invalidFile]);
    assert.strictEqual(cli.status, 1);
    assert.match(cli.stderr, /native runtime canary failed/);
  });

  test('run requires an explicit persistent artifact root', () => {
    const cli = runCli(['run']);
    assert.strictEqual(cli.status, 1);
    assert.match(cli.stderr, /run requires --artifact-root/);
  });

  test('help distinguishes derived runs from caller-supplied validation', () => {
    const cli = runCli(['--help']);
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /self-test/);
    assert.match(cli.stdout, /caller-supplied record fields only/);
  });
} finally {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}

console.log(`native-runtime-canary: ${passed} passed`);
