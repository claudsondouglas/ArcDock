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
├── appUsageDatabase.js   — asynchronous bridge to ~/Documents/arc/apps.db (click/open telemetry).
├── showAppsIcon.js       — ShowAppsIcon (menu St.Button, opens overview).
├── appActionsMenu.js     — fillAppActionsSection(): "Nova janela" + .desktop actions, shared by both menus.
├── desktopShortcut.js    — DesktopShortcut: copies a .desktop to the desktop folder (async, +x, trusted).
├── magnification.js      — Magnification (macOS-style hover zoom: host scale + button width).
├── dockSlotOverlay.js    — DockSlotOverlay: the single lit cell of a drag, painted outside the layout.
├── dockDragReflow.js     — DockDragReflow: the neighbours opening the reserved cell by translation_x.
├── dockGhostFlight.js    — DockGhostFlight: adopts the dnd drag actor and flies it into the cell.
├── autoHide.js           — AutoHide (animates translation_y, pointer polling).
├── windowAnimations.js   — WindowAnimations (minimize via Mutter icon geometry, open via custom actor ease).
├── fullscreenWatcher.js  — FullscreenWatcher (primary monitor in fullscreen → dock force-hidden).
├── dock.js               — Dock (chrome container + panel + Map<itemId, IconButton>; layout).
└── appsLauncher/         — the full-screen Launchpad-style app grid:
    ├── launcher.js       — AppsLauncher (modal overlay, search, paging, DND wiring, folders).
    ├── launcherLayout.js — LauncherLayout: user order + folder records in GSettings; normalization.
    ├── appGridIcon.js    — AppGridIcon: one grid cell (app OR folder), drag source and drop target.
    ├── appGridMenu.js    — AppGridMenu: the cell's context menu (actions, pin to dock, shortcut).
    ├── gridSlot.js       — GridSlot: the fixed cell an icon lives in; paints the hole and the drop target.
    ├── folderPreview.js  — createFolderPreview(): the 3x3 folder cover.
    ├── folderPopup.js    — FolderPopup: the open-folder panel with the editable name.
    ├── appList.js        — installed apps + fuzzy search filtering.
    └── fuzzyMatch.js     — the scoring itself.
