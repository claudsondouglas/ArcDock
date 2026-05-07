# ArcDock — instructions for Claude

A minimalist GNOME Shell extension (macOS Tahoe style) that shows only running apps, with auto-hide, on the bottom edge of the primary screen.

## How to reload after editing JS

- **Xorg (preferred for dev):** `Alt+F2` → `r` → `Enter`. Restarts gnome-shell and forces module reimport. This is the path used in this project.
- **Wayland:** `gnome-extensions disable arcdock@claudson; gnome-extensions enable arcdock@claudson` *may* work, but on GNOME 46+ the ESM module cache often reuses the in-memory module — JS edits stay invisible. If new logs don't show up after enable, the only reliable path is logout/login.
- CSS-only changes (`stylesheet.css`) reload along with the shell. There's no cheaper reliable trick.

## Architecture

```
extension.js              — entry point: ArcDockExtension.enable/disable, instantiates Dock.
src/
├── config.js             — SIZE, ANIM, TIMING, State (Object.freeze constants).
├── trackers.js           — SignalTracker, TimeoutTracker.
├── cursor.js             — cursor helpers (setPointer/setDefault).
├── iconAnimation.js      — attachHoverPress(button): cursor + hover tooltip.
├── dockIcon.js           — DockIcon (St.Button per app, click/middle-click).
├── showAppsIcon.js       — ShowAppsIcon (menu St.Button, opens overview).
├── autoHide.js           — AutoHide (animates translation_y, pointer polling).
└── dock.js               — Dock (chrome container + panel + Map<appId, DockIcon>; layout).
```

One class = one file = one responsibility. **Anything that needs cleanup never lives loose outside a tracker.**

### Import rules
- External imports (`gi://`, `resource:///`) first.
- Blank line.
- Relative imports (`./config.js` etc.) afterwards.
- `extension.js` at the root is the only file whose path is fixed by GNOME — everything else lives under `src/` to make it clear what's an entry point and what's an internal module.
- Relative paths always with explicit `.js` extension (ESM in GJS requires it).

## Code conventions

### Naming and visibility
- Class public surface: names with no prefix (`destroy`, `state`, `setHideDistance`).
- Private: `_` prefix (`_show`, `_isInLiveArea`, `_panelSize`).
- Top-level constants in UPPER_SNAKE grouped in `Object.freeze({...})` objects per category (`SIZE`, `ANIM`, `TIMING`, `State`).

### State
- Magic strings for state (`'hidden'`, `'showing'`, etc.) **never loose** — always via a frozen enum (`State.HIDDEN`).
- Comparisons always against the constant: `if (state === State.SHOWN)`.

### Lifecycle
- Every class that connects signals, registers timeouts, or allocates actors **must have `destroy()`** that cleans up **everything** it created. No exceptions.
- `destroy()` is idempotent when possible (check `null` before destroying).
- Trackers (`SignalTracker`, `TimeoutTracker`) preferred over loose `_xxxId` fields — they reduce the chance of leaks when adding new connections.
- In GNOME Shell, forgetting a `disconnect` or `source_remove` causes: callbacks running after `disable()`, exceptions from destroyed actors, and noisy logs. **Cleanup is part of the contract, not a detail.**

### Clutter animations
- Always `actor.remove_all_transitions()` before starting a new `ease()` that may conflict with the previous one.
- Logical state (`_state`) changes in `onComplete` — not at the moment of calling `ease`. This prevents state from diverging from what the user is seeing.
- Easing per context: `EASE_OUT_QUAD` for entry (fast at the end), `EASE_IN_QUAD` for exit (fast at the start).

### Layout / positioning
- To read dimensions before allocation, use `actor.get_preferred_height(forWidth)` / `get_preferred_width(forHeight)`. **Do not rely on `actor.height` or `actor.width`** right after adding children — returns 0 or stale.
- Reposition on the panel's `notify::height` (not in `idle_add`) — fires automatically when children change.

### Pointer / hover detection
- `St.Widget` with `track_hover` + `notify::hover` is fragile for small chrome areas (Wayland especially). For auto-hide, **prefer polling via `GLib.timeout_add` + `global.get_pointer()`** with explicit geometric calculation of the area of interest — works on any compositor, in any fullscreen state.
- 100ms is a reasonable cadence (10Hz) — imperceptible to the user and very low overhead.

### Chrome (`Main.layoutManager.addChrome`)
- `affectsInputRegion: true` — required to receive events with maximized windows.
- `affectsStruts: false` — don't reserve workspace area (it's an overlay, not a fixed dock).
- `trackFullscreen: true` — automatically hidden in fullscreen apps.
- Always `removeChrome` before `destroy()` on the actor.

### What **not** to do
- Don't use `console.log` for output that must always show — on some versions it's filtered below `notice`. Use `console.warn` (warning level) or `logError` for errors.
- Don't call `Edit`/`refresh` in a loop without an early return — refresh already aggregates adds/removes idempotently, but recursive calls via signals can cause loops.
- Don't use an invisible `St.Widget` as a hot edge — pointer watcher is more robust.
- Don't forget `set_pivot_point` when scaling (without it, scale grows from the top-left, not from the center/bottom).

## Testing a change

1. Edit `extension.js`.
2. `Alt+F2 → r → Enter`.
3. Check the journal: `journalctl --user -f -o cat _COMM=gnome-shell` — there should be no `[ArcDock]` warnings/errors. CSS shadow warnings are pre-existing (multiple shadows are not supported in GNOME CSS).
4. Smoke test:
   - Move the mouse to the bottom edge → dock animates up.
   - Move the mouse away → after ~350ms it goes down.
   - Left click on an icon → activates the app.
   - Middle-click → closes the app.
   - Hover an icon → tooltip above the icon.

## Files

- `extension.js` — entry point. Keep it **thin**: only `Dock` instantiation and cleanup.
- `src/*.js` — modules by responsibility (see tree above).
- `stylesheet.css` — visuals (translucent gradient, border, shadow). Inner highlight via `inset` + outer glow in a single comma-separated `box-shadow` (GNOME CSS warns about multiples, it's just a warning).
- `metadata.json` — UUID, version, GNOME shell-version compat.

## Tunables (constants in `src/config.js`)

| Constant | Default | What it does |
|---|---|---|
| `SIZE.ICON` | 48 | px of the app icon |
| `SIZE.BOTTOM_MARGIN` | 12 | gap between dock and bottom edge |
| `SIZE.HOT_EDGE` | 4 | thickness of the strip that triggers show |
| `SIZE.LIVE_BUFFER` | 8 | px tolerance around the visible dock before starting hide |
| `ANIM.HOVER_SCALE` | 1 | kept for headroom calculation; no scale on hover |
| `ANIM.HOVER_LIFT` | 0 | kept for headroom calculation; no lift on hover |
| `ANIM.HOVER_IN_MS` / `HOVER_OUT_MS` | 140 / 120 | legacy; current hover visual uses tooltip without scale/lift |
| `ANIM.SHOW_MS` / `HIDE_MS` | 220 | duration of dock animations |
| `TIMING.POINTER_POLL_MS` | 100 | pointer polling frequency |
| `TIMING.HIDE_DELAY_MS` | 350 | delay before hiding after mouse leaves |
