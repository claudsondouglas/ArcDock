import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { ANIM, DockTheme, TIMING } from "./config.js";
import * as Cursor from "./cursor.js";
import { TimeoutTracker } from "./trackers.js";

// Tema atual do tooltip. Ele vive no uiGroup, fora da árvore do painel,
// então nenhum seletor descendente de .arcdock-panel-dark o alcança: a
// única forma de vesti-lo é escolher a style class na criação. Estado de
// módulo (e não um campo por botão) porque só existe UM dock por sessão e
// o tooltip é criado aqui dentro — assim nem IconButton nem as subclasses
// precisam carregar o tema só para repassá-lo adiante. O Dock chama
// setTooltipTheme() no construtor, ou seja em toda troca de tema (a key
// recria a dock) e em todo enable(), o que também cobre o cache de módulo
// ESM sobreviver a um disable/enable.
let tooltipTheme = DockTheme.LIGHT;

export function setTooltipTheme(theme) {
  tooltipTheme = theme === DockTheme.DARK ? DockTheme.DARK : DockTheme.LIGHT;
}

// Nomes das transições implícitas criadas por actor.ease(). O helper do
// Shell troca o "_" da propriedade por "-", então é por estes nomes que
// removemos UMA animação sem derrubar as outras do mesmo actor — ver
// _bounce() para o porquê de não usar remove_all_transitions() lá.
const TRANSLATION_Y = "translation-y";
const SCALE_X = "scale-x";
const SCALE_Y = "scale-y";

// Queda livre: um quique com metade da altura leva √0.5 do tempo.
const BOUNCE_TIME_DECAY = Math.sqrt(ANIM.BOUNCE_DECAY);

/**
 * Actor que recebe TODAS as animações do ícone.
 *
 * É sempre o `stage`, nunca o `host`: o host carrega o indicador de app
 * rodando e o dot de atenção como irmãos do stage, e escalar/mover o
 * host levaria os pips junto — o indicador tem que ficar parado embaixo
 * do ícone, como no macOS. Também não é o próprio botão: o dock chama
 * `icon.show(); icon.opacity = 255;` em _applyOrder() logo depois de
 * adicionar o filho, o que atropelaria qualquer fade feito no botão.
 *
 * `_animActor` é definido pelas classes de ícone; os fallbacks cobrem
 * botões que ainda não o exponham.
 */
export function animationTarget(button) {
  return (
    button._animActor ?? button._hoverActor ?? button.get_child?.() ?? button
  );
}

/**
 * Entrada do ícone: cresce do nada com um leve overshoot.
 *
 * Chamada do construtor, quando o ícone ainda nem tem pai — logo, não
 * está mapeado e não tem frame clock, e uma transição iniciada agora
 * ficaria parada esperando um relógio. Por isso o estado inicial é
 * aplicado já, mas o ease só dispara no primeiro map: a animação inteira
 * acontece com o ícone à vista (inclusive a leva toda que nasce com o
 * dock ainda escondido pelo auto-hide).
 */
export function playEntry(button) {
  if (button._animDestroyed) return;
  const target = animationTarget(button);
  target.remove_all_transitions();
  // Sem pivot o scale cresce a partir do canto superior esquerdo; com o
  // pivot na base o ícone "brota" do painel.
  target.set_pivot_point(0.5, 1.0);
  _entryFromState(target);

  if (button.mapped) {
    _runEntry(button);
    return;
  }
  // Conexão no próprio botão: morre junto com ele, sem tracker.
  const handlerId = button.connect("notify::mapped", () => {
    if (!button.mapped) return;
    button.disconnect(handlerId);
    _runEntry(button);
  });
}

function _entryFromState(target) {
  target.opacity = 0;
  target.set_scale(ANIM.ENTRY_SCALE, ANIM.ENTRY_SCALE);
}

function _runEntry(button) {
  if (button._animDestroyed) return;
  const target = animationTarget(button);
  target.remove_all_transitions();
  _entryFromState(target);
  target.ease({
    scale_x: 1,
    scale_y: 1,
    opacity: 255,
    duration: ANIM.ENTRY_MS,
    mode: Clutter.AnimationMode.EASE_OUT_BACK,
  });
}