```

One class = one file = one responsibility. **Anything that needs cleanup never lives loose outside a tracker.**

### Panel sections

The panel is three boxes with a divider between them, and the Applications button glued to the
end of the last one:

```
apps (pinned or running) | recently opened | folders + Applications
```

- The button is the end of the dock, not a section: it never gets a divider of its own.
- A divider is only drawn between two sections that **both** have content, so with no recents the
  row reads `apps | folders + button` and with no folders `apps + button`.
- Apps and folders are separate boxes (`_appsBox`/`_foldersBox`) rather than one ordered by
  `_iconOrder`, because recents sit *between* them and a single `St.BoxLayout` can't open a gap
  in its middle. `_iconOrder` stays a single list — it is the order the store persists — and each
  box consumes only the ids of its own type (`_boxForId`), so what the list dictates is the
  relative order *inside* each section.
- Each box is its own drop target (`_dropDelegate(box)`), and a section only accepts its own type:
  the DND handler receives coordinates already converted to the target's space but not the target
  itself, so one shared delegate would leave `x` ambiguous between the two boxes. `_reorder()`
  converts the section-local drop index back to a global `_iconOrder` position via the neighbour
  that occupies the slot — an item never crosses the boundary between sections by dragging.

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
between the apps and the folders (see **Panel sections**), behind the `show-recent-apps` key.

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

### App usage database

`AppUsageDatabase` records icon activations from both the dock and built-in launcher, plus the
same RUNNING transitions that feed `RecentAppsHistory`. The data lives in
`~/Documents/arc/apps.db`: `apps` is the aggregate, while `app_clicks` and `app_opens` retain the
events. GNOME Shell has no SQLite GI binding on the target system, so the JS bridge launches
`scripts/app_usage_db.py` asynchronously; the helper owns schema creation, WAL transactions and
parameter binding. A single instance owned by the extension serializes events through an async
queue, so dock rebuilds and rapid clicks cannot race each other. Never execute database work
synchronously on the compositor thread.

The extension object exposes `recordExternalAppClick(appId, appName, source)` for sibling
extensions. The public boundary accepts primitive strings only and forwards to the same queue;
callers never receive the database object. ArcDesk uses `source = 'arcdesk'` and resolves the
active ArcDock extension afresh for every activation.

### Running indicator

`DockIcon` keeps the indicator in its own fixed-layout container inside `host` (never inside
`stage`), so switching styles can't change the icon's size. Pips are positioned by hand rather than
by a `St.BoxLayout` with `spacing`: that spacing comes from the CSS theme, and it has to match
exactly the width used to center the container.

- Styles come from `IndicatorStyle` in `config.js` and MUST stay in sync with the `choices` of the
  `running-indicator-style` gschema key.
- The light theme paints the dot **white, opaque, with no `box-shadow`**, and one pixel smaller
  (`INDICATOR.DOT_SIZE_LIGHT`). The size can't come from CSS: the pip's `width`/`height` are set in
  JS, so `Dock` picks the value from the theme and passes it down as `indicatorDotSize`.
  The `running-dot-theme-color` key overrides that color inline with the GNOME theme's foreground —
  in a light GTK theme that is near-black, which is precisely the dot the dock theme is trying not
  to draw. It stays opt-in and off by default.
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

### Tooltips

The hover bubble is behind `show-tooltips` (default on), and the flag lives as **module state in
`iconAnimation.js`** — same shape and same reason as `tooltipTheme`: there is one dock per session
and the bubble is created inside that module, so neither `IconButton` nor its subclasses have to
carry the preference just to hand it down.

- **This key does not restart the dock.** Every other preference goes through
  `ArcDockExtension._restartDock()`, but showing the bubble is a gate inside `_showTooltip()`:
  `Dock`'s constructor calls `setTooltipsEnabled()` and connects `changed::show-tooltips`, and the
  change lands on the next hover without recreating a single icon.
- **Turning it off closes a bubble that is already up.** `tooltipOwner` is the one button currently
  showing one (only one icon is hovered at a time). Without it a `gsettings set` from a terminal —
  or a toggle on another monitor — would leave the bubble painted over the desktop until the next
  hover, because it lives in the `uiGroup` and not in the button's tree.
- Nothing else about hover changes: the cursor still turns into a pointer, the icon still
  highlights and presses, and the hover watchdog still runs.

### Click to minimize

Enabled by the `click-to-minimize` key. `_windowToActivate()` returns `null` to mean "this click
should minimize"; that only happens when the app is focused and there is no other **non-minimized**
window to raise. Minimized windows are deliberately not cycle targets when the setting is on —
otherwise a click would restore them and a multi-window app would never reach the minimize step.

### Fullscreen

Behind `hide-in-fullscreen` (default on). While a window is fullscreen on the primary monitor the
dock is `setForceHidden(true)`: hidden, hot edge dead, input catcher gone.

- The axis is **fullscreen vs maximized**, never "game vs app". A maximized window is still a
  decorated window inside the workspace; a fullscreen one asked the compositor for the entire
  monitor (`_NET_WM_STATE_FULLSCREEN` / xdg-shell `set_fullscreen`), which is the whole "don't
  interrupt me" intent. Every game in exclusive or borderless fullscreen goes through that path,
  so no game detection (`Categories=Game`, wm_class lists, idle inhibitors) is needed or wanted —
  each of those has false positives a fullscreen check doesn't.
- The state is read from `global.display.get_monitor_in_fullscreen(primaryIndex)`, not from
  scanning windows: it is the same value `LayoutManager` uses for `trackFullscreen`, already
  resolved per monitor and already accounting for stacking.
- `setForceHidden`, not `trackFullscreen: true` on the chrome: the Shell's flag only hides the
  actor. The hot edge lives in `AutoHide`'s pointer polling and the input catcher is a separate
  chrome actor — both would stay alive under the game, and the dock popping up on the crosshair
  is exactly the complaint.
- The overview case falls out for free: `_updateForceHidden()` already ORs `_overviewShown`.

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
  through it — and, since the drag rework, the landing of a dropped icon, which is what closed the
  old gap of a drag-drop reorder leaving geometry stale until the next `_refresh()`.
- Disabling the setting clears geometry on every window (`set_icon_geometry(null)`, restoring the
  Shell's default minimize animation) and restores the original `_shouldAnimateActor` before
  going idle. `Dock.destroy()` calls `_windowAnimations.destroy()` before the icons and before
  magnification: while the patch is still installed the Shell can still ask for a rect, and
  destroying icons first would leave that callback resolving against dead actors.

### Dragging a dock icon: the hole, the reflow and the flight

Reordering the dock is the same gesture as reordering the app grid, and it is built from the same
three pieces: the source icon leaves a **hole**, the neighbours **slide aside** to open the cell it
would take, exactly **one cell is lit** as the reserved landing spot, and on drop the dragged art
**flies into that cell** before the row is rebuilt. The machinery lives in `src/dockSlotOverlay.js`
(the lit cell), `src/dockDragReflow.js` (the neighbours) and `src/dockGhostFlight.js` (the flight);
`dock.js` is only the caller.

- **`IconButton` must hand the dnd a drag actor, or there is no hole at all.** Without a
  `getDragActor()`, `dnd.js` takes the *real button* out of the section box and reparents it into
  `Main.uiGroup` — the row closes in the first frame and there is nothing for the neighbours to open.
  So the button provides one (a `Clutter.Clone` of its own art stage; `IconButton` cannot draw
  anybody's icon — the subclass does — and a clone is the only generic way to take a portrait of it
  from there) and stays in the row, **`opacity = 0` plus `Shell.util_set_hidden_from_pick`, never
  `hide()`**. The cell has to keep its allocation *and* stay measurable: the `drag-begin` handler
  runs inside `_gestureRecognized()`, and a few lines below it the dnd measures our
  `getDragActorSource()` to decide where the airborne art is born and where it snaps back to on a
  refused drop — a hidden actor there is invalid geometry, and one NaN in that arithmetic spreads
  all the way into the flight. The clone keeps painting even though its source is at zero opacity:
  `ClutterClone` overrides the source's opacity with its own before painting it, and the override
  short-circuits the parent chain.
- **`opacity === 0` is now what "this icon is being dragged" means**, and every place that used to
  read `visible === false` had to learn that: `_dropIndexAt` counts the source (it still occupies a
  cell), `_applyOrder()` skips restoring its opacity (a `_refresh()` mid-gesture would otherwise put
  the same app in two places at once), and `_iconRectForWindow()` refuses it by opacity instead.
- **The drop target is the whole cell, not the boundary between two of them.** `_dropIndexAt()`
  floors to the column the pointer is inside and clamps past-the-end to the last cell, and the index
  it returns is already the final position in the section's visible order — exactly what
  `_reorder(sourceId, index, box)` takes, so the section-local → global `_iconOrder` conversion is
  untouched. Counting the airborne icon's own cell is what makes the last cell mean "goes to the end
  of the section".
- **The reflow is translation, never re-layout.** The icons between the origin cell and the reserved
  one shift by exactly one cell width via `translation_x`. Reordering children per motion event would
  relayout the whole panel — and, through the panel's `notify::height`, call `_reposition()` — once a
  frame. The shift comes from arithmetic on the cell pitch, never from reading back a position the
  reflow itself just moved, and `handleDragOver` (one call per motion event) bails out when the
  reserved cell has not changed: restarting the same transitions every frame pins them at the first
  instant of the ease and they never arrive.
- **All the geometry is measured in NATURAL widths.** `drag-begin` calls `_suppressHover()`, which
  turns magnification off — but `set_width(-1)` only reaches the allocation on the next layout cycle,
  so reading `child.x` in the same handler returns the still-inflated row.
  `get_preferred_width(-1)` is already the resting width, and the row's origin (`icons[0].x`) is the
  one number magnification cannot move: the first icon of a box is always flush against its edge.
- **The lit cell is painted from a layer that takes no part in the layout.** Dock icons are *not*
  wrapped in slot actors the way grid cells are: the section rows are the `St.BoxLayout`s where
  magnification pushes neighbours by fixing an explicit width on the button, and a fixed-size slot
  container would kill that. Instead a fixed-layout, non-reactive child of `glassHost` holds the
  plate, positioned in the section box's own coordinates. Three traps live in that one actor:
  - It is the **last** child of `glassHost` on purpose. A `Clutter.BindConstraint` is what glues it
    to the section box, and a constraint reads the source's allocation at the moment the *constrained*
    actor is allocated — children are allocated in tree order, so a layer sitting below the panel
    would read the previous frame's box. That matters most in the first instant of the gesture, when
    magnification has just been switched off and every width in the row is about to change. The price
    is painting above the icons, and it is cheap: the lit cell is, by construction, the empty one.
  - Its **natural size is zero**, and the constraint is what gives it a size. Otherwise it would
    enter `BinLayout`'s preferred-size arithmetic and could stretch the glass pill itself because of
    a decoration square.
  - Layer and plate are **out of the pick**, not merely non-reactive — the same wall documented for
    the launcher's ghost layer. `PickMode.ALL` sees non-reactive actors, so a layer over the panel
    would stop the pick, and its parent has no `_delegate`: the whole dock would go inert for drops
    from the first drag on.
- **One cell is lit, and it is the reserved one.** At `drag-begin` the reserved cell is the origin,
  painted `EMPTY` — nothing has moved yet, and that is where the icon returns if the gesture ends
  where it started. From the first `handleDragOver` on it is the cell under the pointer, painted
  `TARGET` (one extra hairline). With the neighbours closing the hole behind the dragged icon, the
  only real gap on screen is the cell it will land in; a second lit square would announce a second
  free place, and one of them would be a lie.
- **The dropped icon flies to its cell, and the reorder waits for it.** `acceptDrop` receives the dnd
  drag actor and *adopts* it — dnd destroys that actor only if it is still a child of `Main.uiGroup`
  (dnd.js), so reparenting it into our ghost layer is what buys the animation. The reorder is the
  flight's **landing callback**, not something `acceptDrop` does: the real icon appears in the frame
  the ghost finishes, which is the seam that makes them read as the same object. While the ghost is
  in the air the source icon is kept hidden (`IconButton` shows itself again at `drag-end`, as it does
  at the end of every gesture), the **reflow stays standing** (the ghost lands exactly in the cell the
  neighbours opened, and zeroing the translations at `drag-end` would snap the row back and then
  forward again), and hover/magnification stay suppressed — resuming them would let the panel inflate
  under the pointer while the ghost is still aiming at a cell measured in resting widths. The
  translations are zeroed **without animating** right after `_applyOrder()`: the new allocation puts
  every icon on the very pixel its translation was drawing it at, so the zero is invisible.
- **A flight that never lands would strand the whole gesture**, so `DockGhostFlight` never lets the
  callback be lost: a non-finite geometry, a failed adoption or a missing destination runs it
  synchronously instead of flying, a *removed* transition (which never fires its `onComplete`) is
  covered by zeroing the counter by hand wherever ghosts are killed, and an independent watchdog
  timer force-lands anything still counted after the duration plus a slack, with a line in the
  journal. Without it the order would never be applied, the source icon would stay invisible and the
  dock would stay hover-dead — the classic "it only works the first time".
- **The pick flag has to be undone by hand after a flight.** `_applyOrder()` restores visibility and
  opacity but knows nothing about the pick, and the flight path takes the source out of it. Landing
  goes through `_showDragSource()` first; without it the icon comes back on screen permanently inert —
  no click, no hover, no menu.
- **Nothing of ours may throw inside the dnd's `emit`.** `_Draggable` is a `Signals.EventEmitter`: its
  `emit()` walks the handlers in a plain JS loop with no try/catch, `drag-begin` comes from inside
  `_gestureRecognized()` and `drag-end` from inside `_dragActorDropped()`. An exception of ours rides
  that emit up and aborts the rest of the gesture — including `_dragComplete()`, which is what pops
  the modal grab pushed at the start of the drag. The symptom is not a lost gesture, it is the whole
  session's dnd wedged. So `IconButton._dragGuard` and `Dock._dndGuard` wrap every callback we hand
  to the Shell; dnd's own try/catch covers only the `acceptDrop` call.
- **Every end that is not a successful drop eases the row home**: a refused drop, a cancel, a drop
  that changed nothing and the pointer leaving the panel all go through `_clearDragDecor()`. The
  pointer leaving is only knowable through a `DND.addDragMonitor` — `handleDragOver` runs only while
  we are the target and there is no `handleDragOut` — and clearing there also marks the session
  **stale**: undoing the reflow ends its bookkeeping (which cell was the origin, who was displaced),
  and without the mark the `handleDragOver` on the way back would find a session that calls itself
  good over a reflow that no longer knows where to start, and the row would never open again for the
  rest of the gesture. `acceptDrop` still returns **true when nothing changed**: a drop in the same
  cell was handled, and returning false would fly the art back to its origin as if the gesture had
  failed.
- **A `_refresh()` in the middle of a gesture invalidates the session, and says so.** `_applyOrder()`
  marks it stale and the next `handleDragOver` rebuilds it from the row that is actually on screen —
  the indices a session holds describe a row that no longer exists. This is also the path that covers
  a `drag-begin` where something blew up before the session was established.
- **The sections do not change.** A drop still lands only in the source's own section
  (`_acceptsDrop`), recents are still not a drop target and still not reorderable (`_isReorderable`
  gates on `_iconOrder`), and `_persistOrder()`'s "ids this version cannot render stay anchored"
  behaviour is untouched. Dragging a recent still goes through `IconButton`'s opacity trick, so its
  row keeps a hole instead of collapsing — but no cell is lit and nothing reflows, because there is
  no position for it to take.
- **The landing calls `_reposition()`**, which is the single funnel for `syncIconGeometry()`: a
  drag-drop reorder moves icons without going through `_refresh()`, and the previously accepted gap
  of "minimize animations aim at the old position until the next refresh" is closed with it.

### Apps launcher: user order and folders

The full-screen grid (`src/appsLauncher/`) is a Launchpad clone: the order is **the user's**, and
dragging one app onto another creates a folder.

- **Nothing is sorted A–Z any more except newcomers.** `getInstalledApps()` still returns a
  collated list, but that order only decides where a *freshly installed* app lands (appended at
  the end) and the tie-break inside search results. The grid itself renders `LauncherLayout.build()`,
  which is the user's arrangement.
- **`LauncherLayout` is the model; the launcher only draws.** Order lives in `launcher-layout`
  (`as`, typed `app:<desktop-id>` / `folder:<uuid>` ids, same `parseId`-on-the-first-colon
  convention as `dockItemsStore`), folder records in `launcher-folders` (`s`, JSON keyed by the
  BARE uuid). **Nothing listens to `changed::` on either key** — the launcher itself is the only
  writer, and a listener would bounce `build()`'s own normalization write straight back into the
  rebuild that produced it (same reasoning as `recent-apps`).
- **`build()` normalizes on every open**, and that is where the rules live: an app that is not
  installed keeps its slot in the stored order but is not drawn (an upgrade that removes the
  `.desktop` for a few seconds must not silently destroy the arrangement); an id type this version
  cannot render is preserved verbatim; and **a folder with fewer than two resolvable members is
  not a folder** — 1 member dissolves back into that app *in the folder's slot*, 0 disappears.
  The rule is checked on every build and not only on drag-out, because uninstalling also shrinks
  a folder.
- **Merge vs. reorder is pure geometry, decided in two different delegates.** `AppGridIcon` is its
  own `_delegate`: the middle of the cell means "make a folder" (`MOVE_DROP`), the
  `MERGE_EDGE_RATIO` slice at each edge returns `CONTINUE` so the event keeps bubbling. The **page**
  actor carries the reorder delegate — the dnd finds a drop target by walking up from the picked
  pixel, so an empty cell or the gap between two of them reaches it for free (the cells are
  non-reactive, which does not matter: dnd picks with `PickMode.ALL`).
- **The grid is slots, and slots never move.** Every cell is a `GridSlot` of fixed size — icon plus
  the label band — and the icon lives inside it. The slots are the fixed frame of the gesture:
  they are what the drop index, the highlight and the ghost's landing rect are all measured
  against, and none of them ever moves.
- **The icons do reflow, by translation.** While a dragged icon travels over the grid the others
  step aside to open the cell it would take (`_applyReflow`), the way Launchpad does. It is
  `translation_x/y` on the `AppGridIcon` itself, never a rebuild: each `_rebuildPages()` recreates
  hundreds of icon textures, and doing that per motion event is unaffordable. The offsets come
  from arithmetic on the metrics (`_cellDelta`: every row has exactly `columns` cells and every
  cell is the same size, so `(col' - col)·cellWidth` is exact) rather than from reading actor
  geometry, which would be reading back a position the reflow itself just moved. The current
  offset map is kept so `handleDragOver` — one call per motion event — can bail out when the
  target cell has not changed.
- **The reflow stops at the page border.** Only icons whose source *and* destination cells are on
  the visible page take part, and if the queue does not fit whole on that page it is not shown at
  all: the icon at the end would move to a page nobody is looking at, and leaving it parked while
  its neighbour advances would put two icons in the same cell — which reads worse than nothing
  moving. In practice that only excludes the two cases where the queue runs off the edge: an app
  coming out of a folder onto a page that is already full, and a drag whose origin is on another
  page. A same-page reorder always fits.
- **One cell is lit, and it is the reserved one.** With the neighbours closing the hole behind the
  dragged icon, the only real gap on screen is the cell it will land in — two lit cells would
  announce two free places, and one of them would be a lie. At the start of the gesture the
  reserved cell is the origin (painted `SlotPaint.EMPTY`: nothing has moved yet); from the first
  `handleDragOver` on it is the cell under the pointer (`TARGET`, one extra hairline border).
- **The drop target is the whole cell, not the boundary between two of them.** `_dropSlotAt()`
  floors to the column instead of rounding to the frontier, and the index it returns is already
  the final position in the visible order — exactly what `moveTo()`/`removeFromFolder()` take.
  Empty cells past the last icon clamp to the last real slot, so the highlight never promises a
  position the layout cannot give. While an icon is lit as a merge target its own `onMergeHover`
  undoes the reflow and hands the reservation back to the **origin** cell: the answer to the drop
  stopped being "goes into this position" and became "joins this icon", and nothing is going to be
  reorganized because of it (the page's `handleDragOver` stops running the moment the icon claims
  the drop, so it cannot notice on its own). The pointer leaving the icon puts the page's handler
  back in charge and the reflow rebuilds itself.
- **The dropped icon flies to its slot, and the rebuild waits for it.** `acceptDrop` receives the
  dnd's drag actor and *adopts* it — dnd destroys that actor only if it is still a child of
  `Main.uiGroup` (dnd.js), so reparenting it to the launcher's ghost layer is what buys the
  animation. It flies to the destination slot's art rect (into the target icon's, shrinking and
  fading, when the drop makes a folder), and only when it lands does the grid rebuild, so the real
  icon appears in the frame the ghost finishes. While a ghost is in the air the source icon is
  kept hidden — `AppGridIcon` shows itself again at `drag-end`, and without that the same app
  would be in two places at once. The **reflow stays standing** for that same window: the ghost
  lands exactly in the cell the neighbours opened, and zeroing the translations at `drag-end`
  would snap the grid back and then forward again one idle later. Only the rebuild clears it —
  fresh icons are born with no translation. Every other end of gesture (refused drop, cancel,
  a drop that changed nothing) goes through `_clearTargetSlot()`, which eases everyone home.
