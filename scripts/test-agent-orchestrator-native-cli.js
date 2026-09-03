#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const executionEnvelopes = require('./agent-orchestrator/execution-envelopes');
const acceptanceShadowReport = require('./agent-orchestrator/acceptance-shadow-report');
const goalLease = require('./agent-orchestrator/goal-lease');
const turnBudget = require('./agent-orchestrator/turn-budget');
const turnTransaction = require('./agent-orchestrator/turn-transaction');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts', 'agent-orchestrator.js');

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.strictEqual(
    result.status,
    expectedStatus,
    `unexpected status for ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function missingNativeRefProviderScript(pipeline = false) {
  return `
const structuredOutput = ${pipeline ? `{
  version: 'global-v1',
  goal: 'verify fail closed native pipeline output',
  nonGoals: [],
  globalAcceptance: ['native evidence is required'],
  architectureConstraints: [],
  runtimeTargets: ['claude-code', 'codex'],
  riskLevel: 'L1',
  blockingQuestions: []
}` : `{
  requirementSpec: {
    summary: 'summary',
    userValue: 'value',
    scope: ['scope'],
    acceptanceCriteria: ['accepted'],
    outOfScope: [],
    risks: [],
    openQuestions: []
  },
  technicalDesign: {
    approach: 'approach',
    files: [],
    interfaces: [],
    dataAndState: 'none',
    risks: [],
    testStrategy: 'focused'
  },
  taskBreakdown: [{
    id: 'T1',
    title: 'task',
    description: 'verify native evidence',
    dependencies: [],
    risk: 'L1',
    doneCriteria: ['native rejection is recorded'],
    suggestedValidation: []
  }],
  assumptions: [],
  outOfScope: [],
  questions: [],
  humanReviewChecklist: []
}`};
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  structured_output: structuredOutput
}));
`;
}

function acceptedSecretProviderScript(secret) {
  return missingNativeRefProviderScript()
    .replace("summary: 'summary'", `summary: '${secret}'`)
    .replace(
      "subtype: 'success',",
      "subtype: 'success',\n  session_id: 'claude-session-redaction',"
    );
}

function pipelineClaudeProviderScript(
  validationCommands,
  integrationValidationCommands = [],
  mutateIntegrationReview = false,
  oracle = null,
  integrationCriterionIds = [],
  sliceCriterionIds = ['ac-validation-gate']
) {
  return `
const fs = require('fs');
const prompt = [fs.readFileSync(0, 'utf8'), ...process.argv.slice(2)].join('\\n');
let structuredOutput;
let sessionId;
if (prompt.includes('global-contract provider')) {
  structuredOutput = {
    version: 'global-v1',
    goal: 'verify pipeline validation gate',
    nonGoals: [],
    globalAcceptance: ['validation gate is enforced'],
    acceptanceContract: {
      criteria: [{
        id: 'ac-validation-gate',
        statement: 'validation gate is enforced',
        sourceRefs: ['global-contract.json#/globalAcceptance/0'],
        oracle: ${JSON.stringify(oracle || {
          type: 'command',
          procedure: integrationValidationCommands[0] || 'git diff --check',
          expected: 'exit code is zero',
        })}
      }]
    },
    architectureConstraints: [],
    runtimeTargets: ['claude-code', 'codex'],
    riskLevel: 'L1',
    blockingQuestions: []
    ,integrationValidationCommands: ${JSON.stringify(integrationValidationCommands)}
    ,integrationCriterionIds: ${JSON.stringify(integrationCriterionIds)}
  };
  sessionId = 'claude-pipeline-global';
} else if (prompt.includes('slice-planner provider')) {
  structuredOutput = {
    slices: [{
      id: 'slice-001',
      title: 'validation gate slice',
      dependsOn: [],
      ownedFiles: ['pipeline-output.txt'],
      readFiles: [],
      criterionIds: ${JSON.stringify(sliceCriterionIds)},
      risk: 'L1',
      acceptanceCriteria: ['gate blocks unsafe durable writeback'],
      doneCriteria: ['gate behavior is receipted'],
      validationCommands: ${JSON.stringify(validationCommands)},
      questions: []
    }]
  };
  sessionId = 'claude-pipeline-planner';
} else if (prompt.includes('slice-review provider')) {
  structuredOutput = {
    decision: 'approved',
    compliant: true,
    findings: [],
    followUpTasks: [],
    contractRevisions: []
  };
  sessionId = 'claude-pipeline-slice-review';
} else if (prompt.includes('integration-review provider')) {
  ${mutateIntegrationReview ? "fs.writeFileSync('seed.txt', 'mutated after validation  \\n');" : ''}
  structuredOutput = {
    decision: 'approved',
    compliant: true,
    findings: [],
    followUpTasks: [],
    contractRevisions: []
  };
  sessionId = 'claude-pipeline-integration-review';
} else {
  throw new Error('unexpected pipeline prompt');
}

process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  structured_output: structuredOutput
}));
`;
}

function assertPipelineReviewMutationInvalidatesSeal(temporaryRoot, controlRoot) {
  const workdir = path.join(temporaryRoot, 'pipeline-review-mutation-workdir');
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'agent-loop@example.invalid'],
    ['config', 'user.name', 'Agent Loop Test'],
    ['add', 'seed.txt'],
    ['commit', '-m', 'test: seed review mutation worktree'],
  ]) {
    const git = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    assert.strictEqual(git.status, 0, git.stderr || git.stdout);
  }
  const runId = 'pipeline-review-mutation';
  const runDir = path.join(workdir, '.runs', runId);
  const provider = path.join(temporaryRoot, 'fake-pipeline-review-mutation-claude.js');
  const implementationProvider = path.join(temporaryRoot, 'fake-pipeline-review-mutation-codex.js');
  fs.writeFileSync(provider, pipelineClaudeProviderScript(['git diff --check'], ['git diff --check'], true));
  fs.writeFileSync(implementationProvider, validImplementationProviderScript());
  const providerCommand = `${process.execPath} ${provider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;
  const common = [
    '--workdir', workdir, '--runs-dir', '.runs', '--auto', '--allow-dirty',
    '--skip-cli-schema', '--spec-command', providerCommand,
    '--implementation-command', implementationCommand, '--review-command', providerCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot, '--turn-budget-slots', '20',
  ];
  run(['run', '--requirement', 'invalidate stale validation after reviewer mutation', '--run-id', runId, '--pipeline', ...common]);
  let state = readJson(path.join(runDir, 'state.json'));
  for (let attempt = 0; attempt < 8 && state.status !== 'completed'; attempt += 1) {
    run(['resume', '--run', runId, ...common]);
    state = readJson(path.join(runDir, 'state.json'));
  }
  assert.strictEqual(state.status, 'integration-ready');
  assert.strictEqual(state.acceptanceStatus, 'passed');
  assert.strictEqual(readJson(path.join(runDir, 'acceptance-shadow.json')).overallStatus, 'failed');
  assert.strictEqual(
    readJson(path.join(runDir, 'acceptance-review-workspace-drift.json')).revalidated,
    true
  );
  const report = acceptanceShadowReport.collectAcceptanceShadowReport(
    path.join(workdir, '.runs'),
    { providerRoot: workdir, controlRoot }
  );
  assert.deepStrictEqual(report.counts, { passed: 1, failed: 1, unknown: 0 });
  assert.strictEqual(report.errors.length, 0);
}

