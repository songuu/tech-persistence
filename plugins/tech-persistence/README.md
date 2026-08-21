# Tech Persistence for Codex

Tech Persistence brings the full self-evolving engineering workflow system to Codex as a native plugin package.

It includes:

- Frozen Claude-compatible command, skill, and legacy hook sources; they are not the active Codex runtime projection.
- Codex-specific skills for the six core phases plus provider-boundary overrides for memory, continuous learning, and caveman.
- Native governed Codex hooks: bounded SessionStart context, exact PreToolUse handoff guard, and synchronous UserPromptSubmit/PreToolUse/PostToolUse/Stop behavior receipts using integer-second timeouts.
- Agent Loop v7 assets: the v6 external orchestrator, JSON schemas, `$agent-loop` wrapper, and the Caveman compression skill family.
- Caveman skills for terse output, commit messages, review comments, help, and memory-file compression.
- Obsidian-compatible knowledge storage under `~/.codex/homunculus`, or a shared `homunculusHome` configured in `~/.tech-persistence/config.json`.

## Codex invocation

The plugin-native entry is `$skill` or the `@` picker. The repository user installer also installs thin `/think`, `/plan`, `/work`, `/review`, `/compound`, and `/sprint` compatibility entries that route to the same Codex-native skills. Use `$agent-loop`, `$prototype`, `$caveman`, and other non-core workflows as skills.

## Agent Loop v7

For multi-agent work, run the neutral orchestrator instead of relying on either agent to understand the other:

```powershell
node scripts/agent-orchestrator.js run --requirement "request"
node scripts/agent-orchestrator.js freeze --run <runId>
node scripts/agent-orchestrator.js resume --run <runId> --validation-command "npm test"

# Split the implementation/review gate when you want to inspect the diff before review
node scripts/agent-orchestrator.js resume --run <runId> --no-review
node scripts/agent-orchestrator.js resume --run <runId> --review-only

# Local checks
node scripts/agent-orchestrator.js doctor
node scripts/agent-orchestrator.js self-test
node scripts/agent-orchestrator.js status --run latest
```

The orchestrator stores each run in `.agent-runs/<runId>/` with `spec.json`/`spec.raw.json`, `requirement-spec.md`, `technical-design.md`, `task-breakdown.json`, `changed-files.json`, `diff.patch`, `review-context.md`, `validation.json`, `handoff.{md,json}`, `review.{json,raw.json}`, `preflight.json`, `follow-up-task.md`, plus per-provider `prompts/*.md` and timestamped `logs/*.<stamp>.{stdout,stderr}.log`. JSON parse failures are captured as `*.parse-error.json` instead of being silently dropped.

Use `$caveman`, `$caveman-commit`, `$caveman-review`, `$caveman-help`, and `$caveman-compress <file>` for v7 compression features. The `$caveman` skill supports intensities `lite|full|ultra|wenyan|wenyan-lite|wenyan-ultra` (bare `wenyan` is alias for `wenyan-full`). Codex never auto-activates caveman on SessionStart; the current user must request it explicitly. `CAVEMAN_DEFAULT_MODE` and `~/.config/caveman/config.json` remain Claude legacy startup controls.

The repository `commands/` directory is the frozen Claude compatibility source and is excluded from the installed Codex plugin. Codex thin core `/command` entries come from `codex-native/commands/`; plugin-native workflows come from `codex-skills/`.

Build the generated plugin contents from the shared Claude/Codex source files:

```powershell
node plugins/tech-persistence/scripts/build-codex-plugin.js
```

Validate the package structure:

```powershell
node scripts/validate-codex-plugin.js
```

## Sharing with Claude Code

Codex defaults to `~/.codex/homunculus` and Claude Code defaults to `~/.claude/homunculus`. To make both agents learn from the same knowledge base, configure a shared homunculus directory:

```powershell
node scripts\configure-shared-homunculus.js --path "C:\Users\you\Documents\TechPersistence"
```

```bash
node scripts/configure-shared-homunculus.js --path ~/Documents/TechPersistence
```

Use that directory as your Obsidian vault. `--import-claude` is still available for one-time migration, but the shared config is the recommended ongoing sync mode.

When no shared directory is configured, the two runtimes keep separate default write locations. Claude legacy SessionStart may merge the compatible Memory stores under its frozen hook contract. Codex SessionStart does not scan or inject Memory; Codex reads shared or local knowledge on demand through skills/MCP. Current native Codex UserPromptSubmit/PreToolUse/PostToolUse/Stop hooks append governed behavior receipts, but never auto-promote or edit shared runtime assets.

Explicit native user controls use a fixed prefix followed by exact canonical JSON, for example:

```text
TP_SELF_LEARNING_CONTROL_V1:{"accepted":true,"action":"approve","candidate_hash":"sha256:<64 lowercase hex>","candidate_id":"lc-<32 lowercase hex>"}
```

The full UTF-8 prompt is bounded to 4096 bytes. Approval requires the live `shadow` candidate and its current candidate hash, checked in the same journal transaction/lock that appends the receipt. Receipt authority binds only native `session_id`, `turn_id`, and the `UserPromptSubmit` hook; prompt/control semantics are protected content, never identity. An exact same-turn replay is a no-op, while any same-turn summary, action, approval, or ordinary/control classification change conflicts without appending a second event. Ordinary prose stays `user.prompt`, invalid prefixed controls fail closed with code-only diagnostics, and generic Agent/MCP/CLI input cannot mint this native user authority. Capturing the approval event does not itself run `approve` or `promote`.
