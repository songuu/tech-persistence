#!/usr/bin/env bash
# update.sh — 通用升级脚本
#
# 用法:
#   bash update.sh              升级到最新版本 (LATEST_VERSION)
#   bash update.sh <version>    升级到指定版本
#   bash update.sh list         列出所有可用版本
#   bash update.sh help         显示帮助
#
# 示例:
#   bash update.sh
#   bash update.sh v3.2
#   bash update.sh v3.1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${HOME}/.claude"

# ─── 版本定义 ───
LATEST_VERSION="v4"

# 可用版本列表（数组：name|desc）
VERSIONS=(
    "v3|工作流层 + 复利循环 (think/plan/work/review/compound/sprint)"
    "v3.1|Obsidian 集成 (frontmatter/wikilinks)"
    "v3.2|文档持久化工作流 (docs/plans/YYYY-MM-DD-<slug>.md)"
    "v4|Skill 自迭代闭环 (diagnose/improve/eval/publish + /prototype)"
)

# ─── 颜色输出 ───
if [[ -t 1 ]]; then
    GREEN=$'\033[32m'
    YELLOW=$'\033[33m'
    RED=$'\033[31m'
    CYAN=$'\033[36m'
    DIM=$'\033[2m'
    RESET=$'\033[0m'
else
    GREEN='' YELLOW='' RED='' CYAN='' DIM='' RESET=''
fi

log_ok()      { echo "  ${GREEN}[OK]${RESET} $1"; }
log_warn()    { echo "  ${YELLOW}[!!]${RESET} $1"; }
log_err()     { echo "  ${RED}[XX]${RESET} $1"; }
log_section() { echo ""; echo "${CYAN}=== $1 ===${RESET}"; echo ""; }

# 安全复制：目标存在时备份
safe_copy() {
    local src="$1"
    local dst="$2"

    if [[ -f "$dst" ]]; then
        local backup="${dst}.bak.$(date +%Y%m%d%H%M)"
        cp "$dst" "$backup"
        log_warn "$(basename "$dst") 已存在，备份到 $(basename "$backup")"
    fi
    cp "$src" "$dst"
}

show_help() {
    cat <<EOF

${CYAN}update.sh — 通用升级脚本${RESET}

用法:
  bash update.sh              升级到最新版本 (${LATEST_VERSION})
  bash update.sh <version>    升级到指定版本
  bash update.sh list         列出所有可用版本
  bash update.sh help         显示此帮助

示例:
  bash update.sh
  bash update.sh v3.2
  bash update.sh v3.1

EOF
}

show_version_list() {
    echo ""
    echo "${CYAN}可用版本:${RESET}"
    echo ""
    for entry in "${VERSIONS[@]}"; do
        local name="${entry%%|*}"
        local desc="${entry#*|}"
        local marker=""
        if [[ "$name" == "$LATEST_VERSION" ]]; then
            marker=" (latest)"
        fi
        printf "  %-6s%s — %s\n" "$name" "$marker" "$desc"
    done
    echo ""
}

test_claude_home() {
    if [[ ! -d "$CLAUDE_HOME" ]]; then
        log_err "未找到 ~/.claude 目录。请先运行 install.sh --all"
        exit 1
    fi

    if [[ ! -d "${CLAUDE_HOME}/commands" ]]; then
        mkdir -p "${CLAUDE_HOME}/commands"
        log_ok "创建 ~/.claude/commands/"
    fi
}

# 检查版本是否存在
is_known_version() {
    local target="$1"
    for entry in "${VERSIONS[@]}"; do
        local name="${entry%%|*}"
        if [[ "$name" == "$target" ]]; then
            return 0
        fi
    done
    return 1
}

# ─── 版本升级函数 ───

# v3: 工作流层 + 复利循环
upgrade_to_v3() {
    log_section "升级到 v3：工作流层 + 复利循环"

    local commands=(think.md plan.md work.md review.md compound.md sprint.md)
    for cmd in "${commands[@]}"; do
        local src="${SCRIPT_DIR}/user-commands/${cmd}"
        local dst="${CLAUDE_HOME}/commands/${cmd}"

        if [[ -f "$src" ]]; then
            safe_copy "$src" "$dst"
            log_ok "/${cmd%.md}"
        else
            log_warn "未找到 $src，跳过"
        fi
    done

    # CLAUDE.md 合并提示
    local claude_md_src="${SCRIPT_DIR}/CLAUDE.md"
    local claude_md_dst="${CLAUDE_HOME}/CLAUDE.md"
    if [[ -f "$claude_md_src" ]]; then
        if [[ -f "$claude_md_dst" ]]; then
            log_warn "~/.claude/CLAUDE.md 已存在，v3 的工程方法论未自动合并"
            echo "     ${CYAN}参考: $claude_md_src${RESET}"
        else
            cp "$claude_md_src" "$claude_md_dst"
            log_ok "CLAUDE.md (v3 版本)"
        fi
    fi

    log_ok "v3 升级完成"
}