function assertPipelineFailedShadowReceipt(temporaryRoot, controlRoot) {
  const workdir = path.join(temporaryRoot, 'pipeline-failed-shadow-workdir');
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
  fs.writeFileSync(path.join(workdir, 'fail-validation.js'), "process.exitCode = 1;\n");
  for (const args of [
    ['init'],
    ['config', 'user.email', 'agent-loop@example.invalid'],
    ['config', 'user.name', 'Agent Loop Test'],
    ['add', 'seed.txt', 'fail-validation.js'],
    ['commit', '-m', 'test: seed failed shadow worktree'],
  ]) {
    const git = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    assert.strictEqual(git.status, 0, git.stderr || git.stdout);
  }
  const runId = 'pipeline-failed-shadow-receipt';
  const runDir = path.join(workdir, '.runs', runId);
  const specProvider = path.join(temporaryRoot, 'fake-pipeline-failed-shadow-claude.js');
  const implementationProvider = path.join(temporaryRoot, 'fake-pipeline-failed-shadow-codex.js');
  fs.writeFileSync(specProvider, pipelineClaudeProviderScript(
    ['git diff --check'],
    ['node fail-validation.js'],
    false,
    null,
    ['ac-validation-gate'],
    []
  ));
  fs.writeFileSync(implementationProvider, validImplementationProviderScript());
  const specCommand = `${process.execPath} ${specProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;
  const common = [
    '--workdir', workdir, '--runs-dir', '.runs',
    '--auto', '--allow-dirty', '--skip-cli-schema',
    '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot,
    '--turn-budget-slots', '20',
  ];
  run(['run', '--requirement', 'record failed integration validation', '--run-id', runId, '--pipeline', ...common]);
  const initialProjectionFile = path.join(runDir, 'acceptance-shadow.json');
  let projection = fs.existsSync(initialProjectionFile)
    && readJson(initialProjectionFile).overallStatus === 'failed'
    ? readJson(initialProjectionFile)
    : null;
  for (let attempt = 0; attempt < 8 && !projection; attempt += 1) {
    run(['resume', '--run', runId, ...common]);
    const file = path.join(runDir, 'acceptance-shadow.json');
    if (fs.existsSync(file)) {
      const candidate = readJson(file);
      if (candidate.overallStatus === 'failed') projection = candidate;
    }
  }
  assert(projection, 'failed integration validation must produce a failed shadow Receipt');
  assert.strictEqual(readJson(path.join(runDir, 'state.json')).status, 'integration-ready');
  const report = acceptanceShadowReport.collectAcceptanceShadowReport(
    path.join(workdir, '.runs'),
    { providerRoot: workdir, controlRoot }
  );
  assert.deepStrictEqual(report.counts, { passed: 0, failed: 1, unknown: 1 });
  assert.strictEqual(report.errors.length, 0);
}

function classicClaudeProviderScript(oracle = {
  type: 'command',
  procedure: 'git diff --check',
  expected: 'exit code is zero',
}) {
  return `
const fs = require('fs');
const prompt = [fs.readFileSync(0, 'utf8'), ...process.argv.slice(2)].join('\\n');
let structuredOutput;
if (prompt.includes('analysis and design provider')) {
  structuredOutput = {
    requirementSpec: {
      summary: 'verify classic shadow acceptance',
      userValue: 'completion remains independent from shadow evidence',
      scope: ['agent-loop'],
      acceptanceCriteria: ['classic completion is reviewed']
    },
    acceptanceContract: {
      criteria: [{
        id: 'ac-classic-validation',
        statement: 'classic completion is reviewed',
        sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'],
        oracle: ${JSON.stringify(oracle)}
      }]
    },
    technicalDesign: {
      approach: 'use existing provider pipeline',
      files: [],
      interfaces: [],
      dataAndState: 'none',
      risks: [],
      testStrategy: 'git diff --check'
    },
    taskBreakdown: [{
      id: 'T1',
      title: 'verify',
      description: 'verify classic shadow output',
      dependencies: [],
      risk: 'L1',
      doneCriteria: ['review completes'],
      suggestedValidation: ['git diff --check']
    }],
    assumptions: [],
    outOfScope: [],
    questions: [],
    humanReviewChecklist: []
  };
} else if (prompt.includes('review provider')) {
  structuredOutput = {
    decision: 'approved',
    compliant: true,
    findings: [],
    followUpTasks: [],
    contractRevisions: []
  };
} else {
  throw new Error('unexpected classic prompt');
}
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'claude-classic-shadow',
  structured_output: structuredOutput
}));
`;
}

function assertPipelineShadowReceipts(temporaryRoot, controlRoot) {
  const workdir = path.join(temporaryRoot, 'pipeline-shadow-workdir');
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'agent-loop@example.invalid'],
    ['config', 'user.name', 'Agent Loop Test'],
    ['add', 'seed.txt'],
    ['commit', '-m', 'test: seed shadow worktree'],
  ]) {
    const git = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    assert.strictEqual(git.status, 0, git.stderr || git.stdout);
  }
  const runId = 'pipeline-shadow-receipts';
  const runDir = path.join(workdir, '.runs', runId);
  const specProvider = path.join(temporaryRoot, 'fake-pipeline-shadow-claude.js');
  const implementationProvider = path.join(temporaryRoot, 'fake-pipeline-shadow-codex.js');
  fs.writeFileSync(specProvider, pipelineClaudeProviderScript(['git diff --check']));
  fs.writeFileSync(implementationProvider, validImplementationProviderScript());
  const specCommand = `${process.execPath} ${specProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;

  run([
    'run', '--requirement', 'produce shadow receipts without enforcing them',
    '--workdir', workdir, '--runs-dir', '.runs', '--run-id', runId,
    '--pipeline', '--auto', '--allow-dirty', '--skip-cli-schema',
    '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot,
    '--turn-budget-slots', '20',
  ]);

  let state = readJson(path.join(runDir, 'state.json'));
  for (let attempt = 0; attempt < 6 && state.status !== 'completed'; attempt += 1) {
    run([
      'resume', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
      '--auto', '--allow-dirty', '--skip-cli-schema',
      '--spec-command', specCommand,
      '--implementation-command', implementationCommand,
      '--review-command', specCommand,
      '--capability-router', 'shadow', '--control-root', controlRoot,
      '--turn-budget-slots', '20',
    ]);
    state = readJson(path.join(runDir, 'state.json'));
  }
  assert.strictEqual(
    state.status,
    'completed',
    JSON.stringify({ state, queue: readJson(path.join(runDir, 'queue.json')) }, null, 2)
  );
  assert(fs.existsSync(path.join(runDir, 'acceptance-contract.json')));
  for (const relativeDir of [path.join('slices', 'slice-001'), '.']) {
    const projection = readJson(path.join(runDir, relativeDir, 'acceptance-shadow.json'));
    assert.strictEqual(projection.overallStatus, 'passed');
    assert(fs.existsSync(path.join(runDir, relativeDir, 'acceptance-evidence-index.json')));
    assert(fs.existsSync(path.join(runDir, projection.receiptRef)));
  }
  const report = acceptanceShadowReport.collectAcceptanceShadowReport(
    path.join(workdir, '.runs'),
    { providerRoot: workdir, controlRoot }
  );
  assert.strictEqual(report.receiptCount, 2);
  assert.deepStrictEqual(report.counts, { passed: 2, failed: 0, unknown: 0 });
  assert.strictEqual(report.errors.length, 0);
}

