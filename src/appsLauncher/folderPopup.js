import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DockTheme, State } from '../config.js';
import { SignalTracker } from '../trackers.js';
import * as Cursor from '../cursor.js';

/**
 * Respiro entre o ÍCONE da pasta e a borda do painel.
 *
 * Tem que ser maior que a ponta da seta (ARROW_DIAGONAL / 2 ≈ 11px), senão
 * a seta encostaria no ícone e o conjunto viraria uma mancha só. Doze
 * deixa a ponta a um fio de distância do rótulo da célula — o suficiente
 * para o olho ligar o painel àquele ícone, que é a única função da seta.
 */
const ANCHOR_GAP = 12;

/**
 * Folga mínima entre o painel e a borda da área utilizável.
 *
 * `bounds` já exclui a faixa da busca e a da dock, então isto é respiro
 * puro: um painel colado no limite de `bounds` encostaria visualmente no
 * campo de busca ou na pílula da dock, que são justamente as duas coisas
 * que a área utilizável foi calculada para evitar.
 */
const EDGE_MARGIN = 16;

/**
 * Lado do quadradinho que, girado 45°, vira a seta.
 *
 * O que aparece é só metade dele (ver ARROW_OVERLAP), ou seja um triângulo
 * de ~11px de altura por ~22px de base — a mesma proporção achatada que o
 * BoxPointer do Shell usa. Um quadrado maior daria uma seta pontuda demais
 * para um painel de canto arredondado.
 */
const ARROW_SIZE = 16;

/** Largura/altura do quadrado DEPOIS do giro de 45°: a diagonal. */
const ARROW_DIAGONAL = ARROW_SIZE * Math.SQRT2;

/**
 * O quanto a seta entra por baixo do painel.
 *
 * Metade do lado do quadrado, o que coloca o CENTRO dele exatamente sobre
 * a aresta do painel: para dentro fica a metade escondida, para fora sobra
 * o triângulo. Qualquer valor menor deixaria aparecer os dois vértices
 * laterais do losango e a seta pareceria um diamante solto.
 */
const ARROW_OVERLAP = ARROW_SIZE / 2;

/**
 * Distância mínima entre o centro da seta e o canto do painel.
 *
 * Precisa ser >= ao `border-radius` de .arcdock-launcher-folder-panel mais
 * metade da diagonal da seta: dentro do arco do canto não há aresta reta
 * onde a base do triângulo possa se apoiar, e a seta apareceria "flutuando"
 * fora do painel. Mudar o raio no CSS pede revisar este número.
 */
const ARROW_EDGE_INSET = 28 + ARROW_DIAGONAL / 2;

/**
 * Respiro entre o nome da pasta e a primeira linha de ícones.
 *
 * Aplicado como `margin_bottom` da faixa do nome, e não como padding no
 * CSS: a faixa troca de widget (rótulo <-> campo de texto) e a margem
 * pertence ao ESPAÇO entre as duas seções, não a nenhum dos dois widgets.
 * O CSS não deve acrescentar margem vertical própria ali, sob pena de o
 * respiro dobrar.
 */
const TITLE_GAP = 14;

/**
 * Durações do zoom de entrada e de saída.
 *
 * Ligeiramente mais curtas que as do launcher (220/160): o painel é uma
 * caixa pequena percorrendo alguns centímetros, e a mesma duração de um
 * overlay de tela inteira o faria parecer lento.
 */
const OPEN_MS = 200;
const CLOSE_MS = 160;

/**
 * Escala mínima de partida do zoom.
 *
 * A escala natural é `anchor.width / panelWidth`; com um painel muito
 * largo (pasta cheia) isso vira um valor perto de zero e o painel "nasce"
 * de um ponto, o que lê como piscada e não como abertura. O piso mantém a
 * origem reconhecível como um retângulo.
 */
const MIN_OPEN_SCALE = 0.25;

/** Nomes das transições animadas — nunca como string solta no meio do código. */
const TRANSLATION_X = 'translation-x';
const TRANSLATION_Y = 'translation-y';
const SCALE_X = 'scale-x';
const SCALE_Y = 'scale-y';
const OPACITY = 'opacity';

// Sumiço e volta do painel enquanto um app dele está no ar (setDragMode).
// Curto: é uma reação a um gesto que já começou, não uma transição de
// tela — o painel precisa sair antes de o ponteiro chegar à grade.
const DRAG_FADE_MS = 120;

function clamp(value, min, max) {
    // Faixa invertida (o painel é mais largo que o espaço em que a seta
    // poderia andar): devolve o meio, que é o único ponto que não fica
    // pior que os dois extremos.
    if (max < min) return (min + max) / 2;
    return Math.max(min, Math.min(max, value));
}

/**
 * Pendura o conteúdo no St.ScrollView.
 *
 * A API MUDOU dentro da faixa suportada — mesma classe de problema do
 * probe sigma/radius em glassEffect.js e do grabIsUsable() do launcher.
 * Até o GNOME 46 a rolagem recebia o filho por `add_actor()`; do 47 em
 * diante ela virou um StBin comum, com a propriedade `child`, e
 * `add_actor()` deixou de existir. Testamos o método novo primeiro porque
 * é o que sobrevive.
 */
