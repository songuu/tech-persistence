---
title: "Codex Memory v5 lightweight auto memory"
date: 2026-04-24
tags: [solution, memory, codex, hooks]
related_instincts: []
aliases: ["Codex memory v5", "MEMORY.md startup index", "hook memory topic files"]
---

# Codex Memory v5 lightweight auto memory

## Problem

Codex had observations, instincts, and session summaries, but no lightweight startup memory layer similar to Claude Code auto memory. SessionStart had to choose between injecting coarse instinct lists and recent sessions, which either missed reusable facts or consumed too much context.

## Root Cause

The v4 pipeline treated all persistent knowledge as either raw observations or higher-level instincts. It lacked a middle layer for durable, concise, future-useful notes such as verified commands, debugging recoveries, and toolchain patterns. Hook payload parsing was also too narrow for Codex-style tool events, and new hook libraries were not part of the install/build copy path.

## Solution

Add Memory v5 as a deterministic file-based layer:

- `observe.js` writes a v5 schema with normalized tool name, redacted summaries, command family, status, and input paths.
- `evaluate-session.js` writes `projects/{hash}/memory/MEMORY.md` plus topic files such as `debugging.md` and `toolchain.md`.
- `MEMORY.md` is capped to a startup index budget (`<200` lines / `25KB`); detailed evidence stays in topic files.
- `inject-context.js` loads only `MEMORY.md` during SessionStart, then falls back to sessions and instincts.
- `build-codex-plugin.js`, `install.sh`, and `install.ps1` copy `scripts/lib/` so hook dependencies travel with the runtime.
- `evaluate-session.js` only auto-checkpoints under context pressure thresholds, preventing short smoke tests from writing sprint handoff files.

## Prevention

When adding shared hook dependencies, update three places together: source scripts, Codex plugin build copy list, and installer hook copy logic. Then run a smoke test with a temporary `TECH_PERSISTENCE_HOME` and assert that `MEMORY.md` is injected while no repository handoff files are created.

## Related

- [[2026-04-24-codex-memory-v5]] — implementation plan
- [[ADR-002]] — Memory v5 architecture decision
