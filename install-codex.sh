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
DOCTOR_SCRIPT="${SCRIPT_DIR}/scripts/codex-runtime-doctor.js"
USER_INSTALL_TRANSACTION_SCRIPT="${SCRIPT_DIR}/scripts/codex-user-install-transaction.js"
MARKETPLACE_UPDATE_SCRIPT="${SCRIPT_DIR}/scripts/update-codex-marketplace.js"
TEXT_ASSET_INSTALL_SCRIPT="${SCRIPT_DIR}/scripts/install-codex-text-asset.js"
JSON_ASSET_INSTALL_SCRIPT="${SCRIPT_DIR}/scripts/install-codex-json-asset.js"
CODEX_AGENTS_INSTALL_SCRIPT="${SCRIPT_DIR}/scripts/install-codex-agents.js"
ACTIVE_USER_INSTALL_MANIFEST=""
USER_INSTALL_ROLLBACK_RUNNING=false
USER_INSTALL_TRANSACTION_TERMINAL=true
USER_INSTALL_EXIT_REASON=""

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
  bash install-codex.sh --all --shared-homunculus ~/Documents/TechPersistence
  bash install-codex.sh --obsidian [path]

Options:
  --user           Install one canonical Codex plugin owner and user templates.
  --project        Create project templates; use a managed skill fallback only without a plugin owner.
  --all            Run --user and --project.
  --import-claude  Copy ~/.claude/homunculus to ~/.codex/homunculus when the Codex target does not exist.
  --obsidian [path]
                   Initialize the Codex homunculus vault (default ~/.codex/homunculus) for Obsidian.
  --shared-homunculus <path>
                   Configure Claude Code and Codex to use one shared homunculus/Obsidian vault.
  --allow-outside-home
                   Allow --shared-homunculus outside the user home directory.
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

resolve_installer_owner_pid() {
  local shell_pid="$$" platform mapped_pid ps_output
  if ! platform="$(uname -s 2>/dev/null)"; then
    echo "[FAIL] Cannot identify the shell platform while resolving the installer owner PID" >&2
    return 1
  fi
  case "$platform" in
    MINGW*|MSYS*|CYGWIN*)
      if ! ps_output="$(ps -W)"; then
        echo "[FAIL] Cannot read the MSYS process table for shell PID ${shell_pid}" >&2
        return 1
      fi
      if ! mapped_pid="$(printf '%s\n' "$ps_output" | awk -v pid="$shell_pid" '
        NR > 1 && $1 == pid { value = $4; matches += 1 }
        END { if (matches != 1 || value !~ /^[0-9]+$/) exit 2; print value }
      ')"; then
        echo "[FAIL] Cannot map the MSYS shell PID ${shell_pid} to exactly one Windows PID" >&2
        return 1
      fi
      if ! node -e 'try { process.kill(Number(process.argv[1]), 0); } catch (error) { if (error.code !== "EPERM") process.exit(1); }' "$mapped_pid"; then
        echo "[FAIL] Mapped Windows installer owner PID is not live: ${mapped_pid}" >&2
        return 1
      fi
      printf '%s\n' "$mapped_pid"
      ;;
    *)
      if ! node -e 'try { process.kill(Number(process.argv[1]), 0); } catch (error) { if (error.code !== "EPERM") process.exit(1); }' "$shell_pid"; then
        echo "[FAIL] Shell PID ${shell_pid} is not visible to Node on ${platform}; refusing an unowned transaction" >&2
        return 1
      fi
      printf '%s\n' "$shell_pid"
      ;;
  esac
}

build_plugin() {
  node "${PLUGIN_SOURCE}/scripts/build-codex-plugin.js"
}

plugin_fingerprint() {
  node -e "const {hashPath}=require(process.argv[1]); const value=hashPath(process.argv[2],{ignoreTopLevel:['commands']}); if(!value) process.exit(2); process.stdout.write(value);" "$DOCTOR_SCRIPT" "$1"
}

