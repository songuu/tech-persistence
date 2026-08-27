#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONFIGURED_FIELDS,
  DEFAULT_RECONCILE_SECONDS,
  DEFAULT_WATCH_SECONDS,
  MAX_CONFIG_BYTES,
  atomicWriteJson,
  configureCodexTranscriptSync,
  main,
  parseArgs,
} = require('./configure-codex-transcript-sync');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-config-'));
  const runtimeRoot = path.join(root, 'runtime');
  const envFile = path.join(runtimeRoot, 'deploy', 'postgres', '.env.transcripts');
  const configPath = path.join(root, 'home', '.tech-persistence', 'config.json');
  fs.mkdirSync(path.join(runtimeRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, 'node_modules', 'pg'), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify({ name: 'tech-persistence' })
  );
  fs.writeFileSync(path.join(runtimeRoot, 'scripts', 'sync-codex-transcripts.js'), '// fixture\n');
  fs.writeFileSync(
    path.join(runtimeRoot, 'node_modules', 'pg', 'package.json'),
    JSON.stringify({ name: 'pg', version: '8.22.0', main: 'index.js' })
  );
  fs.writeFileSync(path.join(runtimeRoot, 'node_modules', 'pg', 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(envFile, 'TRANSCRIPT_POSTGRES_URL=postgres://secret-never-log\n');
  try {
    fn({ root, runtimeRoot, envFile, configPath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function options(fixture, overrides = {}) {
  return {
    runtimeRoot: fixture.runtimeRoot,
    envFile: fixture.envFile,
    configPath: fixture.configPath,
    ...overrides,
  };
}

test('atomically merges transcriptSync while preserving existing homunculus and extension fields', () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.dirname(fixture.configPath), { recursive: true });
    fs.writeFileSync(fixture.configPath, JSON.stringify({
      mode: 'shared',
      homunculusHome: 'C:/vault',
      extension: { keep: true },
      transcriptSync: { futureField: 'preserved', enabled: false },
    }));

    const calls = [];
    const observingFs = {
      ...fs,
      openSync(file, flags, mode) {
        if (String(file).includes('.tmp-')) calls.push(['open', file, flags, mode]);
        return fs.openSync(file, flags, mode);
      },
      fsyncSync(fd) {
        calls.push(['fsync', fd]);
        return fs.fsyncSync(fd);
      },
      renameSync(from, to) {
        calls.push(['rename', from, to]);
        return fs.renameSync(from, to);
      },
    };
    const result = configureCodexTranscriptSync(options(fixture, {
      watchSeconds: 21,
      reconcileSeconds: 1200,
    }), {
      fileSystem: observingFs,
      now: () => new Date('2026-08-25T06:00:00.000Z'),
    });

    assert.strictEqual(result.status, 'configured');
    const written = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
    assert.deepStrictEqual(written, {
      mode: 'shared',
      homunculusHome: 'C:/vault',
      extension: { keep: true },
      transcriptSync: {
        futureField: 'preserved',
        enabled: true,
        runtimeRoot: fixture.runtimeRoot,
        envFile: fixture.envFile,
        watchSeconds: 21,
        reconcileSeconds: 1200,
        reconcileAfter: '2026-08-25T06:00:00.000Z',
      },
    });
    const open = calls.find(([name]) => name === 'open');
    const rename = calls.find(([name]) => name === 'rename');
    assert(open, 'temporary file should be opened');
    assert.strictEqual(open[2], 'wx');
    assert.strictEqual(open[3], 0o600);
    assert(calls.some(([name]) => name === 'fsync'));
    assert(rename, 'temporary file should be atomically renamed');
    assert.strictEqual(path.dirname(rename[1]), path.dirname(fixture.configPath));
    assert.strictEqual(rename[2], fixture.configPath);
  });
});

test('uses the documented defaults and creates a missing config parent', () => {
  withFixture((fixture) => {
    const result = configureCodexTranscriptSync(options(fixture), {
      now: () => new Date('2026-08-25T06:01:02.003Z'),
    });
    assert.strictEqual(result.config.transcriptSync.watchSeconds, DEFAULT_WATCH_SECONDS);
    assert.strictEqual(result.config.transcriptSync.reconcileSeconds, DEFAULT_RECONCILE_SECONDS);
    assert.strictEqual(
      result.config.transcriptSync.reconcileAfter,
      '2026-08-25T06:01:02.003Z'
    );
    assert.strictEqual(result.config.transcriptSync.enabled, true);
    assert.deepStrictEqual(result.configuredFields, CONFIGURED_FIELDS);
    assert(fs.existsSync(fixture.configPath));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(fixture.configPath).mode & 0o777, 0o600);
    }
  });
});

test('first configure records an activation baseline and later configure preserves it', () => {
  withFixture((fixture) => {
    const initial = configureCodexTranscriptSync(options(fixture), {
      now: () => new Date('2026-08-25T07:00:00.000Z'),
    });
    assert.strictEqual(
      initial.config.transcriptSync.reconcileAfter,
      '2026-08-25T07:00:00.000Z'
    );

    const repeated = configureCodexTranscriptSync(options(fixture, { watchSeconds: 30 }), {
      now: () => new Date('2026-08-26T07:00:00.000Z'),
    });
    assert.strictEqual(
      repeated.config.transcriptSync.reconcileAfter,
      '2026-08-25T07:00:00.000Z'
    );
    assert.strictEqual(repeated.config.transcriptSync.watchSeconds, 30);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')).transcriptSync.reconcileAfter,
      '2026-08-25T07:00:00.000Z'
    );
  });
});

