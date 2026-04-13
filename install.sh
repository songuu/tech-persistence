#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Claude Code 技术沉淀系统 v2 — 安装脚本（自学习增强版）
#
# 用法:
#   bash install.sh --user       安装用户级别配置
#   bash install.sh --project    在当前项目安装项目级别配置
#   bash install.sh --all        同时安装两者
#   bash install.sh --hooks-only 只安装 Hook 脚本（已有 v1 升级用）
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${HOME}/.claude"
HOMUNCULUS_DIR="${CLAUDE_HOME}/homunculus"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_ok()    { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_section() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}\n"; }

safe_copy() {
  local src="$1" dst="$2"
  if [[ -f "$dst" ]]; then
    log_warn "$(basename "$dst") 已存在，创建备份"
    cp "$dst" "${dst}.bak.$(date +%Y%m%d%H%M)"
  fi
  cp "$src" "$dst"
}

safe_copy_no_overwrite() {
  local src="$1" dst="$2"
  if [[ -f "$dst" ]]; then
    log_warn "$(basename "$dst") 已存在，跳过（请手动合并）"
    return
  fi
  cp "$src" "$dst"
}

# ──────────────────────────────────────────────
# 安装自学习 Hook 脚本
# ──────────────────────────────────────────────
install_hooks() {
  log_section "安装自学习 Hook 脚本"

  local hooks_dir="${CLAUDE_HOME}/skills/continuous-learning/hooks"
  mkdir -p "$hooks_dir"

  cp "${SCRIPT_DIR}/scripts/observe.js" "$hooks_dir/observe.js"
  log_ok "observe.js → PreToolUse/PostToolUse 观察捕获"

  cp "${SCRIPT_DIR}/scripts/evaluate-session.js" "$hooks_dir/evaluate-session.js"
  log_ok "evaluate-session.js → Stop 会话评估 + 本能提取"

  cp "${SCRIPT_DIR}/scripts/inject-context.js" "$hooks_dir/inject-context.js"
  log_ok "inject-context.js → SessionStart 上下文注入"

  chmod +x "$hooks_dir"/*.js
}

# ──────────────────────────────────────────────
# 安装 Homunculus 目录结构
# ──────────────────────────────────────────────
install_homunculus() {
  log_section "初始化 Homunculus 知识存储"

  mkdir -p "${HOMUNCULUS_DIR}/instincts/personal"
  mkdir -p "${HOMUNCULUS_DIR}/instincts/inherited"
  mkdir -p "${HOMUNCULUS_DIR}/evolved/skills"
  mkdir -p "${HOMUNCULUS_DIR}/evolved/commands"
  mkdir -p "${HOMUNCULUS_DIR}/evolved/agents"
  mkdir -p "${HOMUNCULUS_DIR}/projects"
  # v4: Skill 自迭代相关目录
  mkdir -p "${HOMUNCULUS_DIR}/skill-signals"
  mkdir -p "${HOMUNCULUS_DIR}/skill-evals"
  mkdir -p "${HOMUNCULUS_DIR}/skill-changelog"

  # 默认配置
  if [[ ! -f "${HOMUNCULUS_DIR}/config.json" ]]; then
    cp "${SCRIPT_DIR}/user-level/homunculus/config.json" "${HOMUNCULUS_DIR}/config.json"
    log_ok "config.json — 自学习系统配置"
  else
    log_warn "config.json 已存在，保留现有配置"
  fi

  # 项目注册表
  if [[ ! -f "${HOMUNCULUS_DIR}/projects.json" ]]; then
    echo '{}' > "${HOMUNCULUS_DIR}/projects.json"
    log_ok "projects.json — 项目注册表"
  fi

  log_ok "Homunculus 目录结构就绪"
}

# ──────────────────────────────────────────────
# 安装用户级别配置
# ──────────────────────────────────────────────
install_user() {
  log_section "安装用户级别配置 → ${CLAUDE_HOME}/"

  mkdir -p "${CLAUDE_HOME}/commands"
  mkdir -p "${CLAUDE_HOME}/rules"
  mkdir -p "${CLAUDE_HOME}/skills/memory"
  mkdir -p "${CLAUDE_HOME}/skills/continuous-learning"
  mkdir -p "${CLAUDE_HOME}/skills/prototype-workflow"

  # CLAUDE.md
  safe_copy_no_overwrite "${SCRIPT_DIR}/user-level/CLAUDE.md" "${CLAUDE_HOME}/CLAUDE.md"
  [[ -f "${CLAUDE_HOME}/CLAUDE.md" ]] && log_ok "~/.claude/CLAUDE.md"

  # Commands (覆盖安装)
  # 学习层命令（user-level/commands/）
  local cmds=(
    learn.md review-learnings.md session-summary.md
    instinct-status.md evolve.md instinct-export.md instinct-import.md
    # v4: Skill 自迭代闭环
    skill-diagnose.md skill-improve.md skill-eval.md skill-publish.md
  )
  for cmd in "${cmds[@]}"; do
    if [[ -f "${SCRIPT_DIR}/user-level/commands/${cmd}" ]]; then
      safe_copy "${SCRIPT_DIR}/user-level/commands/${cmd}" "${CLAUDE_HOME}/commands/${cmd}"
      log_ok "命令 /${cmd%.md}"
    fi
  done

  # 工作流层命令（user-commands/）
  local workflow_cmds=(think.md plan.md work.md review.md compound.md sprint.md prototype.md)
  for cmd in "${workflow_cmds[@]}"; do
    if [[ -f "${SCRIPT_DIR}/user-commands/${cmd}" ]]; then
      safe_copy "${SCRIPT_DIR}/user-commands/${cmd}" "${CLAUDE_HOME}/commands/${cmd}"
      log_ok "工作流 /${cmd%.md}"
    fi
  done

  # Rules
  safe_copy_no_overwrite "${SCRIPT_DIR}/user-level/rules/general-standards.md" "${CLAUDE_HOME}/rules/general-standards.md"

  # Skills
  cp "${SCRIPT_DIR}/user-level/skills/memory/SKILL.md" "${CLAUDE_HOME}/skills/memory/SKILL.md"
  cp "${SCRIPT_DIR}/user-level/skills/continuous-learning/SKILL.md" "${CLAUDE_HOME}/skills/continuous-learning/SKILL.md"
  if [[ -f "${SCRIPT_DIR}/user-level/skills/prototype-workflow/SKILL.md" ]]; then
    cp "${SCRIPT_DIR}/user-level/skills/prototype-workflow/SKILL.md" "${CLAUDE_HOME}/skills/prototype-workflow/SKILL.md"
  fi
  log_ok "技能 memory + continuous-learning + prototype-workflow"

  # Hooks
  install_hooks

  # Homunculus
  install_homunculus

  # 用户级 settings.json 中添加 hooks（如果尚未配置）
  local user_settings="${CLAUDE_HOME}/settings.json"
  if [[ -f "$user_settings" ]]; then
    if grep -q "observe.js" "$user_settings" 2>/dev/null; then
      log_warn "settings.json 已包含 Hook 配置，跳过"
    else
      log_warn "settings.json 已存在但无 Hook 配置"
      echo ""
      echo "  请手动将以下 hooks 添加到 ${user_settings}:"
      echo '  参考: project-level/.claude/settings.json 中的 hooks 配置'
      echo ""
    fi
  else
    cp "${SCRIPT_DIR}/project-level/.claude/settings.json" "$user_settings"
    log_ok "settings.json (含 4 Hook 配置)"
    log_info "Hook 配置已写入用户级 settings.json，所有项目通用"
  fi

  echo ""
  log_ok "用户级别安装完成！"
  echo ""
  echo "  已安装:"
  echo "    学习层:  /learn /review-learnings /session-summary"
  echo "             /instinct-status /evolve /instinct-export /instinct-import"
  echo "    工作流:  /think /plan /work /review /compound /sprint /prototype"
  echo "    Skill自迭代: /skill-diagnose /skill-improve /skill-eval /skill-publish"
  echo "    技能:    memory, continuous-learning, prototype-workflow"
  echo "    Hook:    SessionStart, PreToolUse, PostToolUse, Stop"
  echo "    存储:    ~/.claude/homunculus/ (含 skill-signals/evals/changelog)"
  echo ""
  echo "  下一步:"
  echo "    1. 编辑 ~/.claude/CLAUDE.md 填写个人信息"
  echo "    2. 重启 Claude Code"
  echo "    3. 正常开发 — 系统会自动观察和学习"
  echo "    4. 定期 /instinct-status 查看学习成果"
  echo ""
}

# ──────────────────────────────────────────────
# 安装项目级别配置
# ──────────────────────────────────────────────
install_project() {
  local project_root="${PWD}"
  local claude_dir="${project_root}/.claude"

  log_section "安装项目级别配置 → ${claude_dir}/"

  if git rev-parse --is-inside-work-tree &>/dev/null; then
    log_ok "检测到 Git 仓库"
  else
    log_warn "当前目录不是 Git 仓库"
    read -p "  继续? (y/N) " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] || { log_info "已取消"; exit 0; }
  fi

  mkdir -p "${claude_dir}/commands"
  mkdir -p "${claude_dir}/rules"
  mkdir -p "${claude_dir}/skills/session-learning"
  mkdir -p "${project_root}/docs/tech-learnings/sessions"

  # CLAUDE.md
  safe_copy_no_overwrite "${SCRIPT_DIR}/project-level/CLAUDE.md" "${project_root}/CLAUDE.md"

  # settings.json
  if [[ -f "${claude_dir}/settings.json" ]]; then
    if grep -q "observe.js" "${claude_dir}/settings.json" 2>/dev/null; then
      log_warn ".claude/settings.json 已包含 Hook 配置，跳过"
    else
      log_warn ".claude/settings.json 已存在但无 Hook 配置"
      echo "  请参考 project-level/.claude/settings.json 手动合并 hooks"
    fi
  else
    cp "${SCRIPT_DIR}/project-level/.claude/settings.json" "${claude_dir}/settings.json"
    log_ok ".claude/settings.json (含 4 Hook 配置)"
  fi

  # Commands
  local cmds=(learn.md retrospective.md debug-journal.md)
  for cmd in "${cmds[@]}"; do
    safe_copy "${SCRIPT_DIR}/project-level/.claude/commands/${cmd}" "${claude_dir}/commands/${cmd}"
    log_ok "命令 /${cmd%.md}"
  done

  # Rules
  local rules=(architecture.md debugging-gotchas.md performance.md testing-patterns.md api-conventions.md)
  for rule in "${rules[@]}"; do
    safe_copy_no_overwrite "${SCRIPT_DIR}/project-level/.claude/rules/${rule}" "${claude_dir}/rules/${rule}"
  done
  log_ok "规则模板 (${#rules[@]} 个领域)"

  # 确保用户级 Hook 脚本存在
  local hooks_dir="${CLAUDE_HOME}/skills/continuous-learning/hooks"
  if [[ ! -f "${hooks_dir}/observe.js" ]]; then
    log_warn "用户级 Hook 脚本未安装，正在安装..."
    install_hooks
    install_homunculus
  fi

  echo ""
  log_ok "项目级别安装完成！"
  echo ""
  echo "  已安装:"
  echo "    命令:  /learn /retrospective /debug-journal"
  echo "    规则:  architecture, debugging, performance, testing, api"
  echo "    Hook:  通过 .claude/settings.json 或用户级配置生效"
  echo ""
  echo "  提交到 Git:"
  echo "    git add CLAUDE.md .claude/"
  echo "    git commit -m 'chore: 添加 Claude Code 技术沉淀 + 自学习系统'"
  echo ""
  echo "  下一步:"
  echo "    1. 编辑 CLAUDE.md 填写项目信息"
  echo "    2. 重启 Claude Code — Hook 自动生效"
  echo "    3. 正常开发 — 系统自动观察和学习"
  echo ""
}

# ──────────────────────────────────────────────
# 主入口
# ──────────────────────────────────────────────
show_help() {
  echo "Claude Code 技术沉淀系统 v2 — 自学习增强版"
  echo ""
  echo "用法:"
  echo "  bash install.sh --user        安装用户级别 (→ ~/.claude/)"
  echo "  bash install.sh --project     安装项目级别 (→ .claude/)"
  echo "  bash install.sh --all         同时安装两者"
  echo "  bash install.sh --hooks-only  只安装/更新 Hook 脚本"
  echo "  bash install.sh --obsidian    初始化 Obsidian Vault 集成"
  echo "  bash install.sh --help        显示帮助"
  echo ""
  echo "v2 新增能力:"
  echo "  • 4 Hook 自动观察 (PreToolUse/PostToolUse/Stop/SessionStart)"
  echo "  • 原子化本能系统 (置信度 0.3-0.9，自动衰减)"
  echo "  • 本能进化 (/evolve → skill/command/agent)"
  echo "  • 项目自动隔离 (git remote hash)"
  echo "  • 会话上下文自动注入"
}

# ──────────────────────────────────────────────
# Obsidian Vault 集成（可选）
# ──────────────────────────────────────────────
install_obsidian() {
  log_section "Obsidian Vault 集成"

  local vault_path="${HOMUNCULUS_DIR}"

  if [[ -n "${1:-}" ]]; then
    vault_path="$1"
  fi

  # 运行 vault 初始化脚本
  node "${SCRIPT_DIR}/scripts/init-obsidian-vault.js" --vault-path "$vault_path"

  # 输出 MCP 配置指引
  local mcp_snippet="${vault_path}/_mcp-config-snippet.json"
  if [[ -f "$mcp_snippet" ]]; then
    echo ""
    log_info "将以下 MCP 配置合并到 ~/.claude/settings.json:"
    echo ""
    cat "$mcp_snippet"
    echo ""
  fi

  log_ok "Obsidian 集成完成"
  echo ""
  echo "  下一步:"
  echo "    1. 用 Obsidian 打开 vault: $vault_path"
  echo "    2. 安装推荐插件: Dataview, Templater, Graph Analysis"
  echo "    3. 将 _mcp-config-snippet.json 合并到 ~/.claude/settings.json"
  echo ""
}

case "${1:-}" in
  --user)
    install_user
    ;;
  --project)
    install_project
    ;;
  --all)
    install_user
    echo ""
    install_project
    ;;
  --hooks-only)
    install_hooks
    install_homunculus
    log_ok "Hook 脚本已更新"
    ;;
  --obsidian)
    install_obsidian "${2:-}"
    ;;
  --help|-h)
    show_help
    ;;
  *)
    show_help
    exit 1
    ;;
esac
