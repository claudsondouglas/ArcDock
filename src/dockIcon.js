import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { INDICATOR, IndicatorStyle } from './config.js';
import { IconButton } from './iconButton.js';
import { triggerLaunchBounce } from './iconAnimation.js';
import { SignalTracker } from './trackers.js';

const ATTENTION_DOT_SIZE = 11;

export const DockIcon = GObject.registerClass(
class DockIcon extends IconButton {
    _init(window, app, params = {}) {
        super._init({
            id: params.id,
            iconSize: params.iconSize,
            tooltipText: app.get_name() || window?.get_title() || 'Application',
            onMenuStateChanged: params.onMenuStateChanged,
        });
        this.window = window;
        this.windows = params.windows ?? (window ? [window] : []);
        this.app = app;
        this._pinned = !!params.pinned;
        this._running = !!params.running;
        this._useThemeRunningDotColor = !!params.useThemeRunningDotColor;
        this._indicatorStyle = params.indicatorStyle ?? IndicatorStyle.DOT;
        // O tamanho do ponto vem do Dock porque depende do tema, e o
        // actor tem width/height explícitos — CSS por tema não alcança
        // um tamanho fixado em JS.
        this._dotSize = params.indicatorDotSize ?? INDICATOR.DOT_SIZE;
        this._clickToMinimize = params.clickToMinimize ?? false;
        this._onTogglePinned = params.onTogglePinned ?? null;
        this._attentionTracker = params.attentionTracker ?? null;

        const texture = app.create_icon_texture(this.iconSize);
        texture.add_style_class_name('arcdock-icon-texture');
        texture.set_style?.(`icon-size: ${this.iconSize}px;`);
        this.setIconChild(texture);

        // Cor do indicador herda do foreground do popup-menu-content
        // (texto do tema atual) — fica claro em tema escuro, escuro em
        // tema claro. Quando false, mantém a cor padrão definida no CSS.
        this._indicatorColorStyle = this._useThemeRunningDotColor
            ? this._themeDotColorStyle()
            : null;
        // Os pips vivem num container próprio no host (fora do stage),
        // então trocar de estilo nunca mexe no tamanho do ícone.
        this._indicator = new St.Widget({
            style_class: 'arcdock-running-indicator',
            reactive: false,
            visible: false,
        });
        this.host.add_child(this._indicator);
        this._indicatorSignature = null;
        this._updateRunningIndicator();
        this._attentionDot = new St.Widget({
            style_class: 'arcdock-attention-dot',
            reactive: false,
            visible: false,
            width: ATTENTION_DOT_SIZE,
            height: ATTENTION_DOT_SIZE,
        });
        this._attentionDot.set_position(
            this.iconSize - ATTENTION_DOT_SIZE,
            1,
        );
        this.host.add_child(this._attentionDot);

        this._windowSignals = new SignalTracker();
        this._connectWindowSignals();

        this._createMenu();
    }

    setTarget(window, windows, app, pinned, running) {
        this.window = window;
        this.windows = windows ?? (window ? [window] : []);
        this.app = app;
        this._pinned = !!pinned;
        this._running = !!running;
        this.setTooltipText(app.get_name() || window?.get_title() || 'Application');
        this._updateRunningIndicator();
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

    _themeDotColorStyle() {
        // Probe descartável só pra extrair a cor de texto do tema do
        // GNOME (popup-menu-content é uma classe que existe sempre).
        const probe = new St.Widget({ style_class: 'popup-menu-content' });
        Main.uiGroup.add_child(probe);
        probe.ensure_style();
        const fg = probe.get_theme_node().get_foreground_color();
        probe.destroy();
        return `background-color: rgba(${fg.red}, ${fg.green}, ${fg.blue}, ${fg.alpha / 255});`;
    }

    _updateRunningIndicator() {
        const windowCount = this._running
            ? Math.max(1, this.windows.length)
            : 0;
        // _refresh() chama setTarget em TODO ícone a cada mudança de
        // janela; sem a assinatura, reconstruiríamos os pips mesmo
        // quando nada que os afeta mudou.
        const signature = `${this._indicatorStyle}:${windowCount}`;
        if (signature === this._indicatorSignature)
            return;
        this._indicatorSignature = signature;

        this._indicator.destroy_all_children();
        if (windowCount === 0) {
            this._indicator.visible = false;
            return;
        }

        const { width, height } = this._buildIndicatorPips(windowCount);
        this._indicator.set_size(width, height);
        // Host e indicador usam layout fixo (o padrão do St.Widget), então
        // posicionamos pela caixa que acabamos de montar em vez de ler
        // width/height do actor — que ainda não foi alocado aqui.
        this._indicator.set_position(
            Math.round((this.iconSize - width) / 2),
            Math.round(this.iconSize + INDICATOR.CENTER_Y_OFFSET - height / 2),
        );
        this._indicator.visible = true;
    }

    /** Monta os pips do estilo atual e devolve a caixa que eles ocupam. */
    _buildIndicatorPips(windowCount) {
        if (this._indicatorStyle === IndicatorStyle.BAR) {
            const width = Math.max(
                INDICATOR.BAR_MIN_WIDTH,
                Math.round(this.iconSize * INDICATOR.BAR_WIDTH_RATIO),
            );
            const bar = this._makePip(
                'arcdock-indicator-bar', width, INDICATOR.BAR_HEIGHT);
            bar.set_position(0, 0);
            this._indicator.add_child(bar);
            return { width, height: INDICATOR.BAR_HEIGHT };
        }

        const dots = this._indicatorStyle === IndicatorStyle.DOTS
            ? Math.min(windowCount, INDICATOR.MAX_DOTS)
            : 1;
        for (let i = 0; i < dots; i++) {
            const pip = this._makePip(
                'arcdock-running-dot', this._dotSize, this._dotSize);
            // Posição explícita em vez de um BoxLayout com `spacing`: o
            // espaçamento de BoxLayout vem do tema CSS, e aqui ele
            // precisa casar exatamente com a largura usada para centrar.
            pip.set_position(i * (this._dotSize + INDICATOR.DOT_SPACING), 0);
            this._indicator.add_child(pip);
        }
        return {
            width: dots * this._dotSize + (dots - 1) * INDICATOR.DOT_SPACING,
            height: this._dotSize,
        };
    }

    _makePip(styleClass, width, height) {
        const pip = new St.Widget({
            style_class: styleClass,
            reactive: false,
            width,
            height,
        });
        if (this._indicatorColorStyle)
            pip.set_style(this._indicatorColorStyle);
        return pip;
    }

    _createMenu() {
        // Seção de ações do app (Nova janela + actions do .desktop).
        // Reconstruída a cada abertura porque a lista pode mudar (ex:
        // app pode permitir nova janela só depois de iniciado).
        this._actionsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._actionsSection);

        this._windowSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._windowSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pinItem = new PopupMenu.PopupMenuItem('');
        this._pinItem.connect('activate', () => this._onTogglePinned?.(this));
        this.menu.addMenuItem(this._pinItem);

        this._quitItem = new PopupMenu.PopupMenuItem('Fechar');
        this._quitItem.connect('activate', () => this.app?.request_quit?.());
        this.menu.addMenuItem(this._quitItem);

        this._updatePinItem();
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

    _populateMenu() {
        this._updatePinItem();
        this._rebuildActionsMenu();
        this._rebuildWindowMenu();
        this._quitItem.actor.visible = !!this._running;
    }

    _onPrimaryActivate() {
        if (!this.window) {
            // Só o LANÇAMENTO ganha o quique — é ele que sinaliza "o app
            // está abrindo, espera". Trazer uma janela existente para a
            // frente já tem o feedback de press e resposta imediata na
            // tela; quicar ali seria ruído.
            triggerLaunchBounce(this);
            if (this.app.can_open_new_window())
                this.app.open_new_window(-1);
            else
                this.app.activate_full(-1, global.get_current_time());
            return;
        }

        const target = this._windowToActivate();
        if (target) {
            Main.activateWindow(target);
            return;
        }

        // Não há mais nada para trazer à frente: o app está em foco e o
        // resto das janelas já está minimizado, então o clique recolhe.
        this._minimizeWindows();
    }

    _onMiddleActivate() {
        this.window?.delete(global.get_current_time());
    }

    /**
     * Janela que o clique deve ativar, ou null quando ele deve minimizar
     * o app (só acontece com click-to-minimize ligado).
     */
    _windowToActivate() {
        const focusedIndex = this.windows.findIndex(window =>
            typeof window.has_focus === 'function' && window.has_focus());
        // App sem foco: clique é "traga para frente", nunca minimizar.
        if (focusedIndex === -1)
            return this.window;

        for (let i = 1; i < this.windows.length; i++) {
            const candidate = this.windows[(focusedIndex + i) % this.windows.length];
            // Com click-to-minimize, janela minimizada não é destino de
            // ciclo: se fosse, o clique a restauraria e o app com várias
            // janelas nunca chegaria a minimizar.
            if (!this._clickToMinimize || !candidate.minimized)
                return candidate;
        }

        return this._clickToMinimize ? null : this.window;
    }

    _minimizeWindows() {
        for (const window of this.windows) {
            if (!window.minimized)
                window.minimize();
        }
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
        this._windowSignals?.disconnectAll();
        super.destroy();
    }
});
