'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTestEnvironment } = require('./run-tests');

test('Windows child environment uses a canonical temporary directory without mutating its parent', () => {
  const parent = { TEMP: 'C:\\Users\\ADMINI~1\\Temp', TMP: 'C:\\Users\\ADMINI~1\\Tmp', KEEP: 'value' };
  const input = { ...parent };
  const requested = [];
  const child = buildTestEnvironment({
    platform: 'win32',
    env: parent,
    tempDirectory: parent.TEMP,
    realpath: (value) => {
      requested.push(value);
      return 'C:\\Users\\Administrator\\Temp';
    },
  });
  assert.deepEqual(requested, [input.TEMP]);
  assert.equal(child.TEMP, 'C:\\Users\\Administrator\\Temp');
  assert.equal(child.TMP, child.TEMP);
  assert.equal(child.KEEP, 'value');
  assert.equal(child.NODE_NO_WARNINGS, '1');
  assert.deepEqual(parent, input);
});

test('non-Windows child environment retains original temporary settings', () => {
  const parent = { TEMP: '/tmp/original', TMP: '/tmp/other', KEEP: 'value' };
  const child = buildTestEnvironment({
    platform: 'linux',
    env: parent,
    realpath: () => { throw new Error('non-Windows should not resolve'); },
  });
  assert.deepEqual(child, { ...parent, NODE_NO_WARNINGS: '1' });
  assert.notEqual(child, parent);
});

test('Windows reports a canonicalization failure instead of passing an unsafe temp path', () => {
  const cause = new Error('unavailable');
  assert.throws(() => buildTestEnvironment({
    platform: 'win32',
    env: { TEMP: 'C:\\Users\\ADMINI~1\\Temp' },
    tempDirectory: 'C:\\Users\\ADMINI~1\\Temp',
    realpath: () => { throw cause; },
  }), (error) => error.code === 'TEST_TEMP_PATH_UNAVAILABLE'
    && error.cause === cause
    && /canonical temporary directory/i.test(error.message));
});

test('Windows does not retain differently cased aliases of TEMP or TMP', () => {
  const parent = { Temp: 'C:\\short', tmp: 'C:\\other', KEEP: 'value' };
  const child = buildTestEnvironment({
    platform: 'win32',
    env: parent,
    tempDirectory: 'C:\\short',
    realpath: () => 'C:\\canonical',
  });
  assert.deepEqual(child, { KEEP: 'value', NODE_NO_WARNINGS: '1', TEMP: 'C:\\canonical', TMP: 'C:\\canonical' });
  assert.equal(parent.Temp, 'C:\\short');
  assert.equal(parent.tmp, 'C:\\other');
});

function runLiveQualification(args) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  // Without credentials the opted-in test must fail before attempting network.
  for (const key of Object.keys(env)) {
    if (/^OPENAI_(BASE_URL|API_KEY|MODEL)$/i.test(key)) delete env[key];
  }
  return spawnSync(process.execPath, [
    path.join(__dirname, 'run-tests.js'),
    '--grep', '^test-openai-responses-broker-live\\.js$', ...args,
  ], { encoding: 'utf8', env, windowsHide: true, timeout: 15000 });
}

test('live qualification stays skipped even when selected by grep', () => {
  const result = runLiveQualification([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[SKIP\].*test-openai-responses-broker-live\.js/);
  assert.match(result.stdout, /0 pass \/ 0 fail \/ 1 skip \/ 1 total/);
  assert.doesNotMatch(result.stderr, /live broker qualification failed/);
});

test('explicit include-live actually executes qualification and preserves failure', () => {
  const result = runLiveQualification(['--include-live']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /live broker qualification failed: approved Agent model configuration is incomplete/);
  assert.match(result.stdout, /0 pass \/ 1 fail \/ 0 skip \/ 1 total/);
  assert.doesNotMatch(result.stdout, /\[SKIP\]/);
});
