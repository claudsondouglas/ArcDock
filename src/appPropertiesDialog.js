import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ICON_EXTENSIONS = new Set(['png', 'svg', 'xpm']);
const ICON_PAGE_SIZE = 50;
const ICON_GRID_COLUMNS = 5;

function _iconFileIdentity(path) {
    let current = path;
    // Os temas usam cadeias de aliases (A -> B -> ícone real). Resolver a
    // cadeia permite agrupar a arte sem remover nenhum nome pesquisável.
    for (let depth = 0; depth < 12; depth++) {
        try {
            const target = GLib.file_read_link(current);
            current = GLib.canonicalize_filename(target, GLib.path_get_dirname(current));
        } catch (_) {
            break;
        }
    }
    return current;
}

function _iconThemeRoots() {
    return [
        GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']),
        GLib.build_filenamev([GLib.get_home_dir(), '.icons']),
        ...GLib.get_system_data_dirs().map(path => GLib.build_filenamev([path, 'icons'])),
    ];
}

function _findThemeDirectory(theme) {
    for (const root of _iconThemeRoots()) {
        const path = GLib.build_filenamev([root, theme]);
        if (Gio.File.new_for_path(path).query_exists(null))
            return path;
    }
    return null;
}

function _themeChain(theme) {
    const themes = [];
    const pending = [theme, 'hicolor'];
    while (pending.length) {
        const name = pending.shift();
        if (!name || themes.includes(name)) continue;
        themes.push(name);
        const directory = _findThemeDirectory(name);
        if (!directory) continue;
        const keyFile = new GLib.KeyFile();
        try {
            keyFile.load_from_file(GLib.build_filenamev([directory, 'index.theme']),
                GLib.KeyFileFlags.NONE);
            const inherited = keyFile.get_string('Icon Theme', 'Inherits') ?? '';
            pending.push(...inherited.split(',').map(item => item.trim()).filter(Boolean));
        } catch (_) {
            // Temas sem index válido ainda podem conter ícones utilizáveis.
        }
    }
    return themes;
}

function _collectThemeIcons(theme) {
    const icons = new Map();
    const quality = path => {
        const scalable = path.includes('/scalable/') ? 10000 : 0;
        const sizes = [...path.matchAll(/\/(\d+)(?:x\d+)?\//g)]
            .map(match => Number(match[1]));
        const context = path.includes('/apps/') ? 100 : 0;
        return scalable + context + Math.max(0, ...sizes);
    };
    const visit = (directory, candidates) => {
        let enumerator;
        try {
            enumerator = Gio.File.new_for_path(directory).enumerate_children(
                'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            return;
        }
        let info;
        while ((info = enumerator.next_file(null))) {
            const name = info.get_name();
            const path = GLib.build_filenamev([directory, name]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                visit(path, candidates);
                continue;
            }
            const dot = name.lastIndexOf('.');
            if (dot <= 0 || !ICON_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()))
                continue;
            const iconName = name.slice(0, dot);
            const current = candidates.get(iconName);
            if (!current || quality(path) > quality(current))
                candidates.set(iconName, path);
        }
        enumerator.close(null);
    };
    for (const name of _themeChain(theme)) {
        const directory = _findThemeDirectory(name);
        if (!directory) continue;
        const candidates = new Map();
        visit(directory, candidates);
        for (const [iconName, path] of candidates) {
            if (!icons.has(iconName)) icons.set(iconName, path);
        }
    }
    return [...icons].map(([name, path]) => ({
        name,
        path,
        identity: _iconFileIdentity(path),
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

const IconPickerDialog = GObject.registerClass({
    GTypeName: 'ArcDockIconPickerDialog',
}, class IconPickerDialog extends ModalDialog.ModalDialog {
    constructor(theme, icons, onSelect, onBrowse, onCancel) {
        super({ destroyOnClose: true });
        this._icons = icons;
        this._onSelect = onSelect;
        this._onCancel = onCancel;

        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'arcdock-icon-picker',
        });
        root.add_child(new St.Label({
            text: 'Escolher ícone',
            style_class: 'arcdock-properties-title',
            x_align: Clutter.ActorAlign.START,
        }));
        root.add_child(new St.Label({
            text: `Tema do sistema: ${theme}`,
            style_class: 'arcdock-icon-picker-subtitle',
            x_align: Clutter.ActorAlign.START,
        }));
        this._search = new St.Entry({
            can_focus: true,
            hint_text: 'Buscar ícones…',
            style_class: 'arcdock-icon-picker-search',
            x_expand: true,
        });
        this._search.set_primary_icon(new St.Icon({
            icon_name: 'system-search-symbolic', icon_size: 16,
        }));
        this._search.clutter_text.connect('text-changed', () => this._render());
        root.add_child(this._search);

        this._gridLayout = new Clutter.GridLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_spacing: 8,
                row_spacing: 8,
                column_homogeneous: true,
                row_homogeneous: true,
        });
        this._grid = new St.Widget({
            layout_manager: this._gridLayout,
            style_class: 'arcdock-icon-picker-grid',
            x_align: Clutter.ActorAlign.CENTER,
        });
        // ScrollView só aceita um StScrollable. A grade é um actor comum;
        // Viewport fornece os adjustments e faz a ponte entre os dois.
        const viewport = new St.Viewport({
            x_expand: true,
            y_expand: true,
            clip_to_view: true,
        });
        viewport.add_child(this._grid);
        const scroll = new St.ScrollView({
            style_class: 'arcdock-icon-picker-scroll',
            child: viewport,
            x_expand: true,
            y_expand: true,
        });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        root.add_child(scroll);
        this._status = new St.Label({
            style_class: 'arcdock-icon-picker-status',
            x_align: Clutter.ActorAlign.START,
        });
        root.add_child(this._status);
        this.contentLayout.add_child(root);

        this.setButtons([
            { label: 'Cancelar', action: () => this._cancel(), key: Clutter.KEY_Escape },
            { label: 'Escolher arquivo…', action: () => {
                this._onCancel = null;
                this.close();
                onBrowse();
            } },
        ]);
        this.setInitialKeyFocus(this._search.clutter_text);
        this._render();
    }

    _render() {
        const query = this._search.get_text().trim().toLocaleLowerCase();
        const namedMatches = this._icons.filter(icon =>
            !query || icon.name.toLocaleLowerCase().includes(query));
        const identities = new Set();
        const matches = namedMatches.filter(icon => {
            if (identities.has(icon.identity)) return false;
            identities.add(icon.identity);
            return true;
        });
        this._grid.destroy_all_children();
        for (const [index, icon] of matches.slice(0, ICON_PAGE_SIZE).entries()) {
            const button = new St.Button({
                can_focus: true,
                style_class: 'arcdock-icon-picker-item',
                child: new St.Icon({
                    gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(icon.path) }),
                    icon_size: 40,
                }),
                accessible_name: icon.name,
            });
            button.connect('clicked', () => {
                this._onCancel = null;
                const select = this._onSelect;
                this.close();
                select(icon.path);
            });
            this._gridLayout.attach(button,
                index % ICON_GRID_COLUMNS,
                Math.floor(index / ICON_GRID_COLUMNS), 1, 1);
        }
        if (!matches.length)
            this._status.text = 'Nenhum ícone encontrado';
        else if (matches.length > ICON_PAGE_SIZE)
            this._status.text = query
                ? `${matches.length} encontrados — mostrando os primeiros ${ICON_PAGE_SIZE}`
                : `${ICON_PAGE_SIZE} de ${matches.length} ícones — use a busca para ver os demais`;
        else
            this._status.text = `${matches.length} ${matches.length === 1 ? 'ícone' : 'ícones'}`;
    }

    _cancel() {
        const cancel = this._onCancel;
        this._onCancel = null;
        this.close();
        cancel?.();
    }
});

