#!/bin/sh
# Runs the plugin's Node entry points. herdr runs plugin commands in its own
# environment, and a herdr server that launchd started at login (brew
# services) has PATH=/usr/bin:/bin:/usr/sbin:/sbin: no node from Homebrew,
# mise, nvm or volta. So node is looked for: on PATH, where those put it,
# then wherever the user's login shell would find it.

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME/.volta/bin/node" \
    "$HOME/.nix-profile/bin/node" \
    /run/current-system/sw/bin/node \
    /usr/bin/node; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && latest="$candidate"
  done
  if [ -n "$latest" ]; then
    echo "$latest"
    return
  fi
  "${SHELL:-/bin/sh}" -lc 'command -v node' 2>/dev/null | tail -n 1
}

node=$(find_node)
if [ -z "$node" ] || [ ! -x "$node" ]; then
  echo "ghostvt: node (20 or newer) was not found; herdr's PATH is $PATH" >&2
  exit 127
fi
exec "$node" "$@"