function assertPipelineArtifactShadowReceipts(temporaryRoot, controlRoot) {
  const workdir = path.join(temporaryRoot, 'pipeline-artifact-shadow-workdir');
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'agent-loop@example.invalid'],
    ['config', 'user.name', 'Agent Loop Test'],
    ['add', 'seed.txt'],
    ['commit', '-m', 'test: seed pipeline artifact worktree'],
  ]) {
    const git = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    assert.strictEqual(git.status, 0, git.stderr || git.stdout);
  }
  const runId = 'pipeline-artifact-shadow-receipts';
  const runDir = path.join(workdir, '.runs', runId);
  const specProvider = path.join(temporaryRoot, 'fake-pipeline-artifact-claude.js');
  const implementationProvider = path.join(temporaryRoot, 'fake-pipeline-artifact-codex.js');
  fs.writeFileSync(specProvider, pipelineClaudeProviderScript(
    ['git diff --check'],
    ['git diff --check'],
    false,
    {
      type: 'artifact',
      procedure: 'artifact:pipeline-output.txt',
      expected: 'artifact exists, is fresh, and matches its sealed digest',
    }
  ));
  fs.writeFileSync(implementationProvider, pipelineArtifactImplementationProviderScript());
  const specCommand = `${process.execPath} ${specProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;

  run([
    'run', '--requirement', 'produce pipeline artifact shadow receipts',
    '--workdir', workdir, '--runs-dir', '.runs', '--run-id', runId,
    '--pipeline', '--auto', '--allow-dirty', '--skip-cli-schema',
    '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot,
    '--turn-budget-slots', '20',
  ]);
  let state = readJson(path.join(runDir, 'state.json'));
  for (let attempt = 0; attempt < 6 && state.status !== 'completed'; attempt += 1) {
    run([
      'resume', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
      '--auto', '--allow-dirty', '--skip-cli-schema',
      '--spec-command', specCommand,
      '--implementation-command', implementationCommand,
      '--review-command', specCommand,
      '--capability-router', 'shadow', '--control-root', controlRoot,
      '--turn-budget-slots', '20',
    ]);
    state = readJson(path.join(runDir, 'state.json'));
  }
  assert.strictEqual(state.status, 'completed');
  for (const relativeDir of [path.join('slices', 'slice-001'), '.']) {
    const projection = readJson(path.join(runDir, relativeDir, 'acceptance-shadow.json'));
    assert.strictEqual(projection.overallStatus, 'passed');
    const evidenceIndex = readJson(path.join(
      runDir,
      relativeDir,
      'acceptance-evidence-index.json'
    ));
    assert.strictEqual(evidenceIndex.entries[0].evidenceRef.kind, 'artifact-readback');
    assert.strictEqual(evidenceIndex.entries[0].evidenceRef.assurance, 'verified');
  }
  const report = acceptanceShadowReport.collectAcceptanceShadowReport(
    path.join(workdir, '.runs'),
    { providerRoot: workdir, controlRoot }
  );
  assert.strictEqual(report.receiptCount, 2);
  assert.deepStrictEqual(report.counts, { passed: 2, failed: 0, unknown: 0 });
  assert.deepStrictEqual(report.oracleCounts.artifact, { passed: 2, failed: 0, unknown: 0 });
  assert.strictEqual(report.errors.length, 0);
}

function assertClassicShadowReceipt(temporaryRoot, controlRoot) {
  const workdir = path.join(temporaryRoot, 'classic-shadow-workdir');
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'agent-loop@example.invalid'],
    ['config', 'user.name', 'Agent Loop Test'],
    ['add', 'seed.txt'],
    ['commit', '-m', 'test: seed classic shadow worktree'],
  ]) {
    const git = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    assert.strictEqual(git.status, 0, git.stderr || git.stdout);
  }
  const runId = 'classic-shadow-receipt';
  const runDir = path.join(workdir, '.runs', runId);
  const reviewProvider = path.join(temporaryRoot, 'fake-classic-shadow-claude.js');
  const implementationProvider = path.join(temporaryRoot, 'fake-classic-shadow-codex.js');
  fs.writeFileSync(reviewProvider, classicClaudeProviderScript());
  fs.writeFileSync(implementationProvider, validImplementationProviderScript());
  const reviewCommand = `${process.execPath} ${reviewProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;

  run([
    'run', '--requirement', 'produce a classic shadow receipt',
    '--workdir', workdir, '--runs-dir', '.runs', '--run-id', runId,
    '--allow-dirty', '--skip-cli-schema',
    '--spec-command', reviewCommand,
    '--implementation-command', implementationCommand,
    '--review-command', reviewCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot,
    '--turn-budget-slots', '20',
  ]);
  run([
    'freeze', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
    '--control-root', controlRoot,
  ]);
  let state = readJson(path.join(runDir, 'state.json'));
  for (let attempt = 0; attempt < 6 && state.status !== 'completed'; attempt += 1) {
    run([
      'resume', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
      '--allow-dirty', '--skip-cli-schema', '--validation-command', 'git diff --check',
      '--spec-command', reviewCommand,
      '--implementation-command', implementationCommand,
      '--review-command', reviewCommand,
      '--capability-router', 'shadow', '--control-root', controlRoot,
      '--turn-budget-slots', '20',
    ]);
    state = readJson(path.join(runDir, 'state.json'));
  }
  assert.strictEqual(state.status, 'completed');
  const projection = readJson(path.join(runDir, 'acceptance-shadow.json'));
  assert.strictEqual(projection.overallStatus, 'passed');
  assert(fs.existsSync(path.join(runDir, 'acceptance-evidence-index.json')));
  assert(fs.existsSync(path.join(runDir, projection.receiptRef)));
  const report = acceptanceShadowReport.collectAcceptanceShadowReport(
    path.join(workdir, '.runs'),
    { providerRoot: workdir, controlRoot }
  );
  assert.strictEqual(report.receiptCount, 1);
  assert.deepStrictEqual(report.counts, { passed: 1, failed: 0, unknown: 0 });
  assert.strictEqual(report.errors.length, 0);
}

function assertClassicArtifactShadowReceipt(temporaryRoot, controlRoot) {
  const workdir = path.join(temporaryRoot, 'classic-artifact-shadow-workdir');
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'agent-loop@example.invalid'],
    ['config', 'user.name', 'Agent Loop Test'],
    ['add', 'seed.txt'],
    ['commit', '-m', 'test: seed classic artifact worktree'],
  ]) {
    const git = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    assert.strictEqual(git.status, 0, git.stderr || git.stdout);
  }
  const runId = 'classic-artifact-shadow-receipt';
  const runDir = path.join(workdir, '.runs', runId);
  const reviewProvider = path.join(temporaryRoot, 'fake-classic-artifact-claude.js');
  const implementationProvider = path.join(temporaryRoot, 'fake-classic-artifact-codex.js');
  fs.writeFileSync(reviewProvider, classicClaudeProviderScript({
    type: 'artifact',
    procedure: 'artifact:outputs/classic-result.txt',
    expected: 'artifact exists, is fresh, and matches its sealed digest',
  }));
  fs.writeFileSync(implementationProvider, artifactImplementationProviderScript());
  const reviewCommand = `${process.execPath} ${reviewProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;

  run([
    'run', '--requirement', 'produce a verified artifact shadow receipt',
    '--workdir', workdir, '--runs-dir', '.runs', '--run-id', runId,
    '--allow-dirty', '--skip-cli-schema',
    '--spec-command', reviewCommand,
    '--implementation-command', implementationCommand,
    '--review-command', reviewCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot,
    '--turn-budget-slots', '20',
  ]);
  run([
    'freeze', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
    '--control-root', controlRoot,
  ]);
  let state = readJson(path.join(runDir, 'state.json'));
  for (let attempt = 0; attempt < 6 && state.status !== 'completed'; attempt += 1) {
    run([
      'resume', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
      '--allow-dirty', '--skip-cli-schema', '--validation-command', 'git diff --check',
      '--spec-command', reviewCommand,
      '--implementation-command', implementationCommand,
      '--review-command', reviewCommand,
      '--capability-router', 'shadow', '--control-root', controlRoot,
      '--turn-budget-slots', '20',
    ]);
    state = readJson(path.join(runDir, 'state.json'));
  }
  assert.strictEqual(state.status, 'completed');
  const projection = readJson(path.join(runDir, 'acceptance-shadow.json'));
  assert.strictEqual(projection.overallStatus, 'passed');
  const evidenceIndex = readJson(path.join(runDir, 'acceptance-evidence-index.json'));
  assert.strictEqual(evidenceIndex.entries[0].evidenceRef.kind, 'artifact-readback');
  assert.strictEqual(evidenceIndex.entries[0].evidenceRef.assurance, 'verified');
  const report = acceptanceShadowReport.collectAcceptanceShadowReport(
    path.join(workdir, '.runs'),
    { providerRoot: workdir, controlRoot }
  );
  assert.strictEqual(report.receiptCount, 1);
  assert.deepStrictEqual(report.counts, { passed: 1, failed: 0, unknown: 0 });
  assert.deepStrictEqual(report.oracleCounts.artifact, { passed: 1, failed: 0, unknown: 0 });
  assert.strictEqual(report.errors.length, 0);
}

function validImplementationProviderScript() {
  return `
