# agent-loop v7 caveman 架构接入说明

日期：2026-04-30

适用范围：

- Tech Persistence Codex 插件：`plugins/tech-persistence/`
- Codex skills 分发：`user-level/skills/` -> `plugins/tech-persistence/skills/`
- SessionStart hooks：`plugins/tech-persistence/hooks.json`
- Agent Loop 编排器：`scripts/agent-orchestrator.js`

## 1. v7 定位

v7 不是替换 v6 external orchestrator。v6 的 provider adapter、structured output codec、contract normalizer、artifact manager、validation runner、state machine 仍然是 agent-loop 的执行架构。

v7 增加的是“语言压缩能力层”：

```text
Tech Persistence v7
  Knowledge layer: Memory v5 + instincts + skill signals
  Workflow layer: sprint / plan / work / review / compound
  Agent loop layer: v6 external orchestrator
  Compression layer: caveman skill family + auto activation + memory compression
```

执行权规则不变：

- 项目当前 runtime/skill 行为是活项目的执行真相。
- `JuliusBrussee/caveman` 是 v7 的上游功能基线和素材来源。
- 上游更新不会静默覆盖项目侧行为；需要显式 merge。

## 2. 上游 caveman 功能面

本次对齐的上游功能来自 `https://github.com/JuliusBrussee/caveman`：

- `caveman`: 输出 token 压缩模式，包含 lite/full/ultra/wenyan-lite/wenyan/wenyan-ultra。
- `caveman-commit`: Conventional Commits 精简生成。
- `caveman-review`: 一行式 review comment。
- `caveman-help`: caveman 工具帮助。
- `caveman-compress`: 对自然语言 memory 文件做压缩，保留 code blocks、URLs、paths、headings 等结构。
- `.codex/hooks.json`: SessionStart 自动注入 caveman 规则。

## 3. v7 接入设计

### 3.1 Skill Family

源头放在：

```text
user-level/skills/caveman/SKILL.md
user-level/skills/caveman-commit/SKILL.md
user-level/skills/caveman-review/SKILL.md
user-level/skills/caveman-help/SKILL.md
user-level/skills/caveman-compress/SKILL.md
user-level/skills/caveman-compress/scripts/*
```

生成到：

```text
plugins/tech-persistence/skills/*
.codex/skills/*
~/.codex/skills/*
```

`caveman-compress` 必须递归复制整个 skill 目录，不能只复制 `SKILL.md`，否则 Python scripts 丢失。

### 3.2 SessionStart Auto Activation

上游 caveman 用 `.codex/hooks.json` 在 SessionStart 输出规则。v7 接入为独立 hook：

```text
scripts/caveman-activate.js
plugins/tech-persistence/hooks/caveman-activate.js
```

hook 返回 Codex hook JSON：

```json
{
  "hookSpecificOutput": {
    "additionalContext": "<caveman-mode>...</caveman-mode>"
  }
}
```

这样不会破坏现有 `inject-context.js` 的 Memory v5 注入，也不会要求把 caveman 文本硬编码进 memory 层。

### 3.3 语言和安全约束

上游 caveman 默认英文示例较多。v7 必须保持本项目用户偏好：

- 用户中文提问，仍用中文。
- 代码、提交、PR、文档输出保持对应场景的正常格式。
- 安全警告、不可逆操作、多步骤容易误读时，临时退出 caveman terse style，完整说明风险。

### 3.4 分发链路

需要同时更新：

- `plugins/tech-persistence/scripts/build-codex-plugin.js`
- `scripts/validate-codex-plugin.js`
- `scripts/validate-codex-install.js`
- `install-codex.*` 使用 build 输出，无需额外复制逻辑，只要 build 产物完整。

## 4. 验收标准

```text
node plugins/tech-persistence/scripts/build-codex-plugin.js
node scripts/validate-codex-plugin.js
node scripts/agent-orchestrator.js self-test
python -m py_compile user-level/skills/caveman-compress/scripts/*.py
```

通过后应满足：

- `plugins/tech-persistence/skills/caveman*/SKILL.md` 存在。
- `plugins/tech-persistence/skills/caveman-compress/scripts/__main__.py` 存在。
- `plugins/tech-persistence/hooks/caveman-activate.js` 存在。
- `plugins/tech-persistence/hooks.json` 同时保留 Memory v5 hooks 和 caveman SessionStart hook。
- `scripts/agent-orchestrator.js self-test` 继续通过，证明 v7 没破坏 v6 编排器基础契约。

## 5. Attribution

`caveman` 上游项目由 Julius Brussee 维护，许可证为 MIT。v7 复制其 skill 文本、压缩脚本和相关规则时保留 license 副本：

```text
docs/vendor/caveman/LICENSE
docs/vendor/caveman/UPSTREAM.md
```
