#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${HOME}/.codex"
HOMUNCULUS_DIR="${CODEX_HOME}/homunculus"
AGENTS_PLUGINS_DIR="${HOME}/.agents/plugins"
REPO_AGENTS_PLUGINS_DIR="${SCRIPT_DIR}/.agents/plugins"
USER_PLUGINS_ROOT="${HOME}/plugins"
PLUGIN_NAME="tech-persistence"
PLUGIN_SOURCE="${SCRIPT_DIR}/plugins/${PLUGIN_NAME}"
PLUGIN_TARGET="${USER_PLUGINS_ROOT}/${PLUGIN_NAME}"

log_ok() { printf '  [OK] %s\n' "$1"; }
log_warn() { printf '  [!!] %s\n' "$1"; }
log_section() { printf '\n=== %s ===\n\n' "$1"; }

show_help() {
  cat <<'EOF'
Tech Persistence for Codex

Usage:
  bash install-codex.sh --user
  bash install-codex.sh --project
  bash install-codex.sh --all
  bash install-codex.sh --all --import-claude

Options:
  --user           Install the Codex plugin to ~/plugins/tech-persistence and register marketplace.json.
  --project        Create .codex project directories and project templates.
  --all            Run --user and --project.
  --import-claude  Copy ~/.claude/homunculus to ~/.codex/homunculus when the Codex target does not exist.
  --help           Show this help.
EOF
}

require_node() {
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  if [[ "$major" -lt 18 ]]; then
    echo "[FAIL] Node.js >= 18 required" >&2
    exit 1
  fi
}

build_plugin() {
  node "${PLUGIN_SOURCE}/scripts/build-codex-plugin.js"
}

copy_codex_text() {
  local src="$1" dst="$2" mode="${3:-overwrite}"
  mkdir -p "$(dirname "$dst")"
  node - "$src" "$dst" "$mode" <<'NODE'
const fs = require('fs');
const path = require('path');
const source = process.argv[2];
const target = process.argv[3];
const mode = process.argv[4] || 'overwrite';

function isGeneratedBroken(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  return /Codex\.md|\.Codex|~\/\.Codex|锛|銆|鏋|绛|璁|鍐|鐨|涓€/.test(text);
}

function backup(file) {
  fs.copyFileSync(file, `${file}.bak.${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`);
}

if (fs.existsSync(target)) {
  if (mode === 'no-overwrite' && !isGeneratedBroken(target)) {
    process.exit(0);
  }
  if (mode === 'backup' || mode === 'no-overwrite') {
    backup(target);
  }
}

let text = fs.readFileSync(source, 'utf8');
[
  [/~\/\.claude\/CLAUDE\.md/g, '~/.codex/AGENTS.md'],
  [/~\/\.claude\/homunculus/g, '~/.codex/homunculus'],
  [/CLAUDE_PROJECT_DIR/g, 'CODEX_PROJECT_DIR'],
  [/CLAUDE\.md/g, 'AGENTS.md'],
  [/\.claude\/commands/g, '.codex/commands'],
  [/\.claude\/skills/g, '.codex/skills'],
  [/\.claude\/rules/g, '.codex/rules'],
  [/\.claude\/plans/g, '.codex/plans'],
  [/\.claude/g, '.codex'],
  [/Claude Code/g, 'Codex'],
  [/Claude/g, 'Codex'],
].forEach(([pattern, replacement]) => {
  text = text.replace(pattern, replacement);
});
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, text);
NODE
}