function setScrollChild(scroll, child) {
    if (typeof scroll.set_child === 'function') scroll.set_child(child);
    else scroll.add_actor(child);
}

/**
 * Painel dos apps de uma pasta do launcher, no espírito das pastas do
 * Launchpad: uma cartela que sai do ícone da pasta, com o nome editável em
 * cima e a grade de apps embaixo.
 *
 * O actor raiz é filho do **uiGroup**, e NÃO do actor raiz do launcher.
 * Aquele é um St.BoxLayout vertical (busca / viewport / faixa de baixo):
 * um filho a mais entraria na fila vertical e empurraria a grade para
 * cima, em vez de flutuar por cima dela. Como consequência, tudo aqui
 * trabalha em coordenadas de STAGE — que é justamente o sistema em que
 * `anchor` e `bounds` chegam.
 *
 * O popup NÃO toma grab: o launcher já segura um grab modal no uiGroup e
 * este actor é descendente dele, então recebe eventos de verdade pelo
 * caminho normal do St. Um segundo grab empilhado aqui só criaria mais uma
 * chance de deixar a sessão sem teclado — o cenário que o launcher inteiro
 * é escrito para evitar.
 */
export class FolderPopup {
    /**
     * @param {object} params
     * @param {(appEntry: object) => St.Widget} params.createIcon fábrica de
     *   célula, fornecida pelo launcher (é ele que sabe o tamanho de ícone,
     *   a largura de rótulo e o que fazer no clique)
     * @param {number} params.cellWidth
     * @param {number} params.cellHeight
     * @param {number} params.columns máximo de colunas dentro do painel
     * @param {string} params.theme DockTheme.LIGHT | DockTheme.DARK
     * @param {(folderId: string, name: string) => void} params.onRename
     * @param {() => void} params.onClosed chamado sempre que o painel
     *   termina de fechar
     */
    constructor(params = {}) {
        this._createIcon = params.createIcon ?? null;
        this._cellWidth = Math.max(1, Math.round(params.cellWidth ?? 1));
        this._cellHeight = Math.max(1, Math.round(params.cellHeight ?? 1));
        this._columns = Math.max(1, Math.round(params.columns ?? 1));
        // Qualquer valor desconhecido cai no claro, como na dock e no
        // launcher: um tema não reconhecido não pode deixar o painel sem
        // estilo nenhum.
        this._theme =
            params.theme === DockTheme.DARK ? DockTheme.DARK : DockTheme.LIGHT;
        this._onRename = params.onRename ?? null;
        this._onClosed = params.onClosed ?? null;

        this._signals = new SignalTracker();
        // Mesmo enum do launcher e da dock: SHOWING/SHOWN enquanto o painel
        // está de pé, HIDING durante o fecho, HIDDEN só quando ele já saiu
        // da tela (a troca acontece no onComplete, nunca na chamada do ease).
        this._state = State.HIDDEN;
        this._folderId = null;
        // Nome vigente do lado do modelo. É o valor para o qual o Escape
        // volta, e é contra ele que o commit decide se vale a pena chamar
        // onRename.
        this._folderName = '';
        this._editing = false;
        // Painel apagado e desmapeado porque um app dele está sendo
        // arrastado — ver setDragMode().
        this._dragMode = false;
        // Guarda contra reentrância: devolver o foco ao fim da edição
        // dispara 'key-focus-out' no campo, que é um dos caminhos de commit.
        this._finishing = false;
        this._focusBeforeEdit = null;
        // Ícones e linhas da grade são refeitos a cada open(): quem os cria
        // é a fábrica do launcher, e a pasta aberta muda.
        this._appIcons = [];
        this._rows = [];
        // Geometria da abertura corrente, guardada porque o fecho é o
        // espelho exato dela — sem isto o painel encolheria para o canto
        // superior esquerdo em vez de voltar para o ícone.
        this._openFrom = null;

        this._buildActor();
    }

    get isOpen() {
        return this._state === State.SHOWING || this._state === State.SHOWN;
    }

    /**
     * O campo de nome está com o foco de teclado?
     *
     * O launcher consulta isto antes de desviar tecla para a busca: com a
     * rede dele ligada, digitar o nome da pasta acabaria filtrando a grade
     * atrás do painel.
     */
    get isEditingName() {
        return this._editing;
    }

    get folderId() {
        return this._folderId;
    }

