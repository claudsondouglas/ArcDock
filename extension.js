import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Dock } from './src/dock.js';

export default class LiquidDockExtension extends Extension {
    enable() {
        this._dock = new Dock();
    }

    disable() {
        this._dock?.destroy();
        this._dock = null;
    }
}
