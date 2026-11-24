'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pythonNames = [
  '__init__.py', '__main__.py', 'benchmark.py', 'cli.py',
  'compress.py', 'detect.py', 'validate.py',
];
const skillRoots = ['user-level/skills', 'plugins/tech-persistence/skills'];
const pythonFiles = skillRoots.flatMap((skillRoot) => pythonNames.map(
  (name) => `${skillRoot}/caveman-compress/scripts/${name}`
));
const codexPythonFiles = pythonNames.map(
  (name) => `plugins/tech-persistence/codex-skills/caveman-compress/scripts/${name}`
);
const markdownFiles = skillRoots.flatMap((skillRoot) => [
  `${skillRoot}/prototype-workflow/SKILL.md`,
  `${skillRoot}/test-strategy/SKILL.md`,
]);

function assertCheckoutAttributes(files, eol) {
  const result = spawnSync('git', ['check-attr', '-z', 'text', 'eol', '--', ...files], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const fields = result.stdout.split('\0');
  for (let index = 0; index < files.length * 6; index += 6) {
    assert.equal(fields[index], files[index / 6]);
    assert.equal(fields[index + 1], 'text');
    assert.equal(fields[index + 2], 'set');
    assert.equal(fields[index + 3], files[index / 6]);
    assert.equal(fields[index + 4], 'eol');
    assert.equal(fields[index + 5], eol);
  }
}

test('frozen Python assets have explicit LF checkout attributes', () => {
  assertCheckoutAttributes([...pythonFiles, ...codexPythonFiles], 'lf');
});

test('frozen Markdown and command assets retain their checkout attributes', () => {
  assertCheckoutAttributes(markdownFiles, 'lf');
  assertCheckoutAttributes(['plugins/tech-persistence/hooks/run-hook.cmd'], 'crlf');
});

test('frozen text assets respect their byte-level checkout line endings', () => {
  for (const file of [...pythonFiles, ...codexPythonFiles, ...markdownFiles]) {
    const bytes = fs.readFileSync(path.join(root, file));
    assert(!bytes.includes(Buffer.from('\r\n')), `${file} contains CRLF`);
  }
  const cmd = fs.readFileSync(path.join(root, 'plugins/tech-persistence/hooks/run-hook.cmd'), 'utf8');
  assert(cmd.includes('\r\n'));
  assert(!/(^|[^\r])\n/.test(cmd), 'run-hook.cmd contains a non-CRLF newline');
});
