#!/usr/bin/env bash
set -euo pipefail

# JS Knowledge Prism — one-command install script
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/user/js-knowledge-prism/main/install.sh | bash
#
# Environment variables:
#   JS_PRISM_DIR    Install directory (default: ./skills)
#   JS_PRISM_FORCE  Set to 1 to skip overwrite confirmation

REPO="user/js-knowledge-prism"
SKILL_ID="js-knowledge-prism"
DEFAULT_DIR="./skills"

# Sub-skill install: bash -s -- <skill-id>  or  JS_PRISM_SKILL=<id>
SUB_SKILL="${1:-${JS_PRISM_SKILL:-}}"

info()  { printf "\033[1;34m[info]\033[0m  %s\n" "$*"; }
ok()    { printf "\033[1;32m[ok]\033[0m    %s\n" "$*"; }
warn()  { printf "\033[1;33m[warn]\033[0m  %s\n" "$*"; }
err()   { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; }
die()   { err "$@"; exit 1; }

# -- Prerequisites -------------------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node.js is required. Install from https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || die "npm is required. It ships with Node.js."

NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=${NODE_VER%%.*}
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js >= 18 required (found $NODE_VER)"

info "Node.js $NODE_VER detected"

# -- Resolve install directory -------------------------------------------------

INSTALL_BASE="${JS_PRISM_DIR:-$DEFAULT_DIR}"
INSTALL_DIR="$INSTALL_BASE/$SKILL_ID"

# -- Sub-skill install ---------------------------------------------------------

if [ -n "$SUB_SKILL" ]; then
  JS_PRISM_ROOT="$INSTALL_DIR"
  if [ ! -d "$JS_PRISM_ROOT/openclaw-plugin" ]; then
    die "Main skill not found at $JS_PRISM_ROOT. Install it first (without arguments)."
  fi

  info "Installing sub-skill: $SUB_SKILL"

  REGISTRY_URL="https://raw.githubusercontent.com/$REPO/main/dist/skills.json"
  REGISTRY=$(curl -fsSL "$REGISTRY_URL" 2>/dev/null) || die "Failed to fetch skills registry"

  DOWNLOAD_URL=$(echo "$REGISTRY" | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const s=d.skills?.find(s=>s.id==='$SUB_SKILL');
    if(s) process.stdout.write(s.downloadUrl||'');
  ")

  [ -n "$DOWNLOAD_URL" ] || die "Sub-skill '$SUB_SKILL' not found in registry"

  TARGET_DIR="$JS_PRISM_ROOT/skills/$SUB_SKILL"
  if [ -d "$TARGET_DIR" ] && [ "${JS_PRISM_FORCE:-0}" != "1" ]; then
    warn "$TARGET_DIR already exists."
    printf "Overwrite? [y/N] "
    read -r ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { info "Cancelled."; exit 0; }
    rm -rf "$TARGET_DIR"
  fi

  mkdir -p "$TARGET_DIR"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  info "Downloading $DOWNLOAD_URL ..."
  curl -fsSL "$DOWNLOAD_URL" -o "$TMP/skill.zip" || die "Download failed"

  info "Extracting to $TARGET_DIR ..."
  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$TMP/skill.zip" -d "$TARGET_DIR"
  else
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/skill.zip" "$TARGET_DIR"
  fi

  if [ -f "$TARGET_DIR/package.json" ]; then
    info "Installing dependencies ..."
    (cd "$TARGET_DIR" && npm install --production 2>/dev/null || npm install)
  fi

  ok "Sub-skill '$SUB_SKILL' installed to $TARGET_DIR"
  echo ""
  echo "Add to ~/.openclaw/openclaw.json:"
  echo "  plugins.load.paths: [\"$(cd "$TARGET_DIR/openclaw-plugin" && pwd)\"]"
  echo "  plugins.entries.$SUB_SKILL: { \"enabled\": true }"
  echo ""
  echo "Restart OpenClaw to load the new skill."
  exit 0
fi

# -- Main skill install --------------------------------------------------------

if [ -d "$INSTALL_DIR" ] && [ "${JS_PRISM_FORCE:-0}" != "1" ]; then
  warn "$INSTALL_DIR already exists."
  printf "Overwrite? [y/N] "
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { info "Cancelled."; exit 0; }
  rm -rf "$INSTALL_DIR"
fi

mkdir -p "$INSTALL_DIR"

# Fetch latest release tag
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.tag_name||'')" 2>/dev/null) || true

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

