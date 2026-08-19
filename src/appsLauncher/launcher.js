import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DockTheme, LAUNCHER, State } from '../config.js';
import { SignalTracker } from '../trackers.js';
import { applyGlass } from '../glassEffect.js';
import * as Cursor from '../cursor.js';
import { AppGridIcon, CELL_LABEL_BAND, cellHoverHeadroom } from './appGridIcon.js';
import { filterApps, getInstalledApps } from './appList.js';

/**
 * Faixa vertical reservada para a fileira de pontos de página.
 *
 * Reservada SEMPRE, inclusive quando há uma página só e nenhum ponto é
 * desenhado: sem a reserva, a grade saltaria verticalmente no instante em
 * que uma busca reduzisse o resultado a uma única página.
 */
const DOTS_BAND = LAUNCHER.PAGE_DOT_SIZE + 2 * LAUNCHER.PAGE_DOT_SPACING;

/**
 * Delta acumulado de scroll suave (touchpad) equivalente a um "clique" de
 * roda. Eventos SMOOTH chegam em frações a cada frame; sem o acumulador,
 * um único gesto de dois dedos atravessaria a paginação inteira.
 */
const SMOOTH_SCROLL_STEP = 1.0;

/**
 * O grab devolvido pelo pushModal está de fato com o seat?
 *
 * A forma de perguntar isso MUDOU dentro da faixa de versões suportada, e
 * a sonda é em tempo de execução pelo mesmo motivo do probe sigma/radius
 * em glassEffect.js. Até o Clutter 15 a resposta era
 * `get_seat_state() === Clutter.GrabState.ALL`; o Clutter 18 (GNOME 50)
 * removeu as DUAS coisas — `global.stage.grab()` sempre devolve um grab e
 * a perda posterior do seat virou `is_revoked()`.
 *
 * A ordem dos testes importa: tocar em `Clutter.GrabState.ALL` sem antes
 * checar que `Clutter.GrabState` existe lança TypeError, e esse throw
 * aconteceria com o grab já tomado — exatamente o grab órfão que a
 * validação existe para evitar.
 */
function grabIsUsable(grab) {
    if (!grab) return false;
    if (typeof grab.is_revoked === 'function') return !grab.is_revoked();
    if (Clutter.GrabState && typeof grab.get_seat_state === 'function')
        return grab.get_seat_state() === Clutter.GrabState.ALL;
    // Versão que não expõe nenhuma das duas: pushModal não lançou, e não
    // há o que consultar. Confiar nele é melhor do que recusar abrir.
    return true;
}

/**
 * Launcher de apps em tela cheia, no espírito do Launchpad do macOS:
 * blur do wallpaper, busca no topo, grade A–Z paginada.
 *
 * NÃO é chrome (`Main.layoutManager.addChrome`) e sim um filho do
 * `uiGroup`: chrome é mobília permanente que participa da input region e
 * do cálculo de struts/fullscreen da sessão, e isto aqui é um overlay
 * modal transitório que só existe entre um open() e um close().
 *
 * O ponto perigoso deste arquivo é o grab modal. Enquanto ele estiver de
 * pé, TODO o teclado e o ponteiro da sessão pertencem ao actor do grab —
 * um grab órfão deixa o usuário sem entrada nenhuma, sem outra saída além
 * de matar a sessão. Daí as regras: o grab é a ÚLTIMA coisa adquirida em
 * open() (tudo que pode lançar já rodou antes), é devolvido na PRIMEIRA
 * linha de close(), e destroy() trata "launcher aberto" como caminho
 * normal, não como exceção.
 *
 * O actor do grab NÃO é o overlay, e sim o uiGroup (ver _takeGrab), para
 * que a dock continue clicável por cima da grade como no macOS. Quem
 * segura a modalidade no lugar do overlay é o escudo (_showShield).
 */