- **Every layout mutation rebuilds through `_scheduleRefresh()`, never inline.** `acceptDrop`
  returns into dnd code that is still holding the drag actor and the source cell; destroying the
  grid inside it pulls the rug out. The rebuild is one idle callback later and keeps the current
  page. A flight in progress dams it (`_flushRefresh` opens the dam), and a *removed* transition
  never fires its `onComplete` — so the flight counter is zeroed by hand wherever ghosts are
  killed, or the grid would stay dammed forever. `_armFlyWatchdog()` is the independent witness
  that the dam always opens: a transition that never completes for any reason (an actor that never
  got an allocation, a path that kills a ghost without going through `_clearGhosts`) would leave
  `_refreshPending` standing forever — the grid never rebuilds again, the source icon stays hidden,
  and every later drop is a gesture with no effect. The timer turns that into a half-second hiccup
  plus a line in the journal.
- **The ghost layer must be out of the pick, not just non-reactive.** It is a screen-sized
  `St.Widget` sitting at the top of the `uiGroup`, and the dnd does not find its drop target by
  event propagation — it calls `get_actor_at_pos(PickMode.ALL, …)` and walks up from the picked
  pixel. `PickMode.ALL` sees non-reactive actors (that is exactly what lets an empty grid cell
  accept a drop), so without `Shell.util_set_hidden_from_pick` the layer is a wall: the pick stops
  on it, its parent is the `uiGroup` (no `_delegate` anywhere above), and the whole grid goes
  inert — no `handleDragOver`, no `acceptDrop`. The wall only goes up on the FIRST flight, which
  is what gave this the shape of "the first reorder works, the second does nothing": the layer is
  born *after* the first drop's pick, and eats every one after it. Reopening the launcher appeared
  to fix it because `open()` raises the overlay back to the top of the `uiGroup` — above the
  layer — buying exactly one more drop.
