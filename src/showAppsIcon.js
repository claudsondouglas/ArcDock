import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import { SIZE } from './config.js';
import * as Cursor from './cursor.js';
import { attachHoverPress } from './iconAnimation.js';

export const ShowAppsIcon = GObject.registerClass(
class ShowAppsIcon extends St.Button {
    _init() {
        super._init({
            style_class: 'liquiddock-icon liquiddock-menu-icon',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this.set_child(new St.Icon({
            icon_name: 'view-app-grid',
            icon_size: SIZE.ICON,
            style_class: 'liquiddock-icon-texture',
        }));

        this.connect('clicked', this._onClicked.bind(this));
        attachHoverPress(this);
    }

    _onClicked() {
        Main.overview.show(OverviewControls.ControlsState.APP_GRID);
    }

    destroy() {
        if (this.hover)
            Cursor.setDefault();
        super.destroy();
    }
});
