import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Mtk from "gi://Mtk";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { ANIM } from "./config.js";
import { SignalTracker, TimeoutTracker } from "./trackers.js";

const SETTING = "window-animations-enabled";

// Abertura da janela a partir do ícone. A escala inicial sai da razão
// entre o ícone e a janela, mas com teto e piso: uma janelinha de 200px
// nasceria quase do tamanho final (sem efeito nenhum) e uma janela
// gigante nasceria como um pixel (o texto vira sujeira ao esticar).
const OPEN = Object.freeze({
  MIN_START_SCALE: 0.1,
  MAX_START_SCALE: 0.45,
  START_OPACITY: 0,
});

/**
 * Amarra as animações de janela ao ícone da dock, como no macOS:
 *
 *  1. MINIMIZAR/RESTAURAR usam a animação NATIVA do Mutter — basta dizer
 *     a cada janela para onde ela deve encolher, via
 *     `meta_window_set_icon_geometry()`. Nada de handler de minimize aqui:
 *     o compositor faz o "genie" sozinho quando a geometria está setada.
 *  2. ABRIR é a única animação escrita à mão, porque o Shell não tem
 *     ponto de extensão para ela: a janela nasce pequena sobre o ícone e
 *     cresce até o lugar definitivo.
 *
 * O modo de suprimir a animação padrão de abertura é o único ponto
 * delicado. O Shell conecta `map` no construtor com `.bind(this)`, então
 * substituir `Main.wm._mapWindow` NÃO tem efeito — a closure já capturou a
 * função original. O que sobra, e é o caminho seguro, é o predicado
 * `Main.wm._shouldAnimateActor()`, resolvido em `this` a cada chamada:
 * devolvendo `false` o `_mapWindow` do Shell chama `completed_map()` na
 * hora e devolve o actor ao compositor em estado limpo (nada de meia
 * animação pendurada). NOSSO handler de `map` — conectado depois, logo
 * executado depois — então anima só visualmente.
 */
export class WindowAnimations {
  /**
   * @param {Gio.Settings} settings settings da extensão; a própria classe
   *   escuta `changed::window-animations-enabled` e liga/desliga sozinha.
   * @param {(win: Meta.Window) => ?{x: number, y: number, width: number,
   *   height: number}} getIconRect retângulo em coordenadas de stage do
   *   ícone que representa o app da janela, na posição de REPOUSO (sem
   *   magnificação), ou null se o app não tem ícone visível na dock.
   */
  constructor(settings, getIconRect) {
    this._settings = settings;
    this._getIconRect = getIconRect;
    this._enabled = false;
    this._destroyed = false;
    this._origShouldAnimateActor = null;

    // Sinais que vivem enquanto a extensão vive (só o da key) x sinais
    // que existem apenas com o efeito ligado.
    this._settingsSignals = new SignalTracker();
    this._signals = new SignalTracker();
    this._timeouts = new TimeoutTracker();

    // Janelas criadas e ainda não mapeadas. É o marcador que diz ao
    // predicado que a chamada em curso é o MAP e não um minimize/destroy
    // — o Shell passa a mesma lista de tipos em quase todos os eventos,
    // então o argumento não distingue nada. Weak: quem morre some daqui
    // sozinho.
    this._pendingMap = new WeakSet();
    // Actor -> retângulo do ícone, escrito pelo predicado e consumido
    // pelo nosso handler de `map` alguns microssegundos depois, dentro da
    // mesma emissão de sinal.
    this._pendingAnim = new WeakMap();

    this._settingsSignals.connect(settings, `changed::${SETTING}`, () =>
      this._sync(),
    );
    this._sync();
  }

