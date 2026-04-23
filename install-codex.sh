#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${HOME}/.codex"
HOMUNCULUS_DIR="${CODEX_HOME}/homunculus"
AGENTS_PLUGINS_DIR="${HOME}/.agents/plugins"
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
  if [[ "$mode" == "no-overwrite" && -f "$dst" ]]; then
    log_warn "$(basename "$dst") exists, skip"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  node - "$src" "$dst" <<'NODE'
const fs = require('fs');
const path = require('path');
const source = process.argv[2];
const target = process.argv[3];
let text = fs.readFileSync(source, 'utf8');
[
  [/Claude Code/g, 'Codex'],
  [/Claude/g, 'Codex'],
  [/CLAUDE\.md/g, 'AGENTS.md'],
  [/~\/\.claude\/homunculus/g, '~/.codex/homunculus'],
  [/\.claude/g, '.codex'],
].forEach(([pattern, replacement]) => {
  text = text.replace(pattern, replacement);
});
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, text);
NODE
}

update_marketplace() {
  mkdir -p "$AGENTS_PLUGINS_DIR"
  MARKETPLACE_PATH="${AGENTS_PLUGINS_DIR}/marketplace.json" node <<'NODE'
const fs = require('fs');
const path = require('path');
const marketplacePath = process.env.MARKETPLACE_PATH;
const pluginName = 'tech-persistence';
let root = {
  name: 'local-plugins',
  interface: { displayName: 'Local Plugins' },
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
    installation: 'AVAILABLE',
    authentication: 'ON_INSTALL',
  },
  category: 'Coding',
});

fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
fs.writeFileSync(marketplacePath, `${JSON.stringify(root, null, 2)}\n`);
NODE
  log_ok "marketplace.json registered ${PLUGIN_NAME}"
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
  update_marketplace
  initialize_homunculus
}

install_project() {
  local project_root="$PWD"
  local codex_dir="${project_root}/.codex"
  log_section "Installing Codex project templates -> ${codex_dir}"
  mkdir -p "${codex_dir}/commands" "${codex_dir}/rules" "${codex_dir}/plans" "${project_root}/docs/solutions"

  copy_codex_text "${SCRIPT_DIR}/project-level/CLAUDE.md" "${project_root}/AGENTS.md" "no-overwrite"

  if [[ -d "${SCRIPT_DIR}/project-level/.claude/rules" ]]; then
    for file in "${SCRIPT_DIR}"/project-level/.claude/rules/*.md; do
      [[ -f "$file" ]] || continue
      copy_codex_text "$file" "${codex_dir}/rules/$(basename "$file")" "no-overwrite"
    done
    log_ok "rules copied"
  fi

  if [[ -d "${SCRIPT_DIR}/project-level/.claude/commands" ]]; then
    for file in "${SCRIPT_DIR}"/project-level/.claude/commands/*.md; do
      [[ -f "$file" ]] || continue
      copy_codex_text "$file" "${codex_dir}/commands/$(basename "$file")"
    done
    log_ok "project commands copied"
  fi
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
