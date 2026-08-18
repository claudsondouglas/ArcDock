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
├── iconButton.js         — IconButton: base St.Button (host/stage, tooltip, DND, menu).
├── dockIcon.js           — DockIcon extends IconButton (per app: dots, windows, actions).
├── folderIcon.js         — FolderIcon extends IconButton (filesystem folder, async I/O).
├── dockItemsStore.js     — DockItemsStore: ordered typed ids in GSettings + ItemType/makeId/parseId.
├── recentAppsHistory.js  — RecentAppsHistory: "recently opened" queue in GSettings (no signals).
├── showAppsIcon.js       — ShowAppsIcon (menu St.Button, opens overview).
├── magnification.js      — Magnification (macOS-style hover zoom: host scale + button width).
├── autoHide.js           — AutoHide (animates translation_y, pointer polling).
├── windowAnimations.js   — WindowAnimations (minimize via Mutter icon geometry, open via custom actor ease).
└── dock.js               — Dock (chrome container + panel + Map<itemId, IconButton>; layout).
```

One class = one file = one responsibility. **Anything that needs cleanup never lives loose outside a tracker.**

### Dock items

An item is a typed id string, `type:value` — `app:firefox.desktop`, `folder:/home/u/Downloads`,
`group:<id>` (reserved, not rendered yet). `parseId` splits on the FIRST `:` only, because the
value is a path and may contain more.

- Persisted in the GSettings key `dock-items` (`as`), **ordered**. `prefs.js` runs in a separate
  process, so GSettings gives `changed::` in both directions for free — an INI would need a
  `GFileMonitor`. The legacy `pinned-apps.ini` is imported once, guarded by `dock-items-migrated`;
  never treat "empty list" as "not migrated", since emptying the dock is a valid user choice.
- `Dock._iconOrder` covers ALL visible icons including unpinned running apps (volatile); the store
  covers only persisted ones. Dragging reorders both but never promotes a volatile app to pinned.
- An id whose type this version cannot render must be **skipped silently and preserved** on write.
  Anything else makes an older version silently delete a newer version's items.
- `_refresh()` never writes to the store. Only `toggle`/`remove`/`_persistOrder` do, and each
  suppresses the echo of its own write — otherwise `changed::` bounces straight back into
  `_refresh()`.

### Recently opened

Mirrors macOS's "Show recent applications in Dock": up to `RECENT.VISIBLE` apps in their own box,
before the Applications button, behind the `show-recent-apps` key.

- History lives in `recent-apps` (`as`, most recent first) and is written **always**, even with the
  section switched off — turning it back on must find a populated queue. **Nothing listens to
  `changed::recent-apps`**: an app opening writes the key, and a listener would bounce that write
  back into the refresh/restart that caused it.
- "Started running" comes from `app-state-changed` with `Shell.AppState.RUNNING`, never from
  diffing the running set between refreshes: the dock is recreated on every pref change, monitor
  change and wake, and the first refresh of each new dock would stamp every already-open app as
  freshly opened.
- Shown are the first entries that are neither pinned nor already drawn in the main box. An app id
  that `lookup_app` can't resolve is skipped **in the display only** — never dropped from history.
- Recent icons live in `Dock._recentIcons`, a Map separate from `_icons`, so they stay out of
  `_iconOrder`, out of the persisted order and out of drops (`_isReorderable` requires the source
  id to be in `_iconOrder`).

### Running indicator

`DockIcon` keeps the indicator in its own fixed-layout container inside `host` (never inside
`stage`), so switching styles can't change the icon's size. Pips are positioned by hand rather than
by a `St.BoxLayout` with `spacing`: that spacing comes from the CSS theme, and it has to match
exactly the width used to center the container.

- Styles come from `IndicatorStyle` in `config.js` and MUST stay in sync with the `choices` of the
  `running-indicator-style` gschema key.
- `_updateRunningIndicator()` rebuilds only when `style:windowCount` changes — `_refresh()` calls
  `setTarget()` on every icon whenever any window changes, and rebuilding actors on each of those
  would be pure churn.

### Magnification

macOS-style hover zoom, behind `magnification-enabled`, tuned by `magnification-scale`
(1.1–2.0) and `magnification-falloff` (50–400 px). Curve:
`scale(d) = 1 + (S−1)·cos²(π·d/(2·F))` for `d < F`, where `d` is the horizontal distance from
the pointer to the icon's **resting** center. `cos²` has zero derivative at both ends, so no
step at the falloff edge and no jitter when the pointer crosses an icon.

- `scale_x/scale_y` does NOT change allocation, so the effect has two halves per icon:
  **scale on `host`** (pivot `(0.5, 1.0)`, visual only) and **explicit width on the button**
  (`set_width`), which is what pushes the neighbours. Width changes the horizontal allocation
  and nothing else — the panel's preferred height is untouched, so this never feeds back into
  the `notify::height` that drives `_reposition()`.
- The scale target is `host` and **never `stage`**: press/bounce/entry own the stage
  (`_animActor`), and being different actors the two scales compose multiplicatively with
  neither knowing about the other. Never call `remove_all_transitions()` from the magnifier —
  only `remove_transition('scale-x'/'scale-y'/'width')`.
- Both hosts (`IconButton`, `ShowAppsIcon`) are `x_align: CENTER`. With the default FILL, a
  widened button would stretch the host and — since the host uses fixed layout — leave the icon
  glued to the left edge of its slot.
- Resting centers are **reconstructed**, never read raw: an inflated icon moves away from the
  pointer, so feeding its current center back in would make the scale depend on itself. The
  panel is centered, so a total extra width `E` shifts the left edge by `E/2` and each icon
  additionally by the extras of the icons to its left — inverted, that gives the resting center.
- Tracking is `motion-event` on the panel, applied **without ease** (the effect follows the
  finger; easing here is late rubber). The only animated moment is the way back, on
  `notify::hover` going false. `notify::hover` and not `leave-event`: moving from the panel onto
  a child also emits leave on the panel, and St already filters that (`st_widget_leave` checks
  containment of the related actor).
- Reset paths that are NOT the pointer leaving: `notify::mapped` false (auto-hide hides the
  container without any crossing event) and `setEnabled(false)` from `Dock._suppressHover()`
  during a drag (drop indices are computed from natural widths).
- `getIcons` is re-evaluated on every event — icons are created and destroyed by any `_refresh()`
  and a cached list would hold dead actors. The only per-icon state (`_magBaseWidth`,
  `_magExtraWidth`) lives on the actor and dies with it. The base width must be measured
  **before** the first `set_width`: after it, `get_preferred_width` returns the width we fixed.
- `Dock._reposition()` adds `(S−1)·SIZE.ICON` to the headroom when the effect is on (pivot is at
  the base, so the icon grows upward), and subtracts `magnification.extraWidth` from the panel's
  preferred width, because blur backdrop, live area and input catcher are all *resting*
  geometry. `_dockHorizontalBounds()` adds that same extra to the live rect: the panel really is
  wider while magnifying, and following the outermost icon with the pointer would otherwise fall
  outside the live area and schedule the auto-hide. Vertically nothing changes — the effect only
  exists while the pointer is over the panel, which is inside the rect.

### Click to minimize

Enabled by the `click-to-minimize` key. `_windowToActivate()` returns `null` to mean "this click
should minimize"; that only happens when the app is focused and there is no other **non-minimized**
window to raise. Minimized windows are deliberately not cycle targets when the setting is on —
otherwise a click would restore them and a multi-window app would never reach the minimize step.

### Window animations

Behind `window-animations-enabled`. Minimize/unminimize ride the **native** Mutter animation:
`WindowAnimations` just keeps every NORMAL window's `set_icon_geometry()` pointed at its dock
icon, and the compositor does the "genie" on its own. Open has no such extension point, so it's
the one hand-rolled animation: the default is suppressed and a custom scale/translate/opacity
ease from the icon rect plays instead.

- Suppressing the default open animation patches `Main.wm._shouldAnimateActor`, never
  `Main.wm._mapWindow`: the Shell connects `map` to `_mapWindow.bind(this)` in the constructor, so
  reassigning `_mapWindow` later swaps a property nobody calls — the bound closure already
  captured the original function. `_shouldAnimateActor` is looked up fresh (`this._shouldAnimateActor(...)`)
  on every call, so replacing it on `Main.wm` actually takes effect.
- The predicate's `types` argument is identical between a map, a minimize and a destroy, so it
  can't tell them apart. `window-created` seeds a `WeakSet` of windows pending their first map;
  the predicate consumes (deletes) the entry for the current window, and only a hit means "this
  call is the map" — a window born already minimized is never added, so its first restore isn't
  misread as an open.
- Icon geometry alone drives minimize/restore because that's the entirety of the native path: no
  handler is connected for it, `set_icon_geometry()` is the whole contract, and Mutter reads it
  again on every minimize.
- `getIconRect` (passed in by `Dock` as `_iconRectForWindow`) returns **resting** stage
  coordinates by subtracting `_container.translation_y` — auto-hide animates that field on the
  container, so the raw transformed position would target wherever the dock happens to be
  mid-animation instead of where the user actually sees the icon.
- `getIconRect` runs inside the Shell's animation predicate, on every map/minimize/destroy of any
  window in the session — a hot path — so it never throws: window-tracker lookups are wrapped in
  try/catch, and `WindowAnimations._iconRect` catches whatever escapes the callback and logs
  instead of propagating (an exception here would break the animation of every window, not just
  one app's).
- `Dock` calls `syncIconGeometry()` from exactly one place, the end of `_reposition()` — every
  icon-moving path (`_refresh()`, `monitors-changed`, the panel's `notify::height`) already funnels
  through it. Known accepted gap: a drag-drop reorder leaves geometry stale until the next
  `_refresh()`.
- Disabling the setting clears geometry on every window (`set_icon_geometry(null)`, restoring the
  Shell's default minimize animation) and restores the original `_shouldAnimateActor` before
  going idle. `Dock.destroy()` calls `_windowAnimations.destroy()` before the icons and before
  magnification: while the patch is still installed the Shell can still ask for a rect, and
  destroying icons first would leave that callback resolving against dead actors.

### Filesystem I/O

**Never synchronous.** This runs inside the compositor process: a sync `query_info()` on a dead
network mount freezes the whole session. Use `*_async` with a `Gio.Cancellable`, cancel it in
`destroy()`, and re-check validity inside every callback before touching an actor.

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
| `INDICATOR.DOT_SIZE` / `DOT_SPACING` | 5 / 3 | px of each running dot and the gap between dots |
| `INDICATOR.MAX_DOTS` | 4 | cap on per-window dots (above it nobody counts at a glance) |
| `INDICATOR.BAR_HEIGHT` / `BAR_WIDTH_RATIO` | 3 / 0.45 | bar style: height in px, width as a fraction of the icon |
| `INDICATOR.CENTER_Y_OFFSET` | 0.5 | vertical center of the indicator, measured from the icon's bottom edge |
| `RECENT.VISIBLE` / `HISTORY_MAX` | 3 / 10 | recent apps shown next to the Applications button, and how many the history remembers |
| `MAGNIFICATION.MIN_SCALE` / `MAX_SCALE` / `DEFAULT_SCALE` | 1.1 / 2.0 / 1.5 | hover zoom limits; must match the `<range>` of `magnification-scale` |
| `MAGNIFICATION.MIN_FALLOFF` / `MAX_FALLOFF` / `DEFAULT_FALLOFF` | 50 / 400 / 150 | px from the pointer where the zoom dies out; must match `magnification-falloff` |
| `MAGNIFICATION.RELAX_MS` | 150 | the only eased part of the zoom: the way back when the pointer leaves |
| `RECENT.SEPARATOR_*` | 1 / 0.6 / -4 | divider before the recents section: width in px, height as a fraction of the icon, and the lift that aligns it with the icons instead of the row box |
| `ANIM.WINDOW_OPEN_MS` | 250 | duration of the custom open-from-icon animation (`window-animations-enabled`) |