copy_codex_commands() {
  local source_dir="$1" target_dir="$2" count=0
  [[ -d "$source_dir" ]] || { echo 0; return; }
  mkdir -p "$target_dir"
  for file in "$source_dir"/*.md; do
    [[ -f "$file" ]] || continue
    copy_codex_text "$file" "${target_dir}/$(basename "$file")" "backup"
    count=$((count + 1))
  done
  echo "$count"
}

copy_codex_rules() {
  local source_dir="$1" target_dir="$2" count=0
  [[ -d "$source_dir" ]] || { echo 0; return; }
  mkdir -p "$target_dir"
  for file in "$source_dir"/*.md; do
    [[ -f "$file" ]] || continue
    copy_codex_text "$file" "${target_dir}/$(basename "$file")" "no-overwrite"
    count=$((count + 1))
  done
  echo "$count"
}

copy_codex_skills() {
  local source_dir="$1" target_dir="$2" count=0
  [[ -d "$source_dir" ]] || { echo 0; return; }
  mkdir -p "$target_dir"
  for skill_dir in "$source_dir"/*; do
    [[ -f "${skill_dir}/SKILL.md" ]] || continue
    copy_codex_text "${skill_dir}/SKILL.md" "${target_dir}/$(basename "$skill_dir")/SKILL.md" "backup"
    count=$((count + 1))
  done
  echo "$count"
}

update_marketplace() {
  local marketplace_dir="$1" marketplace_name="$2" marketplace_display_name="$3"
  mkdir -p "$marketplace_dir"
  MARKETPLACE_PATH="${marketplace_dir}/marketplace.json" \
  MARKETPLACE_NAME="$marketplace_name" \
  MARKETPLACE_DISPLAY_NAME="$marketplace_display_name" node <<'NODE'
const fs = require('fs');
const path = require('path');
const marketplacePath = process.env.MARKETPLACE_PATH;
const pluginName = 'tech-persistence';
let root = {
  name: process.env.MARKETPLACE_NAME || 'local-plugins',
  interface: { displayName: process.env.MARKETPLACE_DISPLAY_NAME || 'Local Plugins' },
  plugins: [],
};

if (fs.existsSync(marketplacePath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    root.name = existing.name || root.name;
    root.interface = existing.interface || root.interface;
    root.plugins = Array.isArray(existing.plugins) ? existing.plugins : [];
  } catch {
    fs.copyFileSync(marketplacePath, `${marketplacePath}.bak.${Date.now()}`);
  }
}

root.plugins = root.plugins.filter((plugin) => plugin.name !== pluginName);
root.plugins.push({
  name: pluginName,
  source: {
    source: 'local',
    path: './plugins/tech-persistence',
  },
  policy: {
    installation: 'INSTALLED_BY_DEFAULT',
    authentication: 'ON_INSTALL',
  },
  category: 'Coding',
});

fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
fs.writeFileSync(marketplacePath, `${JSON.stringify(root, null, 2)}\n`);
NODE
  log_ok "marketplace.json registered ${PLUGIN_NAME}"
}

update_marketplaces() {
  update_marketplace "$AGENTS_PLUGINS_DIR" "local-plugins" "Local Plugins"
  update_marketplace "$REPO_AGENTS_PLUGINS_DIR" "tech-persistence-local" "Tech Persistence Local"
}

register_codex_marketplace() {
  if command -v codex >/dev/null 2>&1; then
    if codex plugin marketplace add "$SCRIPT_DIR"; then
      log_ok "codex marketplace registered: ${SCRIPT_DIR}"
    else
      log_warn "codex marketplace add failed; run manually: codex plugin marketplace add \"${SCRIPT_DIR}\""
    fi
  else
    log_warn "codex command not found; run later: codex plugin marketplace add \"${SCRIPT_DIR}\""
  fi
}

initialize_homunculus() {
  mkdir -p "${HOMUNCULUS_DIR}/instincts/personal"
  mkdir -p "${HOMUNCULUS_DIR}/instincts/inherited"
  mkdir -p "${HOMUNCULUS_DIR}/evolved/skills"
  mkdir -p "${HOMUNCULUS_DIR}/evolved/commands"
  mkdir -p "${HOMUNCULUS_DIR}/evolved/agents"
  mkdir -p "${HOMUNCULUS_DIR}/projects"
  mkdir -p "${HOMUNCULUS_DIR}/skill-signals"
  mkdir -p "${HOMUNCULUS_DIR}/skill-evals"
  mkdir -p "${HOMUNCULUS_DIR}/skill-changelog"

  if [[ ! -f "${HOMUNCULUS_DIR}/config.json" ]]; then
    cp "${PLUGIN_SOURCE}/codex-homunculus-template/config.json" "${HOMUNCULUS_DIR}/config.json"
    log_ok "homunculus config.json"
  fi
  [[ -f "${HOMUNCULUS_DIR}/projects.json" ]] || printf '{}\n' > "${HOMUNCULUS_DIR}/projects.json"
}

install_codex_user_assets() {
  log_section "Installing Codex user assets -> ${CODEX_HOME}"
  mkdir -p "${CODEX_HOME}/commands" "${CODEX_HOME}/rules" "${CODEX_HOME}/skills"

  copy_codex_text "${SCRIPT_DIR}/user-level/CLAUDE.md" "${CODEX_HOME}/AGENTS.md" "no-overwrite"

  local command_count rule_count skill_count hooks_target
  command_count="$(copy_codex_commands "${SCRIPT_DIR}/user-level/commands" "${CODEX_HOME}/commands")"
  rule_count="$(copy_codex_rules "${SCRIPT_DIR}/user-level/rules" "${CODEX_HOME}/rules")"
  skill_count="$(copy_codex_skills "${SCRIPT_DIR}/user-level/skills" "${CODEX_HOME}/skills")"

  hooks_target="${CODEX_HOME}/skills/continuous-learning/hooks"
  if [[ -d "${PLUGIN_SOURCE}/hooks" ]]; then
    mkdir -p "$hooks_target"
    cp -R "${PLUGIN_SOURCE}/hooks/." "$hooks_target/"
    log_ok "continuous-learning hooks copied"
  fi

  log_ok "${command_count} user commands copied"
  log_ok "${rule_count} user rules copied"
  log_ok "${skill_count} user skills copied"
}

install_user() {
  log_section "Installing Codex plugin -> ${PLUGIN_TARGET}"
  require_node
  build_plugin
  mkdir -p "$USER_PLUGINS_ROOT"
  if [[ -e "$PLUGIN_TARGET" ]]; then
    local backup="${PLUGIN_TARGET}.bak.$(date +%Y%m%d%H%M%S)"
    mv "$PLUGIN_TARGET" "$backup"
    log_warn "Existing plugin backed up to $backup"
  fi
  cp -R "$PLUGIN_SOURCE" "$USER_PLUGINS_ROOT/"
  log_ok "plugin copied"
  update_marketplaces
  register_codex_marketplace
  initialize_homunculus
  install_codex_user_assets
}

install_project() {
  local project_root="$PWD"
  local codex_dir="${project_root}/.codex"
  log_section "Installing Codex project templates -> ${codex_dir}"
  mkdir -p "${codex_dir}/commands" "${codex_dir}/rules" "${codex_dir}/plans" "${codex_dir}/skills" "${project_root}/docs/solutions"

  copy_codex_text "${SCRIPT_DIR}/project-level/CLAUDE.md" "${project_root}/AGENTS.md" "no-overwrite"

  local user_commands project_commands project_rules project_skills
  user_commands="$(copy_codex_commands "${SCRIPT_DIR}/user-level/commands" "${codex_dir}/commands")"
  project_commands="$(copy_codex_commands "${SCRIPT_DIR}/project-level/.claude/commands" "${codex_dir}/commands")"
  log_ok "commands copied (${user_commands} user, ${project_commands} project)"

  copy_codex_rules "${SCRIPT_DIR}/user-level/rules" "${codex_dir}/rules" >/dev/null
  project_rules="$(copy_codex_rules "${SCRIPT_DIR}/project-level/.claude/rules" "${codex_dir}/rules")"
  log_ok "rules copied (${project_rules} project)"

  project_skills="$(copy_codex_skills "${SCRIPT_DIR}/user-level/skills" "${codex_dir}/skills")"
  log_ok "${project_skills} project skills copied"
  log_ok "project directories ready"
}

import_claude_homunculus() {
  local source="${HOME}/.claude/homunculus"
  if [[ ! -d "$source" ]]; then
    log_warn "No Claude homunculus found at $source"
    return
  fi
  if [[ -e "$HOMUNCULUS_DIR" ]]; then
    log_warn "${HOMUNCULUS_DIR} already exists, import skipped"
    return
  fi
  mkdir -p "$CODEX_HOME"
  cp -R "$source" "$HOMUNCULUS_DIR"
  log_ok "imported Claude homunculus"
}

run_user=false
run_project=false
run_import=false

if [[ $# -eq 0 ]]; then
  show_help
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) run_user=true ;;
    --project) run_project=true ;;
    --all) run_user=true; run_project=true ;;
    --import-claude) run_import=true ;;
    --help|-h) show_help; exit 0 ;;
    *) show_help; exit 1 ;;
  esac
  shift
done

if [[ "$run_import" == true ]]; then import_claude_homunculus; fi
if [[ "$run_user" == true ]]; then install_user; fi
if [[ "$run_project" == true ]]; then install_project; fi
