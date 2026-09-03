'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('./sync-codex-transcripts');
const { openTranscriptPostgres } = require('./lib/codex-transcript-postgres');
const { syncRuntimeTranscript } = require('./lib/runtime-transcript-postgres');

function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
(async () => {
  const root = argument('--outbox');
  if (root && (argument('--job') || argument('--file'))) throw new Error('outbox mode cannot be combined with a manual job');
  if (!root && (!argument('--job') || !argument('--file'))) throw new Error('use --outbox or --job with --file');
  if (root) require('./lib/runtime-transcript-worker').discover(path.resolve(root));
  loadEnvFile(argument('--env-file'), process.env);
  const database = await openTranscriptPostgres({ env: process.env });
  try {
    if (root) {
      const result = await require('./lib/runtime-transcript-worker').runWorker({ root, writer: database.writer, reader: database.reader });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.failed) process.exitCode = 1;
      return;
    }
    const jobFile = path.resolve(argument('--job'));
    const sourceFile = path.resolve(argument('--file'));
    const result = await syncRuntimeTranscript({ job: JSON.parse(fs.readFileSync(jobFile, 'utf8')),
      sourceFile, writer: database.writer, reader: database.reader });
    fs.unlinkSync(jobFile);
    process.stdout.write(`${JSON.stringify({ ...result, acknowledged: true })}\n`);
  } finally { await database.close(); }
})().catch((error) => { process.stderr.write(`runtime transcript sync failed: ${error.message}\n`); process.exitCode = 1; });
