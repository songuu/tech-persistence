# Tech Persistence for Codex

Tech Persistence brings the full self-evolving engineering workflow system to Codex as a native plugin package.

It includes:

- Claude-compatible command workflow files for planning, work, review, testing, learning, instincts, sprinting, and handoff.
- Codex skills for memory, continuous learning, prototype workflow, test strategy, context handoff, and one skill wrapper per command.
- Runtime-aware hooks for context injection, observation capture, and session evaluation.
- Agent Loop v7 assets: the v6 external orchestrator, JSON schemas, `$agent-loop` wrapper, and the Caveman compression skill family.
- Caveman skills for terse output, commit messages, review comments, help, and memory-file compression.
- Obsidian-compatible knowledge storage under `~/.codex/homunculus`, or a shared `homunculusHome` configured in `~/.tech-persistence/config.json`.

## Codex invocation

Codex CLI currently exposes custom plugin workflows through skills, not through TUI slash commands. Use `$sprint <request>`, `$agent-loop <request>`, `$prototype <request>`, `$plan <request>`, or pick the skill with `@`.

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

Use `$caveman`, `$caveman-commit`, `$caveman-review`, `$caveman-help`, and `$caveman-compress <file>` for v7 compression features. The `$caveman` skill supports intensities `lite|full|ultra|wenyan|wenyan-lite|wenyan-ultra` (bare `wenyan` is alias for `wenyan-full`). SessionStart hooks inject caveman mode unless `CAVEMAN_DEFAULT_MODE=off`; the env var or `~/.config/caveman/config.json` `defaultMode` controls cross-session behavior. Hook failures are written to stderr but never abort the session.

The `commands/` directory remains packaged for Claude compatibility and future Codex command support, but current Codex CLI sessions will reject `/sprint` and `/tech-persistence:sprint` as unknown slash commands.

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

When no shared directory is configured, SessionStart still merges Memory v5 topic notes from both default stores (`~/.claude/homunculus` and `~/.codex/homunculus`) before injecting context. That keeps Claude Code and Codex startup memory consistent while preserving their separate default write locations.
