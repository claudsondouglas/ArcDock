import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

// Folga entre a ARTE do ícone e a borda do slot. O slot é "mais ou menos
// do tamanho do ícone": grande o bastante para o quadrado se ler como a
// casa onde o app mora, pequeno o bastante para não encostar no vizinho
// (a folga entre células é CELL_PAD_X, o dobro disto de cada lado).
const SLOT_PAD = 10;
// Mesma família de raio do ladrilho de pasta, do anel de hover e do realce
// de merge (22px = os 18px do .arcdock-launcher-cell mais o arredondamento
// extra do ícone). O slot é a caixa onde a arte mora; um raio de outra
// família o leria como outra peça da interface.
const SLOT_RADIUS = 22 + SLOT_PAD;
// Vai-e-vem do slot. Curto porque ele acende no instante em que o ícone
// sai da mão do usuário: mais que isto e o buraco aparece depois do gesto
// que o abriu.
const SLOT_MS = 120;

/**
 * O que o slot está dizendo neste instante.
 *
 * Enum congelado e nunca string solta, como State e IndicatorStyle: são
 * três estados de PINTURA, e comparar contra a constante é o que impede
 * um terceiro valor de aparecer por engano.
 *
 * Só UMA casa da grade fica acesa por vez, e é sempre a que está
 * RESERVADA para o ícone no ar (ver _reserveSlot no launcher): os
 * vizinhos se afastam para abri-la, então um segundo quadrado aceso
 * anunciaria um lugar livre que não existe.
 */
export const SlotPaint = Object.freeze({
    // Repouso: o slot existe, ocupa o lugar e não pinta nada.
    NONE: 'none',
    // Nada vai se reorganizar por causa deste arraste: é o buraco de onde
    // o app saiu, e é para lá que ele volta. Vale no primeiro instante do
    // gesto (ninguém se moveu ainda) e enquanto o drop for "vira pasta".
    EMPTY: 'empty',
    // É para cá que o app vai se o usuário soltar agora — a casa que o
    // reflow abriu.
    TARGET: 'target',
});

/**
 * Uma casa da grade do launcher: a célula de tamanho fixo onde um ícone
 * mora, mais o quadrado que aparece quando esse ícone está sendo
 * arrastado.
 *
 * O slot é a peça PARADA do arraste. Os ícones se afastam ao vivo para
 * abrir a casa reservada, mas fazem isso por translação DENTRO das casas
 * — a grade em si nunca é remontada durante o gesto (cada remontagem
 * recria centenas de texturas de ícone, impagável a cada quadro), e por
 * isso nenhuma casa jamais muda de lugar. É também por isso que o
 * quadrado mora AQUI e não dentro do AppGridIcon: o ícone se esconde
 * durante o próprio arraste (e os outros passeiam), e um slot pendurado
 * nele sumiria junto justamente quando precisa aparecer. Uma casa vazia
 * (a sobra da última linha) também é um destino válido, e ela não tem
 * ícone algum a que se pendurar.
 */
