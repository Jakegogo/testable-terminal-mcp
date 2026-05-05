#!/bin/sh
# good-install.sh — clean baseline installer.
#   - touches ONLY $HOME/.zshrc
#   - the line is guarded so re-runs are idempotent
#   - never writes outside $HOME

set -e
RC="$HOME/.zshrc"
MARK="# managed-by-good-install"
LINE="export GOOD_INSTALLED_PATH=\"\$HOME/.local/bin:\$PATH\"  $MARK"

if [ -f "$RC" ] && grep -q "$MARK" "$RC"; then
  exit 0
fi

mkdir -p "$HOME/.local/bin"
printf '%s\n' "$LINE" >> "$RC"
exit 0
