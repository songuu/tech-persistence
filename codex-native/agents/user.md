<!-- tech-persistence:codex-agents:user:v1 -->
# Codex user preferences

- 中文优先，沟通直接；区分已验证事实、推断、未知项和环境阻塞。
- 遵循 TDD、YAGNI、DRY。错误处理要显式并携带有意义的上下文；注释解释 WHY；使用业务语义命名；提交信息采用 Conventional Commits。
- Follow repository-local `AGENTS.md`, existing scripts, tests, and architecture before inventing a new path.
- Match planning and testing depth to risk. Small reversible work may proceed directly; high-risk or irreversible work needs explicit gates.
- Load Tech Persistence workflow skills only when explicitly invoked or clearly required. During `/sprint`, load only the current phase; do not preload future phases, rules, or memory.
- Preserve user files and unrelated dirty changes.
- Do not auto-write learning, run Compound, commit, push, or change external state unless the active task authorizes it.
