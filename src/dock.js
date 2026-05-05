import Clutter from "gi://Clutter";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as DND from "resource:///org/gnome/shell/ui/dnd.js";

import { SIZE, ANIM, State } from "./config.js";
import { SignalTracker } from "./trackers.js";
import { DockIcon } from "./dockIcon.js";
import { ShowAppsIcon } from "./showAppsIcon.js";
import { OverviewDashHider } from "./overviewDashHider.js";
import { AutoHide } from "./autoHide.js";
import { InputCatcher } from "./inputCatcher.js";
import * as Cursor from "./cursor.js";
import { applyGlass } from "./glassEffect.js";

export class Dock {
  constructor() {
    this._appSystem = Shell.AppSystem.get_default();
    this._icons = new Map();
    this._iconOrder = [];
    this._signals = new SignalTracker();
    this._panelSize = { w: 0, h: 0 };
    this._showAppsIcon = null;
    this._overviewDashHider = new OverviewDashHider();

    this._container = new St.Bin({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
      can_focus: false,
      reactive: true,
    });
    // Defesa: se um clique cair na área do container mas não acertar
    // nenhum filho reactive (ex: pixel "vazio" do headroom), consumimos
    // o evento aqui pra que ele não vaze pra janela atrás do dock.
    this._container.connect("button-press-event", () => Clutter.EVENT_STOP);
    this._container.connect("button-release-event", () => Clutter.EVENT_STOP);

    this._panel = new St.BoxLayout({
      style_class: "liquiddock-panel",
      vertical: false,
      reactive: true,
      track_hover: true,
    });
    applyGlass(this._panel);
    this._container.set_child(this._panel);

    // Container exclusivo para ícones de janela — o DnD opera só aqui.
    this._appsBox = new St.BoxLayout({ vertical: false });
    this._appsBox._delegate = this;
    this._panel.add_child(this._appsBox);

    this._showAppsIcon = new ShowAppsIcon();
    this._panel.add_child(this._showAppsIcon);

    Main.layoutManager.addChrome(this._container, {
      affectsInputRegion: true,
      affectsStruts: false,
      trackFullscreen: false,
    });

    this._inputCatcher = new InputCatcher(() => this._autoHide.hideNow());

    this._raiseToTop();

    this._autoHide = new AutoHide(
      this._container,
      (state) => this._liveRect(state),
      () => {
        const hasWindow = this._hasVisibleWindowOnPrimary();
        this._updateInputCatcher(hasWindow);
        return hasWindow;
      },
    );

    this._signals.connect(this._container, "notify::visible", () => {
      this._updateInputCatcher(this._hasVisibleWindowOnPrimary());
    });

    this._signals.connect(Main.layoutManager, "monitors-changed", () =>
      this._reposition(),
    );
    this._signals.connect(this._panel, "notify::height", () =>
      this._reposition(),
    );
    this._signals.connect(this._appSystem, "app-state-changed", () =>
      this._refresh(),
    );
    this._signals.connect(this._appSystem, "installed-changed", () =>
      this._refresh(),
    );
    this._signals.connect(global.display, "window-created", () =>
      this._refresh(),
    );
    this._signals.connect(global.display, "restacked", () =>
      this._raiseToTop(),
    );
    this._signals.connect(Main.overview, "showing", () =>
      this._autoHide.setForceHidden(true),
    );
    this._signals.connect(Main.overview, "shown", () =>
      this._autoHide.setForceHidden(true),
    );
    this._signals.connect(Main.overview, "hidden", () =>
      this._autoHide.setForceHidden(false),
    );
    if (Main.overview.visible) this._autoHide.setForceHidden(true);

    this._refresh();
  }

  destroy() {
    // Cada passo em try/catch isolado: se um falhar (ex: signal já
    // desconectado pelo shell durante session-mode change), os passos
    // críticos seguintes — especialmente removeChrome — ainda rodam.
    // Sem isso, uma exception em qualquer ponto deixa chrome zumbi
    // que faz o enable() seguinte falhar e a extensão fica INACTIVE.
    const safe = (fn) => { try { fn(); } catch (_) {} };

    safe(() => Cursor.setDefault());
    safe(() => this._hideDropIndicator());
    safe(() => this._autoHide?.destroy());
    this._autoHide = null;
    safe(() => this._signals.disconnectAll());
    for (const icon of this._icons.values()) safe(() => icon.destroy());
    this._icons.clear();
    safe(() => this._showAppsIcon?.destroy());
    this._showAppsIcon = null;
    safe(() => this._overviewDashHider?.destroy());
    this._overviewDashHider = null;
    safe(() => this._inputCatcher?.destroy());
    this._inputCatcher = null;
    safe(() => {
      if (this._container) {
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
      }
    });
    this._container = null;
  }

