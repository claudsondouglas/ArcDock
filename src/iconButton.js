import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { SIZE } from './config.js';
import * as Cursor from './cursor.js';
import { attachHoverPress, dismissTooltip, playEntry } from './iconAnimation.js';

const HOST_EXTRA_HEIGHT = 8;

/* Maquinário comum a qualquer ícone da dock: widget (host + stage),
 * tooltip, menu de contexto e drag-and-drop. Subclasses só precisam
 * fornecer o actor do ícone (setIconChild), popular o menu
 * (_populateMenu) e reagir aos cliques (_onPrimaryActivate /
 * _onMiddleActivate). */
export const IconButton = GObject.registerClass(
class IconButton extends St.Button {
    _init(params = {}) {
        super._init({
            style_class: params.styleClass ?? 'arcdock-icon',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        this.id = params.id;
        this._iconSize = params.iconSize ?? SIZE.ICON;
        this._onMenuStateChanged = params.onMenuStateChanged ?? null;
        this._tooltipText = params.tooltipText ?? '';

        this._stage = new St.Bin({
            style_class: 'arcdock-icon-stage',
            width: this._iconSize,
            height: this._iconSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._host = new St.Widget({
            style_class: 'arcdock-icon-host',
            width: this._iconSize,
            height: this._iconSize + (params.hostExtraHeight ?? HOST_EXTRA_HEIGHT),
            // CENTER e não o FILL padrão: quando a magnificação fixa uma
            // largura MAIOR no botão (é assim que ela empurra os
            // vizinhos), o FILL esticaria o host e, como ele usa layout
            // fixo, o ícone ficaria colado na borda esquerda do slot em
            // vez de continuar no meio dele. Sem magnificação a caixa já
            // é exatamente a largura natural e os dois alinhamentos dão
            // no mesmo.
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._host.add_child(this._stage);
        this._tooltipHost = this._host;
        // Alvo único de TODA animação do ícone (press, quique, entrada).
        // É o stage e não o host porque o host também carrega o
        // indicador de app rodando e o dot de atenção, que não podem
        // escalar nem saltar junto com o ícone. Precisa estar definido
        // antes de attachHoverPress(), que já prepara o pivot do alvo.
        this._animActor = this._stage;
        this.set_child(this._host);

        this.connect('clicked', this._onClicked.bind(this));
        this.connect('button-press-event', this._onButtonPress.bind(this));
        attachHoverPress(this);
        this._setupMenu();

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

        // Entrada animada no próprio construtor: o Dock chama
        // `icon.show(); icon.opacity = 255;` em _applyOrder() logo depois
        // do add_child, então qualquer fade feito no BOTÃO seria
        // atropelado — playEntry() anima o stage, que o Dock não toca.
        playEntry(this);
    }

    get iconSize() {
        return this._iconSize;
    }

    /** Host com overlay livre — subclasses posicionam dots aqui. */
    get host() {
        return this._host;
    }

    get menu() {
        return this._menu;
    }

    /** Troca o actor do ícone e reaponta o alvo das animações de hover. */
    setIconChild(actor) {
        this._stage.set_child(actor);
        this._hoverActor = actor;
    }

    setTooltipText(text) {
        this._tooltipText = text;
    }

    _setupMenu() {
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
        this._menu.actor.hide();

        this._menuManager.addMenu(this._menu);
        Main.uiGroup.add_child(this._menu.actor);

        // Avisa o dock pra travar o auto-hide enquanto o menu estiver
        // aberto — sem isso, o ponteiro saindo da live area do dock pra
        // ir clicar num item esconde o menu junto.
        this._menu.connect('open-state-changed', (_menu, isOpen) =>
            this._onMenuStateChanged?.(isOpen));
    }

    _onButtonPress(_actor, event) {
        // Este handler é conectado antes do de attachHoverPress e devolve
        // EVENT_STOP no botão direito, então o tooltip precisa ser fechado
        // aqui — senão o bubble ficaria por cima do menu de contexto.
        dismissTooltip(this);
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;

        this._populateMenu();
        this._menu.toggle();
        return Clutter.EVENT_STOP;
    }

    _onClicked(_actor, button) {
        if (button === Clutter.BUTTON_MIDDLE)
            this._onMiddleActivate();
        else
            this._onPrimaryActivate();
    }

    _populateMenu() {}

    _onPrimaryActivate() {}

    _onMiddleActivate() {}

    destroy() {
        if (this.hover)
            Cursor.setDefault();
        this._menu?.destroy();
        this._menu = null;
        this._menuManager = null;
        super.destroy();
    }
});
