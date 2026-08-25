# ArcDock architecture

`extension.js` is the GNOME Shell lifecycle entry point. It should remain
small: read settings, create the dock, and destroy it in the correct session
mode transitions.

## Module boundaries

The public façades stay at their current import paths:

- `src/dock.js` exports `Dock`.
- `src/appsLauncher/launcher.js` exports `AppsLauncher`.
- `prefs.js` exports the preferences entry point.

New implementation code is grouped by feature rather than by technical type:

```text
src/
├── dock.js                       # Dock composition root and lifecycle
├── dock/
│   ├── itemOrder.js              # pure visible/persisted order policy
│   ├── view.js                   # actor tree and section presentation
│   ├── contentController.js      # app/window/icon reconciliation
│   ├── dragController.js         # dock DND session and collaborators
│   ├── geometry.js               # monitor, live area and icon geometry
│   └── visibilityController.js   # overview/fullscreen/empty state
└── appsLauncher/
    ├── launcher.js               # launcher composition root and lifecycle
    ├── core/                     # catalog and session state
    ├── view/                     # grid, pagination and actor construction
    ├── drag/                     # reflow, ghost flight and page flip
    └── controllers/              # modal, folders, menus and input
```

`itemOrder.js` and `view.js` have moved so far. The remaining names describe
migration boundaries, not empty scaffolding: create each module when its
implementation is extracted.

## Dependency rules

- Façades compose controllers; controllers do not import the façade.
- View modules receive callbacks and data. They do not read GSettings.
- Stores and controllers own their mutable state and cleanup.
- Pure policy modules do not import `gi://` or Shell resources, so Node can
  test them.
- Cross-feature integrations go through small callback interfaces rather than
  importing another feature's internal actors.
- Files added directly to `Main.uiGroup`, global DND monitors, modal grabs,
  GLib sources and Shell patches must have one explicit owner and `destroy()`.

## Lifecycle invariants

The teardown order in `Dock.destroy()` is intentional. Keep launcher/modal
cleanup first, then global DND resources, auto-hide, window-animation patches,
magnification/signals, icon actors, input catcher, and finally chrome.

`AppsLauncher.close()` must release its modal grab before performing other
cleanup. A refresh after a drop must wait for ghost flight completion.

## Migration strategy

Each extraction should preserve the façade API and be independently
verifiable:

1. Move pure policies and add Node tests.
2. Extract actor/view construction while keeping temporary façade aliases.
3. Extract DND controllers with explicit ownership of global resources.
4. Extract content/catalog state and persistence.
5. Extract geometry, visibility and modal/input coordination last.

Do not combine behavior changes or broad formatting with a structural move.

## Verification

Run `npm test` for pure modules and `npm run check` for tests, JavaScript syntax,
relative imports and the GSettings schema. Runtime smoke testing still requires
GNOME Shell; cover repeated enable/disable, overview, fullscreen, lock/unlock,
monitor changes, launcher open during restart, folders, menus and drag/drop.
