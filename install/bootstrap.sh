#!/usr/bin/env bash
# =============================================================================
# Marketing Kit — remote bootstrap (always latest)
#   curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash
#   ... | bash -s -- hermes        # Hermes instead of Claude Code
#   ... | bash -s -- both          # both hosts
# Clones to ~/.marketing-kit (or pulls), then runs the installer from that checkout.
# Kit skills are SYMLINKS into this checkout, so every re-run updates them in place.
# =============================================================================
set -euo pipefail
TARGET="${1:-claude}"
KIT_DIR="${KIT_DIR:-$HOME/.marketing-kit}"
REPO="https://github.com/feelthefusion/marketing-kit.git"
command -v git >/dev/null 2>&1 || { echo "✗ git required"; exit 1; }
if [ -d "$KIT_DIR/.git" ]; then echo "▶ updating $KIT_DIR"; git -C "$KIT_DIR" pull --ff-only --quiet || echo "  ⚠ pull failed — using local checkout"
else echo "▶ cloning into $KIT_DIR"; git clone --quiet "$REPO" "$KIT_DIR"; fi
export KIT_NO_PULL=1   # just pulled
case "$TARGET" in
    claude) exec bash "$KIT_DIR/install/install.sh" ;;
    hermes) exec bash "$KIT_DIR/install/hermes.sh" ;;
    both)   bash "$KIT_DIR/install/install.sh" && exec bash "$KIT_DIR/install/hermes.sh" ;;
    *) echo "✗ unknown target '$TARGET' (claude | hermes | both)"; exit 1 ;;
esac
