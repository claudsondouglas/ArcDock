import Shell from "gi://Shell";

const EFFECT_NAME = "liquid-glass";

const DEFAULTS = Object.freeze({
  radius: 8,
  brightness: 1.8,
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
