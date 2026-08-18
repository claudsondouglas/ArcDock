import Shell from "gi://Shell";

const EFFECT_NAME = "liquid-glass";

/* brightness fica EM 1.0 de propósito: o blur é um retângulo e a borda
 * dele acaba visível quanto mais o brilho se afasta do fundo real — com
 * o sigma maior daqui, qualquer desvio vira um degrau nítido na margem.
 * O realce "vidro" vem do gradiente branco do .arcdock-panel, esse sim
 * recortado pelo border-radius.
 *
 * radius 16: o frosted do macOS dissolve o wallpaper em manchas de cor;
 * com o painel agora bem mais translúcido, um sigma baixo deixava as
 * janelas atrás legíveis demais através do vidro. */
const DEFAULTS = Object.freeze({
  radius: 16,
  brightness: 1.0,
});

/* Shell.BlurEffect's intensity property is named `radius` in some GNOME
 * Shell versions and `sigma` in others. We probe at runtime and set
 * whichever exists, so the same code works across versions. */
function setIntensity(effect, value) {
  if ("sigma" in effect) {
    effect.sigma = value;
    return;
  }
  if ("radius" in effect) {
    effect.radius = value;
    return;
  }
}

export function applyGlass(actor, opts = {}) {
  const { radius, brightness } = { ...DEFAULTS, ...opts };
  const effect = new Shell.BlurEffect();
  setIntensity(effect, radius);
  effect.brightness = brightness;
  effect.mode = Shell.BlurMode.BACKGROUND;
  actor.add_effect_with_name(EFFECT_NAME, effect);
  return effect;
}

export function removeGlass(actor) {
  actor.remove_effect_by_name(EFFECT_NAME);
}
