---
description: "Codex-native sprint thin entry point"
---

# /sprint

Load exactly one installed Tech Persistence skill whose frontmatter name is
`sprint` (normally `$tech-persistence:sprint`) and follow it with the user's
remaining text as arguments.

This is a stateful workflow, not a read-only-analysis prefix. For a normal
invocation, `missing-pointer` is a bootstrap trigger: create the plan and
active pointer before analysing the remaining text. Only an actual bootstrap
failure may stop there; report that failure, never a status-only conclusion.
Do not pre-read future phase skills or legacy sprint instructions. The selected
skill owns routing, active-pointer recovery, phase transitions, and completion.