export const AppPropertiesDialog = GObject.registerClass({
    GTypeName: 'ArcDockAppPropertiesDialog',
}, class AppPropertiesDialog extends ModalDialog.ModalDialog {
    constructor() {
        super({ destroyOnClose: false });

        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'arcdock-properties',
        });

        const heading = new St.Label({
            text: 'Propriedades do aplicativo',
            style_class: 'arcdock-properties-title',
            x_align: Clutter.ActorAlign.START,
        });
        root.add_child(heading);

        const identity = new St.BoxLayout({
            style_class: 'arcdock-properties-identity',
            x_align: Clutter.ActorAlign.FILL,
        });
        this._preview = new St.Bin({ style_class: 'arcdock-properties-icon' });
        identity.add_child(this._preview);
        const identityText = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._appName = new St.Label({
            style_class: 'arcdock-properties-app-name',
            x_align: Clutter.ActorAlign.START,
        });
        identityText.add_child(this._appName);
        this._changeIconButton = new St.Button({
            label: 'Alterar ícone…',
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            style_class: 'arcdock-properties-icon-button',
        });
        this._changeIconButton.connect('clicked', () => this._chooseIcon());
        identityText.add_child(this._changeIconButton);
        identity.add_child(identityText);
        root.add_child(identity);

        root.add_child(new St.Label({
            text: 'Nome',
            style_class: 'arcdock-properties-field-label',
            x_align: Clutter.ActorAlign.START,
        }));
        this._nameEntry = new St.Entry({
            can_focus: true,
            hint_text: 'Nome exibido no Dock',
            style_class: 'arcdock-properties-entry',
            x_expand: true,
        });
        root.add_child(this._nameEntry);
        this._nameEntry.clutter_text.connect('text-changed', () =>
            this._nameEntry.remove_style_pseudo_class('error'));

        root.add_child(new St.Label({
            text: 'Informações',
            style_class: 'arcdock-properties-section-label',
            x_align: Clutter.ActorAlign.START,
        }));
        this._details = new St.BoxLayout({
            vertical: true,
            style_class: 'arcdock-properties-details',
        });
        root.add_child(this._details);
        this.contentLayout.add_child(root);

        this.setButtons([
            { label: 'Cancelar', action: () => this.close(), key: Clutter.KEY_Escape },
            { label: 'Salvar', action: () => this._save(), default: true },
        ]);
        this._nameEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(event.get_key_symbol()))
                return Clutter.EVENT_PROPAGATE;
            this._save();
            return Clutter.EVENT_STOP;
        });
        this.setInitialKeyFocus(this._nameEntry.clutter_text);
    }

    present(params, submit) {
        this._submit = typeof submit === 'function' ? submit : null;
        this._defaultIcon = params.defaultIcon ?? null;
        this._selectedIconPath = params.iconPath ?? null;
        this._nameEntry.set_text(params.name ?? '');
        this._nameEntry.clutter_text.set_selection(0, -1);
        this._appName.text = params.name || params.appId || 'Aplicativo';
        this._details.destroy_all_children();
        this._addDetail('Aplicativo', params.appId ?? 'Desconhecido');
        if (params.description)
            this._addDetail('Descrição', params.description);
        if (params.executable)
            this._addDetail('Executável', params.executable);
        this._addDetail('Estado', params.running ? '●  Em execução' : 'Fechado',
            params.running ? 'arcdock-properties-status-running' : null);
        this._addDetail('Janelas', String(params.windowCount ?? 0));
        this._updatePreview();
        this.open();
        // O Apps Launcher é acrescentado diretamente ao uiGroup depois do
        // modalDialogGroup padrão do Shell. Portanto, abrir um ModalDialog
        // não basta: o conteúdo fica no grupo certo, mas o GRUPO inteiro
        // ainda está abaixo do launcher. Elevar o grupo preserva o modal e
        // põe esta janela (e seu dimmer) acima do overlay de tela cheia.
        Main.layoutManager.uiGroup?.set_child_above_sibling(
            Main.layoutManager.modalDialogGroup, null);
    }

    _addDetail(key, value, valueClass = null) {
        const row = new St.BoxLayout({ style_class: 'arcdock-properties-detail-row' });
        row.add_child(new St.Label({
            text: key,
            style_class: 'arcdock-properties-detail-key',
            x_align: Clutter.ActorAlign.START,
        }));
        const label = new St.Label({
            text: value,
            style_class: ['arcdock-properties-detail-value', valueClass]
                .filter(Boolean).join(' '),
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        label.clutter_text.set_line_wrap(true);
        row.add_child(label);
        this._details.add_child(row);
    }

    _updatePreview() {
        let actor = null;
        if (this._selectedIconPath) {
            actor = new St.Icon({
                gicon: new Gio.FileIcon({
                    file: Gio.File.new_for_path(this._selectedIconPath),
                }),
                icon_size: 64,
            });
        } else {
            actor = this._defaultIcon?.(64) ?? new St.Icon({
                icon_name: 'application-x-executable', icon_size: 64,
            });
        }
        this._preview.set_child(actor);
    }

    _chooseIcon() {
        const settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        const theme = settings.get_string('icon-theme') || 'hicolor';
        const icons = _collectThemeIcons(theme);
        this.close();
        this._iconPicker = new IconPickerDialog(theme, icons,
            path => {
                this._selectedIconPath = path;
                this._updatePreview();
                this.open();
            },
            () => this._chooseIconFile(),
            () => this.open());
        this._iconPicker.open();
        Main.layoutManager.uiGroup?.set_child_above_sibling(
            Main.layoutManager.modalDialogGroup, null);
    }

    _chooseIconFile() {
        const bus = Gio.DBus.session;
        bus.call('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.FileChooser', 'OpenFile',
            new GLib.Variant('(ssa{sv})', ['', 'Escolher ícone', {
                multiple: new GLib.Variant('b', false),
                directory: new GLib.Variant('b', false),
            }]), new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, null,
            (_connection, result) => {
                let requestPath;
                try { [requestPath] = bus.call_finish(result).deepUnpack(); }
                catch (e) {
                    logError(e, '[ArcDock] properties icon chooser failed');
                    this.open();
                    return;
                }
                let subscription = 0;
                subscription = bus.signal_subscribe('org.freedesktop.portal.Desktop',
                    'org.freedesktop.portal.Request', 'Response', requestPath, null,
                    Gio.DBusSignalFlags.NONE,
                    (_bus, _sender, _path, _iface, _signal, value) => {
                        if (subscription) bus.signal_unsubscribe(subscription);
                        const [response, results] = value.deepUnpack();
                        if (response !== 0) {
                            this.open();
                            return;
                        }
                        const uri = results.uris?.[0];
                        const path = uri ? Gio.File.new_for_uri(uri).get_path() : null;
                        if (path) {
                            this._selectedIconPath = path;
                            this._updatePreview();
                        }
                        this.open();
                    });
            });
    }

    _save() {
        const name = this._nameEntry.get_text().trim();
        if (!name) {
            this._nameEntry.add_style_pseudo_class('error');
            this._nameEntry.grab_key_focus();
            return;
        }
        const submit = this._submit;
        this._submit = null;
        this.close();
        submit?.({ name, iconPath: this._selectedIconPath });
    }

    destroy() {
        this._submit = null;
        this._defaultIcon = null;
        super.destroy();
    }
});
