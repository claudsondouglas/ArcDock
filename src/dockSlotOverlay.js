import Clutter from "gi://Clutter";
import Shell from "gi://Shell";
import St from "gi://St";

import { DockTheme } from "./config.js";

// Folga entre a ARTE do ícone e a borda do quadrado. Dois pixels é
// exatamente o padding de .arcdock-icon, então o quadrado sai do tamanho
// da CÉLULA: nem invade o vizinho, nem fica menor que o buraco que ele
// anuncia.
const SLOT_PAD = 2;
// Mesma família de raio do .arcdock-icon (14px) mais a folga. O raio vem
// do JS e não do CSS pelo mesmo motivo do GridSlot: ele é DERIVADO da
// folga, e deixá-lo no CSS criaria uma segunda fonte de verdade para o
// mesmo número.
const SLOT_RADIUS = 14 + SLOT_PAD;
// Vai-e-vem do quadrado, e também o deslize dele de uma casa para a
// outra. Curto porque ele acende no instante em que o ícone sai da mão do
// usuário: mais que isto e o buraco aparece depois do gesto que o abriu.
const SLOT_MS = 120;

const X = "x";
const Y = "y";
const OPACITY = "opacity";

/**
 * O que a casa reservada está dizendo neste instante.
 *
 * Enum congelado e nunca string solta, como State e IndicatorStyle.
 * Deliberadamente DUPLICADO do SlotPaint do launcher em vez de importado:
 * são as mesmas três leituras, mas importar de appsLauncher/ faria a dock
 * (a peça de baixo) depender da grade (a peça de cima) por causa de um
 * enum de três valores.
 */
export const SlotPaint = Object.freeze({
  // Repouso: não há arraste, nada é pintado.
  NONE: "none",
  // Nada vai se reorganizar por causa deste arraste: é o buraco de onde o
  // ícone saiu, e é para lá que ele volta. Vale no primeiro instante do
  // gesto, quando ninguém se moveu ainda.
  EMPTY: "empty",
  // É para cá que o ícone vai se o usuário soltar agora — a casa que o
  // reflow abriu.
  TARGET: "target",
});

/**
 * O quadrado que marca a ÚNICA casa acesa da fila durante um arraste.
 *
 * UMA casa por vez, e sempre a reservada: com os vizinhos fechando o
 * buraco da origem, o único vazio de verdade na tela é aquele onde o
 * ícone vai cair — dois quadrados acesos anunciariam dois lugares livres,
 * e um deles seria mentira.
 *
 * Ao contrário do launcher, aqui NÃO existe um actor-casa por ícone. As
 * fileiras da dock são St.BoxLayout, e é nelas que a magnificação empurra
 * os vizinhos fixando uma largura maior no botão; envelopar cada ícone num
 * container de tamanho fixo mataria o efeito. Então o quadrado mora numa
 * camada à parte, de layout FIXO, que não participa da fila nenhuma:
 *
 * - A camada é filha do `glassHost` (um BinLayout) e é o ÚLTIMO filho dele
 *   de propósito. A posição dela vem de um Clutter.BindConstraint amarrado
 *   à caixa da seção, e constraint lê a alocação da fonte no momento em que
 *   o PRÓPRIO actor é alocado — filhos são alocados na ordem da árvore, e
 *   uma camada colocada abaixo do painel leria a alocação do quadro
 *   ANTERIOR. Isso importa muito no primeiro instante do gesto: o
 *   drag-begin desliga a magnificação, o que muda a largura de todos os
 *   ícones e a posição da caixa de pastas, e a leitura atrasada poria o
 *   quadrado dezenas de pixels fora do lugar exatamente no quadro em que
 *   ele acende. Sendo o último filho, a leitura é sempre a do quadro
 *   corrente. O preço é pintar POR CIMA dos ícones, e ele é barato: a casa
 *   acesa é, por construção, a casa vazia.
 * - A largura/altura NATURAL da camada é zero, e quem dá tamanho a ela é o
 *   constraint. Sem isso ela entraria na conta do tamanho preferido do
 *   BinLayout e poderia esticar o `glassHost` — ou seja, a pílula de vidro
 *   — por causa de um quadrado de decoração.
 * - Camada e quadrado saem do pick (`Shell.util_set_hidden_from_pick`).
 *   `reactive: false` NÃO basta: o dnd não acha o alvo de drop por
 *   propagação de evento, ele chama `get_actor_at_pos(PickMode.ALL, …)` e
 *   sobe a árvore procurando um `_delegate`. PickMode.ALL enxerga actor
 *   não-reactive, então uma camada por cima do painel seria uma parede —
 *   o pick pararia nela, o pai dela não tem `_delegate`, e a dock inteira
 *   ficaria inerte para drop a partir do primeiro arraste.
 */
