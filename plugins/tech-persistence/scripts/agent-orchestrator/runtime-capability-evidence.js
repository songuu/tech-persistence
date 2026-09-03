'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableHash } = require('./runtime-capabilities');

const CAPABILITIES = ['stdin', 'structured-output', 'repo-read', 'workspace-write'];
const MODEL_FILE = '/etc/tech-persistence/provider-model';
function sha256File(file) { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`; }
function load(fileValue, codexCommandValue) {
  const file = path.resolve(String(fileValue || ''));
  const command = path.resolve(String(codexCommandValue || ''));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024
      || (process.platform !== 'win32' && (stat.uid !== 0 || (stat.mode & 0o7777) !== 0o440))) {
    throw new Error('unsafe runtime capability evidence file');
  }
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { receiptHash, ...core } = receipt;
  if (receipt.schemaVersion !== 'runtime-capability-evidence-v1' || receiptHash !== stableHash(core)) {
    throw new Error('invalid runtime capability evidence receipt');
  }
  if (receipt.binding?.commandPath !== command || receipt.binding?.commandHash !== sha256File(command)) {
    throw new Error('runtime capability evidence does not bind the configured Codex command');
  }
  if (process.platform !== 'win32'
      && (receipt.binding?.modelPath !== MODEL_FILE || receipt.binding?.modelHash !== sha256File(MODEL_FILE))) {
    throw new Error('runtime capability evidence does not bind the configured provider model');
  }
  const implementation = receipt.providers?.implementation;
  if (!implementation || implementation.source !== 'authority-native-writer-probe'
      || Number.isNaN(Date.parse(implementation.observedAt || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(implementation.evidenceHash || '')
      || CAPABILITIES.some(capability => implementation.runtimeObserved?.[capability] !== true)) {
    throw new Error('runtime capability evidence is incomplete');
  }
  return { implementation };
}

module.exports = { CAPABILITIES, MODEL_FILE, load, sha256File };
