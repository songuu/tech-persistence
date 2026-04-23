# Tech Persistence for Codex

Tech Persistence brings the full self-evolving engineering workflow system to Codex as a native plugin package.

It includes:

- Slash-command workflows for planning, work, review, testing, learning, instincts, sprinting, and handoff.
- Codex skills for memory, continuous learning, prototype workflow, test strategy, and context handoff.
- Runtime-aware hooks for context injection, observation capture, and session evaluation.
- Obsidian-compatible knowledge storage under `~/.codex/homunculus`.

Build the generated plugin contents from the shared Claude/Codex source files:

```powershell
node plugins/tech-persistence/scripts/build-codex-plugin.js
```

Validate the package structure:

```powershell
node scripts/validate-codex-plugin.js
```