- **Nothing of ours may throw inside the dnd's `emit`.** `_Draggable` is a `Signals.EventEmitter`:
  its `emit()` walks the handlers in a plain JS loop with no try/catch, and `drag-begin` is emitted
  from inside `_gestureRecognized()` while `drag-end` comes from inside `_dragActorDropped()`. An
  exception of ours rides that emit up and aborts the rest of the gesture — including
  `_dragComplete()`, which is what pops the modal grab pushed at the start of the drag. The symptom
  is not a lost gesture, it is the whole session's dnd wedged: the grab stands forever, no new drag
  begins, and Escape lands in the `_cancelDrag` of a drag that already ended. So every callback
  `AppGridIcon` hands to the Shell (`getDragActor`, the `drag-begin`/`drag-end`/`drag-cancelled`
  handlers, `onMergeHover`, `canMerge`) goes through `_guard`/`_notifyDnd`. dnd's own try/catch
  around `acceptDrop` covers only that one call.
- **The dragged cell goes out of the pick, but never `hide()`.** `Shell.util_set_hidden_from_pick`
  plus `opacity = 0` — which is what keeps it from being the drop target of its own drag, and is
  the same thing dnd does to the drag actor. It must stay *measurable*: the `drag-begin` handler
  runs inside `_gestureRecognized()`, and a few lines below it the dnd measures our
  `getDragActorSource()` to decide where the airborne icon is born and where it snaps back to on a
  refused drop. A hidden actor there is invalid geometry, and one NaN in that arithmetic spreads —
  `set_position(NaN)` makes `clutter_actor_allocate` bail on an assertion, the actor never gets an
  allocation, and the flight that was supposed to release the grid may never land. `_flyGhost`
  checks every number it computed with `Number.isFinite` before touching an actor for the same
  reason: no flight is ugly, a NaN flight is fatal.
