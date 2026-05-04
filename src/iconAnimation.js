import Clutter from 'gi://Clutter';

import { ANIM } from './config.js';
import * as Cursor from './cursor.js';

export function attachHoverPress(button) {
    button.set_pivot_point(0.5, 1.0);

    button.connect('notify::hover', () => {
        if (button.hover) {
            Cursor.setPointer();
            _animateTo(button, ANIM.HOVER_SCALE, ANIM.HOVER_LIFT, ANIM.HOVER_IN_MS);
        } else {
            Cursor.setDefault();
            _animateTo(button, 1, 0, ANIM.HOVER_OUT_MS);
        }
    });
}

function _animateTo(actor, scale, liftY, duration) {
    actor.remove_all_transitions();
    actor.ease({
        scale_x: scale,
        scale_y: scale,
        translation_y: liftY,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUART,
    });
}
