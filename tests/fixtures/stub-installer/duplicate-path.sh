#!/bin/sh
# duplicate-path.sh — naive PATH installer that doesn't deduplicate.
# Re-running it adds the same dir again → assert.env_no_path_duplicates
# should flag this on the second run.

set -e
RC="$HOME/.zshrc"
mkdir -p "$HOME/.dup/bin"
printf 'export PATH="$HOME/.dup/bin:$PATH"\n' >> "$RC"
exit 0
