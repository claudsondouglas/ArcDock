import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { LAUNCHER } from '../config.js';
import * as Cursor from '../cursor.js';
import { triggerPressBounce } from '../iconAnimation.js';

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
// Raio do anel: o do ícone (18px, mesma família do .arcdock-launcher-cell)
// mais a espessura, para que o arco fique concêntrico com o quadrado.
const HOVER_RING_RADIUS = 18 + HOVER_RING;

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
 * Não reaproveita IconButton de propósito: aquele traz tooltip, menu de
 * contexto, drag-and-drop e indicador de app rodando — tudo que a grade
 * não quer. O que interessa reaproveitar é o feedback de clique, e esse
 * vem de triggerPressBounce().
 */
export const AppGridIcon = GObject.registerClass(
class AppGridIcon extends St.Button {
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
        this._app = params.app ?? null;
        this._onActivate = params.onActivate ?? null;
        const iconSize = params.iconSize ?? LAUNCHER.ICON;
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
        iconBin.set_child(this._createTexture(iconSize));
        stage.add_child(iconBin);
        this._stage = stage;
        box.add_child(stage);

        const label = new St.Label({
            text: this._app?.get_name() ?? '',
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
            // O feedback pertence ao botão e vem sempre, antes da ação.
            triggerPressBounce(this);
            this._onActivate?.(this._app);
        });
        // Segundo caminho de limpeza, de propósito: quando o launcher
        // destrói a PÁGINA inteira, o Clutter destrói as células por
        // dentro sem passar pelo destroy() em JS — só o sinal 'destroy'
        // chega aos dois caminhos.
        this.connect('destroy', () => this._onDestroyed());
    }

    get app() {
        return this._app;
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

    /** Realce da célula "selecionada" pelo teclado. */
    setSelected(selected) {
        if (selected) this.add_style_class_name('arcdock-launcher-cell-selected');
        else this.remove_style_class_name('arcdock-launcher-cell-selected');
    }

    _createTexture(size) {
        // create_icon_texture() resolve o tema de ícones corretamente
        // (inclusive fallback por wm_class); só devolve null quando o
        // .desktop não tem ícone algum, e aí a célula ainda precisa de
        // alguma coisa do tamanho certo para não desalinhar a linha.
        const texture = this._app?.create_icon_texture?.(size) ?? null;
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
        // O ponteiro fica com a mãozinha se a célula sumir sob o cursor
        // (troca de página, filtro da busca, fechamento do launcher).
        if (this.hover) Cursor.setDefault();
        this._ring = null;
        this._stage = null;
        this._label = null;
        this._onActivate = null;
        this._app = null;
    }

    destroy() {
        this._onDestroyed();
        super.destroy();
    }
});
