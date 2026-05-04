import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Overlay full-screen invisível e reactive. Posicionado no z-order
 * imediatamente abaixo do dock. Quando visível, garante que qualquer clique
 * fora dos ícones do dock seja consumido pela chrome (em vez de vazar pra
 * janela atrás), e dispara o callback `onClickOutside` pra esconder o dock.
 */
export class InputCatcher {
    constructor(onClickOutside) {
        this._actor = new St.Widget({
            reactive: true,
            can_focus: false,
            opacity: 0,
        });
        this._actor.connect('button-press-event', () => {
            onClickOutside?.();
            return Clutter.EVENT_STOP;
        });
        this._actor.connect('button-release-event', () => Clutter.EVENT_STOP);

        Main.layoutManager.addChrome(this._actor, {
            affectsInputRegion: true,
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._actor.hide();
    }

    fitToMonitor() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._actor.set_position(monitor.x, monitor.y);
        this._actor.set_size(monitor.width, monitor.height);
    }

    placeBelow(sibling) {
        const parent = this._actor.get_parent();
        parent?.set_child_below_sibling(this._actor, sibling);
    }

    show() {
        this._actor.show();
    }

    hide() {
        this._actor.hide();
    }

    destroy() {
        Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
        this._actor = null;
    }
}