    /**
     * @param {object} folderEntry `{ type:'folder', id, folderId, name, apps }`
     * @param {{x,y,width,height}} anchor retângulo do ÍCONE da pasta, em
     *   coordenadas de stage
     * @param {{x,y,width,height}} bounds área utilizável da tela, em
     *   coordenadas de stage (o monitor menos a faixa de busca em cima e a
     *   faixa da dock embaixo)
     */
    open(folderEntry, anchor, bounds) {
        if (!this._root || !folderEntry || !anchor || !bounds) return;

        // Trocar de pasta com o painel aberto é fecho + abertura, não uma
        // mutação no lugar: o zoom de entrada parte de um ícone específico,
        // e reaproveitar o painel deixaria a animação saindo do ícone
        // errado. Sem animação, porque o que o usuário pediu foi a pasta
        // NOVA — e o onClosed sai de dentro do close(), como em qualquer
        // outro fecho, para que o launcher não fique achando que a pasta
        // anterior continua aberta.
        if (this._state !== State.HIDDEN) this.close(false);

        this._folderId = folderEntry.folderId ?? folderEntry.id ?? null;
        this._folderName = folderEntry.name ?? '';
        this._titleLabel.set_text(this._folderName);

        const apps = Array.isArray(folderEntry.apps) ? folderEntry.apps : [];
        // ensure_style() antes de qualquer medida: sem o CSS resolvido o
        // padding do painel vem zero e a cartela sairia apertada em volta
        // da grade (mesmo cuidado do _fit() do launcher com o campo de
        // busca).
        this._panel.ensure_style();
        const [padX, padY] = this._panelPadding();

        // Largura disponível para a GRADE: a área utilizável menos as
        // folgas das duas bordas e menos o padding do próprio painel.
        const maxGridWidth = Math.max(
            this._cellWidth,
            bounds.width - 2 * EDGE_MARGIN - padX
        );
        const columns = Math.max(
            1,
            Math.min(
                this._columns,
                Math.max(1, apps.length),
                Math.floor(maxGridWidth / this._cellWidth)
            )
        );
        const rows = Math.ceil(apps.length / columns);
        const gridWidth = columns * this._cellWidth;
        const gridHeight = rows * this._cellHeight;

        this._buildGrid(apps, columns, rows, gridWidth, gridHeight);

        const titleBand = this._measureTitleBand(gridWidth);
        // Altura que sobra para a grade depois de descontar tudo o que não
        // é grade. A grade que não couber vira rolagem (ver _buildActor):
        // recortar em silêncio esconderia apps, e paginar dentro do painel
        // é complexidade que só a pasta gigante justificaria.
        const maxGridHeight = Math.max(
            this._cellHeight,
            bounds.height - 2 * EDGE_MARGIN - padY - titleBand - TITLE_GAP
        );
        const scrollHeight = Math.min(gridHeight, maxGridHeight);
        this._scroll.set_size(gridWidth, scrollHeight);
        this._scroll.visible = apps.length > 0;

        const panelWidth = gridWidth + padX;
        const panelHeight =
            titleBand + (apps.length > 0 ? TITLE_GAP + scrollHeight : 0) + padY;
        this._panel.set_size(panelWidth, panelHeight);
        this._entry.set_width(gridWidth);

        this._layout(anchor, bounds, panelWidth, panelHeight);

        // Topo do uiGroup a cada abertura, e não só na construção: o
        // overlay do launcher se joga para o topo ao abrir e a chrome da
        // dock se joga para cima dele em seguida — sem esta linha o painel
        // ficaria por baixo dos dois.
        this._root.get_parent()?.set_child_above_sibling(this._root, null);
        this._root.set_position(0, 0);
        this._root.set_size(
            global.screen_width || global.stage.width,
            global.screen_height || global.stage.height
        );
        // Um arraste interrompido pode ter deixado o painel apagado (ver
        // setDragMode): a abertura seguinte tem que começar opaca.
        this._dragMode = false;
        this._root.remove_transition(OPACITY);
        this._root.opacity = 255;
        if (this._shade) this._shade.reactive = true;
        this._root.show();

        this._state = State.SHOWING;
        this._zoomAndFadeIn();
    }

    /**
     * Fecha o painel. Idempotente; dispara onClosed quando a animação acaba.
     */
    close(animate = true) {
        if (!this._root) return;
        if (this._state === State.HIDDEN || this._state === State.HIDING)
            return;

        // O campo de nome não pode sobreviver ao painel segurando o foco de
        // teclado: para o launcher, isEditingName true com o painel fechado
        // significaria uma busca que nunca mais recebe tecla. Commit, e não
        // descarte — o usuário digitou o nome e clicou fora, que é o gesto
        // universal de "confirma".
        this._finishEditing(true);
        this._state = State.HIDING;
        // O ponteiro pode estar sobre uma célula na hora do fecho; o
        // 'destroy' de cada ícone devolve o cursor, mas as células só
        // morrem no fim da animação.
        Cursor.setDefault();

        if (!animate) {
            this._settleClosed();
            return;
        }
        this._zoomAndFadeOut();
    }