  _refresh() {
    const entries = [];
    for (const app of this._appSystem.get_running()) {
      for (const window of app.get_windows()) {
        if (window.is_skip_taskbar()) continue;
        if (window.get_window_type() !== Meta.WindowType.NORMAL) continue;
        entries.push({ window, app });
      }
    }

    const seen = new Set();
    for (const { window, app } of entries) {
      const id = window.get_stable_sequence();
      seen.add(id);
      if (!this._icons.has(id)) {
        this._signals.connect(window, "unmanaged", () => this._refresh());
        const icon = new DockIcon(window, app);
        this._signals.connect(icon._draggable, "drag-begin", () =>
          this._suppressHover(),
        );
        this._signals.connect(icon._draggable, "drag-end", () => {
          this._hideDropIndicator();
          this._resumeHover();
        });
        this._signals.connect(icon._draggable, "drag-cancelled", () => {
          this._hideDropIndicator();
          this._resumeHover();
        });
        this._icons.set(id, icon);
        this._appsBox.add_child(icon);
      }
    }
    for (const [id, icon] of this._icons) {
      if (!seen.has(id)) {
        icon.destroy();
        this._icons.delete(id);
      }
    }
    this._syncOrder(seen);
    this._applyOrder();
    this._reposition();
  }

  _syncOrder(currentIds) {
    this._iconOrder = this._iconOrder.filter((id) => currentIds.has(id));
    const inOrder = new Set(this._iconOrder);
    const newIds = [...currentIds]
      .filter((id) => !inOrder.has(id))
      .sort((a, b) => a - b);
    this._iconOrder.push(...newIds);
  }

  _applyOrder() {
    this._iconOrder.forEach((id, idx) => {
      const icon = this._icons.get(id);
      if (!icon) return;
      const parent = icon.get_parent();
      if (parent !== this._appsBox) {
        parent?.remove_child(icon);
        this._appsBox.insert_child_at_index(icon, idx);
      } else {
        this._appsBox.set_child_at_index(icon, idx);
      }
      icon.show();
      icon.opacity = 255;
    });
  }

  // DND drop target — chamados no _delegate do panel.
  handleDragOver(source, _actor, x) {
    if (!(source instanceof DockIcon)) return DND.DragMotionResult.NO_DROP;
    this._showDropIndicator();
    this._moveDropIndicator(this._dropIndexAt(x));
    return DND.DragMotionResult.MOVE_DROP;
  }

  acceptDrop(source, _actor, x) {
    if (!(source instanceof DockIcon)) return false;
    const sourceId = source.window.get_stable_sequence();
    const targetIndex = this._dropIndexAt(x);
    this._hideDropIndicator();
    this._reorder(sourceId, targetIndex);
    return true;
  }

  _suppressHover() {
    const targets = [...this._icons.values()];
    if (this._showAppsIcon) targets.push(this._showAppsIcon);
    for (const a of targets) {
      a.remove_all_transitions();
      a.scale_x = 1;
      a.scale_y = 1;
      a.translation_y = 0;
      a.track_hover = false;
    }
    Cursor.setDefault();
  }

  _resumeHover() {
    const targets = [...this._icons.values()];
    if (this._showAppsIcon) targets.push(this._showAppsIcon);
    for (const a of targets) a.track_hover = true;
  }

  _showDropIndicator() {
    if (this._dropIndicator) return;
    this._dropIndicator = new St.Widget({
      style_class: "liquiddock-drop-indicator",
      width: SIZE.ICON,
      height: SIZE.ICON,
    });
    this._appsBox.add_child(this._dropIndicator);
  }

  _hideDropIndicator() {
    this._dropIndicator?.destroy();
    this._dropIndicator = null;
  }

