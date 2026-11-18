# rz and sz in herdr panes, for the iGhostVT device that has the pane open.
# Source it from ~/.zshrc or ~/.bashrc (`node src/cli.js zmodem` prints
# the line):
#
#   . /path/to/herdr-ghostvt/shell/zmodem.sh
#
# herdr shows a device its own rendering of a pane, never the bytes the
# programs in it write, so a ZMODEM transfer cannot cross it. In a herdr
# pane this runs ssh, rz and sz through the bridge's src/zmodem/wrap.js,
# which hands a transfer to the bridge and passes everything else through
# untouched; outside one, and for output that is not a terminal (pipes,
# scripts, scp, git), they run as they always do. `command ssh …` skips it
# once; `ghostvt_zmodem <program> …` wraps any other program the same way
# (another remote shell: mosh cannot carry ZMODEM at all).

if [ -n "${HERDR_PANE_ID:-}" ]; then
  if [ -n "${ZSH_VERSION:-}" ]; then
    __ghostvt_root=${${(%):-%x}:A:h:h}
  elif [ -n "${BASH_VERSION:-}" ]; then
    __ghostvt_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
  fi

  if [ -n "${__ghostvt_root:-}" ] && [ -f "$__ghostvt_root/src/zmodem/wrap.js" ]; then
    function ghostvt_zmodem {
      if [ -t 0 ] && [ -t 1 ]; then
        sh "$__ghostvt_root/bin/node.sh" "$__ghostvt_root/src/zmodem/wrap.js" "$@"
      else
        command "$@"
      fi
    }
    function ssh { ghostvt_zmodem ssh "$@"; }
    function rz { ghostvt_zmodem rz "$@"; }
    function sz { ghostvt_zmodem sz "$@"; }
  fi
fi
