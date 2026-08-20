import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { TimeoutTracker } from "./trackers.js";

/**
 * Quanto dura o voo do ícone da mão do usuário até a casa onde ele vai
 * morar.
 *
 * O arraste termina com o ícone NO AR: o dnd solta o actor no ponto do
 * ponteiro e, sem esta animação, ele simplesmente sumiria dali para
 * reaparecer noutro lugar no quadro seguinte. O voo é o que amarra o gesto
 * ao resultado — mesmo papel da animação de minimizar entre a janela e o
 * ícone da dock.
 */
const FLY_MS = 180;
// Folga do relógio que vigia o voo. Generosa de propósito: ele existe para
// a transição que NÃO chegou, e um prazo curto o faria competir com um voo
// que só está atrasado por um quadro perdido.
const FLY_WATCHDOG_SLACK_MS = 400;

/**
 * Adota o actor que o dnd carregava e o faz voar até a casa reservada.
 *
 * Adotar é literal: o dnd destrói o actor de arraste no fim do drop **se
 * ele ainda for filho do uiGroup** (dnd.js), então reparentá-lo para a
 * nossa camada é o que nos dá a posse dele. Sem isso não há animação
 * possível — o ícone deixa de existir no quadro do drop.
 *
 * Enquanto há alguém no ar a REORDENAÇÃO fica represada: o callback
 * `onLanded` é quem aplica a nova ordem, e ele só roda quando o fantasma
 * pousa. É essa emenda que faz o ícone de verdade nascer no quadro em que
 * o fantasma acaba de chegar, e os dois parecerem o mesmo objeto.
 */
export class DockGhostFlight {
  constructor() {
    this._layer = null;
    // { actor, onLanded, done }
    this._ghosts = [];
    this._flying = 0;
    this._timeouts = new TimeoutTracker();
    this._watchdogId = 0;
  }

  get flying() {
    return this._flying > 0;
  }

  /**
   * Devolve a camada ao topo do uiGroup.
   *
   * A dock se joga para o topo a cada 'restacked', e um fantasma abaixo
   * dela atravessaria a tela por TRÁS da pílula de vidro — justo no fim do
   * percurso, que é onde ele precisa ser visto.
   */
  raise() {
    this._layer?.get_parent()?.set_child_above_sibling(this._layer, null);
  }

  /**
   * @param {Clutter.Actor|null} dragActor actor que o dnd entregou ao
   *   acceptDrop
   * @param {{x:number,y:number,width:number,height:number}|null} rect
   *   destino, em coordenadas de stage
   * @param {object} [opts] `duration` e `onLanded`
   * @returns {boolean} houve voo de verdade
   */
  fly(dragActor, rect, opts = {}) {
    const onLanded = opts.onLanded ?? null;
    const layer = this._ensureLayer();
    // Sem voo possível o resultado do drop tem que acontecer MESMO ASSIM:
    // engolir o callback aqui deixaria a dock com a fila remexida e a
    // ordem antiga — um gesto sem efeito nenhum.
    if (!dragActor || !rect || !layer) {
      this._invoke(onLanded);
      return false;
    }

    const scale = dragActor.scale_x || 1;
    const [visualWidth, visualHeight] = dragActor.get_transformed_size();
    const [visualX, visualY] = dragActor.get_transformed_position();
    const width = visualWidth / scale;
    const height = visualHeight / scale;
    const centerX = visualX + visualWidth / 2;
    const centerY = visualY + visualHeight / 2;
    const [layerX, layerY] = this._layerOrigin(layer);

    // Nada de NaN daqui para baixo. `get_transformed_*` devolve NaN sobre
    // um actor sem alocação válida, e um único NaN nesta conta se espalha
    // por tudo: set_position(NaN) faz clutter_actor_allocate abortar por
    // asserção, o actor nunca recebe alocação, e a ease que deveria chamar
    // onLanded no fim pode nunca chegar lá. Sem voo é feio; com NaN é
    // fatal.
    const geometry = [
      scale, width, height, centerX, centerY, layerX, layerY,
      rect.x, rect.y, rect.width, rect.height,
    ];
    if (!geometry.every(Number.isFinite) || !(width > 0) || !(height > 0)) {
      console.warn("[ArcDock] dock flight geometry not finite; skipping");
      this._invoke(onLanded);
      return false;
    }

    try {
      dragActor.get_parent()?.remove_child(dragActor);
      layer.add_child(dragActor);
    } catch (e) {
      logError(e, "[ArcDock] dock drag actor adoption failed");
      this._invoke(onLanded);
      return false;
    }

    // A reparentagem preserva o CENTRO visível, e não o canto: o actor
    // chega com a escala que o dnd lhe deu e com pivô em qualquer lugar, e
    // só o centro do retângulo transformado é a mesma coisa nos dois
    // espaços.
    dragActor.set_pivot_point(0.5, 0.5);
    dragActor.set_scale(scale, scale);
    dragActor.set_position(
      Math.round(centerX - layerX - width / 2),
      Math.round(centerY - layerY - height / 2),
    );

    const duration = opts.duration ?? FLY_MS;
    const target = rect.width / Math.max(1, width);
    const ghost = { actor: dragActor, onLanded, done: false };
    this._ghosts.push(ghost);
    this._flying++;
    this._armWatchdog(duration);
    dragActor.remove_all_transitions();
    dragActor.ease({
      x: Math.round(rect.x - layerX + (rect.width - width) / 2),
      y: Math.round(rect.y - layerY + (rect.height - height) / 2),
      scale_x: target,
      scale_y: target,
      duration,
      // EASE_OUT_QUAD como toda entrada da extensão: rápido ao sair da mão
      // e assentando na casa, que é o contrário de um ícone que parece ter
      // sido cuspido para o lugar.
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => this._land(ghost),
    });
    return true;
  }