export class AppsLauncher {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {number} params.columns colunas da grade (já clampeado pelo chamador)
     * @param {string} params.theme DockTheme.LIGHT | DockTheme.DARK
     * @param {(open: boolean) => void} params.onVisibilityChanged
     * @param {() => number} params.dockInset altura que a dock ocupa na
     *   borda de baixo, consultada a cada abertura
     */
    constructor(params = {}) {
        // Guardado, mas SEM nenhum listener de `changed::`: quem observa as
        // preferências é a extensão, que recria dock e launcher a cada
        // mudança de key. Um listener aqui reagiria duas vezes à mesma
        // troca, uma delas sobre um objeto prestes a ser destruído.
        this._settings = params.settings ?? null;
        // Reclampeado apesar de o chamador já clampear: uma key adulterada
        // não pode pedir uma grade de uma coluna só (ou de duzentas).
        this._columns = Math.max(
            LAUNCHER.MIN_COLUMNS,
            Math.min(
                LAUNCHER.MAX_COLUMNS,
                Math.round(params.columns ?? LAUNCHER.DEFAULT_COLUMNS)
            )
        );
        // Qualquer valor desconhecido cai no claro, como na dock: um tema
        // não reconhecido não pode deixar o overlay sem estilo.
        this._theme =
            params.theme === DockTheme.DARK ? DockTheme.DARK : DockTheme.LIGHT;
        this._onVisibilityChanged = params.onVisibilityChanged ?? null;
        // Callback e não número: a dock fica POR CIMA do launcher (como no
        // macOS) e a altura dela muda com o tamanho do ícone, com a
        // magnificação e com o próprio conteúdo. Perguntar a cada _fit()
        // dá o valor do momento; um número passado na construção
        // congelaria a altura de quando a dock ainda nem tinha ícones.
        this._dockInset = params.dockInset ?? null;

        this._signals = new SignalTracker();
        this._state = State.HIDDEN;
        this._grab = null;
        // Barreira de eventos do grab — ver _showShield().
        this._shield = null;
        // Fica FORA do SignalTracker de propósito: é conectado no objeto
        // Clutter.Grab, que nasce e morre a cada abertura, e não num actor
        // ou num objeto de vida longa.
        this._grabRevokedId = 0;
        this._apps = [];
        this._filtered = [];
        this._pages = [];
        this._dots = [];
        this._icons = [];
        this._page = 0;
        this._selection = -1;
        // A seleção EXISTE sempre (é o que o Enter lança), mas só APARECE
        // depois que o usuário digitou ou navegou com as setas — no
        // Launchpad a grade em repouso não tem nenhum quadro aceso.
        this._selectionVisible = false;
        this._scrollAccum = 0;
        // Eco da nossa própria escrita no campo de busca: open() limpa o
        // texto antes de montar a grade, e sem a supressão o 'text-changed'
        // dessa limpeza montaria a grade uma segunda vez.
        this._suppressSearchEcho = false;
        this._metrics = null;

        this._buildActor();

        // Overview aparecendo (o usuário apertou Super) e troca de
        // monitores são os dois casos em que o overlay sumiria por baixo
        // dos panos: no primeiro ele ficaria escondido atrás do overview
        // ainda segurando o grab, no segundo toda a geometria calculada
        // vira pó.
        this._signals.connect(Main.overview, 'showing', () => this.close());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () =>
            this.close());
    }

    get isOpen() {
        return this._state === State.SHOWING || this._state === State.SHOWN;
    }

    open() {
        if (!this._actor || this.isOpen) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        // TUDO que pode lançar acontece antes do pushModal: uma exceção
        // daqui para cima só custa um launcher que não abriu; depois do
        // grab, custaria a sessão.
        this._apps = getInstalledApps();
        this._filtered = this._apps;
        this._suppressSearchEcho = true;
        this._search.set_text('');
        this._suppressSearchEcho = false;
        this._fit(monitor);
        this._rebuildPages();

        // Topo do uiGroup a cada abertura, e não só na construção: a ordem
        // de criação em relação à chrome da dock (e a qualquer outra coisa
        // adicionada depois) não é garantida.
        this._actor.get_parent()?.set_child_above_sibling(this._actor, null);
        this._actor.remove_all_transitions();
        this._actor.opacity = 0;
        this._actor.set_scale(LAUNCHER.OPEN_SCALE, LAUNCHER.OPEN_SCALE);
        // Visível ANTES do grab: um actor escondido não é alvo válido de
        // grab do seat, e o grab é justamente o que precisa ser validado.
        this._actor.show();
        // Escudo antes do grab, pelo mesmo motivo de tudo o mais que roda
        // aqui em cima: ele é a metade da modalidade que o Clutter deixou
        // de fazer por nós quando o grab subiu para o uiGroup.
        this._showShield();

        if (!this._takeGrab()) {
            // Aborta a abertura em vez de deixar um overlay em tela cheia
            // sem teclado por cima da sessão. A grade recém-montada vai
            // junto: sem abrir, ela seria só umas centenas de texturas de
            // ícone paradas na memória.
            this._hideShield();
            this._actor.hide();
            this._clearPages();
            return;
        }

        this._state = State.SHOWING;
        this._onVisibilityChanged?.(true);
        this._focusSearch();
        this._actor.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: LAUNCHER.OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._actor) return;
                if (this._state === State.SHOWING) this._state = State.SHOWN;
            },
        });
    }

    close() {
        if (!this._actor) return;
        if (this._state === State.HIDDEN || this._state === State.HIDING)
            return;

        // Primeira linha, antes de qualquer animação: o usuário não pode
        // ficar sem teclado durante os CLOSE_MS do fade, e um app lançado
        // daqui precisa do seat livre para receber foco.
        this._releaseGrab();
        this._state = State.HIDING;
        this._onVisibilityChanged?.(false);
        // O ponteiro pode estar sobre uma célula na hora do fechamento; o
        // 'destroy' de cada AppGridIcon devolve o cursor, mas as células só
        // morrem no fim da animação e o ponteiro já está sobre a janela.
        Cursor.setDefault();

        this._actor.remove_all_transitions();
        this._actor.ease({
            opacity: 0,
            scale_x: LAUNCHER.OPEN_SCALE,
            scale_y: LAUNCHER.OPEN_SCALE,
            duration: LAUNCHER.CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._actor) return;
                this._actor.hide();
                this._actor.set_scale(1, 1);
                // Só aqui o estado lógico vira HIDDEN — é o instante em que
                // o overlay realmente sai da tela.
                this._state = State.HIDDEN;
                // Centenas de texturas de ícone não precisam ficar de pé
                // enquanto ninguém olha; open() remonta a grade de qualquer
                // forma, porque a lista de apps pode ter mudado.
                this._clearPages();
            },
        });
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    destroy() {
        // Antes de tudo: um grab que sobrevive ao destroy deixa a sessão
        // sem teclado e sem ponteiro. Este é o caminho normal quando a
        // extensão é desabilitada com o launcher aberto.
        this._releaseGrab();
        const safe = (fn) => {
            try {
                fn();
            } catch (e) {
                logError(e, '[ArcDock] launcher destroy step failed');
            }
        };
        safe(() => this._signals.disconnectAll());
        // Quem nos criou pode estar segurando estado por nossa causa (a
        // dock trava o auto-hide enquanto a grade está aberta). Destruir
        // sem avisar deixaria essa trava de pé sem ninguém para soltá-la.
        if (this.isOpen) safe(() => this._onVisibilityChanged?.(false));
        safe(() => Cursor.setDefault());
        safe(() => this._clearPages());
        safe(() => this._clearDots());
        safe(() => {
            if (this._actor) {
                this._actor.remove_all_transitions();
                this._actor.destroy();
            }
        });
        // Filho solto do uiGroup (não é chrome), então basta destruí-lo —
        // mas não pode ficar para trás: um escudo vivo é uma parede
        // invisível por cima da sessão inteira.
        safe(() => this._shield?.destroy());
        this._shield = null;
        // Destruídos junto com o actor raiz (subárvore), aqui só soltamos
        // as referências para que nada volte a tocar em actor morto.
        this._actor = null;
        this._search = null;
        this._searchBand = null;
        this._bottomBand = null;
        this._dockSpacer = null;
        this._viewport = null;
        this._pagesBox = null;
        this._dotsBox = null;
        this._emptyLabel = null;
        this._onVisibilityChanged = null;
        this._settings = null;
        this._apps = [];
        this._filtered = [];
        this._metrics = null;
        this._state = State.HIDDEN;
    }

    // --- Construção ---

    _buildActor() {
        // Criado ANTES do overlay para já nascer abaixo dele no uiGroup;
        // a posição no z-order é refeita a cada abertura de qualquer
        // forma (ver _showShield).
        this._shield = new St.Widget({
            reactive: true,
            can_focus: false,
            opacity: 0,
            visible: false,
        });
        Main.layoutManager.uiGroup.add_child(this._shield);

        this._actor = new St.BoxLayout({
            style_class: 'arcdock-launcher',
            vertical: true,
            reactive: true,
            can_focus: true,
            visible: false,
        });
        if (this._theme === DockTheme.DARK)
            this._actor.add_style_class_name('arcdock-launcher-dark');
        // Escala de entrada/saída parte do centro do overlay: sem pivot ela
        // cresceria a partir do canto superior esquerdo e o overlay
        // deslizaria na diagonal em vez de "assentar".
        this._actor.set_pivot_point(0.5, 0.5);
        // Aqui o actor é o retângulo inteiro do monitor, então o problema
        // de border-radius que obriga a dock a usar um backdrop recuado
        // (BLUR_INSET) não existe: não há canto arredondado por onde o
        // borrão possa escapar.
        applyGlass(this._actor, {
            radius: LAUNCHER.BLUR_RADIUS,
            brightness: LAUNCHER.BLUR_BRIGHTNESS,
        });

        this._search = new St.Entry({
            style_class: 'arcdock-launcher-search',
            hint_text: 'Search',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            // Sem o CENTER vertical o St.Bin da faixa esticaria o campo
            // (o padrão de alinhamento é FILL) até a altura inteira dela.
            y_align: Clutter.ActorAlign.CENTER,
            width: LAUNCHER.SEARCH_WIDTH,
        });
        this._search.set_primary_icon(
            new St.Icon({
                style_class: 'arcdock-launcher-search-icon',
                icon_name: 'edit-find-symbolic',
                icon_size: 16,
            })
        );
        // Faixa de altura explícita com a busca centralizada dentro dela,
        // em vez de uma margem no próprio campo: margem de ClutterActor só
        // vale se o container a honrar, e o resultado disso era uma busca
        // colada na borda de cima da tela. A faixa é um filho comum do
        // BoxLayout, com altura pedida por ela mesma — não há como o
        // container "não honrar" o tamanho de um filho.
        this._searchBand = new St.Bin({
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            height: LAUNCHER.SEARCH_BAND_MIN,
        });
        this._searchBand.set_child(this._search);
        this._actor.add_child(this._searchBand);

        // Viewport de layout FIXO (St.Widget sem layout manager): as
        // páginas têm largura explícita e ficam lado a lado dentro dele, e
        // o clip é o que impede a página vizinha de pintar sobre a tela
        // durante o deslize.
        this._viewport = new St.Widget({
            reactive: false,
            clip_to_allocation: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pagesBox = new St.BoxLayout({ vertical: false, reactive: false });
        this._viewport.add_child(this._pagesBox);

        this._emptyLabel = new St.Label({
            style_class: 'arcdock-launcher-empty',
            text: 'No results',
            visible: false,
        });
        this._viewport.add_child(this._emptyLabel);
        this._actor.add_child(this._viewport);

        this._dotsBox = new St.BoxLayout({
            style_class: 'arcdock-launcher-dots',
            vertical: false,
            reactive: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            height: DOTS_BAND,
        });
        // Espaço que a DOCK ocupa por cima do launcher, como um filho de
        // verdade em vez de altura extra da faixa: os pontos ficam ACIMA
        // dele por ordem de empilhamento do BoxLayout, e não por
        // alinhamento dentro de uma faixa maior. Um St.Bin alto com o
        // y_align do filho em START era o caminho anterior, e o filho
        // acabava no meio da faixa — isto é, atrás da pílula da dock. A
        // altura real chega em _fit(), via callback.
        this._dockSpacer = new St.Widget({
            reactive: false,
            x_expand: true,
            height: 0,
        });
        // Faixa de baixo = pontos + espaço da dock, nessa ordem. Vertical,
        // porque a ordem dos filhos é a única coisa que decide quem fica
        // em cima de quem.
        this._bottomBand = new St.BoxLayout({
            vertical: true,
            reactive: false,
            x_expand: true,
        });
        this._bottomBand.add_child(this._dotsBox);
        this._bottomBand.add_child(this._dockSpacer);
        this._actor.add_child(this._bottomBand);

        // Sinais de vida longa (raiz e campo de busca vivem enquanto o
        // launcher viver) vão para o tracker. Os das células e dos pontos
        // ficam conectados nos próprios actors: eles são recriados a cada
        // busca e a cada abertura, e um tracker cresceria sem limite ao
        // longo da sessão.
        this._signals.connect(this._actor, 'key-press-event', (actor, event) =>
            this._onKeyPress(event, false));
        this._signals.connect(this._actor, 'scroll-event', (actor, event) =>
            this._onScroll(event));
        // Rede para o leave-event que não chega: o ponteiro que sai de uma
        // célula para o pixel vazio do overlay tem que voltar ao cursor
        // normal — e apagar o anel de hover — mesmo que o St não tenha
        // atualizado o hover da célula. Cada clearHover() sai na primeira
        // linha quando não há nada aceso, que é o caso de quase todo
        // motion-event.
        this._signals.connect(this._actor, 'motion-event', (actor, event) => {
            if (event.get_source?.() === actor) {
                Cursor.setDefault();
                for (const icon of this._icons) icon?.clearHover?.();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // Consumimos o clique SÓ quando ele nasceu no pixel vazio do
        // overlay. Se nasceu num filho, precisa propagar: no GNOME 49+ o
        // St.Button detecta o clique por ClutterClickGesture, e um
        // EVENT_STOP vindo do ancestral cancela o gesture antes de ele
        // virar 'clicked' — foi o que já deixou a dock inteira sem
        // resposta ao botão 1 (ver Dock, stopIfOwnPixel).
        this._signals.connect(
            this._actor,
            'button-press-event',
            (actor, event) =>
                event.get_source?.() === actor
                    ? Clutter.EVENT_STOP
                    : Clutter.EVENT_PROPAGATE
        );
        this._signals.connect(
            this._actor,
            'button-release-event',
            (actor, event) => this._onButtonRelease(actor, event)
        );
        this._signals.connect(
            this._search.clutter_text,
            'key-press-event',
            (actor, event) => this._onKeyPress(event, true)
        );
        this._signals.connect(this._search.clutter_text, 'text-changed', () =>
            this._onSearchChanged());

        // O escudo fecha a grade pelo mesmo gesto do pixel vazio do
        // overlay (soltar o botão), e consome o resto para que nada
        // debaixo dele reaja enquanto a grade está aberta.
        this._signals.connect(this._shield, 'button-press-event', () =>
            Clutter.EVENT_STOP);
        this._signals.connect(this._shield, 'button-release-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._signals.connect(this._shield, 'scroll-event', () =>
            Clutter.EVENT_STOP);

        // Rede para o foco de teclado que sai do overlay SEM que a grade
        // feche: com o grab no uiGroup a dock recebe eventos de verdade,
        // e um St.Button pega foco ao ser pressionado (arrastar um ícone
        // da dock basta). A tecla ainda sobe até o actor do grab, então
        // daqui ela volta para a busca em vez de se perder. Com a grade
        // fechada este handler não olha tecla nenhuma.
        this._signals.connect(
            Main.layoutManager.uiGroup,
            'key-press-event',
            (actor, event) =>
                this.isOpen
                    ? this._onKeyPress(event, false)
                    : Clutter.EVENT_PROPAGATE
        );

        Main.layoutManager.uiGroup.add_child(this._actor);
    }

    // --- Grab modal ---

    /**
     * Toma o grab modal.
     *
     * O actor do grab é o **uiGroup**, e não o overlay. O Clutter entrega
     * evento de ponteiro ao actor do grab e aos DESCENDENTES dele;
     * qualquer outro alvo vira evento para o próprio actor do grab. Com o
     * grab no overlay, a dock — que é chrome, irmã do overlay dentro do
     * uiGroup — ficava inerte enquanto a grade estivesse aberta: clique,
     * hover e tooltip iam todos parar no overlay (e o clique ainda
     * fechava a grade, por cair na regra do "pixel vazio"). Subindo o
     * grab para o ancestral comum, a dock volta a receber os eventos DE
     * VERDADE — nada de evento sintético, então gesture de clique, DND,
     * tooltip e magnificação seguem pelo caminho normal do St.
     *
     * A modalidade não afrouxa por isso. O uiGroup contém também o
     * window_group, então sozinho ele deixaria uma janela em monitor
     * secundário receber clique: quem fecha esse buraco é o escudo
     * (_showShield), que cobre o stage inteiro logo abaixo do overlay.
     * Sobra alcançável exatamente o que está VISUALMENTE por cima dele —
     * a dock — e o teclado continua nosso, porque o foco vai para o campo
     * de busca logo depois do grab.
     *
     * @returns {boolean} true se o teclado/ponteiro é nosso.
     */
    _takeGrab() {
        let grab = null;
        try {
            grab = Main.pushModal(Main.layoutManager.uiGroup, {
                actionMode: Shell.ActionMode.OVERVIEW,
            });
        } catch (e) {
            logError(e, '[ArcDock] launcher pushModal failed');
            grab = null;
        }
        if (!grab) return false;

        // A validação roda com o grab JÁ tomado. Qualquer exceção daqui
        // para baixo deixaria um grab ÓRFÃO — overlay em tela cheia
        // segurando teclado e ponteiro, e ninguém com a referência para
        // devolvê-lo — então "não consegui validar" é tratado como falha,
        // e o grab volta.
        let usable = false;
        try {
            usable = grabIsUsable(grab);
        } catch (e) {
            logError(e, '[ArcDock] launcher grab validation failed');
            usable = false;
        }
        if (!usable) {
            try {
                Main.popModal(grab);
            } catch (e) {
                logError(e, '[ArcDock] launcher popModal (unusable grab)');
            }
            return false;
        }

        this._grab = grab;
        // Rede para o seat roubado DEPOIS da abertura (troca de VT, um
        // cliente com grab exclusivo, o próprio Shell revogando): sem
        // isto o overlay ficaria na tela sem receber mais nada. Só existe
        // onde há a propriedade `revoked`; nas versões sem ela o handler
        // simplesmente não é conectado.
        this._grabRevokedId = 0;
        if ('revoked' in grab) {
            try {
                this._grabRevokedId = grab.connect('notify::revoked', () => {
                    if (grab.revoked) this.close();
                });
            } catch (e) {
                logError(e, '[ArcDock] launcher notify::revoked connect failed');
                this._grabRevokedId = 0;
            }
        }
        return true;
    }

    _releaseGrab() {
        const grab = this._grab;
        const revokedId = this._grabRevokedId;
        this._grab = null;
        this._grabRevokedId = 0;
        if (grab) {
            if (revokedId) {
                try {
                    grab.disconnect(revokedId);
                } catch (e) {
                    logError(e, '[ArcDock] launcher grab disconnect failed');
                }
            }
            try {
                Main.popModal(grab);
            } catch (e) {
                logError(e, '[ArcDock] launcher popModal failed');
            }
        }
        // Fora do `if`, e depois do popModal: o escudo é a metade do
        // modal que fica do lado do ponteiro, então ele cai JUNTO com o
        // grab — inclusive nos caminhos em que já não há grab nenhum para
        // devolver (grab perdido, destroy com a grade meio aberta). Um
        // escudo esquecido de pé seria uma parede invisível em cima da
        // sessão inteira.
        this._hideShield();
    }

    /**
     * Barreira de eventos que cobre o stage inteiro, logo ABAIXO do
     * overlay.
     *
     * Com o grab no uiGroup (ver _takeGrab), tudo que estiver dentro dele
     * volta a ser alvo válido de ponteiro — e o window_group está lá
     * dentro. Sem esta barreira, um clique num monitor secundário, onde o
     * overlay não chega, acertaria a janela atrás e ainda deixaria a
     * grade aberta segurando o teclado. Com ela, o alcançável é só o que
     * está por cima: o overlay e a dock.
     *
     * `opacity: 0` e não `hide()`: actor escondido não é pickable, e o
     * pick é justamente o que se quer dele (mesmo truque do InputCatcher
     * da dock). Ele não é chrome pelo mesmo motivo do overlay: nada aqui
     * é mobília permanente da sessão.
     */
    _showShield() {
        if (!this._shield || !this._actor) return;
        // Stage inteiro e não o monitor primário: é exatamente a área que
        // o overlay NÃO cobre que precisa de barreira.
        this._shield.set_position(0, 0);
        // screen_* é a medida do display; o stage entra como reserva
        // porque um escudo de tamanho zero seria uma barreira que não
        // barra nada.
        this._shield.set_size(
            global.screen_width || global.stage.width,
            global.screen_height || global.stage.height);
        this._shield.show();
        // Logo abaixo do overlay a cada abertura, e não só na construção:
        // o overlay se joga para o topo do uiGroup ao abrir, e a dock se
        // joga para cima dele em seguida.
        this._shield.get_parent()?.set_child_below_sibling(
            this._shield, this._actor);
    }

    _hideShield() {
        this._shield?.hide();
    }

    _focusSearch() {
        // O foco de teclado mora no campo de busca do começo ao fim: é o
        // que faz "digitar em qualquer lugar" filtrar a grade sem nenhum
        // desvio de evento (as células são can_focus: false).
        this._search?.grab_key_focus();
    }

    // --- Geometria ---

    _fit(monitor) {
        this._actor.set_position(monitor.x, monitor.y);
        this._actor.set_size(monitor.width, monitor.height);

        // ensure_style() antes de medir: sem o CSS resolvido o entry devolve
        // altura sem padding nem fonte, e o número de linhas sairia errado.
        this._search.ensure_style();
        const [, searchHeight] = this._search.get_preferred_height(-1);
        // Faixa da busca: proporcional à tela, com o campo centralizado
        // dentro dela, e nunca menor que o próprio campo mais um respiro.
        const searchBand = Math.max(
            searchHeight + 2 * LAUNCHER.GRID_MARGIN_TOP,
            Math.min(
                LAUNCHER.SEARCH_BAND_MAX,
                Math.max(
                    LAUNCHER.SEARCH_BAND_MIN,
                    Math.round(monitor.height * LAUNCHER.SEARCH_BAND_RATIO)
                )
            )
        );
        // Espaço que a dock ocupa por cima do launcher. Vem de fora e é
        // tratado como número não confiável: um valor absurdo (ou um
        // callback que lançou) não pode comer a tela inteira e deixar a
        // grade sem uma linha sequer.
        let dockInset = 0;
        try {
            dockInset = Math.round(this._dockInset?.() ?? 0);
        } catch (e) {
            logError(e, '[ArcDock] launcher dock inset failed');
            dockInset = 0;
        }
        if (!Number.isFinite(dockInset) || dockInset < 0) dockInset = 0;
        dockInset = Math.min(dockInset, Math.floor(monitor.height / 3));
        const bottomBand =
            DOTS_BAND + (dockInset > 0 ? dockInset + LAUNCHER.DOCK_GAP : 0);

        this._searchBand.set_height(searchBand);
        this._searchBand.set_width(monitor.width);
        this._dotsBox.set_height(DOTS_BAND);
        this._dockSpacer.set_height(bottomBand - DOTS_BAND);
        this._bottomBand.set_height(bottomBand);
        this._bottomBand.set_width(monitor.width);

        const cellHeight =
            LAUNCHER.ICON + CELL_LABEL_BAND + 2 * LAUNCHER.CELL_PAD_Y;
        const naturalWidth =
            Math.max(LAUNCHER.ICON, LAUNCHER.LABEL_MAX_WIDTH) +
            2 * LAUNCHER.CELL_PAD_X;
        // Com muitas colunas a linha natural passaria da largura do
        // monitor; a célula encolhe até caber, com o tamanho do ícone como
        // piso (abaixo dele a grade deixaria de ser legível).
        const cellWidth = Math.max(
            LAUNCHER.ICON,
            Math.min(naturalWidth, Math.floor(monitor.width / this._columns))
        );

        // Tudo que não é grade: a faixa da busca, a faixa de baixo (pontos
        // + dock) e as folgas mínimas em volta da grade. O viewport é
        // y_expand/CENTER, então a sobra acima dessas folgas se reparte
        // igualmente entre os dois lados e a grade fica centrada no que
        // resta entre a busca e a dock.
        const chrome =
            searchBand +
            LAUNCHER.GRID_MARGIN_TOP +
            LAUNCHER.GRID_MARGIN_BOTTOM +
            bottomBand;
        // Folga acima e abaixo da grade para o hover não ser cortado pelo
        // clip do viewport. Entra no cálculo das linhas, e não só no
        // tamanho final, senão o viewport pediria mais altura do que o que
        // sobrou entre a busca e a dock.
        const headroom = cellHoverHeadroom(LAUNCHER.ICON);
        const rows = Math.max(
            1,
            Math.floor((monitor.height - chrome - 2 * headroom) / cellHeight)
        );

        this._metrics = {
            columns: this._columns,
            rows,
            cellWidth,
            cellHeight,
            // Rótulo nunca mais largo que a célula: com a célula encolhida
            // por excesso de colunas, um rótulo no tamanho cheio vazaria
            // por cima da célula vizinha.
            labelWidth: Math.max(
                LAUNCHER.ICON,
                Math.min(LAUNCHER.LABEL_MAX_WIDTH, cellWidth - LAUNCHER.CELL_PAD_X)
            ),
            viewportWidth: monitor.width,
            // Duas alturas de propósito: a da GRADE (o que as linhas
            // ocupam, e portanto a altura da página) e a do VIEWPORT, que
            // é a grade mais a folga do hover em cima e embaixo.
            gridHeight: rows * cellHeight,
            viewportHeight: rows * cellHeight + 2 * headroom,
            headroom,
            perPage: this._columns * rows,
        };
        this._viewport.set_size(
            this._metrics.viewportWidth,
            this._metrics.viewportHeight
        );
        // A folga de cima é dada por posição, não por altura de página: o
        // deslize entre páginas anda em translation_x no mesmo actor, e os
        // dois não se atrapalham.
        this._pagesBox.set_position(0, this._metrics.headroom);
    }

    // --- Grade e paginação ---

    _rebuildPages() {
        if (!this._metrics) return;
        this._clearPages();

        const {
            columns,
            rows,
            cellWidth,
            cellHeight,
            labelWidth,
            viewportWidth,
            viewportHeight,
            gridHeight,
            perPage,
        } = this._metrics;
        const apps = this._filtered;

        this._emptyLabel.visible = apps.length === 0;
        if (apps.length === 0) {
            this._emptyLabel.set_width(viewportWidth);
            this._emptyLabel.ensure_style();
            const [, labelHeight] = this._emptyLabel.get_preferred_height(
                viewportWidth
            );
            // Layout fixo no viewport: o centro é posicionado à mão.
            this._emptyLabel.set_position(
                0,
                Math.max(0, Math.round((viewportHeight - labelHeight) / 2))
            );
        }

        const pageCount = Math.ceil(apps.length / perPage);
        for (let page = 0; page < pageCount; page++) {
            const pageActor = new St.BoxLayout({
                vertical: true,
                reactive: false,
                width: viewportWidth,
                height: gridHeight,
            });
            for (let row = 0; row < rows; row++) {
                const first = page * perPage + row * columns;
                if (first >= apps.length) break;
                const rowActor = new St.BoxLayout({
                    vertical: false,
                    reactive: false,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                for (let column = 0; column < columns; column++) {
                    const index = first + column;
                    // A célula entra mesmo vazia: a última linha da última
                    // página tem que ficar alinhada com as de cima, e não
                    // centralizada por conta própria.
                    const cell = new St.Bin({
                        reactive: false,
                        width: cellWidth,
                        height: cellHeight,
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    const app = apps[index];
                    if (app) {
                        const icon = new AppGridIcon({
                            app,
                            iconSize: LAUNCHER.ICON,
                            labelWidth,
                            onActivate: (activated) => this._launch(activated),
                        });
                        cell.set_child(icon);
                        this._icons[index] = icon;
                    }
                    rowActor.add_child(cell);
                }
                pageActor.add_child(rowActor);
            }
            this._pagesBox.add_child(pageActor);
            this._pages.push(pageActor);
        }

        this._updateDots(pageCount);
        this._goToPage(0, false);
        // Seleção sempre na primeira célula: é ela que o Enter lança quando
        // o usuário só digitou e não navegou. O REALCE dela, porém, só
        // aparece quando há busca: a grade recém-aberta do Launchpad não
        // tem nenhum quadro aceso, e um realce parado na primeira célula
        // se confunde com o rastro de um hover que não saiu.
        this._selectionVisible = (this._search?.get_text() ?? '') !== '';
        this._setSelection(apps.length > 0 ? 0 : -1, false);
    }

    _clearPages() {
        for (const icon of this._icons) icon?.destroy();
        this._icons = [];
        for (const page of this._pages) page.destroy();
        this._pages = [];
        this._selection = -1;
        this._selectionVisible = false;
        this._page = 0;
        this._scrollAccum = 0;
        if (this._pagesBox) {
            this._pagesBox.remove_all_transitions();
            this._pagesBox.translation_x = 0;
        }
        if (this._emptyLabel) this._emptyLabel.visible = false;
    }

    _clearDots() {
        for (const dot of this._dots) dot.destroy();
        this._dots = [];
    }

    _updateDots(pageCount) {
        this._clearDots();
        // Uma página só não tem para onde ir: a fileira some, mas a faixa
        // continua reservada (ver DOTS_BAND).
        if (pageCount <= 1) return;
        for (let page = 0; page < pageCount; page++) {
            const pip = new St.Widget({
                style_class: 'arcdock-launcher-dot',
                reactive: false,
                width: LAUNCHER.PAGE_DOT_SIZE,
                height: LAUNCHER.PAGE_DOT_SIZE,
            });
            // O ponto em si tem 8px — pequeno demais como alvo de clique.
            // Quem recebe o clique é um botão com padding em volta dele.
            const button = new St.Button({
                style_class: 'arcdock-launcher-dot-button',
                can_focus: false,
                track_hover: true,
                child: pip,
            });
            button._pip = pip;
            button.margin_left = Math.floor(LAUNCHER.PAGE_DOT_SPACING / 2);
            button.margin_right = Math.floor(LAUNCHER.PAGE_DOT_SPACING / 2);
            button.connect('clicked', () => this._goToPage(page));
            button.connect('notify::hover', () => {
                if (button.hover) Cursor.setPointer();
                else Cursor.setDefault();
            });
            button.connect('destroy', () => {
                if (button.hover) Cursor.setDefault();
            });
            this._dotsBox.add_child(button);
            this._dots.push(button);
        }
        this._updateActiveDot();
    }

    _updateActiveDot() {
        for (let index = 0; index < this._dots.length; index++) {
            const pip = this._dots[index]._pip;
            if (index === this._page)
                pip.add_style_class_name('arcdock-launcher-dot-active');
            else pip.remove_style_class_name('arcdock-launcher-dot-active');
        }
    }

    _goToPage(index, animate = true) {
        if (!this._metrics) return;
        const count = this._pages.length;
        const page = count === 0 ? 0 : Math.max(0, Math.min(count - 1, index));
        this._page = page;
        // Zerado a cada troca: o resto do gesto anterior não pode empurrar
        // a página seguinte junto.
        this._scrollAccum = 0;
        this._updateActiveDot();

        const target = -page * this._metrics.viewportWidth;
        this._pagesBox.remove_all_transitions();
        if (!animate) {
            this._pagesBox.translation_x = target;
            return;
        }
        this._pagesBox.ease({
            translation_x: target,
            duration: LAUNCHER.PAGE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // --- Seleção ---

    _setSelection(index, follow = true) {
        const count = this._filtered.length;
        const next =
            count === 0 ? -1 : Math.max(0, Math.min(count - 1, Math.round(index)));
        if (this._selection >= 0)
            this._icons[this._selection]?.setSelected(false);
        this._selection = next;
        if (next < 0) return;
        this._icons[next]?.setSelected(this._selectionVisible);
        // A seleção arrasta a página: é assim que as setas trocam de página
        // ao cruzar a borda da grade, sem um segundo atalho para isso.
        if (follow && this._metrics)
            this._goToPage(Math.floor(next / this._metrics.perPage));
    }

    _moveSelection(dx, dy) {
        if (!this._metrics || this._filtered.length === 0) return;
        // Navegar com as setas é o gesto que ACENDE o realce; a partir daí
        // ele acompanha a seleção até a próxima remontagem da grade.
        this._selectionVisible = true;
        if (this._selection < 0) {
            this._setSelection(0);
            return;
        }
        this._setSelection(this._selection + dx + dy * this._metrics.columns);
    }

    _launch(app) {
        if (!app) return;
        // Fecha ANTES de ativar: close() devolve o grab na primeira linha, e
        // uma janela nova não consegue tomar o foco enquanto o overlay
        // ainda segura o teclado do seat.
        this.close();
        try {
            app.activate();
        } catch (e) {
            logError(e, '[ArcDock] launcher app activate failed');
        }
    }

    // --- Eventos ---

    _onSearchChanged() {
        if (this._suppressSearchEcho || !this._search) return;
        const query = this._search.get_text() ?? '';
        this._filtered = filterApps(this._apps, query);
        // Reconstrói a paginação inteira e volta para a primeira página: o
        // resultado é outra lista, e manter o índice de página anterior
        // deixaria o usuário olhando para uma página vazia.
        this._rebuildPages();
    }

    _onButtonRelease(actor, event) {
        // Só o pixel "vazio" do overlay fecha. Um clique numa célula ou no
        // campo de busca nasce no filho reactive e nunca chega aqui como
        // source próprio; os containers intermediários são não-reactive de
        // propósito, então o fundo inteiro é este actor.
        if (event.get_source?.() !== actor) return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            this._scrollAccum += dx + dy;
            if (Math.abs(this._scrollAccum) < SMOOTH_SCROLL_STEP)
                return Clutter.EVENT_STOP;
            this._goToPage(this._page + (this._scrollAccum > 0 ? 1 : -1));
            return Clutter.EVENT_STOP;
        }
        if (
            direction === Clutter.ScrollDirection.DOWN ||
            direction === Clutter.ScrollDirection.RIGHT
        )
            this._goToPage(this._page + 1);
        else if (
            direction === Clutter.ScrollDirection.UP ||
            direction === Clutter.ScrollDirection.LEFT
        )
            this._goToPage(this._page - 1);
        return Clutter.EVENT_STOP;
    }

    /**
     * @param {Clutter.Event} event
     * @param {boolean} fromSearch o evento veio do texto da busca (que já
     *   sabe inserir caracteres sozinho) e não da raiz do overlay.
     */
    _onKeyPress(event, fromSearch) {
        const symbol = event.get_key_symbol();
        const modifiers =
            event.get_state() &
            (Clutter.ModifierType.CONTROL_MASK |
                Clutter.ModifierType.MOD1_MASK |
                Clutter.ModifierType.SUPER_MASK);

        switch (symbol) {
        case Clutter.KEY_Escape:
            // Comportamento do Launchpad: o primeiro Escape limpa a busca,
            // o segundo é que fecha.
            if (this._search?.get_text()) this._search.set_text('');
            else this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activateSelection();
            return Clutter.EVENT_STOP;

        // As setas navegam a grade mesmo com o cursor dentro da busca: aqui
        // elas valem mais como navegação do que como movimento de cursor de
        // texto, e é assim que o Launchpad se comporta. Este handler roda
        // antes do handler padrão do ClutterText, então o EVENT_STOP é o
        // que impede o cursor de andar.
        case Clutter.KEY_Left:
            this._moveSelection(-1, 0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
            this._moveSelection(1, 0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._moveSelection(0, -1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._moveSelection(0, 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Page_Up:
            this._goToPage(this._page - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._goToPage(this._page + 1);
            return Clutter.EVENT_STOP;
        }

        if (fromSearch) return Clutter.EVENT_PROPAGATE;

        // Rede de segurança para quando o foco NÃO estiver na busca (algo
        // roubou o foco de teclado dentro do overlay): qualquer caractere
        // imprimível volta a digitar na busca em vez de se perder.
        if (symbol === Clutter.KEY_BackSpace) {
            const text = this._search?.get_text() ?? '';
            this._focusSearch();
            if (text) this._search.set_text(text.slice(0, -1));
            return Clutter.EVENT_STOP;
        }
        if (!modifiers) {
            // get_key_unicode() devolve um gunichar, que o GJS entrega como
            // string de um caractere; a normalização cobre a versão que o
            // entregue como número, para que uma diferença de marshalling
            // não vire exceção dentro de um handler de teclado.
            const raw = event.get_key_unicode?.();
            const unicode =
                typeof raw === 'number' ? String.fromCharCode(raw) : raw ?? '';
            if (unicode && unicode.charCodeAt(0) >= 0x20 &&
                unicode.charCodeAt(0) !== 0x7f) {
                this._focusSearch();
                this._search.set_text((this._search.get_text() ?? '') + unicode);
                // Cursor no fim, senão o próximo caractere digitado entraria
                // antes do que acabou de ser inserido.
                this._search.clutter_text.set_cursor_position(-1);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _activateSelection() {
        if (this._selection < 0) return;
        this._launch(this._filtered[this._selection] ?? null);
    }
}
