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
            this._connectSignal(this._settings, 'changed::running-indicator-style', () => {
                log('[ArcDock] running indicator style changed');
                this._restartDock('running-indicator-style-changed');
            });
            this._connectSignal(this._settings, 'changed::dock-theme', () => {
                log('[ArcDock] dock theme changed');
                this._restartDock('dock-theme-changed');
            });
            this._connectSignal(this._settings, 'changed::click-to-minimize', () => {
                log('[ArcDock] click-to-minimize changed');
                this._restartDock('click-to-minimize-changed');
            });
            this._connectSignal(this._settings, 'changed::show-apps-button', () => {
                log('[ArcDock] show-apps-button changed');
                this._restartDock('show-apps-button-changed');
            });
            this._connectSignal(this._settings, 'changed::show-recent-apps', () => {
                log('[ArcDock] show-recent-apps changed');
                this._restartDock('show-recent-apps-changed');
            });
            this._connectSignal(this._settings, 'changed::magnification-enabled', () => {
                log('[ArcDock] magnification-enabled changed');
                this._restartDock('magnification-enabled-changed');
            });
            this._connectSignal(this._settings, 'changed::magnification-scale', () => {
                log('[ArcDock] magnification-scale changed');
                this._restartDock('magnification-scale-changed');
            });
            this._connectSignal(this._settings, 'changed::magnification-falloff', () => {
                log('[ArcDock] magnification-falloff changed');
                this._restartDock('magnification-falloff-changed');
            });
            this._connectSignal(this._settings, 'changed::apps-launcher-enabled', () => {
                log('[ArcDock] apps-launcher-enabled changed');
                this._restartDock('apps-launcher-enabled-changed');
            });
            this._connectSignal(this._settings, 'changed::apps-launcher-columns', () => {
                log('[ArcDock] apps-launcher-columns changed');
                this._restartDock('apps-launcher-columns-changed');
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
        // unlock-dialog rationale: declared in metadata.json session-modes
        // so the extension stays subscribed to logind's prepare-for-sleep
        // (WakeWatcher) and to Main.sessionMode 'updated' across the lock
        // screen — the dock can then reappear instantly on unlock. The
        // dock UI is destroyed when entering unlock-dialog mode (see the
        // sessionMode handler in enable()), so nothing is rendered on the
        // lock screen. disable() only runs on real teardown (logout,
        // uninstall, user toggle), never on lock.
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
            settings: this._settings,
            iconSize: this._settings?.get_int('icon-size'),
            useThemeRunningDotColor:
                this._settings?.get_boolean('running-dot-theme-color') ?? false,
            indicatorStyle:
                this._settings?.get_string('running-indicator-style') ?? 'dot',
            theme:
                this._settings?.get_string('dock-theme') ?? 'light',
            clickToMinimize:
                this._settings?.get_boolean('click-to-minimize') ?? true,
            showAppsButton:
                this._settings?.get_boolean('show-apps-button') ?? true,
            showRecentApps:
                this._settings?.get_boolean('show-recent-apps') ?? true,
            magnification: {
                enabled:
                    this._settings?.get_boolean('magnification-enabled') ?? false,
                scale:
                    this._settings?.get_double('magnification-scale') ?? 1.5,
                falloff:
                    this._settings?.get_int('magnification-falloff') ?? 150,
            },
            appsLauncher: {
                enabled:
                    this._settings?.get_boolean('apps-launcher-enabled') ?? true,
                columns:
                    this._settings?.get_int('apps-launcher-columns') ?? 7,
            },
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
