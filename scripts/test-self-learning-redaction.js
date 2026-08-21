#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const canonical = require('./lib/self-learning-canonical');
const { redactSensitiveText } = require('./lib/redaction');
const store = require('./lib/self-learning-store');

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-self-learning-redaction-'));
try {
  const assignmentCases = [
    ['db_password="x"', 'db_password="[REDACTED]"'],
    ['github_token="x,y\\\"z"', 'github_token="[REDACTED]"'],
    ["service_password='x,y'", "service_password='[REDACTED]'"],
    ['DB_PASSWORD=x', 'DB_PASSWORD=[REDACTED]'],
    ['tenant.service-token=x,y', 'tenant.service-token=[REDACTED]'],
    ['2fa.backup-token=q', '2fa.backup-token=[REDACTED]'],
    ['slackBotToken = "x"', 'slackBotToken = "[REDACTED]"'],
    [
      'payload={\\"github_token\\":\\"x,y\\\\\\"z\\",\\"safe\\":\\"visible\\"}',
      'payload={\\"github_token\\":\\"[REDACTED]\\",\\"safe\\":\\"visible\\"}',
    ],
  ];
  assignmentCases.forEach(([input, expected]) => {
    const redacted = redactSensitiveText(input);
    assert.strictEqual(redacted, expected, input);
    assert.strictEqual(redactSensitiveText(redacted), redacted, `redaction must be idempotent: ${input}`);
  });

  const credentialCases = [
    ['Authorization: Basic tiny-basic', 'Authorization: [REDACTED]'],
    ['Authorization Bearer tiny-bearer', 'Authorization [REDACTED]'],
    ['Authorization: Bearer "top-secret"', 'Authorization: [REDACTED]'],
    ['Authorization: Bearer abc!def', 'Authorization: [REDACTED]'],
    [
      'postgresql://db-user:db-password@db.example.test/app',
      'postgresql://[REDACTED]@db.example.test/app',
    ],
    [
      'http://api-user:api-password@api.example.test/v1',
      'http://[REDACTED]@api.example.test/v1',
    ],
    [
      'https://web-user:web-password@web.example.test/path',
      'https://[REDACTED]@web.example.test/path',
    ],
    [
      'postgresql:\\/\\/db-user:db-password@db.example.test/app',
      'postgresql:\\/\\/[REDACTED]@db.example.test/app',
    ],
  ];
  credentialCases.forEach(([input, expected]) => {
    const redacted = redactSensitiveText(input);
    assert.strictEqual(redacted, expected, input);
    assert.strictEqual(redactSensitiveText(redacted), redacted, `redaction must be idempotent: ${input}`);
  });

  const ordinaryNarrative = [
    'The password policy requires rotation; token count is 42.',
    'password: should be strong, memorable, and unique.',
    'Password: should be strong, memorable, and unique.',
    'Authorization: required for protected routes.',
    'Document database_url behavior without assigning a value.',
    'token_count=42 password_policy=strong secret_sauce=recipe',
    'Bearer tokens are described here without including a credential.',
    'https://example.test/users/alice@example.test remains a normal URL path.',
  ];
  ordinaryNarrative.forEach((text) => assert.strictEqual(redactSensitiveText(text), text));

  const storeDir = store.resolveStoreDir(baseDir, 'project-redaction');
  const token = `glpat-${'A'.repeat(24)}`;
  const githubToken = `ghp_${'B'.repeat(36)}`;
  const slackToken = `xoxb-${'1'.repeat(12)}-${'C'.repeat(24)}`;
  const payload = {
    password: 'short',
    db_password: 'database-password-value',
    github_token: githubToken,
    slack_bot_token: slackToken,
    client_secret: 'client-secret-value',
    session_token: 'session-token-value',
    apiKey: 'camel-api-key-value',
    clientSecret: 'camel-client-secret-value',
    awsSecretAccessKey: 'aws-secret-access-key-value',
    awsAccessKeyId: 'aws-access-key-id-value',
    credentials: 'credential-value',
    database_url: 'postgresql://user:password@example.invalid/db',
    nested: {
      note: `before <private>do-not-persist</private> after ${token} ${githubToken} ${slackToken} dbPassword=database-free-text githubToken=github-free-text slackBotToken=slack-free-text awsSecretAccessKey=aws-free-text db_password="snake-db-secret" service-password=shell,comma-secret tenant.github_token="dot-json-secret" {"clientSecret":"json-free-text"} escaped={\\"clientSecret\\":\\"escaped-json-secret\\",\\"safe\\":\\"visible\\"}`,
      array: [{ api_key: 'tiny' }],
    },
  };
  const snapshot = JSON.parse(JSON.stringify(payload));
  const result = store.appendRecord(storeDir, {
    record_type: 'behavior_event',
    record_id: 'redaction-1',
    entity_id: 'redaction-1',
    actor: { kind: 'hook', id: 'claude-observe', runtime: 'claude', authority_ref: null },
    occurred_at: '2026-08-20T01:02:03.000Z',
    payload,
  });

  assert.deepStrictEqual(payload, snapshot, 'redaction must not mutate caller payload');
  const serialized = fs.readFileSync(result.file, 'utf8');
  assert(!serialized.includes('short'));
  assert(!serialized.includes('database-password-value'));
  assert(!serialized.includes(githubToken));
  assert(!serialized.includes('xoxb-'));
  assert(!serialized.includes('tiny'));
  assert(!serialized.includes('client-secret-value'));
  assert(!serialized.includes('session-token-value'));
  assert(!serialized.includes('camel-api-key-value'));
  assert(!serialized.includes('camel-client-secret-value'));
  assert(!serialized.includes('aws-secret-access-key-value'));
  assert(!serialized.includes('aws-access-key-id-value'));
  assert(!serialized.includes('credential-value'));
  assert(!serialized.includes('postgresql://user:password'));
  assert(!serialized.includes('do-not-persist'));
  assert(!serialized.includes(token));
  assert(!serialized.includes('database-free-text'));
  assert(!serialized.includes('github-free-text'));
  assert(!serialized.includes('slack-free-text'));
  assert(!serialized.includes('aws-free-text'));
  assert(!serialized.includes('snake-db-secret'));
  assert(!serialized.includes('shell,comma-secret'));
  assert(!serialized.includes('dot-json-secret'));
  assert(!serialized.includes('json-free-text'));
  assert(!serialized.includes('escaped-json-secret'));
  assert(serialized.includes('[REDACTED]'));
  assert.strictEqual(result.record.payload_hash, canonical.hashObject(result.record.payload));

  const sensitiveActors = [
    { kind: 'user', id: `AKIA${'A'.repeat(16)}`, runtime: 'codex', authority_ref: null },
    { kind: 'user', id: 'user-local', runtime: `Bearer ${'B'.repeat(24)}`, authority_ref: null },
    { kind: 'user', id: 'user-local', runtime: 'codex', authority_ref: 'password=supersecretvalue' },
    { kind: 'user', id: 'user-local', runtime: 'codex', authority_ref: 'githubToken=github-secret-value' },
  ];
  sensitiveActors.forEach((actor, index) => {
    assert.throws(() => store.appendRecord(storeDir, {
      record_type: 'behavior_event',
      record_id: `sensitive-actor-${index}`,
      entity_id: `sensitive-actor-${index}`,
      actor,
      occurred_at: '2026-08-20T01:02:04.000Z',
      payload: { safe: true },
    }), /sensitive|secret|redact/i);
  });
  assert.strictEqual(store.readJournal(storeDir).revision, 1);

  const prototypeKey = JSON.parse('{"__proto__":{"polluted":true},"safe":true}');
  const normalizedPrototypeKey = canonical.canonicalize(prototypeKey);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(normalizedPrototypeKey, '__proto__'), true);
  assert.strictEqual({}.polluted, undefined);
  assert.notStrictEqual(canonical.hashObject(prototypeKey), canonical.hashObject({ safe: true }));

  assert.throws(() => store.resolveStoreDir(baseDir, '../escape'), /path segment|identifier/i);
  assert.throws(() => store.resolveStoreDir(baseDir, 'project.'), /path segment/i);
  assert.throws(() => store.resolveStoreDir(baseDir, 'CON'), /path segment/i);
  assert.throws(() => canonical.validateIdentifier('bad/control\n'), /identifier/i);

  const cyclicPayload = {};
  cyclicPayload.self = cyclicPayload;
  assert.throws(
    () => store.appendRecord(store.resolveStoreDir(baseDir, 'project-cycle'), {
      record_type: 'behavior_event',
      record_id: 'cycle-1',
      entity_id: 'cycle-1',
      actor: { kind: 'user', id: 'user-local', runtime: null, authority_ref: null },
      occurred_at: '2026-08-20T01:02:03.000Z',
      payload: cyclicPayload,
    }),
    /circular/i
  );

  const outside = path.join(baseDir, 'outside');
  const linked = path.join(baseDir, 'linked-store');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, linked, 'junction');
  assert.throws(
    () => store.appendRecord(linked, {
      record_type: 'behavior_event',
      record_id: 'linked-1',
      entity_id: 'linked-1',
      actor: { kind: 'user', id: 'user-local', runtime: null, authority_ref: null },
      occurred_at: '2026-08-20T01:02:03.000Z',
      payload: { safe: true },
    }),
    /symbolic link|junction|reparse/i
  );
  fs.rmSync(outside, { recursive: true, force: true });
  assert.throws(
    () => store.readJournal(linked),
    /symbolic link|junction|reparse/i,
    'a dangling junction must not be treated as an absent store'
  );
} finally {
  fs.rmSync(baseDir, { recursive: true, force: true });
}

console.log('self-learning redaction tests passed');