const fs = require('fs');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('missing --output-last-message');
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  summary: 'implemented without worktree changes',
  changedFiles: [],
  validation: [],
  risks: [],
  followUp: []
}));
process.stdout.write([
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-post-accept-thread' }),
  JSON.stringify({ type: 'turn.started', turn_id: 'codex-post-accept-turn' }),
  JSON.stringify({ type: 'turn.completed' })
].join('\\n'));
`;
}

function artifactImplementationProviderScript() {
  return `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('missing --output-last-message');
const artifactRef = path.join('outputs', 'classic-result.txt');
fs.mkdirSync(path.dirname(path.join(process.cwd(), artifactRef)), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), artifactRef), 'classic artifact result\\n');
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  summary: 'created a fresh classic artifact',
  changedFiles: [artifactRef.replace(/\\\\/g, '/')],
  validation: [],
  risks: [],
  followUp: []
}));
process.stdout.write([
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-artifact-thread' }),
  JSON.stringify({ type: 'turn.started', turn_id: 'codex-artifact-turn' }),
  JSON.stringify({ type: 'turn.completed' })
].join('\\n'));
`;
}

function pipelineArtifactImplementationProviderScript() {
  return `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('missing --output-last-message');
fs.writeFileSync(path.join(process.cwd(), 'pipeline-output.txt'), 'pipeline artifact result\\n');
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  summary: 'created a fresh pipeline artifact',
  changedFiles: ['pipeline-output.txt'],
  validation: [],
  risks: [],
  followUp: []
}));
process.stdout.write([
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-pipeline-artifact-thread' }),
  JSON.stringify({ type: 'turn.started', turn_id: 'codex-pipeline-artifact-turn' }),
  JSON.stringify({ type: 'turn.completed' })
].join('\\n'));
`;
}

function invalidImplementationProviderScript() {
  return `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('missing --output-last-message');
fs.writeFileSync(path.join(process.cwd(), 'changed-after-provider.txt'), 'provider changed the worktree\\n');
if (args.includes('resume')) {
  fs.writeFileSync(path.join(process.cwd(), 'resume-observed.json'), JSON.stringify(args));
}
fs.writeFileSync(args[outputIndex + 1], '{}');
process.stdout.write([
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-invalid-handoff-thread' }),
  JSON.stringify({ type: 'turn.started', turn_id: 'codex-invalid-handoff-turn' }),
  JSON.stringify({ type: 'turn.completed' })
].join('\\n'));
`;
}

function lockfileImplementationProviderScript(content, refSuffix) {
  return `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('missing --output-last-message');
fs.writeFileSync(path.join(process.cwd(), 'package-lock.json'), ${JSON.stringify(content)});
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  summary: 'updated generated lockfile',
  changedFiles: ['package-lock.json'],
  validation: [],
  risks: [],
  followUp: []
}));
process.stdout.write([
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-lockfile-${refSuffix}' }),
  JSON.stringify({ type: 'turn.started', turn_id: 'codex-lockfile-turn-${refSuffix}' }),
  JSON.stringify({ type: 'turn.completed' })
].join('\\n'));
`;
}

function failingReviewProviderScript() {
  return `
process.stderr.write('intentional review pause\\n');
process.exitCode = 1;
`;
}

function failingValidationScript() {
  return `
