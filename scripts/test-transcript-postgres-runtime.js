#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_POSTGRES_PORT,
  POSTGRES_STARTUP_MAX_USED_PERCENT,
  POSTGRES_STARTUP_MIN_FREE_BYTES,
  POSTGRES_STARTUP_MIN_FREE_INODES,
  prepareRuntime,
  runCli,
} = require('./transcript-postgres-runtime');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(
  REPO_ROOT,
  'deploy',
  'compose',
  'tech-persistence-postgres.compose.yml'
);
const INIT_ROOT = path.join(REPO_ROOT, 'deploy', 'postgres', 'init');
const START_TUNNEL_SCRIPT = path.join(
  REPO_ROOT,
  'deploy',
  'postgres',
  'start-transcript-postgres-tunnel.ps1'
);
const INSTALL_TUNNEL_SCRIPT = path.join(
  REPO_ROOT,
  'deploy',
  'postgres',
  'install-transcript-postgres-tunnel.ps1'
);

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

function withRuntime(fn) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-transcript-postgres-'));
  const runtime = {
    repoRoot,
    postgresRoot: path.join(repoRoot, 'deploy', 'postgres'),
    dataDir: path.join(repoRoot, 'local-dev-data'),
    composeFile: path.join(repoRoot, 'deploy', 'compose', 'tech-persistence-postgres.compose.yml'),
    allowLocalDevData: true,
    statfsSyncImpl: healthyStatfsSync,
  };
  return Promise.resolve(fn(runtime)).finally(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
}

function healthyStatfsSync() {
  return {
    bsize: 4096n,
    blocks: 2_000_000n,
    bfree: 1_000_000n,
    bavail: 1_000_000n,
    files: 2_000_000n,
    ffree: 1_000_000n,
  };
}

function deterministicRandomBytes() {
  let next = 1;
  return (size) => Buffer.alloc(size, next++);
}