  _moveDropIndicator(visualIndex) {
    if (!this._dropIndicator) return;
    // Converte índice visual (só ícones visíveis) em índice absoluto de children.
    const children = this._appsBox.get_children()
      .filter(c => c !== this._dropIndicator);
    let visCount = 0;
    for (let i = 0; i < children.length; i++) {
      if (!children[i].visible) continue;
      if (visCount === visualIndex) {
        this._appsBox.set_child_at_index(this._dropIndicator, i);
        return;
      }
      visCount++;
    }
    this._appsBox.set_child_at_index(this._dropIndicator, children.length);
  }

  _dropIndexAt(x) {
    let idx = 0;
    for (const child of this._appsBox.get_children()) {
      if (child === this._dropIndicator) continue;
      if (!child.visible) continue; // ignora source (hidden durante drag)
      const center = child.x + child.width / 2;
      if (x < center) return idx;
      idx++;
    }
    return idx;
  }

  _reorder(sourceId, targetIndex) {
    const fromIndex = this._iconOrder.indexOf(sourceId);
    if (fromIndex === -1) return;
    this._iconOrder.splice(fromIndex, 1);
    this._iconOrder.splice(targetIndex, 0, sourceId);
    this._applyOrder();
  }

  _reposition() {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const [, naturalH] = this._panel.get_preferred_height(monitor.width);
    const h = Math.max(naturalH, SIZE.ICON + 24);
    const [, naturalW] = this._panel.get_preferred_width(h);

    // Headroom acima do panel: cobre o lift + scale do hover dos ícones,
    // garantindo que o input region da chrome (que usa allocation, não
    // transforms) inclua a área visual do ícone quando estiver lifted.
    // Sem isso, cliques no topo do ícone hovered passam pra janela atrás.
    // Usa h (altura real do panel, com padding) em vez de SIZE.ICON.
    const headroom =
      Math.abs(ANIM.HOVER_LIFT) + Math.ceil((ANIM.HOVER_SCALE - 1) * h) + 8;
    const totalH = h + headroom;

    this._container.set_size(monitor.width, totalH);
    this._panelSize = { w: naturalW, h };
    this._container.set_position(
      monitor.x,
      monitor.y + monitor.height - totalH - SIZE.BOTTOM_MARGIN,
    );
    this._autoHide.setHideDistance(h + SIZE.BOTTOM_MARGIN);
    this._inputCatcher?.fitToMonitor();
    this._raiseToTop();
    Main.layoutManager.queueUpdateRegions?.();
  }

  _raiseToTop() {
    const parent = this._container?.get_parent();
    parent?.set_child_above_sibling(this._container, null);
    this._inputCatcher?.placeBelow(this._container);
  }

  _liveRect(state) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return null;

    const hotEdgeRect = {
      x: monitor.x,
      y: monitor.y + monitor.height - SIZE.HOT_EDGE,
      w: monitor.width,
      h: SIZE.HOT_EDGE,
    };

    if (state === State.SHOWN || state === State.SHOWING) {
      const horizontalBounds = this._dockHorizontalBounds(monitor);
      if (!horizontalBounds) return hotEdgeRect;

      const { h } = this._panelSize;
      if (!h) return hotEdgeRect;

      const cy = monitor.y + monitor.height - h - SIZE.BOTTOM_MARGIN;
      const dockRect = {
        x: horizontalBounds.x,
        y: cy - SIZE.LIVE_BUFFER,
        w: horizontalBounds.w,
        h: monitor.y + monitor.height - cy + SIZE.LIVE_BUFFER,
      };
      return [dockRect, hotEdgeRect];
    }

    return hotEdgeRect;
  }

  _dockHorizontalBounds(monitor) {
    const { w } = this._panelSize;
    if (!w) return null;

    const x = monitor.x + Math.round((monitor.width - w) / 2);
    return {
      x: x - SIZE.LIVE_BUFFER,
      w: w + 2 * SIZE.LIVE_BUFFER,
    };
  }

  _updateInputCatcher(hasWindow) {
    if (this._container.visible && hasWindow) this._inputCatcher.show();
    else this._inputCatcher.hide();
  }

  _hasVisibleWindowOnPrimary() {
    const workspace = global.workspace_manager.get_active_workspace();
    const primaryIndex = Main.layoutManager.primaryIndex;
    if (!workspace || primaryIndex === -1) return false;

    return workspace
      .list_windows()
      .some(
        (window) =>
          !window.minimized &&
          !window.is_skip_taskbar() &&
          window.get_monitor() === primaryIndex,
      );
  }
}
