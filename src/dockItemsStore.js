import GLib from 'gi://GLib';

import { SignalTracker } from './trackers.js';

const KEY_ITEMS = 'dock-items';
const KEY_GROUPS = 'dock-groups';
const KEY_MIGRATED = 'dock-items-migrated';

// Formato legado (INI) lido apenas na migração one-shot.
const LEGACY_GROUP = 'Pinned';
const LEGACY_KEY = 'apps';

const ID_SEPARATOR = ':';

export const ItemType = Object.freeze({
    APP: 'app',
    FOLDER: 'folder',
    GROUP: 'group',
});

const KNOWN_TYPES = new Set(Object.values(ItemType));

/** makeId('folder', '/home/u/Downloads') -> 'folder:/home/u/Downloads' */
export function makeId(type, value) {
    return `${type}${ID_SEPARATOR}${value}`;
}

/**
 * parseId('folder:/home/u/Downloads') -> { type: 'folder', value: '/home/u/Downloads' }
 * Retorna null se malformado ou se o type não estiver em ItemType.
 */
export function parseId(id) {
    if (typeof id !== 'string')
        return null;
    // Split no PRIMEIRO ':' apenas: o value é um caminho de arquivo ou um
    // appId e pode conter ':' à vontade.
    const sep = id.indexOf(ID_SEPARATOR);
    if (sep <= 0)
        return null;
    const type = id.slice(0, sep);
    const value = id.slice(sep + 1);
    if (!value || !KNOWN_TYPES.has(type))
        return null;
    return { type, value };
}

/**
 * Lista ORDENADA de ids tipados da dock, persistida em GSettings.
 *
 * GSettings (e não o INI antigo) porque prefs.js roda em outro processo:
 * o sinal `changed::` chega nas duas direções de graça, sem GFileMonitor.
 * Não há cache interno — o GSettings é a única fonte de verdade, então
 * uma escrita feita pelas preferências nunca fica invisível aqui.
 */
