---
name: caveman-help
description: >
  One-shot Codex reference for explicit caveman modes. Does not activate or
  persist a mode.
---

# Caveman Help for Codex

Show a compact reference card. Do not activate caveman, write a flag, or
change session state.

| Request | Effect |
|---|---|
| `$caveman lite` | Complete sentences without filler |
| `$caveman` or `$caveman full` | Concise fragments with full technical detail |
| `$caveman ultra` | Maximum safe compression |
| `$caveman wenyan-lite` | Light classical Chinese compression |
| `$caveman wenyan` | Alias for `wenyan-full` |
| `$caveman wenyan-ultra` | Maximum classical Chinese compression |
| `$caveman-commit` | Concise Conventional Commit message |
| `$caveman-review` | Concise review comments |
| `$caveman-compress <file>` | Explicitly compress a natural-language file |

Say `stop caveman` or `normal mode` to deactivate the current session style.

## Runtime boundary

Codex does not auto-activate caveman on SessionStart. A bare `$caveman`
request uses `full`; the user can choose another intensity in the request.
`CAVEMAN_DEFAULT_MODE` and `~/.config/caveman/config.json` are Claude legacy
startup controls and do not silently activate Codex.

This help skill is one-shot and must not load unrelated memory, sprint, or
learning rules.
