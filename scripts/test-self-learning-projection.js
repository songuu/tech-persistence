#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const builder = require(path.join(
  root,
  'plugins',
  'tech-persistence',
  'scripts',
  'build-codex-plugin.js'
));

const requiredRuntimeLibs = [
  'behavior-episodes.js',
  'behavior-events.js',
  'learning-candidates.js',
  'project-identity.js',
  'self-learning-canonical.js',
  'self-learning-service.js',
  'self-learning-store.js',
  'skill-eval-results.js',
];

function listRelativeFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) return listRelativeFiles(absolute, relative);
      return entry.isFile() ? [relative] : [];
    });
}

function assertFileParity(source, target, label) {
  assert(fs.existsSync(target), `${label}: projection missing`);
  assert.deepStrictEqual(fs.readFileSync(target), fs.readFileSync(source), `${label}: byte drift`);
}

function assertCanonicalTextParity(source, target, label) {
  assert(fs.existsSync(target), `${label}: projection missing`);
  const expected = Buffer.from(builder.normalizeLf(fs.readFileSync(source, 'utf8')));
  assert.deepStrictEqual(fs.readFileSync(target), expected, `${label}: canonical byte drift`);
}

function assertDirectoryParity(source, target, label, assertParity = assertFileParity) {
  const sourceFiles = listRelativeFiles(source);
  assert.deepStrictEqual(listRelativeFiles(target), sourceFiles, `${label}: inventory drift`);
  for (const relative of sourceFiles) {
    assertParity(path.join(source, relative), path.join(target, relative), `${label}/${relative}`);
  }
}

function seedStaleManagedFiles(temporaryPluginRoot) {
  const staleSchema = path.join(
    temporaryPluginRoot,
    'schemas',
    'self-learning',
    'stale.schema.json'
  );
  const staleLib = path.join(temporaryPluginRoot, 'scripts', 'lib', 'stale-learning-runtime.js');
  fs.mkdirSync(path.dirname(staleSchema), { recursive: true });
  fs.mkdirSync(path.dirname(staleLib), { recursive: true });
  fs.writeFileSync(staleSchema, '{}\n');
  fs.writeFileSync(staleLib, 'module.exports = {};\n');
  return { staleSchema, staleLib };
}

function main() {
  assert(builder.expectedCommands.includes('self-learning.md'), 'self-learning command is not projected');
  assert(builder.utilityScripts.includes('self-learning.js'), 'self-learning CLI is not an atomic utility');
  assert.strictEqual(typeof builder.copyUtilityScripts, 'function');
  assert.strictEqual(typeof builder.copySchemas, 'function');

  const temporaryPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-projection-'));
  try {
    const stale = seedStaleManagedFiles(temporaryPluginRoot);
    builder.copyUtilityScripts(temporaryPluginRoot);
    builder.copySchemas(temporaryPluginRoot);

    assert.strictEqual(fs.existsSync(stale.staleSchema), false, 'stale schema survived projection');
    assert.strictEqual(fs.existsSync(stale.staleLib), false, 'stale runtime lib survived projection');
    assertCanonicalTextParity(
      path.join(root, 'scripts', 'self-learning.js'),
      path.join(temporaryPluginRoot, 'scripts', 'self-learning.js'),
      'self-learning CLI'
    );
    assertDirectoryParity(
      path.join(root, 'scripts', 'lib'),
      path.join(temporaryPluginRoot, 'scripts', 'lib'),
      'utility runtime libs',
      assertCanonicalTextParity
    );
    for (const name of requiredRuntimeLibs) {
      assert(
        fs.existsSync(path.join(temporaryPluginRoot, 'scripts', 'lib', name)),
        `required self-learning runtime is missing: ${name}`
      );
    }
    assertDirectoryParity(
      path.join(root, 'schemas'),
      path.join(temporaryPluginRoot, 'schemas'),
      'schemas'
    );

    const projectedCliPath = path.join(temporaryPluginRoot, 'scripts', 'self-learning.js');
    delete require.cache[require.resolve(projectedCliPath)];
    const projectedCli = require(projectedCliPath);
    assert.strictEqual(typeof projectedCli.run, 'function', 'projected CLI dependency closure is not loadable');

    const businessCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-business-cwd-'));
    const projectedMemoryToolsPath = path.join(
      temporaryPluginRoot,
      'scripts',
      'lib',
      'memory-tools.js'
    );
    const originalCwd = process.cwd();
    const originalHome = process.env.TECH_PERSISTENCE_HOME;
    try {
      process.env.TECH_PERSISTENCE_HOME = path.join(businessCwd, 'homunculus');
      process.chdir(businessCwd);
      delete require.cache[require.resolve(projectedMemoryToolsPath)];
      const projectedMemoryTools = require(projectedMemoryToolsPath);
      const result = projectedMemoryTools.callTool('tp_learning_govern', {
        operation: 'publish-guard',
        input: { name: 'sprint' },
      });
      assert.strictEqual(result.isError, true, 'missing authority must fail closed');
      assert.match(
        result.content[0].text,
        /no-baseline|blocked/i,
        'projected MCP publish guard did not execute from a non-repository cwd'
      );
      assert.doesNotMatch(result.content[0].text, /MODULE_NOT_FOUND/);
    } finally {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.TECH_PERSISTENCE_HOME;
      else process.env.TECH_PERSISTENCE_HOME = originalHome;
      fs.rmSync(businessCwd, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(temporaryPluginRoot, { recursive: true, force: true });
  }

  console.log('[OK] self-learning projection tests passed');
}

main();
