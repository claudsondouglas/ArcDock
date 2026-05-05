import GObject from 'gi://GObject';
import St from 'gi://St';

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { SIZE } from './config.js';
import * as Cursor from './cursor.js';
import { attachHoverPress } from './iconAnimation.js';

export const DockIcon = GObject.registerClass(
class DockIcon extends St.Button {
    _init(window, app) {
        super._init({
            style_class: 'liquiddock-icon',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        this.window = window;
        this.app = app;

        const texture = app.create_icon_texture(SIZE.ICON);
        texture.add_style_class_name('liquiddock-icon-texture');
        this.set_child(texture);

        this.connect('clicked', this._onClicked.bind(this));
        attachHoverPress(this);

        // _delegate é o que o DND lê para identificar o source no drop target.
        this._delegate = this;
        this._draggable = DND.makeDraggable(this, {
            timeoutThreshold: 150,
            restoreOnSuccess: false,
        });
        this._draggable.connect('drag-begin', () => { this.hide(); });
        const restore = () => { this.opacity = 255; this.show(); };
        this._draggable.connect('drag-end', restore);
        this._draggable.connect('drag-cancelled', restore);
    }

    _onClicked(_actor, button) {
        if (button === Clutter.BUTTON_MIDDLE)
            this.window.delete(global.get_current_time());
        else
            Main.activateWindow(this.window);
    }

    destroy() {
        if (this.hover)
            Cursor.setDefault();
        super.destroy();
    }
});
