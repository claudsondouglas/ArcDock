import Clutter from "gi://Clutter";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { DockTheme, RECENT } from "../config.js";
import { applyGlass } from "../glassEffect.js";

/**
 * Actor tree and section presentation for the dock.
 *
 * The view receives behavior as callbacks and deliberately knows nothing
 * about settings, persistence, applications, or drag-session state.
 */
export class DockView {
  constructor({ iconSize, theme, createDropDelegate, onEmptyPixelRelease }) {
    this.container = new St.Bin({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
      can_focus: false,
      reactive: true,
    });

    const stopIfOwnPixel = (actor, event) =>
      event.get_source?.() === actor
        ? Clutter.EVENT_STOP
        : Clutter.EVENT_PROPAGATE;
    this.container.connect("button-press-event", stopIfOwnPixel);
    this.container.connect("button-release-event", (actor, event) => {
      if (stopIfOwnPixel(actor, event) === Clutter.EVENT_PROPAGATE)
        return Clutter.EVENT_PROPAGATE;
      onEmptyPixelRelease?.();
      return Clutter.EVENT_STOP;
    });

    this.panel = new St.BoxLayout({
      style_class: "arcdock-panel",
      vertical: false,
      reactive: true,
      track_hover: true,
    });
    if (theme === DockTheme.DARK)
      this.panel.add_style_class_name("arcdock-panel-dark");

    this.blurBackdrop = new St.Widget({
      style_class: "arcdock-blur-backdrop",
      reactive: false,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    applyGlass(this.blurBackdrop);

    this.glassHost = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      reactive: false,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
    });
    this.glassHost.add_child(this.blurBackdrop);
    this.glassHost.add_child(this.panel);
    this.container.set_child(this.glassHost);

    this.appsBox = new St.BoxLayout({ vertical: false });
    this.appsBox._delegate = createDropDelegate(this.appsBox);
    this.panel.add_child(this.appsBox);

    this.recentsSeparator = this._createSeparator(iconSize);
    this.panel.add_child(this.recentsSeparator);

    this.recentsBox = new St.BoxLayout({ vertical: false, visible: false });
    this.panel.add_child(this.recentsBox);

    this.foldersSeparator = this._createSeparator(iconSize);
    this.panel.add_child(this.foldersSeparator);

    this.foldersBox = new St.BoxLayout({ vertical: false, visible: false });
    this.foldersBox._delegate = createDropDelegate(this.foldersBox);
    this.panel.add_child(this.foldersBox);

    this._mounted = false;
  }

  mount() {
    if (this._mounted) return;
    Main.layoutManager.addChrome(this.container, {
      affectsStruts: false,
      trackFullscreen: false,
    });
    this._mounted = true;
  }

  addShowAppsIcon(icon, visible) {
    this.panel.add_child(icon);
    icon.visible = visible;
  }

  syncSectionVisibility({ hasApps, hasRecents, hasFolders }) {
    this.appsBox.visible = hasApps;
    this.recentsBox.visible = hasRecents;
    this.foldersBox.visible = hasFolders;
    this.recentsSeparator.visible = hasApps && hasRecents;
    this.foldersSeparator.visible = hasFolders && (hasApps || hasRecents);
  }

  setLauncherOpen(open, { openDuration, closeDuration }) {
    if (open) this.panel.add_style_class_name("arcdock-panel-transparent");
    else this.panel.remove_style_class_name("arcdock-panel-transparent");

    this.blurBackdrop.remove_all_transitions();
    this.blurBackdrop.ease({
      opacity: open ? 0 : 255,
      duration: open ? openDuration : closeDuration,
      mode: open
        ? Clutter.AnimationMode.EASE_IN_QUAD
        : Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  destroy() {
    if (!this.container) return;
    if (this._mounted) Main.layoutManager.removeChrome(this.container);
    this.container.destroy();
    this._mounted = false;
    this.container = null;
    this.panel = null;
    this.blurBackdrop = null;
    this.glassHost = null;
    this.appsBox = null;
    this.recentsBox = null;
    this.foldersBox = null;
    this.recentsSeparator = null;
    this.foldersSeparator = null;
  }

  _createSeparator(iconSize) {
    const separator = new St.Widget({
      style_class: "arcdock-separator",
      reactive: false,
      width: RECENT.SEPARATOR_WIDTH,
      height: Math.round(iconSize * RECENT.SEPARATOR_HEIGHT_RATIO),
      y_expand: false,
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
    });
    separator.translation_y = RECENT.SEPARATOR_Y_OFFSET;
    return separator;
  }
}
