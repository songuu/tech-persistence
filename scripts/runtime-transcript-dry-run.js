'use strict';
const { sourceAdapter } = require('./lib/transcript-source-adapters');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

(async () => {
  const adapter = sourceAdapter(argument('--adapter'));
  if (adapter.descriptor.batchDryRunOnly !== true) throw new Error('dry-run CLI only accepts batch-dry-run adapters');
  const snapshot = await adapter.stream(argument('--file'), { startLine: Number(argument('--start-line') || 1) });
  process.stdout.write(`${JSON.stringify({ descriptor: snapshot.descriptor, observedSize: snapshot.observedSize,
    eventCount: snapshot.eventCount, emittedEventCount: snapshot.emittedEventCount,
    nextLineNo: snapshot.nextLineNo, fileIdentityHash: snapshot.fileIdentityHash,
    eventChainSha256: snapshot.eventChainSha256, projectionChainSha256: snapshot.projectionChainSha256 })}\n`);
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
