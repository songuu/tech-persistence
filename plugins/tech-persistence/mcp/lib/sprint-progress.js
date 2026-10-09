'use strict';

const { parseFrontmatter } = require('./memory-v5');

function invalidProgress() {
  const error = new Error('Sprint task metadata must declare one canonical tasks_completed/tasks_total pair with completed <= total');
  error.code = 'SPRINT_TASK_METADATA_INVALID';
  return error;
}

function readSprintProgress(content) {
  const normalized = String(content).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (normalized.startsWith('---\n') && !frontmatterMatch) throw invalidProgress();
  const { meta } = parseFrontmatter(normalized);
  const frontmatter = frontmatterMatch?.[1] || '';
  const taskLines = frontmatter.split('\n').filter((line) => /^\s*tasks_(?:completed|total)\s*:/.test(line));
  const declaredCounts = taskLines.length > 0;
  let tasksDone;
  let tasksTotal;
  if (declaredCounts) {
    // Acceptance checkboxes are a separate contract, not implementation tasks.
    if (taskLines.length !== 2
        || !taskLines.every((line) => /^tasks_(?:completed|total)\s*:\s*(?:"(?:0|[1-9]\d*)"|'(?:0|[1-9]\d*)'|(?:0|[1-9]\d*))\s*$/.test(line))
        || !/^(?:0|[1-9]\d*)$/.test(meta.tasks_completed || '')
        || !/^(?:0|[1-9]\d*)$/.test(meta.tasks_total || '')) {
      throw invalidProgress();
    }
    tasksDone = Number(meta.tasks_completed);
    tasksTotal = Number(meta.tasks_total);
    if (!Number.isSafeInteger(tasksDone) || !Number.isSafeInteger(tasksTotal) || tasksDone > tasksTotal) {
      throw invalidProgress();
    }
  } else {
    tasksDone = (normalized.match(/^- \[x\]/gim) || []).length;
    tasksTotal = (normalized.match(/^- \[[ x]\]/gim) || []).length;
  }
  return {
    status: String(meta.status || '').trim().toLowerCase(),
    tasksDone,
    tasksTotal,
    declaredCounts,
  };
}

module.exports = { readSprintProgress };
