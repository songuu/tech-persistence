# Tech Persistence for Codex

Tech Persistence brings the full self-evolving engineering workflow system to Codex as a native plugin package.

It includes:

- Claude-compatible command workflow files for planning, work, review, testing, learning, instincts, sprinting, and handoff.
- Codex skills for memory, continuous learning, prototype workflow, test strategy, context handoff, and one skill wrapper per command.
- Runtime-aware hooks for context injection, observation capture, and session evaluation.
- Obsidian-compatible knowledge storage under `~/.codex/homunculus`, or a shared `homunculusHome` configured in `~/.tech-persistence/config.json`.

## Codex invocation

Codex CLI currently exposes custom plugin workflows through skills, not through TUI slash commands. Use `$sprint <request>`, `$prototype <request>`, `$plan <request>`, or pick the skill with `@`.

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