DOWNLOADED=0

# Try 1: skill zip from release assets
if [ -n "$TAG" ]; then
  ASSET_URL="https://github.com/$REPO/releases/download/$TAG/js-knowledge-prism-skill.zip"
  info "Trying release asset: $ASSET_URL"
  if curl -fsSL "$ASSET_URL" -o "$TMP/skill.zip" 2>/dev/null; then
    DOWNLOADED=1
  fi
fi

# Try 2: source archive
if [ "$DOWNLOADED" = "0" ]; then
  REF="${TAG:-main}"
  SRC_URL="https://github.com/$REPO/archive/refs/heads/main.zip"
  if [ -n "$TAG" ]; then
    SRC_URL="https://github.com/$REPO/archive/refs/tags/$TAG.zip"
  fi
  info "Trying source archive: $SRC_URL"
  if curl -fsSL "$SRC_URL" -o "$TMP/source.zip" 2>/dev/null; then
    DOWNLOADED=2
  fi
fi

[ "$DOWNLOADED" != "0" ] || die "Failed to download from all sources"

info "Extracting ..."

if [ "$DOWNLOADED" = "1" ]; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$TMP/skill.zip" -d "$INSTALL_DIR"
  else
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/skill.zip" "$INSTALL_DIR"
  fi
else
  EXTRACT_DIR="$TMP/extracted"
  mkdir -p "$EXTRACT_DIR"
  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$TMP/source.zip" -d "$EXTRACT_DIR"
  else
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/source.zip" "$EXTRACT_DIR"
  fi

  SRC_ROOT=$(find "$EXTRACT_DIR" -maxdepth 1 -type d | tail -1)
  for item in SKILL.md SECURITY.md package.json LICENSE; do
    [ -f "$SRC_ROOT/$item" ] && cp "$SRC_ROOT/$item" "$INSTALL_DIR/"
  done
  for dir in openclaw-plugin lib templates; do
    [ -d "$SRC_ROOT/$dir" ] && cp -r "$SRC_ROOT/$dir" "$INSTALL_DIR/"
  done
fi

# Fix permissions
find "$INSTALL_DIR" -type f -exec chmod 644 {} + 2>/dev/null || true
find "$INSTALL_DIR" -type d -exec chmod 755 {} + 2>/dev/null || true

# Install dependencies
if [ -f "$INSTALL_DIR/package.json" ]; then
  info "Installing dependencies ..."
  (cd "$INSTALL_DIR" && npm install --production 2>/dev/null || npm install)
fi

PLUGIN_PATH="$(cd "$INSTALL_DIR/openclaw-plugin" 2>/dev/null && pwd || echo "$INSTALL_DIR/openclaw-plugin")"

ok "JS Knowledge Prism installed to $INSTALL_DIR"
echo ""
echo "Next steps:"
echo ""
echo "  1. Add to ~/.openclaw/openclaw.json:"
echo ""
echo "     {\"plugins\":{\"load\":{\"paths\":[\"$PLUGIN_PATH\"]},"
echo "      \"entries\":{\"js-knowledge-prism\":{\"enabled\":true,"
echo "        \"config\":{\"baseDir\":\"/path/to/your-knowledge-base\"}}}}}"
echo ""
echo "  2. Restart OpenClaw"
echo "  3. Run: openclaw prism status"
echo ""
