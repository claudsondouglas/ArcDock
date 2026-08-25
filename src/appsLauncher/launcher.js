import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DockTheme, LAUNCHER, State } from '../config.js';
import { DesktopShortcut } from '../desktopShortcut.js';
import {
    getArcDeskAppearance,
    setArcDeskIcon,
    setArcDeskName,
} from '../arcdeskBridge.js';
import { AppPropertiesDialog } from '../appPropertiesDialog.js';
import { SignalTracker } from '../trackers.js';
import { applyGlass } from '../glassEffect.js';
import * as Cursor from '../cursor.js';
import { AppGridIcon, CELL_LABEL_BAND, cellHoverHeadroom } from './appGridIcon.js';
import { filterApps, getInstalledApps } from './appList.js';
import { FolderPopup } from './folderPopup.js';
import { GridSlot, SlotPaint } from './gridSlot.js';
import {
    LauncherItemType,
    LauncherLayout,
    makeLauncherId,
} from './launcherLayout.js';

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
 * Quanto dura o voo do ícone da mão do usuário até a casa onde ele vai
 * morar.
 *
 * O arraste termina com o app NO AR: o dnd solta o actor no ponto do
 * ponteiro e, sem esta animação, ele simplesmente sumiria dali para
 * reaparecer noutro lugar no quadro seguinte. O voo é o que amarra o
 * gesto ao resultado — é o mesmo papel que a animação de minimizar faz
 * entre a janela e o ícone da dock.
 *
 * A remontagem da grade ESPERA o voo terminar (ver _flushRefresh): o
 * ícone de verdade nasce no quadro em que o fantasma acaba de pousar, e
 * é essa emenda que faz os dois parecerem o mesmo objeto.
 */
const FLY_MS = 200;
// Voo para dentro de uma pasta: mais longo e com destino menor, porque
// aqui o ícone não pousa — ele CAI dentro de outra coisa. Encolher até
// perto do tamanho de um sub-ícone da capa é o que conta essa história.
const FLY_FOLDER_MS = 240;
const FLY_FOLDER_SCALE = 0.42;
// Folga do relógio que vigia o voo (ver _armFlyWatchdog). Generosa
// de propósito: ele existe para a transição que NÃO chegou, e um
// prazo curto o faria competir com um voo que só está atrasado por
// um quadro perdido.
const FLY_WATCHDOG_SLACK_MS = 400;

/**
 * Quanto dura o afastamento dos vizinhos enquanto o ícone passeia pela
 * grade.
 *
 * Curto, e EASE_OUT_QUAD como toda entrada da extensão: o reflow é
 * RESPOSTA a um ponteiro que já está em movimento. Uma animação longa
 * chegaria atrasada — a grade ainda estaria se abrindo para a casa
 * anterior quando o usuário já está duas casas adiante.
 */
const REFLOW_MS = 170;
// Nomes das transições que o reflow controla, sempre por PROPRIEDADE e
// nunca remove_all_transitions(): o hover e o quique do clique animam
// escala e translação dentro da célula (no stage interno dela), e
// derrubar tudo os congelaria no meio do movimento.
const TRANSLATION_X = 'translation-x';
const TRANSLATION_Y = 'translation-y';

/**
 * Faixa nas laterais do viewport que, com algo na mão, vira "virar a
 * página". Sem ela não haveria como levar um app para outra página: a
 * roda do mouse durante o arraste pertence ao dnd, e soltar para virar a
 * página perderia o gesto.
 */
