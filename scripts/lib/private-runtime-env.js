'use strict';

const PRIVATE_DATABASE_ENV_PATTERN = /^(?:ACCEPTANCE|TRANSCRIPTS)_POSTGRES_(?:URL|READ_URL|WRITE_URL)$/;
const BROKER_SYSTEM_ENV_KEYS = Object.freeze([
  'ComSpec',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'WINDIR',
]);

function withoutPrivateDatabaseCredentials(inherited = process.env, overrides = {}) {
  const combined = { ...inherited, ...overrides };
  for (const key of Object.keys(combined)) {
    if (PRIVATE_DATABASE_ENV_PATTERN.test(key)) delete combined[key];
  }
  return combined;
}

function minimalAuthorityBrokerEnvironment(inherited = process.env) {
  const selected = {};
  for (const key of BROKER_SYSTEM_ENV_KEYS) {
    if (typeof inherited[key] === 'string' && inherited[key] !== '') {
      selected[key] = inherited[key];
    }
  }
  return selected;
}

module.exports = {
  BROKER_SYSTEM_ENV_KEYS,
  PRIVATE_DATABASE_ENV_PATTERN,
  minimalAuthorityBrokerEnvironment,
  withoutPrivateDatabaseCredentials,
};
