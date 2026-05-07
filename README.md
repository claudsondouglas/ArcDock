# ArcDock

An attempt to bring the **macOS Tahoe Dock** look to GNOME Shell.

A minimalist extension written from scratch, focused on recreating the feel of
Apple's dock — frosted glass, hover tooltips, smooth reveal when the cursor
hits the bottom edge — using only native GNOME Shell APIs (Clutter, St,
Shell.BlurEffect).

![ArcDock screenshot](https://i.postimg.cc/L51nJHVk/Captura-de-tela-de-2026-05-06-21-49-58.png)

## Features

- **Auto-hide** with a hot-edge on the bottom of the screen and pointer polling.
- **Translucent glass** via `Shell.BlurEffect` in background mode.
- **Hover tooltip** above icons, no scale/lift.
- **Running apps only** — no pinned favorites, mirroring the default macOS
  dock behavior.
- **Show Apps button** that opens the overview's app grid.
- **No click leakage**: a full-screen reactive overlay below the dock ensures
  clicks outside icons never reach the window underneath.

## Requirements

- GNOME Shell **46**

## Installation

### 1. Clone the repository into the GNOME extensions directory

The folder name **must** be exactly `ArcDock@claudson` (it's the UUID declared in `metadata.json`):

```bash
git clone https://github.com/claudsondouglas/ArcDock.git \
  ~/.local/share/gnome-shell/extensions/ArcDock@claudson
```

> If you prefer SSH: `git@github.com:claudsondouglas/ArcDock.git`.

### 2. Reload GNOME Shell

So the shell picks up the new extension:

- **Xorg:** `Alt+F2`, type `r`, `Enter`.
- **Wayland:** log out and log back in (no runtime shell reload).

### 3. Enable the extension

```bash
gnome-extensions enable ArcDock@claudson
```

Or via the **Extensions** app (`gnome-extensions-app`) — search for *ArcDock* and flip the switch.

### 4. Verify

Move your cursor to the bottom edge of the primary screen — the dock should slide up smoothly. If nothing happens, check the journal:

```bash
journalctl --user -f -o cat _COMM=gnome-shell | grep -i arcdock
```

### Update

```bash
cd ~/.local/share/gnome-shell/extensions/ArcDock@claudson
git pull
```

Then reload the shell (step 2).

### Uninstall

```bash
gnome-extensions disable ArcDock@claudson
rm -rf ~/.local/share/gnome-shell/extensions/ArcDock@claudson
```

## Status

Experimental, evolving project. Technical documentation and architecture in
[`CLAUDE.md`](./CLAUDE.md).

## License

MIT.
