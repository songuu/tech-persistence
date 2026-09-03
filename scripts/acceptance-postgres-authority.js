#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  appendAcceptanceAuthorityRecord,
  openAcceptancePostgres,
} = require('./lib/acceptance-postgres-authority');
const { readPrivateEnvFile } = require('./lib/acceptance-postgres-env');

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const PUBLIC_APPEND_KINDS = new Set(['acceptance-receipt', 'authority-canary']);

function readBoundedStdin() {
  const content = fs.readFileSync(0);
  if (content.length === 0 || content.length > MAX_INPUT_BYTES) {
    throw new Error('Acceptance PostgreSQL authority input must be between 1 byte and 16 MiB');
  }
  return JSON.parse(content.toString('utf8'));
}

async function appendFromFile(envFile, record, options = {}) {
  if (!record || !PUBLIC_APPEND_KINDS.has(record.recordKind)) {
    throw new Error('Acceptance PostgreSQL public append recordKind is not allowed');
  }
  const resolved = path.resolve(envFile);
  const env = readPrivateEnvFile(resolved);
  const opened = await openAcceptancePostgres({ env, pg: options.pg });
  try {
    return await appendAcceptanceAuthorityRecord(opened.writer, opened.reader, record);
  } finally {
    await Promise.allSettled([opened.reader.end(), opened.writer.end()]);
  }
}

async function main() {
  try {
    const [command, envFile] = process.argv.slice(2);
    if (command !== 'append' || !envFile) {
      throw new Error('Usage: acceptance-postgres-authority.js append <private-env-file>');
    }
    const result = await appendFromFile(envFile, readBoundedStdin());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`[acceptance-postgres] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { PUBLIC_APPEND_KINDS, appendFromFile, readBoundedStdin };

if (require.main === module) main();