export const GridSlot = GObject.registerClass(
class GridSlot extends St.Widget {
    /**
     * @param {object} params
     * @param {number} params.cellWidth
     * @param {number} params.cellHeight
     * @param {number} params.iconSize tamanho da ARTE (sem o rótulo)
     * @param {number} params.artTop distância do topo da célula até o topo
     *   da arte, medida pelo launcher (é ele que conhece a geometria da
     *   célula inteira)
     */
    _init(params = {}) {
        super._init({
            reactive: false,
            // BinLayout e não o St.Bin de antes: o Bin só aceita um filho,
            // e aqui são dois empilhados (o quadrado atrás, o ícone na
            // frente). O alinhamento de cada um vem do próprio filho, que
            // é como o AppGridIcon já se centraliza.
            layout_manager: new Clutter.BinLayout(),
            width: Math.max(1, Math.round(params.cellWidth ?? 1)),
            height: Math.max(1, Math.round(params.cellHeight ?? 1)),
        });
        this._iconSize = Math.max(1, Math.round(params.iconSize ?? 1));
        this._artTop = Math.round(params.artTop ?? 0);
        this._paint = SlotPaint.NONE;

        const size = this._iconSize + 2 * SLOT_PAD;
        // Apagado por OPACIDADE e não por visible, como o anel de hover do
        // AppGridIcon: é a opacidade que dá o fade, e um actor em opacity 0
        // não é pintado de qualquer forma.
        this._plate = new St.Widget({
            style_class: 'arcdock-launcher-slot',
            reactive: false,
            opacity: 0,
            width: size,
            height: size,
            x_align: Clutter.ActorAlign.CENTER,
            // START e não CENTER: a célula inclui a faixa do rótulo, e
            // centralizar na célula inteira deixaria o quadrado deslocado
            // para baixo da arte. A altura de verdade chega por
            // translation_y, que não re-aloca nada.
            y_align: Clutter.ActorAlign.START,
            translation_y: this._artTop - SLOT_PAD,
        });
        // O raio vem do JS pelo mesmo motivo do anel e do realce de merge:
        // ele é derivado da folga, e mantê-lo no CSS seria uma segunda
        // fonte de verdade para o mesmo número.
        this._plate.set_style(`border-radius: ${SLOT_RADIUS}px;`);
        this.add_child(this._plate);

        this.connect('destroy', () => this._onDestroyed());
    }

    /** O ícone que mora nesta casa, ou null se ela está vazia. */
    get icon() {
        return this._icon ?? null;
    }

    setIcon(icon) {
        this._icon = icon ?? null;
        if (icon) this.add_child(icon);
    }

    /**
     * Retângulo da ARTE em coordenadas de stage — de onde a animação de um
     * ícone que chega parte, e onde ela termina.
     *
     * Calculado a partir da célula e não do quadrado: o quadrado é maior
     * que a arte (SLOT_PAD de cada lado), e mirar nele faria o ícone
     * aterrissar maior do que vai ficar. Transformado, e não somado à mão,
     * porque a página desliza em translation_x — a casa da página vizinha
     * não está onde a aritmética diria.
     */
    artRect() {
        const [x, y] = this.get_transformed_position();
        const [width] = this.get_transformed_size();
        return {
            x: x + (width - this._iconSize) / 2,
            y: y + this._artTop,
            width: this._iconSize,
            height: this._iconSize,
        };
    }

    setPaint(paint, animate = true) {
        const next = paint ?? SlotPaint.NONE;
        if (this._paint === next || !this._plate) return;
        this._paint = next;

        // A classe extra do alvo entra ANTES do fade: ela só troca a borda,
        // e trocá-la no fim faria a casa piscar de um estado para o outro
        // com o quadrado já aceso.
        if (next === SlotPaint.TARGET)
            this._plate.add_style_class_name('arcdock-launcher-slot-target');
        else
            this._plate.remove_style_class_name('arcdock-launcher-slot-target');

        const opacity = next === SlotPaint.NONE ? 0 : 255;
        this._plate.remove_transition('opacity');
        if (!animate) {
            this._plate.opacity = opacity;
            return;
        }
        this._plate.ease({
            opacity,
            duration: SLOT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * Solta o que esta casa segurava.
     *
     * Pelo sinal 'destroy' e não por um destroy() em JS: quem apaga a
     * grade destrói a PÁGINA inteira, e aí o Clutter leva as casas por
     * dentro sem passar por método nenhum daqui — só o sinal chega aos
     * dois caminhos. O ÍCONE não morre aqui de propósito: quem o criou
     * (o launcher) também o destrói, explicitamente e antes das páginas,
     * porque o destroy() do AppGridIcon devolve o cursor e solta o
     * monitor de arraste.
     */
    _onDestroyed() {
        try {
            this._plate?.remove_all_transitions();
        } catch (_) {}
        this._plate = null;
        this._icon = null;
    }
});
