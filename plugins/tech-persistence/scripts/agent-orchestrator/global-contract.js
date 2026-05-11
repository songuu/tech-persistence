'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CANONICAL_HASH_FIELDS = [
  'goal',
  'nonGoals',
  'globalAcceptance',
  'architectureConstraints',
  'runtimeTargets',
];

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function contractPath(runDir) {
  return path.join(runDir, 'global-contract.json');
}

function historyPath(runDir) {
  return path.join(runDir, 'global-contract.history.jsonl');
}

function revisionsPath(runDir) {
  return path.join(runDir, 'contract-revisions.jsonl');
}

function appendJsonl(file, entry) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function sortedStringArray(value) {
  const arr = Array.isArray(value) ? value.map((item) => String(item)) : [];
  return [...arr].sort();
}

function canonicalContractPayload(contract) {
  const payload = {};
  payload.goal = String(contract.goal || '');
  payload.nonGoals = sortedStringArray(contract.nonGoals);
  payload.globalAcceptance = sortedStringArray(contract.globalAcceptance);
  payload.architectureConstraints = sortedStringArray(contract.architectureConstraints);
  payload.runtimeTargets = sortedStringArray(contract.runtimeTargets);
  return payload;
}

function computeContractHash(contract) {
  const canonical = canonicalContractPayload(contract);
  const serialized = JSON.stringify(canonical);
  return `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`;
}

function normalizeGlobalContract(raw) {
  const contract = raw && typeof raw === 'object' ? raw : {};
  const normalized = {
    version: 'global-v1',
    goal: String(contract.goal || '').trim(),
    nonGoals: Array.isArray(contract.nonGoals) ? contract.nonGoals.map(String) : [],
    globalAcceptance: Array.isArray(contract.globalAcceptance) ? contract.globalAcceptance.map(String) : [],
    architectureConstraints: Array.isArray(contract.architectureConstraints) ? contract.architectureConstraints.map(String) : [],
    runtimeTargets: Array.isArray(contract.runtimeTargets) && contract.runtimeTargets.length > 0
      ? contract.runtimeTargets.map(String)
      : ['claude-code', 'codex'],
    riskLevel: ['L0', 'L1', 'L2', 'L3', 'L4'].includes(contract.riskLevel) ? contract.riskLevel : 'L2',
    blockingQuestions: Array.isArray(contract.blockingQuestions) ? contract.blockingQuestions.map(String) : [],
    integrationValidationCommands: Array.isArray(contract.integrationValidationCommands)
      ? contract.integrationValidationCommands.map(String)
      : [],
  };
  normalized.contractHash = computeContractHash(normalized);
  return normalized;
}

function loadGlobalContract(runDir) {
  const file = contractPath(runDir);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function writeGlobalContract(runDir, contract, cause) {
  const normalized = normalizeGlobalContract(contract);
  writeJson(contractPath(runDir), normalized);
  appendJsonl(historyPath(runDir), {
    writtenAt: nowIso(),
    cause: cause || 'write',
    snapshot: normalized,
  });
  return normalized;
}

function appendRevisionEvent(runDir, revision) {
  appendJsonl(revisionsPath(runDir), revision);
}

function applyRevisionToContract(contract, revision) {
  const next = { ...contract };
  const fields = revision.fields || {};
  for (const key of CANONICAL_HASH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      next[key] = fields[key];
    }
  }
  return normalizeGlobalContract(next);
}

function detectChangedCanonicalFields(previous, next) {
  if (!previous || !next) return [];
  const changed = [];
  for (const key of CANONICAL_HASH_FIELDS) {
    const a = JSON.stringify(sortedStringArrayOrString(previous[key]));
    const b = JSON.stringify(sortedStringArrayOrString(next[key]));
    if (a !== b) changed.push(key);
  }
  return changed;
}

function sortedStringArrayOrString(value) {
  if (Array.isArray(value)) return sortedStringArray(value);
  return value == null ? '' : String(value);
}

module.exports = {
  CANONICAL_HASH_FIELDS,
  contractPath,
  historyPath,
  revisionsPath,
  canonicalContractPayload,
  computeContractHash,
  normalizeGlobalContract,
  loadGlobalContract,
  writeGlobalContract,
  appendRevisionEvent,
  applyRevisionToContract,
  detectChangedCanonicalFields,
};