- `acceptDrop` on the page returns **true even when nothing changed**: a drop in the same slot was
  handled, and returning false would fly the icon back to its origin as if the gesture had failed.
- **Search is a different mode.** With a query the grid is a flat, relevance-ordered list of *apps*,
  including the ones living inside folders (looking for an app should never require remembering
  which folder it ended up in), and drag-and-drop is switched off — reordering a list that is not
  the persisted order would write nonsense.
- **`FolderPopup` is a child of `uiGroup`, not of the launcher's actor**, which is an
  `St.BoxLayout` where an overlay child would take part in the vertical layout. It takes no grab
  (the launcher already holds one on `uiGroup` and the popup lives inside it), so Escape is
  handled by the launcher and `isEditingName` is what stops `_onKeyPress` from stealing the
  keystrokes of a rename.
- **Dragging an app OUT of an open folder** needs the panel to get out of the way:
  `setDragMode(true)` fades the popup and then **hides** it — fading alone is not enough,
  `PickMode.ALL` still finds an invisible cell, and the drop would land on the panel instead of
  the grid. It is not closed, because closing would destroy the source cell mid-gesture and dnd
  needs it to undo a refused drop; the launcher closes it for real at `drag-end`, and only if
  something actually changed.

### Apps launcher: when the grid closes

