#!/bin/sh
# non-idempotent.sh — every run unconditionally appends a NEW timestamped
# line to .zshrc. assert.idempotent_install should catch the file diff
# between rounds.
#
# Use $RANDOM (bash) or $$ + clock if zsh — pid+timestamp guarantees
# distinct content even on fast runs.

set -e
RC="$HOME/.zshrc"
mkdir -p "$HOME"
printf 'export NON_IDEMP_%s=%s_%s\n' "$$" "$$" "$(date +%N 2>/dev/null || date +%s%N 2>/dev/null || awk 'BEGIN{srand();print int(rand()*1e9)}')" >> "$RC"
exit 0
