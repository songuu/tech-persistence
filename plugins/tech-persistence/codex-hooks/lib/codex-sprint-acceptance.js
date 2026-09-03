'use strict';

const fs = require('fs');
const path = require('path');
const acceptance = require('./acceptance-contract');
const { stableHash } = require('./self-learning-canonical');
const controlStore = require('../agent-orchestrator/control-store');
const { collectAcceptanceShadowReport } = require('../agent-orchestrator/acceptance-shadow-report');
const acceptanceEvaluator = require('../agent-orchestrator/acceptance-evaluator');

const SCHEMA_VERSION = 'codex-sprint-acceptance-binding-v1';
const START_MARKER = '<!-- acceptance-contract:start -->';
const END_MARKER = '<!-- acceptance-contract:end -->';

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function regularJson(file, root) {
  const resolved = path.resolve(file);
  if (!inside(path.resolve(root), resolved)) throw new Error('acceptance artifact escapes its root');
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('acceptance artifact must be a bounded regular file');
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function acceptanceStatements(planText) {
  const start = planText.indexOf(START_MARKER);
  const end = planText.indexOf(END_MARKER);
  if (start < 0 || end <= start || planText.indexOf(START_MARKER, start + 1) >= 0
      || planText.indexOf(END_MARKER, end + 1) >= 0) {
    throw new Error('plan requires one canonical acceptance-contract marker block');
  }
  const statements = planText.slice(start + START_MARKER.length, end)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*- \[[ xX]\]\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1]);
  if (statements.length === 0 || new Set(statements).size !== statements.length) {
    throw new Error('plan acceptance-contract block requires unique checklist statements');
  }
  return statements;
}

function bindingPath(planFile) {
  return `${path.resolve(planFile)}.acceptance.json`;
}

function normalizeBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sprint acceptance binding must be an object');
  }
  const keys = Object.keys(value).sort();
  const expected = [
    'acceptanceSourceHash', 'bindingHash', 'contractHash', 'plan',
    'runLocator', 'schemaVersion',
  ].sort();
  if (keys.join(',') !== expected.join(',') || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('sprint acceptance binding shape is invalid');
  }
  const core = {
    schemaVersion: SCHEMA_VERSION,
    plan: String(value.plan),
    acceptanceSourceHash: String(value.acceptanceSourceHash),
    runLocator: String(value.runLocator),
    contractHash: String(value.contractHash),
  };
  if (stableHash(core) !== value.bindingHash) {
    throw new Error('sprint acceptance binding hash is invalid');
  }
  return { ...core, bindingHash: value.bindingHash };
}

function bindSprintAcceptance({ cwd, plan, runDir, controlRoot }) {
  const workspace = path.resolve(cwd || process.cwd());
  const planFile = path.resolve(workspace, plan);
  const plansRoot = path.join(workspace, 'docs', 'plans');
  if (!inside(plansRoot, planFile)) throw new Error('plan must stay under docs/plans');
  const planStat = fs.lstatSync(planFile);
  if (!planStat.isFile() || planStat.isSymbolicLink()) throw new Error('plan must be a regular file');
  const statements = acceptanceStatements(fs.readFileSync(planFile, 'utf8'));
  const resolvedRunDir = path.resolve(runDir);
  if (!inside(workspace, resolvedRunDir)) throw new Error('acceptance run must stay inside workspace');
  const contract = regularJson(path.join(resolvedRunDir, 'acceptance-contract.json'), resolvedRunDir);
  acceptance.assertAcceptanceContract(contract);
  if (stableHash([...contract.criteria.map((criterion) => criterion.statement)].sort())
      !== stableHash([...statements].sort())) {
    throw new Error('plan acceptance statements do not match the frozen AcceptanceContract');
  }
  const controlOptions = { providerRoot: workspace, controlRoot: path.resolve(controlRoot) };
  const controlDir = controlStore.controlRunDir(resolvedRunDir, controlOptions);
  const keyedMarker = acceptanceEvaluator.expectedSampleMarkerFile(controlDir, contract.contractHash);
  const markerPath = fs.existsSync(keyedMarker)
    ? keyedMarker
    : path.join(controlDir, 'acceptance-expected-sample.json');
  const marker = controlStore.readAuthoritativeJson(
    resolvedRunDir,
    markerPath,
    controlOptions
  );
  if (!marker || marker.schemaVersion !== 'acceptance-expected-sample-v1'
      || marker.runLocator !== controlStore.stableRunLocator(resolvedRunDir)
      || marker.contractHash !== contract.contractHash) {
    throw new Error('authoritative acceptance freeze marker is invalid');
  }
  const core = {
    schemaVersion: SCHEMA_VERSION,
    plan: path.relative(workspace, planFile).replace(/\\/g, '/'),
    acceptanceSourceHash: stableHash(statements),
    runLocator: controlStore.stableRunLocator(resolvedRunDir),
    contractHash: contract.contractHash,
  };
  const binding = { ...core, bindingHash: stableHash(core) };
  const file = bindingPath(planFile);
  const serialized = `${JSON.stringify(binding, null, 2)}\n`;
  try {
    fs.writeFileSync(file, serialized, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== serialized) throw error;
  }
  return binding;
}

function verifySprintAcceptance({ cwd, plan, controlRoot, requirePassed = false }) {
  const workspace = path.resolve(cwd || process.cwd());
  const planFile = path.resolve(workspace, plan);
  const statements = acceptanceStatements(fs.readFileSync(planFile, 'utf8'));
  const binding = normalizeBinding(regularJson(bindingPath(planFile), path.dirname(planFile)));
  if (binding.plan !== path.relative(workspace, planFile).replace(/\\/g, '/')
      || binding.acceptanceSourceHash !== stableHash(statements)) {
    throw new Error('sprint acceptance binding is stale for the current plan');
  }
  const runDir = path.resolve(binding.runLocator);
  if (!inside(workspace, runDir)) throw new Error('sprint acceptance run locator escaped workspace');
  const contract = regularJson(path.join(runDir, 'acceptance-contract.json'), runDir);
  acceptance.assertAcceptanceContract(contract);
  if (contract.contractHash !== binding.contractHash) {
    throw new Error('sprint acceptance Contract changed after binding');
  }
  if (requirePassed) {
    const report = collectAcceptanceShadowReport(path.dirname(runDir), {
      providerRoot: workspace,
      controlRoot: path.resolve(controlRoot),
    });
    const run = report.runs.find((entry) => (
      pathKey(entry.runLocator) === pathKey(binding.runLocator)
    ));
    if (!run || report.errors.some((entry) => entry.run === path.basename(runDir))) {
      throw new Error('sprint acceptance authority readback is incomplete');
    }
    const passed = run.receipts.some((receipt) => (
      receipt.contractHash === binding.contractHash && receipt.overallStatus === 'passed'
    ));
    if (!passed) throw new Error('review-to-compound requires a passed authoritative Receipt');
  }
  return binding;
}

module.exports = {
  END_MARKER,
  SCHEMA_VERSION,
  START_MARKER,
  acceptanceStatements,
  bindSprintAcceptance,
  bindingPath,
  normalizeBinding,
  verifySprintAcceptance,
};