    /**
     * Tira o painel da FRENTE (sem fechá-lo) enquanto um app de dentro
     * dele está sendo arrastado.
     *
     * O escudo cobre a área útil inteira, e o dnd acha o alvo de drop pelo
     * pixel sob o ponteiro: com ele reactive no caminho, um app arrastado
     * para fora da pasta nunca alcançaria a grade — o drop cairia sempre
     * no painel. Apagar por opacidade e soltar o escudo resolve os dois
     * lados de uma vez.
     *
     * Apagar, e não fechar: fechar destruiria a célula de ORIGEM no meio
     * do gesto, e é ela que o dnd usa para desfazer um drop recusado. Quem
     * decide entre voltar (setDragMode(false)) e fechar de verdade é o
     * launcher, no fim do arraste, olhando se algo mudou.
     */
    setDragMode(active) {
        const next = !!active;
        if (!this._root || this._dragMode === next) return;
        this._dragMode = next;
        if (this._shade) this._shade.reactive = !next;
        this._root.remove_transition(OPACITY);
        if (!next) this._root.show();
        this._root.ease({
            opacity: next ? 0 : 255,
            duration: DRAG_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // ESCONDIDO no fim, e não só apagado: o dnd procura o alvo
                // de drop com PickMode.ALL, que devolve actor
                // não-reactive e (dependendo da versão) actor com
                // opacidade zero. Um ícone invisível do painel continuaria
                // sendo um alvo válido bem no meio da grade. Só um actor
                // desmapeado sai do pick com certeza.
                if (this._root && this._dragMode) this._root.hide();
            },
        });
    }

    destroy() {
        // Sem animação e sem callback: quem destrói já está desmontando o
        // launcher inteiro, e um onClosed disparado aqui reentraria num
        // objeto que está no meio do próprio destroy.
        this._onClosed = null;
        const safe = (fn) => {
            try {
                fn();
            } catch (e) {
                logError(e, '[ArcDock] folder popup destroy step failed');
            }
        };
        safe(() => this._signals.disconnectAll());
        safe(() => Cursor.setDefault());
        safe(() => this._clearGrid());
        safe(() => {
            // Transições vivas seguram onComplete apontando para actors que
            // estão prestes a morrer.
            this._panelGroup?.remove_all_transitions();
            this._shade?.remove_all_transitions();
        });
        // Destruir a RAIZ derruba a sombra junto — e a sombra é reativa e do
        // tamanho da área utilizável: esquecida de pé, vira uma parede
        // invisível por cima da sessão, exatamente como o escudo do
        // launcher.
        safe(() => this._root?.destroy());
        this._root = null;
        this._shade = null;
        this._panelGroup = null;
        this._panel = null;
        this._arrow = null;
        this._titleButton = null;
        this._titleLabel = null;
        this._entry = null;
        this._scroll = null;
        this._gridBox = null;
        this._createIcon = null;
        this._onRename = null;
        this._focusBeforeEdit = null;
        this._openFrom = null;
        this._folderId = null;
        this._editing = false;
        this._state = State.HIDDEN;
    }

    // --- Construção ---

    _buildActor() {
        // Raiz de layout FIXO (St.Widget sem layout manager): sombra e
        // painel são posicionados à mão, em coordenadas de stage. Não é
        // reativa — o pick do Clutter desce nos filhos de um actor não
        // reativo do mesmo jeito, então a sombra continua pegando clique
        // sem que a raiz roube o resto da tela.
        this._root = new St.Widget({
            reactive: false,
            visible: false,
        });
        if (this._theme === DockTheme.DARK)
            this._root.add_style_class_name('arcdock-launcher-dark');

        // Sombra: existe para focar a atenção no painel E para pegar o
        // clique de fora. Cobre `bounds`, não o stage: fora da área
        // utilizável estão a busca e a dock, que continuam clicáveis (a
        // dock por cima do launcher é o comportamento do macOS).
        this._shade = new St.Widget({
            style_class: 'arcdock-launcher-folder-shade',
            reactive: true,
            opacity: 0,
            visible: false,
        });
        this._root.add_child(this._shade);

        // Grupo de layout fixo com painel + seta dentro: é ELE que a
        // animação move e escala, para que a seta acompanhe o painel como
        // uma peça só. Escalar o painel e a seta em separado abriria uma
        // fresta entre os dois no meio do caminho.
        this._panelGroup = new St.Widget({ reactive: false });
        this._root.add_child(this._panelGroup);

        // Quadrado girado 45°: o que sobra para fora da aresta do painel é
        // um triângulo apontando para o ícone da pasta. Pivô no centro,
        // senão o giro sai do canto superior esquerdo e o losango aparece
        // deslocado meia diagonal para o lado.
        this._arrow = new St.Widget({
            style_class: 'arcdock-launcher-folder-arrow',
            reactive: false,
            width: ARROW_SIZE,
            height: ARROW_SIZE,
        });
        this._arrow.set_pivot_point(0.5, 0.5);
        this._arrow.rotation_angle_z = 45;
        this._panelGroup.add_child(this._arrow);

        this._panel = new St.BoxLayout({
            style_class: 'arcdock-launcher-folder-panel',
            vertical: true,
            reactive: true,
        });
        if (this._theme === DockTheme.DARK)
            this._panel.add_style_class_name('arcdock-launcher-dark');
        // Painel ACIMA da seta na ordem de empilhamento: a metade do
        // quadrado que entra sob a cartela tem que ficar coberta por ela.
        // Com a seta por cima, a sobreposição de duas superfícies
        // translúcidas desenharia um quadrado mais escuro dentro do painel.
        this._panelGroup.add_child(this._panel);
        this._panelGroup.set_child_below_sibling(this._arrow, this._panel);

        // Nada de applyGlass() aqui, de propósito. O actor raiz do launcher
        // já tem um Shell.BlurEffect de raio 48 cobrindo o monitor inteiro,
        // e o painel se apoia nesse fundo já borrado: um segundo blur
        // capturaria o framebuffer JÁ composto (com a tinta do launcher
        // dentro) e o borraria outra vez, o que só escurece. Pior, o
        // BlurMode.BACKGROUND deixa rastros quando a repintura é parcial —
        // é o que a bomba de repintura do launcher existe para evitar, e
        // ela suja o actor DELE, não este, que é irmão no uiGroup. O painel
        // seria justamente o pedaço fora da mitigação.

        // Faixa do nome: rótulo e campo de texto trocam de lugar por
        // `visible` — um filho invisível não ocupa espaço no BoxLayout, e a
        // altura fixada em _measureTitleBand() garante que a troca não
        // mude o tamanho do painel no meio do gesto.
        //
        // O clique-para-editar vem de um St.Button embrulhando o rótulo, e
        // não de um Clutter.ClickGesture: gesture só existe do GNOME 48 em
        // diante, e o alvo declarado aqui é 46–50. O St.Button funciona nos
        // dois mundos (no 49+ ele próprio roteia o clique por
        // ClutterClickGesture, por dentro). A armadilha conhecida desse
        // caminho é um ancestral devolvendo EVENT_STOP no button-press, que
        // cancela o gesture antes de virar 'clicked' — ver o comentário do
        // stopIfOwnPixel no launcher. Aqui não há esse risco: os ancestrais
        // do botão são o painel, o grupo e a raiz, todos nossos e nenhum
        // deles consome button-press.
        this._titleLabel = new St.Label({
            style_class: 'arcdock-launcher-folder-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._titleButton = new St.Button({
            style_class: 'arcdock-launcher-folder-title-button',
            can_focus: false,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            child: this._titleLabel,
        });
        this._titleButton.margin_bottom = TITLE_GAP;
        this._panel.add_child(this._titleButton);

        this._entry = new St.Entry({
            style_class: 'arcdock-launcher-folder-entry',
            can_focus: true,
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            // Sem o CENTER vertical o BoxLayout esticaria o campo (o padrão
            // é FILL) até a altura reservada para a faixa.
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._entry.margin_bottom = TITLE_GAP;
        this._panel.add_child(this._entry);

        // Rolagem para a pasta que não cabe na altura disponível. A grade em
        // si tem tamanho explícito, então o que a rolagem faz é só recortar
        // e deslizar.
        this._scroll = new St.ScrollView({ reactive: true });
        // Propriedades atribuídas DEPOIS da construção, e não no objeto de
        // init: passar uma propriedade inexistente ao construtor lança, e a
        // superfície do StScrollView mudou entre 46 e 50. Atribuição solta,
        // no pior caso, só cria um campo JS que ninguém lê.
        try {
            this._scroll.hscrollbar_policy = St.PolicyType.NEVER;
            this._scroll.vscrollbar_policy = St.PolicyType.AUTOMATIC;
            // Barra por cima do conteúdo: com a barra ocupando largura, o
            // painel mudaria de tamanho ao passar de uma linha a mais.
            this._scroll.overlay_scrollbars = true;
        } catch (e) {
            logError(e, '[ArcDock] folder popup scroll policy failed');
        }
        this._gridBox = new St.BoxLayout({ vertical: true, reactive: false });
        setScrollChild(this._scroll, this._gridBox);
        this._panel.add_child(this._scroll);

        // --- Sinais de vida longa (os actors acima vivem enquanto o popup
        // viver). As células da grade não entram aqui: nascem e morrem a
        // cada open(), e um tracker cresceria sem limite ao longo da sessão.

        // Clique na sombra fecha. O press é consumido para que nada abaixo
        // dela reaja, e é no RELEASE que o fecho acontece — mesmo par do
        // escudo do launcher.
        this._signals.connect(this._shade, 'button-press-event', () =>
            Clutter.EVENT_STOP);
        this._signals.connect(this._shade, 'button-release-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._signals.connect(this._shade, 'scroll-event', () =>
            Clutter.EVENT_STOP);
        this._signals.connect(this._shade, 'motion-event', () => {
            // A sombra é área morta: se o ponteiro saiu de uma célula para
            // cá, o cursor de mãozinha tem que voltar ao normal.
            Cursor.setDefault();
            return Clutter.EVENT_PROPAGATE;
        });

        // Clique DENTRO do painel (no vazio entre ícones) não pode fechar:
        // o evento sobe até a raiz e a raiz não é reativa, mas o release
        // ainda passaria pela sombra se ela estivesse por cima. Está por
        // baixo — mesmo assim consumimos aqui, porque é o contrato explícito
        // de "clique fora fecha, clique dentro não".
        this._signals.connect(this._panel, 'button-press-event', () =>
            Clutter.EVENT_PROPAGATE);

        this._signals.connect(this._titleButton, 'clicked', () =>
            this._beginEditing());
        this._signals.connect(this._titleButton, 'notify::hover', () => {
            if (this._titleButton?.hover) Cursor.setPointer();
            else Cursor.setDefault();
        });
        this._signals.connect(
            this._entry.clutter_text,
            'key-press-event',
            (actor, event) => this._onEntryKeyPress(event)
        );
        // Foco saindo do campo = commit. Cobre o clique fora, o fecho do
        // painel e qualquer outra coisa que roube o foco: em todos eles o
        // usuário deixou o nome como está, e o gesto lê como confirmação.
        this._signals.connect(this._entry.clutter_text, 'key-focus-out', () => {
            if (this._editing) this._finishEditing(true);
        });

        Main.layoutManager.uiGroup.add_child(this._root);
    }

    // --- Geometria ---

    /** Padding horizontal e vertical do painel, direto do tema resolvido. */
    _panelPadding() {
        try {
            const node = this._panel.get_theme_node();
            return [node.get_horizontal_padding(), node.get_vertical_padding()];
        } catch (e) {
            // get_theme_node() lança quando o actor ainda não tem estilo
            // resolvido. Cartela sem respiro é feia; cartela que não abre é
            // um bug — então segue com zero.
            logError(e, '[ArcDock] folder popup theme node failed');
            return [0, 0];
        }
    }

    /**
     * Altura da faixa do nome, igual para o rótulo e para o campo.
     *
     * Medir os dois e ficar com o maior é o que impede o painel de mudar de
     * tamanho no instante em que o usuário clica no nome: a faixa já nasce
     * do tamanho do widget mais alto dos dois.
     */
    _measureTitleBand(contentWidth) {
        // Altura de volta ao natural ANTES de medir: a abertura anterior
        // fixou uma altura nos dois widgets, e get_preferred_height() de um
        // actor com tamanho fixo devolve o tamanho fixo — a faixa ficaria
        // presa para sempre no valor da primeira pasta aberta.
        this._titleButton.set_height(-1);
        this._entry.set_height(-1);
        this._titleButton.ensure_style();
        this._entry.ensure_style();
        // Largura passada na medida porque o campo tem largura explícita e
        // o rótulo pode quebrar: a altura de um texto depende da largura
        // disponível.
        const [, labelHeight] = this._titleButton.get_preferred_height(
            contentWidth
        );
        const [, entryHeight] = this._entry.get_preferred_height(contentWidth);
        const band = Math.max(labelHeight, entryHeight);
        this._titleButton.set_height(band);
        this._entry.set_height(band);
        return band;
    }

    /**
     * Posiciona sombra, painel e seta em coordenadas de stage.
     *
     * O painel fica centrado no ícone quando dá, grudado na borda de
     * `bounds` quando não dá, ABAIXO do ícone por padrão e acima quando não
     * há altura embaixo. A seta persegue o centro do ícone dentro do que a
     * aresta reta do painel permite.
     */
    _layout(anchor, bounds, panelWidth, panelHeight) {
        this._shade.set_position(bounds.x, bounds.y);
        this._shade.set_size(bounds.width, bounds.height);

        const anchorCenterX = anchor.x + anchor.width / 2;
        const minX = bounds.x + EDGE_MARGIN;
        const maxX = bounds.x + bounds.width - EDGE_MARGIN - panelWidth;
        const panelX = Math.round(
            clamp(anchorCenterX - panelWidth / 2, minX, maxX)
        );

        const below = anchor.y + anchor.height + ANCHOR_GAP;
        const fitsBelow =
            below + panelHeight <= bounds.y + bounds.height - EDGE_MARGIN;
        const above = anchor.y - ANCHOR_GAP - panelHeight;
        const minY = bounds.y + EDGE_MARGIN;
        const maxY = bounds.y + bounds.height - EDGE_MARGIN - panelHeight;
        const panelY = Math.round(clamp(fitsBelow ? below : above, minY, maxY));

        this._panelGroup.set_position(panelX, panelY);
        this._panelGroup.set_size(panelWidth, panelHeight);
        this._panel.set_position(0, 0);

        // Centro da seta em coordenadas do GRUPO. Preso à aresta reta: perto
        // demais do canto e a base do triângulo cairia sobre o arco.
        const arrowCenterX = clamp(
            anchorCenterX - panelX,
            ARROW_EDGE_INSET,
            panelWidth - ARROW_EDGE_INSET
        );
        // A aresta apontada é a de CIMA quando o painel está abaixo do
        // ícone, e a de baixo no caso contrário.
        const arrowCenterY = fitsBelow ? 0 : panelHeight;
        this._arrow.set_position(
            Math.round(arrowCenterX - ARROW_SIZE / 2),
            Math.round(arrowCenterY - ARROW_OVERLAP)
        );

        // Guardado para o fecho: é o mesmo delta, ao contrário.
        this._openFrom = {
            translationX: anchor.x - panelX,
            translationY: anchor.y - panelY,
            scale: Math.max(
                MIN_OPEN_SCALE,
                Math.min(1, anchor.width / Math.max(1, panelWidth))
            ),
        };
    }

    // --- Grade ---

    _buildGrid(apps, columns, rows, gridWidth, gridHeight) {
        this._clearGrid();
        this._gridBox.set_size(gridWidth, gridHeight);
        if (!this._createIcon || apps.length === 0) return;

        for (let row = 0; row < rows; row++) {
            const rowActor = new St.BoxLayout({
                vertical: false,
                reactive: false,
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (let column = 0; column < columns; column++) {
                const index = row * columns + column;
                const entry = apps[index];
                if (!entry) break;
                // Bin de tamanho fixo em volta da célula, como na grade do
                // launcher: é ele que mantém as colunas alinhadas mesmo com
                // rótulos de larguras diferentes.
                const cell = new St.Bin({
                    reactive: false,
                    width: this._cellWidth,
                    height: this._cellHeight,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                let icon = null;
                try {
                    icon = this._createIcon(entry);
                } catch (e) {
                    // Uma célula que não nasceu não pode derrubar a pasta
                    // inteira: o resto dos apps continua utilizável.
                    logError(e, '[ArcDock] folder popup cell failed');
                    icon = null;
                }
                if (icon) {
                    cell.set_child(icon);
                    this._appIcons.push(icon);
                }
                rowActor.add_child(cell);
            }
            this._gridBox.add_child(rowActor);
            this._rows.push(rowActor);
        }
    }

    _clearGrid() {
        // Ícones primeiro e explicitamente: eles têm destroy() próprio (o do
        // AppGridIcon devolve o cursor e para as transições), e destruir só
        // a linha os levaria embora pelo caminho do Clutter, sem passar por
        // ele.
        for (const icon of this._appIcons) {
            try {
                icon?.destroy();
            } catch (e) {
                logError(e, '[ArcDock] folder popup icon destroy failed');
            }
        }
        this._appIcons = [];
        for (const row of this._rows) row.destroy();
        this._rows = [];
    }

    // --- Animação ---

    /**
     * Entrada: o painel nasce em cima do ícone da pasta, no tamanho dele, e
     * cresce até o próprio lugar — o mesmo gesto do
     * AppFolderDialog._zoomAndFadeIn do Shell.
     *
     * O pivô é o canto SUPERIOR ESQUERDO (0, 0), e não o centro: o par
     * "translation = delta entre os cantos + scale = anchor.width /
     * panelWidth" só mapeia o painel sobre o ícone se a escala crescer a
     * partir do mesmo canto que a translação alinhou. Com o pivô no centro
     * o painel escalado sairia meio tamanho para cima e para a esquerda.
     */
    _zoomAndFadeIn() {
        const from = this._openFrom;
        if (!from) return;

        this._panelGroup.remove_all_transitions();
        this._shade.remove_all_transitions();

        this._panelGroup.set_pivot_point(0, 0);
        this._panelGroup.translation_x = from.translationX;
        this._panelGroup.translation_y = from.translationY;
        this._panelGroup.set_scale(from.scale, from.scale);
        this._panelGroup.opacity = 0;
        this._shade.opacity = 0;
        this._shade.show();

        // Dois eases no mesmo actor porque as curvas são diferentes e o
        // ease() do Clutter aplica UM modo a todas as propriedades da
        // chamada: a geometria sai forte e assenta (EASE_OUT_EXPO, que é o
        // que dá a sensação de "salto"), a opacidade sobe linear-ish
        // (EASE_OUT_QUAD) para o painel não aparecer de uma vez no primeiro
        // quadro.
        this._panelGroup.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onComplete: () => {
                if (!this._panelGroup) return;
                // Só aqui o estado lógico vira SHOWN: é o instante em que o
                // painel de fato parou no lugar.
                if (this._state === State.SHOWING) this._state = State.SHOWN;
            },
        });
        this._panelGroup.ease({
            opacity: 255,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._shade.ease({
            opacity: 255,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Saída: o espelho da entrada, com EASE_IN_QUAD (rápido no começo). */
    _zoomAndFadeOut() {
        const from = this._openFrom;
        // Sem geometria guardada (fecho antes de qualquer abertura completa)
        // só resta o fade — melhor que um salto para o canto (0, 0).
        const translationX = from?.translationX ?? 0;
        const translationY = from?.translationY ?? 0;
        const scale = from?.scale ?? MIN_OPEN_SCALE;

        this._panelGroup.remove_transition(TRANSLATION_X);
        this._panelGroup.remove_transition(TRANSLATION_Y);
        this._panelGroup.remove_transition(SCALE_X);
        this._panelGroup.remove_transition(SCALE_Y);
        this._panelGroup.remove_transition(OPACITY);
        this._shade.remove_transition(OPACITY);

        this._panelGroup.ease({
            translation_x: translationX,
            translation_y: translationY,
            scale_x: scale,
            scale_y: scale,
            duration: CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._panelGroup) return;
                // Estado lógico e onClosed só no fim da animação: o painel
                // ainda está na tela durante os CLOSE_MS, e quem espera o
                // onClosed (o launcher, para soltar o estado da pasta
                // aberta) não pode ser avisado antes disso.
                this._settleClosed();
            },
        });
        this._panelGroup.ease({
            opacity: 0,
            duration: CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        this._shade.ease({
            opacity: 0,
            duration: CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    /** Estado final do fecho, comum ao caminho animado e ao instantâneo. */
    _settleClosed() {
        if (!this._root) return;
        this._panelGroup.remove_all_transitions();
        this._shade.remove_all_transitions();
        this._shade.hide();
        this._root.hide();
        // Geometria de volta à identidade: a próxima abertura mede e
        // posiciona tudo de novo, mas uma escala residual apareceria no
        // primeiro quadro antes disso.
        this._panelGroup.set_scale(1, 1);
        this._panelGroup.translation_x = 0;
        this._panelGroup.translation_y = 0;
        this._panelGroup.opacity = 255;
        this._state = State.HIDDEN;
        this._folderId = null;
        this._openFrom = null;
        // Dezenas de texturas de ícone não precisam ficar de pé enquanto
        // ninguém olha; open() remonta a grade de qualquer forma.
        this._clearGrid();
        this._onClosed?.();
    }

    // --- Nome editável ---

    _beginEditing() {
        if (this._editing || !this._entry) return;
        this._editing = true;
        // O foco anterior é devolvido no fim da edição. No caso normal ele é
        // o campo de busca do launcher, e devolvê-lo é o que faz o usuário
        // voltar a digitar na busca sem precisar clicar nela.
        this._focusBeforeEdit = global.stage?.get_key_focus?.() ?? null;

        this._entry.set_text(this._folderName);
        this._titleButton.hide();
        this._entry.show();
        this._entry.grab_key_focus();
        // Texto todo selecionado: renomear é quase sempre substituir o nome
        // inteiro, e é o que o Finder e o Launchpad fazem.
        this._entry.clutter_text.set_selection(0, -1);
    }

    /**
     * Encerra a edição.
     *
     * @param {boolean} commit true = grava o que está no campo; false =
     *   descarta e mantém o nome anterior (Escape).
     */
    _finishEditing(commit) {
        if (!this._editing || this._finishing) return;
        // Marcado ANTES de qualquer coisa que mexa no foco: devolver o foco
        // dispara 'key-focus-out' no campo, que é justamente um dos
        // caminhos que chamam este método.
        this._editing = false;
        this._finishing = true;
        try {
            const text = (this._entry?.get_text() ?? '').trim();
            // Nome vazio (ou só espaço) é recusado, não gravado: uma pasta
            // sem nome fica impossível de identificar na grade, e o gesto
            // "apagou tudo e saiu" quase nunca quer dizer isso.
            if (commit && text && text !== this._folderName) {
                this._folderName = text;
                // Rótulo atualizado na hora, sem esperar o modelo voltar: o
                // launcher pode remontar a grade em seguida, e até lá o
                // painel tem que mostrar o que o usuário acabou de digitar.
                this._titleLabel?.set_text(text);
                try {
                    this._onRename?.(this._folderId, text);
                } catch (e) {
                    logError(e, '[ArcDock] folder popup rename failed');
                }
            }
            this._entry?.hide();
            this._titleButton?.show();
            this._restoreFocus();
        } finally {
            this._finishing = false;
        }
    }

    _restoreFocus() {
        const target = this._focusBeforeEdit;
        this._focusBeforeEdit = null;
        if (!target) return;
        try {
            // Um actor destruído ou desmontado no meio da edição (a busca
            // do launcher morre junto com ele) não é alvo válido de foco:
            // grab_key_focus() ali deixaria o teclado no limbo.
            if (target.mapped) target.grab_key_focus();
        } catch (e) {
            logError(e, '[ArcDock] folder popup focus restore failed');
        }
    }

    _onEntryKeyPress(event) {
        const symbol = event.get_key_symbol();
        switch (symbol) {
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._finishEditing(true);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Escape:
            // Escape aqui é "desisti do nome", NÃO "fecha o painel". Por
            // isso o EVENT_STOP: sem ele a tecla subiria até o handler que
            // o launcher tem no uiGroup e fecharia a grade inteira no que
            // era para ser um cancelamento de edição.
            this._finishEditing(false);
            return Clutter.EVENT_STOP;
        }
        // Todo o resto pertence ao ClutterText: digitação, seleção,
        // movimento de cursor. Ele consome o que sabe tratar, então nada
        // disso chega à rede de teclado do launcher.
        return Clutter.EVENT_PROPAGATE;
    }
}
