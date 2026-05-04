import GObject from 'gi://GObject';
import St from 'gi://St';

import Clutter from 'gi://Clutter';

import { SIZE } from './config.js';
import * as Cursor from './cursor.js';
import { attachHoverPress } from './iconAnimation.js';

export const DockIcon = GObject.registerClass(
class DockIcon extends St.Button {
    _init(app) {
        super._init({
            style_class: 'liquiddock-icon',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        this.app = app;

        const texture = app.create_icon_texture(SIZE.ICON);
        texture.add_style_class_name('liquiddock-icon-texture');
        this.set_child(texture);

        this.connect('clicked', this._onClicked.bind(this));
        attachHoverPress(this);
    }

    _onClicked(_actor, button) {
        if (button === Clutter.BUTTON_MIDDLE)
            this.app.request_quit();
        else
            this.app.activate();
    }

    destroy() {
        if (this.hover)
            Cursor.setDefault();
        super.destroy();
    }
});
