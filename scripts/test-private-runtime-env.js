#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  BROKER_SYSTEM_ENV_KEYS,
  PRIVATE_DATABASE_ENV_PATTERN,
  minimalAuthorityBrokerEnvironment,
  withoutPrivateDatabaseCredentials,
} = require('./lib/private-runtime-env');

const sanitized = withoutPrivateDatabaseCredentials({
  PATH: 'kept',
  ACCEPTANCE_POSTGRES_READ_URL: 'secret',
  ACCEPTANCE_POSTGRES_WRITE_URL: 'secret',
  ACCEPTANCE_POSTGRES_URL: 'secret',
  TRANSCRIPTS_POSTGRES_READ_URL: 'secret',
  TRANSCRIPTS_POSTGRES_WRITE_URL: 'secret',
  TRANSCRIPTS_POSTGRES_URL: 'secret',
}, {
  ACCEPTANCE_POSTGRES_WRITE_URL: 'cannot-reintroduce',
  SAFE_VALUE: 'kept',
});

assert.strictEqual(sanitized.PATH, 'kept');
assert.strictEqual(sanitized.SAFE_VALUE, 'kept');
assert.strictEqual(
  Object.keys(sanitized).some((key) => PRIVATE_DATABASE_ENV_PATTERN.test(key)),
  false
);
console.log('[OK] private PostgreSQL URLs are stripped from child-process environments');

const brokerEnv = minimalAuthorityBrokerEnvironment({
  SystemRoot: 'C:\\Windows',
  TEMP: 'C:\\Temp',
  OPENAI_API_KEY: 'must-not-leak',
  GITHUB_TOKEN: 'must-not-leak',
  ACCEPTANCE_POSTGRES_READ_URL: 'must-not-leak',
  PATH: 'must-not-leak',
});
assert.deepStrictEqual(brokerEnv, { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' });
assert(BROKER_SYSTEM_ENV_KEYS.includes('SystemRoot'));
console.log('[OK] authority brokers receive only the bounded system environment allowlist');
