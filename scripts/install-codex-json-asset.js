#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const {
  marketplaceExpectationFromRaw,
  publishTextCompareAndSwap,
  reconcilePublishJournal,
  stripLeadingBom,
} = require('./update-codex-marketplace');

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertJsonObject(text, label) {
  const value = JSON.parse(stripLeadingBom(text));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function readReplacement(options) {
  if (Boolean(options.source) === Boolean(options.defaultJson !== undefined)) {
    throw new Error('JSON asset install requires exactly one of source or defaultJson');
  }
  if (options.source) {
    const source = path.resolve(options.source);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`JSON asset source must be a plain file: ${source}`);
    }
    const text = fs.readFileSync(source, 'utf8');
    assertJsonObject(text, `JSON asset source ${source}`);
    return text;
  }
  const parsed = assertJsonObject(String(options.defaultJson), 'default JSON asset');
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function installJsonAsset(options = {}) {
  if (!options.target) throw new Error('JSON asset target is required');
  const target = path.resolve(options.target);
  const replacement = readReplacement(options);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  reconcilePublishJournal(target);

  if (!pathExists(target)) {
    publishTextCompareAndSwap(
      target,
      replacement,
      marketplaceExpectationFromRaw(null),
      { testHooks: options.testHooks }
    );
    return { target, status: 'created', backupPath: null };
  }

  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`JSON asset target must be a plain file: ${target}`);
  }
  const raw = fs.readFileSync(target);
  try {
    assertJsonObject(raw.toString('utf8'), `existing JSON asset ${target}`);
    return { target, status: 'existing-valid', backupPath: null };
  } catch {
    const expectation = marketplaceExpectationFromRaw(
      raw,
      process.platform === 'win32' ? null : stat.mode & 0o777
    );
    const published = publishTextCompareAndSwap(target, replacement, expectation, {
      retainPrevious: true,
      previousLabel: 'bak.invalid',
      testHooks: options.testHooks,
    });
    return {
      target,
      status: 'repaired-invalid',
      backupPath: published.previousPath,
    };
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--target', '--source', '--default-json'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === '--target') options.target = value;
    else if (argument === '--source') options.source = value;
    else if (argument === '--default-json') options.defaultJson = value;
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const result = installJsonAsset(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  installJsonAsset,
};
