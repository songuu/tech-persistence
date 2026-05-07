---
title: "Memory v5 Claude/Codex parity"
date: 2026-05-07
tags: [solution, memory, codex, claude, hooks]
related_instincts: []
aliases: ["memory parity", "unified Memory v5 index"]
---

# Memory v5 Claude/Codex parity

## Problem

Memory v5 already produced durable topic files and a concise `MEMORY.md`, but Claude Code and Codex could still drift when they used their default stores. Claude wrote under `~/.claude/homunculus`, Codex wrote under `~/.codex/homunculus`, and SessionStart stopped at the first available `MEMORY.md`. A local runtime memory index could therefore hide durable notes learned by the other runtime.

## Root Cause

Two boundaries were too loose:

- Project identity was copied in `observe.js`, `inject-context.js`, and `evaluate-session.js`, so future changes could make the three hooks compute different project IDs.
- Memory index loading used first-hit fallback rather than a merged compatible read. This matched simple migration behavior, but not the parity requirement for two active runtimes.

## Solution

- Move project identity detection into `scripts/lib/memory-v5.js`.
- Move Memory v5 topic parsing, entry dedupe, sorting, and index formatting into the same helper.
- Change `inject-context.js` to call `loadUnifiedMemoryIndex()` over all compatible homunculus read dirs, so `~/.claude/homunculus` and `~/.codex/homunculus` are merged before startup context injection.
- Keep `evaluate-session.js` writing to the active runtime base dir, but make its `MEMORY.md` formatting use the shared helper.
- Add `scripts/smoke-memory-parity.js`, which creates temporary Claude and Codex default stores and verifies both runtimes inject both notes.
- Regenerate the Codex plugin hook bundle, validate the generated plugin includes the new helper behavior, and sync the user-level fallback/cache hook copies used by the local runtime.

## Prevention

For future memory changes, treat `scripts/lib/memory-v5.js` as the single source for project identity and Memory v5 index semantics. Any change to hook helper behavior must be followed by:

```powershell
node plugins\tech-persistence\scripts\build-codex-plugin.js
node scripts\smoke-memory-parity.js
node scripts\validate-codex-plugin.js
```

## Related

- [[2026-05-07-memory-parity]] — sprint implementation plan
- [[2026-04-24-codex-memory-v5]] — original Memory v5 implementation
- [[2026-04-23-homunculus-sharing]] — shared homunculus / Obsidian mode
