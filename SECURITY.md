# Security

Tech Persistence is a local-first memory and workflow layer for Claude Code and
Codex. It favors deterministic markdown files, local hook scripts, and explicit
user-controlled sharing.

## Data Storage

- Project observations, memory, sessions, instincts, and local metrics are stored under the configured homunculus directory.
- The default location is `~/.claude/homunculus` for Claude-style runtimes and `~/.codex/homunculus` for Codex-style runtimes.
- `TECH_PERSISTENCE_HOME` can override the homunculus directory for tests or custom setups.
- Repository documents under `docs/`, `.claude/`, and `.codex/` are git-tracked only when you explicitly commit them.

## Telemetry

Tech Persistence does not send telemetry to a hosted Tech Persistence service.
Any telemetry written by this project is local file telemetry, such as aggregate
Memory v5 recall metrics. These metrics must not include prompt text, memory
entry bodies, tool outputs, secrets, or provider responses.

## Provider Caveat

Claude Code, Codex, and other AI runtimes may send prompts, tool outputs, or
conversation context to their own model providers according to their product
behavior and account settings. Tech Persistence does not change that provider
path; it only controls its own local hook capture and local files.

## Privacy Tags

Use privacy tags around content that should not be persisted by Tech Persistence
observations:

```text
<private>user-level sensitive content</private>
<system-private>system or policy-sensitive content</system-private>
<claude-mem-context>imported memory context</claude-mem-context>
```

The observation hook strips these blocks before writing `observations.jsonl`.
The markers are best-effort local protection, not a substitute for avoiding
secrets in prompts or shell commands.

## Secret Handling

- Do not paste API keys, passwords, private keys, or bearer tokens into prompts or commands.
- Run `node scripts/secret-scan-on-demand.js --paths <path>` before committing security-sensitive changes.
- If a secret is captured locally, rotate the secret first, then delete the affected local observation files.

## Reporting

For security issues, open a private report through the repository owner or use
the existing trusted project communication channel. Include reproduction steps,
affected files, and whether any local observation file captured sensitive data.
