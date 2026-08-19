import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { SignalTracker } from "./trackers.js";

const SETTING = "hide-in-fullscreen";

/**
 * Sai da frente enquanto houver uma janela em TELA CHEIA no monitor
 * primário — jogo, player de vídeo, browser em F11.
 *
 * A distinção que importa NÃO é "jogo x app": é fullscreen x maximizada,
 * e quem já sabe a diferença é o Mutter. Uma janela maximizada continua
 * sendo uma janela decorada dentro do workspace, respeita struts e
 * convive com o resto da chrome; uma janela fullscreen pediu o monitor
 * inteiro por protocolo (`_NET_WM_STATE_FULLSCREEN` / xdg-shell
 * `set_fullscreen`) e é essa a intenção "não me interrompa". Praticamente
 * todo jogo em cheia, exclusiva ou borderless via SDL/Proton, entra por
 * esse caminho — não existe nem precisa existir um teste de "é um jogo".
 *
 * O sinal é lido do display, `get_monitor_in_fullscreen(primaryIndex)`,
 * e não de uma varredura de janelas: é exatamente o mesmo estado que o
 * `trackFullscreen` do LayoutManager usa para esconder a chrome do
 * próprio Shell, já resolvido por monitor e já contando a pilha de
 * janelas (uma janela fullscreen coberta por outra não conta).
 *
 * Enquanto ativo o Dock manda `setForceHidden(true)` no AutoHide, o que
 * mata também a borda quente e o input catcher — em jogo, um dock que
 * "só" aparece ao encostar o mouse embaixo é pior que um dock fixo: ele
 * aparece no meio da mira.
 */
export class FullscreenWatcher {
  /**
   * @param {Gio.Settings} settings settings da extensão; a classe escuta
   *   `changed::hide-in-fullscreen` e liga/desliga sozinha.
   * @param {(active: boolean) => void} onChanged chamado só quando o
   *   estado efetivo muda.
   */
  constructor(settings, onChanged) {
    this._settings = settings;
    this._onChanged = onChanged;
    this._active = false;
    this._signals = new SignalTracker();

    this._signals.connect(settings, `changed::${SETTING}`, () =>
      this._update(),
    );
    // Emitido pelo Meta.Display quando QUALQUER monitor entra ou sai de
    // fullscreen; é o mesmo sinal em que o LayoutManager recalcula
    // monitor.inFullscreen, e o valor lido aqui já está atualizado.
    this._signals.connect(global.display, "in-fullscreen-changed", () =>
      this._update(),
    );
    // Índice do primário muda quando um monitor entra ou sai.
    this._signals.connect(Main.layoutManager, "monitors-changed", () =>
      this._update(),
    );

    // Estado inicial: a dock é recriada a cada preferência, wake e troca
    // de monitor, e pode muito bem nascer com o jogo já em tela cheia.
    this._active = this._compute();
  }

  /** @returns {boolean} dock deve ficar fora de cena agora. */
  get active() {
    return this._active;
  }

  destroy() {
    this._signals.disconnectAll();
    this._onChanged = null;
  }

  _update() {
    const active = this._compute();
    if (active === this._active) return;
    this._active = active;
    this._onChanged?.(active);
  }

  _compute() {
    if (!this._settings.get_boolean(SETTING)) return false;

    const index = Main.layoutManager.primaryIndex;
    if (index < 0) return false;
    try {
      return global.display.get_monitor_in_fullscreen(index);
    } catch (_) {
      // Fallback pelo LayoutManager: mesma informação, um passo depois.
      return Main.layoutManager.primaryMonitor?.inFullscreen ?? false;
    }
  }
}
