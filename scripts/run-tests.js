#!/usr/bin/env node

/**
 * run-tests.js — 单测调度器
 *
 * 扫描 scripts/test-*.js 串行 spawn 跑（隔离子进程，避免 require 缓存污染 + 命名冲突）。
 * 聚合每个 test-*.js 的 exit code，最终 exit = 失败数（CI 友好）。
 *
 * 不引入 npm 依赖（保持 ADR-011 轻量优先）。
 * 与 node:test 命名冲突解决：每个 test-*.js 独立子进程跑。
 *
 * 用法：
 *   node scripts/run-tests.js           # 跑离线 test-*.js（跳过 live 验证）
 *   node scripts/run-tests.js --grep pattern  # 仅跑名字匹配 pattern 的
 *   node scripts/run-tests.js --list    # 列出而不执行
 *   node scripts/run-tests.js --include-live  # 显式运行需要外部服务的 live 验证
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = path.resolve(__dirname);
// This qualification issues real model requests and must not run as a side
// effect of ordinary offline tests, including a matching --grep.
const LIVE_QUALIFICATION_TESTS = new Set(['test-openai-responses-broker-live.js']);

function buildTestEnvironment(options = {}) {
  const env = { ...(options.env || process.env), NODE_NO_WARNINGS: '1' };
  if ((options.platform || process.platform) !== 'win32') return env;

  try {
    // Windows can expose the same directory through a DOS 8.3 alias. Tests
    // exercise canonical-path guards, so give their child processes the real
    // directory without changing the caller's or user's environment.
    const canonical = (options.realpath || fs.realpathSync.native)(
      options.tempDirectory || os.tmpdir()
    );
    if (typeof canonical !== 'string' || !path.win32.isAbsolute(canonical)) {
      throw new Error('resolved temporary directory is not an absolute Windows path');
    }
    // Windows environment names are case-insensitive even when the copied JS
    // object contains differently-cased keys.
    for (const key of Object.keys(env)) {
      if (/^(TEMP|TMP)$/i.test(key)) delete env[key];
    }
    env.TEMP = canonical;
    env.TMP = canonical;
    return env;
  } catch (cause) {
    const error = new Error('Cannot resolve canonical temporary directory for test subprocesses', { cause });
    error.code = 'TEST_TEMP_PATH_UNAVAILABLE';
    throw error;
  }
}

function discoverTestFiles() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((name) => /^test-.+\.js$/.test(name))
    .sort()
    .map((name) => path.join(SCRIPTS_DIR, name));
}

function runOne(file) {
  const rel = path.relative(process.cwd(), file);
  const start = Date.now();
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildTestEnvironment(),
  });
  const ms = Date.now() - start;
  const ok = result.status === 0;
  return {
    file: rel,
    ok,
    code: result.status ?? -1,
    signal: result.signal || null,
    error: result.error ? result.error.message : '',
    ms,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseArgs(argv) {
  const args = { grep: null, list: false, includeLive: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--grep' && i + 1 < argv.length) {
      args.grep = argv[++i];
    } else if (arg === '--list') {
      args.list = true;
    } else if (arg === '--include-live') {
      args.includeLive = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let files = discoverTestFiles();

  if (args.grep) {
    const re = new RegExp(args.grep);
    files = files.filter((f) => re.test(path.basename(f)));
  }

  if (files.length === 0) {
    console.log('[run-tests] no test files found');
    return 0;
  }

  if (args.list) {
    files.forEach((f) => console.log(path.relative(process.cwd(), f)));
    return 0;
  }

  console.log(`[run-tests] discovered ${files.length} test file(s)\n`);

  const results = [];
  let skipped = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    if (!args.includeLive && LIVE_QUALIFICATION_TESTS.has(path.basename(file))) {
      console.log(`[SKIP] ${rel} (live qualification; pass --include-live to run)\n`);
      skipped += 1;
      continue;
    }
    console.log(`──── ${rel} ────`);
    const r = runOne(file);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (!r.ok && r.error) process.stderr.write(`[run-tests] ${rel} spawn error: ${r.error}\n`);
    console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${rel} (${r.ms}ms, code=${r.code})\n`);
    results.push(r);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  console.log('═'.repeat(60));
  console.log(`[run-tests] summary: ${passed} pass / ${failed} fail / ${skipped} skip / ${files.length} total`);
  if (failed > 0) {
    console.log('failed files:');
    results.filter((r) => !r.ok).forEach((r) => {
      const signal = r.signal ? `, signal=${r.signal}` : '';
      const error = r.error ? `, error=${r.error}` : '';
      console.log(`  - ${r.file} (code=${r.code}${signal}${error})`);
    });
  }

  // 防 POSIX exit code mod 256 fail-open（>127 fail 会 wrap 到 0）
  return failed > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { buildTestEnvironment, discoverTestFiles, runOne, parseArgs, main };
