import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { LAUNCHER } from '../config.js';
import * as Cursor from '../cursor.js';
import { triggerPressBounce } from '../iconAnimation.js';
import { AppGridMenu } from './appGridMenu.js';
import { createFolderPreview } from './folderPreview.js';
import { LauncherItemType } from './launcherLayout.js';

// Respiro entre o ícone e o rótulo, e a linha de texto em si. O respiro é
// medido a partir da caixa do ícone, e o anel de hover come HOVER_RING
// dele — o que sobra abaixo do anel é LABEL_GAP - HOVER_RING.
const LABEL_GAP = 20;
const LABEL_LINE_HEIGHT = 20;

// Espessura do anel branco que marca o hover. O anel mora FORA da caixa
// do ícone (posição negativa dentro do stage de layout fixo), e não como
// borda do próprio stage: uma borda encolheria a área de conteúdo e o
// ícone daria um pulo de 8px no instante do hover.
const HOVER_RING = 4;
// Aumento do ÍCONE no hover. Vai como scale_* do Clutter (o anel é filho
// do stage e cresce junto, concêntrico) e não como um tamanho maior de
// textura: scale é visual puro, não re-aloca, então nem a coluna nem a
// contagem de linhas da grade sentem o hover. O ícone não tem sombra, que
// é o que impede o mesmo caminho no rótulo (ver o CSS de -label-hover).
const HOVER_ICON_SCALE = 1.2;
// Duração do vai-e-vem do hover. Curto porque o gesto é de passagem: mais
// que isto e o realce chega depois do olho, virando rastro.
const HOVER_MS = 160;
// Nomes das transições que o hover controla. Escopo por propriedade, e
// nunca remove_all_transitions(): o quique do clique anima translation-y
// no MESMO actor, e derrubar tudo o congelaria no meio do salto.
const SCALE_X = 'scale-x';
const SCALE_Y = 'scale-y';
const OPACITY = 'opacity';
const TRANSLATION_Y = 'translation-y';
// Quanto o rótulo desce enquanto o ícone está grande. O anel só encosta
// no nome no hover, então o afastamento é do hover também: subir LABEL_GAP
// resolveria igual, mas ao custo de a grade em repouso ficar frouxa. É
// translation e não margin porque translation não re-aloca — o rótulo
// continua ocupando a mesma faixa, e nada na grade se mexe por baixo.
const HOVER_LABEL_SHIFT = 8;
// Raio do anel: o do ícone (22px — 18px da família do
// .arcdock-launcher-cell mais 4px de arredondamento extra) mais a
// espessura, para que o arco fique concêntrico com o quadrado.
const HOVER_RING_RADIUS = 22 + HOVER_RING;

// --- Arrastar e juntar (pastas) ---

// Quanto tempo o botão fica pressionado antes de o arraste começar. Vale
// mais que os 150ms da dock porque aqui o clique é a ação PRINCIPAL
// (abrir o app): o gesto de arrastar tem que ser claramente intencional
// para não roubar cliques de quem só clicou devagar.
const DRAG_HOLD_MS = 200;
// Fatia de CADA borda da célula que conta como "entre ícones" e não como
// "em cima deste ícone". Fora dessas fatias o drop vira pasta; dentro
// delas o evento continua subindo e a página trata como reordenação.
// Fração e não pixels: a célula encolhe quando há muitas colunas, e uma
// margem fixa engoliria a zona de merge inteira numa grade apertada.
const MERGE_EDGE_RATIO = 0.3;
// Espera antes de ACENDER o realce de "isto vira uma pasta". O drop em si
// não espera nada (é só geometria) — a pausa existe para o ícone não
// piscar enquanto o ponteiro apenas atravessa a grade a caminho de outro
// lugar.
const MERGE_DWELL_MS = 250;
// Quanto o ícone alvo encolhe enquanto o realce está aceso: ele "cai
// dentro" da pasta que está se formando. Mesma ideia do
// FOLDER_SUBICON_FRACTION do Shell, só que menos brusca.
const MERGE_ICON_SCALE = 0.72;
const MERGE_MS = 140;
// Duração do quique do ícone que acabou de virar (ou de entrar numa)
// pasta. Mais longo que MERGE_MS porque o EASE_OUT_BACK gasta o fim do
// tempo no ultrapasse — encurtar aqui come justamente a parte que se vê.
const APPEAR_POP_MS = 260;
// Janela depois do FIM de um arraste em que um 'clicked' ainda conta como
// rabo do gesto, e não como um clique novo. Curta o bastante para não
// engolir um clique de verdade (é preciso soltar o arraste e apertar de
// novo dentro dela) e longa o bastante para cobrir a folga entre o
// button-release e o 'clicked' que o ClutterClickGesture emite depois.
const DRAG_CLICK_GUARD_US = 250 * 1000;
// Folga entre a caixa do ícone e a borda do realce de merge.
const MERGE_HALO_PAD = 8;
const MERGE_HALO_RADIUS = 22 + MERGE_HALO_PAD;

