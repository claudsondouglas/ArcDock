import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SignalTracker } from './trackers.js';

// Mapeia notificações do MessageTray para app ids, expondo
// hasAttention(appId) para os ícones do dock. Substitui (na prática
// complementa) o `demands-attention` da janela, que apps Electron como
// Discord/Slack não setam de forma confiável no Wayland.
export class AttentionTracker {
    constructor() {
        this._sources = new Map(); // source -> { tracker: SignalTracker, appId }
        this._listeners = new Set();
        this._signals = new SignalTracker();

        const tray = Main.messageTray;
        if (tray) {
            this._signals.connect(tray, 'source-added', (_t, src) => this._onSourceAdded(src));
            this._signals.connect(tray, 'source-removed', (_t, src) => this._onSourceRemoved(src));
            const existing = tray.getSources?.() ?? [];
            for (const src of existing)
                this._onSourceAdded(src);
        }
    }

    addListener(fn) {
        this._listeners.add(fn);
    }

    removeListener(fn) {
        this._listeners.delete(fn);
    }

    hasAttention(appOrId) {
        if (!appOrId) return false;
        for (const { appId: srcAppId, source } of this._sources.values()) {
            if (!this._sourceMatchesApp(source, srcAppId, appOrId)) continue;
            if (this._sourceCount(source) > 0) return true;
        }
        return false;
    }

    _sourceCount(source) {
        const counts = [
            source.notifications?.length,
            source.count,
            source.unseenCount,
            source._count,
            source._unseenCount,
        ].filter(v => typeof v === 'number');
        return counts.length ? Math.max(...counts) : 0;
    }

    _appIdFor(source) {
        const direct = source.app?.get_id?.();
        if (direct) return direct;
        const pid = source.pid ?? source._pid;
        if (pid) {
            const app = Shell.WindowTracker.get_default().get_app_from_pid?.(pid);
            if (app?.get_id) return app.get_id();
        }
        return null;
    }

    _sourceMatchesApp(source, sourceAppId, appOrId) {
        const appId = typeof appOrId === 'string'
            ? appOrId
            : appOrId.get_id?.();
        if (sourceAppId && appId && sourceAppId === appId)
            return true;

        const sourceLabels = this._sourceLabels(source, sourceAppId);
        const appLabels = this._appLabels(appOrId);
        for (const sourceLabel of sourceLabels) {
            for (const appLabel of appLabels) {
                if (sourceLabel === appLabel)
                    return true;
            }
        }
        return false;
    }

    _sourceLabels(source, sourceAppId) {
        return [
            sourceAppId,
            source.title,
            source.name,
            source.appName,
            source._title,
            source._name,
            source._appName,
            source.app?.get_name?.(),
            source.app?.get_id?.(),
        ].map(label => this._normalizeLabel(label)).filter(label => label);
    }

    _appLabels(appOrId) {
        if (typeof appOrId === 'string')
            return [this._normalizeLabel(appOrId)];

        return [
            appOrId.get_id?.(),
            appOrId.get_name?.(),
        ].map(label => this._normalizeLabel(label)).filter(label => label);
    }

    _normalizeLabel(label) {
        if (!label) return null;
        return String(label)
            .toLowerCase()
            .replace(/\.desktop$/, '')
            .replace(/-/g, ' ')
            .trim();
    }

    _onSourceAdded(source) {
        if (this._sources.has(source)) return;
        const tracker = new SignalTracker();
        const entry = { tracker, source, appId: this._appIdFor(source) };
        this._sources.set(source, entry);

        const update = () => {
            entry.appId = this._appIdFor(source) ?? entry.appId;
            this._notify();
        };
        // GNOME Shell varia entre versões — conectamos defensivamente a
        // todos os signals plausíveis. SignalTracker.connect já lança se
        // o signal não existir, então embrulhamos cada um.
        const safeConnect = (sig) => {
            try { tracker.connect(source, sig, update); } catch (_) {}
        };
        safeConnect('notification-added');
        safeConnect('notification-removed');
        safeConnect('count-updated');
        safeConnect('notify::count');
        safeConnect('notify::title');

        try {
            tracker.connect(source, 'destroy', () => this._onSourceRemoved(source));
        } catch (_) {}

        this._notify();
    }

    _onSourceRemoved(source) {
        const entry = this._sources.get(source);
        if (!entry) return;
        entry.tracker.disconnectAll();
        this._sources.delete(source);
        this._notify();
    }

    _notify() {
        for (const fn of this._listeners) {
            try { fn(); } catch (_) {}
        }
    }

    destroy() {
        this._signals.disconnectAll();
        for (const { tracker } of this._sources.values())
            tracker.disconnectAll();
        this._sources.clear();
        this._listeners.clear();
    }
}
