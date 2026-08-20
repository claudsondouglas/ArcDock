import Clutter from "gi://Clutter";

/**
 * Quanto dura o afastamento dos vizinhos enquanto o ícone passeia pela
 * fila.
 *
 * Curto, e EASE_OUT_QUAD como toda entrada da extensão: o reflow é
 * RESPOSTA a um ponteiro que já está em movimento. Uma animação longa
 * chegaria atrasada — a fila ainda estaria se abrindo para a casa anterior
 * quando o usuário já está duas casas adiante.
 */
const REFLOW_MS = 170;
// Por PROPRIEDADE e nunca remove_all_transitions(): o press e o quique do
// clique animam escala e translação DENTRO do ícone (no stage interno), e
// derrubar tudo os congelaria no meio do movimento. A magnificação, por
// sua vez, anima 'width' no mesmo actor.
const TRANSLATION_X = "translation-x";

/**
 * Os vizinhos abrindo a casa reservada, ao vivo, durante um arraste na
 * dock.
 *
 * Translação e NUNCA reordenação de children: mexer na ordem da caixa a
 * cada evento de movimento dispararia um relayout do painel inteiro (e,
 * por tabela, o notify::height que chama _reposition()) por quadro. O que
 * se move é só a PINTURA do ícone; a alocação dele — que é o que a
 * aritmética das casas usa — fica exatamente onde está.
 *
 * A fila da dock é horizontal e cabe inteira na tela, então não há o
 * recorte por página que o launcher precisa fazer: dx é sempre ±1 casa e
 * dy não existe.
 */
export class DockDragReflow {
  constructor() {
    this._icons = [];
    // Casa que o ícone arrastado ocupa hoje. -1 significa "não há gesto".
    this._from = -1;
    this._pitch = 0;
    // Casa reservada que gerou o mapa atual. Guardada para sair cedo do
    // caminho quente: handleDragOver roda uma vez por evento de movimento,
    // e reiniciar as mesmas translações a cada quadro as deixaria presas
    // no primeiro instante do ease, sem nunca chegar.
    this._slot = -1;
    // Para onde cada ícone está deslocado neste instante
    // (índice na seção -> dx em px). Existe para animar só o que mudou.
    this._shifts = new Map();
  }

  get active() {
    return this._from !== -1;
  }

  /** Casa reservada neste instante, ou -1. */
  get slot() {
    return this._slot;
  }

  /**
   * @param {Clutter.Actor[]} icons ícones da seção, na ordem visual,
   *   INCLUINDO o que está sendo arrastado
   * @param {number} from índice do arrastado dentro de `icons`
   * @param {number} pitch largura de uma casa em px
   */
  begin(icons, from, pitch) {
    this.cancel(false);
    this._icons = icons.slice();
    this._from = from;
    this._pitch = pitch;
    // A reserva nasce na própria casa de origem: enquanto o ponteiro não
    // sair dela não há nada a recalcular — com `from === k` ninguém se
    // desloca.
    this._slot = from;
  }

  /** Abre a casa `index` para o ícone que está no ar. */
  reserve(index) {
    if (this._from === -1) return;
    if (index === this._slot) return;
    this._slot = index;
    this._apply(this._shiftsFor(index));
  }

  /**
   * Devolve todo mundo ao lugar.
   *
   * NÃO é chamado quando o drop é aceito: o fantasma pousa exatamente na
   * casa que os vizinhos abriram, e zerar as translações antes disso faria
   * a fila saltar para trás e, um instante depois, para a frente de novo.
   * Nesse caminho quem apaga o reflow é o `_applyOrder()` do drop, com
   * `animate = false` — a nova alocação já põe cada ícone no pixel em que
   * a translação o estava desenhando, então o zero é invisível.
   */
  cancel(animate = true) {
    this._slot = -1;
    this._from = -1;
    const shifted = this._shifts;
    this._shifts = new Map();
    for (const index of shifted.keys())
      this._ease(this._icons[index], 0, animate);
    this._icons = [];
  }

  destroy() {
    this.cancel(false);
  }

  /**
   * Quem se desloca, e para onde, se o ícone no ar tomar a casa `k`.
   *
   * A fila entre a casa de origem e `k` anda uma casa no sentido contrário
   * ao do ícone. Aritmética da largura da casa, e não geometria de actor:
   * toda casa tem o mesmo tamanho, então a conta é exata — e imune ao fato
   * de o ícone já estar transladado, que é justamente o que uma leitura de
   * posição não seria.
   *
   * @returns {Map<number, number>}
   */
  _shiftsFor(k) {
    const shifts = new Map();
    const from = this._from;
    if (from === -1 || k < 0 || k === from) return shifts;

    const [lo, hi, delta] =
      from < k ? [from + 1, k, -1] : [k, from - 1, 1];
    for (let index = lo; index <= hi; index++) {
      if (!this._icons[index]) continue;
      shifts.set(index, delta * this._pitch);
    }
    return shifts;
  }

  /** Anima só a diferença entre o reflow vigente e o novo. */
  _apply(shifts) {
    for (const index of this._shifts.keys())
      if (!shifts.has(index)) this._ease(this._icons[index], 0);
    for (const [index, dx] of shifts) {
      if (this._shifts.get(index) === dx) continue;
      this._ease(this._icons[index], dx);
    }
    this._shifts = shifts;
  }

  _ease(icon, dx, animate = true) {
    if (!icon) return;
    // Um _refresh() no meio do gesto pode ter destruído este ícone: tocar
    // num actor morto aqui viraria exceção dentro de um handler do dnd.
    try {
      icon.remove_transition(TRANSLATION_X);
      if (!animate) {
        icon.translation_x = dx;
        return;
      }
      icon.ease({
        translation_x: dx,
        duration: REFLOW_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    } catch (e) {
      logError(e, "[ArcDock] dock reflow ease failed");
    }
  }
}
