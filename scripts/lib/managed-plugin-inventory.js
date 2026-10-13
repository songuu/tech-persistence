'use strict';

const crypto = require('crypto');

const MANAGED_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeNames(values, kind) {
  if (!Array.isArray(values)) throw new TypeError(`${kind} inventory must be an array`);
  const names = values.map((value) => {
    if (typeof value !== 'string' || !MANAGED_NAME.test(value)) {
      throw new Error(`invalid ${kind} name: ${String(value)}`);
    }
    return value;
  });
  const unique = new Set(names);
  if (unique.size !== names.length) throw new Error(`duplicate ${kind} name in managed inventory`);
  return [...names].sort();
}

function createManagedPluginInventory(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('managed plugin inventory input must be an object');
  }
  const commandNames = normalizeNames(input.commands, 'command');
  const baseSkillNames = normalizeNames(input.skills, 'skill');
  const overlap = commandNames.filter((name) => baseSkillNames.includes(name));
  if (overlap.length > 0) {
    throw new Error(`command and skill inventory overlap: ${overlap.join(', ')}`);
  }
  const commandFiles = commandNames.map((name) => `${name}.md`).sort();
  const codexSkillNames = [...commandNames, ...baseSkillNames].sort();
  const inventorySha256 = crypto.createHash('sha256').update(JSON.stringify({
    commands: commandNames,
    skills: baseSkillNames,
  })).digest('hex');
  return Object.freeze({
    commandNames: Object.freeze(commandNames),
    commandFiles: Object.freeze(commandFiles),
    baseSkillNames: Object.freeze(baseSkillNames),
    codexSkillNames: Object.freeze(codexSkillNames),
    inventorySha256,
  });
}

const managedInventory = createManagedPluginInventory({
  commands: [
    'agent-loop',
    'checkpoint',
    'compound',
    'evolve',
    'instinct-export',
    'instinct-import',
    'instinct-status',
    'learn',
    'plan',
    'prototype',
    'review',
    'review-learnings',
    'self-learning',
    'session-summary',
    'skill',
    'skill-diagnose',
    'skill-eval',
    'skill-improve',
    'skill-publish',
    'sprint',
    'test',
    'think',
    'work',
  ],
  skills: [
    'caveman',
    'caveman-commit',
    'caveman-compress',
    'caveman-help',
    'caveman-review',
    'context-handoff',
    'continuous-learning',
    'memory',
    'prototype-workflow',
    'test-strategy',
  ],
});

module.exports = {
  BASE_SKILL_NAMES: managedInventory.baseSkillNames,
  CODEX_SKILL_NAMES: managedInventory.codexSkillNames,
  COMMAND_FILES: managedInventory.commandFiles,
  COMMAND_NAMES: managedInventory.commandNames,
  INVENTORY_SHA256: managedInventory.inventorySha256,
  createManagedPluginInventory,
};