# v3.1: Obsidian 集成
upgrade_to_v3_1() {
    log_section "升级到 v3.1：Obsidian 集成"

    echo "  ${CYAN}v3.1 的 Obsidian 集成主要是格式规范和 Vault 初始化：${RESET}"
    echo "  - 本能/会话/解决方案文档已使用 Obsidian 兼容的 frontmatter"
    echo "  - 如需初始化 Vault，请运行: bash install.sh --obsidian"
    echo ""
    log_ok "v3.1 升级完成"
}

# v4: Skill 自迭代闭环
upgrade_to_v4() {
    log_section "升级到 v4：Skill 自迭代闭环"

    # 1. 同步新的 skill 生命周期命令
    echo "  1/5 同步 Skill 自迭代命令到 ~/.claude/commands/"
    local skill_cmds=(skill-diagnose.md skill-improve.md skill-eval.md skill-publish.md)
    for cmd in "${skill_cmds[@]}"; do
        local src="${SCRIPT_DIR}/user-level/commands/${cmd}"
        local dst="${CLAUDE_HOME}/commands/${cmd}"

        if [[ -f "$src" ]]; then
            safe_copy "$src" "$dst"
            log_ok "/${cmd%.md}"
        else
            log_warn "未找到 $src，跳过"
        fi
    done

    # 2. 同步 /prototype 工作流命令
    echo ""
    echo "  2/5 同步 /prototype 命令到 ~/.claude/commands/"
    local proto_src="${SCRIPT_DIR}/user-commands/prototype.md"
    if [[ -f "$proto_src" ]]; then
        safe_copy "$proto_src" "${CLAUDE_HOME}/commands/prototype.md"
        log_ok "/prototype"
    fi

    # 3. 同步更新后的 /compound（含 skill 信号采集）和 /learn（轻量版）
    echo ""
    echo "  3/5 升级 /compound 和 /learn"
    if [[ -f "${SCRIPT_DIR}/user-commands/compound.md" ]]; then
        safe_copy "${SCRIPT_DIR}/user-commands/compound.md" "${CLAUDE_HOME}/commands/compound.md"
        log_ok "/compound (含 skill 使用信号采集)"
    fi
    if [[ -f "${SCRIPT_DIR}/user-level/commands/learn.md" ]]; then
        safe_copy "${SCRIPT_DIR}/user-level/commands/learn.md" "${CLAUDE_HOME}/commands/learn.md"
        log_ok "/learn (轻量版)"
    fi

    # 4. 安装 prototype-workflow skill
    echo ""
    echo "  4/5 安装 prototype-workflow skill"
    local proto_skill_dir="${CLAUDE_HOME}/skills/prototype-workflow"
    mkdir -p "$proto_skill_dir"
    local proto_skill_src="${SCRIPT_DIR}/user-level/skills/prototype-workflow/SKILL.md"
    if [[ -f "$proto_skill_src" ]]; then
        cp "$proto_skill_src" "${proto_skill_dir}/SKILL.md"
        log_ok "prototype-workflow skill"
    fi

    # 5. 创建 skill 自迭代相关的 homunculus 子目录
    echo ""
    echo "  5/5 初始化 skill-signals / skill-evals / skill-changelog 目录"
    mkdir -p "${HOME}/.claude/homunculus/skill-signals"
    mkdir -p "${HOME}/.claude/homunculus/skill-evals"
    mkdir -p "${HOME}/.claude/homunculus/skill-changelog"
    log_ok "~/.claude/homunculus/skill-signals/"
    log_ok "~/.claude/homunculus/skill-evals/"
    log_ok "~/.claude/homunculus/skill-changelog/"

    log_ok "v4 升级完成"
}

