import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { SIZE } from './config.js';
import * as Cursor from './cursor.js';
import {
    attachHoverPress,
    dismissTooltip,
    playEntry,
    resetHoverPress,
} from './iconAnimation.js';

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

        // Marca lida pelos handlers de fim de arraste. Pelo SINAL e não
        // pelo destroy() daqui: quando o painel inteiro é destruído o
        // Clutter leva os filhos por dentro, sem passar por método nenhum
        // desta classe — só o sinal chega aos dois caminhos. O nome é
        // qualificado de propósito: FolderIcon tem o seu próprio
        // `_destroyed`, com o mesmo sentido mas com o ciclo de vida da I/O
        // assíncrona dela, e uma base que escrevesse nele mexeria nas
        // guardas de uma subclasse sem ela saber.
        this._iconDestroyed = false;
        this.connect('destroy', () => { this._iconDestroyed = true; });

        // _delegate é o que o DND lê para identificar o source no drop target.
        this._delegate = this;
        this._draggable = DND.makeDraggable(this, {
            timeoutThreshold: 150,
            restoreOnSuccess: false,
        });
        this._draggable.connect('drag-begin', () => this._onDragBegin());
        const restore = () => this._onDragEnd();
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

    /**
     * Começou o arraste: o botão fica INVISÍVEL mas continua na fila.
     *
     * Nem `hide()`, nem deixar o dnd levar o botão embora. As duas coisas
     * tiram o ícone da alocação do St.BoxLayout, a fila fecha na hora e não
     * sobra buraco nenhum para os vizinhos abrirem — que é a metade visível
     * do gesto. Mais do que isso, a célula precisa continuar MENSURÁVEL:
     * este handler roda dentro do `_gestureRecognized()` do dnd, e logo
     * abaixo dele o dnd mede o nosso `getDragActorSource()` para decidir
     * onde o ícone no ar nasce e para onde ele volta num drop recusado. Um
     * actor escondido ali é geometria inválida, e um NaN nessa conta
     * contamina a posição do fantasma e a alocação dele.
     *
     * Sair do PICK era a outra metade do hide(), e é o que
     * `util_set_hidden_from_pick` faz sozinho (é o mesmo que o dnd usa no
     * próprio actor de arraste): sem isso o ícone seria o alvo de drop do
     * seu próprio arraste.
     */
    _onDragBegin() {
        this._dragGuard(() => {
            // O tooltip e a escala de press seguiriam o gesto inteiro: o
            // botão continua "apertado" para o St, porque o botão do mouse
            // só é solto lá no drop. Nesta ordem: resetHoverPress limpa o
            // flag de supressão do tooltip, então dispensá-lo antes não
            // adiantaria nada.
            resetHoverPress(this);
            dismissTooltip(this);
            Shell.util_set_hidden_from_pick(this, true);
            this.opacity = 0;
        }, 'drag begin');
    }

    _onDragEnd() {
        // Célula já destruída: o dnd continua emitindo 'drag-cancelled' e
        // 'drag-end' sobre o draggable, e cada toque em actor morto aqui
        // vira exceção DENTRO do handler do Shell.
        if (this._iconDestroyed) return;
        this._dragGuard(() => {
            Shell.util_set_hidden_from_pick(this, false);
            this.opacity = 255;
            this.show();
        }, 'drag end');
    }

    /**
     * Roda `fn` sem deixar NADA escapar para o dnd do Shell.
     *
     * O `_Draggable` é um `Signals.EventEmitter`: o `emit()` dele percorre
     * os handlers num laço JS **sem try/catch**, e 'drag-begin' sai de
     * dentro de `_gestureRecognized()` enquanto 'drag-end' sai de dentro de
     * `_dragActorDropped()`. Uma exceção nossa sobe por esse emit e aborta
     * o resto do fim de gesto — inclusive o `_dragComplete()`, que é quem
     * devolve o `Main.pushModal` empurrado no início do arraste. O sintoma
     * não é um gesto perdido, é o dnd da SESSÃO inteira travado.
     */
    _dragGuard(fn, what = 'drag handler') {
        try {
            fn();
        } catch (e) {
            logError(e, `[ArcDock] icon ${what} failed`);
        }
    }

    /**
     * Actor que o ponteiro carrega.
     *
     * Existir é o ponto: SEM este método o dnd reparenta o próprio botão
     * para o uiGroup (dnd.js), e aí o ícone some da fila no primeiro quadro
     * do gesto — sem buraco, sem reflow e sem casa reservada para onde
     * voltar.
     *
     * Um Clutter.Clone do stage (só a ARTE, sem os dots de app rodando) e
     * não uma textura nova: `IconButton` não sabe desenhar o ícone de
     * ninguém — quem sabe é a subclasse —, e o clone é a única forma
     * genérica de tirar um retrato dele daqui. O clone continua pintando
     * mesmo com o botão em opacity 0: o ClutterClone sobrescreve a
     * opacidade da fonte pela sua própria antes de pintá-la, e a
     * sobrescrita curto-circuita a cadeia de pais.
     */
    getDragActor() {
        let actor = null;
        this._dragGuard(() => {
            actor = new Clutter.Clone({
                source: this._stage,
                width: this._iconSize,
                height: this._iconSize,
            });
        }, 'drag actor creation');
        // Blindado pelo mesmo motivo do _dragGuard: este getter é chamado
        // por _gestureRecognized() DEPOIS do pushModal, e uma exceção aqui
        // deixaria o grab de pé sem nunca chegar a um fim de gesto que o
        // devolvesse. Um ícone genérico é uma saída ruim; a sessão sem
        // ponteiro não é saída nenhuma.
        return actor ?? new St.Icon({
            icon_name: 'application-x-executable',
            icon_size: this._iconSize,
        });
    }

    /** Onde a arte nasce, e para onde ela volta num drop recusado. */
    getDragActorSource() {
        return this._stage ?? this;
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
