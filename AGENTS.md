<!-- tech-persistence:codex-agents:project:v1 -->
# Project instructions for Codex

- Inspect the repository's real structure, scripts, tests, and local conventions before changing code; do not treat placeholder examples as facts.
- Keep changes minimal and scoped. Preserve unrelated work and user-owned files.
- Scale planning and verification to risk. Bug fixes need regression coverage; destructive or externally visible actions require an explicit gate.
- When using Tech Persistence `/sprint`, read only the active plan and current phase skill. Load rules, memory, design context, and later phases only when the current task requires them.
- Report completed work, actual verification, residual risks, and environment blockers separately.

<!-- tech-persistence:project-standards:start -->
## Project standards routing

- Architecture evidence and the exact managed inventory live in `.codex/project-standards.json`.
- Before architecture-sensitive work, Codex must read that manifest and the listed rules for the active profiles.
- Treat detected profiles as evidence, not as a substitute for inspecting real manifests, source layout, tests, and repository-local instructions.
- Use the project-local `project-standards` skill for a standards audit; `project-audit` is read-only and must not silently rewrite user-owned files.
<!-- tech-persistence:project-standards:end -->
