import Clutter from "gi://Clutter";

import { MAGNIFICATION } from "./config.js";
import { SignalTracker } from "./trackers.js";

// Nomes das transições implícitas de actor.ease() que ESTE módulo cria.
// Removemos por nome (e nunca com remove_all_transitions) porque os
// mesmos actors carregam animações de outros donos — ver o comentário de
// _applyIcon() sobre a divisão stage/host.
const SCALE_X = "scale-x";
const SCALE_Y = "scale-y";
const WIDTH = "width";

/**
 * Magnificação estilo macOS: o ícone sob o ponteiro incha e arrasta os
 * vizinhos, com a intensidade caindo suavemente até a distância de
 * falloff.
 *
 * O efeito tem DUAS metades por ícone, porque em Clutter `scale_x/scale_y`
 * é uma transformação de PINTURA — não muda a allocation, então sozinha
 * ela faria os ícones crescerem uns por cima dos outros:
 *
 *  1. escala VISUAL no `host` do ícone, com pivot na base (0.5, 1.0), que
 *     é o que faz o ícone "brotar" do painel em vez de crescer para o
 *     canto superior esquerdo;
 *  2. LARGURA explícita no próprio botão, que é o que empurra os vizinhos
 *     para os lados. Mexe na allocation horizontal e só nela: a altura
 *     pedida pelo painel não muda, então isto não realimenta o
 *     `notify::height` que dispara Dock._reposition().
 *
 * O alvo da escala é o `host` e NUNCA o `stage`: press, quique e entrada
 * já animam o stage (ver iconAnimation.js). Sendo actors diferentes, as
 * duas escalas se compõem multiplicativamente por construção — nenhuma
 * precisa saber da outra, e daí a regra de nunca chamar
 * remove_all_transitions() no stage a partir daqui.
 */
export class Magnification {
  /**
   * @param {Clutter.Actor} panel painel reactive+track_hover da dock.
   * @param {() => object[]} getIcons devolve TODOS os botões visíveis do
   *   painel na ordem visual (esquerda → direita). Avaliado a cada
   *   evento: ícones nascem e morrem a qualquer _refresh() e um cache
   *   aqui guardaria actor morto.
   * @param {{scale: number, falloff: number}} params
   */
  constructor(panel, getIcons, params = {}) {
    this._panel = panel;
    this._getIcons = getIcons;
    this._scale = this._clamp(
      params.scale ?? MAGNIFICATION.DEFAULT_SCALE,
      MAGNIFICATION.MIN_SCALE,
      MAGNIFICATION.MAX_SCALE,
    );
    this._falloff = this._clamp(
      Math.round(params.falloff ?? MAGNIFICATION.DEFAULT_FALLOFF),
      MAGNIFICATION.MIN_FALLOFF,
      MAGNIFICATION.MAX_FALLOFF,
    );
    this._enabled = true;
    // Soma das larguras extras aplicadas agora. O Dock lê isto para
    // esticar a live area do auto-hide junto com o painel.
    this._extraWidth = 0;
    this._signals = new SignalTracker();

    this._signals.connect(panel, "motion-event", (_actor, event) =>
      this._onMotion(event),
    );
    // notify::hover e não 'leave-event': mover o ponteiro do painel para
    // um filho TAMBÉM emite leave no painel (o Clutter troca o actor sob
    // o ponteiro), então um handler ingênuo de leave-event zeraria o
    // efeito justamente ao entrar num ícone. O St já filtra isso — o
    // st_widget_leave() só desliga `hover` quando o actor relacionado não
    // está contido no widget —, e `track_hover` do painel já está ligado.
    this._signals.connect(panel, "notify::hover", () => {
      if (!panel.hover) this._relax();
    });
    // O auto-hide esconde o CONTAINER, o que desmapeia o painel sem que
    // nenhum crossing event chegue: sem isto a dock voltaria com os
    // ícones congelados no tamanho do último frame. Fora de cena não há
    // frame clock, então o retorno é imediato, sem ease.
    this._signals.connect(panel, "notify::mapped", () => {
      if (!panel.mapped) this.reset();
    });
  }

  /** Largura extra que a magnificação está somando ao painel, em px. */
  get extraWidth() {
    return this._extraWidth;
  }