test('reconfigure rejects a non-canonical activation baseline instead of replacing it', () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.dirname(fixture.configPath), { recursive: true });
    fs.writeFileSync(fixture.configPath, JSON.stringify({
      transcriptSync: { reconcileAfter: 1234 },
    }));
    const before = fs.readFileSync(fixture.configPath, 'utf8');
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture), {
        now: () => new Date('2026-08-25T08:00:00.000Z'),
      }),
      /reconcileAfter.*canonical UTC/i
    );
    assert.strictEqual(fs.readFileSync(fixture.configPath, 'utf8'), before);
  });
});

test('dry-run validates inputs but neither creates nor changes config state', () => {
  withFixture((fixture) => {
    const result = configureCodexTranscriptSync(options(fixture, { dryRun: true }));
    assert.strictEqual(result.status, 'planned');
    assert.strictEqual(fs.existsSync(fixture.configPath), false);

    fs.mkdirSync(path.dirname(fixture.configPath), { recursive: true });
    fs.writeFileSync(fixture.configPath, '{"homunculusHome":"C:/keep"}\n');
    const before = fs.readFileSync(fixture.configPath, 'utf8');
    configureCodexTranscriptSync(options(fixture, { dryRun: true }));
    assert.strictEqual(fs.readFileSync(fixture.configPath, 'utf8'), before);
  });
});

test('API rejects relative config, runtime, and env paths', () => {
  withFixture((fixture) => {
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture, { runtimeRoot: 'relative-runtime' })),
      /runtimeRoot.*absolute/i
    );
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture, { envFile: 'relative-env' })),
      /envFile.*absolute/i
    );
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture, { configPath: 'relative-config' })),
      /configPath.*absolute/i
    );
  });
});

test('validates runtime identity, sync entrypoint, and pg resolution', () => {
  withFixture((fixture) => {
    fs.writeFileSync(path.join(fixture.runtimeRoot, 'package.json'), JSON.stringify({ name: 'other' }));
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture)),
      /package\.json.*tech-persistence/i
    );

    fs.writeFileSync(
      path.join(fixture.runtimeRoot, 'package.json'),
      JSON.stringify({ name: 'tech-persistence' })
    );
    fs.rmSync(path.join(fixture.runtimeRoot, 'scripts', 'sync-codex-transcripts.js'));
    fs.mkdirSync(path.join(fixture.runtimeRoot, 'scripts', 'sync-codex-transcripts.js'));
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture)),
      /sync-codex-transcripts\.js.*plain file/i
    );

    fs.rmSync(path.join(fixture.runtimeRoot, 'scripts', 'sync-codex-transcripts.js'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(fixture.runtimeRoot, 'scripts', 'sync-codex-transcripts.js'), '// ok\n');
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture), {
        resolveModule() {
          throw new Error('resolution failed');
        },
      }),
      /pg.*runtimeRoot/i
    );
  });
});

test('rejects an env directory and env symlink without reading env content', () => {
  withFixture((fixture) => {
    fs.rmSync(fixture.envFile);
    fs.mkdirSync(fixture.envFile);
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture)),
      /envFile.*plain file/i
    );

    fs.rmSync(fixture.envFile, { recursive: true });
    const actual = `${fixture.envFile}.actual`;
    fs.writeFileSync(actual, 'SECRET_VALUE=do-not-leak-this-value\n');
    try {
      fs.symlinkSync(actual, fixture.envFile, 'file');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      return;
    }
    let caught;
    try {
      configureCodexTranscriptSync(options(fixture));
    } catch (error) {
      caught = error;
    }
    assert(caught);
    assert.match(caught.message, /envFile.*symbolic link/i);
    assert(!caught.message.includes('do-not-leak-this-value'));
  });
});

test('rejects unsafe, oversized, and malformed existing configs', () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.dirname(fixture.configPath), { recursive: true });
    fs.mkdirSync(fixture.configPath);
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture)),
      /configPath.*plain file/i
    );

    fs.rmSync(fixture.configPath, { recursive: true });
    fs.writeFileSync(fixture.configPath, 'x'.repeat(MAX_CONFIG_BYTES + 1));
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture)),
      /configPath.*size limit/i
    );

    fs.writeFileSync(fixture.configPath, '{broken');
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture)),
      /configPath.*valid JSON/i
    );

    fs.writeFileSync(fixture.configPath, '[]');
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture)),
      /configPath.*JSON object/i
    );
  });
});

test('rejects a symlink config and leaves its target unchanged', () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.dirname(fixture.configPath), { recursive: true });
    const target = path.join(fixture.root, 'protected.json');
    fs.writeFileSync(target, '{"protected":true}\n');
    try {
      fs.symlinkSync(target, fixture.configPath, 'file');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      return;
    }
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture)),
      /configPath.*symbolic link/i
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"protected":true}\n');
  });
});

