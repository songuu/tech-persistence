'use strict';

const path = require('path');
const childProcess = require('child_process');
const { createBehaviorEvent } = require('./behavior-events');
const { loadSelfLearningPolicy } = require('./self-learning-service');
const { getOrAppendPromptReceipts, resolveStoreDir } = require('./self-learning-store');
const { drainPromptReceipts } = require('./prompt-receipt-outbox');

function startPromptReceiptWorker(baseDir, projectId) {
  try {
    const child = childProcess.spawn(process.execPath, [__filename, baseDir, projectId], {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      cwd: __dirname,
    });
    child.once('error', () => {});
    if (!child.pid) return { status: 'failed' };
    child.unref();
    return { status: 'started' };
  } catch {
    return { status: 'failed' };
  }
}

function drainProjectPromptReceipts(baseDir, projectId) {
  if (!path.isAbsolute(baseDir)) throw new Error('prompt worker base directory must be absolute');
  const policy = loadSelfLearningPolicy(baseDir);
  if (!policy.enabled || !policy.writer_enabled || policy.mode === 'off') return { status: 'disabled' };
  const storeDir = resolveStoreDir(baseDir, projectId);
  const outboxDir = path.join(storeDir, 'prompt-outbox');
  const result = drainPromptReceipts(outboxDir, (jobs) => {
    if (jobs.some(({ receipt_spec: spec }) => spec.project_id !== projectId)) {
      throw new Error('prompt outbox project does not match worker project');
    }
    const items = jobs.map(({ receipt_spec: spec, event_draft: draft }) => ({
      spec,
      buildRecordInput: ({ source_event_id: sourceEventId, occurred_at: occurredAt, receipt }) => {
        const event = createBehaviorEvent({
          ...draft,
          source_event_id: sourceEventId,
          occurred_at: occurredAt,
          details: { ...draft.details, prompt_receipt: receipt },
        });
        return {
          record_type: 'behavior_event',
          record_id: event.event_id,
          entity_id: event.event_id,
          actor: { kind: 'user', id: event.actor.id, runtime: 'claude', authority_ref: sourceEventId },
          occurred_at: occurredAt,
          payload: event,
        };
      },
    }));
    try {
      getOrAppendPromptReceipts(storeDir, items);
      return items.map(() => 'committed');
    } catch (error) {
      if (!error || error.code !== 'SELF_LEARNING_ID_CONFLICT') throw error;
    }
    // A conflicting replay must not block unrelated streams. Retry each item
    // against the complete journal; only a successful readback is committed.
    // Subsequent items in the same stream stay pending until the conflict is
    // resolved, preserving receipt order. The outbox persists that block.
    const blocked = new Set();
    return items.map((item) => {
      const { project_id, session_id, transcript_ref } = item.spec;
      const stream = JSON.stringify([project_id, session_id, transcript_ref]);
      if (blocked.has(stream)) return 'deferred';
      try {
        getOrAppendPromptReceipts(storeDir, [item]);
        return 'committed';
      } catch (error) {
        if (!error || error.code !== 'SELF_LEARNING_ID_CONFLICT') throw error;
        blocked.add(stream);
        return 'conflict';
      }
    });
  });
  return result;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('invalid worker arguments');
    // The active consumer releases its lock while holding the enqueue lock
    // after the empty check, so a busy worker can exit without losing a wakeup.
    drainProjectPromptReceipts(process.argv[2], process.argv[3]);
  } catch {
    // Jobs remain durable and are retried by a later hook or session start.
    process.exitCode = 1;
  }
}

module.exports = { drainProjectPromptReceipts, startPromptReceiptWorker };
