'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sourceAdapter } = require('./lib/transcript-source-adapters');
const { createJob } = require('./lib/runtime-transcript-outbox');

function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
try {
  const adapter = sourceAdapter(argument('--adapter'));
  const sourceFile = path.resolve(argument('--file'));
  const inspected = adapter.inspect(sourceFile);
  const job = createJob({ runtime: adapter.descriptor.runtime, adapterId: adapter.descriptor.id,
    sessionId: argument('--session'), sourcePathHash: inspected.pathHash,
    fileIdentityHash: inspected.fileIdentityHash, observedSize: inspected.observedSize,
    positionKind: adapter.descriptor.positionKind });
  const outbox = path.resolve(argument('--outbox'));
  fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const output = path.join(outbox, `${job.jobHash.replace(':', '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify(job, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, jobHash: job.jobHash })}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
