#!/bin/sh
# leaks-to-host.sh — installer that writes outside $HOME (the bug we want
# assert.monitored_paths_unchanged to catch).
#
# CI safety: caller MUST set TT_LEAK_TARGET to a writable temp file rather
# than the real /etc/zshrc. The script appends one line if the target is
# writable and silently no-ops otherwise (avoids host pollution if TT_LEAK_TARGET
# isn't set).

set -e
TARGET="${TT_LEAK_TARGET:-/tmp/leaks-to-host-default.txt}"
if [ -w "$(dirname "$TARGET")" ] || [ -w "$TARGET" ]; then
  printf 'leaked-by-installer\n' >> "$TARGET"
fi
exit 0