The grid leaves the screen by three gestures and no others: **launching an app**, **Escape**, and
the **Applications button** (plus the dock-side paths — clicking a dock icon activates an app, and
a dock context menu would otherwise open *underneath* the overlay).

- **Nothing is connected to the grab's `notify::revoked`.** Clutter grabs are a stack and any modal
  pushed on top revokes the one below for as long as it lasts — and the Shell pushes modals inside
  perfectly ordinary gestures: `dnd.js` calls `Main.pushModal()` on its own event actor the moment
  a drag gesture is recognized, and so do menus and popups. Closing on that revocation meant
  holding an icon to move it tore the launcher down in the first frame of the gesture. Losing the
  grab does not make the overlay useless either: it is a full-screen reactive actor in the
  `uiGroup`, so it keeps receiving clicks, and the key focus goes back to the search field when the
  modal above pops. The grab buys exclusivity, not events — which is why the Shell itself never
  watches that property.
- **Clicking the empty background does not close it** (neither the overlay's own pixel nor the
  shield). Both still *consume* the click — nothing underneath may react while the grid is up — but
  an icon dropped in the gap between two cells ends its gesture with exactly one button-release on
  that background, and closing there turned every slightly-off drop into a dismissal.

### Apps launcher: the context menu

Right-clicking an app cell in the grid opens a `PopupMenu` anchored to it: the app's own
actions, then "Fixar na dock"/"Desafixar da dock", then "Criar atalho na área de trabalho".
The first block is literally the dock's — `fillAppActionsSection()` in `src/appActionsMenu.js`
is what `DockIcon._rebuildActionsMenu()` calls too, so the "Nova janela" de-duplication against a
`.desktop` action matching `/new[-_]?window$/i` has one implementation, not two.

- **Folders get no menu at all.** Everything the menu offers is about an installed app, and a
  `folder:` cell has no `Shell.App` — `AppGridIcon.toggleMenu()` returns early on `!this.app`.
- **The menu is built on the FIRST right-click of that cell, never in the constructor.** A
  `_rebuildPages()` creates hundreds of cells and throws them all away on the next reorder; a
  `PopupMenu` + `PopupMenuManager` per cell would be thousands of actors to show at most one.
  Cheap for the dock (ten icons), unaffordable here.
- **The menu actor lives in `uiGroup`, so `AppGridIcon` must destroy it by hand.** It is not a
  child of the cell and nothing would take it down with the grid — and "leaks once" would in
  practice mean "leaks on every reorder". `_onDestroyed()` nulls `_menu` *before* calling
  `destroy()` on it (so the close it triggers cannot re-enter) and nulls `_menuPolicy` *after*
  (so that close still reaches the launcher).
