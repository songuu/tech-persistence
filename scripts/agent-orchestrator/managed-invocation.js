'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { parseManagedInvocation } = require('../harness-managed-invocation');

const MAX_METADATA_BYTES = 64 * 1024;

function readInvocationFile(file) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('managed invocation metadata must be a regular file');
  }
  if (stat.size > MAX_METADATA_BYTES) throw new Error('managed invocation metadata is too large');
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
    throw new Error('managed invocation metadata must not be group/world writable');
  }
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`managed invocation metadata is invalid JSON: ${error.message}`);
  }
}

function resolveManagedInvocation(requirement, metadataFile) {
  const expected = parseManagedInvocation(requirement);
  if (!metadataFile) return expected;
  const supplied = readInvocationFile(metadataFile);
  if (!expected || !isDeepStrictEqual(supplied, expected)) {
    throw new Error('managed invocation metadata does not match requirement or current inventory');
  }
  return Object.freeze({ ...supplied });
}

function managedInvocationPromptBlock(invocation) {
  if (!invocation) return '';
  return [
    'Managed invocation authority:',
    `- Syntax: ${invocation.syntax}`,
    `- Target: ${invocation.name}`,
    `- Inventory SHA-256: ${invocation.inventorySha256}`,
    '- The exact canonical invocation is delimited below:',
    '<managed-invocation>',
    invocation.canonicalInvocation,
    '</managed-invocation>',
    '- You must not rename, replace, or omit this target or its arguments.',
  ].join('\n');
}

module.exports = {
  managedInvocationPromptBlock,
  resolveManagedInvocation,
};
