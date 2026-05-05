#!/bin/sh
# writes-zshrc-only.sh — round 7 fixture.
# Writes ONLY $HOME/.zshrc. zsh `-il` reads .zshrc on login → fresh-login
# env_snapshot should see the change. mode=current does NOT (only the
# next login shell will).
#
# This is the canonical proof-of-need for the fresh-login default.

set -e
RC="$HOME/.zshrc"
mkdir -p "$HOME"
{
  printf 'export ZSHRC_ONLY_VAR="zshrc-only-installed"\n'
  printf 'export PATH="$HOME/.zshrc-only/bin:$PATH"\n'
} >> "$RC"
exit 0
