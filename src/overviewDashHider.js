import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SignalTracker } from './trackers.js';

export class OverviewDashHider {
    constructor() {
        this._signals = new SignalTracker();
        this._dash = Main.overview.dash;
        this._wasVisible = this._dash?.visible ?? true;

        this._signals.connect(Main.overview, 'showing', () => this._hide());
        this._signals.connect(Main.overview, 'shown', () => this._hide());

        this._hide();
    }

    destroy() {
        this._signals.disconnectAll();
        if (this._dash && this._wasVisible)
            this._dash.show();
        this._dash = null;
    }

    _hide() {
        this._dash?.hide();
    }
}