/** Pulinho único: "abri alguma coisa" (pasta, grade de apps). */
export function triggerPressBounce(button) {
  _bounce(button, ANIM.TAP_LIFT, 1);
}

/** Quique de lançamento estilo macOS: o app ainda vai abrir. */
export function triggerLaunchBounce(button) {
  _bounce(button, ANIM.BOUNCE_HEIGHT, ANIM.BOUNCE_HOPS);
}

export function attachHoverPress(button) {
  const target = animationTarget(button);
  target.set_pivot_point(0.5, 1.0);
  // Tracker do watchdog de hover (abaixo). Vive no botão e é esvaziado
  // no destroy — nada de timeout solto fora de tracker.
  button._hoverTimeouts = new TimeoutTracker();

  button.connect("notify::hover", () => {
    if (button.hover) {
      // O St do GNOME 49/50 trocou a implementação de sync_hover(): em
      // vez de perguntar ao stage sobre qual actor o ponteiro está, ele
      // confia num contador interno de enter/leave (enter_count). Esse
      // contador VAZA sempre que o botão sai de cena com o ponteiro em
      // cima — o drag-begin faz hide() no próprio botão, o auto-hide
      // esconde o container — porque actor fora de cena nunca recebe o
      // leave (st_widget_unmap zera o hover, mas NÃO o contador). Na
      // sequência, qualquer sync_hover — como o track_hover=true de
      // Dock._resumeHover() no fim de um drag — faz set_hover(TRUE) com
      // o ponteiro em QUALQUER lugar da tela, e como ele não está aqui
      // dentro, nenhum leave jamais desfaz: cursor de mãozinha, tooltip
      // e realce grudados. Validar contra a geometria real mata a
      // ressurreição na origem: hover=true com o ponteiro fora do botão
      // é sempre estado podre, nunca um hover de verdade.
      if (!_pointerInsideButton(button)) {
        // Flag pro ramo de saída logo abaixo (o set_hover dispara o
        // notify sincronamente): este hover nunca "entrou", então não
        // há cursor/tooltip/press a desfazer — e o Cursor.setDefault()
        // de lá atropelaria o cursor de um ícone realmente em hover.
        button._hoverGhost = true;
        button.set_hover(false);
        button._hoverGhost = false;
        return;
      }
      Cursor.setPointer();
      _showTooltip(button);
      // Rede pra TODA saída sem crossing event — grab modal engolindo o
      // leave (a doc do St avisa que hover não é rastreável durante um
      // pointer grab), actor transladado/escondido sob o ponteiro
      // parado, ícone recriado pelo _refresh(). Enquanto o botão se
      // achar em hover, confere a 10Hz se o ponteiro segue nele; é o
      // mesmo padrão de polling do auto-hide.
      _startHoverWatchdog(button);
    } else {
      _stopHoverWatchdog(button);
      if (button._hoverGhost) return;
      // Sair do ícone rearma o tooltip pro próximo hover.
      button._tooltipSuppressed = false;
      Cursor.setDefault();
      // Soltar o botão fora do ícone não gera release aqui, então o
      // hover-out também precisa desfazer o afundamento.
      _pressUp(button);
      _hideTooltip(button);
    }
  });

  // Um clique fecha o bubble e o mantém fechado até o ponteiro sair e
  // voltar (mesmo comportamento do macOS). Sem isto o tooltip fica na
  // tela depois do clique: o auto-hide só faz hide() do container, o
  // que não muda `hover` do botão, então nada dispararia _hideTooltip —
  // e o bubble (branco no tema claro) ficava solto sobre a área de
  // trabalho, parecendo um "fundo branco" surgido do nada.
  button.connect("button-press-event", () => {
    dismissTooltip(button);
    _pressDown(button);
    return Clutter.EVENT_PROPAGATE;
  });

  button.connect("button-release-event", () => {
    _pressUp(button);
    return Clutter.EVENT_PROPAGATE;
  });

  // Segundo caminho de volta, de propósito: no GNOME 49+ o St.Button
  // detecta o clique por ClutterClickGesture, e quando o gesture reivindica
  // a sequência o 'button-release-event' pode não chegar até aqui. Sem
  // este handler o ícone poderia ficar encolhido para sempre. _pressUp é
  // idempotente (sai cedo se não há press ativo), então os dois caminhos
  // convivem sem animar duas vezes.
  button.connect("clicked", () => _pressUp(button));

  // Rede de segurança: dock escondido/desmontado nunca deixa bubble órfão
  // nem animação pendurada. Fora da cena o actor perde o frame clock e as
  // transições param de avançar — animar aqui congelaria o ícone
  // encolhido (ou no alto do quique) até o próximo map, então o estado
  // visual volta de uma vez, sem ease.
  button.connect("notify::mapped", () => {
    if (!button.mapped) {
      // O st_widget_unmap já zera o hover (e o ramo de saída acima para
      // o watchdog), mas só quando track_hover está ligado — durante um
      // drag ele está desligado, então o stop aqui é a garantia.
      _stopHoverWatchdog(button);
      _cancelIconAnimations(button);
      _hideTooltip(button, true);
    }
  });

  button.connect("destroy", () => {
    // O actor ainda está vivo aqui (o sinal é emitido no início da
    // destruição), então dá para parar as transições em vez de deixá-las
    // morrer junto com ele e disparar onComplete sobre actor finalizado.
    button._animDestroyed = true;
    button._hoverTimeouts?.removeAll();
    button._hoverWatchdogId = 0;
    try {
      animationTarget(button).remove_all_transitions();
    } catch (_) {}
    _hideTooltip(button, true);
  });
}

