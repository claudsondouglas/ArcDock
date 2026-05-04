import GLib from 'gi://GLib';

export class SignalTracker {
    constructor() {
        this._connections = [];
    }

    connect(obj, signal, handler) {
        const id = obj.connect(signal, handler);
        this._connections.push({ obj, id });
        return id;
    }

    disconnectAll() {
        for (const { obj, id } of this._connections)
            obj.disconnect(id);
        this._connections.length = 0;
    }
}

export class TimeoutTracker {
    constructor() {
        this._ids = new Set();
    }

    add(intervalMs, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            const keep = callback();
            if (keep === GLib.SOURCE_REMOVE)
                this._ids.delete(id);
            return keep;
        });
        this._ids.add(id);
        return id;
    }

    remove(id) {
        if (this._ids.delete(id))
            GLib.source_remove(id);
    }

    removeAll() {
        for (const id of this._ids)
            GLib.source_remove(id);
        this._ids.clear();
    }
}
