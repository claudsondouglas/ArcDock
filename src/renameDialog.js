import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export const RenameDialog = GObject.registerClass({
    GTypeName: 'ArcDockRenameDialog',
},
class RenameDialog extends ModalDialog.ModalDialog {
    constructor() {
        super({ destroyOnClose: false });
        const box = new St.BoxLayout({ vertical: true });
        box.add_child(new St.Label({ text: 'Renomear atalho' }));
        this._entry = new St.Entry({ can_focus: true });
        box.add_child(this._entry);
        this.contentLayout.add_child(box);
        this.setButtons([
            { label: 'Cancelar', action: () => this.close(), key: Clutter.KEY_Escape },
            { label: 'Renomear', action: () => this._accept(), default: true },
        ]);
        this._entry.clutter_text.connect('key-press-event', (_actor, event) => {
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(event.get_key_symbol()))
                return Clutter.EVENT_PROPAGATE;
            this._accept();
            return Clutter.EVENT_STOP;
        });
        this.setInitialKeyFocus(this._entry.clutter_text);
    }

    present(name, submit) {
        this._submit = submit;
        this._entry.set_text(name ?? '');
        this._entry.clutter_text.set_selection(0, -1);
        this.open();
    }

    _accept() {
        const name = this._entry.get_text().trim();
        if (!name) return;
        const submit = this._submit;
        this._submit = null;
        this.close();
        submit?.(name);
    }
});