export class DockItemsStore {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._signals = new SignalTracker();
        // Única escrita permitida na construção: a migração one-shot.
        this._migrateLegacy();
    }

    list() {
        return this._read();
    }

    has(id) {
        return this._read().includes(id);
    }

    /** index omitido ou -1 = append. No-op se já existe. */
    add(id, index = -1) {
        if (typeof id !== 'string' || !id)
            return;
        const items = this._read();
        if (items.includes(id))
            return;
        if (index === undefined || index === null || index < 0 || index >= items.length)
            items.push(id);
        else
            items.splice(index, 0, id);
        this._write(items);
    }

    remove(id) {
        const items = this._read();
        const at = items.indexOf(id);
        if (at === -1)
            return;
        items.splice(at, 1);
        this._write(items);
    }

    /** Reposiciona um id já existente. No-op se não existe. */
    move(id, index) {
        const items = this._read();
        const at = items.indexOf(id);
        if (at === -1)
            return;
        items.splice(at, 1);
        if (index === undefined || index === null || index < 0 || index >= items.length)
            items.push(id);
        else
            items.splice(index, 0, id);
        this._write(items);
    }

    /** Substitui a lista ordenada inteira. */
    setAll(ids) {
        const next = [];
        for (const id of Array.isArray(ids) ? ids : []) {
            if (typeof id === 'string' && id && !next.includes(id))
                next.push(id);
        }
        // Compatibilidade com versões futuras: list() devolve o array bruto
        // (sem filtrar por tipo), então um round-trip list() -> setAll() já
        // preserva ids de tipo desconhecido. Este bloco cobre o outro caso:
        // quem chama filtrou a lista pelos tipos que conhece e deixou os
        // desconhecidos de fora — eles voltam no fim em vez de sumirem.
        const orphans = this._read().filter(id => parseId(id) === null && !next.includes(id));
        this._write([...next, ...orphans]);
    }

    /** add se ausente, remove se presente. */
    toggle(id) {
        if (this.has(id))
            this.remove(id);
        else
            this.add(id);
    }

    // --- Grupos de apps: acessores JSON finos sobre 'dock-groups'. ---
    // JSON num `s` porque a{sa{sv}} aninhado no GSettings é doloroso de
    // manipular dos dois lados. Nenhuma lógica de grupo vive aqui.

    /** -> { [groupId]: { name: string, apps: string[] } } */
    getGroups() {
        if (!this._settings)
            return {};
        try {
            const parsed = JSON.parse(this._settings.get_string(KEY_GROUPS));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return {};
            return parsed;
        } catch (_) {
            // JSON corrompido não deve derrubar a dock: começa vazio.
            return {};
        }
    }

    /** @param {{ name: string, apps: string[] }} group */
    setGroup(groupId, group) {
        if (!this._settings || typeof groupId !== 'string' || !groupId)
            return;
        const groups = this.getGroups();
        groups[groupId] = {
            name: typeof group?.name === 'string' ? group.name : '',
            apps: Array.isArray(group?.apps) ? [...group.apps] : [],
        };
        this._writeGroups(groups);
    }

    removeGroup(groupId) {
        if (!this._settings)
            return;
        const groups = this.getGroups();
        if (!Object.prototype.hasOwnProperty.call(groups, groupId))
            return;
        delete groups[groupId];
        this._writeGroups(groups);
    }

    /**
     * Inscreve callback para mudanças (inclusive de outro processo, ex: prefs).
     * @returns {() => void} unsubscribe
     */
    onChanged(callback) {
        if (!this._settings || typeof callback !== 'function')
            return () => {};
        const ids = [
            this._signals.connect(this._settings, `changed::${KEY_ITEMS}`, () => callback()),
            this._signals.connect(this._settings, `changed::${KEY_GROUPS}`, () => callback()),
        ];
        let unsubscribed = false;
        return () => {
            if (unsubscribed)
                return;
            unsubscribed = true;
            // Desconecta só estes handlers. As entradas ficam no tracker, mas
            // disconnectAll() pula handlers já desconectados, então destroy()
            // continua seguro.
            for (const id of ids) {
                try {
                    if (this._settings?.signal_handler_is_connected(id))
                        this._settings.disconnect(id);
                } catch (_) {}
            }
        };
    }

    destroy() {
        this._signals?.disconnectAll();
        this._signals = null;
        this._settings = null;
    }

    _read() {
        if (!this._settings)
            return [];
        // Array bruto, sem filtro de tipo — ver comentário em setAll().
        return this._settings.get_strv(KEY_ITEMS).filter(id => id);
    }

    _write(ids) {
        this._settings?.set_strv(KEY_ITEMS, ids);
    }

    _writeGroups(groups) {
        this._settings?.set_string(KEY_GROUPS, JSON.stringify(groups));
    }

    /**
     * Migração one-shot do INI legado (~/.config/arcdock/pinned-apps.ini e,
     * antes do rename, ~/.config/mahoedock/).
     *
     * A flag `dock-items-migrated` é gravada SEMPRE, mesmo sem nada para
     * migrar: usar "lista vazia" como sinal de "não migrado" faria os apps
     * antigos ressuscitarem para quem esvaziou a dock de propósito.
     */
    _migrateLegacy() {
        if (this._settings.get_boolean(KEY_MIGRATED))
            return;

        const appIds = this._readLegacyIni();
        if (appIds.length > 0)
            this._write(appIds.map(appId => makeId(ItemType.APP, appId)));

        this._settings.set_boolean(KEY_MIGRATED, true);
    }

    _readLegacyIni() {
        const paths = [
            GLib.build_filenamev([GLib.get_user_config_dir(), 'arcdock', 'pinned-apps.ini']),
            GLib.build_filenamev([GLib.get_user_config_dir(), 'mahoedock', 'pinned-apps.ini']),
        ];
        for (const path of paths) {
            try {
                const keyFile = new GLib.KeyFile();
                keyFile.load_from_file(path, GLib.KeyFileFlags.NONE);
                return keyFile.get_string_list(LEGACY_GROUP, LEGACY_KEY).filter(id => id);
            } catch (_) {
                // Arquivo ausente ou grupo/key inexistente: tenta o próximo.
            }
        }
        return [];
    }
}
