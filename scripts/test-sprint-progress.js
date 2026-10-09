#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoCheckpoint, detectActiveSprint } = require('./evaluate-session');
const { detectPendingHandoff } = require('./inject-context');

const completedImplementation = [
  '---', 'status: in-progress', 'tasks_completed: 5', 'tasks_total: 5', '---',
  '## 成功标准', ...Array(5).fill('- [ ] Criterion'),
  '### 任务拆解', ...Array(5).fill('- [x] Task'),
].join('\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sprint-progress-'));
const originalCwd = process.cwd();
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`[OK] ${name}`);
}

try {
  process.chdir(root);
  const plansDir = path.join(root, 'docs', 'plans');
  const handoffDir = path.join(plansDir, '.handoff');
  fs.mkdirSync(handoffDir, { recursive: true });
  const planPath = path.join(plansDir, 'demo.md');
  fs.writeFileSync(planPath, completedImplementation);

  test('checkpoint uses declared task counts rather than acceptance checkboxes, including CRLF', () => {
    for (const content of [completedImplementation, completedImplementation.replace(/\n/g, '\r\n'), `\uFEFF${completedImplementation}`]) {
      const result = autoCheckpoint({ file: 'demo.md', status: 'in-progress', content }, []);
      assert.equal(result.tasksDone, 5);
      assert.equal(result.tasksTotal, 5);
      assert.match(fs.readFileSync(result.file, 'utf8'), /tasks_total: 5\n/);
    }
  });

  test('completed implementation retains pending Sprint phases with canonical progress', () => {
    assert.equal(detectActiveSprint().tasksDone, 5);
    assert.equal(detectActiveSprint().tasksTotal, 5);
  });

  test('quoted canonical integer counts retain compatibility with Sprint completion parsing', () => {
    const content = completedImplementation.replace('tasks_completed: 5', 'tasks_completed: "5"')
      .replace('tasks_total: 5', "tasks_total: '5'");
    const result = autoCheckpoint({ file: 'quoted.md', status: 'in-progress', content }, []);
    assert.equal(result.tasksDone, 5);
    assert.equal(result.tasksTotal, 5);
    fs.unlinkSync(result.file);
  });

  test('legacy handoff shows current plan progress without rewriting its historical snapshot', () => {
    const handoffPath = path.join(handoffDir, 'demo-handoff-99.md');
    const raw = '---\nsprint_doc: "docs/plans/demo.md"\ntasks_done: 5\ntasks_total: 10\n---\n';
    fs.writeFileSync(handoffPath, raw);
    const result = detectPendingHandoff({ repoRoot: root });
    assert.equal(result.progress.tasksDone, 5);
    assert.equal(result.progress.tasksTotal, 5);
    assert.match(result.content, /当前计划实现任务: 5\/5/);
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), raw);
  });

  test('reviewing sprint remains pending even when implementation tasks are complete', () => {
    fs.writeFileSync(planPath, completedImplementation.replace('status: in-progress', 'status: reviewing'));
    assert.ok(detectActiveSprint());
    assert.ok(detectPendingHandoff({ repoRoot: root }));
  });

  test('open tasks and legacy plans remain checkpoint candidates', () => {
    fs.writeFileSync(planPath, completedImplementation.replace('tasks_completed: 5', 'tasks_completed: 4'));
    assert.equal(detectActiveSprint().tasksDone, 4);
    assert.ok(detectPendingHandoff({ repoRoot: root }));
    const result = autoCheckpoint({ file: 'legacy.md', status: 'work', content: '- [x] Done\n- [ ] Todo\n' }, []);
    assert.equal(result.tasksDone, 1);
    assert.equal(result.tasksTotal, 2);
    fs.unlinkSync(result.file);
  });

  test('invalid declared progress is rejected rather than falling back to checkbox counts', () => {
    for (const content of [
      completedImplementation.replace('tasks_total: 5\n', ''),
      completedImplementation.replace('tasks_completed: 5', 'tasks_completed: 05'),
      completedImplementation.replace('tasks_completed: 5', 'tasks_completed: 6'),
      completedImplementation.replace('tasks_total: 5', 'tasks_total: 5\ntasks_total: 10'),
      completedImplementation.replace('tasks_completed: 5', '  tasks_completed: 5'),
      completedImplementation.replace('tasks_total: 5\n---', 'tasks_total: 5'),
    ]) {
      fs.writeFileSync(planPath, content);
      assert.throws(() => autoCheckpoint({ file: 'demo.md', status: 'in-progress', content }, []),
        { code: 'SPRINT_TASK_METADATA_INVALID' });
      assert.equal(detectActiveSprint(), null);
      assert.equal(detectPendingHandoff({ repoRoot: root }), null);
    }
  });

  test('quoted terminal status is read from frontmatter rather than stale handoff prose', () => {
    fs.writeFileSync(planPath, completedImplementation.replace('status: in-progress', 'status: "completed"'));
    assert.equal(detectPendingHandoff({ repoRoot: root }), null);
  });
  console.log(`sprint-progress: ${passed} passed`);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(root, { recursive: true, force: true });
}