const PAGE_FLIP_EDGE = 56;
const PAGE_FLIP_MS = 650;

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
     * @param {(desktopId: string) => boolean} [params.isAppPinned] o app
     *   está fixado na dock? Vem de fora porque quem é dono do
     *   `DockItemsStore` é a dock: uma segunda instância dele aqui gravaria
     *   a mesma key duas vezes e brigaria com a supressão de eco que a dock
     *   faz nas próprias escritas.
     * @param {(desktopId: string) => void} [params.onTogglePinned] fixa ou
     *   desafixa. Opcional JUNTO com o anterior: sem os dois, o item de
     *   fixar simplesmente não aparece no menu.
     * @param {(desktopId: string) => boolean} [params.isOnDesk] o app está
     *   na área de trabalho do ArcDesk?
     * @param {(desktopId: string) => void} [params.toggleOnDesk] põe ou tira
     *   da área de trabalho. Opcional JUNTO com o anterior, pela mesma razão
     *   do par acima.
     * @param {(app: Shell.App) => void} [params.onAppActivated] registra a
     *   ativação de um app feita por esta grade.
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
        // Os dois só valem em par: um "Fixar na dock" que sabe consultar o
        // estado mas não sabe gravá-lo (ou o contrário) é um item de menu
        // com rótulo mentiroso.
        this._isAppPinned = typeof params.isAppPinned === 'function'
            ? params.isAppPinned
            : null;
        this._onTogglePinned = typeof params.onTogglePinned === 'function'
            ? params.onTogglePinned
            : null;
        // O par da área de trabalho segue a mesma regra do par de fixar: os
        // dois ou nenhum. Vem da dock e não da ponte direto porque quem sabe
        // montar o id tipado (`app:<desktop-id>`) a partir de um desktop-id
        // é ela.
        this._isOnDesk = typeof params.isOnDesk === 'function'
            ? params.isOnDesk
            : null;
        this._toggleOnDesk = typeof params.toggleOnDesk === 'function'
            ? params.toggleOnDesk
            : null;
        this._onAppActivated = typeof params.onAppActivated === 'function'
            ? params.onAppActivated
            : null;
        // Uma instância para o launcher inteiro, e não uma por célula: os
        // cancellables dela morrem no destroy() daqui, e pendurá-los nas
        // células faria a primeira remontagem da grade cancelar a cópia
        // que o usuário acabou de pedir.
        this._shortcuts = new DesktopShortcut();
        this._propertiesDialog = null;
        // Célula cujo menu de contexto está aberto. É o equivalente ao
        // `isEditingName` do painel de pasta: enquanto ele existe, o
        // teclado é do menu e o _onKeyPress daqui tem que sair da frente.
        this._menuIcon = null;
        // Montada uma vez (depois de _shortcuts e dos callbacks de fixar,
        // que ela captura) e reusada por toda célula que a grade criar.
        this._menuPolicyObject = this._menuPolicy();

        this._signals = new SignalTracker();
        this._state = State.HIDDEN;
        this._grab = null;
        // Barreira de eventos do grab — ver _showShield().
        this._shield = null;
        // Fica FORA do SignalTracker de propósito: é conectado no objeto
        // Clutter.Grab, que nasce e morre a cada abertura, e não num actor
        // ou num objeto de vida longa.
        this._grabRevokedId = 0;
        // Ver _startRedrawPump(): existe só enquanto o overlay está na tela.
        this._redrawPump = null;
        // Ordem, pastas e persistência da grade. O launcher desenha; quem
        // sabe o que existe, em que ordem e dentro de qual pasta é o
        // LauncherLayout.
        this._layout = new LauncherLayout(this._settings);
        this._apps = [];
        // Entries do layout (apps e pastas) na ordem do usuário, e o
        // subconjunto que está na tela. Com busca ativa `_filtered` deixa
        // de ser um recorte de `_entries`: vira uma lista PLANA de apps,
        // inclusive os que moram dentro de pastas.
        this._entries = [];
        this._entryByAppId = new Map();
        this._filtered = [];
        // Estado do arraste em curso. `fromFolderId` só é preenchido
        // quando o ícone saiu de um painel de pasta aberto — é o que
        // transforma o drop na grade em "tirar da pasta".
        this._drag = null;
        // Casas da grade, indexadas pela MESMA posição de `_icons`: a casa
        // existe mesmo vazia (a sobra da última linha), e é ela que pinta
        // o buraco do ícone no ar e o destino do drop.
        this._slots = [];
        // A ÚNICA casa acesa durante um arraste (a reservada) e a pintura
        // com que ela está acesa. Uma só porque os vizinhos fecham o
        // buraco da origem — ver _reserveSlot. O par (casa, pintura) é
        // guardado junto porque a mesma casa troca de pintura no meio do
        // gesto.
        this._paintedSlot = -1;
        this._paintedAs = SlotPaint.NONE;
        // Casa de ORIGEM do ícone no ar (-1 quando ele veio de dentro de
        // uma pasta e ainda não ocupa lugar na grade). É de onde a fila do
        // reflow parte, e é para onde a reserva volta num merge.
        this._emptySlot = -1;
        // Reflow ao vivo: para onde cada ícone está deslocado neste
        // instante (índice na ordem visível -> {dx, dy}) e a casa
        // reservada que gerou esse mapa. O mapa existe para animar só o
        // que mudou, e a casa para sair cedo do caminho quente
        // (handleDragOver roda a cada evento de movimento).
        this._reflow = new Map();
        this._reflowSlot = -1;
        // Ícones em VOO (o actor que o dnd carregava, adotado por nós no
        // drop) e a camada onde eles voam. Enquanto houver um no ar a
        // remontagem da grade fica represada — ver _flushRefresh().
        this._ghosts = [];
        this._ghostLayer = null;
        this._flying = 0;
        // Relógio que garante que a represa acima sempre abre — ver
        // _armFlyWatchdog().
        this._flyWatchdogId = 0;
        // Ícone de origem escondido à mão enquanto o fantasma dele voa.
        this._flySource = null;
        this._refreshPending = false;
        // Ícone que a próxima remontagem deve fazer quicar: a pasta que
        // acabou de nascer ou de engolir um app.
        this._popId = null;
        this._pageFlipId = 0;
        this._pageFlipTarget = -1;
        this._folderPopup = null;
        this._popupKey = '';
        this._openFolderId = null;
        // Marca "este arraste mudou o layout", lida no fim do gesto para
        // decidir se o painel da pasta volta ou fecha.
        this._dragChanged = false;
        this._refreshId = 0;
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
        // reload() antes de build(): as preferências rodam noutro processo
        // e a grade pode ter sido mexida por lá (ou por outra sessão)
        // enquanto este launcher estava fechado.
        this._layout.reload();
        this._entries = this._layout.build(this._apps);
        this._indexEntries();
        this._filtered = this._entries;
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
        // Antes do grab e antes da animação de entrada: a primeira coisa
        // que o blur pinta já precisa ser um quadro inteiro.
        this._startRedrawPump();
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
            this._stopRedrawPump();
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
        // O painel é filho do uiGroup, não da grade: ninguém o esconderia
        // junto, e ele ficaria de pé sobre a sessão com o launcher fechado.
        this._closeFolder(false);
        // Mesma história para o menu de contexto — e ele ainda segura um
        // modal próprio, empilhado por cima do nosso. Fechado aqui, e não
        // deixado para a destruição das células no fim do fade: durante
        // esses CLOSE_MS a grade já não é interativa, e um menu de pé sobre
        // ela seguraria o teclado da sessão.
        this._closeIconMenu();
        // Um ícone em voo mora na camada de fantasmas, que também é filha
        // do uiGroup: sem isto ele continuaria atravessando a tela por
        // cima da sessão enquanto o overlay some por baixo dele.
        this._clearGhosts();
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
                this._stopRedrawPump();
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

    // --- Bomba de repintura (artefato do blur de fundo) ---

    /**
     * Força o overlay inteiro a ser repintado a cada quadro enquanto está
     * na tela.
     *
     * Sem isto o blur deixa RASTROS ESCUROS por onde o ponteiro passou.
     * O motivo é a combinação de repintura parcial com
     * `Shell.BlurMode.BACKGROUND`: o efeito copia o retângulo INTEIRO do
     * actor a partir do framebuffer para usar como fundo, mas o Clutter,
     * quando só um ícone anima, redesenha apenas o retângulo daquele
     * ícone. Fora dele o framebuffer ainda contém o quadro ANTERIOR já
     * composto — isto é, o wallpaper com o borrão e a tinta do launcher
     * por cima. Esse conteúdo já escurecido é o que o efeito captura,
     * borra de novo (sigma 48 espalha bem além da região suja) e pinta
     * dentro da área realmente redesenhada: uma mancha mais escura, com o
     * formato da caixa de dano, que fica na tela até algo sujar aquele
     * pedaço outra vez.
     *
     * `queue_redraw()` no actor raiz suja o volume de pintura inteiro, o
     * que faz o wallpaper abaixo ser redesenhado antes da captura — e aí
     * o que o efeito copia é o fundo de verdade.
     *
     * Por quadro e o tempo todo, e não só durante as animações: QUALQUER
     * dano parcial produz a mancha, inclusive os de um quadro só (o piscar
     * do cursor da busca, o realce da seleção pelo teclado, a grade
     * trocando na busca). Um pulso por animação deixaria justamente esses
     * de fora. O custo fica limitado ao tempo em que a grade está aberta:
     * é um overlay modal e transitório, e enquanto ele existe não há mais
     * nada para o compositor desenhar.
     */
    _startRedrawPump() {
        if (!this._actor) return;
        if (!this._redrawPump) {
            // Timeline do Clutter, e não um timeout do GLib: presa ao
            // actor, ela roda no frame clock do monitor — um quadro nosso
            // para cada quadro pintado, sem sobrar nem faltar.
            this._redrawPump = new Clutter.Timeline({
                actor: this._actor,
                duration: 1000,
                repeat_count: -1,
            });
            this._redrawPump.connect('new-frame', () =>
                this._actor?.queue_redraw());
        }
        if (!this._redrawPump.is_playing()) this._redrawPump.start();
    }

    _stopRedrawPump() {
        this._redrawPump?.stop();
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
        safe(() => this._cancelPageFlip());
        safe(() => this._cancelFlyWatchdog());
        safe(() => {
            if (this._refreshId) {
                GLib.source_remove(this._refreshId);
                this._refreshId = 0;
            }
        });
        // Antes das páginas: o painel tem células que apontam para o mesmo
        // layout, e um painel vivo sobre uma grade destruída é um escudo
        // reactive parado por cima da sessão inteira.
        safe(() => this._folderPopup?.destroy());
        this._folderPopup = null;
        // Antes das páginas, pelo mesmo motivo do painel: o menu é filho do
        // uiGroup e ainda pode estar segurando um modal próprio.
        safe(() => this._closeIconMenu());
        safe(() => this._propertiesDialog?.destroy());
        this._propertiesDialog = null;
        // Cancela qualquer cópia de .desktop em voo. O callback dela
        // sobreviveria ao objeto e tocaria numa notificação de erro de uma
        // extensão que já foi desabilitada.
        safe(() => this._shortcuts?.destroy());
        this._shortcuts = null;
        safe(() => this._layout?.destroy());
        safe(() => this._stopRedrawPump());
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
        // A camada dos fantasmas também é filha solta do uiGroup, e pode
        // ter um ícone no ar neste exato instante: as transições saem
        // primeiro (o onComplete delas volta para cá) e só então o actor.
        safe(() => this._clearGhosts());
        safe(() => this._ghostLayer?.destroy());
        this._ghostLayer = null;
        this._flying = 0;
        this._refreshPending = false;
        // A timeline segura uma referência ao actor raiz (é dele que sai o
        // frame clock); parada acima e solta aqui, some junto com ele.
        this._redrawPump = null;
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
        this._isAppPinned = null;
        this._onTogglePinned = null;
        this._isOnDesk = null;
        this._toggleOnDesk = null;
        this._menuIcon = null;
        this._menuPolicyObject = null;
        this._settings = null;
        this._apps = [];
        this._entries = [];
        this._entryByAppId = new Map();
        this._filtered = [];
        this._drag = null;
        this._slots = [];
        this._reflow = new Map();
        this._reflowSlot = -1;
        this._flySource = null;
        this._layout = null;
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

        // O escudo só CONSOME: nada debaixo dele pode reagir enquanto a
        // grade está aberta. Fechar era o comportamento anterior e saiu
        // pelo mesmo motivo do pixel vazio do overlay (ver
        // _onButtonRelease) — um arraste que termina fora da grade não é
        // um pedido de fechar.
        this._signals.connect(this._shield, 'button-press-event', () =>
            Clutter.EVENT_STOP);
        this._signals.connect(this._shield, 'button-release-event', () =>
            Clutter.EVENT_STOP);
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
        // NADA é conectado a `notify::revoked`, e isso é deliberado.
        //
        // Grab do Clutter é pilha: QUALQUER modal empilhado por cima
        // revoga o de baixo enquanto durar. E o Shell empilha modais o
        // tempo todo por dentro de gestos perfeitamente normais — o
        // arraste de um ícone (dnd.js dá pushModal no próprio actor de
        // eventos assim que o gesto é reconhecido), um menu de contexto,
        // um popup. Fechar a grade ali significava que segurar um ícone
        // para movê-lo derrubava o launcher no primeiro frame do gesto.
        //
        // Perder o grab também não deixa o overlay inútil: ele é um actor
        // reactive de tela cheia no uiGroup, então continua recebendo
        // clique normalmente, e o foco de teclado segue no campo de busca
        // (é para lá que o popModal do modal de cima devolve o foco). O
        // grab dá EXCLUSIVIDADE, não a capacidade de receber evento — e o
        // Shell, pelo mesmo motivo, não observa essa propriedade em lugar
        // nenhum.
        this._grabRevokedId = 0;
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
            // Área útil em coordenadas de STAGE, para o painel de pasta:
            // a tela menos a faixa da busca em cima e a faixa da dock
            // embaixo. É o retângulo dentro do qual o painel tem que
            // caber, e ele não sabe nada da geometria do launcher.
            bounds: {
                x: monitor.x,
                y: monitor.y + searchBand,
                width: monitor.width,
                height: Math.max(
                    cellHeight,
                    monitor.height - searchBand - bottomBand
                ),
            },
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
        const items = this._filtered;
        // O arraste só existe na grade em repouso. Com busca ativa a lista
        // é um recorte por relevância — arrastar ali reordenaria uma ordem
        // que não é a que está na tela, e um app que mora dentro de uma
        // pasta apareceria solto, pronto para ser "reordenado" para um
        // lugar onde ele não está.
        const dnd = this._isSearching() ? null : this._gridDnd();

        this._emptyLabel.visible = items.length === 0;
        if (items.length === 0) {
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

        const pageCount = Math.ceil(items.length / perPage);
        for (let page = 0; page < pageCount; page++) {
            const pageActor = new St.BoxLayout({
                vertical: true,
                reactive: false,
                width: viewportWidth,
                height: gridHeight,
            });
            // A PÁGINA é o alvo de drop da reordenação, e não cada célula:
            // o dnd acha o alvo subindo a árvore de actors a partir do
            // pixel sob o ponteiro, então uma célula vazia (ou o vão entre
            // duas) chega aqui de graça. As células não-reactive não
            // atrapalham — o pick do dnd é PickMode.ALL.
            if (dnd) {
                pageActor._delegate = {
                    handleDragOver: (source, _actor, x, y) =>
                        this._handleGridDragOver(page, source, x, y),
                    // O actor de arraste vai junto para o drop: é ele que
                    // vira o fantasma que voa até a casa de destino.
                    acceptDrop: (source, actor, x, y) =>
                        this._acceptGridDrop(page, source, actor, x, y),
                };
            }
            for (let row = 0; row < rows; row++) {
                const first = page * perPage + row * columns;
                if (first >= items.length) break;
                const rowActor = new St.BoxLayout({
                    vertical: false,
                    reactive: false,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                for (let column = 0; column < columns; column++) {
                    const index = first + column;
                    // A casa entra mesmo vazia: a última linha da última
                    // página tem que ficar alinhada com as de cima, e não
                    // centralizada por conta própria — e uma casa vazia é
                    // um destino de drop tão válido quanto uma ocupada.
                    const slot = new GridSlot({
                        cellWidth,
                        cellHeight,
                        iconSize: LAUNCHER.ICON,
                        // Onde a ARTE começa dentro da célula. O botão é
                        // centralizado verticalmente e sua altura é a da
                        // arte mais o rótulo mais o padding do CSS, então
                        // a sobra de cima é exatamente CELL_PAD_Y — o
                        // padding do botão se cancela na conta, e por isso
                        // este número não precisa consultar o tema.
                        artTop: LAUNCHER.CELL_PAD_Y,
                    });
                    const item = items[index];
                    if (item) {
                        const icon = this._createIcon(item, labelWidth, dnd);
                        slot.setIcon(icon);
                        this._icons[index] = icon;
                    }
                    this._slots[index] = slot;
                    rowActor.add_child(slot);
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
        this._selectionVisible = this._isSearching();
        this._setSelection(items.length > 0 ? 0 : -1, false);
    }

    _clearPages() {
        // Não deveria acontecer: remontar a grade com um gesto em curso
        // destrói o ícone de ORIGEM antes de o dnd processar o drop. O
        // retrato de _onIconDragBegin salva o drop, mas a condição em si é
        // um bug — e diagnosticá-la ao vivo custa um logout inteiro, então
        // ela grita no journal na hora em que acontece.
        //
        // Uma vez por gesto: com o ícone de origem destruído o 'drag-end'
        // dele não volta mais para cá, então `_drag` fica de pé até o
        // próximo arraste e um segundo aviso seria eco do mesmo incidente.
        if (this._drag && !this._drag.gridCleared) {
            this._drag.gridCleared = true;
            console.warn('[ArcDock] launcher grid rebuilt mid-drag');
        }
        // Sem animação: os ícones que carregam o reflow morrem duas
        // linhas abaixo, e animar uma volta que ninguém vai ver só
        // deixaria transições de pé sobre actors prestes a sumir.
        this._cancelReflow(false);
        this._clearTargetSlot();
        this._clearGhosts();
        // Cada célula destrói o próprio menu, e o fechamento dele avisa
        // aqui (_onIconMenuStateChanged) — mas a referência é zerada à mão
        // também: uma célula que morra por um caminho que não emita o
        // fechamento deixaria _menuIcon apontando para um actor morto, e o
        // teclado do launcher ficaria desviado para sempre.
        this._menuIcon = null;
        for (const icon of this._icons) icon?.destroy();
        this._icons = [];
        // Destruídas junto com a página (são filhas dela); aqui só soltamos
        // as referências, para que nada volte a pintar uma casa morta.
        this._slots = [];
        this._flySource = null;
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

    /**
     * O que um clique numa célula faz: app abre, pasta abre o painel.
     * Ponto único porque o mesmo AppGridIcon serve aos dois casos.
     */
    _activate(item, icon) {
        if (!item) return;
        if (item.type === LauncherItemType.FOLDER) {
            this._openFolder(item, icon);
            return;
        }
        this._launch(item.app);
    }

    _launch(app) {
        if (!app) return;
        this._onAppActivated?.(app);
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

    // --- Itens, arraste e pastas ---

    _isSearching() {
        return (this._search?.get_text() ?? '').trim() !== '';
    }

    /**
     * Índice appId -> entry, refeito a cada build().
     *
     * Existe para a BUSCA: filterApps() devolve Shell.App, e a célula
     * precisa do entry (que carrega o id do layout). Reaproveitar o entry
     * que o layout já criou — inclusive o de dentro de uma pasta — mantém
     * um objeto só por app, e é o que faz a célula da busca ter o mesmo id
     * da célula da grade em repouso.
     */
    _indexEntries() {
        this._entryByAppId = new Map();
        const visit = (entry) => {
            if (entry?.type === LauncherItemType.APP && entry.appId)
                this._entryByAppId.set(entry.appId, entry);
        };
        for (const entry of this._entries) {
            if (entry?.type === LauncherItemType.FOLDER)
                (entry.apps ?? []).forEach(visit);
            else visit(entry);
        }
    }

    _entryForApp(app) {
        const appId = app?.get_id?.() ?? null;
        const cached = appId ? this._entryByAppId.get(appId) : null;
        if (cached) return cached;
        // App instalado depois do último build() (a busca roda sobre a
        // lista que open() capturou). Um entry improvisado deixa a célula
        // funcionar; a posição definitiva dele chega na próxima abertura.
        return {
            type: LauncherItemType.APP,
            id: makeLauncherId(LauncherItemType.APP, appId ?? ''),
            appId,
            app,
            name: app?.get_name?.() ?? '',
        };
    }

    _createIcon(item, labelWidth, dnd) {
        if (item?.type === LauncherItemType.APP) {
            const appearance = getArcDeskAppearance(item.id);
            item.name = appearance.name || item.app?.get_name?.() || item.name || '';
            item.customIcon = appearance.icon;
        }
        return new AppGridIcon({
            item,
            iconSize: LAUNCHER.ICON,
            labelWidth,
            onActivate: (activated, icon) => this._activate(activated, icon),
            dnd,
            // Ao contrário do `dnd`, o menu vale também com busca ativa: a
            // lista filtrada é de apps de verdade, e fixar um deles (ou
            // criar um atalho) não mexe em ordem nenhuma.
            //
            // Um objeto SÓ, compartilhado por todas as células: a política
            // não tem estado por ícone (quem é a célula chega como
            // argumento no stateChanged), e uma remontagem cria centenas
            // delas de uma vez.
            menu: this._menuPolicyObject,
        });
    }

    /**
     * Política do menu de contexto das células.
     *
     * O par fixar/desafixar só entra quando a dock forneceu OS DOIS
     * callbacks — o launcher nunca constrói um `DockItemsStore` próprio
     * (ver o construtor).
     */
    _menuPolicy() {
        const policy = {
            createShortcut: (app) => this._shortcuts?.create(app),
            showProperties: (app, icon) => this._showAppProperties(app, icon),
            // Lançar pelo menu é lançar: a grade sai de cena igual a um
            // clique normal na célula. close() devolve o grab na primeira
            // linha e só destrói as células no fim do fade, então chamá-la
            // de dentro do 'activate' de um item não puxa o tapete do menu
            // que ainda está se fechando por cima.
            launch: () => this.close(),
            stateChanged: (icon, isOpen) =>
                this._onIconMenuStateChanged(icon, isOpen),
        };
        // Mesma regra do par de fixar, e pelo mesmo motivo: um item que sabe
        // consultar a área de trabalho mas não sabe gravá-la (ou o
        // contrário) é um rótulo mentiroso. Consultado a CADA abertura,
        // porque o ArcDesk pode ter sido mexido — ou desligado — entre um
        // clique direito e o próximo.
        if (this._isOnDesk && this._toggleOnDesk) {
            policy.isOnDesk = (app) => {
                const appId = app?.get_id?.() ?? null;
                return appId ? this._isOnDesk?.(appId) === true : false;
            };
            policy.toggleOnDesk = (app) => {
                const appId = app?.get_id?.() ?? null;
                if (appId) this._toggleOnDesk?.(appId);
            };
        }
        if (!this._isAppPinned || !this._onTogglePinned) return policy;
        // Consultado a CADA abertura, e não guardado: a dock pode ter sido
        // mexida (inclusive pelas preferências, noutro processo) entre um
        // clique e o próximo.
        policy.isPinned = (app) => {
            const appId = app?.get_id?.() ?? null;
            return appId ? this._isAppPinned?.(appId) === true : false;
        };
        policy.togglePinned = (app) => {
            const appId = app?.get_id?.() ?? null;
            if (appId) this._onTogglePinned?.(appId);
        };
        return policy;
    }

    _showAppProperties(app, icon) {
        const appId = app?.get_id?.() ?? null;
        if (!appId) return;
        const id = makeLauncherId(LauncherItemType.APP, appId);
        const appearance = getArcDeskAppearance(id);
        const appInfo = app?.get_app_info?.() ?? null;
        // O PopupMenu só libera seu modal depois do callback de activate.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._state === State.HIDDEN) return GLib.SOURCE_REMOVE;
            this._propertiesDialog ??= new AppPropertiesDialog();
            this._propertiesDialog.present({
                name: appearance.name || app.get_name?.() || '',
                iconPath: appearance.icon,
                defaultIcon: size => app?.create_icon_texture?.(size),
                appId,
                description: appInfo?.get_description?.() ?? null,
                executable: appInfo?.get_executable?.() ?? null,
                running: app?.get_state?.() === Shell.AppState.RUNNING,
                windowCount: app?.get_windows?.().length ?? 0,
            }, ({ name, iconPath }) => {
                setArcDeskName(id, name);
                if (iconPath) setArcDeskIcon(id, iconPath);
                icon?.setLabelText(name);
                icon?.setCustomIcon(iconPath);
                const entry = this._entryByAppId?.get(appId);
                if (entry) {
                    entry.name = name;
                    entry.customIcon = iconPath;
                }
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _onIconMenuStateChanged(icon, isOpen) {
        if (isOpen) this._menuIcon = icon;
        else if (this._menuIcon === icon) this._menuIcon = null;
    }

    /** Existe um menu de contexto aberto agora? */
    _isMenuOpen() {
        if (!this._menuIcon) return false;
        // Confere no ícone em vez de confiar no campo: se algum caminho
        // destruir a célula sem passar pelo 'open-state-changed' do
        // fechamento, o campo ficaria de pé para sempre e o teclado do
        // launcher morreria junto com ele.
        if (this._menuIcon.isMenuOpen) return true;
        this._menuIcon = null;
        return false;
    }

    _closeIconMenu() {
        const icon = this._menuIcon;
        this._menuIcon = null;
        try {
            icon?.closeMenu();
        } catch (e) {
            logError(e, '[ArcDock] launcher menu close failed');
        }
    }

    _iconById(id) {
        if (!id) return null;
        for (const icon of this._icons) {
            if (icon?.id === id) return icon;
        }
        return null;
    }

    /**
     * Remonta a grade a partir do layout, preservando a página atual.
     *
     * Sempre adiada por idle (ver _scheduleRefresh): quem chama isto é um
     * acceptDrop, e o dnd ainda está mexendo no actor de arraste e na
     * célula de origem quando ele retorna — destruir a grade ali dentro
     * puxaria o tapete de baixo dele.
     */
    _refreshGrid() {
        if (!this._metrics) return;
        const page = this._page;
        this._entries = this._layout.build(this._apps);
        this._indexEntries();
        if (!this._isSearching()) this._filtered = this._entries;
        this._rebuildPages();
        if (page > 0) this._goToPage(page, false);
        // Os fantasmas saem SÓ depois de a grade nova estar de pé: matá-los
        // no fim do voo deixaria um quadro sem ícone nenhum no lugar (o
        // rebuild só acontece no idle seguinte), e é justamente essa emenda
        // que faz o app parecer ter pousado na casa.
        this._clearGhosts();
        if (this._popId) {
            this._iconById(this._popId)?.playAppearPop();
            this._popId = null;
        }
    }

    /**
     * Marca "o layout mudou" e agenda a remontagem para o próximo idle.
     *
     * TUDO que reage a um drop passa por aqui, inclusive fechar o painel
     * da pasta: quem chama é um acceptDrop, e destruir ali dentro a célula
     * de ORIGEM do arraste (o que fechar o painel faz) é mexer num actor
     * que o dnd ainda tem na mão. Um idle depois, o gesto já acabou.
     */
    _scheduleRefresh() {
        this._dragChanged = true;
        // Com um ícone no ar a remontagem espera: ela destrói a grade
        // inteira, e o fantasma que está voando mira uma casa dela. Quem
        // solta a represa é o fim do voo (_flushRefresh).
        if (this._flying > 0) {
            this._refreshPending = true;
            return;
        }
        if (this._refreshId) return;
        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshId = 0;
            if (!this._actor || !this.isOpen) return GLib.SOURCE_REMOVE;
            this._closeFolder(false);
            this._refreshGrid();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Último voo terminou: ou a remontagem represada acontece agora, ou
     * não há remontagem nenhuma e o que sobrou de cenário do arraste tem
     * que sair na mão.
     *
     * O segundo caso é o drop que não mudou nada (soltar o app na própria
     * casa): ninguém vai remontar a grade, então é aqui que o fantasma
     * morre, o buraco se fecha e o ícone escondido volta.
     */
    _flushRefresh() {
        if (this._flying > 0) return;
        if (this._refreshPending) {
            this._refreshPending = false;
            this._scheduleRefresh();
            return;
        }
        this._clearGhosts();
        this._clearTargetSlot();
        this._restoreFlySource();
    }

    /** Política de arraste das células da GRADE. */
    _gridDnd() {
        return {
            canMerge: (source, target) => this._canMerge(source, target),
            merge: (source, target, dragActor) =>
                this._merge(source, target, dragActor),
            onDragBegin: (icon) => this._onIconDragBegin(icon, null),
            onDragEnd: (icon) => this._onIconDragEnd(icon),
            onMergeHover: (icon, hovering) =>
                this._onMergeHover(icon, hovering),
        };
    }

    /** Idem, para as células de DENTRO de um painel de pasta. */
    _folderDnd(folderId) {
        return {
            canMerge: (source, target) => this._canMerge(source, target),
            merge: (source, target, dragActor) =>
                this._merge(source, target, dragActor),
            onDragBegin: (icon) => this._onIconDragBegin(icon, folderId),
            onDragEnd: (icon) => this._onIconDragEnd(icon),
            onMergeHover: (icon, hovering) =>
                this._onMergeHover(icon, hovering),
        };
    }

    _onIconDragBegin(icon, fromFolderId) {
        // Retrato do que o DROP precisa saber, tirado enquanto o ícone
        // está vivo. O gesto termina no dnd, que pergunta ao `_delegate`
        // da origem qual é o item — e se alguma coisa destruir a grade no
        // meio do caminho, esse ícone já teve o `_item` zerado e o drop
        // seria recusado por todos os alvos (nem mover, nem virar pasta).
        // O modelo só é mexido NO drop, então o retrato continua valendo:
        // ele descreve o item, não o actor.
        this._drag = {
            icon,
            fromFolderId,
            id: icon?.id ?? null,
            item: icon?.item ?? null,
            // Ver _clearPages(): marca de "a grade caiu no meio deste
            // gesto", para o aviso sair uma vez só.
            gridCleared: false,
        };
        this._dragChanged = false;
        // A casa de origem acende como BURACO: neste primeiro instante
        // ainda é ela a casa RESERVADA — nada se moveu, e é para ali que
        // o app volta se o gesto acabar sem sair do lugar. Do primeiro
        // handleDragOver em diante a reserva passa a ser a casa sob o
        // ponteiro, e esta se fecha junto com o reflow (_reserveSlot).
        const at = this._icons.indexOf(icon);
        this._emptySlot = at;
        // Guardada também como reserva vigente do reflow: enquanto o
        // ponteiro não sair da casa de onde o ícone saiu não há nada a
        // recalcular — com `from === k` ninguém se desloca.
        this._reflowSlot = at;
        this._paintSlot(at, SlotPaint.EMPTY);
        // O painel sai da frente enquanto o app está no ar: o escudo dele
        // cobre a grade inteira, e é a GRADE que precisa receber este drop
        // (é assim que se tira um app da pasta). Sai por opacidade, não
        // destruído: destruí-lo mataria a célula de origem no meio do
        // gesto, e é ela que o dnd usa para desfazer um drop recusado.
        if (fromFolderId) this._folderPopup?.setDragMode(true);
    }

    /**
     * O ponteiro parou sobre um ícone que aceita virar pasta.
     *
     * Desfaz o reflow e devolve a reserva à casa de ORIGEM: a resposta ao
     * drop deixou de ser "entra nesta posição" e passou a ser "junta com
     * este ícone", e por causa dele nada vai se reorganizar. A grade
     * aberta no meio do caminho continuaria prometendo um lugar que este
     * drop não usa.
     *
     * Quando o ponteiro sai do ícone, o handleDragOver da página volta a
     * correr e o reflow se refaz sozinho.
     */
    _onMergeHover(_icon, hovering) {
        if (!hovering) return;
        this._cancelReflow();
        this._paintSlot(this._emptySlot, SlotPaint.EMPTY);
    }

    _onIconDragEnd(icon) {
        const fromFolderId = this._drag?.fromFolderId ?? null;
        this._drag = null;
        this._cancelPageFlip();
        // Com um voo em curso o ícone de origem VOLTA a se esconder: o
        // AppGridIcon já se mostrou de novo (é o que ele faz no fim de
        // todo gesto), e deixá-lo aceso poria o mesmo app em dois lugares
        // enquanto o fantasma atravessa a tela. Quem o traz de volta é a
        // grade nova — ou _flushRefresh, quando não há grade nova.
        //
        // O REFLOW fica de pé pelo mesmo motivo: o fantasma pousa
        // exatamente na casa que os vizinhos abriram, e zerar as
        // translações agora faria a grade saltar para trás e, um idle
        // depois, para a frente outra vez. Quem as apaga é a remontagem
        // (os ícones novos nascem sem translação nenhuma).
        //
        // A condição é o VOO, e não o ícone estar na grade: um app que veio
        // de dentro de uma pasta tem a célula de origem no painel, e testar
        // pela grade zeraria o reflow no meio do voo justamente nesse caso.
        if (this._flying > 0) {
            if (this._icons.indexOf(icon) !== -1) {
                this._flySource = icon;
                icon.hide();
            }
        } else {
            this._clearTargetSlot();
        }
        if (!fromFolderId) return;
        // Drop aceito: a pasta mudou, e quem fecha o painel é o idle de
        // _scheduleRefresh (fechar aqui destruiria a célula de origem
        // ainda dentro do gesto). Drop recusado ou cancelado: nada mudou,
        // e o painel volta como estava.
        if (!this._dragChanged) this._folderPopup?.setDragMode(false);
    }

    /**
     * O item da ORIGEM do arraste: do próprio ícone enquanto ele existe,
     * do retrato de _onIconDragBegin quando ele já não existe mais.
     *
     * O retrato só vale para o ícone que ABRIU este arraste. Um source
     * desconhecido (outro draggable do Shell subindo pela mesma árvore)
     * nunca pode herdar o item de um gesto que não é dele — seria um drop
     * aceito em nome do app errado.
     */
    _dragItemOf(source) {
        if (source?.item) return source.item;
        if (!this._drag || source !== this._drag.icon) return null;
        return this._drag.item ?? null;
    }

    /** Idem para o id do layout, que é o que o modelo consome. */
    _dragIdOf(source) {
        if (source?.id) return source.id;
        if (!this._drag || source !== this._drag.icon) return null;
        return this._drag.id ?? null;
    }

    // --- Juntar em pasta ---

    _canMerge(sourceIcon, targetIcon) {
        if (this._isSearching()) return false;
        const source = this._dragItemOf(sourceIcon);
        // O alvo é o ícone sob o ponteiro, vivo por definição: ele é quem
        // está sendo perguntado.
        const target = targetIcon?.item ?? null;
        if (!source || !target || source === target) return false;
        // Pasta dentro de pasta não existe aqui, do mesmo jeito que no
        // Launchpad: um nível só mantém o gesto de arrastar previsível.
        if (source.type !== LauncherItemType.APP) return false;
        if (target.type === LauncherItemType.FOLDER) {
            return !(target.apps ?? []).some(entry => entry?.id === source.id);
        }
        return target.type === LauncherItemType.APP;
    }

    _merge(sourceIcon, targetIcon, dragActor) {
        const source = this._dragItemOf(sourceIcon);
        const target = targetIcon?.item ?? null;
        if (!source || !target) return false;
        const fromFolderId = this._drag?.fromFolderId ?? null;

        let changed = false;
        // O id da pasta RESULTANTE, guardado para o quique de chegada: ele
        // roda no ícone novo, depois da remontagem, e a essa altura o
        // targetIcon daqui já foi destruído.
        let folderId = null;
        if (target.type === LauncherItemType.FOLDER) {
            // addToFolder já tira o app da pasta de origem, quando havia
            // uma; a pasta que ficar com um membro só se dissolve sozinha
            // no próximo build().
            changed = this._layout.addToFolder(target.folderId, source.id);
            if (changed) folderId = target.id;
        } else if (fromFolderId) {
            // Saiu de uma pasta e caiu em cima de um app solto: é uma
            // pasta nova, e o app tem que deixar a antiga antes.
            changed = this._layout.removeFromFolder(fromFolderId, source.id, -1);
            if (changed) {
                folderId = this._layout.createFolder(target.id, source.id);
                changed = folderId !== null;
            }
        } else {
            folderId = this._layout.createFolder(target.id, source.id);
            changed = folderId !== null;
        }
        if (!changed) return false;

        // Voo primeiro, agendamento depois: é o voo que incrementa o
        // contador que faz _scheduleRefresh represar a remontagem.
        this._flyGhost(dragActor, targetIcon.getArtRect(), {
            duration: FLY_FOLDER_MS,
            scale: FLY_FOLDER_SCALE,
            fade: true,
        });
        this._popId = folderId;
        this._scheduleRefresh();
        return true;
    }

    // --- Reordenar (a página é o alvo) ---

    _isReorderSource(source) {
        return (
            !this._isSearching() &&
            source instanceof AppGridIcon &&
            // Retrato como reserva: um ícone destruído no meio do gesto
            // não tem mais `item`, e sem isto o drop seria recusado
            // justamente no instante em que o usuário soltou.
            !!this._dragItemOf(source)
        );
    }

    _handleGridDragOver(page, source, x, y) {
        if (!this._isReorderSource(source)) return DND.DragMotionResult.NO_DROP;
        this._maybePageFlip(x);
        this._reserveSlot(this._dropSlotAt(page, x, y));
        return DND.DragMotionResult.MOVE_DROP;
    }

    _acceptGridDrop(page, source, dragActor, x, y) {
        if (!this._isReorderSource(source)) return false;
        const sourceId = this._dragIdOf(source);
        if (!sourceId) return false;
        const index = this._dropSlotAt(page, x, y);
        this._cancelPageFlip();
        // O retângulo é lido AGORA, com a grade ainda de pé: a casa é
        // destruída pela remontagem que este drop agenda, e o voo mira
        // onde ela estava no instante em que o usuário soltou.
        const rect = this._slots[index]?.artRect() ?? null;

        const fromFolderId = this._drag?.fromFolderId ?? null;
        // O índice é o da CASA sob o ponteiro, e é para lá que o app vai:
        // é a mesma coordenada que moveTo() e removeFromFolder() esperam
        // (posição final na ordem visível, já sem o item que se moveu).
        const changed = fromFolderId
            ? this._layout.removeFromFolder(fromFolderId, sourceId, index)
            : this._layout.moveTo(sourceId, index);

        this._flyGhost(dragActor, rect, { duration: FLY_MS });
        if (changed) this._scheduleRefresh();
        // true mesmo quando nada mudou: soltar no mesmo lugar é um drop
        // TRATADO, e devolver false faria a arte voar de volta à origem
        // como se o gesto tivesse falhado.
        return true;
    }

    /**
     * Qual CASA da grade está sob um ponto da página.
     *
     * `x`/`y` são locais à página (o dnd já converteu), então o deslize
     * entre páginas e a folga do hover no topo do viewport não entram na
     * conta. Piso e não arredondamento: o que se procura não é a fronteira
     * entre duas células, é a célula inteira — o alvo do arraste é a casa,
     * e ela ocupa toda a largura da coluna.
     *
     * Devolve o índice na lista visível, que é o mesmo espaço de
     * coordenadas de moveTo(): soltar sobre a casa `k` põe o app na
     * posição `k`, empurrando o resto para o lado.
     */
    _dropSlotAt(page, x, y) {
        const m = this._metrics;
        const onPage = Math.max(
            0,
            Math.min(m.perPage, this._filtered.length - page * m.perPage)
        );
        const rowsOnPage = Math.max(1, Math.ceil(onPage / m.columns));
        const row = Math.max(
            0,
            Math.min(rowsOnPage - 1, Math.floor(y / m.cellHeight))
        );
        const originX = Math.round(
            (m.viewportWidth - m.columns * m.cellWidth) / 2
        );
        const col = Math.max(
            0,
            Math.min(m.columns - 1, Math.floor((x - originX) / m.cellWidth))
        );
        // As casas vazias do fim da última linha não são posições da
        // lista: soltar em qualquer uma delas é "vai para o fim". O teto
        // sobe um quando o app vem de dentro de uma pasta — ele ainda não
        // ocupa lugar nenhum na grade, então há uma casa a mais para
        // entrar.
        const extra = this._drag?.fromFolderId ? 1 : 0;
        const last = Math.max(0, this._filtered.length - 1 + extra);
        return Math.min(last, page * m.perPage + row * m.columns + col);
    }

    /**
     * Reserva a casa `index` para o ícone que está no ar: acende ela e
     * empurra os vizinhos para abri-la.
     *
     * UMA casa acesa por vez, e sempre a reservada. Com o reflow os
     * vizinhos fecham o buraco da origem no mesmo movimento, então o
     * único vazio de verdade na tela é a casa onde o app vai cair — duas
     * casas acesas anunciariam dois lugares livres, e um deles seria
     * mentira.
     */
    _reserveSlot(index) {
        this._paintSlot(index, SlotPaint.TARGET);
        this._applyReflow(index);
    }

    /**
     * Acende uma casa e apaga a que estava acesa.
     *
     * Guarda o par (casa, pintura) porque a MESMA casa troca de pintura
     * no meio do gesto: a de origem nasce como BURACO e vira ALVO no
     * instante em que o ponteiro volta para cima dela.
     */
    _paintSlot(index, paint) {
        if (index === this._paintedSlot && paint === this._paintedAs) return;
        if (index !== this._paintedSlot)
            this._slots[this._paintedSlot]?.setPaint(SlotPaint.NONE);
        this._paintedSlot = index;
        this._paintedAs = paint;
        this._slots[index]?.setPaint(paint);
    }

    /** Apaga a casa acesa e desfaz o reflow: o gesto acabou. */
    _clearTargetSlot() {
        this._slots[this._paintedSlot]?.setPaint(SlotPaint.NONE);
        this._paintedSlot = -1;
        this._paintedAs = SlotPaint.NONE;
        this._emptySlot = -1;
        this._cancelReflow();
    }

    // --- Reflow ao vivo (os vizinhos abrindo a casa) ---

    /**
     * Reorganiza a grade para abrir a casa `index`.
     *
     * Translação e NUNCA remontagem: cada _rebuildPages() recria centenas
     * de texturas de ícone, e fazer isso por evento de movimento é
     * impagável. As casas (GridSlot) ficam exatamente onde estão — o que
     * se move é só o ícone dentro delas.
     */
    _applyReflow(index) {
        // handleDragOver roda a cada evento de movimento: enquanto o
        // ponteiro anda DENTRO da mesma casa não há nada a recalcular, e
        // reiniciar as mesmas translações a cada quadro as deixaria
        // presas no primeiro instante do ease, sem nunca chegar.
        if (index === this._reflowSlot) return;
        this._reflowSlot = index;
        this._setReflow(this._reflowShifts(index));
    }

    /**
     * Quem se desloca, e para onde, se o ícone no ar tomar a casa `k`.
     *
     * `from` é a casa que ele ocupa hoje (-1 quando veio de dentro de uma
     * pasta e ainda não ocupa nenhuma): a fila entre `from` e `k` anda uma
     * casa no sentido contrário ao do ícone, e vindo de uma pasta é a fila
     * inteira a partir de `k` que anda para a frente.
     *
     * O efeito para na borda da PÁGINA. Se a fila não couber inteira na
     * página que está na tela, ela simplesmente não é mostrada: o ícone da
     * ponta iria para uma página que ninguém está vendo, e deixá-lo parado
     * enquanto o vizinho avança poria dois ícones na mesma casa — que se
     * lê pior do que nada se mexendo.
     *
     * @returns {Map<number, {dx: number, dy: number}>}
     */
    _reflowShifts(k) {
        const shifts = new Map();
        const m = this._metrics;
        if (!m || k < 0) return shifts;
        const from = this._emptySlot;
        if (from === k) return shifts;

        const page = Math.floor(k / m.perPage);
        const pageStart = page * m.perPage;
        const pageEnd = pageStart + m.perPage - 1;

        let lo, hi, delta;
        if (from === -1) {
            lo = k;
            hi = this._icons.length - 1;
            delta = 1;
        } else if (from < k) {
            lo = from + 1;
            hi = k;
            delta = -1;
        } else {
            lo = k;
            hi = from - 1;
            delta = 1;
        }
        // Recortado na página ANTES de decidir se cabe: o que está fora da
        // tela não se mexe de qualquer jeito, e é a ponta do trecho
        // visível que decide.
        lo = Math.max(lo, pageStart);
        hi = Math.min(hi, pageEnd);
        if (lo > hi) return shifts;
        if (delta === 1 ? hi + 1 > pageEnd : lo - 1 < pageStart) return shifts;

        for (let index = lo; index <= hi; index++) {
            if (!this._icons[index]) continue;
            shifts.set(index, this._cellDelta(index, index + delta, pageStart));
        }
        return shifts;
    }

    /**
     * Deslocamento entre duas casas da mesma página, em pixels.
     *
     * Aritmética das métricas, e não geometria de actor: toda linha tem
     * `columns` casas (as sobras entram vazias) e todas têm o mesmo
     * tamanho, então a conta é exata — e imune ao fato de o ícone já estar
     * transladado, que é justamente o que uma leitura de posição
     * transformada não seria.
     */
    _cellDelta(from, to, pageStart) {
        const m = this._metrics;
        const a = from - pageStart;
        const b = to - pageStart;
        return {
            dx: ((b % m.columns) - (a % m.columns)) * m.cellWidth,
            dy:
                (Math.floor(b / m.columns) - Math.floor(a / m.columns)) *
                m.cellHeight,
        };
    }

    /** Anima só a diferença entre o reflow vigente e o novo. */
    _setReflow(shifts) {
        for (const index of this._reflow.keys()) {
            if (!shifts.has(index)) this._easeIcon(this._icons[index], 0, 0);
        }
        for (const [index, delta] of shifts) {
            const current = this._reflow.get(index);
            if (current && current.dx === delta.dx && current.dy === delta.dy)
                continue;
            this._easeIcon(this._icons[index], delta.dx, delta.dy);
        }
        this._reflow = shifts;
    }

    /**
     * Devolve todo mundo ao lugar.
     *
     * NÃO é chamado quando o drop é aceito: a grade nova só nasce quando o
     * fantasma termina o voo (ver _flushRefresh), e zerar as translações
     * antes disso faria a grade saltar para trás e, um idle depois, para a
     * frente de novo. Nesse caminho quem apaga o reflow é a remontagem.
     */
    _cancelReflow(animate = true) {
        this._reflowSlot = -1;
        if (this._reflow.size === 0) return;
        const shifted = this._reflow;
        this._reflow = new Map();
        for (const index of shifted.keys())
            this._easeIcon(this._icons[index], 0, 0, animate);
    }

    _easeIcon(icon, dx, dy, animate = true) {
        if (!icon) return;
        icon.remove_transition(TRANSLATION_X);
        icon.remove_transition(TRANSLATION_Y);
        if (!animate) {
            icon.translation_x = dx;
            icon.translation_y = dy;
            return;
        }
        icon.ease({
            translation_x: dx,
            translation_y: dy,
            duration: REFLOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // --- Voo do ícone até a casa ---

    /**
     * Adota o actor que o dnd carregava e o faz voar até `rect`.
     *
     * Adotar é literal: o dnd destrói o actor de arraste no fim do drop
     * **se ele ainda for filho do uiGroup** (dnd.js), então reparentá-lo
     * para a nossa camada é o que nos dá a posse dele. Sem isso não há
     * animação possível — o ícone simplesmente deixa de existir no quadro
     * do drop.
     *
     * A reparentagem preserva o CENTRO visível, e não o canto: o actor
     * pode chegar com escala do dnd e com pivô em qualquer lugar, e só o
     * centro do retângulo transformado é a mesma coisa nos dois espaços.
     *
     * @param {Clutter.Actor|null} dragActor
     * @param {{x:number,y:number,width:number,height:number}|null} rect
     *   destino em coordenadas de stage
     * @param {object} [opts] `duration`, `scale` (fração do tamanho do
     *   destino) e `fade` (some ao chegar, para o voo até uma pasta)
     */
    _flyGhost(dragActor, rect, opts = {}) {
        if (!dragActor || !rect) return;
        const layer = this._ensureGhostLayer();
        if (!layer) return;

        const scale = dragActor.scale_x || 1;
        const [visualWidth, visualHeight] = dragActor.get_transformed_size();
        const [visualX, visualY] = dragActor.get_transformed_position();
        const width = visualWidth / scale;
        const height = visualHeight / scale;
        const centerX = visualX + visualWidth / 2;
        const centerY = visualY + visualHeight / 2;
        const [layerX, layerY] = this._ghostLayerOrigin(layer);

        // Nada de NaN daqui para baixo. `get_transformed_*` devolve NaN
        // sobre um actor sem alocação válida, e um único NaN nesta conta
        // se espalha por tudo: set_position(NaN) faz clutter_actor_allocate
        // abortar por asserção, o actor nunca recebe alocação, e a ease
        // que deveria decrementar _flying no fim pode nunca chegar lá —
        // o que represa a grade PARA SEMPRE (ver _flushRefresh) e mata o
        // arraste do resto da sessão. Sem voo é feio; com NaN é fatal.
        const geometry = [
            scale, width, height, centerX, centerY, layerX, layerY,
            rect.x, rect.y, rect.width, rect.height,
        ];
        if (!geometry.every(Number.isFinite)) {
            console.warn('[ArcDock] launcher flight geometry not finite; skipping');
            return;
        }

        try {
            dragActor.get_parent()?.remove_child(dragActor);
            layer.add_child(dragActor);
        } catch (e) {
            logError(e, '[ArcDock] launcher drag actor adoption failed');
            return;
        }
        dragActor.set_pivot_point(0.5, 0.5);
        dragActor.set_scale(scale, scale);
        dragActor.set_position(
            Math.round(centerX - layerX - width / 2),
            Math.round(centerY - layerY - height / 2)
        );

        const duration = opts.duration ?? FLY_MS;
        const target = (rect.width * (opts.scale ?? 1)) / Math.max(1, width);
        this._ghosts.push(dragActor);
        this._flying++;
        this._armFlyWatchdog(duration);
        dragActor.remove_all_transitions();
        dragActor.ease({
            x: Math.round(rect.x - layerX + (rect.width - width) / 2),
            y: Math.round(rect.y - layerY + (rect.height - height) / 2),
            scale_x: target,
            scale_y: target,
            opacity: opts.fade ? 0 : 255,
            duration,
            // EASE_OUT_QUAD como toda entrada da extensão: rápido ao sair
            // da mão e assentando na casa, que é o contrário de um ícone
            // que parece ter sido cuspido para o lugar.
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._flying = Math.max(0, this._flying - 1);
                this._flushRefresh();
            },
        });
    }

    /**
     * Canto superior esquerdo da camada de fantasmas, em coordenadas de
     * stage.
     *
     * Pelo PAI e não pela camada: ela é criada e usada no mesmo instante
     * (o primeiro voo da sessão), e um actor que ainda não passou por um
     * ciclo de alocação não tem transformação válida —
     * `get_transformed_position()` ali devolve NaN. O uiGroup, esse,
     * está alocado desde que a sessão subiu, e a camada mora em (0, 0)
     * dentro dele, então a soma é exata e não depende de alocação
     * nenhuma. A leitura direta continua valendo como caminho normal
     * assim que ela existe de verdade.
     */
    _ghostLayerOrigin(layer) {
        const [x, y] = layer.get_transformed_position();
        if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
        const parent = layer.get_parent();
        if (!parent) return [0, 0];
        const [parentX, parentY] = parent.get_transformed_position();
        if (!Number.isFinite(parentX) || !Number.isFinite(parentY))
            return [0, 0];
        return [parentX + layer.x, parentY + layer.y];
    }

    /**
     * Rede de segurança da represa: o voo TEM que acabar.
     *
     * `_flying` só volta a zero no `onComplete` da ease, e uma transição
     * que nunca completa (actor sem alocação, transição removida por um
     * caminho que não passa por `_clearGhosts`, o que for) deixa
     * `_refreshPending` de pé para sempre: a grade nunca mais remonta,
     * o ícone de origem fica escondido e todo drop seguinte vira um
     * gesto sem efeito nenhum. O sintoma é o arraste "funcionar só na
     * primeira vez".
     *
     * O relógio é a única testemunha independente disso. Ele não é o
     * caminho normal — quando ele dispara, alguma coisa saiu do trilho e
     * o journal precisa dizer isso — mas transforma uma quebra
     * permanente num soluço de meio segundo.
     */
    _armFlyWatchdog(duration) {
        this._cancelFlyWatchdog();
        const wait = Math.max(0, Math.round(duration)) + FLY_WATCHDOG_SLACK_MS;
        this._flyWatchdogId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            wait,
            () => {
                this._flyWatchdogId = 0;
                if (this._flying === 0) return GLib.SOURCE_REMOVE;
                console.warn(
                    '[ArcDock] launcher flight never landed; releasing the grid'
                );
                this._flying = 0;
                this._flushRefresh();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelFlyWatchdog() {
        if (!this._flyWatchdogId) return;
        GLib.source_remove(this._flyWatchdogId);
        this._flyWatchdogId = 0;
    }

    /**
     * Camada onde os fantasmas voam: filha do uiGroup, do tamanho da tela
     * inteira, SEMPRE acima do overlay e SEMPRE fora do pick.
     *
     * Fora do actor do launcher de propósito — ele é um BoxLayout
     * vertical, onde um filho posicionado à mão viraria mais uma faixa da
     * pilha, e o viewport, que é o outro candidato, tem
     * clip_to_allocation: um ícone indo para outra linha sairia cortado.
     *
     * `reactive: false` NÃO basta para tirá-la do caminho. O dnd não acha
     * o alvo de drop por evento: ele chama
     * `get_actor_at_pos(PickMode.ALL, …)` e sobe a árvore procurando um
     * `_delegate`. PickMode.ALL enxerga actor não-reactive — é justamente
     * o que faz uma célula vazia da grade poder receber um drop. Uma
     * camada do tamanho da tela no topo do uiGroup é, para esse pick, uma
     * parede: o pick para nela, o pai dela é o uiGroup (que não tem
     * `_delegate` nenhum), e a grade inteira fica inerte — nem
     * `handleDragOver`, nem `acceptDrop`.
     *
     * E a parede só sobe no PRIMEIRO voo, que é o que dava a esse bug a
     * cara de "a primeira vez ordena, a segunda não": a camada nasce
     * DEPOIS do pick do primeiro drop (ele funciona), e a partir dali
     * come todos os outros. Reabrir o launcher "consertava" porque
     * `open()` joga o overlay de volta para o topo do uiGroup — por cima
     * da camada — comprando exatamente mais um drop.
     */
    _ensureGhostLayer() {
        if (!this._actor) return null;
        if (!this._ghostLayer) {
            this._ghostLayer = new St.Widget({ reactive: false });
            Shell.util_set_hidden_from_pick(this._ghostLayer, true);
            Main.layoutManager.uiGroup.add_child(this._ghostLayer);
        }
        // Posição e tamanho explícitos, como o escudo: o uiGroup é de
        // layout fixo, e uma camada sem geometria própria teria a
        // alocação decidida pelos filhos — justamente o que a conta de
        // coordenadas do voo não pode ter se mexendo por baixo dela.
        this._ghostLayer.set_position(0, 0);
        this._ghostLayer.set_size(
            global.screen_width || global.stage.width,
            global.screen_height || global.stage.height);
        // A cada voo, e não só na criação: o overlay se joga para o topo do
        // uiGroup a cada abertura (e o painel de pasta também é filho de
        // lá), então a posição relativa não se mantém sozinha.
        this._ghostLayer
            .get_parent()
            ?.set_child_above_sibling(this._ghostLayer, null);
        return this._ghostLayer;
    }

    _clearGhosts() {
        // O contador zera aqui, e não no onComplete de cada voo: uma
        // transição REMOVIDA não é uma transição terminada — o
        // 'stopped' dela chega com finished=false e o onComplete não roda.
        // Sem este zero a grade ficaria represada para sempre.
        this._flying = 0;
        this._cancelFlyWatchdog();
        this._refreshPending = false;
        for (const ghost of this._ghosts) {
            try {
                ghost.remove_all_transitions();
                ghost.destroy();
            } catch (e) {
                logError(e, '[ArcDock] launcher ghost cleanup failed');
            }
        }
        this._ghosts = [];
    }

    /**
     * Traz de volta o ícone que ficou escondido por causa de um voo que
     * não terminou em remontagem (o drop que não mudou nada).
     */
    _restoreFlySource() {
        const icon = this._flySource;
        this._flySource = null;
        try {
            icon?.show();
        } catch (_) {}
    }

    /**
     * Virar a página segurando o ícone junto à borda do viewport.
     *
     * Com dwell, e não na hora: a borda é justamente por onde o ponteiro
     * passa para alcançar a última coluna, e um giro imediato tornaria
     * impossível soltar um ícone ali.
     */
    _maybePageFlip(x) {
        const width = this._metrics?.viewportWidth ?? 0;
        let target = -1;
        if (x < PAGE_FLIP_EDGE) target = this._page - 1;
        else if (x > width - PAGE_FLIP_EDGE) target = this._page + 1;
        if (target < 0 || target >= this._pages.length) target = -1;
        if (target === this._pageFlipTarget) return;

        this._cancelPageFlip();
        this._pageFlipTarget = target;
        if (target === -1) return;
        this._pageFlipId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PAGE_FLIP_MS,
            () => {
                this._pageFlipId = 0;
                this._pageFlipTarget = -1;
                this._goToPage(target);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelPageFlip() {
        if (this._pageFlipId) {
            GLib.source_remove(this._pageFlipId);
            this._pageFlipId = 0;
        }
        this._pageFlipTarget = -1;
    }

    // --- Painel da pasta ---

    /**
     * O painel é recriado quando a geometria da célula muda (troca de
     * monitor, outra contagem de colunas) e reaproveitado no resto do
     * tempo: ele monta as próprias células, e reconstruí-lo a cada
     * abertura de pasta seria refazer texturas à toa.
     */
    _ensurePopup() {
        const m = this._metrics;
        if (!m) return null;
        const key = `${m.cellWidth}x${m.cellHeight}x${this._columns}`;
        if (this._folderPopup && this._popupKey === key) return this._folderPopup;

        this._folderPopup?.destroy();
        this._popupKey = key;
        this._folderPopup = new FolderPopup({
            // A pasta de origem das células vem do PRÓPRIO painel, e não
            // de _openFolderId: abrir a pasta B com a A aberta é um
            // fecho seguido de uma abertura, e o onClosed do fecho zera
            // aquele campo no meio da montagem da grade da pasta B. O
            // painel já sabe qual pasta está desenhando.
            createIcon: (entry) =>
                this._createIcon(
                    entry,
                    m.labelWidth,
                    this._folderDnd(
                        this._folderPopup?.folderId ?? this._openFolderId
                    )
                ),
            cellWidth: m.cellWidth,
            cellHeight: m.cellHeight,
            // Uma pasta é um recorte pequeno da grade: manter as mesmas
            // colunas da tela inteira deixaria uma pasta de três apps
            // dentro de um painel largo e vazio.
            columns: Math.max(2, Math.min(5, this._columns)),
            theme: this._theme,
            onRename: (folderId, name) => this._renameFolder(folderId, name),
            onClosed: () => {
                this._openFolderId = null;
            },
        });
        return this._folderPopup;
    }

    _openFolder(item, icon) {
        if (!icon || !this._metrics) return;
        // Antes do _ensurePopup(): a fábrica de células lê este campo para
        // saber de qual pasta os ícones que ela cria estão saindo.
        this._openFolderId = item.folderId ?? item.id;
        const popup = this._ensurePopup();
        if (!popup) return;
        popup.open(item, icon.getArtRect(), this._metrics.bounds);
    }

    _closeFolder(animate = true) {
        if (this._folderPopup?.isOpen) this._folderPopup.close(animate);
    }

    _renameFolder(folderId, name) {
        if (!this._layout.renameFolder(folderId, name)) return;
        // Só o rótulo, sem remontar a grade: a remontagem destruiria a
        // célula que o painel aberto está usando de âncora, e o nome é a
        // única coisa que mudou.
        this._iconById(folderId)?.setLabelText(name);
        const entry = this._entries.find(item => item?.id === folderId);
        if (entry) entry.name = name;
    }

    // --- Eventos ---

    _onSearchChanged() {
        if (this._suppressSearchEcho || !this._search) return;
        const query = this._search.get_text() ?? '';
        // Uma busca em curso é outro modo de exibição, não um estado
        // compatível com um painel de pasta aberto por cima da grade.
        this._closeFolder(false);
        // Sem busca a grade é a ordem do usuário, com pastas. Com busca é
        // a lista PLANA de apps por relevância — inclusive os que moram
        // dentro de pastas, que é o comportamento do Launchpad: procurar
        // um app nunca deveria exigir lembrar em que pasta ele foi parar.
        this._filtered = query.trim()
            ? filterApps(this._apps, query).map(app => this._entryForApp(app))
            : this._entries;
        // Reconstrói a paginação inteira e volta para a primeira página: o
        // resultado é outra lista, e manter o índice de página anterior
        // deixaria o usuário olhando para uma página vazia.
        this._rebuildPages();
    }

    _onButtonRelease(actor, event) {
        // O pixel vazio do overlay CONSOME o clique, mas não fecha mais a
        // grade.
        //
        // Fechar aqui transformava o fim de um arraste em fechamento: um
        // ícone solto no vão entre duas células termina exatamente com um
        // button-release sobre o fundo do overlay. A grade sai da tela por
        // três caminhos, e só por eles: abrir um app, Escape, ou o botão
        // Applications da dock.
        if (event.get_source?.() !== actor) return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        // Paginar com uma pasta aberta moveria a âncora do painel para
        // fora da tela; o gesto fecha a pasta e volta para a grade.
        this._closeFolder();
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
        // O nome da pasta está sendo editado: as teclas são dele. Sem esta
        // saída, o desvio "qualquer caractere volta para a busca" roubaria
        // a digitação no meio da palavra.
        if (this._folderPopup?.isEditingName) return Clutter.EVENT_PROPAGATE;
        // Menu de contexto aberto: as teclas são DELE, pela mesma razão.
        //
        // O Escape do menu nem chega aqui — o PopupMenuManager o consome na
        // fase de CAPTURA sobre o actor do menu, e por isso este handler
        // (que é de bolha, no uiGroup) nunca o vê. As outras teclas chegam:
        // o actor do menu é filho do uiGroup, então tudo que ele não
        // consome sobe até nós. Sem esta saída, a primeira letra digitada
        // com o menu aberto cairia no desvio "volta para a busca", que faz
        // `grab_key_focus()` no campo — arrancando o foco do menu e
        // deixando-o aberto sem teclado.
        if (this._isMenuOpen()) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        const modifiers =
            event.get_state() &
            (Clutter.ModifierType.CONTROL_MASK |
                Clutter.ModifierType.MOD1_MASK |
                Clutter.ModifierType.SUPER_MASK);

        switch (symbol) {
        case Clutter.KEY_Escape:
            // Comportamento do Launchpad: o primeiro Escape limpa a busca,
            // o segundo é que fecha. Uma pasta aberta vem antes dos dois —
            // é a camada mais de cima.
            if (this._folderPopup?.isOpen) this._closeFolder();
            else if (this._search?.get_text()) this._search.set_text('');
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

        // Menu de contexto pelo teclado. Passa pelo launcher e não pela
        // célula porque as células são `can_focus: false` (o foco mora na
        // busca do começo ao fim), então elas nunca receberiam a tecla
        // sozinhas — a "seleção" da grade é um realce nosso, não o foco.
        case Clutter.KEY_Menu:
            this._openSelectionMenu();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_F10:
            if (!(event.get_state() & Clutter.ModifierType.SHIFT_MASK))
                break;
            this._openSelectionMenu();
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
        const item = this._filtered[this._selection] ?? null;
        this._activate(item, this._icons[this._selection] ?? null);
    }

    _openSelectionMenu() {
        if (this._selection < 0) return;
        // O realce da seleção pode estar apagado (grade recém-aberta, sem
        // busca nem navegação): abrir um menu sobre uma célula que o usuário
        // não vê selecionada seria um menu vindo do nada.
        if (!this._selectionVisible) {
            this._selectionVisible = true;
            this._setSelection(this._selection, false);
        }
        this._icons[this._selection]?.toggleMenu();
    }
}
