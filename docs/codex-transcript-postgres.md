# Codex transcript PostgreSQL sync

This feature automatically delivers Codex session transcripts to PostgreSQL without putting network latency on the `SessionEnd` hook path.

## Delivery contract

The runtime has three independent recovery layers:

1. `codex-transcript-outbox.js` runs synchronously for every main-thread `SessionEnd`. Within the Codex three-second limit it validates the official session identifier and a plain transcript below the trusted sessions root, captures file identity/size/mtime through a verified descriptor, and atomically fsyncs a content-addressed v2 job. The job contains no transcript body and does not perform an O(n) file hash.
2. After the durable job exists, the hook detached-starts `sync-codex-transcripts.js` from the explicitly configured Tech Persistence runtime. A directory lease permits only one worker per outbox. The worker drains immediately, retains failed jobs, and retries database or network failures with bounded exponential backoff.
3. On worker startup and every 15 minutes by default, the worker reconciles every plain `.jsonl` below `~/.codex/sessions` whose modification time is at or after the immutable first-configuration baseline. This covers post-activation Codex crashes, machine shutdowns, hook timeouts, missing jobs, and subagent transcripts (Codex does not emit `SessionEnd` for subagents) without silently backfilling an unbounded historical archive.

PostgreSQL delivery is complete only after a separate reader connection verifies the committed row count, duplicate-position count, byte cursor, last-event hash, raw-event chain, and projection chain. Only then may an outbox job be acknowledged.

## Configure the worker

Install the pinned Node dependency, prepare a private PostgreSQL env file, then configure the absolute runtime paths:

```powershell
npm install
node scripts/configure-codex-transcript-sync.js `
  --runtime-root C:\project\my\tech-persistence `
  --env-file C:\path\to\private-transcripts.env
```

The command atomically merges this allowlisted section into `~/.tech-persistence/config.json` while preserving existing homunculus settings:

```json
{
  "transcriptSync": {
    "enabled": true,
    "runtimeRoot": "C:\\project\\my\\tech-persistence",
    "envFile": "C:\\path\\to\\private-transcripts.env",
    "watchSeconds": 15,
    "reconcileSeconds": 900,
    "reconcileAfter": "2026-08-25T06:00:00.000Z"
  }
}
```

The configurator verifies that the runtime, sync entrypoint, `pg` dependency, env file, and config file are ordinary non-symlink filesystem objects. It records `reconcileAfter` only on first configuration and preserves that baseline on later idempotent runs. It never prints or copies the env file contents.

## Trust the installed `SessionEnd` hook

Codex loads plugin hooks, but non-managed hook definitions do not run until their exact definition hash is trusted. After installing or updating the Tech Persistence plugin, open an interactive Codex session in the target workspace:

```powershell
codex --no-alt-screen -C C:\project\my\tech-persistence
```

Enter `/hooks`, inspect the Tech Persistence `SessionEnd` definition, and approve the exact installed hook set. Repeat this review whenever the hook definition changes because the trusted hash changes with it. The one-off `--dangerously-bypass-hook-trust` flag is useful only for a controlled diagnostic probe; it does not persist activation.

