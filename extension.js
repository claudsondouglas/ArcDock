import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Dock } from './src/dock.js';
import { WakeWatcher } from './src/wakeWatcher.js';

export default class LiquidDockExtension extends Extension {
    enable() {
        try {
            this._enabled = true;
            this._restartSourceIds = new Set();
            this._signalConnections = [];
            this._lastSessionMode = Main.sessionMode.currentMode;
            this._wakeWatcher = new WakeWatcher(() => this._scheduleDockRestart(1200, 'prepare-for-sleep'));
            this._connectSignal(Main.sessionMode, 'updated', () => {
                const mode = Main.sessionMode.currentMode;
                log(`[MahoeDock] session mode updated: ${this._lastSessionMode} -> ${mode}`);
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
            });
            this._connectSignal(Main.layoutManager, 'monitors-changed', () => {
                log('[MahoeDock] monitors changed');
                this._scheduleDockRestart(1200, 'monitors-changed');
            });
            this._connectSignal(Main.screenShield, 'wake-up-screen', () => {
                log('[MahoeDock] screen wake-up detected');
                this._scheduleDockRepairSeries('screen-wake-up');
            });
            if (!this._isLockedMode(this._lastSessionMode)) {
                this._ensureDock();
                this._scheduleDockRepairSeries('enable');
            }
        } catch (e) {
            logError(e, '[MahoeDock] enable() failed');
            throw e;
        }
    }

    disable() {
        try {
            log('[MahoeDock] disable');
            this._enabled = false;
            this._cancelDockRestarts();
            this._disconnectSignals();
            this._wakeWatcher?.destroy();
            this._wakeWatcher = null;
            this._destroyDock();
        } catch (e) {
            logError(e, '[MahoeDock] disable() failed');
        }
    }

    _connectSignal(obj, signal, handler) {
        if (!obj)
            return;

        try {
            const id = obj.connect(signal, handler);
            this._signalConnections.push({ obj, id });
        } catch (e) {
            logError(e, `[MahoeDock] failed to connect signal ${signal}`);
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
        this._dock = new Dock();
        log('[MahoeDock] dock created');
    }

    _ensureDock() {
        if (!this._dock)
            this._createDock();
    }

    _destroyDock() {
        try {
            this._dock?.destroy();
        } catch (e) {
            logError(e, '[MahoeDock] dock destroy failed');
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

        this._destroyDock();
        this._createDock();
        log(`[MahoeDock] dock restarted after ${reason}`);
    }
}