process.stderr.write('intentional validation failure\\n');
process.exitCode = 1;
`;
}

function assertNativeRejectionDoesNotAdvance(temporaryRoot, controlRoot, pipeline) {
  const mode = pipeline ? 'pipeline' : 'classic';
  const runId = `native-reject-${mode}`;
  const runDir = path.join(temporaryRoot, '.runs', runId);
  const fakeProvider = path.join(temporaryRoot, `fake-${mode}-provider.js`);
  fs.writeFileSync(fakeProvider, missingNativeRefProviderScript(pipeline));
  const providerCommand = `${process.execPath} ${fakeProvider}`;
  const args = [
    'run',
    '--requirement', `reject missing native refs in ${mode}`,
    '--workdir', temporaryRoot,
    '--runs-dir', '.runs',
    '--run-id', runId,
    '--skip-git-repo-check',
    '--skip-cli-schema',
    '--spec-command', providerCommand,
    '--implementation-command', providerCommand,
    '--review-command', providerCommand,
    '--capability-router', 'shadow',
    '--control-root', controlRoot,
  ];
  if (pipeline) args.push('--pipeline');
  const result = run(args, 1);
  assert.match(result.stderr, /native runtime result was not accepted/);
  const state = readJson(path.join(runDir, 'state.json'));
  if (pipeline) {
    assert.notStrictEqual(state.status, 'global-contract-ready');
    assert.strictEqual(state.files.globalContract, undefined);
  } else {
    assert.notStrictEqual(state.status, 'spec-ready');
    assert.strictEqual(state.files.spec, undefined);
  }
  const contractsDir = path.join(runDir, 'contracts');
  const names = fs.readdirSync(contractsDir);
  const baseResultName = names.find((name) => name.endsWith('.result.json')
    && !name.includes('.acceptance-failure.') && !name.includes('.post-acceptance-failure.'));
  const baseAcceptanceName = names.find((name) => name.endsWith('.acceptance.json')
    && !name.includes('.acceptance-failure.') && !name.includes('.post-acceptance-failure.'));
  const failureResultName = names.find((name) => name.includes('.acceptance-failure.result.json'));
  const failureAcceptanceName = names.find((name) => name.includes('.acceptance-failure.acceptance.json'));
  assert(baseResultName && baseAcceptanceName && failureResultName && failureAcceptanceName);
  const baseResult = readJson(path.join(contractsDir, baseResultName));
  const baseAcceptance = readJson(path.join(contractsDir, baseAcceptanceName));
  const failureResult = readJson(path.join(contractsDir, failureResultName));
  const failureAcceptance = readJson(path.join(contractsDir, failureAcceptanceName));
  assert.strictEqual(baseResult.status, 'succeeded');
  assert.strictEqual(baseAcceptance.accepted, false);
  assert(baseAcceptance.errors.includes('native runtime result was not accepted'));
  assert.strictEqual(failureResult.status, 'failed');
  assert.notStrictEqual(failureResult.ref, baseResult.ref);
  assert.strictEqual(failureAcceptance.accepted, false);
  assert.strictEqual(state.providerRuns[0].failure.kind, 'acceptance');
  assert.strictEqual(state.providerRuns[0].rejectedResultEnvelopeHash, baseResult.hash);
  assert.strictEqual(
    names.some((name) => name.endsWith('.accepted.json')),
    false,
    `${mode} must not publish an exclusive accepted result`
  );
}

function assertAcceptedCanonicalArtifactsAreRedacted(temporaryRoot, controlRoot) {
  const runId = 'native-accepted-redaction';
  const runDir = path.join(temporaryRoot, '.runs', runId);
  const fakeProvider = path.join(temporaryRoot, 'fake-secret-provider.js');
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
  fs.writeFileSync(fakeProvider, acceptedSecretProviderScript(secret));
  const providerCommand = `${process.execPath} ${fakeProvider}`;
  run([
    'run',
    '--requirement', 'redact accepted native result',
    '--workdir', temporaryRoot,
    '--runs-dir', '.runs',
    '--run-id', runId,
    '--skip-git-repo-check',
    '--skip-cli-schema',
    '--spec-command', providerCommand,
    '--implementation-command', providerCommand,
    '--review-command', providerCommand,
    '--capability-router', 'shadow',
    '--control-root', controlRoot,
  ]);
  const contractsDir = path.join(runDir, 'contracts');
  const names = fs.readdirSync(contractsDir);
  const resultName = names.find((name) => name.endsWith('.result.json'));
  const acceptedName = names.find((name) => name.endsWith('.accepted.json'));
  assert(resultName, 'canonical result artifact is required');
  assert(acceptedName, 'exclusive accepted artifact is required');
  const canonical = readJson(path.join(contractsDir, resultName));
  const accepted = readJson(path.join(contractsDir, acceptedName));
  assert.deepStrictEqual(accepted, canonical);
  assert(!JSON.stringify(canonical).includes(secret));
  assert.strictEqual(
    canonical.payload.requirementSpec.summary,
    '[REDACTED]'
  );
  const taskName = names.find((name) => name.endsWith('.task.json'));
  const routeName = names.find((name) => name.endsWith('.route.json'));
  const validation = executionEnvelopes.validateResultForAcceptance(
    readJson(path.join(contractsDir, taskName)),
    canonical,
    readJson(path.join(contractsDir, routeName)),
    { routeMode: 'shadow', requireNativeEvidence: true }
  );
  assert.strictEqual(validation.accepted, true, validation.errors.join('; '));
}

function assertPostAcceptanceFailurePreservesAcceptedArtifacts(temporaryRoot, controlRoot) {
  const runId = 'native-post-acceptance-failure';
  const runDir = path.join(temporaryRoot, '.runs', runId);
  const specProvider = path.join(temporaryRoot, 'fake-valid-spec-provider.js');
  const implementationProvider = path.join(temporaryRoot, 'fake-valid-implementation-provider.js');
  fs.writeFileSync(specProvider, acceptedSecretProviderScript('ordinary-summary'));
  fs.writeFileSync(implementationProvider, validImplementationProviderScript());
  const specCommand = `${process.execPath} ${specProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;

  run([
    'run', '--requirement', 'preserve accepted artifacts after a post acceptance write failure',
    '--workdir', temporaryRoot, '--runs-dir', '.runs', '--run-id', runId,
    '--skip-git-repo-check', '--skip-cli-schema',
    '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot,
  ]);
  run([
    'freeze', '--workdir', temporaryRoot, '--runs-dir', '.runs', '--run', runId,
    '--control-root', controlRoot,
  ]);
  const acceptanceContract = readJson(path.join(runDir, 'acceptance-contract.json'));
  assert.strictEqual(acceptanceContract.schemaVersion, 'acceptance-contract-v1');
  assert.strictEqual(acceptanceContract.criteria[0].oracle.type, 'independent-review');
  fs.mkdirSync(path.join(runDir, 'provider-handoff.json'));
  run([
    'resume', '--workdir', temporaryRoot, '--runs-dir', '.runs', '--run', runId,
    '--skip-git-repo-check', '--skip-cli-schema',
    '--spec-command', specCommand,
    '--validation-command', 'node --version',
    '--implementation-command', implementationCommand,
    '--review-command', specCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot,
  ], 1);

  const contractsDir = path.join(runDir, 'contracts');
  const names = fs.readdirSync(contractsDir);
  const baseResultName = names.find((name) => name.startsWith('implementation.')
    && name.endsWith('.result.json') && !name.includes('.post-acceptance-failure.'));
  const baseAcceptanceName = names.find((name) => name.startsWith('implementation.')
    && name.endsWith('.acceptance.json') && !name.includes('.post-acceptance-failure.'));
  const postResultName = names.find((name) => name.includes('.post-acceptance-failure.result.json'));
  const postAcceptanceName = names.find((name) => name.includes('.post-acceptance-failure.acceptance.json'));
  const acceptedName = names.find((name) => name.includes('implementation')
    && name.endsWith('.accepted.json'));
  assert(baseResultName && baseAcceptanceName && postResultName && postAcceptanceName && acceptedName);

  const baseResult = readJson(path.join(contractsDir, baseResultName));
  const baseAcceptance = readJson(path.join(contractsDir, baseAcceptanceName));
  const accepted = readJson(path.join(contractsDir, acceptedName));
  const postResult = readJson(path.join(contractsDir, postResultName));
  const postAcceptance = readJson(path.join(contractsDir, postAcceptanceName));
  assert.strictEqual(baseAcceptance.accepted, true);
  assert.strictEqual(baseResult.hash, accepted.hash);
  assert.notStrictEqual(postResult.hash, baseResult.hash);
  assert.strictEqual(postAcceptance.accepted, false);

  const state = readJson(path.join(runDir, 'state.json'));
  assert.strictEqual(state.providerRecovery.resumeMode, 'reconcile');
  assert.strictEqual(state.providerRecovery.reconcileRequired, true);
  assert.strictEqual(state.providerRuns.at(-1).postAcceptanceFailure, true);
}

