#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const {
  CODEX_SKILL_NAMES,
  COMMAND_NAMES,
  INVENTORY_SHA256,
} = require('./lib/managed-plugin-inventory');

const MAX_REQUIREMENT_BYTES = 16 * 1024;
const MANAGED_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLUGIN_NAMESPACE = 'tech-persistence';
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class ManagedInvocationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedInvocationError';
    this.code = code;
  }
}

function firstMeaningfulContent(requirement) {
  return requirement.replace(/^(?:[ \t]*(?:\r?\n|$))+/, '').replace(/^[ \t]+/, '');
}

function parseManagedInvocation(requirement) {
  if (typeof requirement !== 'string') {
    throw new ManagedInvocationError('HARNESS_INVALID_REQUIREMENT', 'requirement must be a string');
  }
  const content = firstMeaningfulContent(requirement);
  if (!content.startsWith('/') && !content.startsWith('$')) return null;
  if (Buffer.byteLength(requirement, 'utf8') > MAX_REQUIREMENT_BYTES) {
    throw new ManagedInvocationError('HARNESS_REQUIREMENT_TOO_LARGE', 'managed invocation requirement is too large');
  }
  if (UNSAFE_CONTROL_CHARACTER.test(requirement)) {
    throw new ManagedInvocationError('HARNESS_CONTROL_CHARACTER', 'managed invocation contains a control character');
  }
  const match = /^([/$])([^\s]+)(?:[ \t]+([\s\S]*)|\r?\n([\s\S]*))?$/.exec(content);
  if (!match) {
    throw new ManagedInvocationError('HARNESS_INVALID_INVOCATION', 'invalid managed invocation syntax or name');
  }
  const targetParts = match[2].split(':');
  const name = targetParts.length === 1
    ? targetParts[0]
    : (targetParts.length === 2 && targetParts[0] === PLUGIN_NAMESPACE ? targetParts[1] : '');
  if (!MANAGED_NAME.test(name)) {
    throw new ManagedInvocationError('HARNESS_INVALID_INVOCATION', 'invalid managed invocation syntax or name');
  }
  const syntax = match[1] === '/' ? 'command' : 'skill';
  const allowedNames = syntax === 'command' ? COMMAND_NAMES : CODEX_SKILL_NAMES;
  if (!allowedNames.includes(name)) {
    throw new ManagedInvocationError(
      syntax === 'command' ? 'HARNESS_UNKNOWN_COMMAND' : 'HARNESS_UNKNOWN_SKILL',
      `unknown managed ${syntax}: ${name}`
    );
  }
  const args = match[3] !== undefined ? match[3] : (match[4] || '');
  const canonicalInvocation = `$${PLUGIN_NAMESPACE}:${name}${args ? ` ${args}` : ''}`;
  return Object.freeze({
    schemaVersion: 'harness-managed-invocation-v1',
    syntax,
    name,
    arguments: args,
    canonicalInvocation,
    inventorySha256: INVENTORY_SHA256,
    requirementSha256: crypto.createHash('sha256').update(requirement).digest('hex'),
  });
}

module.exports = {
  MAX_REQUIREMENT_BYTES,
  ManagedInvocationError,
  PLUGIN_NAMESPACE,
  parseManagedInvocation,
};