# v3.2: 文档持久化工作流
upgrade_to_v3_2() {
    log_section "升级到 v3.2：文档持久化工作流"

    # 1. 同步最新的 6 个工作流命令（含文档持久化指令）
    echo "  1/3 同步最新的工作流命令到 ~/.claude/commands/"
    local commands=(think.md plan.md work.md review.md compound.md sprint.md)
    for cmd in "${commands[@]}"; do
        local src="${SCRIPT_DIR}/user-commands/${cmd}"
        local dst="${CLAUDE_HOME}/commands/${cmd}"

        if [[ -f "$src" ]]; then
            safe_copy "$src" "$dst"
            log_ok "/${cmd%.md} (含文档持久化指令)"
        else
            log_warn "未找到 $src，跳过"
        fi
    done

    # 2. 初始化项目 docs/plans/ 目录
    echo ""
    echo "  2/3 初始化项目 docs/plans/ 目录"
    local project_root
    project_root="$(pwd)"
    local plans_dir="${project_root}/docs/plans"

    if [[ ! -d "$plans_dir" ]]; then
        mkdir -p "$plans_dir"
        log_ok "创建 ${plans_dir}"
    else
        log_ok "docs/plans/ 已存在"
    fi

    # 3. 复制 TEMPLATE.md 到项目
    echo ""
    echo "  3/3 复制文档模板到项目"
    local template_src="${SCRIPT_DIR}/docs/plans/TEMPLATE.md"
    local template_dst="${plans_dir}/TEMPLATE.md"

    if [[ ! -f "$template_src" ]]; then
        log_err "源模板不存在: $template_src"
        log_err "请确保在 tech-persistence 项目根目录运行此脚本"
        return
    fi

    # 如果当前项目就是 tech-persistence 本身，源和目标相同，跳过
    local template_src_abs
    template_src_abs="$(cd "$(dirname "$template_src")" && pwd)/$(basename "$template_src")"
    if [[ "$template_src_abs" == "$template_dst" ]]; then
        log_ok "当前项目就是 tech-persistence 本身，TEMPLATE.md 已就位"
    elif [[ -f "$template_dst" ]]; then
        log_warn "TEMPLATE.md 已存在，跳过（如需更新请手动替换）"
    else
        cp "$template_src" "$template_dst"
        log_ok "TEMPLATE.md → ${template_dst}"
    fi

    log_ok "v3.2 升级完成"
}

# ─── 主分发器 ───
invoke_update() {
    local target="${1:-}"

    # 规范化参数
    target="$(echo "$target" | tr '[:upper:]' '[:lower:]' | xargs)"

    # 处理特殊命令
    case "$target" in
        ""|"latest")
            target="$LATEST_VERSION"
            ;;
        "help"|"-h"|"--help")
            show_help
            exit 0
            ;;
        "list"|"-l"|"--list")
            show_version_list
            exit 0
            ;;
    esac

    # 补全简写
    if [[ "$target" == "v3.0" ]]; then
        target="v3"
    fi

    # 验证版本存在
    if ! is_known_version "$target"; then
        log_err "未知版本: $target"
        show_version_list
        exit 1
    fi

    # 检查环境
    test_claude_home

    echo ""
    echo "${CYAN}目标版本: $target${RESET}"
    if [[ "$target" == "$LATEST_VERSION" ]]; then
        echo "${DIM}(最新版本)${RESET}"
    fi

    # 分发到对应的升级函数
    case "$target" in
        "v3")   upgrade_to_v3 ;;
        "v3.1") upgrade_to_v3_1 ;;
        "v3.2") upgrade_to_v3_2 ;;
        "v4")   upgrade_to_v4 ;;
    esac

    # 完成提示
    echo ""
    echo "${GREEN}=== 升级完成 ===${RESET}"
    echo ""
    echo "当前已升级到: $target"
    echo ""
    if [[ "$target" == "v3.2" ]]; then
        echo "立即试用:"
        echo "  /sprint '你的需求描述'"
        echo "  /think '小型需求' (单阶段使用也会生成文档)"
        echo ""
        echo "新文档位置: docs/plans/"
        echo ""
    elif [[ "$target" == "v4" ]]; then
        echo "Skill 自迭代闭环（五层架构）："
        echo ""
        echo "  L1 信号采集: /compound 自动记录 skill 使用信号"
        echo "  L2 诊断:     /skill-diagnose [name]  — 步骤热力图 + 改进建议"
        echo "  L3 改进提案: /skill-improve [name]   — 基于数据生成修改提案"
        echo "  L4 验证:     /skill-eval [name] --diff — A/B 对比通过率"
        echo "  L5 发布:     /skill-publish [name]   — 备份 + changelog + 回滚"
        echo ""
        echo "配套新增: /prototype 原型多轮收敛 + prototype-workflow skill"
        echo "信号存储: ~/.claude/homunculus/skill-signals/"
        echo "测试集:   ~/.claude/homunculus/skill-evals/"
        echo ""
        echo "P0 起步（先让数据跑 1-2 个月）："
        echo "  正常使用 /compound，它会自动采集 skill 使用信号"
        echo "  一段时间后运行 /skill-diagnose 查看第一份诊断报告"
        echo ""
    fi
}

# ─── 入口 ───
invoke_update "${1:-}"
