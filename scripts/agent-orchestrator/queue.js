'use strict';

const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function queuePath(runDir) {
  return path.join(runDir, 'queue.json');
}

function emptyQueue() {
  return {
    pending: [],
    ready: [],
    running: [],
    completed: [],
    blocked: [],
    abandoned: [],
    rejected: [],
    updatedAt: nowIso(),
  };
}

function loadQueue(runDir) {
  const file = queuePath(runDir);
  if (!fs.existsSync(file)) return emptyQueue();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    ready: Array.isArray(parsed.ready) ? parsed.ready : [],
    running: Array.isArray(parsed.running) ? parsed.running : [],
    completed: Array.isArray(parsed.completed) ? parsed.completed : [],
    blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
    abandoned: Array.isArray(parsed.abandoned) ? parsed.abandoned : [],
    rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
    updatedAt: parsed.updatedAt || nowIso(),
  };
}

function saveQueue(runDir, queue) {
  const next = { ...queue, updatedAt: nowIso() };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(queuePath(runDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function removeFromAll(queue, sliceId) {
  return {
    ...queue,
    pending: queue.pending.filter((id) => id !== sliceId),
    ready: queue.ready.filter((id) => id !== sliceId),
    running: queue.running.filter((id) => id !== sliceId),
    completed: queue.completed.filter((id) => id !== sliceId),
    blocked: queue.blocked.filter((entry) => entry.sliceId !== sliceId),
    abandoned: queue.abandoned.filter((id) => id !== sliceId),
    rejected: queue.rejected.filter((id) => id !== sliceId),
  };
}

function moveToPending(queue, sliceId) {
  if (!sliceId) throw new Error('moveToPending: sliceId required');
  const without = removeFromAll(queue, sliceId);
  if (without.pending.includes(sliceId)) return without;
  return { ...without, pending: [...without.pending, sliceId] };
}

function moveToReady(queue, sliceId) {
  const without = removeFromAll(queue, sliceId);
  if (without.ready.includes(sliceId)) return without;
  return { ...without, ready: [...without.ready, sliceId] };
}

function moveToRunning(queue, sliceId) {
  const without = removeFromAll(queue, sliceId);
  if (without.running.includes(sliceId)) return without;
  return { ...without, running: [...without.running, sliceId] };
}

function moveToCompleted(queue, sliceId) {
  const without = removeFromAll(queue, sliceId);
  if (without.completed.includes(sliceId)) return without;
  return { ...without, completed: [...without.completed, sliceId] };
}

function moveToBlocked(queue, sliceId, reason) {
  if (!reason) throw new Error('moveToBlocked: reason required');
  const without = removeFromAll(queue, sliceId);
  return {
    ...without,
    blocked: [...without.blocked, { sliceId, reason, blockedAt: nowIso() }],
  };
}

function moveToAbandoned(queue, sliceId) {
  const without = removeFromAll(queue, sliceId);
  if (without.abandoned.includes(sliceId)) return without;
  return { ...without, abandoned: [...without.abandoned, sliceId] };
}

function moveToRejected(queue, sliceId) {
  const without = removeFromAll(queue, sliceId);
  if (without.rejected.includes(sliceId)) return without;
  return { ...without, rejected: [...without.rejected, sliceId] };
}

function hasActiveWork(queue) {
  return queue.ready.length > 0 || queue.running.length > 0 || queue.pending.length > 0;
}

function hasIntegrationReady(queue) {
  if (queue.running.length > 0) return false;
  if (queue.ready.length > 0) return false;
  if (queue.pending.length > 0) return false;
  return queue.completed.length > 0;
}

module.exports = {
  emptyQueue,
  loadQueue,
  saveQueue,
  moveToPending,
  moveToReady,
  moveToRunning,
  moveToCompleted,
  moveToBlocked,
  moveToAbandoned,
  moveToRejected,
  hasActiveWork,
  hasIntegrationReady,
};