Close a fresh session normally, then require both the durable outbox/worker evidence and an independent PostgreSQL reader query before declaring automatic sync active. See the official [Codex hooks trust contract](https://learn.chatgpt.com/docs/hooks).

## Local PostgreSQL for development

Requirements: Node.js 18.15 or newer (for filesystem-capacity checks) and Docker Compose.

```powershell
npm run transcripts:postgres
npm run transcripts:postgres:status
npm run acceptance:postgres:canary
npm run transcripts:configure
```

`transcripts:postgres` is idempotent. On first use it creates five random Docker secrets: independent transcript reader/writer credentials, independent acceptance-authority reader/writer credentials, and the administrator credential. It then creates the database, least-privilege roles, transcript tables, and the append-only `acceptance_authority_records` ledger. It refuses to regenerate missing secrets when an initialized data directory exists because replacement files would no longer match the role passwords stored by PostgreSQL.

For a legacy cluster whose administrator and two transcript secret files are all intact, `transcripts:postgres` may create exactly the two newly introduced acceptance secrets. After the container is healthy it always reruns the fixed role and acceptance-schema migrations through `docker compose exec -T`; both are idempotent. Any other missing legacy credential still fails before replacement credentials are generated.

`acceptance:postgres:canary` first attests the exact database privileges, appends one synthetic `authority-canary` record in a writer transaction, and verifies the committed canonical payload and hash through the independent read-only connection. A successful connection alone is not treated as readback evidence, and an `authority-canary` record can never satisfy a criterion's `readback` Oracle. The canary output contains only the record digest, never a connection URL.

Shadow Receipt mirroring is explicit. Pass both `--acceptance-postgres-env-file <path>` and, for an installed/plugin runtime, `--acceptance-postgres-broker <path>` to `agent-orchestrator`. The public broker accepts only `acceptance-receipt` and `authority-canary`; it rejects `readback-seal` and every other internal authority kind so a provider cannot self-issue criterion evidence. The private env file and broker must be regular non-link files outside the provider workspace; the broker deployment must have the locked `pg` dependency available. The harness strips both transcript and acceptance database URLs from provider and validation child environments. A mirror failure changes only the shadow projection to `error`; it cannot change the run's authoritative terminal state.

Criterion `readback` Oracles use a separate fixed broker selected with `--acceptance-readback-broker <path>`. The harness sends one canonical `acceptance-readback-request-v1` per frozen criterion on stdin. The broker must return exactly `acceptance-readback-response-v1` with the unchanged stable run locator and contract/subject/criterion/Oracle binding, distinct `readerRef` and `writerRef`, a boolean `matched`, and a SHA-256 `resultDigest`. The broker must be a regular non-link file outside the provider workspace; its bytes are hashed before execution and checked again afterward. Invalid output, locator/binding drift, same-identity self-readback, execution failure, or broker mutation remains `unknown`. Valid matched/mismatched responses become verified passed/failed evidence in an external append-only `acceptance-readback-seal`; the offline shadow report independently recomputes every Receipt reference from that seal.

Criterion `independent-review` Oracles use `--acceptance-independent-review-broker <path>` and the same isolation rules. Each `acceptance-independent-review-request-v1` is target-bound by stable run locator plus the frozen four-hash binding. The exact response must echo both, name distinct `reviewerRef`/`writerRef` identities, return one `passed|failed|unknown` criterion decision and a result digest. Exact criterion coverage is written to `acceptance-independent-review-seal`; only passed/failed entries become verified Receipt evidence, and the offline report recomputes them from the external seal. Existing summary-level `review.json` approval is never upgraded.

Criterion `user-confirmation` Oracles use an explicit native Codex control plus `--acceptance-user-confirmation-broker <path>`. The user control is `TP_SELF_LEARNING_CONTROL_V1:` followed by canonical JSON for `confirm-acceptance`, binding `contract_hash`, `subject_hash`, `criterion_id`, `oracle_hash`, and an `accepted|rejected` decision. Ordinary language and non-canonical JSON remain ordinary/invalid input. The hook records only an explicit `codex_cli:UserPromptSubmit` event; the fixed external broker must read that native authority and echo the stable run locator and frozen binding with its event ref and control-envelope digest. The harness writes `acceptance-user-confirmation-seal`, and the offline report recomputes every verified reference. Claude parity is deliberately not inferred by this adapter and remains governed by P1-6b.

If the native confirmation arrives after an immutable unknown Receipt, the harness appends a successor Receipt instead of overwriting the genesis. Authority records form a one-based linear chain with `evaluationSequence` and `predecessorReceiptHash`. Only a `user-confirmation` result may move from unknown to passed/failed; existing claims, other criteria, and terminal results are immutable. The offline report verifies the complete chain and counts only its unique head. Forks, gaps, changed claims, terminal reversal, and predecessor tampering fail closed.

Gate B-1 cohort exclusion is a separate operator lifecycle action. `npm run acceptance:cohort:tombstone -- --workdir <path> --run-dir <path> --control-root <path> --broker <path> --reason <operator-abandoned|superseded-before-evaluation>` asks a fixed broker outside the provider workspace to authorize one immutable tombstone bound to the stable run locator, Contract, and expected-sample marker. It is rejected once any Receipt authority exists, and Receipt creation is rejected after a tombstone. The offline report excludes only a valid no-Receipt tombstone and reports `excludedCount` plus the reason; tamper, missing bindings, or a tombstone/Receipt race fails closed. The PostgreSQL schema reserves internal `cohort-tombstone` records, while the public append broker deliberately continues to reject that kind. Running the command changes the Gate B-1 denominator and therefore remains an explicit governance action.

Authority brokers receive only the bounded Windows process-startup environment (`SystemRoot`, `WINDIR`, `ComSpec`, `PATHEXT`, `TEMP`, and `TMP` when present), not PATH, HOME, API tokens, or database URLs. A deployed broker must obtain reader/reviewer credentials and its run-locator mapping from its own service boundary.

PGDATA is an absolute bind mount outside the checkout so a release/worktree replacement cannot remove the database:

- Linux/server default: `/opt/tech-persistence/shared/postgres`
- Windows default: `%USERPROFILE%\.tech-persistence\shared\postgres`
- Docker secrets: `deploy/postgres/secrets/`
- client environment: `deploy/postgres/.env.transcripts`
- loopback endpoint: `127.0.0.1:55433`

`prepare` records the resolved absolute path as `TECH_PERSISTENCE_POSTGRES_DATA_DIR` in the private env file, and Compose refuses to start without it. Outside an explicit local-development mode, the runtime rejects PGDATA below the repository, a release/worktree path, or the OS temporary directory (including resolved symlink targets).

For a disposable repo-local development database only, opt in explicitly before the first prepare:

```powershell
$env:TECH_PERSISTENCE_POSTGRES_DATA_DIR = (Join-Path $PWD 'deploy\postgres\data')
$env:TECH_PERSISTENCE_POSTGRES_LOCAL_DEV = 'true'
npm run transcripts:postgres
```

Do not use that opt-in on a server. Existing private env values are operator-owned and are not overwritten. Set `TECH_PERSISTENCE_POSTGRES_PORT` before the first prepare to select a different free port.

Before `prepare` creates or chmods any directory, secret, or env file, it checks every filesystem that will receive those writes. Safe startup requires at least 2 GiB available, at least 10,000 free inodes when the filesystem reports inode counts, and less than 95% block utilization. The same check runs again immediately before `up`; failures are path- and secret-free, and `status`/`down` remain available for recovery.

## Server PostgreSQL

Production follows the same boundary as agent-build:

- deploy the pinned PostgreSQL Compose service, init scripts, data, and Docker secrets into a persistent server directory;
- keep `TECH_PERSISTENCE_POSTGRES_DATA_DIR=/opt/tech-persistence/shared/postgres` (or an equivalent dedicated absolute path) outside every release/worktree and backup it independently;
- bind PostgreSQL only to server loopback (for example `127.0.0.1:55433`), never public `0.0.0.0:5432`;
- keep `transcript_reader` read-only and give `transcript_writer` only the explicit insert/cursor-update grants in `deploy/postgres/init/`;
- keep `acceptance_reader` read-only; `acceptance_writer` may only insert authority records and read the four conflict-key/hash columns, with no payload, update, delete, truncate, ownership, or schema-create privilege;
- use a managed SSH tunnel from the client, such as local `127.0.0.1:55434` to server `127.0.0.1:55433`;
- point `TRANSCRIPTS_POSTGRES_READ_URL` and `TRANSCRIPTS_POSTGRES_WRITE_URL` in the private client env file at the local forwarded port, with `TRANSCRIPTS_POSTGRES_SSL=false` because SSH is the encrypted transport;
- verify the writer with a real insert and verify the committed state independently through the reader before enabling automatic delivery.
- run `npm run acceptance:postgres:canary` and require both privilege attestation and exact independent readback before using PostgreSQL records as acceptance authority.

On Windows, first enroll and verify the server host key in the user's `known_hosts`, then install the repository-managed Scheduled Task (replace the SSH target and remote PostgreSQL port):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\postgres\install-transcript-postgres-tunnel.ps1 `
  -SshDestination user@server `
  -LocalPort 55434 `
  -RemoteHost 127.0.0.1 `
  -RemotePort 5432
```

The installer registers `TechPersistence-TranscriptPostgresTunnel` for the current interactive user, starts it immediately and at logon, retries once per minute, and ignores duplicate instances. The Scheduled Task action executes `ssh.exe` directly with the complete hardened argument set; it does not launch SSH as a PowerShell child. This ownership is required so `Stop-ScheduledTask` can reclaim the forwarding process instead of leaving an orphaned SSH tunnel. The action requires strict host-key checking and public-key/agent authentication, disables password and keyboard-interactive authentication, fails if forwarding cannot be established, and uses SSH keepalives.

`start-transcript-postgres-tunnel.ps1` applies the same SSH policy only for foreground diagnosis. The Scheduled Task does not call it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\postgres\start-transcript-postgres-tunnel.ps1 `
  -SshDestination user@server `
  -LocalPort 55434 `
  -RemoteHost 127.0.0.1 `
  -RemotePort 5432
```

Inspect the task with `Get-ScheduledTask -TaskName TechPersistence-TranscriptPostgresTunnel`. For a recovery drill, stop and restart that exact task with `Stop-ScheduledTask` and `Start-ScheduledTask`, then confirm that the old SSH process is gone before accepting the replacement listener. The transcript worker owns database retry and reconciliation; the tunnel is a separately managed prerequisite. If it is down, jobs remain durable and the worker keeps retrying. Do not treat a running task or listening local port as proof of readiness—a real PostgreSQL query and independent reader readback are required.

Before deploying, verify server free space, inode headroom, backup/retention policy, and rollback capacity. `prepare`/`up` fail closed at the startup thresholds above; do not bypass them on a server.

## Sync modes

```powershell
npm run transcripts:sync
npm run transcripts:backfill
npm run transcripts:watch

node scripts/sync-codex-transcripts.js --file C:\path\below\.codex\sessions\rollout.jsonl `
  --sessions-root C:\Users\you\.codex\sessions `
  --env-file C:\path\to\private-transcripts.env
```

- Default mode drains `~/.codex/transcript-outbox` once.
- `--all` discovers all plain `.jsonl` files below the trusted sessions root. The automatic worker additionally passes its first-configuration `--reconcile-after` baseline; an explicit `--all` without that option remains a true historical backfill.
- `--file` syncs one explicit file below that root.
- `--watch` runs the leased automatic worker; `--watch-seconds N` changes its poll interval.
- `--reconcile-seconds N` changes the full-session reconciliation interval.
- `--dry-run` parses and projects without opening PostgreSQL.
- `--keep-jobs` verifies writes but retains outbox jobs.

The cursor uses Codex `ordinal` when present and a 1-based physical line position for legacy files. The physical transcript ID comes from `session_meta.payload.id`; the root session and parent thread are stored separately. A growing transcript is read only through its observed snapshot size, and a trailing partial JSON line remains pending for the next pass.

## Integrity and privacy boundaries

- Event inserts are parameterized and `ON CONFLICT DO NOTHING`; an existing position with a different raw/projection hash fails closed instead of being overwritten.
- Resume requires the same file identity, an untruncated cursor, and the previous event anchor. A transaction-level advisory lock serializes writers for one transcript.
- The writer can insert transcript/event rows and update only transcript cursor/evidence columns. It cannot update events or delete either table. The reader is read-only.
- v1 outbox jobs retain their complete queued-prefix hash contract. v2 moves O(n) reads out of the time-bounded hook; before acknowledgement, the worker recomputes the complete source event/projection chains and requires them to match the synchronized PostgreSQL evidence, in addition to file identity and observed snapshot coverage.
- Stored `event_json` omits system/developer instructions, reasoning, encrypted content, and world-state internals, then applies the shared credential redactor. Raw JSONL files remain under Codex control and are never copied into the outbox.

The projection intentionally contains ordinary user/assistant messages and tool events. Treat the server database as sensitive data. Deleting an outbox job or source JSONL does not delete PostgreSQL rows; retention and deletion are explicit operator actions.

## Recovery

- If PostgreSQL or the tunnel is unavailable, leave the worker running. It retains jobs and retries automatically.
- If the worker was not running, the next `SessionEnd` starts it; its first reconciliation also recovers eligible sessions updated since the activation baseline. Pre-activation history requires the explicit backfill command and a separate capacity gate.
- If a data directory exists but a Docker secret is missing, restore the original secret or perform an explicit database recovery. The runtime will not silently rotate it.
- If an older checkout stored PGDATA under `deploy/postgres/data`, stop PostgreSQL and perform an explicit verified move/restore into the stable directory before changing the bind mount. Never point a fresh stable directory at old credentials and call that a migration.
- `node scripts/transcript-postgres-runtime.js down` stops the local container/network but preserves bind-mounted data and private credentials.
- Before treating a changed projection/redaction version as compatible, use an explicit migration or rebuild path; incremental sync fails closed across version changes.
