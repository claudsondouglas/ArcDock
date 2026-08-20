import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { fillAppActionsSection } from '../appActionsMenu.js';

/**
 * Lado da seta, e portanto onde o menu nasce em relação à célula.
 *
 * TOP = seta em cima = caixa ABAIXO do ícone, que é onde um menu de
 * contexto é esperado. Não é preciso escolher outro lado para a última
 * linha da grade: o BoxPointer vira sozinho para BOTTOM quando a caixa não
 * cabe abaixo da fonte e cabe acima (`_calculateArrowSide`), então a
 * escolha aqui é só a PREFERÊNCIA.
 */
const ARROW_SIDE = St.Side.TOP;

/**
 * Menu de contexto de uma célula de app do launcher.
 *
 * Uma classe própria, e criada SOB DEMANDA pelo AppGridIcon (só no
 * primeiro botão direito daquela célula), pelos dois motivos que separam
 * este menu do da dock: a grade tem centenas de células — construir um
 * PopupMenu + PopupMenuManager para cada uma a cada `_rebuildPages()` seria
 * pagar milhares de actors para mostrar no máximo um — e o menu da dock
 * fala de janelas, enquanto este fala do app instalado.
 *
 * A parte perigosa é o GRAB. O launcher segura um modal no uiGroup; abrir
 * este menu empilha OUTRO modal por cima (PopupMenuManager faz
 * `Main.pushModal(menu.actor)`), revogando o de baixo enquanto durar. Isso
 * é esperado e ninguém deve reagir a `notify::revoked` — ver o comentário
 * de `_takeGrab()` no launcher. O que o launcher precisa mesmo saber é
 * "existe um menu aberto", e é para isso que serve `stateChanged`: com o
 * menu de pé, o `_onKeyPress` dele tem que sair do caminho (senão o desvio
 * "qualquer caractere volta para a busca" rouba o foco do menu no primeiro
 * toque de tecla).
 */
export class AppGridMenu {
    /**
     * @param {object} params
     * @param {Clutter.Actor} params.sourceActor célula a que o menu se ancora
     * @param {Shell.App} params.app
     * @param {object} params.policy callbacks do launcher:
     *   - `isPinned(app) => boolean` e `togglePinned(app)` (opcionais, e
     *     opcionais JUNTOS: sem os dois o item de fixar não é criado)
     *   - `createShortcut(app)`
     *   - `launch()` — algo vai ser lançado, a grade tem que sair de cena
     *     ANTES (o overlay segura o grab do seat; ver fillAppActionsSection)
     *   - `stateChanged(isOpen)`
     */
    constructor(params = {}) {
        this._app = params.app ?? null;
        this._policy = params.policy ?? {};

        this._menuManager = new PopupMenu.PopupMenuManager(params.sourceActor);
        this._menu = new PopupMenu.PopupMenu(params.sourceActor, 0.5, ARROW_SIDE);
        this._menu.actor.hide();
        this._menuManager.addMenu(this._menu);
        // No uiGroup e não dentro do overlay: o actor do launcher é um
        // St.BoxLayout vertical, onde um filho posicionado à mão viraria
        // mais uma faixa da pilha. É o mesmo lugar (e o mesmo motivo) do
        // FolderPopup e da camada de fantasmas.
        Main.uiGroup.add_child(this._menu.actor);

        // Ações do app. Repopulada a cada abertura — ver fillAppActionsSection.
        // O separador que fecha a seção é dela: com um app sem ação nenhuma
        // ele simplesmente não existe, e o menu começa direto no "Fixar".
        this._actionsSection = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(this._actionsSection);

        const { isPinned, togglePinned } = this._policy;
        if (typeof isPinned === 'function' && typeof togglePinned === 'function') {
            // Rótulo vazio na construção: quem decide entre "Fixar" e
            // "Desafixar" é o estado do store NO INSTANTE da abertura, e o
            // usuário pode ter mexido na dock entre um clique e outro.
            this._pinItem = new PopupMenu.PopupMenuItem('');
            this._pinItem.connect('activate', () =>
                this._guard(() => togglePinned(this._app), 'toggle pinned'));
            this._menu.addMenuItem(this._pinItem);
        }

        this._shortcutItem = new PopupMenu.PopupMenuItem(
            'Criar atalho na área de trabalho');
        this._shortcutItem.connect('activate', () =>
            this._guard(() => this._policy.createShortcut?.(this._app),
                'create shortcut'));
        this._menu.addMenuItem(this._shortcutItem);

        this._menu.connect('open-state-changed', (_menu, isOpen) =>
            this._guard(() => this._policy.stateChanged?.(isOpen),
                'menu state'));
    }

    get isOpen() {
        return !!this._menu?.isOpen;
    }

    /**
     * Abre (ou fecha, se já estava aberto) o menu, com o conteúdo volátil
     * refeito na hora.
     *
     * `toggle()` e não `open()` pelo mesmo motivo da dock: o segundo botão
     * direito na mesma célula fecha o que o primeiro abriu.
     */
    toggle() {
        if (!this._menu) return;
        this._populate();
        this._menu.toggle();
    }

    close() {
        if (!this._menu?.isOpen) return;
        this._menu.close(BoxPointer.PopupAnimation.NONE);
    }

    destroy() {
        const menu = this._menu;
        this._menu = null;
        this._actionsSection = null;
        this._pinItem = null;
        this._shortcutItem = null;
        this._app = null;
        if (menu) {
            try {
                // destroy() do PopupMenu já fecha, esvazia, destrói o actor
                // (o que o tira do uiGroup) e emite 'destroy' — que é o que
                // faz o PopupMenuManager devolver o modal caso este menu
                // ainda fosse o ativo. O 'open-state-changed' do fechamento
                // ainda chega ao launcher, e é por ele que o `_menuIcon`
                // dele é zerado.
                menu.destroy();
            } catch (e) {
                logError(e, '[ArcDock] launcher menu destroy failed');
            }
        }
        this._menuManager = null;
        this._policy = {};
    }

    _populate() {
        // As ações precisam de uma consulta viva ao app: `can_open_new_window()`
        // de vários apps só passa a valer depois que eles estão rodando.
        this._guard(() => {
            fillAppActionsSection(this._actionsSection, this._app, {
                // Lançar pelo menu é lançar: a grade sai de cena igual a um
                // clique normal na célula. Fixar e criar atalho NÃO passam
                // por aqui — o usuário provavelmente vai fazer outra coisa
                // na grade em seguida.
                onLaunch: () => this._guard(() => this._policy.launch?.(),
                    'menu launch'),
            });
        }, 'menu actions');

        if (!this._pinItem) return;
        let pinned = false;
        this._guard(() => {
            pinned = this._policy.isPinned?.(this._app) === true;
        }, 'menu pin state');
        this._pinItem.label.text = pinned ? 'Desafixar da dock' : 'Fixar na dock';
    }

    /**
     * Nada nosso pode escapar daqui.
     *
     * `_populate()` roda dentro de um `button-press-event` e os handlers de
     * item rodam dentro do `emit('activate')` do PopupBaseMenuItem — que o
     * Shell conecta com `ConnectFlags.AFTER` para fechar o menu logo depois.
     * Uma exceção nossa aborta essa continuação e deixa o menu aberto
     * segurando o modal, o que é a mesma classe de estrago do dnd travado
     * descrito em `AppGridIcon._guard`.
     */
    _guard(fn, what = 'menu') {
        try {
            fn();
        } catch (e) {
            logError(e, `[ArcDock] launcher ${what} failed`);
        }
    }
}
