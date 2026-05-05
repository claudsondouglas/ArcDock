import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import GLib from 'gi://GLib';

/**
 * Escuta o signal `prepare-for-sleep` do LoginManager interno do shell:
 * emitido com `true` antes de suspender e `false` após o resume. Chama
 * `onResume` no resume para reconciliar estado pós-suspend (forceHidden
 * travado, chrome desempilhado, monitor remontado).
 */
export class WakeWatcher {
    constructor(onResume) {
        this._onResume = onResume;
        this._loginManager = LoginManager.getLoginManager();
        this._resumeSourceIds = new Set();
        this._signalId = this._loginManager.connect(
            'prepare-for-sleep',
            (_lm, aboutToSuspend) => {
                log(`[MahoeDock] prepare-for-sleep: ${aboutToSuspend}`);
                this._scheduleResumeReconcile(aboutToSuspend);
            },
        );
    }

    _scheduleResumeReconcile(aboutToSuspend = false) {
        log(`[MahoeDock] resume reconcile scheduled from prepare-for-sleep=${aboutToSuspend}`);
        this._clearResumeTimeouts();

        if (!aboutToSuspend) {
            this._runResumeReconcile();
            this._addResumeTimeout(250);
            this._addResumeTimeout(1000);
            return;
        }

        this._addResumeTimeout(3000);
        this._addResumeTimeout(8000);
        this._addResumeTimeout(15000);
    }

    _addResumeTimeout(delayMs) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._resumeSourceIds.delete(id);
            this._runResumeReconcile();
            return GLib.SOURCE_REMOVE;
        });
        this._resumeSourceIds.add(id);
    }

    _runResumeReconcile() {
        try {
            this._onResume?.();
        } catch (e) {
            logError(e, '[MahoeDock] resume reconcile failed');
        }
    }

    _clearResumeTimeouts() {
        for (const id of this._resumeSourceIds)
            GLib.source_remove(id);
        this._resumeSourceIds.clear();
    }

    destroy() {
        this._clearResumeTimeouts();
        if (this._signalId && this._loginManager) {
            try { this._loginManager.disconnect(this._signalId); } catch (_) {}
        }
        this._signalId = 0;
        this._loginManager = null;
        this._onResume = null;
    }
}
