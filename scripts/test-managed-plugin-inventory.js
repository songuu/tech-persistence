#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const inventory = require('./lib/managed-plugin-inventory');
const builder = require('../plugins/tech-persistence/scripts/build-codex-plugin');

function listDirectories(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function main() {
  assert(Object.isFrozen(inventory.COMMAND_NAMES));
  assert(Object.isFrozen(inventory.BASE_SKILL_NAMES));
  assert(Object.isFrozen(inventory.CODEX_SKILL_NAMES));
  assert.deepStrictEqual(
    builder.expectedCommands,
    inventory.COMMAND_FILES,
    'plugin builder must consume the shared command inventory'
  );
  assert.deepStrictEqual(
    builder.expectedSkills,
    inventory.BASE_SKILL_NAMES,
    'plugin builder must consume the shared base skill inventory'
  );
  assert.deepStrictEqual(
    inventory.CODEX_SKILL_NAMES,
    [...new Set([...inventory.BASE_SKILL_NAMES, ...inventory.COMMAND_NAMES])].sort()
  );
  assert.deepStrictEqual(
    inventory.COMMAND_FILES,
    fs.readdirSync(path.join(root, 'user-level', 'commands'))
      .filter((name) => name.endsWith('.md'))
      .sort(),
    'canonical command directory drifted from the managed inventory'
  );
  assert.deepStrictEqual(
    inventory.BASE_SKILL_NAMES,
    listDirectories(path.join(root, 'user-level', 'skills')),
    'canonical skill directory drifted from the managed inventory'
  );
  assert.match(inventory.INVENTORY_SHA256, /^[a-f0-9]{64}$/);

  assert.throws(
    () => inventory.createManagedPluginInventory({ commands: ['work', 'work'], skills: [] }),
    /duplicate command/i
  );
  assert.throws(
    () => inventory.createManagedPluginInventory({ commands: ['work'], skills: ['work'] }),
    /overlap/i
  );
  assert.throws(
    () => inventory.createManagedPluginInventory({ commands: ['../work'], skills: [] }),
    /invalid command/i
  );

  console.log('[OK] managed plugin inventory tests passed');
}

main();
