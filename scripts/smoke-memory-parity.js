#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { detectProjectIdentity } = require('./lib/memory-v5');

const repoRoot = path.resolve(__dirname, '..');
const project = detectProjectIdentity(repoRoot);

function writeTopic(baseDir, topic, id, summary) {
  const memoryDir = path.join(baseDir, 'projects', project.id, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, `${topic}.md`),
    [
      '---',
      'type: memory-topic',
      'memory_version: "5.0"',
      `topic: "${topic}"`,
      `project: "${project.name}"`,
      'tags: [memory]',
      '---',
      '',
      `# ${topic} Memory`,
      '',
      '## Notes',
      `<!-- memory:v5:${id} -->`,
      `- 2026-05-07 [0.80] [tool_preference] ${summary}`,
      '',
    ].join('\n')
  );
}

function runInject(runtime, tempHome) {
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    TECH_PERSISTENCE_RUNTIME: runtime,
    TECH_PERSISTENCE_CONFIG: path.join(tempHome, '.tech-persistence', 'missing-config.json'),
  };
  delete env.TECH_PERSISTENCE_HOME;
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_SESSION_ID;
  delete env.CODEX_SESSION_ID;

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'inject-context.js')],
    { cwd: repoRoot, env, encoding: 'utf-8' }
  );

  if (result.status !== 0) {
    throw new Error(`${runtime} inject failed: ${result.error?.message || result.stderr || result.stdout || `status ${result.status}`}`);
  }
  if (!result.stdout.trim()) {
    throw new Error(`${runtime} inject produced no context`);
  }

  const payload = JSON.parse(result.stdout);
  return payload.hookSpecificOutput.additionalContext;
}

function assertIncludes(context, runtime, expected) {
  if (!context.includes(expected)) {
    throw new Error(`${runtime} context missing ${expected}`);
  }
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tech-persistence-memory-parity-'));
  const tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(tempHome, { recursive: true });

  try {
    writeTopic(
      path.join(tempHome, '.claude', 'homunculus'),
      'debugging',
      'aaaaaaaaaaaa',
      'Claude default store note visible to both runtimes.'
    );
    writeTopic(
      path.join(tempHome, '.codex', 'homunculus'),
      'toolchain',
      'bbbbbbbbbbbb',
      'Codex default store note visible to both runtimes.'
    );

    const claudeContext = runInject('claude', tempHome);
    const codexContext = runInject('codex', tempHome);

    assertIncludes(claudeContext, 'claude', 'Claude default store note visible to both runtimes.');
    assertIncludes(claudeContext, 'claude', 'Codex default store note visible to both runtimes.');
    assertIncludes(codexContext, 'codex', 'Claude default store note visible to both runtimes.');
    assertIncludes(codexContext, 'codex', 'Codex default store note visible to both runtimes.');

    console.log('[OK] memory parity smoke passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
}