/**
 * Faixa vertical que o rótulo ocupa dentro da célula.
 *
 * Exportada porque quem calcula a ALTURA DA CÉLULA — e, a partir dela,
 * quantas linhas cabem no monitor — é o launcher, e ele precisa desse
 * número ANTES de existir qualquer célula: medir o rótulo exigiria um
 * actor já estilizado e alocado, e a essa altura o número de linhas já
 * teria que estar decidido. É uma estimativa amarrada ao font-size de
 * .arcdock-launcher-label no stylesheet — mudar um exige revisar o outro.
 */
export const CELL_LABEL_BAND = LABEL_GAP + LABEL_LINE_HEIGHT;

/**
 * O quanto o hover transborda a caixa do ícone PARA CIMA.
 *
 * Exportada pela mesma razão de CELL_LABEL_BAND: quem dimensiona o
 * viewport é o launcher, e o viewport tem clip_to_allocation (é ele que
 * segura a página vizinha durante o deslize). O ícone da PRIMEIRA linha
 * cresce para cima a partir da base, e sem essa folga reservada o clip
 * cortaria justamente o topo do ícone e do anel — só na linha de cima, o
 * que é pior que não ter efeito nenhum.
 *
 * Para baixo não há nada a reservar: o pivô na base deixa a borda de
 * baixo do anel praticamente parada, dentro do LABEL_GAP que já existe.
 */
export function cellHoverHeadroom(iconSize = LAUNCHER.ICON) {
    return Math.ceil(
        iconSize * (HOVER_ICON_SCALE - 1) + HOVER_RING * HOVER_ICON_SCALE
    );
}

/**
 * Uma célula da grade do launcher: ícone grande + nome embaixo.
 *
 * Serve tanto para um APP quanto para uma PASTA — a diferença é só o
 * actor que vai dentro da caixa do ícone (textura do tema vs. miniatura
 * de folderPreview.js) e o que o clique ativa. Uma classe só, e não duas
 * irmãs, porque tudo o que é caro aqui (anel de hover, faixa do rótulo,
 * quique do clique, arrastar, ser alvo de drop) é idêntico nos dois
 * casos: duas classes seriam duas cópias da mesma geometria fina para
 * manter em sincronia.
 *
 * Não reaproveita IconButton de propósito: aquele traz tooltip, menu de
 * contexto e indicador de app rodando — tudo que a grade não quer. O que
 * interessa reaproveitar é o feedback de clique, e esse vem de
 * triggerPressBounce().
 */
