#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  normalizeAuthorityRecord,
} = require('./lib/acceptance-postgres-authority');
const { appendPostgresAuthorityRecordSync } = require('./lib/acceptance-postgres-authority-client');
const { stableHash } = require('./lib/self-learning-canonical');
const { parsePrivateEnv, readPrivateEnvFile } = require('./lib/acceptance-postgres-env');

async function runCanary(options = {}) {
  const envFile = path.resolve(
    options.envFile || path.join(__dirname, '..', 'deploy', 'postgres', '.env.transcripts')
  );
  readPrivateEnvFile(envFile);
  const canaryId = options.canaryId || new Date().toISOString();
  const authorityScope = stableHash({ kind: 'acceptance-postgres-canary', version: 1 });
  const contractHash = stableHash({ canaryId, authorityScope, phase: 'contract' });
  const subjectHash = stableHash({ canaryId, authorityScope, phase: 'subject' });
  return appendPostgresAuthorityRecordSync(normalizeAuthorityRecord({
      authorityScope,
      recordKind: 'authority-canary',
      recordKey: stableHash({ canaryId, authorityScope }),
      contractHash,
      subjectHash,
      payload: {
        schemaVersion: 'acceptance-postgres-canary-v1',
        canaryId,
        contractHash,
        subjectHash,
      },
    }), { postgresEnvFile: envFile, spawnSyncImpl: options.spawnSyncImpl });
}

async function main() {
  try {
    const result = await runCanary({ envFile: process.argv[2] });
    console.log(`[acceptance-postgres] canary verified record=${result.recordHash}`);
  } catch (error) {
    console.error(`[acceptance-postgres] canary failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parsePrivateEnv, runCanary };

if (require.main === module) main();
