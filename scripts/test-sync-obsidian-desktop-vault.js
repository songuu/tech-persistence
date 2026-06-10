#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncObsidianDesktopVault } = require('./sync-obsidian-desktop-vault');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-desktop-sync-repo-'));
  fs.mkdirSync(path.join(repo, 'docs', 'solutions'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  return repo;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeSolution(repo, name, body = '# Solution\n') {
  writeFile(
    path.join(repo, 'docs', 'solutions', name),
    ['---', 'title: "Demo"', 'date: 2026-06-10', 'tags: [solution, demo]', '---', '', body.trim(), ''].join('\n')
  );
}

test('syncObsidianDesktopVault mirrors markdown knowledge into desktop vault mirror root and cleans stale files', () => {
  const repo = makeRepo();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-desktop-sync-shared-'));
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-desktop-sync-desktop-'));

  writeFile(path.join(shared, 'projects.json'), JSON.stringify({
    proj123: {
      name: 'tech-persistence',
      source: 'git-remote',
      path: repo,
    },
  }, null, 2));
  writeFile(path.join(shared, 'projects', 'proj123', 'memory', 'MEMORY.md'), '# Memory\n');
  writeFile(path.join(shared, 'projects', 'proj123', 'memory', 'general.md'), '# General\n');
  writeFile(path.join(shared, 'projects', 'proj123', 'sessions', '2026-06-10-a.md'), '# Session\n');
  writeFile(path.join(shared, 'projects', 'proj123', 'instincts', 'alpha.md'), '# Instinct\n');
  writeFile(path.join(shared, 'instincts', 'personal', 'global.md'), '# Global\n');
  writeSolution(repo, '2026-06-10-demo.md', '# Demo solution\n');

  writeFile(path.join(desktop, '_shared_homunculus', 'projects', 'proj123', 'sessions', 'stale.md'), '# stale\n');

  const result = syncObsidianDesktopVault(repo, {
    sharedVault: shared,
    desktopVault: desktop,
  });

  assert.strictEqual(result.project.id, 'proj123');
  assert.ok(fs.existsSync(path.join(desktop, '_shared_homunculus', 'projects', 'proj123', 'memory', 'MEMORY.md')));
  assert.ok(fs.existsSync(path.join(desktop, '_shared_homunculus', 'projects', 'proj123', 'sessions', '2026-06-10-a.md')));
  assert.ok(fs.existsSync(path.join(desktop, '_shared_homunculus', 'projects', 'proj123', 'instincts', 'alpha.md')));
  assert.ok(fs.existsSync(path.join(desktop, '_shared_homunculus', 'instincts', 'personal', 'global.md')));
  assert.ok(fs.existsSync(path.join(desktop, '_shared_homunculus', 'projects', 'proj123', 'solutions', '2026-06-10-demo.md')));
  assert.ok(!fs.existsSync(path.join(desktop, '_shared_homunculus', 'projects', 'proj123', 'sessions', 'stale.md')));
  assert.ok(fs.readFileSync(path.join(desktop, '.gitignore'), 'utf-8').includes('_shared_homunculus/'));

  const second = syncObsidianDesktopVault(repo, {
    sharedVault: shared,
    desktopVault: desktop,
  });
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.solutionProjection.changed, false);

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
  fs.rmSync(desktop, { recursive: true, force: true });
});

test('syncObsidianDesktopVault no-ops when desktop vault already is shared vault', () => {
  const repo = makeRepo();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-desktop-sync-shared-noop-'));
  writeFile(path.join(shared, 'projects.json'), JSON.stringify({
    proj123: {
      name: 'tech-persistence',
      source: 'git-remote',
      path: repo,
    },
  }, null, 2));

  const result = syncObsidianDesktopVault(repo, {
    sharedVault: shared,
    desktopVault: shared,
  });

  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.noopReason, 'desktop-vault-is-shared-vault');

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, error }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${error.stack || error.message}`);
  });
  process.exit(1);
}
