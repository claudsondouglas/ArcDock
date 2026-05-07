import GLib from 'gi://GLib';

const GROUP = 'Pinned';
const KEY = 'apps';

export class PinnedAppsStore {
    constructor() {
        this._path = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'arcdock',
            'pinned-apps.ini',
        ]);
        // Path legado de versões anteriores — lido apenas se o novo
        // ainda não existe, para não perder os apps fixados de quem
        // já usava a extensão antes do rename.
        this._legacyPath = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'mahoedock',
            'pinned-apps.ini',
        ]);
        this._appIds = [];
        this._load();
    }

    list() {
        return [...this._appIds];
    }

    has(appId) {
        return this._appIds.includes(appId);
    }

    toggle(appId) {
        if (this.has(appId))
            this._appIds = this._appIds.filter(id => id !== appId);
        else
            this._appIds.push(appId);
        this._save();
    }

    _load() {
        const keyFile = new GLib.KeyFile();
        const tryLoad = (path) => {
            try {
                keyFile.load_from_file(path, GLib.KeyFileFlags.NONE);
                return keyFile.get_string_list(GROUP, KEY).filter(id => id);
            } catch (_) {
                return null;
            }
        };
        const fromNew = tryLoad(this._path);
        if (fromNew !== null) {
            this._appIds = fromNew;
            return;
        }
        const fromLegacy = tryLoad(this._legacyPath);
        if (fromLegacy !== null) {
            this._appIds = fromLegacy;
            this._save();
            return;
        }
        this._appIds = [];
    }

    _save() {
        const keyFile = new GLib.KeyFile();
        keyFile.set_string_list(GROUP, KEY, this._appIds);

        const dir = GLib.path_get_dirname(this._path);
        GLib.mkdir_with_parents(dir, 0o700);

        const [data] = keyFile.to_data();
        GLib.file_set_contents(this._path, data);
    }
}
