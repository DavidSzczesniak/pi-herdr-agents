#!/bin/sh
# Claude Code hook: record one event's input as evidence for the adapter. Usage: claude-hook.sh <event> <hooks-dir>
# Plain sh on purpose: the adapter may run inside a bundled Pi binary, so no interpreter path is known to hooks.
# Each invocation writes its own file, so repeated or overlapping events never overwrite or truncate each other.
set -eu
case "$1" in *[!A-Za-z]* | "") exit 1 ;; esac
umask 077
name="$1-$(date +%s)-$$.json"
cat > "$2/.$name.tmp"
mv -f "$2/.$name.tmp" "$2/$name"
