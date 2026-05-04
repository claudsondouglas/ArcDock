import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SIZE, ANIM, State } from './config.js';
import { SignalTracker } from './trackers.js';
import { DockIcon } from './dockIcon.js';
import { ShowAppsIcon } from './showAppsIcon.js';
import { OverviewDashHider } from './overviewDashHider.js';
import { AutoHide } from './autoHide.js';
import { InputCatcher } from './inputCatcher.js';
import * as Cursor from './cursor.js';
import { applyGlass } from './glassEffect.js';

export class Dock {
    constructor() {
        this._appSystem = Shell.AppSystem.get_default();
        this._icons = new Map();
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
        this._container.connect('button-press-event', () => Clutter.EVENT_STOP);
        this._container.connect('button-release-event', () => Clutter.EVENT_STOP);

        this._panel = new St.BoxLayout({
            style_class: 'liquiddock-panel',
            vertical: false,
            reactive: true,
            track_hover: true,
        });
        applyGlass(this._panel);
        this._container.set_child(this._panel);

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
            () => this._hasMaximizedOrFullscreenWindow()
        );

        this._signals.connect(this._container, 'notify::visible', () => {
            if (this._container.visible)
                this._inputCatcher.show();
            else
                this._inputCatcher.hide();
        });

        this._signals.connect(Main.layoutManager, 'monitors-changed',
            () => this._reposition());
        this._signals.connect(this._panel, 'notify::height',
            () => this._reposition());
        this._signals.connect(this._appSystem, 'app-state-changed',
            () => this._refresh());
        this._signals.connect(this._appSystem, 'installed-changed',
            () => this._refresh());
        this._signals.connect(global.display, 'restacked',
            () => this._raiseToTop());
        this._signals.connect(Main.overview, 'showing',
            () => this._autoHide.setForceHidden(true));
        this._signals.connect(Main.overview, 'shown',
            () => this._autoHide.setForceHidden(true));
        this._signals.connect(Main.overview, 'hidden',
            () => this._autoHide.setForceHidden(false));
        if (Main.overview.visible)
            this._autoHide.setForceHidden(true);

        this._refresh();
    }

    destroy() {
        Cursor.setDefault();
        this._autoHide.destroy();
        this._signals.disconnectAll();
        for (const icon of this._icons.values())
            icon.destroy();
        this._icons.clear();
        this._showAppsIcon?.destroy();
        this._showAppsIcon = null;
        this._overviewDashHider.destroy();
        this._overviewDashHider = null;
        this._inputCatcher?.destroy();
        this._inputCatcher = null;
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
        this._container = null;
    }

    _refresh() {
        const seen = new Set();
        for (const app of this._appSystem.get_running()) {
            const id = app.get_id();
            seen.add(id);
            if (!this._icons.has(id)) {
                const icon = new DockIcon(app);
                this._icons.set(id, icon);
                this._panel.add_child(icon);
            }
        }
        for (const [id, icon] of this._icons) {
            if (!seen.has(id)) {
                icon.destroy();
                this._icons.delete(id);
            }
        }
        this._keepShowAppsIconLast();
        this._reposition();
    }

    _keepShowAppsIconLast() {
        if (!this._showAppsIcon)
            return;
        this._panel.set_child_above_sibling(this._showAppsIcon, null);
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const [, naturalH] = this._panel.get_preferred_height(monitor.width);
        const h = Math.max(naturalH, SIZE.ICON + 24);
        const [, naturalW] = this._panel.get_preferred_width(h);

        // Headroom acima do panel: cobre o lift + scale do hover dos ícones,
        // garantindo que o input region da chrome (que usa allocation, não
        // transforms) inclua a área visual do ícone quando estiver lifted.
        // Sem isso, cliques no topo do ícone hovered passam pra janela atrás.
        // Usa h (altura real do panel, com padding) em vez de SIZE.ICON.
        const headroom = Math.abs(ANIM.HOVER_LIFT)
            + Math.ceil((ANIM.HOVER_SCALE - 1) * h)
            + 8;
        const totalH = h + headroom;

        this._container.set_size(monitor.width, totalH);
        this._panelSize = { w: naturalW, h };
        this._container.set_position(
            monitor.x,
            monitor.y + monitor.height - totalH - SIZE.BOTTOM_MARGIN
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
        if (!monitor)
            return null;

        const hotEdgeRect = {
            x: monitor.x,
            y: monitor.y + monitor.height - SIZE.HOT_EDGE,
            w: monitor.width,
            h: SIZE.HOT_EDGE,
        };

        if (state === State.SHOWN || state === State.SHOWING) {
            const horizontalBounds = this._dockHorizontalBounds(monitor);
            if (!horizontalBounds)
                return hotEdgeRect;

            const { h } = this._panelSize;
            if (!h)
                return hotEdgeRect;

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
        if (!w)
            return null;

        const x = monitor.x + Math.round((monitor.width - w) / 2);
        return {
            x: x - SIZE.LIVE_BUFFER,
            w: w + 2 * SIZE.LIVE_BUFFER,
        };
    }

    _hasMaximizedOrFullscreenWindow() {
        const workspace = global.workspace_manager.get_active_workspace();
        const primaryIndex = Main.layoutManager.primaryIndex;
        if (!workspace || primaryIndex === -1)
            return false;

        return workspace.list_windows().some(window =>
            !window.minimized
            && !window.is_skip_taskbar()
            && window.get_monitor() === primaryIndex
            && (this._isFullscreen(window)
                || (window.maximized_horizontally && window.maximized_vertically))
        );
    }

    _isFullscreen(window) {
        if (window.is_fullscreen)
            return window.is_fullscreen();
        return window.fullscreen;
    }

}