function parseEnv(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

test('compose pins PostgreSQL and keeps the service on loopback with bounded resources', () => {
  const compose = fs.readFileSync(COMPOSE_FILE, 'utf8');
  assert.match(compose, /image:\s*postgres@sha256:[a-f0-9]{64}\b/);
  assert.match(compose, /127\.0\.0\.1:\$\{TECH_PERSISTENCE_POSTGRES_PORT:-55433\}:5432/);
  assert.match(compose, /pg_isready[^\n]*tech_persistence/);
  assert.match(
    compose,
    /source:\s*["']?\$\{TECH_PERSISTENCE_POSTGRES_DATA_DIR:\?[^}]+\}/
  );
  assert.match(compose, /target:\s*\/var\/lib\/postgresql\/data/);
  assert.match(compose, /create_host_path:\s*false/);
  assert.doesNotMatch(compose, /\.\.\/postgres\/data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /\.\.\/postgres\/init:\/docker-entrypoint-initdb\.d:ro/);
  assert.match(compose, /mem_limit:/);
  assert.match(compose, /pids_limit:/);
  assert.match(compose, /max-size:\s*["']?10m/);
  assert.match(compose, /postgres_admin_password:/);
  assert.match(compose, /transcript_reader_password:/);
  assert.match(compose, /transcript_writer_password:/);
  assert.match(compose, /acceptance_reader_password:/);
  assert.match(compose, /acceptance_writer_password:/);
});

test('init assets create least-privilege roles and append-only transcript evidence tables', () => {
  const roles = fs.readFileSync(path.join(INIT_ROOT, '00-create-roles.sh'), 'utf8');
  const schema = fs.readFileSync(path.join(INIT_ROOT, '10-transcripts.sql'), 'utf8');
  const acceptanceSchema = fs.readFileSync(
    path.join(INIT_ROOT, '20-acceptance-authority.sql'),
    'utf8'
  );

  assert.match(roles, /CREATE ROLE transcript_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(roles, /CREATE ROLE transcript_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(roles, /CREATE ROLE acceptance_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(roles, /CREATE ROLE acceptance_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(roles, /REVOKE ALL ON DATABASE tech_persistence FROM PUBLIC/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.transcripts/);
  assert.match(schema, /transcript_id text PRIMARY KEY/);
  assert.match(schema, /root_session_id text NOT NULL/);
  assert.match(schema, /source_file_name text NOT NULL/);
  assert.match(schema, /file_identity_hash text NOT NULL/);
  assert.match(schema, /observed_mtime double precision/);
  assert.match(schema, /next_byte_offset bigint NOT NULL/);
  assert.match(schema, /next_line_no bigint NOT NULL/);
  assert.match(schema, /last_ordinal bigint/);
  assert.match(schema, /event_chain_sha256 text/);
  assert.match(schema, /projection_chain_sha256 text/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.transcript_events/);
  assert.match(schema, /position_kind text NOT NULL/);
  assert.match(schema, /source_position bigint NOT NULL/);
  assert.match(schema, /event_sha256 text NOT NULL/);
  assert.match(schema, /event_json jsonb NOT NULL/);
  assert.match(schema, /metadata_json jsonb NOT NULL/);
  assert.match(schema, /last_synced_at timestamptz/);
  assert.match(schema, /PRIMARY KEY \(transcript_id, position_kind, source_position\)/);
  assert.match(schema, /GRANT SELECT ON TABLE public\.transcripts, public\.transcript_events TO transcript_reader/);
  assert.match(schema, /GRANT INSERT ON TABLE public\.transcripts TO transcript_writer/);
  assert.match(schema, /GRANT SELECT \([\s\S]*transcript_id[\s\S]*redaction_version[\s\S]*\) ON TABLE public\.transcripts TO transcript_writer/);
  assert.match(schema, /GRANT UPDATE \([\s\S]*next_byte_offset[\s\S]*last_synced_at[\s\S]*\) ON TABLE public\.transcripts TO transcript_writer/);
  assert.match(schema, /GRANT INSERT ON TABLE public\.transcript_events TO transcript_writer/);
  assert.match(schema, /GRANT SELECT \([\s\S]*transcript_id[\s\S]*position_kind[\s\S]*source_position[\s\S]*projection_sha256[\s\S]*\) ON TABLE public\.transcript_events TO transcript_writer/);
  const writerTranscriptSelect = schema.match(
    /GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.transcripts TO transcript_writer/
  );
  const writerEventSelect = schema.match(
    /GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.transcript_events TO transcript_writer/
  );
  assert(writerTranscriptSelect && !writerTranscriptSelect[1].includes('metadata_json'));
  assert(writerEventSelect && !writerEventSelect[1].includes('event_json'));
  assert.doesNotMatch(schema, /GRANT[^;]*DELETE[^;]*transcript_writer/i);
  assert.doesNotMatch(schema, /GRANT\s+UPDATE[^;]*public\.transcript_events/i);
  assert.doesNotMatch(schema, /GRANT\s+CREATE[^;]*transcript_(?:reader|writer)/i);
  assert.match(acceptanceSchema, /CREATE TABLE IF NOT EXISTS public\.acceptance_authority_records/);
  assert.match(acceptanceSchema, /PRIMARY KEY \(authority_scope, record_kind, record_key\)/);
  assert.match(acceptanceSchema, /GRANT SELECT ON TABLE public\.acceptance_authority_records TO acceptance_reader/);
  assert.match(acceptanceSchema, /GRANT INSERT ON TABLE public\.acceptance_authority_records TO acceptance_writer/);
  assert.match(acceptanceSchema, /GRANT SELECT \([\s\S]*record_hash[\s\S]*\) ON TABLE public\.acceptance_authority_records TO acceptance_writer/);
  assert.doesNotMatch(acceptanceSchema, /GRANT[^;]*(?:UPDATE|DELETE|TRUNCATE)[^;]*acceptance_writer/i);
  assert.match(acceptanceSchema, /BEFORE UPDATE OR DELETE ON public\.acceptance_authority_records/);
  assert.match(acceptanceSchema, /'authority-canary'/);
});

test('Windows tunnel launcher fails closed and keeps SSH forwarding encrypted and noninteractive', () => {
  const script = fs.readFileSync(START_TUNNEL_SCRIPT, 'utf8');

  assert.match(script, /\[ValidatePattern\('\^\[\^\\s@\]\+@\[\^\\s@\]\+\$'\)\]/);
  assert.match(script, /\$forward = "127\.0\.0\.1:\$\{LocalPort\}:\$\{RemoteHost\}:\$\{RemotePort\}"/);
  assert.match(script, /'-N'/);
  assert.match(script, /'-T'/);
  assert.match(script, /'BatchMode=yes'/);
  assert.match(script, /'PasswordAuthentication=no'/);
  assert.match(script, /'KbdInteractiveAuthentication=no'/);
  assert.match(script, /'StrictHostKeyChecking=yes'/);
  assert.match(script, /'ExitOnForwardFailure=yes'/);
  assert.match(script, /'ConnectTimeout=15'/);
  assert.match(script, /'ServerAliveInterval=30'/);
  assert.match(script, /'ServerAliveCountMax=3'/);
  assert.match(script, /'TCPKeepAlive=yes'/);
  assert.match(script, /'-L', \$forward/);
  assert.doesNotMatch(script, /StrictHostKeyChecking=(?:no|accept-new)/i);
  assert.doesNotMatch(script, /(?:Password|KbdInteractive)Authentication=yes/i);
  assert.match(script, /throw "Transcript PostgreSQL SSH tunnel exited with code \$\{sshExitCode\}\."/);
});

test('Windows tunnel installer makes the limited scheduled task directly own hardened ssh', () => {
  const script = fs.readFileSync(INSTALL_TUNNEL_SCRIPT, 'utf8');

  assert.match(script, /\[ValidatePattern\('\^\[\^\\s@\]\+@\[\^\\s@\]\+\$'\)\]/);
  assert.match(script, /\$ssh = Get-Command ssh\.exe -ErrorAction Stop/);
  assert.match(script, /\$forward = "127\.0\.0\.1:\$\{LocalPort\}:\$\{RemoteHost\}:\$\{RemotePort\}"/);
  assert.match(script, /'-N'/);
  assert.match(script, /'-T'/);
  assert.match(script, /'BatchMode=yes'/);
  assert.match(script, /'PasswordAuthentication=no'/);
  assert.match(script, /'KbdInteractiveAuthentication=no'/);
  assert.match(script, /'StrictHostKeyChecking=yes'/);
  assert.match(script, /'ExitOnForwardFailure=yes'/);
  assert.match(script, /'ConnectTimeout=15'/);
  assert.match(script, /'ServerAliveInterval=30'/);
  assert.match(script, /'ServerAliveCountMax=3'/);
  assert.match(script, /'TCPKeepAlive=yes'/);
  assert.match(script, /'LogLevel=ERROR'/);
  assert.match(script, /'-L', \$forward/);
  assert.match(script, /\$actionArguments = \$sshArguments -join ' '/);
  assert.match(script, /New-ScheduledTaskAction -Execute \$ssh\.Source -Argument \$actionArguments/);
  assert.doesNotMatch(script, /New-ScheduledTaskAction -Execute \$powershell/i);
  assert.doesNotMatch(script, /-File[^\r\n]*start-transcript-postgres-tunnel/i);
  assert.doesNotMatch(script, /StrictHostKeyChecking=(?:no|accept-new)/i);
  assert.doesNotMatch(script, /(?:Password|KbdInteractive)Authentication=yes/i);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$currentIdentity/);
  assert.match(script, /-LogonType Interactive/);
  assert.match(script, /-RunLevel Limited/);
  assert.match(script, /-StartWhenAvailable/);
  assert.match(script, /-RestartCount 999/);
  assert.match(script, /-RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /Register-ScheduledTask -TaskName \$TaskName -InputObject \$definition -Force/);
  assert.match(script, /Start-ScheduledTask -TaskName \$TaskName/);
});

test('prepare creates five private secrets and distinct client URLs without replacing them', async () => {
  await withRuntime((runtime) => {
    const { postgresRoot, dataDir } = runtime;
    const first = prepareRuntime({ ...runtime, randomBytes: deterministicRandomBytes() });
    assert.strictEqual(first.createdSecrets.length, 5);
    assert.strictEqual(first.port, DEFAULT_POSTGRES_PORT);

    const secretPaths = [
      path.join(postgresRoot, 'secrets', 'postgres-admin-password'),
      path.join(postgresRoot, 'secrets', 'transcript-reader-password'),
      path.join(postgresRoot, 'secrets', 'transcript-writer-password'),
      path.join(postgresRoot, 'secrets', 'acceptance-reader-password'),
      path.join(postgresRoot, 'secrets', 'acceptance-writer-password'),
    ];
    const firstSecrets = secretPaths.map((file) => fs.readFileSync(file, 'utf8'));
    assert.strictEqual(new Set(firstSecrets).size, 5);
    assert(firstSecrets.every((value) => value.trim().length >= 40));

    const envFile = path.join(postgresRoot, '.env.transcripts');
    const firstEnv = fs.readFileSync(envFile, 'utf8');
    const parsed = parseEnv(firstEnv);
    assert.strictEqual(parsed.TECH_PERSISTENCE_POSTGRES_PORT, '55433');
    assert.strictEqual(parsed.TECH_PERSISTENCE_POSTGRES_DATA_DIR, dataDir);
    assert.strictEqual(parsed.TECH_PERSISTENCE_POSTGRES_LOCAL_DEV, 'true');
    assert.strictEqual(parsed.TRANSCRIPTS_POSTGRES_SSL, 'false');
    assert.match(parsed.TRANSCRIPTS_POSTGRES_READ_URL, /^postgresql:\/\/transcript_reader:/);
    assert.match(parsed.TRANSCRIPTS_POSTGRES_WRITE_URL, /^postgresql:\/\/transcript_writer:/);
    assert.match(parsed.ACCEPTANCE_POSTGRES_READ_URL, /^postgresql:\/\/acceptance_reader:/);
    assert.match(parsed.ACCEPTANCE_POSTGRES_WRITE_URL, /^postgresql:\/\/acceptance_writer:/);
    assert(parsed.TRANSCRIPTS_POSTGRES_READ_URL.endsWith('@127.0.0.1:55433/tech_persistence'));

    const second = prepareRuntime({
      ...runtime,
      randomBytes() {
        throw new Error('idempotent prepare must not generate replacement secrets');
      },
    });
    assert.deepStrictEqual(second.createdSecrets, []);
    assert.deepStrictEqual(secretPaths.map((file) => fs.readFileSync(file, 'utf8')), firstSecrets);
    assert.strictEqual(fs.readFileSync(envFile, 'utf8'), firstEnv);

    if (process.platform !== 'win32') {
      for (const file of [...secretPaths, envFile]) {
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      }
    }
  });
});

test('prepare preserves existing env values and only appends missing keys', async () => {
  await withRuntime((runtime) => {
    const { postgresRoot, dataDir } = runtime;
    fs.mkdirSync(postgresRoot, { recursive: true });
    const envFile = path.join(postgresRoot, '.env.transcripts');
    fs.writeFileSync(
      envFile,
      '# operator-owned\n'
        + `TECH_PERSISTENCE_POSTGRES_DATA_DIR=${dataDir}\n`
        + 'TECH_PERSISTENCE_POSTGRES_LOCAL_DEV=true\n'
        + 'TECH_PERSISTENCE_POSTGRES_PORT=6001\n'
        + 'TRANSCRIPTS_POSTGRES_READ_URL=postgresql://custom\n',
      { mode: 0o600 }
    );

    prepareRuntime({ ...runtime, randomBytes: deterministicRandomBytes() });
    const content = fs.readFileSync(envFile, 'utf8');
    const parsed = parseEnv(content);
    assert(content.startsWith('# operator-owned\n'));
    assert.strictEqual((content.match(/TECH_PERSISTENCE_POSTGRES_PORT=/g) || []).length, 1);
    assert.strictEqual(parsed.TECH_PERSISTENCE_POSTGRES_PORT, '6001');
    assert.strictEqual(parsed.TRANSCRIPTS_POSTGRES_READ_URL, 'postgresql://custom');
    assert(parsed.TRANSCRIPTS_POSTGRES_WRITE_URL.endsWith('@127.0.0.1:6001/tech_persistence'));
  });
});

test('prepare fails closed before generating credentials when data exists and a secret is missing', async () => {
  await withRuntime((runtime) => {
    const { postgresRoot, dataDir } = runtime;
    const secretsDir = path.join(postgresRoot, 'secrets');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'PG_VERSION'), '17\n');
    fs.writeFileSync(path.join(secretsDir, 'postgres-admin-password'), 'existing-admin\n');

    assert.throws(
      () => prepareRuntime({ ...runtime, randomBytes: deterministicRandomBytes() }),
      /data directory is not empty.*missing Docker secret/i
    );
    assert(!fs.existsSync(path.join(secretsDir, 'transcript-reader-password')));
    assert(!fs.existsSync(path.join(postgresRoot, '.env.transcripts')));
  });
});

test('prepare upgrades a complete legacy transcript cluster with only the two new acceptance secrets', async () => {
  await withRuntime((runtime) => {
    const { postgresRoot, dataDir } = runtime;
    const secretsDir = path.join(postgresRoot, 'secrets');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'PG_VERSION'), '17\n');
    for (const [name, value] of [
      ['postgres-admin-password', 'legacy-admin'],
      ['transcript-reader-password', 'legacy-reader'],
      ['transcript-writer-password', 'legacy-writer'],
    ]) {
      fs.writeFileSync(path.join(secretsDir, name), `${value}\n`);
    }

    const prepared = prepareRuntime({ ...runtime, randomBytes: deterministicRandomBytes() });
    assert.deepStrictEqual(
      [...prepared.createdSecrets].sort(),
      ['acceptance-reader-password', 'acceptance-writer-password']
    );
    const parsed = parseEnv(fs.readFileSync(path.join(postgresRoot, '.env.transcripts'), 'utf8'));
    assert.match(parsed.ACCEPTANCE_POSTGRES_READ_URL, /^postgresql:\/\/acceptance_reader:/);
    assert.match(parsed.ACCEPTANCE_POSTGRES_WRITE_URL, /^postgresql:\/\/acceptance_writer:/);
  });
});

test('prepare fails before any runtime write when free bytes are below the PostgreSQL reserve', async () => {
  await withRuntime((runtime) => {
    let randomCalled = false;
    let error;
    try {
      prepareRuntime({
        ...runtime,
        statfsSyncImpl: () => ({
          ...healthyStatfsSync(),
          bavail: (POSTGRES_STARTUP_MIN_FREE_BYTES / 4096n) - 1n,
        }),
        randomBytes() {
          randomCalled = true;
          return Buffer.alloc(32, 1);
        },
      });
    } catch (caught) {
      error = caught;
    }

    assert(error);
    assert.match(error.message, /storage preflight failed.*free space/i);
    assert(!error.message.includes(runtime.repoRoot));
    assert.strictEqual(randomCalled, false);
    assert(!fs.existsSync(runtime.postgresRoot));
    assert(!fs.existsSync(runtime.dataDir));
  });
});

test('prepare fails before any runtime write when free inodes are below the PostgreSQL reserve', async () => {
  await withRuntime((runtime) => {
    assert.throws(
      () => prepareRuntime({
        ...runtime,
        statfsSyncImpl: () => ({
          ...healthyStatfsSync(),
          ffree: POSTGRES_STARTUP_MIN_FREE_INODES - 1n,
        }),
        randomBytes() {
          throw new Error('must not generate credentials after a failed inode preflight');
        },
      }),
      /storage preflight failed.*inode/i
    );
    assert(!fs.existsSync(runtime.postgresRoot));
    assert(!fs.existsSync(runtime.dataDir));
  });
});

test('prepare fails before any runtime write when filesystem utilization reaches the startup limit', async () => {
  await withRuntime((runtime) => {
    const totalBlocks = 20_000_000n;
    const freeBlocks = (
      totalBlocks * (100n - POSTGRES_STARTUP_MAX_USED_PERCENT) / 100n
    );
    assert.throws(
      () => prepareRuntime({
        ...runtime,
        statfsSyncImpl: () => ({
          ...healthyStatfsSync(),
          blocks: totalBlocks,
          bfree: freeBlocks,
          bavail: freeBlocks,
        }),
        randomBytes() {
          throw new Error('must not generate credentials at the utilization limit');
        },
      }),
      /storage preflight failed.*utilization/i
    );
    assert(!fs.existsSync(runtime.postgresRoot));
    assert(!fs.existsSync(runtime.dataDir));
  });
});

test('stable PGDATA policy rejects repository, release, and temporary paths unless local development is explicit', async () => {
  await withRuntime((runtime) => {
    const unsafeDataDir = path.join(runtime.repoRoot, 'releases', 'current', 'postgres');
    let error;
    try {
      prepareRuntime({
        ...runtime,
        dataDir: unsafeDataDir,
        allowLocalDevData: false,
        randomBytes: deterministicRandomBytes(),
      });
    } catch (caught) {
      error = caught;
    }
    assert(error);
    assert.match(error.message, /stable PGDATA policy/i);
    assert(!error.message.includes(unsafeDataDir));
    assert(!fs.existsSync(unsafeDataDir));

    const prepared = prepareRuntime({
      ...runtime,
      dataDir: unsafeDataDir,
      allowLocalDevData: true,
      randomBytes: deterministicRandomBytes(),
    });
    assert.strictEqual(prepared.dataDir, unsafeDataDir);
    assert(fs.statSync(unsafeDataDir).isDirectory());
  });
});

test('up/status/down use the injected Docker runner and never require a real daemon in tests', async () => {
  await withRuntime((runtime) => {
    const { repoRoot, composeFile } = runtime;
    fs.mkdirSync(path.dirname(composeFile), { recursive: true });
    fs.writeFileSync(composeFile, 'services: {}\n');
    const calls = [];
    const spawnSyncImpl = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'ok\n', stderr: '' };
    };

    runCli(['up'], { ...runtime, spawnSyncImpl, randomBytes: deterministicRandomBytes() });
    runCli(['status'], { ...runtime, spawnSyncImpl });
    runCli(['down'], { ...runtime, spawnSyncImpl });

    assert.strictEqual(calls.length, 5);
    assert.deepStrictEqual(calls.map((call) => call.command), ['docker', 'docker', 'docker', 'docker', 'docker']);
    assert.deepStrictEqual(
      calls[0].args.slice(-5),
      ['up', '-d', '--wait', '--wait-timeout', '120']
    );
    assert.deepStrictEqual(
      calls[1].args.slice(-5),
      ['exec', '-T', 'tech-persistence-postgres', '/bin/sh', '/docker-entrypoint-initdb.d/00-create-roles.sh']
    );
    assert(calls[2].args.some((arg) => arg.endsWith('/docker-entrypoint-initdb.d/20-acceptance-authority.sql')));
    assert.strictEqual(calls[3].args.at(-1), 'ps');
    assert.strictEqual(calls[4].args.at(-1), 'down');
    for (const call of calls) {
      assert.strictEqual(call.options.shell, false);
      assert(call.args.includes('--env-file'));
      assert(call.args.includes('-f'));
    }
  });
});

test('up refuses a full filesystem before credentials, env, Docker, or runtime directories are written', async () => {
  await withRuntime((runtime) => {
    let dockerCalled = false;
    assert.throws(
      () => runCli(['up'], {
        ...runtime,
        statfsSyncImpl: () => ({ ...healthyStatfsSync(), bavail: 0n }),
        spawnSyncImpl() {
          dockerCalled = true;
          return { status: 0, stdout: '', stderr: '' };
        },
        randomBytes() {
          throw new Error('must not generate credentials on a full filesystem');
        },
      }),
      /storage preflight failed.*free space/i
    );
    assert.strictEqual(dockerCalled, false);
    assert(!fs.existsSync(runtime.postgresRoot));
    assert(!fs.existsSync(runtime.dataDir));
  });
});

test('Docker failures retain the attempted operation and stderr context', async () => {
  await withRuntime((runtime) => {
    const { composeFile } = runtime;
    fs.mkdirSync(path.dirname(composeFile), { recursive: true });
    fs.writeFileSync(composeFile, 'services: {}\n');
    prepareRuntime({ ...runtime, randomBytes: deterministicRandomBytes() });
    assert.throws(
      () => runCli(['status'], {
        ...runtime,
        spawnSyncImpl: () => ({ status: 17, stdout: '', stderr: 'daemon unavailable\n' }),
      }),
      /docker compose status failed.*daemon unavailable/i
    );
  });
});

(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const { name, error } of failures) {
      console.error(`\n[${name}]\n${error.stack || error.message}`);
    }
    process.exitCode = 1;
  }
})();
