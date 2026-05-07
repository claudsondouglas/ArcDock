import Clutter from "gi://Clutter";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Cursor from "./cursor.js";

const PRESS_LIFT = -6;
const PRESS_UP_MS = 120;
const PRESS_DOWN_MS = 180;

export function triggerPressBounce(button) {
  const target = _animationTarget(button);
  target.remove_all_transitions();
  target.ease({
    translation_y: PRESS_LIFT,
    duration: PRESS_UP_MS,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    onComplete: () => {
      target.ease({
        translation_y: 0,
        duration: PRESS_DOWN_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    },
  });
}

export function attachHoverPress(button) {
  button.connect("notify::hover", () => {
    if (button.hover) {
      Cursor.setPointer();
      _showTooltip(button);
    } else {
      Cursor.setDefault();
      _hideTooltip(button);
    }
  });

  button.connect("destroy", () => _hideTooltip(button));
}

export function resetHoverPress(button) {
  _resetActor(button);
  const child = button.get_child?.();
  if (child) _resetActor(child);
  const icon = _animationTarget(button);
  if (icon !== button && icon !== child) _resetActor(icon);
  _hideTooltip(button);
}

function _animationTarget(button) {
  return button._hoverActor ?? button.get_child?.() ?? button;
}

function _resetActor(actor) {
  actor.remove_all_transitions();
  actor.scale_x = 1;
  actor.scale_y = 1;
  actor.translation_y = 0;
}

function _showTooltip(button) {
  const text = button._tooltipText;
  if (!text) return;

  _hideTooltip(button);

  // popup-menu-content é a classe nativa do GNOME usada pelos menus de
  // popup — herda background, cor de texto, border, shadow do tema do
  // shell, igual ao menu de botão direito do dock.
  const label = new St.Label({
    text,
    style_class: "popup-menu-content arcdock-tooltip-label",
  });

  const tooltip = new St.BoxLayout({
    style_class: "arcdock-tooltip",
    vertical: true,
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
  });
  // translation_y aplicado após a inserção pra garantir que o BoxLayout
  // não reseta. Valor negativo > altura da seta faz sobreposição visual
  // dentro da área do label, eliminando qualquer gap perceptível.
  arrow.translation_y = 0;
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

  button._tooltip = tooltip;
}

function _hideTooltip(button) {
  button._tooltip?.destroy();
  button._tooltip = null;
}
