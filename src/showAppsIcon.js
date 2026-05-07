import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as OverviewControls from "resource:///org/gnome/shell/ui/overviewControls.js";

import { SIZE } from "./config.js";
import * as Cursor from "./cursor.js";
import { attachHoverPress, triggerPressBounce } from "./iconAnimation.js";

export const ShowAppsIcon = GObject.registerClass(
  class ShowAppsIcon extends St.Button {
    _init(params = {}) {
      super._init({
        style_class: "arcdock-icon arcdock-menu-icon",
        reactive: true,
        can_focus: true,
        track_hover: true,
      });
      this._iconSize = params.iconSize ?? SIZE.ICON;
      this._tooltipText = "Applications";

      const icon = new St.Icon({
        icon_name: "view-app-grid",
        icon_size: this._iconSize,
        style_class: "arcdock-icon-texture",
      });
      icon.set_style?.(`icon-size: ${this._iconSize}px;`);
      const stage = new St.Bin({
        style_class: "arcdock-icon-stage",
        width: this._iconSize,
        height: this._iconSize,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      stage.set_child(icon);
      const host = new St.Widget({
        style_class: "arcdock-icon-host",
        width: this._iconSize,
        height: this._iconSize + 8,
      });
      host.add_child(stage);
      const dot = new St.Widget({
        style_class: "arcdock-running-dot arcdock-menu-dot",
        reactive: false,
      });
      dot.set_position(Math.floor((this._iconSize - 5) / 2), this._iconSize - 1);
      host.add_child(dot);
      this._tooltipHost = host;
      this._hoverActor = icon;
      this.set_child(host);

      this.connect("clicked", this._onClicked.bind(this));
      attachHoverPress(this);
    }

    _onClicked() {
      triggerPressBounce(this);
      Main.overview.show(OverviewControls.ControlsState.APP_GRID);
    }

    destroy() {
      if (this.hover) Cursor.setDefault();
      super.destroy();
    }
  },
);