assert_private_install_container() {
  local candidate="$1" expected_prefix="$2"
  node - "$USER_PLUGINS_ROOT" "$candidate" "$expected_prefix" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, candidate, expectedPrefix] = process.argv.slice(2).map((value, index) => (
  index < 2 ? path.resolve(value) : value
));
for (const [label, value] of [['plugin root', root], ['private install container', candidate]]) {
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a plain directory: ${value}`);
  }
}
const realRoot = fs.realpathSync.native(root);
const realCandidate = fs.realpathSync.native(candidate);
if (path.dirname(realCandidate) !== realRoot || !path.basename(realCandidate).startsWith(expectedPrefix)) {
  throw new Error(`private install container escaped its root or prefix: ${realCandidate}`);
}
NODE
}

create_private_install_container() {
  local kind="$1" prefix=".${PLUGIN_NAME}.${kind}." candidate
  if ! candidate="$(mktemp -d "${USER_PLUGINS_ROOT}/${prefix}XXXXXXXX")"; then
    echo "[FAIL] Cannot create exclusive ${kind} container" >&2
    return 1
  fi
  if ! assert_private_install_container "$candidate" "$prefix"; then
    echo "[FAIL] Exclusive ${kind} container failed lstat/realpath validation: ${candidate}" >&2
    return 1
  fi
  printf '%s\n' "$candidate"
}

remove_private_install_container() {
  local candidate="$1" kind="$2" prefix=".${PLUGIN_NAME}.${kind}."
  [[ -e "$candidate" ]] || return 0
  assert_private_install_container "$candidate" "$prefix" || return 1
  rm -rf -- "$candidate"
}

rename_directory_if_target_absent() {
  local source="$1" target="$2"
  node - "$source" "$target" <<'NODE'
const fs = require('fs');
const path = require('path');
const [sourceInput, targetInput] = process.argv.slice(2);
const source = path.resolve(sourceInput);
const target = path.resolve(targetInput);
const sourceStat = fs.lstatSync(source);
if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
  throw new Error(`rename source is not a plain directory: ${source}`);
}
try {
  fs.lstatSync(target);
  console.error(`[FAIL] Rename target already exists: ${target}`);
  process.exit(17);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
fs.renameSync(source, target);
NODE
}

install_codex_plugin_bundle() {
  local transaction_manifest="$1"
  if ! mkdir -p "$USER_PLUGINS_ROOT"; then
    echo "[FAIL] Cannot create user plugin root: ${USER_PLUGINS_ROOT}" >&2
    return 1
  fi
  local source_hash target_hash original_target_hash="" backup_hash stage stage_hash backup="" backup_container=""
  local target_existed=false
  if ! source_hash="$(plugin_fingerprint "$PLUGIN_SOURCE")"; then
    echo "[FAIL] Cannot fingerprint the Codex plugin source" >&2
    return 1
  fi
  if [[ -d "$PLUGIN_TARGET" ]]; then
    target_existed=true
    if ! target_hash="$(plugin_fingerprint "$PLUGIN_TARGET")"; then
      echo "[FAIL] Cannot fingerprint the existing Codex plugin target" >&2
      return 1
    fi
    original_target_hash="$target_hash"
    if [[ "$source_hash" == "$target_hash" && ! -e "$PLUGIN_TARGET/commands" ]]; then
      log_ok "plugin already up to date"
      return 0
    fi
  fi

  if ! stage="$(create_private_install_container "stage")"; then return 1; fi
  if ! cp -R "${PLUGIN_SOURCE}/." "$stage/"; then
    remove_private_install_container "$stage" "stage" || true
    echo "[FAIL] Staging Codex plugin failed; previous plugin was not changed" >&2
    return 1
  fi
  if ! assert_private_install_container "$stage" ".${PLUGIN_NAME}.stage."; then
    echo "[FAIL] Isolated stage changed identity during copy" >&2
    return 1
  fi
  if ! rm -rf -- "$stage/commands"; then
    echo "[FAIL] Cannot remove legacy commands from the isolated stage" >&2
    return 1
  fi
  if ! stage_hash="$(plugin_fingerprint "$stage")"; then
    echo "[FAIL] Cannot fingerprint the isolated Codex plugin stage" >&2
    return 1
  fi
  if [[ "$source_hash" != "$stage_hash" ]]; then
    remove_private_install_container "$stage" "stage" || true
    echo "[FAIL] Staged plugin fingerprint mismatch; previous plugin was not changed" >&2
    return 1
  fi
  if ! assert_private_install_container "$stage" ".${PLUGIN_NAME}.stage."; then
    echo "[FAIL] Isolated stage changed identity before activation" >&2
    return 1
  fi

  if ! node "$USER_INSTALL_TRANSACTION_SCRIPT" activation-gate \
    --manifest "$transaction_manifest" \
    --phase "before-claim"; then
    remove_private_install_container "$stage" "stage" || true
    echo "[FAIL] Plugin target changed before the activation claim; staged bytes were not published" >&2
    return 1
  fi

  local backup_created=false
  if [[ "$target_existed" == true ]]; then
    if [[ ! -e "$PLUGIN_TARGET" ]] \
      || ! target_hash="$(plugin_fingerprint "$PLUGIN_TARGET")" \
      || [[ "$target_hash" != "$original_target_hash" ]]; then
      echo "[FAIL] Canonical plugin target changed after the before-claim gate; stage retained at ${stage}" >&2
      return 1
    fi
    if ! backup_container="$(create_private_install_container "backup")"; then return 1; fi
    backup="${backup_container}/plugin"
    [[ ! -e "$backup" ]] || {
      echo "[FAIL] Exclusive backup destination was unexpectedly occupied" >&2
      return 1
    }
    if ! rename_directory_if_target_absent "$PLUGIN_TARGET" "$backup"; then
      echo "[FAIL] Cannot preserve the existing Codex plugin target" >&2
      return 1
    fi
    if [[ -e "$PLUGIN_TARGET" ]]; then
      echo "[FAIL] Canonical plugin target appeared while claiming the previous plugin; stage and backup retained" >&2
      return 1
    fi
    if ! assert_private_install_container "$backup_container" ".${PLUGIN_NAME}.backup." \
      || ! backup_hash="$(plugin_fingerprint "$backup")" \
      || [[ "$backup_hash" != "$original_target_hash" ]]; then
      echo "[FAIL] Exclusive backup failed identity/fingerprint validation; outer rollback required" >&2
      return 1
    fi
    backup_created=true
    if ! node "$USER_INSTALL_TRANSACTION_SCRIPT" activation-gate \
      --manifest "$transaction_manifest" \
      --phase "claimed" \
      --claimed-path "$backup"; then
      if assert_private_install_container "$backup_container" ".${PLUGIN_NAME}.backup." \
        && backup_hash="$(plugin_fingerprint "$backup")" \
        && [[ "$backup_hash" == "$original_target_hash" ]] \
        && [[ ! -e "$PLUGIN_TARGET" ]] \
        && rename_directory_if_target_absent "$backup" "$PLUGIN_TARGET"; then
        remove_private_install_container "$backup_container" "backup" || true
        remove_private_install_container "$stage" "stage" || true
        log_warn "Previous plugin restored after activation failure"
      else
        echo "[FAIL] Claimed plugin bytes and staged bytes were preserved because the canonical target is occupied: backup=${backup} stage=${stage}" >&2
      fi
      return 1
    fi
    log_warn "Existing plugin backed up to $backup"
  else
    if [[ -e "$PLUGIN_TARGET" ]]; then
      echo "[FAIL] Canonical plugin target appeared after the before-claim gate; stage retained at ${stage}" >&2
      return 1
    fi
    if ! node "$USER_INSTALL_TRANSACTION_SCRIPT" activation-gate \
      --manifest "$transaction_manifest" \
      --phase "claimed"; then
      if [[ -e "$PLUGIN_TARGET" ]]; then
        echo "[FAIL] Canonical plugin target appeared during the claimed activation gate; stage retained at ${stage}" >&2
      else
        remove_private_install_container "$stage" "stage" || true
      fi
      return 1
    fi
  fi

  if [[ -e "$PLUGIN_TARGET" ]]; then
    echo "[FAIL] Canonical plugin target appeared before staged publication; stage and backup retained" >&2
    return 1
  fi
  if ! rename_directory_if_target_absent "$stage" "$PLUGIN_TARGET"; then
    if [[ -e "$PLUGIN_TARGET" ]]; then
      echo "[FAIL] Concurrent canonical plugin target retained; stage and backup retained for recovery" >&2
      return 1
    fi
    if [[ "$backup_created" == true && -e "$backup" ]]; then
      if assert_private_install_container "$backup_container" ".${PLUGIN_NAME}.backup." \
        && backup_hash="$(plugin_fingerprint "$backup")" \
        && [[ "$backup_hash" == "$original_target_hash" ]] \
        && rename_directory_if_target_absent "$backup" "$PLUGIN_TARGET"; then
        remove_private_install_container "$backup_container" "backup" || true
        log_warn "Previous plugin restored after activation failure"
      else
        echo "[FAIL] Inner activation rollback failed; outer transaction evidence is retained" >&2
      fi
    fi
    remove_private_install_container "$stage" "stage" || true
    echo "[FAIL] Activating staged Codex plugin failed" >&2
    return 1
  fi
  if ! target_hash="$(plugin_fingerprint "$PLUGIN_TARGET")"; then
    echo "[FAIL] Cannot fingerprint the activated Codex plugin target" >&2
    return 1
  fi
  if [[ "$source_hash" != "$target_hash" ]]; then
    echo "[FAIL] Activated plugin fingerprint mismatch; canonical target and backup retained for transaction recovery" >&2
    return 1
  fi
  log_ok "plugin activated from verified stage"
}

resolve_user_path() {
  node -e "const path=require('path'); const home=process.env.HOME||process.env.USERPROFILE; let value=process.argv[1]; if (value==='~') value=home; else if (value.startsWith('~/')||value.startsWith('~\\\\')) value=path.join(home,value.slice(2)); console.log(path.resolve(value));" "$1"
}

configure_shared_homunculus() {
  [[ -n "${SHARED_HOMUNCULUS:-}" ]] || return 0
  require_node
  local args=("${SCRIPT_DIR}/scripts/configure-shared-homunculus.js" "--path" "$SHARED_HOMUNCULUS" "--force")
  if [[ "${ALLOW_OUTSIDE_HOME:-false}" == true ]]; then
    args+=("--allow-outside-home")
  fi
  node "${args[@]}"
  HOMUNCULUS_DIR="$(resolve_user_path "$SHARED_HOMUNCULUS")"
}

copy_codex_text() {
  local src="$1" dst="$2" mode="${3:-overwrite}" result
  [[ -f "$TEXT_ASSET_INSTALL_SCRIPT" ]] || {
    echo "[FAIL] Missing Codex text asset installer: ${TEXT_ASSET_INSTALL_SCRIPT}" >&2
    return 1
  }
  mkdir -p "$(dirname "$dst")" || return $?
  if ! result="$(node "$TEXT_ASSET_INSTALL_SCRIPT" \
    --allowed-root "$(dirname "$dst")" \
    --source "$src" \
    --target "$dst" \
    --mode "$mode" 2>&1)"; then
    echo "[FAIL] Codex text asset compare-and-swap failed for ${dst}: ${result}" >&2
    return 1
  fi
}
copy_codex_commands() {
  local source_dir="$1" target_dir="$2" exclude_native="${3:-false}" count=0
  [[ -d "$source_dir" ]] || { echo 0; return; }
  mkdir -p "$target_dir" || return $?
  for file in "$source_dir"/*.md; do
    [[ -f "$file" ]] || continue
    if [[ "$exclude_native" == true ]]; then
      case "$(basename "$file")" in
        compound.md|plan.md|review.md|sprint.md|think.md|work.md) continue ;;
      esac
    fi
    copy_codex_text "$file" "${target_dir}/$(basename "$file")" "backup" || return $?
    count=$((count + 1))
  done
  echo "$count"
}

copy_codex_rules() {
  local source_dir="$1" target_dir="$2" count=0
  [[ -d "$source_dir" ]] || { echo 0; return; }
  mkdir -p "$target_dir" || return $?
  for file in "$source_dir"/*.md; do
    [[ -f "$file" ]] || continue
    copy_codex_text "$file" "${target_dir}/$(basename "$file")" "no-overwrite" || return $?
    count=$((count + 1))
  done
  echo "$count"
}

update_marketplace() {
  local marketplace_dir="$1" marketplace_name="$2" marketplace_display_name="$3" transaction_manifest="$4"
  [[ -f "$MARKETPLACE_UPDATE_SCRIPT" ]] || {
    echo "[FAIL] Missing lossless marketplace updater: ${MARKETPLACE_UPDATE_SCRIPT}" >&2
    return 1
  }
  mkdir -p "$marketplace_dir"
  local update_status
  if node "$MARKETPLACE_UPDATE_SCRIPT" \
    --path "${marketplace_dir}/marketplace.json" \
    --name "$marketplace_name" \
    --display-name "$marketplace_display_name" \
    --plugin-name "$PLUGIN_NAME" \
    --manifest "$transaction_manifest"; then
    update_status=0
  else
    update_status=$?
    echo "[FAIL] marketplace.json update failed with exit ${update_status}" >&2
    return "$update_status"
  fi
  log_ok "marketplace.json registered ${PLUGIN_NAME}"
}

register_codex_marketplace() {
  if command -v codex >/dev/null 2>&1; then
    if codex plugin marketplace add "$HOME" --json; then
      log_ok "codex marketplace registered: ${HOME}"
    else
      echo "[FAIL] codex marketplace registration failed" >&2
      return 1
    fi
  else
    echo "[FAIL] Codex CLI is required for --user" >&2
    return 1
  fi
}

refresh_codex_plugin_cache() {
  if ! codex plugin add "${PLUGIN_NAME}@local-plugins" --json; then
    echo "[FAIL] Codex canonical plugin cache refresh failed" >&2
    return 1
  fi
  log_ok "codex plugin cache refreshed from canonical marketplace"
}

repair_codex_runtime() {
  [[ -f "$DOCTOR_SCRIPT" ]] || { echo "[FAIL] Missing Codex runtime doctor: $DOCTOR_SCRIPT" >&2; return 1; }
  log_section "Inspecting Codex runtime ownership (read-only)"
  if node "$DOCTOR_SCRIPT" --reference-plugin-root "$PLUGIN_TARGET"; then
    log_ok "runtime ownership already healthy"
  else
    log_warn "runtime ownership needs a safe repair; dry-run completed"
  fi
  log_section "Enforcing one canonical Codex runtime owner"
  if ! node "$DOCTOR_SCRIPT" --fix --install-canonical --reference-plugin-root "$PLUGIN_TARGET"; then
    echo "[FAIL] Codex runtime owner repair failed" >&2
    return 1
  fi
  log_ok "canonical owner: tech-persistence@local-plugins"
}

inject_install_failure() {
  local step="$1"
  if [[ -n "${CODEX_INSTALL_FAIL_AT:-}" && "${CODEX_INSTALL_FAIL_AT}" == "$step" ]]; then
    echo "[FAIL] Injected Codex user-install failure after ${step}" >&2
    return 97
  fi
}

disarm_user_install_traps() {
  trap - EXIT INT TERM
}

user_install_signal_trap() {
  local status="$1" signal_name="$2"
  USER_INSTALL_EXIT_REASON="received ${signal_name} during active Codex user install"
  exit "$status"
}

user_install_exit_trap() {
  local original_status="$1" final_status="$1"
  disarm_user_install_traps
  if [[ -n "$ACTIVE_USER_INSTALL_MANIFEST" \
    && "$USER_INSTALL_TRANSACTION_TERMINAL" != true \
    && "$USER_INSTALL_ROLLBACK_RUNNING" != true ]]; then
    if [[ "$final_status" -eq 0 ]]; then final_status=125; fi
    if ! rollback_user_install_transaction \
      "$ACTIVE_USER_INSTALL_MANIFEST" \
      "${USER_INSTALL_EXIT_REASON:-shell exited with status ${original_status}}"; then
      final_status=125
    fi
  fi
  exit "$final_status"
}

arm_user_install_traps() {
  trap 'user_install_exit_trap $?' EXIT
  trap 'user_install_signal_trap 130 INT' INT
  trap 'user_install_signal_trap 143 TERM' TERM
}

complete_user_install_transaction() {
  USER_INSTALL_TRANSACTION_TERMINAL=true
  ACTIVE_USER_INSTALL_MANIFEST=""
  USER_INSTALL_EXIT_REASON=""
  disarm_user_install_traps
}

transaction_manifest_field() {
  local manifest_path="$1" field="$2"
  node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const field=value[process.argv[2]]; if(field!==null&&field!==undefined) process.stdout.write(String(field));" "$manifest_path" "$field"
}

rollback_user_install_transaction() {
  local manifest_path="$1" reason="$2" rollback_status=0 disposition lock_error
  USER_INSTALL_ROLLBACK_RUNNING=true
  node "$USER_INSTALL_TRANSACTION_SCRIPT" rollback \
    --manifest "$manifest_path" \
    --reason "$reason" || rollback_status=$?
  if ! disposition="$(transaction_manifest_field "$manifest_path" state)"; then disposition="unknown"; fi
  if ! lock_error="$(transaction_manifest_field "$manifest_path" lockReleaseError)"; then lock_error="unknown"; fi
  complete_user_install_transaction
  case "$disposition" in
    rolled-back)
      if [[ -n "$lock_error" || "$rollback_status" -ne 0 ]]; then
        echo "[FAIL] Codex user-install rollback completed, but the active transaction lock was not released: ${lock_error:-unknown release failure}. Evidence: ${manifest_path}" >&2
        return 125
      fi
      log_warn "User install failed; plugin, marketplace, cache, and owner state were restored"
      return 0
      ;;
    recovery-required)
      if [[ -n "$lock_error" || "$rollback_status" -ne 0 ]]; then
        echo "[FAIL] Codex user install crossed the irreversible CLI commit point; installer-owned state was preserved, but the active transaction lock was not released: ${lock_error:-unknown release failure}. Rerun --user to finish recovery. Evidence: ${manifest_path}" >&2
      else
        echo "[FAIL] Codex user install crossed the irreversible CLI commit point; installer-owned state was preserved and the transaction lock was released. Rerun --user to finish recovery. Evidence: ${manifest_path}" >&2
      fi
      return 125
      ;;
    *)
      echo "[FAIL] Codex user-install compensation failed closed with state=${disposition}; evidence: ${manifest_path}" >&2
      return 1
      ;;
  esac
}

run_user_install_step() {
  local manifest_path="$1" step="$2" step_status
  shift 2
  if "$@"; then
    return 0
  else
    step_status=$?
  fi
  local terminal_state lock_error
  if ! terminal_state="$(transaction_manifest_field "$manifest_path" state)"; then terminal_state="unknown"; fi
  if [[ "$terminal_state" == "committed" || "$terminal_state" == "rolled-back" || "$terminal_state" == "recovery-required" ]]; then
    if ! lock_error="$(transaction_manifest_field "$manifest_path" lockReleaseError)"; then lock_error="unknown"; fi
    complete_user_install_transaction
    echo "[FAIL] Codex user-install step '${step}' reached terminal state=${terminal_state}; no rollback was attempted. Active lock release error: ${lock_error:-none recorded}. Evidence: ${manifest_path}" >&2
    return 125
  fi
  if ! rollback_user_install_transaction "$manifest_path" "$step failed with exit ${step_status}"; then
    return 125
  fi
  return "$step_status"
}

assert_codex_runtime_single_owner() {
  local reference_plugin_root="$1"
  if ! node "$DOCTOR_SCRIPT" --reference-plugin-root "$reference_plugin_root"; then
    echo "[FAIL] Codex runtime is not single-owner healthy. Run the user installer or runtime doctor first." >&2
    return 1
  fi
  log_ok "runtime doctor verified ownerCount=1"
}

install_managed_project_fallback() {
  local codex_dir="$1"
  local skills_source="${PLUGIN_SOURCE}/codex-skills"
  local fallback_installer="${SCRIPT_DIR}/scripts/install-managed-project-fallback.js"
  [[ -d "$skills_source" ]] || { echo "[FAIL] Missing built Codex skills: $skills_source" >&2; return 1; }
  [[ -f "$fallback_installer" ]] || { echo "[FAIL] Missing managed fallback installer: $fallback_installer" >&2; return 1; }

  node "$fallback_installer" \
    --source "$skills_source" \
    --codex-dir "$codex_dir" \
    --user-codex-home "$CODEX_HOME"
  log_ok "managed project fallback installed with SHA256 owner manifest"
}

install_homunculus_json_asset() {
  local target="$1" result backup status
  shift
  [[ -f "$JSON_ASSET_INSTALL_SCRIPT" ]] || {
    echo "[FAIL] Missing atomic JSON asset installer: ${JSON_ASSET_INSTALL_SCRIPT}" >&2
    return 1
  }
  if ! result="$(node "$JSON_ASSET_INSTALL_SCRIPT" --target "$target" "$@")"; then
    echo "[FAIL] Atomic JSON asset install failed for ${target}" >&2
    return 1
  fi
  if ! backup="$(node -e "const value=JSON.parse(process.argv[1]); if(value.backupPath) process.stdout.write(String(value.backupPath));" "$result")"; then
    echo "[FAIL] Atomic JSON asset install returned invalid output for ${target}" >&2
    return 1
  fi
  if ! status="$(node -e "const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.status||'unknown'));" "$result")"; then
    echo "[FAIL] Atomic JSON asset install returned no status for ${target}" >&2
    return 1
  fi
  [[ -z "$backup" ]] || log_warn "Invalid JSON asset backed up to ${backup}"
  log_ok "homunculus $(basename "$target") ${status}"
}

install_codex_agents() {
  local kind="$1" allowed_root="$2" target="$3" template="$4" legacy_source="$5"
  local result helper_status status backup reason
  [[ -f "$CODEX_AGENTS_INSTALL_SCRIPT" ]] || {
    echo "[FAIL] Missing Codex AGENTS installer: ${CODEX_AGENTS_INSTALL_SCRIPT}" >&2
    return 1
  }

  if result="$(node "$CODEX_AGENTS_INSTALL_SCRIPT" \
    --kind "$kind" \
    --allowed-root "$allowed_root" \
    --target "$target" \
    --template "$template" \
    --legacy-source "$legacy_source")"; then
    helper_status=0
  else
    helper_status=$?
  fi
  case "$helper_status" in
    0|2) ;;
    *)
      echo "[FAIL] Codex AGENTS install failed with exit ${helper_status}: ${target}" >&2
      return "$helper_status"
      ;;
  esac

  status="$(node -e "const value=JSON.parse(process.argv[1]); if(!value.status) process.exit(2); process.stdout.write(String(value.status));" "$result")" || return 1
  backup="$(node -e "const value=JSON.parse(process.argv[1]); if(value.backupPath) process.stdout.write(String(value.backupPath));" "$result")" || return 1
  reason="$(node -e "const value=JSON.parse(process.argv[1]); if(value.reason) process.stdout.write(String(value.reason));" "$result")" || return 1

  [[ -z "$backup" ]] || log_warn "Previous AGENTS.md retained at ${backup}"
  if [[ "$helper_status" -eq 2 ]]; then
    log_warn "AGENTS.md ${status}; Codex-native optimization was not applied${reason:+: ${reason}}"
    return 0
  fi
  log_ok "AGENTS.md ${status}"
}

initialize_homunculus() {
  mkdir -p "${HOMUNCULUS_DIR}/instincts/personal" || return $?
  mkdir -p "${HOMUNCULUS_DIR}/instincts/inherited" || return $?
  mkdir -p "${HOMUNCULUS_DIR}/evolved/skills" || return $?
  mkdir -p "${HOMUNCULUS_DIR}/evolved/commands" || return $?
  mkdir -p "${HOMUNCULUS_DIR}/evolved/agents" || return $?
  mkdir -p "${HOMUNCULUS_DIR}/projects" || return $?
  mkdir -p "${HOMUNCULUS_DIR}/skill-signals" || return $?
  mkdir -p "${HOMUNCULUS_DIR}/skill-evals" || return $?
  mkdir -p "${HOMUNCULUS_DIR}/skill-changelog" || return $?

  install_homunculus_json_asset \
    "${HOMUNCULUS_DIR}/config.json" \
    --source "${PLUGIN_SOURCE}/codex-homunculus-template/config.json" || return $?
  install_homunculus_json_asset \
    "${HOMUNCULUS_DIR}/projects.json" \
    --default-json '{}' || return $?

  # 存在即刷新：vault 已存在则同步最新 tag 类配置（幂等，无变化不写）。不创建新 vault。
  if [[ -d "${HOMUNCULUS_DIR}/.obsidian" ]]; then
    if node "${SCRIPT_DIR}/scripts/init-obsidian-vault.js" --vault-path "${HOMUNCULUS_DIR}" >/dev/null 2>&1; then
      log_ok "Obsidian vault 配置已刷新"
    fi
  fi
}

install_codex_user_assets() {
  log_section "Installing Codex user assets -> ${CODEX_HOME}" || return $?
  mkdir -p "${CODEX_HOME}/commands" "${CODEX_HOME}/rules" || return $?

  install_codex_agents \
    "user" \
    "$CODEX_HOME" \
    "${CODEX_HOME}/AGENTS.md" \
    "${SCRIPT_DIR}/codex-native/agents/user.md" \
    "${SCRIPT_DIR}/user-level/CLAUDE.md" || return $?

  local command_count native_command_count rule_count
  command_count="$(copy_codex_commands "${SCRIPT_DIR}/user-level/commands" "${CODEX_HOME}/commands" true)" || return $?
  native_command_count="$(copy_codex_commands "${SCRIPT_DIR}/codex-native/commands" "${CODEX_HOME}/commands")" || return $?
  command_count=$((command_count + native_command_count))
  rule_count="$(copy_codex_rules "${SCRIPT_DIR}/user-level/rules" "${CODEX_HOME}/rules")" || return $?

  log_ok "${command_count} user commands copied" || return $?
  log_ok "${rule_count} user rules copied" || return $?
  log_ok "skills and hooks are owned by the canonical plugin" || return $?
}

install_user() {
  log_section "Installing Codex plugin -> ${PLUGIN_TARGET}"
  require_node
  build_plugin
  [[ -f "$USER_INSTALL_TRANSACTION_SCRIPT" ]] || {
    echo "[FAIL] Missing Codex user-install transaction helper: ${USER_INSTALL_TRANSACTION_SCRIPT}" >&2
    return 1
  }

  local transaction_manifest installer_owner_pid
  if ! installer_owner_pid="$(resolve_installer_owner_pid)"; then
    return 1
  fi
  if ! transaction_manifest="$(node "$USER_INSTALL_TRANSACTION_SCRIPT" prepare \
    --plugin-target "$PLUGIN_TARGET" \
    --plugin-source "$PLUGIN_SOURCE" \
    --marketplace-path "${AGENTS_PLUGINS_DIR}/marketplace.json" \
    --marketplace-root "$HOME" \
    --marketplace-name "local-plugins" \
    --canonical-owner "${PLUGIN_NAME}@local-plugins" \
    --codex-home "$CODEX_HOME" \
    --owner-pid "$installer_owner_pid")"; then
    return 1
  fi
  ACTIVE_USER_INSTALL_MANIFEST="$transaction_manifest"
  USER_INSTALL_ROLLBACK_RUNNING=false
  USER_INSTALL_TRANSACTION_TERMINAL=false
  USER_INSTALL_EXIT_REASON=""
  arm_user_install_traps

  run_user_install_step "$transaction_manifest" "plugin activation" \
    install_codex_plugin_bundle "$transaction_manifest" || return $?
  run_user_install_step "$transaction_manifest" "activation snapshot" \
    node "$USER_INSTALL_TRANSACTION_SCRIPT" activated --manifest "$transaction_manifest" || return $?
  run_user_install_step "$transaction_manifest" "target failure injection" \
    inject_install_failure "target" || return $?

  run_user_install_step "$transaction_manifest" "marketplace file update" \
    update_marketplace "$AGENTS_PLUGINS_DIR" "local-plugins" "Local Plugins" "$transaction_manifest" || return $?
  run_user_install_step "$transaction_manifest" "marketplace file checkpoint" \
    node "$USER_INSTALL_TRANSACTION_SCRIPT" checkpoint --manifest "$transaction_manifest" \
      --phase "marketplace-file" || return $?
  run_user_install_step "$transaction_manifest" "marketplace registration" \
    register_codex_marketplace || return $?
  run_user_install_step "$transaction_manifest" "marketplace registration checkpoint" \
    node "$USER_INSTALL_TRANSACTION_SCRIPT" checkpoint --manifest "$transaction_manifest" \
      --phase "marketplace" || return $?
  run_user_install_step "$transaction_manifest" "marketplace failure injection" \
    inject_install_failure "marketplace" || return $?

  run_user_install_step "$transaction_manifest" "plugin cache refresh" \
    refresh_codex_plugin_cache || return $?
  run_user_install_step "$transaction_manifest" "plugin cache checkpoint" \
    node "$USER_INSTALL_TRANSACTION_SCRIPT" checkpoint --manifest "$transaction_manifest" \
      --phase "cache" || return $?
  run_user_install_step "$transaction_manifest" "cache failure injection" \
    inject_install_failure "cache" || return $?

  run_user_install_step "$transaction_manifest" "runtime doctor" repair_codex_runtime || return $?
  run_user_install_step "$transaction_manifest" "runtime doctor checkpoint" \
    node "$USER_INSTALL_TRANSACTION_SCRIPT" checkpoint --manifest "$transaction_manifest" \
      --phase "doctor" || return $?
  run_user_install_step "$transaction_manifest" "doctor failure injection" \
    inject_install_failure "doctor" || return $?
  run_user_install_step "$transaction_manifest" "transaction commit" \
    node "$USER_INSTALL_TRANSACTION_SCRIPT" commit --manifest "$transaction_manifest" || return $?
  complete_user_install_transaction
  log_ok "verified plugin transaction committed: ${transaction_manifest}"

  local postcommit_status
  if inject_install_failure "user-assets"; then
    :
  else
    postcommit_status=$?
    echo "[FAIL] Codex plugin transaction committed, but post-commit user assets are incomplete (injection exit ${postcommit_status}). Rerun --user; asset writes are atomic and idempotent. Evidence: ${transaction_manifest}" >&2
    return 125
  fi
  if initialize_homunculus; then
    :
  else
    postcommit_status=$?
    echo "[FAIL] Codex plugin transaction committed, but post-commit user assets are incomplete (homunculus exit ${postcommit_status}). Rerun --user; asset writes are atomic and idempotent. Evidence: ${transaction_manifest}" >&2
    return 125
  fi
  if install_codex_user_assets; then
    :
  else
    postcommit_status=$?
    echo "[FAIL] Codex plugin transaction committed, but post-commit user assets are incomplete (asset exit ${postcommit_status}). Rerun --user; asset writes are atomic and idempotent. Evidence: ${transaction_manifest}" >&2
    return 125
  fi
  log_ok "Codex user install complete"
}

install_project() {
  local project_root="$PWD"
  local codex_dir="${project_root}/.codex"
  log_section "Installing Codex project templates -> ${codex_dir}"
  require_node
  build_plugin
  mkdir -p "${codex_dir}/commands" "${codex_dir}/rules" "${codex_dir}/plans" "${project_root}/docs/solutions"

  install_codex_agents \
    "project" \
    "$project_root" \
    "${project_root}/AGENTS.md" \
    "${SCRIPT_DIR}/codex-native/agents/project.md" \
    "${SCRIPT_DIR}/project-level/CLAUDE.md" || return $?

  local user_commands project_commands project_rules
  user_commands="$(copy_codex_commands "${SCRIPT_DIR}/user-level/commands" "${codex_dir}/commands" true)"
  project_commands="$(copy_codex_commands "${SCRIPT_DIR}/project-level/.claude/commands" "${codex_dir}/commands")"
  local native_commands
  native_commands="$(copy_codex_commands "${SCRIPT_DIR}/codex-native/commands" "${codex_dir}/commands")"
  log_ok "commands copied (${user_commands} user, ${project_commands} project, ${native_commands} native)"

  copy_codex_rules "${SCRIPT_DIR}/user-level/rules" "${codex_dir}/rules" >/dev/null
  project_rules="$(copy_codex_rules "${SCRIPT_DIR}/project-level/.claude/rules" "${codex_dir}/rules")"
  log_ok "rules copied (${project_rules} project)"

  if command -v codex >/dev/null 2>&1; then
    local owner_output owner_status
    if owner_output="$(node "$DOCTOR_SCRIPT" --plugin-owner-status --json 2>&1)"; then
      owner_status=0
    else
      owner_status=$?
    fi
    case "$owner_status" in
      0)
        log_ok "one plugin owner is active; project skills and hooks were not copied"
        ;;
      2)
        log_warn "No Codex plugin owner is active; installing a managed project skill fallback"
        install_managed_project_fallback "$codex_dir"
        ;;
      3)
        echo "[FAIL] Multiple Codex plugin owners detected: $owner_output" >&2
        return 1
        ;;
      *)
        echo "[FAIL] Codex owner probe failed: $owner_output" >&2
        return 1
        ;;
    esac
    assert_codex_runtime_single_owner "$PLUGIN_SOURCE"
  else
    log_warn "Codex CLI unavailable; installing a managed project skill fallback"
    install_managed_project_fallback "$codex_dir"
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

install_obsidian() {
  log_section "Obsidian Vault 集成 (Codex)"
  require_node
  local vault_path="${HOMUNCULUS_DIR}"
  if [[ -n "${OBSIDIAN_VAULT_PATH:-}" ]]; then
    vault_path="$OBSIDIAN_VAULT_PATH"
  elif [[ -n "${SHARED_HOMUNCULUS:-}" ]]; then
    vault_path="$(resolve_user_path "$SHARED_HOMUNCULUS")"
  fi

  node "${SCRIPT_DIR}/scripts/init-obsidian-vault.js" --vault-path "$vault_path"

  local mcp_snippet="${vault_path}/_mcp-config-snippet.json"
  if [[ -f "$mcp_snippet" ]]; then
    echo ""
    log_warn "将以下 MCP 配置合并到 Codex 的 mcpServers 字段:"
    cat "$mcp_snippet"
    echo ""
  fi
  log_ok "Obsidian 集成完成: $vault_path"
}

run_user=false
run_project=false
run_import=false
run_obsidian=false
OBSIDIAN_VAULT_PATH=""
SHARED_HOMUNCULUS=""
ALLOW_OUTSIDE_HOME=false

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
    --obsidian)
      run_obsidian=true
      if [[ -n "${2:-}" && "${2:0:1}" != "-" ]]; then
        OBSIDIAN_VAULT_PATH="$2"
        shift
      fi
      ;;
    --shared-homunculus)
      SHARED_HOMUNCULUS="${2:-}"
      [[ -n "$SHARED_HOMUNCULUS" ]] || { echo "[FAIL] --shared-homunculus requires a path" >&2; exit 1; }
      shift
      ;;
    --allow-outside-home) ALLOW_OUTSIDE_HOME=true ;;
    --help|-h) show_help; exit 0 ;;
    *) show_help; exit 1 ;;
  esac
  shift
done

configure_shared_homunculus
if [[ "$run_import" == true ]]; then import_claude_homunculus; fi
if [[ "$run_user" == true ]]; then install_user; fi
if [[ "$run_project" == true ]]; then install_project; fi
if [[ "$run_obsidian" == true ]]; then install_obsidian; fi
