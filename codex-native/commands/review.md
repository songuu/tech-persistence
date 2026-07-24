---
description: "Codex-native review thin entry point"
---

# /review

Load exactly one installed Tech Persistence skill whose frontmatter name is
`review` (normally `$tech-persistence:review`) and follow it with the user's
remaining text as arguments.

Review is read-only unless the user also asks for fixes. Do not load the legacy
generated reviewer protocol or pre-spawn a fixed reviewer set.