  /**
   * Mata os fantasmas e ABRE a represa sem executar nada.
   *
   * O contador zera aqui, e não no onComplete de cada voo: uma transição
   * REMOVIDA não é uma transição terminada — o 'stopped' dela chega com
   * finished=false e o onComplete não roda. Sem este zero o `flying`
   * ficaria de pé para sempre e todo drop seguinte seria um gesto sem
   * efeito.
   */
  clear() {
    this._flying = 0;
    this._cancelWatchdog();
    const ghosts = this._ghosts;
    this._ghosts = [];
    for (const ghost of ghosts) this._destroyGhost(ghost);
  }

  destroy() {
    this.clear();
    this._timeouts.removeAll();
    if (this._layer) {
      try {
        this._layer.destroy();
      } catch (_) {}
    }
    this._layer = null;
  }

  /** O fantasma pousou: aplica o resultado do drop e some. */
  _land(ghost) {
    if (ghost.done) return;
    ghost.done = true;
    this._flying = Math.max(0, this._flying - 1);
    if (this._flying === 0) this._cancelWatchdog();
    const onLanded = ghost.onLanded;
    ghost.onLanded = null;
    // O callback ANTES de destruir o fantasma: é ele que faz o ícone de
    // verdade aparecer na casa, e a ordem inversa deixaria um quadro com a
    // casa vazia entre uma coisa e a outra.
    this._invoke(onLanded);
    this._ghosts = this._ghosts.filter((other) => other !== ghost);
    this._destroyGhost(ghost);
  }

  _destroyGhost(ghost) {
    try {
      ghost.actor?.remove_all_transitions();
      ghost.actor?.destroy();
    } catch (e) {
      logError(e, "[ArcDock] dock ghost cleanup failed");
    }
    ghost.actor = null;
    ghost.onLanded = null;
  }

  _invoke(onLanded) {
    if (!onLanded) return;
    try {
      onLanded();
    } catch (e) {
      logError(e, "[ArcDock] dock drop completion failed");
    }
  }

  /**
   * Rede de segurança da represa: o voo TEM que acabar.
   *
   * `flying` só volta a zero no onComplete da ease, e uma transição que
   * nunca completa (actor sem alocação, transição removida por um caminho
   * que não passa por `clear()`, o que for) deixaria a reordenação nunca
   * aplicada, o ícone de origem escondido para sempre e o hover suspenso.
   * O relógio é a única testemunha independente disso — não é o caminho
   * normal, e quando ele dispara o journal precisa dizer isso, mas ele
   * transforma uma quebra permanente num soluço de meio segundo.
   */
  _armWatchdog(duration) {
    this._cancelWatchdog();
    const wait = Math.max(0, Math.round(duration)) + FLY_WATCHDOG_SLACK_MS;
    this._watchdogId = this._timeouts.add(wait, () => {
      this._watchdogId = 0;
      if (this._flying === 0) return GLib.SOURCE_REMOVE;
      console.warn("[ArcDock] dock flight never landed; releasing the drop");
      for (const ghost of [...this._ghosts]) this._land(ghost);
      this._flying = 0;
      return GLib.SOURCE_REMOVE;
    });
  }

  _cancelWatchdog() {
    if (!this._watchdogId) return;
    this._timeouts.remove(this._watchdogId);
    this._watchdogId = 0;
  }

  /**
   * Camada onde os fantasmas voam: filha do uiGroup, do tamanho da tela
   * inteira, SEMPRE acima da chrome da dock e SEMPRE fora do pick.
   *
   * Fora do container da dock de propósito: ele tem a altura da pílula mais
   * o headroom, e um ícone soltando de qualquer ponto da tela nasceria
   * cortado dentro dele.
   *
   * `reactive: false` NÃO basta para tirá-la do caminho — ver a mesma nota
   * em dockSlotOverlay.js e no launcher: PickMode.ALL enxerga actor
   * não-reactive, e uma camada do tamanho da tela no topo do uiGroup vira
   * uma parede que deixa a dock inteira inerte para drop a partir do
   * primeiro voo.
   */
  _ensureLayer() {
    if (!this._layer) {
      this._layer = new St.Widget({ reactive: false });
      Shell.util_set_hidden_from_pick(this._layer, true);
      Main.layoutManager.uiGroup.add_child(this._layer);
    }
    // Posição e tamanho explícitos: o uiGroup é de layout fixo, e uma
    // camada sem geometria própria teria a alocação decidida pelos filhos —
    // justamente o que a conta de coordenadas do voo não pode ter se
    // mexendo por baixo dela.
    this._layer.set_position(0, 0);
    this._layer.set_size(
      global.screen_width || global.stage.width,
      global.screen_height || global.stage.height,
    );
    this.raise();
    return this._layer;
  }

  /**
   * Canto superior esquerdo da camada, em coordenadas de stage.
   *
   * Pelo PAI quando a leitura direta não serve: a camada é criada e usada
   * no mesmo instante (o primeiro voo), e um actor que ainda não passou por
   * um ciclo de alocação não tem transformação válida —
   * `get_transformed_position()` ali devolve NaN. O uiGroup está alocado
   * desde que a sessão subiu, e a camada mora em (0, 0) dentro dele.
   */
  _layerOrigin(layer) {
    const [x, y] = layer.get_transformed_position();
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
    const parent = layer.get_parent();
    if (!parent) return [0, 0];
    const [parentX, parentY] = parent.get_transformed_position();
    if (!Number.isFinite(parentX) || !Number.isFinite(parentY)) return [0, 0];
    return [parentX + layer.x, parentY + layer.y];
  }
}
