import GObject from 'gi://GObject';
import St from 'gi://St';

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { SIZE } from './config.js';
import * as Cursor from './cursor.js';
import { attachHoverPress, triggerPressBounce } from './iconAnimation.js';
import { SignalTracker } from './trackers.js';

const ATTENTION_DOT_SIZE = 11;

export const DockIcon = GObject.registerClass(
class DockIcon extends St.Button {
    _init(window, app, params = {}) {
        super._init({
            style_class: 'arcdock-icon',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        this.id = params.id;
        this.window = window;
        this.windows = params.windows ?? (window ? [window] : []);
        this.app = app;
        this._pinned = !!params.pinned;
        this._running = !!params.running;
        this._iconSize = params.iconSize ?? SIZE.ICON;
        this._useThemeRunningDotColor = !!params.useThemeRunningDotColor;
        this._onTogglePinned = params.onTogglePinned ?? null;
        this._onMenuStateChanged = params.onMenuStateChanged ?? null;
        this._attentionTracker = params.attentionTracker ?? null;
        this._tooltipText = app.get_name() || window?.get_title() || 'Application';

        const texture = app.create_icon_texture(this._iconSize);
        texture.add_style_class_name('arcdock-icon-texture');
        texture.set_style?.(`icon-size: ${this._iconSize}px;`);
        const stage = new St.Bin({
            style_class: 'arcdock-icon-stage',
            width: this._iconSize,
            height: this._iconSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        stage.set_child(texture);
        const host = new St.Widget({
            style_class: 'arcdock-icon-host',
            width: this._iconSize,
            height: this._iconSize + 8,
        });
        host.add_child(stage);
        this._runningDot = new St.Widget({
            style_class: 'arcdock-running-dot',
            reactive: false,
            visible: this._running,
        });
        this._runningDot.set_position(Math.floor((this._iconSize - 5) / 2), this._iconSize - 2);
        host.add_child(this._runningDot);
        // Cor do dot herda do foreground do popup-menu-content (texto do
        // tema atual) — fica claro em tema escuro, escuro em tema claro.
        // Quando false, mantém a cor padrão definida no CSS.
        if (this._useThemeRunningDotColor)
            this._applyThemeDotColor();
        this._attentionDot = new St.Widget({
            style_class: 'arcdock-attention-dot',
            reactive: false,
            visible: false,
            width: ATTENTION_DOT_SIZE,
            height: ATTENTION_DOT_SIZE,
        });
        this._attentionDot.set_position(
            this._iconSize - ATTENTION_DOT_SIZE,
            1,
        );
        host.add_child(this._attentionDot);
        this._tooltipHost = host;
        this._hoverActor = texture;
        this.set_child(host);

        this._windowSignals = new SignalTracker();
        this._connectWindowSignals();

        this.connect('clicked', this._onClicked.bind(this));
        this.connect('button-press-event', this._onButtonPress.bind(this));
        attachHoverPress(this);
        this._createMenu();

        // _delegate é o que o DND lê para identificar o source no drop target.
        this._delegate = this;
        this._draggable = DND.makeDraggable(this, {
            timeoutThreshold: 150,
            restoreOnSuccess: false,
        });
        this._draggable.connect('drag-begin', () => { this.hide(); });
        const restore = () => { this.opacity = 255; this.show(); };
        this._draggable.connect('drag-end', restore);
        this._draggable.connect('drag-cancelled', restore);
    }

    setTarget(window, windows, app, pinned, running) {
        this.window = window;
        this.windows = windows ?? (window ? [window] : []);
        this.app = app;
        this._pinned = !!pinned;
        this._running = !!running;
        this._tooltipText = app.get_name() || window?.get_title() || 'Application';
        this._runningDot.visible = this._running;
        this._connectWindowSignals();
        this._updatePinItem();
    }

    _connectWindowSignals() {
        this._windowSignals.disconnectAll();
        if (!this.windows.length) {
            this._updateAttentionDot();
            return;
        }
        const update = () => this._updateAttentionDot();
        for (const window of this.windows) {
            this._windowSignals.connect(window, 'notify::demands-attention', update);
            this._windowSignals.connect(window, 'notify::urgent', update);
        }
        update();
    }

    _updateAttentionDot() {
        const windowNeeds = this.windows.some(w =>
            (typeof w.is_demanding_attention === 'function' && w.is_demanding_attention())
            || (typeof w.is_urgent === 'function' && w.is_urgent()));
        const trayNeeds = !!this._attentionTracker?.hasAttention(this.app);
        this._attentionDot.visible = windowNeeds || trayNeeds;
    }

    refreshAttention() {
        this._updateAttentionDot();
    }

    _applyThemeDotColor() {
        // Probe descartável só pra extrair a cor de texto do tema do
        // GNOME (popup-menu-content é uma classe que existe sempre).
        const probe = new St.Widget({ style_class: 'popup-menu-content' });
        Main.uiGroup.add_child(probe);
        probe.ensure_style();
        const fg = probe.get_theme_node().get_foreground_color();
        probe.destroy();
        this._runningDot.set_style(
            `background-color: rgba(${fg.red}, ${fg.green}, ${fg.blue}, ${fg.alpha / 255});`,
        );
    }

    _createMenu() {
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
        this._menu.actor.hide();

        // Seção de ações do app (Nova janela + actions do .desktop).
        // Reconstruída a cada abertura porque a lista pode mudar (ex:
        // app pode permitir nova janela só depois de iniciado).
        this._actionsSection = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(this._actionsSection);

        this._windowSection = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(this._windowSection);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pinItem = new PopupMenu.PopupMenuItem('');
        this._pinItem.connect('activate', () => this._onTogglePinned?.(this));
        this._menu.addMenuItem(this._pinItem);

        this._quitItem = new PopupMenu.PopupMenuItem('Fechar');
        this._quitItem.connect('activate', () => this.app?.request_quit?.());
        this._menu.addMenuItem(this._quitItem);

        this._updatePinItem();

        this._menuManager.addMenu(this._menu);
        Main.uiGroup.add_child(this._menu.actor);

        // Avisa o dock pra travar o auto-hide enquanto o menu estiver
        // aberto — sem isso, o ponteiro saindo da live area do dock pra
        // ir clicar num item esconde o menu junto.
        this._menu.connect('open-state-changed', (_menu, isOpen) =>
            this._onMenuStateChanged?.(isOpen));
    }

    _rebuildActionsMenu() {
        this._actionsSection.removeAll();
        if (!this.app)
            return;

        // Lista das actions do .desktop antes — assim sabemos se já há
        // uma "new-window" nelas e evitamos duplicar com o nosso item.
        const appInfo = this.app.get_app_info?.() ?? this.app.appInfo;
        const desktopActions = appInfo?.list_actions?.() ?? [];
        const hasNewWindowAction = desktopActions.some(a =>
            /new[-_]?window$/i.test(a));

        if (this.app.can_open_new_window?.() && !hasNewWindowAction) {
            const item = new PopupMenu.PopupMenuItem('Nova janela');
            item.connect('activate', () =>
                this.app.open_new_window(-1));
            this._actionsSection.addMenuItem(item);
        }

        for (const action of desktopActions) {
            const name = appInfo.get_action_name(action);
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => {
                const ctx = global.create_app_launch_context(0, -1);
                appInfo.launch_action(action, ctx);
            });
            this._actionsSection.addMenuItem(item);
        }

        if (this._actionsSection.numMenuItems > 0)
            this._actionsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _updatePinItem() {
        if (!this._pinItem)
            return;
        this._pinItem.label.text = this._pinned
            ? 'Desafixar da dock'
            : 'Fixar na dock';
    }

    _onButtonPress(_actor, event) {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;

        this._updatePinItem();
        this._rebuildActionsMenu();
        this._rebuildWindowMenu();
        this._quitItem.actor.visible = !!this._running;
        this._menu.toggle();
        return Clutter.EVENT_STOP;
    }

    _onClicked(_actor, button) {
        if (button === Clutter.BUTTON_MIDDLE) {
            this.window?.delete(global.get_current_time());
        } else if (!this.window) {
            triggerPressBounce(this);
            if (this.app.can_open_new_window())
                this.app.open_new_window(-1);
            else
                this.app.activate_full(-1, global.get_current_time());
        } else {
            triggerPressBounce(this);
            Main.activateWindow(this._windowToActivate());
        }
    }

    _windowToActivate() {
        if (this.windows.length <= 1)
            return this.window;

        const focusedIndex = this.windows.findIndex(window =>
            typeof window.has_focus === 'function' && window.has_focus());
        if (focusedIndex === -1)
            return this.window;

        return this.windows[(focusedIndex + 1) % this.windows.length];
    }

    _rebuildWindowMenu() {
        this._windowSection.removeAll();
        if (this.windows.length <= 1)
            return;

        this._windowSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const window of this.windows) {
            const title = window.get_title?.() || this.app.get_name() || 'Janela';
            const item = new PopupMenu.PopupMenuItem(title);
            item.connect('activate', () => Main.activateWindow(window));
            this._windowSection.addMenuItem(item);
        }
    }

    destroy() {
        if (this.hover)
            Cursor.setDefault();
        this._windowSignals?.disconnectAll();
        this._menu?.destroy();
        this._menu = null;
        this._menuManager = null;
        super.destroy();
    }
});
