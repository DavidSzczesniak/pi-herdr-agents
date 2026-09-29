#!/bin/sh
# Runs after each Bash call. A worktree's node_modules that links outside that worktree lets tools in one checkout
# rewrite another checkout's dependencies, so remove the link (never its target) and tell the agent. Exit 2 reports.
common() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }
repository=$(common "$1") || exit 0
removed=$(git -C "$1" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while IFS= read -r tree; do
  link=$tree/node_modules
  [ -L "$link" ] || continue
  # Git can still list a path that another repository now occupies.
  [ "$(common "$tree")" = "$repository" ] || continue
  target=$(cd -P "$link" 2>/dev/null && pwd -P) || continue
  root=$(cd -P "$tree" && pwd -P) || continue
  case $target/ in ("$root"/*) continue ;; esac
  rm "$link" && printf ' %s' "$link"
done)
[ -z "$removed" ] && exit 0
echo "Removed node_modules links to another checkout:$removed. Install dependencies in each worktree instead (for example \`npm ci\`)." >&2
exit 2
