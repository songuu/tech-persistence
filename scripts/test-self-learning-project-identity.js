#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeGitRemote,
  projectIdentityFromRemote,
  detectStableProjectIdentity,
} = require('./lib/project-identity');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
  }
}

test('SSH and HTTPS clones normalize to the same repository locator', () => {
  const ssh = normalizeGitRemote('git@github.com:OpenAI/example.git');
  const https = normalizeGitRemote('https://github.com/OpenAI/example.git');
  assert.strictEqual(ssh, 'github.com/OpenAI/example');
  assert.strictEqual(https, ssh);
  assert.strictEqual(projectIdentityFromRemote('ssh://git@github.com/OpenAI/example.git').id,
    projectIdentityFromRemote('https://github.com/OpenAI/example.git').id);
});

test('explicit default ports stay equivalent across SSH and HTTPS clones', () => {
  const scp = normalizeGitRemote('git@github.com:OpenAI/example.git');
  const ssh = normalizeGitRemote('ssh://git@github.com:22/OpenAI/example.git');
  const https = normalizeGitRemote('https://github.com:443/OpenAI/example.git');
  assert.strictEqual(ssh, scp);
  assert.strictEqual(https, scp);
  assert.strictEqual(
    projectIdentityFromRemote('ssh://git@github.com:22/OpenAI/example.git').id,
    projectIdentityFromRemote('https://github.com:443/OpenAI/example.git').id
  );
});

test('non-default remote ports are preserved and isolate project identities', () => {
  const standard = normalizeGitRemote('https://github.com/OpenAI/example.git');
  const alternateHttps = normalizeGitRemote('https://github.com:8443/OpenAI/example.git');
  const alternateSsh = normalizeGitRemote('ssh://git@github.com:2222/OpenAI/example.git');
  assert.strictEqual(alternateHttps, 'github.com:8443/OpenAI/example');
  assert.strictEqual(alternateSsh, 'github.com:2222/OpenAI/example');
  assert.notStrictEqual(
    projectIdentityFromRemote('https://github.com/OpenAI/example.git').id,
    projectIdentityFromRemote('https://github.com:8443/OpenAI/example.git').id
  );
  assert.notStrictEqual(
    projectIdentityFromRemote('https://github.com:8443/OpenAI/example.git').id,
    projectIdentityFromRemote('ssh://git@github.com:2222/OpenAI/example.git').id
  );
});

test('credentials and query fragments never survive normalization', () => {
  const normalized = normalizeGitRemote('https://token:secret@github.com/org/repo.git?access_token=secret#x');
  assert.strictEqual(normalized, 'github.com/org/repo');
  const identity = projectIdentityFromRemote('https://token:secret@github.com/org/repo.git');
  assert.ok(!JSON.stringify(identity).includes('token'));
  assert.ok(!JSON.stringify(identity).includes('secret'));
  assert.ok(/^project-[a-f0-9]{24}$/.test(identity.id));
});

test('detected identity persists hashes, not raw remote or cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-project-identity-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), [
    '[remote "origin"]',
    '\turl = git@github.com:org/private-repo.git',
    '',
  ].join('\n'));
  const identity = detectStableProjectIdentity(root);
  assert.strictEqual(identity.source, 'git-remote-normalized');
  assert.strictEqual(identity.name, 'private-repo');
  assert.ok(identity.locator_hash.startsWith('sha256:'));
  assert.ok(!Object.prototype.hasOwnProperty.call(identity, 'locator'));
  assert.ok(!JSON.stringify(identity).includes(root));
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