  /**
   * Liga/desliga o efeito sem destruí-lo (usado durante o drag, quando os
   * ícones precisam estar na largura natural para o cálculo de drop).
   */
  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (!this._enabled) this.reset();
  }

  /** Volta tudo ao repouso AGORA, sem animar. */
  reset() {
    for (const icon of this._icons()) this._resetIcon(icon);
    this._extraWidth = 0;
  }

  destroy() {
    this._signals.disconnectAll();
    // Antes de soltar o callback: reset() depende dele para achar os
    // ícones que ainda estão inchados.
    try {
      this.reset();
    } catch (_) {}
    this._getIcons = null;
    this._panel = null;
  }

  _onMotion(event) {
    if (!this._enabled) return Clutter.EVENT_PROPAGATE;
    if (!this._panel?.mapped) return Clutter.EVENT_PROPAGATE;
    const [x] = event.get_coords();
    // Direto, sem ease: o efeito segue o dedo. Um easing aqui viraria
    // uma borracha sempre atrasada em relação ao ponteiro.
    this._apply(x);
    return Clutter.EVENT_PROPAGATE;
  }

  /**
   * escala(d) = 1 + (S−1)·cos²(π·d/(2·F)), zerada em d ≥ F.
   *
   * cos² dá derivada nula nas duas pontas: o ícone sob o ponteiro não
   * "trepida" quando ele passa pelo centro, e o último ícone dentro do
   * falloff entra sem degrau.
   */
  _scaleFor(distance) {
    if (distance >= this._falloff) return 1;
    const t = Math.cos((Math.PI * distance) / (2 * this._falloff));
    return 1 + (this._scale - 1) * t * t;
  }

  _apply(pointerX) {
    const icons = this._icons();
    if (!icons.length) {
      this._extraWidth = 0;
      return;
    }

    // Centros de REPOUSO, reconstruídos a partir da posição atual.
    //
    // Usar o centro atual (já inchado) faria a escala depender de si
    // mesma — o ícone que cresce se afasta do ponteiro e encolhe no
    // frame seguinte. Como o painel é centrado, uma largura extra total
    // E empurra a borda esquerda em E/2, e cada ícone leva ainda a soma
    // das extras dos ícones à sua esquerda:
    //
    //   esquerda_atual_i = esquerda_repouso_i − E/2 + Σ_{j<i} extra_j
    //
    // …que invertida dá o centro de repouso abaixo.
    const bases = [];
    const prefix = [];
    let extraSoFar = 0;
    for (const icon of icons) {
      bases.push(this._baseWidth(icon));
      prefix.push(extraSoFar);
      extraSoFar += icon._magExtraWidth ?? 0;
    }

    let total = 0;
    icons.forEach((icon, i) => {
      const base = bases[i];
      // Largura natural ainda não resolvida (ícone recém-criado, sem
      // style): pular é melhor do que fixar uma largura errada nele.
      if (base <= 0) return;
      const [left] = icon.get_transformed_position();
      const center = left + extraSoFar / 2 - prefix[i] + base / 2;
      const scale = this._scaleFor(Math.abs(pointerX - center));
      const width = Math.round(base * scale);
      this._applyIcon(icon, scale, width, base);
      total += width - base;
    });
    this._extraWidth = total;
  }

  _applyIcon(icon, scale, width, base) {
    const host = icon.host;
    if (host) {
      // Só as transições DESTE módulo: quem mais anima escala neste ícone
      // trabalha no stage, um actor diferente.
      host.remove_transition(SCALE_X);
      host.remove_transition(SCALE_Y);
      host.set_pivot_point(0.5, 1.0);
      host.set_scale(scale, scale);
    }
    icon.remove_transition(WIDTH);
    icon.set_width(width);
    icon._magExtraWidth = width - base;
  }

  /** Saída do ponteiro: volta ao repouso animando. */
  _relax() {
    for (const icon of this._icons()) {
      const base = icon._magBaseWidth ?? 0;
      const host = icon.host;
      if (host) {
        host.remove_transition(SCALE_X);
        host.remove_transition(SCALE_Y);
        host.ease({
          scale_x: 1,
          scale_y: 1,
          duration: MAGNIFICATION.RELAX_MS,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      }
      icon.remove_transition(WIDTH);
      if (base > 0 && icon._magExtraWidth) {
        icon.ease({
          width: base,
          duration: MAGNIFICATION.RELAX_MS,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          // -1 devolve a largura à preferida (nada de largura fantasma
          // se o tema ou o icon-size mudarem depois). Um novo motion
          // remove esta transição antes de completar, então o callback
          // só roda quando o repouso realmente aconteceu.
          onComplete: () => {
            try {
              icon.set_width(-1);
            } catch (_) {}
          },
        });
      } else {
        icon.set_width(-1);
      }
      icon._magExtraWidth = 0;
    }
    // Zerado já, e não ao fim do ease: quem lê isto é a live area do
    // auto-hide, e neste ponto o ponteiro JÁ saiu do painel.
    this._extraWidth = 0;
  }

  _resetIcon(icon) {
    const host = icon.host;
    if (host) {
      host.remove_transition(SCALE_X);
      host.remove_transition(SCALE_Y);
      host.set_scale(1, 1);
    }
    icon.remove_transition(WIDTH);
    icon.set_width(-1);
    icon._magExtraWidth = 0;
  }

  /**
   * Largura natural do botão, medida UMA vez por ícone e guardada NELE
   * (não num Map aqui): a medição precisa acontecer antes do primeiro
   * set_width, porque a partir dele get_preferred_width passa a devolver
   * a largura que fixamos. Guardada no próprio actor, morre com ele.
   */
  _baseWidth(icon) {
    const cached = icon._magBaseWidth;
    if (cached > 0) return cached;
    const [, natural] = icon.get_preferred_width(-1);
    if (natural > 0) icon._magBaseWidth = natural;
    return natural;
  }

  /** Ícones vivos e visíveis, na ordem visual. Nunca cacheado. */
  _icons() {
    const icons = this._getIcons?.() ?? [];
    return icons.filter((icon) => icon?.visible);
  }

  _clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }
}
