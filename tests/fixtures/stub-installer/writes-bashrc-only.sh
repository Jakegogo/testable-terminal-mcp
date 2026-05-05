#!/bin/sh
# writes-bashrc-only.sh — round 8 fixture.
# Writes ONLY $HOME/.bashrc. bash `-il` does NOT source .bashrc by default
# (it sources .bash_profile / .bash_login / .profile), so a fresh-login
# capture with bash should NOT see this change.
#
# This is the "real signal" case from spec §11.6.2: installer chose the
# wrong rc file. Test asserts fresh-login env DOES NOT contain the var.

set -e
RC="$HOME/.bashrc"
mkdir -p "$HOME"
{
  printf 'export BASHRC_ONLY_VAR="bashrc-only-installed"\n'
} >> "$RC"
exit 0
