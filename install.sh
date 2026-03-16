#!/usr/bin/env bash

set -euo pipefail

SKILL_NAME="weekly-web-report"
DEFAULT_REPO="tsumi233/weekly-web-report-skill"
DEFAULT_REF="main"

REPO_SLUG="$DEFAULT_REPO"
REF="$DEFAULT_REF"
TARGET_DIR="${CODEX_HOME:-$HOME/.openclaw}/skills/${SKILL_NAME}"
LOCAL_SOURCE=""
FORCE=0

usage() {
  cat <<'EOF'
Install the Weekly Web Report skill into OpenClaw.

Usage:
  install.sh [--target DIR] [--repo OWNER/REPO] [--ref NAME] [--from-local DIR] [--force]

Examples:
  curl -fsSL https://raw.githubusercontent.com/tsumi233/weekly-web-report-skill/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/tsumi233/weekly-web-report-skill/main/install.sh | bash -s -- --ref v0.1.0
  ./install.sh --from-local .
EOF
}

fail() {
  printf '[weekly-web-report-installer] %s\n' "$1" >&2
  exit 1
}

log() {
  printf '[weekly-web-report-installer] %s\n' "$1"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

verify_source_dir() {
  local dir="$1"
  [[ -f "$dir/SKILL.md" ]] || fail "Missing SKILL.md in source: $dir"
  [[ -f "$dir/scripts/weekly-web-report.mjs" ]] || fail "Missing scripts/weekly-web-report.mjs in source: $dir"
}

download_repo_archive() {
  local repo_slug="$1"
  local ref="$2"
  local temp_dir="$3"
  local archive_path="$temp_dir/repo.tar.gz"
  local url

  require_cmd curl
  require_cmd tar

  for url in \
    "https://github.com/${repo_slug}/archive/refs/tags/${ref}.tar.gz" \
    "https://github.com/${repo_slug}/archive/refs/heads/${ref}.tar.gz" \
    "https://github.com/${repo_slug}/archive/${ref}.tar.gz"
  do
    if curl -fsSL "$url" -o "$archive_path" >/dev/null 2>&1; then
      tar -xzf "$archive_path" -C "$temp_dir"
      find "$temp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1
      return 0
    fi
  done

  fail "Failed to download ${repo_slug} at ref ${ref}"
}

copy_skill_contents() {
  local source_dir="$1"
  local target_dir="$2"

  mkdir -p "$target_dir"
  cp "$source_dir/SKILL.md" "$target_dir/SKILL.md"

  for folder in agents scripts references assets; do
    if [[ -d "$source_dir/$folder" ]]; then
      cp -R "$source_dir/$folder" "$target_dir/$folder"
    fi
  done

  if [[ -d "$target_dir/scripts" ]]; then
    chmod +x "$target_dir"/scripts/* || true
  fi
}

install_skill() {
  local source_dir="$1"
  local target_dir="$2"
  local backup_dir=""

  mkdir -p "$(dirname "$target_dir")"

  if [[ -e "$target_dir" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      rm -rf "$target_dir"
    else
      backup_dir="${target_dir}.backup-$(date +%Y%m%d%H%M%S)"
      mv "$target_dir" "$backup_dir"
      log "Existing install moved to backup: $backup_dir"
    fi
  fi

  copy_skill_contents "$source_dir" "$target_dir"

  log "Installed to: $target_dir"
  if [[ -n "$backup_dir" ]]; then
    log "Backup kept at: $backup_dir"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET_DIR="$2"
      shift 2
      ;;
    --repo)
      REPO_SLUG="$2"
      shift 2
      ;;
    --ref)
      REF="$2"
      shift 2
      ;;
    --from-local)
      LOCAL_SOURCE="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

if [[ -n "$LOCAL_SOURCE" ]]; then
  SOURCE_DIR="$LOCAL_SOURCE"
else
  SCRIPT_PATH=""
  if [[ -n "${BASH_SOURCE-}" ]]; then
    SCRIPT_PATH="${BASH_SOURCE[0]}"
  fi
  SCRIPT_DIR=""
  if [[ -n "$SCRIPT_PATH" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd 2>/dev/null || true)"
  fi
  if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/SKILL.md" && -f "$SCRIPT_DIR/scripts/weekly-web-report.mjs" ]]; then
    SOURCE_DIR="$SCRIPT_DIR"
  else
    log "Downloading ${REPO_SLUG} (${REF})..."
    SOURCE_DIR="$(download_repo_archive "$REPO_SLUG" "$REF" "$TEMP_DIR")"
  fi
fi

verify_source_dir "$SOURCE_DIR"
install_skill "$SOURCE_DIR" "$TARGET_DIR"

cat <<EOF

Next steps:
1. Copy an example config, such as:
   cp ~/.openclaw/skills/${SKILL_NAME}/assets/mock-report.example.json ./report-config.json
2. Set credentials as environment variables (do not put passwords in JSON).
3. Validate the config:
   node ~/.openclaw/skills/${SKILL_NAME}/scripts/weekly-web-report.mjs validate-config --config ./report-config.json
4. Log in once per system:
   node ~/.openclaw/skills/${SKILL_NAME}/scripts/weekly-web-report.mjs login --system <system-key> --config ./report-config.json --show-browser true
5. Run the report:
   node ~/.openclaw/skills/${SKILL_NAME}/scripts/weekly-web-report.mjs collect --config ./report-config.json

EOF
