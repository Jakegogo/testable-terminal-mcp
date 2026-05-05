#!/bin/sh
# writes-bash-profile.sh — round 8 control fixture.
# Writes $HOME/.bash_profile (which bash `-il` DOES source). Fresh-login
# capture with bash should see the change → real pass case complementing
# writes-bashrc-only.sh.

set -e
RC="$HOME/.bash_profile"
mkdir -p "$HOME"
{
  printf 'export BASH_PROFILE_VAR="bash-profile-installed"\n'
} >> "$RC"
exit 0
