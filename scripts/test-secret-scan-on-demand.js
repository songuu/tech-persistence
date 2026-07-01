#!/usr/bin/env node

/**
 * test-secret-scan-on-demand.js
 *
 * Self-contained tests for the on-demand secret scanner.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scanner = require('./secret-scan-on-demand');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-secret-scan-'));
}

function writeFile(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function run(args, cwd = process.cwd()) {
  let stdout = '';
  let stderr = '';
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (value = '') => { stdout += `${value}\n`; };
  console.error = (value = '') => { stderr += `${value}\n`; };
  try {
    const code = scanner.run(args, cwd);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 2, stdout, stderr: `${stderr}[secret-scan] ${error.message}\n` };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

test('positive: detects API key assignment and redacts value', () => {
  const root = makeDir();
  const secretValue = `supersecret${'A'.repeat(24)}`;
  writeFile(root, 'config.txt', `api_key = "${secretValue}"\n`);

  const result = run(['--paths', root]);
  assert.strictEqual(result.code, 1, `expected findings, stdout=${result.stdout}`);
  assert.ok(result.stdout.includes('[generic_api_key_assignment]'));
  assert.ok(!result.stdout.includes(secretValue), 'full secret leaked in output');
  assert.ok(result.stdout.includes('[REDACTED]'));
});

test('positive: detects OpenAI-style key and redacts value', () => {
  const root = makeDir();
  const secretValue = ['sk', 'proj', `A${'B'.repeat(30)}`].join('-');
  writeFile(root, 'token.txt', `token=${secretValue}\n`);

  const result = run(['--paths', root]);
  assert.strictEqual(result.code, 1, `expected findings, stdout=${result.stdout}`);
  assert.ok(result.stdout.includes('[openai_key]'));
  assert.ok(!result.stdout.includes(secretValue), 'full OpenAI-style key leaked in output');
});

test('positive: detects provider token pattern pack and redacts values', () => {
  const root = makeDir();
  const secrets = {
    gitlab: `glpat-${'A'.repeat(24)}`,
    huggingface: `hf_${'B'.repeat(30)}`,
    npm: `npm_${'C'.repeat(36)}`,
    digitalocean: `dop_v1_${'d'.repeat(64)}`,
    bearer: `Bearer ${'E'.repeat(32)}`,
  };
  writeFile(root, 'tokens.env', [
    `GITLAB_TOKEN=${secrets.gitlab}`,
    `HF_TOKEN=${secrets.huggingface}`,
    `NPM_TOKEN=${secrets.npm}`,
    `DIGITALOCEAN_TOKEN=${secrets.digitalocean}`,
    `Authorization: ${secrets.bearer}`,
  ].join('\n'));

  const result = run(['--paths', root]);
  assert.strictEqual(result.code, 1, `expected findings, stdout=${result.stdout}`);
  for (const pattern of ['gitlab_pat', 'huggingface_token', 'npm_token', 'digitalocean_token', 'bearer_token']) {
    assert.ok(result.stdout.includes(`[${pattern}]`), `missing ${pattern}`);
  }
  for (const value of Object.values(secrets)) {
    assert.ok(!result.stdout.includes(value), `full secret leaked: ${value}`);
  }
});

test('positive: detects gcp service account json and redacts fields', () => {
  const root = makeDir();
  const clientEmail = 'tp-service@prod-project.iam.gserviceaccount.com';
  const privateKeyId = '1234567890abcdef1234567890abcdef12345678';
  const fakePrivateKey = ['-----BEGIN', 'PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END', 'PRIVATE KEY-----\\n'].join(' ');
  writeFile(root, 'service-account.json', JSON.stringify({
    type: 'service_account',
    private_key_id: privateKeyId,
    private_key: fakePrivateKey,
    client_email: clientEmail,
  }));

  const result = run(['--paths', root]);
  assert.strictEqual(result.code, 1, `expected findings, stdout=${result.stdout}`);
  assert.ok(result.stdout.includes('[gcp_service_account_json]'));
  assert.ok(!result.stdout.includes(clientEmail), 'client email leaked');
  assert.ok(!result.stdout.includes(privateKeyId), 'private key id leaked');
  assert.ok(!result.stdout.includes(fakePrivateKey), 'private key leaked');
});

test('negative: placeholder values do not report findings', () => {
  const root = makeDir();
  writeFile(root, 'example.md', 'api_key = "YOUR_API_KEY_PLACEHOLDER"\n');

  const result = run(['--paths', root]);
  assert.strictEqual(result.code, 0, `expected clean, stdout=${result.stdout}`);
  assert.ok(result.stdout.includes('clean'));
});

test('path filtering scans only requested subtree', () => {
  const root = makeDir();
  const secretValue = `anothersecret${'C'.repeat(24)}`;
  writeFile(root, 'scan-me/config.txt', `secret = "${secretValue}"\n`);
  writeFile(root, 'clean/readme.md', 'nothing to see here\n');

  const result = run(['--paths', path.join(root, 'clean')]);
  assert.strictEqual(result.code, 0, `expected clean, stdout=${result.stdout}`);
});

test('json output is valid and omits full secret', () => {
  const root = makeDir();
  const secretValue = `jsonsecret${'D'.repeat(24)}`;
  writeFile(root, 'config.json', `{"password":"${secretValue}"}\n`);

  const result = run(['--json', '--paths', root]);
  assert.strictEqual(result.code, 1, `expected findings, stdout=${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.findings.length, 1);
  assert.ok(!result.stdout.includes(secretValue), 'full secret leaked in json output');
});

test('unknown option exits with usage error', () => {
  const result = run(['--definitely-not-real']);
  assert.strictEqual(result.code, 2);
  assert.ok(result.stderr.includes('unknown option'));
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  failures.forEach(({ name, err }) => {
    console.error(`\n  [${name}]`);
    console.error(`  ${err.stack || err.message}`);
  });
  process.exit(1);
}