export const AppGridIcon = GObject.registerClass(
class AppGridIcon extends St.Button {
    /**
     * @param {object} params
     * @param {object} params.item entry de launcherLayout: `{type:'app', …}`
     *   ou `{type:'folder', …}`
     * @param {number} [params.iconSize]
     * @param {number} [params.labelWidth]
     * @param {(item: object, icon: AppGridIcon) => void} [params.onActivate]
     * @param {object|null} [params.dnd] política de arraste, fornecida pelo
     *   launcher. `null` desliga o arraste inteiro (a célula continua
     *   clicável). Campos:
     *   - `canMerge(sourceIcon, targetIcon) => boolean`
     *   - `merge(sourceIcon, targetIcon, dragActor) => boolean`
     *   - `onDragBegin(icon)` / `onDragEnd(icon)`
     *   - `onMergeHover(icon, hovering)`
     * @param {object|null} [params.menu] política do menu de contexto,
     *   também fornecida pelo launcher. `null` desliga o menu. Ver
     *   AppGridMenu; o `stateChanged` daqui recebe `(icon, isOpen)`.
     */
    _init(params = {}) {
        super._init({
            style_class: 'arcdock-launcher-cell',
            reactive: true,
            // Foco de teclado NUNCA vem para cá: ele fica permanentemente
            // no campo de busca, para que digitar filtre a grade sem
            // exigir um clique de volta na busca depois de clicar numa
            // célula. A "seleção" da grade é uma style class nossa
            // (setSelected), não o foco do St.
            can_focus: false,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._item = params.item ?? null;
        // Instante (monotônico) em que o último arraste acabou. Ver
        // _swallowClick(): é o que separa "clique" de "fim de arraste".
        this._dragEndedAt = 0;
        // Mesmo id do modelo (`app:…` / `folder:…`): é por ele que o
        // launcher acha a posição da célula na ordem persistida.
        this.id = this._item?.id ?? null;
        this._onActivate = params.onActivate ?? null;
        this._dnd = params.dnd ?? null;
        // Só a política fica guardada: o menu em si nasce no PRIMEIRO botão
        // direito desta célula. A grade tem centenas de células e recria
        // todas a cada _rebuildPages() — um PopupMenu + PopupMenuManager
        // por célula seria pagar milhares de actors para mostrar, no
        // máximo, um.
        this._menuPolicy = params.menu ?? null;
        this._menu = null;
        const iconSize = params.iconSize ?? LAUNCHER.ICON;
        this._iconSize = iconSize;
        const labelWidth = params.labelWidth ?? LAUNCHER.LABEL_MAX_WIDTH;

        const box = new St.BoxLayout({
            vertical: true,
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Caixa de layout FIXO do tamanho do ícone: ela existe para poder
        // pendurar o anel de hover em coordenadas negativas, transbordando
        // a caixa sem participar da alocação (o padding da célula já dá a
        // folga que o anel ocupa visualmente).
        const stage = new St.Widget({
            width: iconSize,
            height: iconSize,
            reactive: false,
            // CENTER e não o FILL padrão: a coluna tem a largura do RÓTULO
            // (maior que o ícone), e com FILL uma caixa de largura
            // explícita fica encostada na borda esquerda dessa coluna — o
            // ícone apareceria deslocado à esquerda do próprio nome.
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Realce de "soltar aqui cria uma pasta". Entra ANTES do ícone
        // para ficar atrás dele, e é irmão do ícone (não pai) porque quem
        // encolhe no merge é só o ícone: um encolhesse-junto faria o
        // realce sumir no mesmo instante em que precisa aparecer.
        this._halo = new St.Widget({
            style_class: 'arcdock-launcher-merge-halo',
            reactive: false,
            opacity: 0,
            width: iconSize + 2 * MERGE_HALO_PAD,
            height: iconSize + 2 * MERGE_HALO_PAD,
        });
        this._halo.set_position(-MERGE_HALO_PAD, -MERGE_HALO_PAD);
        this._halo.set_style(`border-radius: ${MERGE_HALO_RADIUS}px;`);
        stage.add_child(this._halo);

        // Apagado por OPACIDADE, não por visible: é a opacidade que dá o
        // fade de entrada e saída, e um actor em opacity 0 não é pintado —
        // some do custo do frame do mesmo jeito que um actor escondido.
        this._ring = new St.Widget({
            style_class: 'arcdock-launcher-ring',
            reactive: false,
            opacity: 0,
            width: iconSize + 2 * HOVER_RING,
            height: iconSize + 2 * HOVER_RING,
        });
        this._ring.set_position(-HOVER_RING, -HOVER_RING);
        this._ring.set_style(
            `border: ${HOVER_RING}px solid rgba(255, 255, 255, 0.95);` +
            `border-radius: ${HOVER_RING_RADIUS}px;`
        );
        stage.add_child(this._ring);

        // Bin de tamanho fixo em volta da textura: o tema pode devolver um
        // ícone menor que o pedido (fallback de tamanho), e sem a caixa
        // fixa a célula encolheria junto, quebrando o alinhamento da linha.
        const iconBin = new St.Bin({
            width: iconSize,
            height: iconSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        iconBin.set_position(0, 0);
        // Pivô no centro: o encolhimento do merge é para DENTRO da caixa
        // do ícone, ao contrário do hover, que cresce a partir da base.
        iconBin.set_pivot_point(0.5, 0.5);
        iconBin.set_child(this._createIconActor(iconSize));
        stage.add_child(iconBin);
        this._iconBin = iconBin;
        this._stage = stage;
        box.add_child(stage);

        const label = new St.Label({
            text: this._item?.name ?? '',
            style_class: 'arcdock-launcher-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        // Largura EXPLÍCITA (e não um max-width no CSS, que o St não honra
        // de forma confiável): é ela que garante que toda célula tenha a
        // mesma largura, e é sobre ela que o ellipsize decide onde cortar.
        label.set_width(labelWidth);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.clutter_text.set_line_wrap(false);
        label.margin_top = LABEL_GAP;
        // Altura EXPLÍCITA, pelo mesmo motivo da largura: é ela que deixa o
        // hover trocar o font-size sem re-alocar nada. A faixa é a mesma
        // que CELL_LABEL_BAND promete ao launcher, então fixá-la aqui só
        // torna aquela estimativa exata.
        label.set_height(LABEL_LINE_HEIGHT);
        this._label = label;
        box.add_child(label);

        // Mesmo contrato dos ícones da dock: as animações moram no stage,
        // não no botão. O dock/launcher mexe em visibilidade e opacidade do
        // botão, e um quique feito ali seria atropelado.
        this._animActor = stage;
        // Pivô na BASE, como nos ícones da dock. Crescer a partir do meio
        // parece simétrico no papel, mas manda metade do aumento para
        // BAIXO — e o que desce primeiro é o anel, que já mora 4px fora da
        // caixa: o rótulo acabava dentro do quadro branco. Ancorado na
        // base, a borda de baixo do anel fica praticamente parada e todo o
        // crescimento vai para cima, onde a folga entre linhas é o dobro
        // do respiro até o nome.
        stage.set_pivot_point(0.5, 1.0);
        this.set_child(box);

        this.connect('notify::hover', () => {
            if (this.hover) {
                Cursor.setPointer();
                this._setHoverPainted(true);
            } else {
                Cursor.setDefault();
                this._setHoverPainted(false);
            }
        });
        this.connect('clicked', () => {
            // Um arraste NUNCA pode abrir o app: ativar aqui manda o
            // launcher fechar (_launch -> close -> _clearPages), e a grade
            // fechada destrói ESTA célula no meio do gesto — o dnd chega
            // ao drop com a origem já morta, nenhum alvo aceita, e mover
            // ou juntar em pasta deixa de funcionar por inteiro.
            if (this._swallowClick()) return;
            // O feedback pertence ao botão e vem sempre, antes da ação.
            triggerPressBounce(this);
            this._onActivate?.(this._item, this);
        });
        // O botão direito NÃO passa pelo 'clicked': o button_mask padrão do
        // St.Button é só o botão 1, então nem o quique nem o
        // DRAG_CLICK_GUARD_US acima têm qualquer relação com este caminho.
        this.connect('button-press-event', (_actor, event) =>
            this._onButtonPress(event));
        // Segundo caminho de limpeza, de propósito: quando o launcher
        // destrói a PÁGINA inteira, o Clutter destrói as células por
        // dentro sem passar pelo destroy() em JS — só o sinal 'destroy'
        // chega aos dois caminhos.
        this.connect('destroy', () => this._onDestroyed());

        if (this._dnd) this._setupDnd();
    }

    get item() {
        return this._item;
    }

    /** App da célula, ou null quando ela é uma pasta. */
    get app() {
        return this._item?.type === LauncherItemType.APP
            ? this._item.app ?? null
            : null;
    }

    get isFolder() {
        return this._item?.type === LauncherItemType.FOLDER;
    }

    /**
     * Retângulo da ARTE do ícone em coordenadas de stage.
     *
     * É daqui que o painel de pasta parte na animação de abertura, e é a
     * arte — não a célula inteira — porque a célula inclui a faixa do
     * rótulo: partir dela faria o painel nascer deslocado para baixo do
     * ícone que o usuário clicou.
     */
    getArtRect() {
        const actor = this._iconBin ?? this;
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        // Centro medido, tamanho em REPOUSO: a caixa da arte pode estar
        // encolhida pelo realce de merge no instante em que alguém
        // pergunta, e devolver esse tamanho faria o painel de pasta (ou o
        // ícone que está voando para cá) mirar uma caixa que já está
        // voltando ao normal. O centro não se mexe — o pivô do
        // encolhimento é o meio da caixa.
        return {
            x: x + (width - this._iconSize) / 2,
            y: y + (height - this._iconSize) / 2,
            width: this._iconSize,
            height: this._iconSize,
        };
    }

    /**
     * Troca só o texto do rótulo.
     *
     * Existe para o renomear de pasta não custar uma remontagem da grade
     * inteira: o nome é a única coisa que muda, e remontar destruiria a
     * célula que o painel aberto está usando como âncora.
     */
    setLabelText(text) {
        this._label?.set_text(text ?? '');
        if (this._item) this._item.name = text ?? '';
    }

    /**
     * Apaga o realce de hover sem depender de um leave-event.
     *
     * O launcher chama isto quando o ponteiro aparece sobre o pixel vazio
     * do overlay: o St nem sempre entrega o leave da célula nesse caminho,
     * e sem esta rede o anel ficaria aceso num ícone que o cursor já
     * deixou. Sai cedo quando não há nada aceso — o motion-event é quente.
     */
    clearHover() {
        if (!this._hoverPainted) return;
        this._setHoverPainted(false);
    }

    _setHoverPainted(painted) {
        if (this._hoverPainted === painted) return;
        this._hoverPainted = painted;
        // EASE_OUT_QUAD nos dois sentidos: a ida acompanha o ponteiro que
        // chega e a volta sai rápido e assenta, que é o que impede o
        // realce de parecer que está sendo arrastado atrás do cursor.
        if (this._ring) {
            this._ring.remove_transition(OPACITY);
            this._ring.ease({
                opacity: painted ? 255 : 0,
                duration: HOVER_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        if (this._stage) {
            const scale = painted ? HOVER_ICON_SCALE : 1;
            this._stage.remove_transition(SCALE_X);
            this._stage.remove_transition(SCALE_Y);
            this._stage.ease({
                scale_x: scale,
                scale_y: scale,
                duration: HOVER_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        if (!this._label) return;
        this._label.remove_transition(TRANSLATION_Y);
        this._label.ease({
            translation_y: painted ? HOVER_LABEL_SHIFT : 0,
            duration: HOVER_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        // O TAMANHO do rótulo troca de uma vez, sem transição: o negrito e o aumento
        // vêm do font-size em .arcdock-launcher-label-hover, e font-size
        // não é interpolável aqui. Um scale_* do Clutter animaria, mas
        // descolaria a text-shadow dos glifos e o nome sairia em dobro.
        if (painted) this._label.add_style_class_name('arcdock-launcher-label-hover');
        else this._label.remove_style_class_name('arcdock-launcher-label-hover');
    }

    /**
     * Quique de "cheguei": a arte nasce encolhida e assenta no tamanho
     * normal.
     *
     * É o fecho da animação de juntar em pasta. Roda no ícone NOVO, depois
     * da remontagem da grade, e não no alvo do drop antes dela: a
     * remontagem destrói o ícone alvo, e um quique começado ali seria
     * cortado no meio pelo rebuild que o próprio drop agendou.
     *
     * EASE_OUT_BACK, o único ultrapasse da grade: a pasta acabou de
     * engolir um app, e é o exagero no fim que conta essa história.
     */
    playAppearPop() {
        if (!this._iconBin) return;
        this._iconBin.remove_transition(SCALE_X);
        this._iconBin.remove_transition(SCALE_Y);
        this._iconBin.set_scale(MERGE_ICON_SCALE, MERGE_ICON_SCALE);
        this._iconBin.ease({
            scale_x: 1,
            scale_y: 1,
            duration: APPEAR_POP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    // --- Menu de contexto ---

    get isMenuOpen() {
        return !!this._menu?.isOpen;
    }

    /**
     * Abre (ou fecha) o menu de contexto desta célula.
     *
     * Público porque o teclado também chega aqui: a célula é
     * `can_focus: false` (o foco mora na busca do começo ao fim), então a
     * tecla Menu / Shift+F10 é tratada pelo launcher e encaminhada para a
     * célula selecionada.
     */
    toggleMenu() {
        // Sem política, pasta, ou gesto de arraste em curso: nenhum menu. A
        // pasta fica de fora porque tudo o que este menu oferece — ações do
        // .desktop, fixar na dock, atalho — é sobre um app instalado, e um
        // menu de app aberto sobre uma pasta seria mentira.
        if (!this._menuPolicy || !this.app || this._dragging) return;
        if (!this._menu) {
            this._guard(() => {
                this._menu = new AppGridMenu({
                    sourceActor: this,
                    app: this.app,
                    policy: {
                        ...this._menuPolicy,
                        // O launcher precisa saber QUAL célula abriu, e o
                        // AppGridMenu não conhece a célula — ela é só o
                        // actor de ancoragem para ele.
                        stateChanged: (isOpen) =>
                            this._menuPolicy?.stateChanged?.(this, isOpen),
                    },
                });
            }, 'menu creation');
        }
        this._menu?.toggle();
    }

    closeMenu() {
        this._menu?.close();
    }

    _onButtonPress(event) {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        this.toggleMenu();
        // EVENT_STOP para o botão direito morrer aqui: subindo, ele chegaria
        // ao overlay do launcher (que consome o clique do próprio pixel) e
        // ficaria à disposição do gesto de arraste. Mesma resposta que o
        // IconButton da dock dá.
        return Clutter.EVENT_STOP;
    }

    /** Realce da célula "selecionada" pelo teclado. */
    setSelected(selected) {
        if (selected) this.add_style_class_name('arcdock-launcher-cell-selected');
        else this.remove_style_class_name('arcdock-launcher-cell-selected');
    }

    // --- Arrastar ---

    /**
     * Este 'clicked' é o rabo de um arraste, e não um clique?
     *
     * Não basta olhar `_dragging`: do GNOME 49 em diante o St.Button
     * reconhece o clique por ClutterClickGesture, que corre por fora da
     * propagação de evento do dnd e não sabe nada dele. O 'clicked' nasce
     * do mesmo button-release que ENCERRA o arraste e pode chegar DEPOIS
     * do 'drag-end' — com `_dragging` já em false. Daí a janela de tempo:
     * ela cobre esse atraso sem depender da ordem entre os dois caminhos.
     *
     * É tempo e não um flag limpo por timeout de propósito: um timeout
     * seria mais um recurso para cancelar no destroy, e um relógio
     * monotônico morre junto com o objeto sem precisar de nada.
     */
    _swallowClick() {
        if (this._dragging) return true;
        if (!this._dragEndedAt) return false;
        return GLib.get_monotonic_time() - this._dragEndedAt <
            DRAG_CLICK_GUARD_US;
    }

    _setupDnd() {
        // _delegate é o que o DND lê dos dois lados: no arraste ele
        // identifica a ORIGEM, e no drop é por ele que o alvo é
        // encontrado (o dnd sobe a árvore de actors procurando um).
        this._delegate = this;
        this._draggable = DND.makeDraggable(this, {
            timeoutThreshold: DRAG_HOLD_MS,
            restoreOnSuccess: false,
        });
        this._draggable.connect('drag-begin', () => {
            this._dragging = true;
            // Invisível e fora do pick, mas NÃO hide(): a célula precisa
            // continuar ocupando o slot (o buraco é o que segura a grade
            // parada) e, mais importante, precisa continuar MENSURÁVEL.
            //
            // Este handler roda dentro do _gestureRecognized() do dnd, e
            // logo abaixo dele o dnd mede o nosso getDragActorSource()
            // para decidir onde o ícone no ar nasce e para onde ele volta
            // num drop recusado. Um actor escondido aqui é geometria
            // inválida ali — e um NaN nessa conta contamina a posição do
            // fantasma, a alocação dele e, no fim, o voo que devolve a
            // grade ao normal.
            //
            // Sair do pick era a outra metade do hide(), e é o que
            // util_set_hidden_from_pick faz sozinho (é o mesmo que o dnd
            // usa no próprio actor de arraste): sem isso o ícone seria o
            // alvo de drop do seu próprio arraste.
            this._guard(() => {
                Shell.util_set_hidden_from_pick(this, true);
                this.opacity = 0;
            });
            this._notifyDnd('onDragBegin');
        });
        const restore = () => {
            this._dragging = false;
            // Carimbado antes de qualquer saída: é o que segura o
            // 'clicked' atrasado deste mesmo gesto (ver _swallowClick).
            this._dragEndedAt = GLib.get_monotonic_time();
            // Célula já destruída: o dnd continua emitindo 'drag-cancelled'
            // e 'drag-end' sobre o draggable, e cada toque em actor morto
            // aqui vira exceção DENTRO do handler do Shell — que aborta o
            // resto do fim de gesto e enche o journal de "already
            // disposed". Sair cedo é a única resposta: quem já morreu não
            // tem opacidade, nem hover de merge, nem grade para avisar.
            if (this._animDestroyed) return;
            this._guard(() => {
                this._setMergeHover(false);
                Shell.util_set_hidden_from_pick(this, false);
                this.opacity = 255;
                // show() de qualquer forma: o launcher esconde a célula de
                // verdade enquanto o fantasma dela atravessa a tela, e é
                // deste caminho (ou da grade nova) que ela volta.
                this.show();
            });
            this._notifyDnd('onDragEnd');
        };
        this._draggable.connect('drag-end', restore);
        this._draggable.connect('drag-cancelled', restore);
    }

    /**
     * Roda `fn` sem deixar NADA escapar para o dnd do Shell.
     *
     * O `_Draggable` é um `Signals.EventEmitter`: o `emit()` dele percorre
     * os handlers num laço JS **sem try/catch**, e 'drag-begin' sai de
     * dentro de `_gestureRecognized()` enquanto 'drag-end' sai de dentro
     * de `_dragActorDropped()`. Uma exceção nossa sobe por esse emit e
     * aborta o resto do fim de gesto — inclusive o `_dragComplete()`, que
     * é quem devolve o `Main.pushModal` empurrado no início do arraste.
     *
     * O sintoma disso não é um gesto perdido, é o dnd da SESSÃO inteira
     * travado: o grab fica de pé para sempre, nenhum arraste novo começa
     * e o Escape passa a cair no `_cancelDrag` de um arraste que já
     * acabou. Ou seja: "só funciona na primeira vez".
     */
    _guard(fn, what = 'drag handler') {
        try {
            fn();
        } catch (e) {
            logError(e, `[ArcDock] launcher ${what} failed`);
        }
    }

    /** Idem, para um callback da política de arraste (que é do launcher). */
    _notifyDnd(name, ...args) {
        this._guard(() => this._dnd?.[name]?.(this, ...args), `dnd ${name}`);
    }

    /**
     * Actor que o ponteiro carrega. Uma cópia nova do ícone, sem rótulo e
     * sem célula: é assim que o Launchpad arrasta (só a arte), e é o que
     * evita reparentar a própria célula para fora da página — o que
     * desmontaria a linha durante o gesto.
     */
    getDragActor() {
        // Blindado pelo mesmo motivo do _guard: os dois getters são
        // chamados por _gestureRecognized() DEPOIS do pushModal, e uma
        // exceção aqui deixaria o grab de pé sem nunca chegar a um fim
        // de gesto que o devolvesse. Um ícone genérico é uma saída ruim;
        // a sessão sem ponteiro não é saída nenhuma.
        let actor = null;
        this._guard(() => {
            actor = this._createIconActor(this._iconSize);
        }, 'drag actor creation');
        return actor ?? new St.Icon({
            icon_name: 'application-x-executable',
            icon_size: this._iconSize,
        });
    }

    /** Para onde a arte volta quando o drop é recusado. */
    getDragActorSource() {
        return this._iconBin ?? this._stage ?? this;
    }

    // --- Alvo de drop ---

    handleDragOver(source, _actor, x) {
        if (source === this) return DND.DragMotionResult.NO_DROP;
        if (!this._canMergeWith(source)) {
            this._setMergeHover(false);
            // CONTINUE e não NO_DROP: o evento tem que seguir subindo até
            // a página, que é quem trata a reordenação. NO_DROP aqui
            // deixaria a grade inteira inerte para reordenar.
            return DND.DragMotionResult.CONTINUE;
        }
        if (this._withinEdges(x)) {
            this._setMergeHover(false);
            return DND.DragMotionResult.CONTINUE;
        }
        this._setMergeHover(true);
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, actor, x) {
        this._setMergeHover(false);
        if (!this._canMergeWith(source)) return false;
        // Perto das bordas o drop não é nosso: devolvendo false o dnd
        // continua subindo a árvore e a página o trata como reordenação.
        if (this._withinEdges(x)) return false;
        // O actor de arraste vai junto: é ele que o launcher faz voar para
        // dentro desta pasta. Sem essa passagem o dnd o destruiria no
        // instante do drop e o app sumiria do ar sem chegar a lugar nenhum.
        return this._dnd?.merge?.(source, this, actor) === true;
    }

    /** A coordenada local caiu na faixa "entre ícones" de uma das bordas? */
    _withinEdges(x) {
        const width = this.width || this._iconSize;
        const edge = width * MERGE_EDGE_RATIO;
        return x < edge || x > width - edge;
    }

    _canMergeWith(source) {
        if (!this._dnd?.canMerge) return false;
        if (!(source instanceof AppGridIcon)) return false;
        // Mesma blindagem do _guard, com resposta: uma pergunta que
        // explode vira "não dá para juntar", e o evento segue subindo
        // para a página tratar como reordenação.
        let can = false;
        this._guard(() => {
            can = this._dnd.canMerge(source, this) === true;
        }, 'dnd canMerge');
        return can;
    }

    /**
     * Liga/desliga o estado "o ponteiro está parado em cima de mim com
     * algo na mão".
     *
     * O monitor de arraste é a única forma de saber que o ponteiro SAIU:
     * handleDragOver só é chamado enquanto somos o alvo, e não existe um
     * handleDragOut. É o mesmo padrão do AppViewItem do Shell.
     */
    _setMergeHover(hovering) {
        if (this._mergeHover === hovering) return;
        this._mergeHover = hovering;
        // A grade precisa saber: enquanto este ícone for o alvo de "vira
        // pasta", a casa de destino do arraste tem que estar apagada. As
        // duas respostas para o mesmo drop acesas ao mesmo tempo diriam
        // coisas contraditórias, e a página não tem como descobrir isto
        // sozinha — enquanto somos o alvo, o handleDragOver dela não é
        // mais chamado.
        this._notifyDnd('onMergeHover', hovering);

        if (hovering) {
            this._dragMonitor = {
                dragMotion: (dragEvent) => {
                    if (!this.contains(dragEvent.targetActor))
                        this._setMergeHover(false);
                    return DND.DragMotionResult.CONTINUE;
                },
            };
            DND.addDragMonitor(this._dragMonitor);
            this._mergeTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                MERGE_DWELL_MS,
                () => {
                    this._mergeTimeoutId = 0;
                    this._setMergePainted(true);
                    return GLib.SOURCE_REMOVE;
                }
            );
            return;
        }

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._clearMergeTimeout();
        this._setMergePainted(false);
    }

    _setMergePainted(painted) {
        if (this._mergePainted === painted) return;
        this._mergePainted = painted;
        if (this._halo) {
            this._halo.remove_transition(OPACITY);
            this._halo.ease({
                opacity: painted ? 255 : 0,
                duration: MERGE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        if (!this._iconBin) return;
        const scale = painted ? MERGE_ICON_SCALE : 1;
        this._iconBin.remove_transition(SCALE_X);
        this._iconBin.remove_transition(SCALE_Y);
        this._iconBin.ease({
            scale_x: scale,
            scale_y: scale,
            duration: MERGE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _clearMergeTimeout() {
        if (!this._mergeTimeoutId) return;
        GLib.source_remove(this._mergeTimeoutId);
        this._mergeTimeoutId = 0;
    }

    /**
     * A arte da célula: textura do tema para um app, miniatura de pasta
     * para uma pasta. Chamada duas vezes por célula no máximo (uma na
     * construção, outra por arraste), então não vale cache.
     */
    _createIconActor(size) {
        if (this._item?.type === LauncherItemType.FOLDER) {
            const apps = (this._item.apps ?? [])
                .map(entry => entry?.app)
                .filter(app => app);
            return createFolderPreview(apps, size);
        }
        // create_icon_texture() resolve o tema de ícones corretamente
        // (inclusive fallback por wm_class); só devolve null quando o
        // .desktop não tem ícone algum, e aí a célula ainda precisa de
        // alguma coisa do tamanho certo para não desalinhar a linha.
        const texture = this._item?.app?.create_icon_texture?.(size) ?? null;
        if (texture) return texture;
        return new St.Icon({
            icon_name: 'application-x-executable',
            icon_size: size,
        });
    }

    _onDestroyed() {
        // Mesma rede de segurança do iconAnimation: o actor ainda está vivo
        // durante o sinal, então dá para parar as transições em vez de
        // deixá-las disparar onComplete sobre um actor já finalizado.
        this._animDestroyed = true;
        try {
            this._animActor?.remove_all_transitions();
        } catch (_) {}
        // Monitor e timeout do merge são os dois únicos recursos globais
        // que esta célula toma emprestado; deixá-los para trás faria o
        // Shell chamar um callback sobre um actor morto no próximo
        // arraste.
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._clearMergeTimeout();
        // O menu é filho do uiGroup, não desta célula: ninguém o destruiria
        // junto, e a grade recria centenas de células a cada remontagem —
        // um menu esquecido aqui vaza a CADA reordenação. Zerado antes de
        // destruir para que o 'open-state-changed' do fechamento (que
        // avisa o launcher) não reentre neste caminho.
        const menu = this._menu;
        this._menu = null;
        if (menu) {
            try {
                menu.destroy();
            } catch (e) {
                logError(e, '[ArcDock] launcher cell menu cleanup failed');
            }
        }
        // Só DEPOIS do destroy: o fechamento que ele dispara ainda passa
        // por este callback para avisar o launcher de que não há mais menu
        // aberto. Zerar antes emudeceria justamente esse aviso.
        this._menuPolicy = null;
        // O ponteiro fica com a mãozinha se a célula sumir sob o cursor
        // (troca de página, filtro da busca, fechamento do launcher).
        if (this.hover) Cursor.setDefault();
        this._ring = null;
        this._halo = null;
        this._stage = null;
        this._iconBin = null;
        this._label = null;
        this._onActivate = null;
        this._dnd = null;
        this._draggable = null;
        this._item = null;
    }

    destroy() {
        this._onDestroyed();
        super.destroy();
    }
});