export class DockSlotOverlay {
  /**
   * @param {Clutter.Actor} host container de vidro (BinLayout) da dock
   * @param {object} params `iconSize` e `theme`
   */
  constructor(host, params = {}) {
    this._iconSize = Math.max(1, Math.round(params.iconSize ?? 1));
    this._paint = SlotPaint.NONE;
    this._at = null;

    this._layer = new St.Widget({
      layout_manager: new Clutter.FixedLayout(),
      reactive: false,
      width: 0,
      height: 0,
    });
    Shell.util_set_hidden_from_pick(this._layer, true);
    this._bind = new Clutter.BindConstraint({
      coordinate: Clutter.BindCoordinate.ALL,
    });
    this._layer.add_constraint(this._bind);

    const size = this._iconSize + 2 * SLOT_PAD;
    // Apagado por OPACIDADE e não por `visible`, como o quadrado do
    // launcher: é a opacidade que dá o fade, e um actor em opacity 0 não é
    // pintado de qualquer forma.
    this._plate = new St.Widget({
      style_class: "arcdock-slot",
      reactive: false,
      opacity: 0,
      width: size,
      height: size,
    });
    // O tema NÃO chega por seletor descendente: a camada é irmã do painel,
    // não filha dele, então .arcdock-panel-dark não a alcança — mesma
    // situação do tooltip, que vive no uiGroup.
    if (params.theme === DockTheme.DARK)
      this._plate.add_style_class_name("arcdock-slot-dark");
    this._plate.set_style(`border-radius: ${SLOT_RADIUS}px;`);
    Shell.util_set_hidden_from_pick(this._plate, true);
    this._layer.add_child(this._plate);

    host.add_child(this._layer);
  }

  get paint() {
    return this._paint;
  }

  /**
   * Amarra a camada à caixa de uma seção. A partir daqui as coordenadas de
   * `moveTo()` são LOCAIS àquela caixa — que é o mesmo espaço em que o
   * dnd entrega o `x` do handleDragOver.
   */
  attachTo(box) {
    if (!this._bind) return;
    if (this._bind.source === box) return;
    this._bind.source = box ?? null;
  }

  /**
   * Acende a casa que cobre `rect` (retângulo da ARTE, em coordenadas da
   * caixa da seção).
   *
   * O quadrado DESLIZA de uma casa para a outra em vez de saltar: no
   * launcher são N casas fazendo cross-fade entre si, aqui é um quadrado
   * só, e um corte seco leria como piscada. Só a PRIMEIRA aparição é
   * posicionada sem animar — vindo de opacity 0, deslizar a partir da
   * posição anterior mostraria um percurso que ninguém pediu.
   */
  moveTo(rect, paint) {
    if (!rect || !this._plate) return;
    const x = Math.round(rect.x + (rect.width - this._plate.width) / 2);
    const y = Math.round(rect.y + (rect.height - this._plate.height) / 2);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const moved = !this._at || this._at.x !== x || this._at.y !== y;
    if (moved) {
      const slide = this._paint !== SlotPaint.NONE && this._at !== null;
      this._at = { x, y };
      this._plate.remove_transition(X);
      this._plate.remove_transition(Y);
      if (slide) {
        this._plate.ease({
          x,
          y,
          duration: SLOT_MS,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      } else {
        this._plate.set_position(x, y);
      }
    }
    this.setPaint(paint);
  }

  setPaint(paint, animate = true) {
    const next = paint ?? SlotPaint.NONE;
    if (this._paint === next || !this._plate) return;
    this._paint = next;

    // A classe extra do alvo entra ANTES do fade: ela só troca a borda, e
    // trocá-la no fim faria a casa piscar de um estado para o outro com o
    // quadrado já aceso.
    if (next === SlotPaint.TARGET)
      this._plate.add_style_class_name("arcdock-slot-target");
    else this._plate.remove_style_class_name("arcdock-slot-target");

    const opacity = next === SlotPaint.NONE ? 0 : 255;
    this._plate.remove_transition(OPACITY);
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
   * Apaga a casa. `_at` volta a null para que a próxima aparição seja
   * posicionada sem deslizar — o gesto seguinte não tem por que herdar o
   * percurso do anterior.
   */
  clear(animate = true) {
    this.setPaint(SlotPaint.NONE, animate);
    this._at = null;
  }

  destroy() {
    if (this._plate) {
      try {
        this._plate.remove_all_transitions();
      } catch (_) {}
    }
    this._plate = null;
    // A fonte do constraint é solta à mão: o Clutter já desfaz isso quando
    // a caixa morre, mas a dock é destruída e recriada o tempo todo e a
    // camada pode sair ANTES da caixa.
    if (this._bind) {
      try {
        this._bind.source = null;
      } catch (_) {}
    }
    this._bind = null;
    if (this._layer) {
      try {
        this._layer.destroy();
      } catch (_) {}
    }
    this._layer = null;
  }
}