  /**
   * Reaplica `set_icon_geometry()` em todas as janelas atuais. O Dock
   * chama isto sempre que os ícones mudam de lugar (refresh, mudança de
   * monitor, item adicionado/removido).
   */
  syncIconGeometry() {
    if (this._destroyed) return;
    for (const actor of global.get_window_actors()) {
      const win = actor.meta_window;
      if (win) this._applyIconGeometry(win);
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._settingsSignals.disconnectAll();
    // A flag só entra DEPOIS do _disable(): é ele quem limpa a geometria
    // dos ícones, e syncIconGeometry() recusa trabalho em objeto morto.
    this._disable();
    this._destroyed = true;
  }

  // --- liga/desliga -------------------------------------------------

  _sync() {
    const wanted = !!this._settings.get_boolean(SETTING);
    if (wanted === this._enabled) return;
    if (wanted) this._enable();
    else this._disable();
  }

  _enable() {
    this._enabled = true;
    this._patch();
    this._signals.connect(global.display, "window-created", (_display, win) =>
      this._onWindowCreated(win),
    );
    this._signals.connect(global.window_manager, "map", (_wm, actor) =>
      this._onMap(actor),
    );
    this.syncIconGeometry();
  }

  _disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._unpatch();
    this._signals.disconnectAll();
    this._timeouts.removeAll();
    // Marcadores novos: um pendente de antes do desligamento não pode
    // ressuscitar no próximo enable.
    this._pendingMap = new WeakSet();
    this._pendingAnim = new WeakMap();
    // Com `_enabled` já false isto LIMPA a geometria de todas as janelas,
    // devolvendo o minimize à animação padrão do Shell.
    this.syncIconGeometry();
  }

  // --- monkey-patch do predicado de animação ------------------------

  _patch() {
    // Nunca patchar duas vezes: o original guardado seria o nosso wrapper
    // e o unpatch deixaria a corrente montada para sempre.
    if (this._origShouldAnimateActor) return;
    const wm = Main.wm;
    if (typeof wm?._shouldAnimateActor !== "function") return;

    const orig = wm._shouldAnimateActor;
    this._origShouldAnimateActor = orig;
    const self = this;
    wm._shouldAnimateActor = function (actor, types) {
      // O marcador é consumido ANTES de perguntar ao original: mesmo que
      // ele diga "não animar" (overview aberta, por exemplo) o evento foi
      // o map, e deixar o marcador para trás faria o próximo minimize
      // desta janela ser confundido com um map.
      const win = actor?.meta_window ?? null;
      const isMap = win ? self._pendingMap.delete(win) : false;
      const animate = orig.call(this, actor, types);
      if (!isMap || !animate) return animate;

      const rect = self._openRectFor(win);
      // Sem ícone de destino não há de onde a janela sair: devolver o
      // controle ao Shell é melhor do que abrir sem animação nenhuma.
      if (!rect) return animate;

      self._pendingAnim.set(actor, rect);
      return false;
    };
  }

  _unpatch() {
    if (!this._origShouldAnimateActor) return;
    const wm = Main.wm;
    if (wm) wm._shouldAnimateActor = this._origShouldAnimateActor;
    this._origShouldAnimateActor = null;
  }

  // --- geometria do ícone (minimizar/restaurar) ---------------------

  _onWindowCreated(win) {
    if (!win) return;
    // Janela que já nasce minimizada (WM_HINTS iconic) não recebe map
    // agora: marcá-la faria o primeiro restaurar ser lido como abertura.
    if (this._isOpenCandidate(win) && !win.minimized) this._pendingMap.add(win);

    // No `window-created` a janela ainda não tem actor nem posição final.
    // Um timeout de 0ms devolve o controle ao loop e é rastreado pelo
    // TimeoutTracker — nada que precise de limpeza fica solto.
    this._timeouts.add(0, () => {
      if (this._enabled) this._applyIconGeometry(win);
      return GLib.SOURCE_REMOVE;
    });
  }

  _applyIconGeometry(win) {
    let type;
    try {
      type = win.get_window_type();
    } catch (_) {
      // Janela já unmanaged: o wrapper sobrevive, o objeto não.
      return;
    }
    if (type !== Meta.WindowType.NORMAL) return;

    const rect = this._enabled ? this._iconRect(win) : null;
    try {
      win.set_icon_geometry(
        rect
          ? new Mtk.Rectangle({
              // Campos gint: um float aqui vira erro de marshalling.
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            })
          : null,
      );
    } catch (e) {
      logError(e, "[ArcDock] set_icon_geometry failed");
    }
  }