test('a failed atomic rename preserves the previous config and cleans the temporary file', () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.dirname(fixture.configPath), { recursive: true });
    const original = '{"homunculusHome":"C:/keep"}\n';
    fs.writeFileSync(fixture.configPath, original);
    const failingFs = {
      ...fs,
      renameSync() {
        const error = new Error('injected rename failure');
        error.code = 'EIO';
        throw error;
      },
    };
    assert.throws(
      () => configureCodexTranscriptSync(options(fixture), { fileSystem: failingFs }),
      /atomically write configPath.*EIO/i
    );
    assert.strictEqual(fs.readFileSync(fixture.configPath, 'utf8'), original);
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(fixture.configPath)).filter((name) => name.includes('.tmp-')),
      []
    );
  });
});

test('non-Windows atomic writes force 0600 before the rename', () => {
  const calls = [];
  const fakeFs = {
    mkdirSync() {},
    openSync(file, flags, mode) {
      calls.push(['open', file, flags, mode]);
      return flags === 'wx' ? 10 : 11;
    },
    writeFileSync(fd, body, encoding) {
      calls.push(['write', fd, body, encoding]);
    },
    fchmodSync(fd, mode) {
      calls.push(['fchmod', fd, mode]);
    },
    fsyncSync(fd) {
      calls.push(['fsync', fd]);
    },
    closeSync(fd) {
      calls.push(['close', fd]);
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
    },
    unlinkSync(file) {
      calls.push(['unlink', file]);
    },
  };
  atomicWriteJson(fakeFs, 'C:\\safe\\config.json', { ok: true }, {
    pathModule: path.win32,
    platform: 'linux',
    randomBytes: () => Buffer.from('fixed-random'),
  });
  assert(calls.some((call) => (
    call[0] === 'open' && call[2] === 'wx' && call[3] === 0o600
  )));
  assert.deepStrictEqual(calls.find(([name]) => name === 'fchmod'), ['fchmod', 10, 0o600]);
  const fchmodIndex = calls.findIndex(([name]) => name === 'fchmod');
  const renameIndex = calls.findIndex(([name]) => name === 'rename');
  assert(fchmodIndex >= 0 && renameIndex > fchmodIndex);
});

test('parseArgs supports overrides, dynamic env default, and positive integer validation', () => {
  withFixture((fixture) => {
    const parsed = parseArgs([
      '--runtime-root', fixture.runtimeRoot,
      '--config', fixture.configPath,
      '--watch-seconds', '7',
      '--reconcile-seconds', '60',
      '--dry-run',
    ], { env: {}, home: fixture.root });
    assert.strictEqual(parsed.runtimeRoot, fixture.runtimeRoot);
    assert.strictEqual(parsed.envFile, path.join(
      fixture.runtimeRoot,
      'deploy',
      'postgres',
      '.env.transcripts'
    ));
    assert.strictEqual(parsed.watchSeconds, 7);
    assert.strictEqual(parsed.reconcileSeconds, 60);
    assert.strictEqual(parsed.dryRun, true);
    const relative = parseArgs([
      '--runtime-root', 'runtime',
      '--env-file', 'runtime/deploy/postgres/.env.transcripts',
      '--config', 'home/.tech-persistence/config.json',
    ], { env: {}, home: fixture.root, cwd: fixture.root });
    assert.strictEqual(relative.runtimeRoot, path.join(fixture.root, 'runtime'));
    assert.strictEqual(
      relative.envFile,
      path.join(fixture.root, 'runtime', 'deploy', 'postgres', '.env.transcripts')
    );
    assert.strictEqual(
      relative.configPath,
      path.join(fixture.root, 'home', '.tech-persistence', 'config.json')
    );
    assert.throws(
      () => parseArgs(['--watch-seconds', '0'], { env: {}, home: fixture.root }),
      /watchSeconds.*positive integer/i
    );
    assert.throws(
      () => parseArgs(['--reconcile-seconds', '86401'], { env: {}, home: fixture.root }),
      /reconcileSeconds.*at most 86400/i
    );
    assert.throws(
      () => parseArgs(['--unknown'], { env: {}, home: fixture.root }),
      /Unknown option/i
    );
  });
});

test('CLI reports only status and configured field names, never paths or env contents', () => {
  withFixture((fixture) => {
    const stdout = [];
    const stderr = [];
    const code = main([
      '--runtime-root', fixture.runtimeRoot,
      '--env-file', fixture.envFile,
      '--config', fixture.configPath,
      '--dry-run',
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(stderr, []);
    const output = stdout.join('\n');
    assert.match(output, /DRY-RUN/);
    CONFIGURED_FIELDS.forEach((field) => assert(output.includes(field)));
    assert(!output.includes(fixture.runtimeRoot));
    assert(!output.includes(fixture.envFile));
    assert(!output.includes('postgres://secret-never-log'));
  });
});

if (!process.exitCode) {
  console.log(`\n${passed} configure transcript sync tests passed.`);
}