function assertClassicValidationBlocksDurableWriteback(
  temporaryRoot,
  controlRoot,
  sourceStatus
) {
  assert(['skipped', 'failed'].includes(sourceStatus));
  const runId = `native-${sourceStatus}-validation`;
  const runDir = path.join(temporaryRoot, '.runs', runId);
  const specProvider = path.join(temporaryRoot, `fake-${sourceStatus}-validation-spec.js`);
  const implementationProvider = path.join(
    temporaryRoot, `fake-${sourceStatus}-validation-implementation.js`
  );
  fs.writeFileSync(specProvider, acceptedSecretProviderScript('validation gate spec'));
  fs.writeFileSync(implementationProvider, validImplementationProviderScript());
  const validationArgs = [];
  if (sourceStatus === 'failed') {
    const validationProvider = path.join(temporaryRoot, 'classic-validation-fail.js');
    fs.writeFileSync(validationProvider, failingValidationScript());
    validationArgs.push(
      '--validation-command',
      `"${process.execPath}" "${validationProvider}"`
    );
  }
  const specCommand = `${process.execPath} ${specProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;
  const common = [
    '--workdir', temporaryRoot, '--runs-dir', '.runs',
    '--skip-git-repo-check', '--skip-cli-schema',
    '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand,
    '--capability-router', 'shadow', '--control-root', controlRoot,
    '--turn-budget-slots', '10',
    ...validationArgs,
  ];

  run([
    'run', '--requirement', `block material result when validation is ${sourceStatus}`,
    '--run-id', runId, ...common,
  ]);
  run(['freeze', '--run', runId, ...common]);
  const failed = run(['resume', '--run', runId, ...common], 1);
  assert.match(
    failed.stderr,
    new RegExp(`provider validation ${sourceStatus}.*requires passed validation`)
  );

  const validation = readJson(path.join(runDir, 'validation.json'));
  assert.strictEqual(validation.status, sourceStatus);
  if (sourceStatus === 'failed') {
    assert.strictEqual(validation.commands[0].exitCode, 1);
  } else {
    assert.deepStrictEqual(validation.commands, []);
  }

  const contractsDir = path.join(runDir, 'contracts');
  const names = fs.readdirSync(contractsDir);
  const journalRecord = turnTransaction.listAuthoritativeTurnJournals(runDir, {
    controlRoot,
    providerRoot: temporaryRoot,
    legacyFiles: [],
  }).find((record) => record.receipt.phaseRecords.some((entry) => (
    entry.phase === 'validation' && entry.payload.sourceStatus === sourceStatus
  )));
  assert(journalRecord, 'implementation validation failure must retain an authoritative turn journal');
  const receipt = journalRecord.receipt;
  assert.strictEqual(receipt.validationStatus, 'failed');
  assert.strictEqual(receipt.currentPhase, 'validation');
  assert.strictEqual(receipt.nextPhase, 'durable-writeback');
  assert.strictEqual(receipt.phaseRecords.at(-1).payload.sourceStatus, sourceStatus);
  const budgetLedger = turnBudget.readTurnBudgetLedger(runDir, {
    controlRoot,
    providerRoot: temporaryRoot,
  });
  assert(budgetLedger.spends.length > 0, 'earlier durable turns must spend budget');
  assert.strictEqual(
    budgetLedger.spends.some((entry) => entry.turnKey === receipt.turnKey),
    false,
    'validation failure before durable-writeback must not spend budget'
  );
  const typedResultPhase = receipt.phaseRecords.find((entry) => entry.phase === 'typed-result');
  assert(typedResultPhase, 'validation failure receipt must retain its typed-result phase');
  const typedResult = readJson(
    path.join(runDir, typedResultPhase.payload.resultArtifactRef)
  );
  assert.strictEqual(typedResult.ref, typedResultPhase.payload.resultRef);
  assert.strictEqual(typedResult.hash, typedResultPhase.payload.resultHash);
  const validationFailureName = names.find((name) => (
    name.startsWith('implementation.')
    && name.includes('.validation-failure.result.json')
  ));
  assert(validationFailureName, 'validation failure must use a distinct result artifact');
  const validationFailure = readJson(path.join(contractsDir, validationFailureName));
  assert.notStrictEqual(validationFailure.ref, typedResult.ref);
  assert.notStrictEqual(validationFailure.hash, typedResult.hash);
  assert.strictEqual(
    names.some((name) => (
      name.includes('implementation') && name.endsWith('.accepted.json')
    )),
    false
  );
  const state = readJson(path.join(runDir, 'state.json'));
  assert.notStrictEqual(state.status, 'implemented');
  assert.strictEqual(state.providerRuns.at(-1).failure.kind, 'validation');
}

function assertPipelineValidationBlocksDurableWriteback(
  temporaryRoot,
  controlRoot,
  sourceStatus
) {
  assert(['skipped', 'failed'].includes(sourceStatus));
  const runId = `pipeline-${sourceStatus}-validation`;
  const runDir = path.join(temporaryRoot, '.runs', runId);
  const specProvider = path.join(
    temporaryRoot,
    `fake-pipeline-${sourceStatus}-claude.js`
  );
  const implementationProvider = path.join(
    temporaryRoot,
    `fake-pipeline-${sourceStatus}-implementation.js`
  );
  const validationCommands = [];
  if (sourceStatus === 'failed') {
    const validationProvider = path.join(temporaryRoot, 'pipeline-validation-fail.js');
    fs.writeFileSync(validationProvider, failingValidationScript());
    validationCommands.push('node pipeline-validation-fail.js');
  }
  fs.writeFileSync(specProvider, pipelineClaudeProviderScript(validationCommands));
  fs.writeFileSync(implementationProvider, validImplementationProviderScript());

  const specCommand = `${process.execPath} ${specProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;
  run([
    'run',
    '--requirement', `block pipeline result when validation is ${sourceStatus}`,
    '--workdir', temporaryRoot,
    '--runs-dir', '.runs',
    '--run-id', runId,
    '--pipeline',
    '--auto',
    '--skip-git-repo-check',
    '--skip-cli-schema',
    '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand,
    '--capability-router', 'shadow',
    '--control-root', controlRoot,
    '--turn-budget-slots', '10',
  ]);

  const acceptanceContract = readJson(path.join(runDir, 'acceptance-contract.json'));
  assert.strictEqual(acceptanceContract.schemaVersion, 'acceptance-contract-v1');
  assert.strictEqual(acceptanceContract.criteria[0].oracle.type, 'command');

  const sliceDir = path.join(runDir, 'slices', 'slice-001');
  const validation = readJson(path.join(sliceDir, 'validation.json'));
  assert.strictEqual(validation.schemaVersion, 'integration-validation-v1');
  assert.strictEqual(validation.status, sourceStatus);
  if (sourceStatus === 'failed') {
    assert.strictEqual(validation.commands[0].status, 'failed');
    assert.strictEqual(validation.commands[0].exitStatus, 1);
  } else {
    assert.deepStrictEqual(validation.commands, []);
  }

  const contractsDir = path.join(runDir, 'contracts');
  const names = fs.readdirSync(contractsDir);
  const journalRecord = turnTransaction.listAuthoritativeTurnJournals(runDir, {
    controlRoot,
    providerRoot: temporaryRoot,
    legacyFiles: [],
  }).find((record) => record.receipt.phaseRecords.some((entry) => (
    entry.phase === 'validation' && entry.payload.sourceStatus === sourceStatus
  )));
  assert(journalRecord, 'pipeline validation failure must retain an authoritative turn journal');
  const receipt = journalRecord.receipt;
  assert.strictEqual(receipt.validationStatus, 'failed');
  assert.strictEqual(receipt.currentPhase, 'validation');
  assert.strictEqual(receipt.nextPhase, 'durable-writeback');
  assert.strictEqual(receipt.phaseRecords.at(-1).payload.sourceStatus, sourceStatus);
  const budgetLedger = turnBudget.readTurnBudgetLedger(runDir, {
    controlRoot,
    providerRoot: temporaryRoot,
  });
  assert(budgetLedger.spends.length > 0, 'earlier durable turns must spend budget');
  assert.strictEqual(
    budgetLedger.spends.some((entry) => entry.turnKey === receipt.turnKey),
    false,
    'validation failure before durable-writeback must not spend budget'
  );
  assert.strictEqual(receipt.completedPhases.includes('durable-writeback'), false);
  assert.strictEqual(
    names.some((name) => (
      name.includes('slice-implementation-slice-001')
      && name.endsWith('.accepted.json')
    )),
    false
  );
  assert.strictEqual(fs.existsSync(path.join(sliceDir, 'provider-handoff.json')), false);

  const state = readJson(path.join(runDir, 'state.json'));
  assert.strictEqual(
    state.pipeline.sliceStates['slice-001'],
    'slice-implementation-failed'
  );
  assert.strictEqual(state.providerRuns.at(-1).failure.kind, 'validation');
  const queue = readJson(path.join(runDir, 'queue.json'));
  assert(queue.blocked.some((entry) => entry.sliceId === 'slice-001'));
}

function assertClassicInvalidHandoffPersistsPartialRecovery(temporaryRoot, controlRoot) {
  const workdir = path.join(temporaryRoot, 'classic-invalid-workdir');
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'agent-loop@example.invalid'],
    ['config', 'user.name', 'Agent Loop Test'],
    ['add', 'seed.txt'],
    ['commit', '-m', 'test: seed invalid handoff worktree'],
  ]) {
    const result = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  }

  const runId = 'classic-invalid-handoff';
  const runDir = path.join(workdir, '.runs', runId);
  const specProvider = path.join(temporaryRoot, 'fake-invalid-handoff-spec.js');
  const implementationProvider = path.join(temporaryRoot, 'fake-invalid-handoff-codex.js');
  fs.writeFileSync(specProvider, acceptedSecretProviderScript('valid spec before invalid handoff'));
  fs.writeFileSync(implementationProvider, invalidImplementationProviderScript());
  const specCommand = `${process.execPath} ${specProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;

  run([
    'run', '--requirement', 'reject empty classic implementation handoff',
    '--workdir', workdir, '--runs-dir', '.runs', '--run-id', runId,
    '--skip-cli-schema', '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand, '--capability-router', 'shadow',
    '--control-root', controlRoot,
  ]);
  run([
    'freeze', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
    '--control-root', controlRoot,
  ]);
  const firstFailure = run([
    'resume', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
    '--skip-cli-schema', '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand, '--capability-router', 'shadow',
    '--control-root', controlRoot,
  ], 1);
  assert.match(firstFailure.stderr, /failed local schema validation/);
  let state = readJson(path.join(runDir, 'state.json'));
  assert.strictEqual(state.status, 'frozen');
  assert.strictEqual(state.providerRecovery.effectsState, 'partial');
  assert.strictEqual(state.providerRecovery.resumeMode, 'native');
  assert.strictEqual(state.providerRecovery.runtimeRefs.threadId, 'codex-invalid-handoff-thread');
  assert.strictEqual(state.providerRecovery.stage, 'implementation');
  assert.strictEqual(state.providerRuns.at(-1).failure.kind, 'schema-validation');
  assert.strictEqual(fs.existsSync(path.join(runDir, 'handoff.json')), false);
  assert.strictEqual(
    fs.readdirSync(path.join(runDir, 'contracts')).some((name) => (
      name.includes('implementation') && name.endsWith('.accepted.json')
    )),
    false
  );

  run([
    'resume', '--workdir', workdir, '--runs-dir', '.runs', '--run', runId,
    '--allow-dirty', '--skip-cli-schema', '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', specCommand, '--capability-router', 'shadow',
    '--control-root', controlRoot,
  ], 1);
  const observedArgs = readJson(path.join(workdir, 'resume-observed.json'));
  assert(observedArgs.includes('resume'));
  assert(observedArgs.includes('codex-invalid-handoff-thread'));
  state = readJson(path.join(runDir, 'state.json'));
  assert.strictEqual(state.providerRecovery.effectsState, 'partial');
}

function initializeLockfileRepository(workdir) {
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
  fs.writeFileSync(
    path.join(workdir, 'package-lock.json'),
    '{"name":"fixture","lockfileVersion":3,"packages":{}}\n'
  );
  for (const args of [
    ['init'],
    ['config', 'user.email', 'agent-loop@example.invalid'],
    ['config', 'user.name', 'Agent Loop Test'],
    ['add', 'seed.txt', 'package-lock.json'],
    ['commit', '-m', 'test: seed lockfile diff fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  }
}

function runLockfileImplementationFixture(
  temporaryRoot,
  controlRoot,
  fixtureId,
  lockfileContent
) {
  const workdir = path.join(temporaryRoot, `lockfile-workdir-${fixtureId}`);
  initializeLockfileRepository(workdir);
  const runId = `lockfile-diff-${fixtureId}`;
  const runDir = path.join(workdir, '.runs', runId);
  const specProvider = path.join(temporaryRoot, `fake-lockfile-spec-${fixtureId}.js`);
  const implementationProvider = path.join(temporaryRoot, `fake-lockfile-impl-${fixtureId}.js`);
  const reviewProvider = path.join(temporaryRoot, `fake-lockfile-review-${fixtureId}.js`);
  fs.writeFileSync(specProvider, acceptedSecretProviderScript(`lockfile diff fixture ${fixtureId}`));
  fs.writeFileSync(
    implementationProvider,
    lockfileImplementationProviderScript(lockfileContent, fixtureId)
  );
  fs.writeFileSync(reviewProvider, failingReviewProviderScript());
  const specCommand = `${process.execPath} ${specProvider}`;
  const implementationCommand = `${process.execPath} ${implementationProvider}`;
  const reviewCommand = `${process.execPath} ${reviewProvider}`;
  const common = [
    '--workdir', workdir, '--runs-dir', '.runs',
    '--skip-cli-schema', '--spec-command', specCommand,
    '--implementation-command', implementationCommand,
    '--review-command', reviewCommand, '--capability-router', 'shadow',
    '--validation-command', 'git diff --check',
    '--control-root', controlRoot,
  ];
  run([
    'run', '--requirement', `bind omitted lockfile content ${fixtureId}`,
    '--run-id', runId, ...common,
  ]);
  run(['freeze', '--run', runId, ...common]);
  const paused = run(['resume', '--run', runId, ...common], 1);
  assert.match(paused.stderr, /intentional review pause|review provider exited with (?:status )?1/);

  const bundle = readJson(path.join(runDir, 'provider-handoff.json'));
  const diffText = fs.readFileSync(path.join(runDir, 'diff.patch'), 'utf8');
  assert.match(diffText, /omitted-diff-content-v1/);
  assert.match(diffText, /"head":\{"exists":true,[^}]*"objectId":"[0-9a-f]+"/);
  assert.match(diffText, /"index":\{"exists":true,"entries":\[/);
  assert.match(diffText, /"worktree":\{"exists":true,"type":"file","size":\d+,"objectId":"[0-9a-f]+"/);
  return {
    workdir,
    runDir,
    runId,
    common,
    diffHash: bundle.result.evidence.diffHash,
  };
}

function assertOmittedLockfileContentInvalidatesHandoff(temporaryRoot, controlRoot) {
  const first = runLockfileImplementationFixture(
    temporaryRoot,
    controlRoot,
    'first',
    '{"name":"fixture","lockfileVersion":3,"packages":{"a":{"version":"1.0.0"}}}\n'
  );
  const second = runLockfileImplementationFixture(
    temporaryRoot,
    controlRoot,
    'second',
    '{"name":"fixture","lockfileVersion":3,"packages":{"a":{"version":"2.0.0"}}}\n'
  );
  assert.notStrictEqual(
    first.diffHash,
    second.diffHash,
    'same omitted path with different content must produce different diffHash values'
  );

  fs.writeFileSync(
    path.join(first.workdir, 'package-lock.json'),
    '{"name":"fixture","lockfileVersion":3,"packages":{"a":{"version":"3.0.0"}}}\n'
  );
  const stale = run(['resume', '--run', first.runId, ...first.common], 1);
  assert.match(stale.stderr, /provider handoff diffHash is stale for the current worktree/);
}

function main() {
  const persistentRoot = process.env.TP_NATIVE_CLI_FIXTURE_ROOT;
  const persistentControlRoot = process.env.TP_NATIVE_CLI_CONTROL_ROOT;
  if ((persistentRoot && !persistentControlRoot) || (!persistentRoot && persistentControlRoot)) {
    throw new Error('TP_NATIVE_CLI_FIXTURE_ROOT and TP_NATIVE_CLI_CONTROL_ROOT must be set together');
  }
  const temporaryRoot = persistentRoot
    ? path.resolve(persistentRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'tp-native-cli-'));
  const controlRoot = persistentControlRoot
    ? path.resolve(persistentControlRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'tp-native-control-'));
  if (persistentRoot) {
    fs.mkdirSync(temporaryRoot, { recursive: false });
    fs.mkdirSync(controlRoot, { recursive: false });
  }
  const runId = 'native-cli-test';
  const runDir = path.join(temporaryRoot, '.runs', runId);
  try {
    run([
      'run',
      '--requirement', 'verify native runtime control plane',
      '--workdir', temporaryRoot,
      '--runs-dir', '.runs',
      '--run-id', runId,
      '--dry-run',
      '--skip-git-repo-check',
      '--turn-budget-slots', '2',
      '--spec-command', process.execPath,
      '--implementation-command', process.execPath,
      '--review-command', process.execPath,
      '--orchestration-owner', 'codex-host',
      '--capability-router', 'shadow',
      '--claude-adapter', 'bare',
      '--codex-adapter', 'exec',
      '--control-root', controlRoot,
    ]);

    const executionPlan = readJson(path.join(runDir, 'execution-plan.json'));
    assert.strictEqual(executionPlan.version, 'execution-plan-v2');
    assert.strictEqual(executionPlan.orchestrationOwner, 'codex-host');
    assert.deepStrictEqual(executionPlan.adapterPolicy, { claude: 'bare', codex: 'exec' });
    assert.strictEqual(executionPlan.capabilityRouter.mode, 'shadow');
    assert.ok(executionPlan.stages.spec.capabilities, 'spec capability snapshot is required');
    assert.ok(executionPlan.stages.implementation.routeDecision, 'implementation route decision is required');

    const initializedBudget = turnBudget.readTurnBudgetLedger(runDir, {
      controlRoot,
      providerRoot: temporaryRoot,
    });
    assert(initializedBudget, 'run initialization must create authority ledger');
    assert.strictEqual(initializedBudget.runId, runId);
    assert.strictEqual(initializedBudget.enabled, true);
    assert.strictEqual(initializedBudget.maxSlots, 2);
    assert.strictEqual(initializedBudget.revision, 0);
    assert.deepStrictEqual(initializedBudget.spends, []);

    const statePath = path.join(runDir, 'state.json');
    let state = readJson(statePath);
    state.turnBudgetPolicy = { enabled: false, maxSlots: null };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

    const budgetStatus = JSON.parse(run([
      'status',
      '--workdir', temporaryRoot,
      '--runs-dir', '.runs',
      '--run', runId,
      '--control-root', controlRoot,
      '--json',
    ]).stdout);
    assert.strictEqual(budgetStatus.turnBudget.authority, 'external-control-store');
    assert.strictEqual(budgetStatus.turnBudget.enabled, true);
    assert.strictEqual(budgetStatus.turnBudget.max, 2);
    assert.strictEqual(budgetStatus.turnBudget.revision, 0);

    const dryResume = run([
      'resume',
      '--workdir', temporaryRoot,
      '--runs-dir', '.runs',
      '--run', runId,
      '--control-root', controlRoot,
    ]);
    assert.match(dryResume.stdout, /dry-run.*No provider calls to resume/);
    const budgetAfterResume = turnBudget.readTurnBudgetLedger(runDir, {
      controlRoot,
      providerRoot: temporaryRoot,
    });
    assert.strictEqual(budgetAfterResume.ledgerHash, initializedBudget.ledgerHash);
    assert.strictEqual(budgetAfterResume.revision, 0);
    assert.deepStrictEqual(budgetAfterResume.spends, []);
    run([
      'goal-bind',
      '--workdir', temporaryRoot,
      '--runs-dir', '.runs',
      '--run', runId,
      '--runtime', 'codex',
      '--host-ref', 'thread:test-opaque-ref',
      '--objective', 'verify native runtime control plane',
      '--control-root', controlRoot,
    ]);
    let lease = readJson(path.join(runDir, 'goal-lease.json'));
    assert.strictEqual(lease.status, 'active');
    assert.strictEqual(lease.ownerRuntime, 'codex');
    assert.match(lease.objectiveHash, /^sha256:[a-f0-9]{64}$/);
    assert.strictEqual(lease.hostRef, undefined, 'run projection must not expose opaque hostRef');
    assert.strictEqual(
      goalLease.readGoalLease(runDir, { controlRoot }).hostRef,
      'thread:test-opaque-ref'
    );

    state = readJson(path.join(runDir, 'state.json'));
    assert.strictEqual(state.files.goalLease, 'goal-lease.json');

    run([
      'goal-release',
      '--workdir', temporaryRoot,
      '--runs-dir', '.runs',
      '--run', runId,
      '--reason', 'test complete',
      '--control-root', controlRoot,
    ]);
    lease = readJson(path.join(runDir, 'goal-lease.json'));
    assert.strictEqual(lease.status, 'released');
    assert.strictEqual(
      goalLease.readGoalLease(runDir, { controlRoot }).releaseReason,
      'test complete'
    );
    const wrongHostRuntime = run([
      'goal-bind',
      '--workdir', temporaryRoot,
      '--runs-dir', '.runs',
      '--run', runId,
      '--runtime', 'claude',
      '--host-ref', 'session:wrong-host',
      '--objective', 'verify native runtime control plane',
      '--control-root', controlRoot,
    ], 1);
    assert.match(wrongHostRuntime.stderr, /goal-bind owner conflict/);

    const help = run(['help']).stdout;
    assert.match(help, /--orchestration-owner <owner>/);
    assert.match(help, /--capability-router <mode>/);
    assert.match(help, /goal-bind/);
    assert.match(help, /goal-release/);

    const tpRunId = 'native-cli-tp-goal-test';
    const tpRunDir = path.join(temporaryRoot, '.runs', tpRunId);
    run([
      'run',
      '--requirement', 'bind either host Goal under tp ownership',
      '--workdir', temporaryRoot,
      '--runs-dir', '.runs',
      '--run-id', tpRunId,
      '--dry-run',
      '--skip-git-repo-check',
      '--spec-command', process.execPath,
      '--implementation-command', process.execPath,
      '--review-command', process.execPath,
      '--orchestration-owner', 'tp',
      '--control-root', controlRoot,
    ]);
    run([
      'goal-bind',
      '--workdir', temporaryRoot,
      '--runs-dir', '.runs',
      '--run', tpRunId,
      '--runtime', 'claude',
      '--host-ref', 'session:test-opaque-ref',
      '--objective', 'bind either host Goal under tp ownership',
      '--control-root', controlRoot,
    ]);
    assert.strictEqual(
      goalLease.readGoalLease(tpRunDir, { controlRoot }).ownerRuntime,
      'claude'
    );

    assertNativeRejectionDoesNotAdvance(temporaryRoot, controlRoot, false);
    assertNativeRejectionDoesNotAdvance(temporaryRoot, controlRoot, true);
    assertAcceptedCanonicalArtifactsAreRedacted(temporaryRoot, controlRoot);
    assertClassicValidationBlocksDurableWriteback(temporaryRoot, controlRoot, 'skipped');
    assertClassicValidationBlocksDurableWriteback(temporaryRoot, controlRoot, 'failed');
    assertPipelineValidationBlocksDurableWriteback(temporaryRoot, controlRoot, 'skipped');
    assertPipelineValidationBlocksDurableWriteback(temporaryRoot, controlRoot, 'failed');
    assertPipelineShadowReceipts(temporaryRoot, controlRoot);
    assertPipelineArtifactShadowReceipts(temporaryRoot, controlRoot);
    assertPipelineReviewMutationInvalidatesSeal(temporaryRoot, controlRoot);
    assertPipelineFailedShadowReceipt(temporaryRoot, controlRoot);
    assertClassicShadowReceipt(temporaryRoot, controlRoot);
    assertClassicArtifactShadowReceipt(temporaryRoot, controlRoot);
    assertPostAcceptanceFailurePreservesAcceptedArtifacts(temporaryRoot, controlRoot);
    assertClassicInvalidHandoffPersistsPartialRecovery(temporaryRoot, controlRoot);
    assertOmittedLockfileContentInvalidatesHandoff(temporaryRoot, controlRoot);
  } finally {
    if (!persistentRoot) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      fs.rmSync(controlRoot, { recursive: true, force: true });
    }
  }

  console.log('[OK] agent orchestrator native CLI integration tests passed');
}

if (require.main === module) main();
module.exports = { classicClaudeProviderScript, pipelineClaudeProviderScript, validImplementationProviderScript };
