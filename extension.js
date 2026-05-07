import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Dock } from './src/dock.js';
import { WakeWatcher } from './src/wakeWatcher.js';

export default class ArcDockExtension extends Extension {
    enable() {
        log('[ArcDock] enable() entry');
        try {
            this._enabled = true;
            this._restartSourceIds = new Set();
            this._signalConnections = [];
            this._settings = this.getSettings();
            this._lastSessionMode = Main.sessionMode.currentMode;
            log(`[ArcDock] enable: lastSessionMode=${this._lastSessionMode}`);
            this._wakeWatcher = new WakeWatcher(() => this._scheduleDockRestart(1200, 'prepare-for-sleep'));
            this._connectSignal(this._settings, 'changed::icon-size', () => {
                log('[ArcDock] icon size changed');
                this._restartDock('icon-size-changed');
            });
            this._connectSignal(this._settings, 'changed::running-dot-theme-color', () => {
                log('[ArcDock] running dot color mode changed');
                this._restartDock('running-dot-theme-color-changed');
            });
            this._connectSignal(Main.sessionMode, 'updated', () => {
                try {
                    const mode = Main.sessionMode.currentMode;
                    log(`[ArcDock] session mode updated: ${this._lastSessionMode} -> ${mode}`);
                    const wasLocked = this._isLockedMode(this._lastSessionMode);
                    const isLocked = this._isLockedMode(mode);
                    this._lastSessionMode = mode;

                    if (isLocked) {
                        this._cancelDockRestarts();
                        this._destroyDock();
                    } else if (wasLocked) {
                        this._ensureDock();
                        this._scheduleDockRepairSeries('session-unlocked');
                    }
                } catch (e) {
                    logError(e, '[ArcDock] sessionMode updated handler failed');
                }
            });
            this._connectSignal(Main.layoutManager, 'monitors-changed', () => {
                log('[ArcDock] monitors changed');
                this._scheduleDockRestart(1200, 'monitors-changed');
            });
            this._connectSignal(Main.screenShield, 'wake-up-screen', () => {
                log('[ArcDock] screen wake-up detected');
                this._scheduleDockRepairSeries('screen-wake-up');
            });
            if (!this._isLockedMode(this._lastSessionMode)) {
                this._ensureDock();
                this._scheduleDockRepairSeries('enable');
            }
        } catch (e) {
            logError(e, '[ArcDock] enable() failed');
            throw e;
        }
        log('[ArcDock] enable() exit');
    }

    disable() {
        log('[ArcDock] disable() entry');
        try {
            this._enabled = false;
            this._cancelDockRestarts();
            this._disconnectSignals();
            this._wakeWatcher?.destroy();
            this._wakeWatcher = null;
            this._destroyDock();
            this._settings = null;
        } catch (e) {
            logError(e, '[ArcDock] disable() failed');
        }
        log('[ArcDock] disable() exit');
    }

    _connectSignal(obj, signal, handler) {
        if (!obj)
            return;

        try {
            const id = obj.connect(signal, handler);
            this._signalConnections.push({ obj, id });
        } catch (e) {
            logError(e, `[ArcDock] failed to connect signal ${signal}`);
        }
    }

    _disconnectSignals() {
        for (const { obj, id } of this._signalConnections) {
            try { obj.disconnect(id); } catch (_) {}
        }
        this._signalConnections = [];
    }

    _isLockedMode(mode) {
        return mode === 'unlock-dialog' || mode === 'lock-screen';
    }

    _createDock() {
        this._dock = new Dock({
            iconSize: this._settings?.get_int('icon-size'),
            useThemeRunningDotColor:
                this._settings?.get_boolean('running-dot-theme-color') ?? false,
        });
        log('[ArcDock] dock created');
    }

    _ensureDock() {
        if (this._isLockedMode(Main.sessionMode.currentMode))
            return;
        if (!this._dock)
            this._createDock();
    }

    _destroyDock() {
        try {
            this._dock?.destroy();
        } catch (e) {
            logError(e, '[ArcDock] dock destroy failed');
        }
        this._dock = null;
    }

    _scheduleDockRepairSeries(reason) {
        this._scheduleDockRestart(1200, reason);
        this._scheduleDockRestart(4000, reason);
        this._scheduleDockRestart(10000, reason);
    }

    _scheduleDockRestart(delayMs, reason = 'unknown') {
        if (!this._enabled)
            return;

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._restartSourceIds.delete(id);
            this._restartDock(reason);
            return GLib.SOURCE_REMOVE;
        });
        this._restartSourceIds.add(id);
    }

    _cancelDockRestarts() {
        for (const id of this._restartSourceIds)
            GLib.source_remove(id);
        this._restartSourceIds.clear();
    }

    _restartDock(reason) {
        if (!this._enabled)
            return;
        if (this._isLockedMode(Main.sessionMode.currentMode)) {
            this._destroyDock();
            return;
        }

        this._destroyDock();
        this._createDock();
        log(`[ArcDock] dock restarted after ${reason}`);
    }
}