- **The volatile half is rebuilt on every open**, same reason as the dock's `_populateMenu()`:
  `can_open_new_window()` of many apps only becomes true once the app is running, and the pin
  label has to be read from the store at that instant — the dock may have been changed from
  `prefs.js`, in another process, between two right-clicks.
- **Arrow side is `St.Side.TOP` and the bottom row needs no special case.** `BoxPointer`
  flips to `BOTTOM` on its own (`_calculateArrowSide`) when the box does not fit below the
  source and does fit above, so the constant is a preference, not a decision.
- **Right-click never reaches the click path.** `St.Button`'s default `button_mask` is button 1
  only, so button 3 produces no `clicked` — neither the press bounce nor `DRAG_CLICK_GUARD_US`
  has anything to do with this route. The handler returns `EVENT_STOP` so the press dies on the
  cell instead of bubbling to the overlay (which consumes its own empty pixel). `toggleMenu()`
  also refuses while `_dragging`.

#### The menu and the grid's grab

The launcher holds a modal grab on `uiGroup`; `PopupMenuManager` pushes **another** modal on
`menu.actor` on top of it, revoking ours for as long as the menu is up. That is normal and
nothing may start watching `notify::revoked` — see **when the grid closes**. What matters is
what the redirection does to each of the launcher's own handlers:

- **Escape closes the menu, not the grid, for free.** The manager consumes it on `captured-event`
  over `menu.actor`, which is the *capture* phase; `AppsLauncher._onKeyPress` is a bubble-phase
  handler and never sees it.
- **Every other key DOES reach us, and that is the trap.** `menu.actor` is a child of `uiGroup`,
  and the launcher listens for `key-press-event` there — so with the menu open, the first letter
  typed would fall into the "any printable character goes back to the search" fallback, which
  calls `grab_key_focus()` on the entry and rips the focus out of the menu. `_onKeyPress` is
  therefore gated on `_isMenuOpen()`, exactly the way `FolderPopup.isEditingName` gates it.
  `_isMenuOpen()` re-asks the icon instead of trusting `_menuIcon`: a cell that died without
  emitting its close would otherwise leave the launcher's keyboard diverted forever.
- **The background handlers are not reached at all.** With the grab, a click anywhere else is
  delivered to `menu.actor`, so the overlay's `button-press-event`/`_onButtonRelease` never run
  and the dismissing click cannot be mistaken for anything. The button *release* that follows
  lands normally on the overlay and is only consumed — which is why dismissing a menu over
  another cell does not launch it (that cell never got the press).
- **Keyboard entry point is the launcher, not the cell.** Cells are `can_focus: false` (the focus
  lives in the search field), so Menu / Shift+F10 are handled in `_onKeyPress` and forwarded to
  the selected cell, lighting the selection first if it was not visible.

#### What each item does to the grid

- **A `.desktop` action or "Nova janela" closes the grid**, like any other launch. `onLaunch` is
  called **before** the launch, not after: the overlay holds a seat grab and a new window cannot
  take focus while it stands — the same ordering `_launch()` documents. `close()` is safe from
  inside an item's `activate`: it releases the grab and starts the fade, and only destroys the
  cells (and with them the menu) in the ease's `onComplete`, long after the `ConnectFlags.AFTER`
  handler that closes the menu has run.
- **Pinning and creating a shortcut leave the grid open.** The menu closes itself (the Shell's
  AFTER handler), nothing else moves.
- **Nothing of ours throws into the Shell.** `AppGridMenu._guard` wraps `_populate()` and every
  item handler for the same reason as `AppGridIcon._guard`: `_populate()` runs inside a
  `button-press-event`, and the item handlers run inside `emit('activate')` — whose AFTER
  continuation is what closes the menu and pops its modal. An exception there leaves the menu
  standing on a grab nobody will return.

#### Pinning: the store stays the dock's

`AppsLauncher` takes `isAppPinned(desktopId)` and `onTogglePinned(desktopId)` as constructor
params and **never constructs a `DockItemsStore` of its own**. A second instance would write
`dock-items` in parallel with the dock's and fight the echo suppression that `_persistOrder`
does on its own writes. The two are optional, and optional *together*: without both, the pin
item is simply not created — a menu that can read the state but not write it (or the reverse)
would carry a lying label. The launcher hands the policy object to every cell, one object for
the whole grid: it has no per-icon state (the cell arrives as an argument to `stateChanged`).

#### The desktop shortcut

`src/desktopShortcut.js` copies the app's `.desktop` into
`GLib.UserDirectory.DIRECTORY_DESKTOP` (falling back to the home dir — for many users those are
the same folder, and refusing there would be worse than writing there).

- **A byte-for-byte copy, never a hand-written ini.** The real file carries `Icon`, an `Exec`
  with its field codes, the declared actions and every translated `Name[xx]`; synthesizing it
  loses all of that.
- **`create_async` and not `replace_contents_async`.** Exclusive creation *is* the existence
  test, done by the kernel in one step; a `query_info` followed by a write is two round trips
  with a window in between, and losing that race means overwriting a shortcut the user edited by
  hand. `EXISTS` is what drives the `firefox.desktop` → `firefox-1.desktop` suffix loop, capped
  so a pathological directory cannot turn into an endless queue of I/O inside the compositor.
