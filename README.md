# iGhostVT bridge for herdr

A [herdr](https://herdr.dev) plugin that makes the machine running herdr an
[iGhostVT](https://github.com/owngoal-dev/iGhostVT) host. iGhostVT on an
iPhone, iPad or Mac finds it on the local network (Bonjour), pairs with it
using a six-digit code, and opens terminals on it — or reaches it from
anywhere through an iGhostVT relay. The terminals are herdr's: every pane
open in herdr — shells and agents, in every workspace — is a session the
device can pick up, and a tab the app opens is a new tab in herdr's
**iGhostVT** workspace.

The app needs no change: the plugin speaks iGhostVT's own remote protocol
(TLS 1.2 PSK, SPAKE2+ pairing, the IOWire session frames of protocol 2,
with the LZFSE frame compression and link window of iGhostVT 1.6) and its
relay protocol.

## Requirements

- herdr 0.8.0 or newer
- Node.js 20 or newer (no npm packages)
- iGhostVT 1.6 on the other devices (the plugin speaks the 1.6 release line;
  iGhostVT connects only within one major.minor line)
- For the local network: macOS (`dns-sd`, built in) or Linux with
  `avahi-publish` (avahi-utils). Without either, devices reach the host only
  through the relay.

## Install

From a local checkout:

```sh
herdr plugin link /path/to/herdr-ghostvt
```

The plugin's startup hook starts the bridge in the background when the herdr
server starts; the plugin's actions start it too if it is not running yet.

herdr runs plugin commands with its own environment, and a herdr server that
launchd starts at login (`brew services`) has only
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`. So every command goes through
`bin/node.sh`, which finds Node on PATH, where Homebrew, mise, volta, nvm or
nix put it, or through the login shell.

herdr keeps a copy of the manifest from when the plugin was linked or
installed: after an update that changes `herdr-plugin.toml`, link it again
(`herdr plugin unlink ghostvt && herdr plugin link <path>`) or reinstall it.
The plugin's state and configuration stay.

## Pair a device

1. In herdr, run the action **Pair an iGhostVT device** (or
   `herdr plugin action invoke ghostvt.pair`). A six-digit code appears, valid
   for two minutes and three attempts.
2. On the other device: iGhostVT ▸ Settings ▸ Remote Access, choose this
   host (named after the machine, with “(herdr)”), and enter the code.

The device then lists every herdr pane, labelled with its workspace, the
agent running in it and its state, and its title — “vphone-qemu · claude
(working) · ◐ survey symbol table” — and can pick any of them up. **New
Tab** makes a new herdr tab in the iGhostVT workspace.

While a device shows a pane, the pane takes the device's size (in herdr too);
when the device lets go, the pane gets its own size back. Closing a tab on
the device closes it in herdr only for a terminal the device opened there;
a shell or agent you started in herdr is just let go.

The action **iGhostVT bridge** opens a panel with the paired devices and the
relay: `p` pair, `u` unpair the selected device, `i` import a relay
configuration, `x` remove it, `n` rename the host.

## Relay

To reach the host from outside the local network, run an
[iGhostVT relay](https://github.com/owngoal-dev/iGhostVT/tree/main/Relay) and
import the same `.vtrpsc` file on this host as on the devices: `i` in the
panel, or

```sh
node src/cli.js relay import relay.vtrpsc
```

Pairing through the relay is refused unless the pairing window allows it
(`r` on the pairing screen, or `node src/cli.js pair --relay`).

## Configuration

Optional, in the plugin's config directory (`herdr plugin config-dir ghostvt`),
`config.json`:

| Key | Meaning | Default |
|---|---|---|
| `name` | The name devices see | the computer's name + “(herdr)” |
| `port` | The TCP port to listen on | 46404, else 46414, 46424, … |
| `workspace` | The herdr workspace new terminals open in | `iGhostVT` |
| `expose` | `all`: every herdr pane is a session; `workspace`: only the panes in that workspace | `all` |
| `session` | The herdr session the bridge serves (a name given to `herdr --session`) | the default session |
| `appVersion` | The iGhostVT release line to speak; only 1.6 is implemented, so remove an older value | `1.6.0` |
| `bonjour` | `false` to not advertise on the local network | `true` |

iGhostVT's own host on the same Mac holds port 46404; the bridge then takes
the next free one and advertises it. Devices that find the host over Bonjour
or the relay follow the advertised port; only iGhostVT's fallback to an
address it remembered dials 46404.

## How terminal content gets there

herdr does not expose a terminal's raw output. The bridge holds each session
open with `herdr terminal session control` at the device's size: herdr sends
frames of its own rendering of the screen, the bridge passes them on as the
session's output (dropping redundant cursor moves and colours, which makes a
full screen 10–20× smaller), and the device's input goes back as
`terminal.input`. Frames go at most about 30 times a second: changes in
between wait for the next one, or — when they add up to more than a
repaint, or the link is backed up — are replaced by one repaint, so a slow
link shows the latest screen rather than a queue of old ones. "Backed up"
counts what the device has not yet said it received, so the TCP buffers on
the way (a relay's among them) cannot hide a backlog; frames of 1 KiB and up
cross compressed, so a reattach's history replay is a fraction of its size.

Because frames repaint the screen rather than scroll it, the bridge keeps the
device's scrollback itself: an attach replays herdr's history before the
screen, and while a session is shown, lines that scroll off are written into
the device's scrollback shortly after (best effort — under a flood of output a
few lines can be repeated or missed).

Known differences from a terminal on an iGhostVT host:

- Terminal modes are not forwarded (herdr's frames do not carry them):
  bracketed paste, application cursor keys, the kitty keyboard protocol,
  focus events. Pasting several lines into a shell runs them line by line.
- Full-screen programs (an agent's TUI, vim, less) keep their content out of
  the scrollback and scroll themselves. While one runs, the device's terminal
  reports the mouse and a swipe reaches the program the way the wheel does
  in herdr's own window: as wheel events for a program that reads the mouse,
  as arrow keys for one that does not. A fling is paced to the program's
  drawing (a few steps queued at most, dropped when the swipe turns), so the
  view stops when the finger does. Taps reach it on herdr 0.9.2 and
  later; on older herdr they are dropped. Raw mouse reports never go to a
  program as typed input. Selecting text still works there: on iPhone and
  iPad a double tap selects a word, a triple tap a row, and the handles
  extend it; in the Mac app, Shift-drag. A shell without history yet (new,
  or just cleared) is not treated as full-screen.
- The bell and OSC 52 clipboard writes do not reach the device. The pane's
  title does: the bridge passes herdr's on.
- A session is shown at one size at a time: the device holding it sets the
  pane's size in herdr while it is attached.
- The bridge serves one herdr server: the default session, or the one named
  by `session`. Other herdr servers' startup hooks leave it alone.

## Files

In the plugin's state directory (`~/.local/state/herdr/plugins/ghostvt`):

| File | Contents |
|---|---|
| `state.json` | The host id, the paired devices and their keys, the relay host key (mode 0600) |
| `sessions.json` | Which herdr terminals are which iGhostVT sessions |
| `daemon.log` | The bridge's log |
| `ctl.sock` | How the actions and `src/cli.js` reach the bridge |

The relay configuration is kept as `relay.vtrpsc` in the config directory.

## Command line

```sh
node src/cli.js status [--json]
node src/cli.js pair [--relay]
node src/cli.js unpair <device id>
node src/cli.js relay import <file> | relay remove
node src/cli.js rename [name]
node src/cli.js start | stop
```

## Development

```sh
npm test
```

The interop tests check the plugin against the real iGhostVT code on macOS:
pairing with corecrypto's SPAKE2+, sessions over Network.framework's TLS-PSK,
and a local build of the relay. They need an iGhostVT checkout next to this
one (or `IGHOSTVT=…`), Xcode and Go:

```sh
make -C interop          # builds interop/build/{spake-oracle,ghostvt-client,ighostvt-relay}
npm test
```

They run against a herdr server of their own (`herdr --session
ghostvt-test-<pid>`), never the user's.

| Path | What |
|---|---|
| `src/remote/` | The iGhostVT host: listener, client protocol, pairing, relay, Bonjour |
| `src/crypto/` | P-256 and SPAKE2+ (corecrypto's variant) |
| `src/wire/` | IOWire frames, the XPC value codec, and an LZVN encoder for frame compression |
| `src/herdr/` | herdr's socket API, terminal streams, the session registry |
| `src/daemon/` | The background process and its control socket |
| `src/panes/`, `src/actions/` | The popup panes and the actions that open them |

## License

MIT — see [LICENSE](LICENSE).
