# Hook Exit Codes

Hook and tool scripts must use exit codes intentionally, because the same
script may run from Claude Code hooks, Codex plugin hooks, CI, or a manual
terminal.

## Semantics

| Code | Meaning | Use when |
|------|---------|----------|
| 0 | success or graceful fail-open | The hook completed, skipped, or hit a recoverable local error that must not block the host runtime |
| 1 | non-blocking actionable error | A manual CLI or diagnostic found a problem and the caller should see failure, but no user workflow should be forcibly blocked |
| 2 | blocking policy/usage error | A validator intentionally rejects the operation, or CLI usage is invalid |

## Rules

- Runtime hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`) default to exit 0 on internal errors.
- Fail-open hooks must write one stderr marker such as `[observe] hook failed: ...`; silent `catch {}` is not allowed.
- Blocking exit 2 is reserved for explicit validators such as pre-commit checks, security scans, or malformed CLI usage.
- Do not introduce raw `process.exit(1)` inside hook catch blocks; use code 0 with a marker unless the script is intentionally a validator.
- If a script has both hook mode and CLI mode, branch the exit policy by mode and document it near `main()`.

## Dogfood Check

Before changing hook exit behavior, run:

```bash
node scripts/run-tests.js --grep "hook|inject|observe"
node scripts/pre-commit-check.js
```