  // --- animação de abertura -----------------------------------------

  _onMap(actor) {
    const rect = this._pendingAnim.get(actor);
    if (!rect) return;
    this._pendingAnim.delete(actor);
    this._animateOpen(actor, rect);
  }

  _animateOpen(actor, rect) {
    const win = actor.meta_window;
    if (!win) return;

    // O buffer rect É a geometria do actor em coordenadas de stage, e já
    // está resolvido no map — diferente de actor.width/height, que logo
    // após o map ainda podem devolver 0 (ver CLAUDE.md, "Layout").
    const box = win.get_buffer_rect();
    if (!(box.width > 0) || !(box.height > 0)) return;

    const scale = Math.min(
      OPEN.MAX_START_SCALE,
      Math.max(OPEN.MIN_START_SCALE, rect.width / box.width),
    );

    actor.remove_all_transitions();
    // Pivot no centro: com a escala presa ao centro do actor, a translação
    // abaixo é exatamente a distância entre os dois centros — qualquer
    // outro pivot exigiria compensar o deslocamento da própria escala.
    actor.set_pivot_point(0.5, 0.5);
    actor.set_scale(scale, scale);
    actor.translation_x =
      rect.x + rect.width / 2 - (box.x + box.width / 2);
    actor.translation_y =
      rect.y + rect.height / 2 - (box.y + box.height / 2);
    actor.opacity = OPEN.START_OPACITY;
    actor.show();

    actor.ease({
      scale_x: 1,
      scale_y: 1,
      translation_x: 0,
      translation_y: 0,
      opacity: 255,
      duration: ANIM.WINDOW_OPEN_MS,
      // Entrada: rápido no começo, deslizando no fim.
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      // onStopped e não onComplete: uma janela fechada no meio do caminho
      // interrompe a transição, e o estado visual precisa voltar à
      // identidade nos DOIS finais.
      onStopped: () => this._resetActor(actor),
    });
  }

  _resetActor(actor) {
    // O actor pode ter sido finalizado junto com a janela; aqui o wrapper
    // ainda existe mas qualquer acesso ao GObject lança.
    try {
      actor.set_pivot_point(0, 0);
      actor.set_scale(1, 1);
      actor.translation_x = 0;
      actor.translation_y = 0;
      actor.opacity = 255;
    } catch (_) {}
  }

  // --- helpers -------------------------------------------------------

  /** Retângulo do ícone para a abertura, com todas as recusas do efeito. */
  _openRectFor(win) {
    if (!this._enabled) return null;
    // Animações desligadas no sistema (acessibilidade, "reduce motion"):
    // não suprimir nada, o Shell já resolve tudo em duração zero.
    if (!St.Settings.get().enable_animations) return null;
    if (!this._isOpenCandidate(win)) return null;
    return this._iconRect(win);
  }

  /**
   * Só janelas NORMAL e não transientes. O Shell trata transiente como
   * diálogo (ver `_getAnimationWindowType`), e diálogo tem animação
   * própria — suprimi-la para abrir "do ícone" seria errado duas vezes.
   */
  _isOpenCandidate(win) {
    try {
      return (
        win.get_window_type() === Meta.WindowType.NORMAL &&
        win.get_transient_for() === null
      );
    } catch (_) {
      return false;
    }
  }

  _iconRect(win) {
    let rect = null;
    try {
      rect = this._getIconRect(win);
    } catch (e) {
      // O callback vem do Dock e roda DENTRO do predicado de animação do
      // Shell: deixá-lo escapar quebraria a animação de todas as janelas.
      logError(e, "[ArcDock] getIconRect failed");
      return null;
    }
    if (!rect) return null;
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return rect;
  }
}
