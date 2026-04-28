# Tech Persistence for Codex

Tech Persistence brings the full self-evolving engineering workflow system to Codex as a native plugin package.

It includes:

- Claude-compatible command workflow files for planning, work, review, testing, learning, instincts, sprinting, and handoff.
- Codex skills for memory, continuous learning, prototype workflow, test strategy, context handoff, and one skill wrapper per command.
- Runtime-aware hooks for context injection, observation capture, and session evaluation.
- Agent Loop v6 assets: an external orchestrator, JSON schemas, and `$agent-loop` command wrapper for frozen-spec multi-agent work.
- Obsidian-compatible knowledge storage under `~/.codex/homunculus`, or a shared `homunculusHome` configured in `~/.tech-persistence/config.json`.

## Codex invocation

Codex CLI currently exposes custom plugin workflows through skills, not through TUI slash commands. Use `$sprint <request>`, `$agent-loop <request>`, `$prototype <request>`, `$plan <request>`, or pick the skill with `@`.

## Agent Loop v6

For multi-agent work, run the neutral orchestrator instead of relying on either agent to understand the other:

```powershell
node scripts/agent-orchestrator.js run --requirement "request"
node scripts/agent-orchestrator.js freeze --run <runId>
node scripts/agent-orchestrator.js resume --run <runId> --validation-command "npm test"
```

The orchestrator stores each run in `.agent-runs/<runId>/` with spec, design, tasks, diff, validation, handoff, review, and follow-up task files.

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