/**
 * O ponteiro está mesmo sobre o botão? Conta feita em geometria
 * transformada, então acompanha a translação do auto-hide e a largura
 * extra da magnificação; botão fora de cena conta como "fora" — actor
 * desmapeado não recebe crossing events, logo hover nele é sempre resto
 * de estado, nunca um hover real.
 */
function _pointerInsideButton(button) {
  if (!button.mapped || !button.visible) return false;
  const [x, y] = global.get_pointer();
  const rect = button.get_transformed_extents();
  return (
    x >= rect.get_x() &&
    x < rect.get_x() + rect.get_width() &&
    y >= rect.get_y() &&
    y < rect.get_y() + rect.get_height()
  );
}

// --- Watchdog de hover ---
//
// Só roda ENQUANTO um botão está em hover (na prática, um por vez), e
// morre sozinho no primeiro tick em que o hover cai — custo desprezível.
// É a rede para os jeitos de o ponteiro "sair" sem crossing event que
// nenhum handler cobre por construção: grab modal (menu de contexto,
// launcher, overview), dock escondida sob o ponteiro parado, ícone
// recriado pelo _refresh() por baixo do cursor.

function _startHoverWatchdog(button) {
  if (button._hoverWatchdogId) return;
  button._hoverWatchdogId =
    button._hoverTimeouts?.add(TIMING.POINTER_POLL_MS, () => {
      if (button._animDestroyed || !button.hover) {
        button._hoverWatchdogId = 0;
        return GLib.SOURCE_REMOVE;
      }
      if (!_pointerInsideButton(button)) {
        button._hoverWatchdogId = 0;
        // set_hover(false) percorre o caminho NORMAL de saída (o
        // notify::hover acima): devolve o cursor, fecha o tooltip com
        // fade e solta o press — nada de desfazer na mão aqui.
        button.set_hover(false);
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    }) ?? 0;
}

function _stopHoverWatchdog(button) {
  if (!button._hoverWatchdogId) return;
  button._hoverTimeouts?.remove(button._hoverWatchdogId);
  button._hoverWatchdogId = 0;
}

/** Fecha o tooltip agora e impede que ele volte até o próximo hover. */
export function dismissTooltip(button) {
  button._tooltipSuppressed = true;
  _hideTooltip(button);
}

export function resetHoverPress(button) {
  _stopHoverWatchdog(button);
  // O hover não pode sobreviver a um reset: quem chama (drag-begin) já
  // sabe que o caminho normal de saída não vai rodar — o drag rouba o
  // ponteiro e o track_hover é desligado logo em seguida. set_hover(false)
  // derruba a pseudo-classe :hover (o realce de fundo some junto) e
  // dispara o notify que devolve o cursor; o reset duro abaixo cobre o
  // que a saída animada deixaria pela metade.
  if (button.hover) button.set_hover(false);
  button._tooltipSuppressed = false;
  // O drag rouba o ponteiro: o release nunca chega ao botão, então o
  // flag de press precisa ser zerado à mão ou o próximo hover-out
  // dispararia um "solta" sem "aperta".
  button._pressActive = false;
  _resetActor(button);
  const child = button.get_child?.();
  if (child) _resetActor(child);
  const target = animationTarget(button);
  if (target !== button && target !== child) _resetActor(target);
  _hideTooltip(button, true);
}

/** Volta o alvo ao repouso na hora, sem animar nem tocar na opacidade. */
function _cancelIconAnimations(button) {
  button._pressActive = false;
  if (button._animDestroyed) return;
  const target = animationTarget(button);
  target.remove_transition(SCALE_X);
  target.remove_transition(SCALE_Y);
  target.remove_transition(TRANSLATION_Y);
  target.set_scale(1, 1);
  target.translation_y = 0;
}

function _resetActor(actor) {
  actor.remove_all_transitions();
  actor.scale_x = 1;
  actor.scale_y = 1;
  actor.translation_y = 0;
  actor.opacity = 255;
}

// --- Press ---

function _pressDown(button) {
  if (button._animDestroyed) return;
  const target = animationTarget(button);
  button._pressActive = true;
  target.remove_transition(SCALE_X);
  target.remove_transition(SCALE_Y);
  target.ease({
    scale_x: ANIM.PRESS_SCALE,
    scale_y: ANIM.PRESS_SCALE,
    duration: ANIM.PRESS_IN_MS,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
  });
}

function _pressUp(button) {
  // Sem press em andamento não há o que soltar — e sair daqui protege a
  // animação de entrada, que também mexe na escala do mesmo actor.
  if (!button._pressActive) return;
  button._pressActive = false;
  if (button._animDestroyed) return;
  const target = animationTarget(button);
  target.remove_transition(SCALE_X);
  target.remove_transition(SCALE_Y);
  target.ease({
    scale_x: 1,
    scale_y: 1,
    duration: ANIM.PRESS_OUT_MS,
    mode: Clutter.AnimationMode.EASE_OUT_BACK,
  });
}

// --- Quique ---

function _bounce(button, height, hops) {
  if (button._animDestroyed) return;
  const target = animationTarget(button);
  // Escopo de propriedade em vez de remove_all_transitions(): o quique
  // começa no 'clicked', ou seja EXATAMENTE quando a escala de release
  // ainda está subindo. Derrubar tudo congelaria o ícone encolhido.
  target.remove_transition(TRANSLATION_Y);
  target.translation_y = 0;
  _hop(button, target, height, hops, ANIM.BOUNCE_UP_MS, ANIM.BOUNCE_DOWN_MS);
}

function _hop(button, target, height, hopsLeft, upMs, downMs) {
  target.ease({
    translation_y: -height,
    duration: upMs,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    onComplete: () => {
      if (button._animDestroyed) return;
      target.ease({
        translation_y: 0,
        duration: downMs,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => {
          if (button._animDestroyed) return;
          // Zera na mão: o ease pode ter parado em -0.0001 e o actor
          // ficaria com um translation residual para sempre.
          target.translation_y = 0;
          if (hopsLeft <= 1) return;
          _hop(
            button,
            target,
            height * ANIM.BOUNCE_DECAY,
            hopsLeft - 1,
            Math.round(upMs * BOUNCE_TIME_DECAY),
            Math.round(downMs * BOUNCE_TIME_DECAY),
          );
        },
      });
    },
  });
}

// --- Tooltip ---

function _showTooltip(button) {
  const text = button._tooltipText;
  if (!text) return;
  if (button._tooltipSuppressed) return;
  if (!button.mapped) return;

  // Imediato: um bubble em fade-out sobreposto ao novo faria os dois
  // aparecerem juntos no mesmo ponto durante ~100ms.
  _hideTooltip(button, true);

  // popup-menu-content dá a base de bubble do tema atual; nosso CSS
  // sobrescreve geometria (margin/min-height, pra que a seta nunca
  // descole) E cores, pra que o bubble siga o tema da DOCK e não o do
  // shell — um dock claro sob um shell escuro teria tooltip escuro.
  const label = new St.Label({
    text,
    style_class:
      tooltipTheme === DockTheme.DARK
        ? "popup-menu-content arcdock-tooltip-label arcdock-tooltip-label-dark"
        : "popup-menu-content arcdock-tooltip-label",
  });

  const tooltip = new St.BoxLayout({
    style_class: "arcdock-tooltip",
    vertical: true,
    opacity: 0,
  });
  tooltip.add_child(label);

  Main.layoutManager.uiGroup.add_child(tooltip);

  // ensure_style() força o St a resolver o CSS imediatamente, então
  // get_preferred_width/height retornam o tamanho real (com padding,
  // border, fonte). Sem isso, a medição vem zerada/sem padding.
  label.ensure_style();
  tooltip.ensure_style();

  // Lê a cor de background do label depois do style resolvido, pra
  // que a seta combine com o tema atual (claro/escuro/qualquer um).
  const themeNode = label.get_theme_node();
  const bg = themeNode.get_background_color();
  const arrowFill = [
    bg.red / 255,
    bg.green / 255,
    bg.blue / 255,
    bg.alpha / 255,
  ];

  const ARROW_W = 12;
  const ARROW_H = 6;
  const arrow = new St.DrawingArea({
    width: ARROW_W,
    height: ARROW_H,
    x_align: Clutter.ActorAlign.CENTER,
    x_expand: true,
    // Encosta a seta no bubble — evita gap de 1px por arredondamento.
    style: "margin-top: -1px;",
  });
  arrow.connect("repaint", () => {
    const cr = arrow.get_context();
    const [w, h] = arrow.get_surface_size();
    cr.moveTo(0, 0);
    cr.lineTo(w, 0);
    cr.lineTo(w / 2, h);
    cr.closePath();
    cr.setSourceRGBA(...arrowFill);
    cr.fill();
    cr.$dispose();
  });
  tooltip.add_child(arrow);

  const [, tooltipW] = tooltip.get_preferred_width(-1);
  const [, tooltipH] = tooltip.get_preferred_height(-1);

  const target = button._tooltipHost ?? button;
  const [targetX, targetY] = target.get_transformed_position();
  const [targetW] = target.get_transformed_size?.() ?? target.get_size();

  tooltip.set_position(
    Math.round(targetX + targetW / 2 - tooltipW / 2),
    Math.round(targetY - tooltipH - 14),
  );

  // Entrada: sobe TOOLTIP_SLIDE px enquanto aparece. translation_y é
  // aditivo à posição acima, então basta voltá-lo a zero.
  tooltip.translation_y = ANIM.TOOLTIP_SLIDE;
  tooltip.ease({
    opacity: 255,
    translation_y: 0,
    duration: ANIM.TOOLTIP_FADE_IN_MS,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
  });

  button._tooltip = tooltip;
}

/**
 * @param {boolean} immediate destrói sem fade. Obrigatório quando o
 *   bubble não pode sobreviver nem por um frame ao dono (unmap, destroy,
 *   início de drag) — ele vive no uiGroup, não na árvore do botão, e
 *   continuaria pintado sobre a área de trabalho.
 */
function _hideTooltip(button, immediate = false) {
  const tooltip = button._tooltip;
  button._tooltip = null;
  // Um bubble anterior ainda em fade-out: nunca deixamos dois vivos.
  const fading = button._tooltipFading;
  button._tooltipFading = null;
  if (fading) {
    fading.remove_all_transitions();
    fading.destroy();
  }

  if (!tooltip) return;
  tooltip.remove_all_transitions();
  if (immediate) {
    tooltip.destroy();
    return;
  }

  button._tooltipFading = tooltip;
  tooltip.ease({
    opacity: 0,
    translation_y: ANIM.TOOLTIP_SLIDE,
    duration: ANIM.TOOLTIP_FADE_OUT_MS,
    mode: Clutter.AnimationMode.EASE_IN_QUAD,
    onComplete: () => {
      if (button._tooltipFading === tooltip) button._tooltipFading = null;
      tooltip.destroy();
    },
  });
}
