#!/usr/bin/env node

'use strict';

const assert = require('assert');
const {
  ManagedInvocationError,
  parseManagedInvocation,
} = require('./harness-managed-invocation');

function main() {
  assert.strictEqual(parseManagedInvocation('ordinary requirement'), null);
  assert.strictEqual(parseManagedInvocation('\n  ordinary requirement'), null);
  assert.strictEqual(parseManagedInvocation('x'.repeat(20 * 1024)), null);

  const command = parseManagedInvocation('\n/sprint --auto\nship it');
  assert.deepStrictEqual(command, {
    schemaVersion: 'harness-managed-invocation-v1',
    syntax: 'command',
    name: 'sprint',
    arguments: '--auto\nship it',
    canonicalInvocation: '$tech-persistence:sprint --auto\nship it',
    inventorySha256: command.inventorySha256,
    requirementSha256: command.requirementSha256,
  });
  assert.match(command.inventorySha256, /^[a-f0-9]{64}$/);
  assert.match(command.requirementSha256, /^[a-f0-9]{64}$/);

  const skill = parseManagedInvocation('$tech-persistence:memory find provider evidence');
  assert.strictEqual(skill.syntax, 'skill');
  assert.strictEqual(skill.name, 'memory');
  assert.strictEqual(skill.arguments, 'find provider evidence');
  assert.strictEqual(skill.canonicalInvocation, '$tech-persistence:memory find provider evidence');
  assert.strictEqual(
    parseManagedInvocation('$memory find provider evidence').canonicalInvocation,
    '$tech-persistence:memory find provider evidence'
  );
  assert.strictEqual(
    parseManagedInvocation('/tech-persistence:sprint --auto').canonicalInvocation,
    '$tech-persistence:sprint --auto'
  );

  assert.throws(() => parseManagedInvocation('/memory'), (error) => (
    error instanceof ManagedInvocationError
    && error.code === 'HARNESS_UNKNOWN_COMMAND'
  ));
  assert.throws(() => parseManagedInvocation('$does-not-exist'), (error) => (
    error instanceof ManagedInvocationError
    && error.code === 'HARNESS_UNKNOWN_SKILL'
  ));
  assert.throws(() => parseManagedInvocation('$other:sprint'), /invalid managed invocation/i);
  assert.throws(() => parseManagedInvocation('/../work'), /invalid managed invocation/i);
  assert.throws(() => parseManagedInvocation('/work bad\u0001arg'), /control character/i);
  assert.throws(() => parseManagedInvocation(`/work ${'x'.repeat(16 * 1024)}`), /too large/i);

  console.log('[OK] Harness managed invocation tests passed');
}

main();