- **The write loops.** `write_bytes_async` may legitimately write *less* than asked; a truncated
  `.desktop` is worse than no shortcut at all — it exists, it has an icon, and it opens nothing.
- **Executable AND trusted, in two separate calls.** GNOME refuses to launch a desktop file that
  is not both. `unix::mode` is on the inode and failing it is a real failure (the file shows up
  as text); `metadata::trusted` lives in the gvfs metadata backend, which may simply not be
  running — that one only warns in the journal, because the shortcut is already created and
  working.
- **All of it asynchronous, with one `Gio.Cancellable` per job**, cancelled in `destroy()`. This
  is the **Filesystem I/O** rule, not a preference: a sync copy on a dead NFS home freezes the
  session. Every callback re-asks `_alive(job)` — destroyed, cancelled, or already finished —
  before touching anything, and a cancellation is never reported as an error (the thing that
  cancelled it was the extension going away).
- **One instance for the whole launcher, not one per cell.** The cancellables die with
  `AppsLauncher.destroy()`; hung on the cells, the first grid rebuild after the click would
  cancel the copy the user just asked for.
- Failures `logError` with the `[ArcDock]` prefix **and** `Main.notifyError`: a menu item that
  silently does nothing reads as broken. Success stays quiet — the file appearing is the feedback.

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
- Showing is **dwell-gated**: the pointer has to stay in the live area for `TIMING.SHOW_DELAY_MS`
  before the dock rises, and the timeout re-reads `global.get_pointer()` when it fires instead of
  trusting the tick that scheduled it — a pointer that left in the last few ms would otherwise
  raise a dock that immediately schedules its own hide. Interrupting a *hide* skips the wait: the
  dock is still on screen and the user is aiming at something visible.

### Chrome (`Main.layoutManager.addChrome`)
- `affectsInputRegion: true` — required to receive events with maximized windows.
- `affectsStruts: false` — don't reserve workspace area (it's an overlay, not a fixed dock).
- `trackFullscreen: false` — the Shell would only hide the actor, leaving the hot edge and the
  input catcher alive under a game. Fullscreen is handled by `FullscreenWatcher` +
  `setForceHidden()`, which kills the whole interaction (see **Fullscreen**).
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
| `SIZE.BOTTOM_MARGIN` | 2 | gap between the pill and the bottom edge (the pill is anchored to the bottom of the chrome container by `glassHost`’s `y_align: END`; the headroom lives above it) |
| `SIZE.HOT_EDGE` | 4 | thickness of the strip that triggers show |
| `SIZE.LIVE_BUFFER` | 8 | px tolerance around the visible dock before starting hide |
| `ANIM.HOVER_SCALE` | 1 | kept for headroom calculation; no scale on hover |
| `ANIM.HOVER_LIFT` | 0 | kept for headroom calculation; no lift on hover |
| `ANIM.HOVER_IN_MS` / `HOVER_OUT_MS` | 140 / 120 | legacy; current hover visual uses tooltip without scale/lift |
| `ANIM.SHOW_MS` / `HIDE_MS` | 280 / 200 | duration of dock animations (mirrored cubic: OUT on the way in, IN on the way out) |
| `TIMING.POINTER_POLL_MS` | 100 | pointer polling frequency |
| `TIMING.HIDE_DELAY_MS` | 350 | delay before hiding after mouse leaves |
| `TIMING.SHOW_DELAY_MS` | 250 | dwell time on the hot edge before showing (a pass-by never summons the dock) |
| `INDICATOR.DOT_SIZE` / `DOT_SPACING` | 5 / 3 | px of each running dot and the gap between dots |
| `INDICATOR.DOT_SIZE_LIGHT` | 4 | dot size in the light theme, where the dot is flat white with no shadow |
| `INDICATOR.MAX_DOTS` | 4 | cap on per-window dots (above it nobody counts at a glance) |
| `INDICATOR.BAR_HEIGHT` / `BAR_WIDTH_RATIO` | 3 / 0.45 | bar style: height in px, width as a fraction of the icon |
| `INDICATOR.CENTER_Y_OFFSET` | 0.5 | vertical center of the indicator, measured from the icon's bottom edge |
| `RECENT.VISIBLE` / `HISTORY_MAX` | 6 / 10 | recent apps shown next to the Applications button, and how many the history remembers |
| `MAGNIFICATION.MIN_SCALE` / `MAX_SCALE` / `DEFAULT_SCALE` | 1.1 / 2.0 / 1.5 | hover zoom limits; must match the `<range>` of `magnification-scale` |
| `MAGNIFICATION.MIN_FALLOFF` / `MAX_FALLOFF` / `DEFAULT_FALLOFF` | 50 / 400 / 150 | px from the pointer where the zoom dies out; must match `magnification-falloff` |
| `MAGNIFICATION.RELAX_MS` | 150 | the only eased part of the zoom: the way back when the pointer leaves |
| `RECENT.SEPARATOR_*` | 1 / 0.6 / -4 | the section dividers: width in px, height as a fraction of the icon, and the lift that aligns them with the icons instead of the row box |
| `ANIM.WINDOW_OPEN_MS` | 250 | duration of the custom open-from-icon animation (`window-animations-enabled`) |
