import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { IconButton } from './iconButton.js';
import { triggerPressBounce } from './iconAnimation.js';
import { SignalTracker } from './trackers.js';
import { ItemType, makeId } from './dockItemsStore.js';
import {
    addToArcDesk,
    isArcDeskActive,
    isOnArcDesk,
    removeFromArcDesk,
} from './arcdeskBridge.js';

// Quantos itens da pasta aparecem no menu antes do resumo "… mais N".
const MENU_ITEM_CAP = 12;
// Tamanho do lote de next_files_async: grande o bastante pra uma pasta
// comum resolver num único round-trip, pequeno o bastante pra não travar
// o loop principal formatando GFileInfos.
const ENUMERATE_BATCH = 64;
// Teto absoluto de entradas lidas. A ordenação (pastas antes, alfabética)
// exige ler a pasta inteira, e "inteira" pode significar 200k arquivos em
// ~/Downloads de alguém. Acima disto paramos e o resumo vira "mais de N".
const ENUMERATE_HARD_CAP = 512;

// Prefixo do id desta pasta na área de trabalho do ArcDesk. Escrito à mão
// e não com makeId(): o que a dock chama de `folder:` o ArcDesk chama de
// `path:` (lá `folder:` é uma pasta VIRTUAL, um agrupamento de apps que não
// existe no sistema de arquivos), então os dois nomes não podem se misturar.
const DESK_PATH_PREFIX = 'path:';

const INFO_ATTRS = 'standard::icon,standard::display-name';
const CHILD_ATTRS = [
    'standard::name',
    'standard::display-name',
    'standard::type',
    'standard::is-hidden',
].join(',');

/* Ícone de pasta do sistema de arquivos (stack, estilo macOS).
 *
 * Regra que domina o arquivo: NADA de I/O síncrono. Isto roda dentro do
 * processo do compositor — um query_info() num mount de rede morto
 * congelaria a sessão inteira. Então o ícone temático genérico aparece
 * na hora e o real chega por callback; o menu abre com placeholder e o
 * conteúdo é preenchido quando a enumeração retorna. */
export const FolderIcon = GObject.registerClass(
class FolderIcon extends IconButton {
    /** @param {string} path caminho absoluto da pasta */
    _init(path, params = {}) {
        super._init({
            id: params.id ?? makeId(ItemType.FOLDER, path),
            iconSize: params.iconSize,
            tooltipText: _basenameOf(path),
            onMenuStateChanged: params.onMenuStateChanged,
        });
        this._path = path;
        this._onRemove = params.onRemove ?? null;
        this._destroyed = false;
        // Token de geração: um callback async que voltar depois de um
        // setTarget() pertence à pasta antiga e precisa ser descartado
        // mesmo que o cancellable não tenha chegado a cancelar em tempo.
        this._targetToken = 0;
        // Dois cancellables porque os dois I/Os têm tempos de vida
        // diferentes: o do ícone morre com o alvo/objeto, o da enumeração
        // morre também quando o menu fecha (ninguém precisa do resultado
        // de uma pasta gigante depois de o usuário fechar o menu).
        this._infoCancellable = null;
        this._menuCancellable = null;
        // null = ainda não sabemos; false = pasta ilegível na última query.
        this._reachable = null;

        this._icon = new St.Icon({
            gicon: _fallbackGicon(),
            icon_size: this.iconSize,
            style_class: 'arcdock-icon-texture',
        });
        this.setIconChild(this._icon);

        this._signals = new SignalTracker();
        this._createMenu();
        this._queryInfo();
    }

    get path() {
        return this._path;
    }

    /** Reaproveita este ícone para outra pasta. */
    setTarget(path) {
        if (this._destroyed || !path)
            return;

        this._cancelInfoIo();
        this._cancelMenuIo();
        this._targetToken++;
        this._path = path;
        this.id = makeId(ItemType.FOLDER, path);
        this._reachable = null;

        // Volta ao estado "não sei nada da pasta": ícone genérico, tooltip
        // pelo basename, menu sem conteúdo velho da pasta anterior.
        this._icon.gicon = _fallbackGicon();
        this.setTooltipText(_basenameOf(path));
        this._contentSection?.removeAll();

        this._queryInfo();
    }

    // --- Ícone e nome (async) ---

    _queryInfo() {
        const token = this._targetToken;
        const cancellable = new Gio.Cancellable();
        this._infoCancellable = cancellable;

        Gio.File.new_for_path(this._path).query_info_async(
            INFO_ATTRS,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (file, res) => {
                let info = null;
                try {
                    info = file.query_info_finish(res);
                } catch (e) {
                    if (!this._isCurrentJob(token, cancellable))
                        return;
                    // Pendrive removido, pasta apagada, mount sem permissão:
                    // caso esperado, não é erro do dock. Só marca o estado
                    // pro menu explicar e mantém o ícone genérico.
                    this._reachable = false;
                    return;
                }
                if (!this._isCurrentJob(token, cancellable))
                    return;

                this._reachable = true;
                // O gicon do GIO já traz os ícones especiais (Downloads,
                // Imagens, Documentos) sem hardcode nosso.
                const gicon = info.get_icon();
                if (gicon)
                    this._icon.gicon = gicon;
                const name = info.get_display_name();
                if (name)
                    this.setTooltipText(name);
            });
    }

    // --- Menu ---

    _createMenu() {
        // Estrutura fixa criada uma vez; só a seção de conteúdo é refeita
        // a cada abertura (pasta muda — nunca cacheamos as entradas).
        this._contentSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._contentSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openItem = new PopupMenu.PopupMenuItem('Abrir pasta');
        openItem.connect('activate', () => this._openFolder());
        this.menu.addMenuItem(openItem);

        const removeItem = new PopupMenu.PopupMenuItem('Remover da dock');
        removeItem.connect('activate', () => this._onRemove?.(this));
        this.menu.addMenuItem(removeItem);

        // Rótulo e visibilidade ficam para _populateMenu(): o ArcDesk é
        // outra extensão e o usuário pode ligá-la ou desligá-la entre dois
        // cliques, então nada aqui pode ser decidido na construção.
        this._deskItem = new PopupMenu.PopupMenuItem('');
        this._deskItem.connect('activate', () => this._toggleOnDesk());
        this.menu.addMenuItem(this._deskItem);

        // Menu fechado = resultado da enumeração não interessa mais.
        this._signals.connect(this.menu, 'open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                this._cancelMenuIo();
        });
    }

    /**
     * Id desta pasta na área de trabalho, montado a cada uso e nunca
     * guardado: setTarget() reaproveita o ícone para outro caminho.
     */
    _deskId() {
        return this._path ? `${DESK_PATH_PREFIX}${this._path}` : null;
    }

    _updateDeskItem() {
        if (!this._deskItem)
            return;
        const id = this._deskId();
        // Relido a cada abertura, e não guardado: o ArcDesk pode ter sido
        // ligado ou desligado depois que este ícone nasceu, e o item viraria
        // um clique sem efeito — ou um rótulo mentiroso, se a pasta tivesse
        // sido tirada da área de trabalho por lá.
        this._deskItem.actor.visible = !!id && isArcDeskActive();
        this._deskItem.label.text = id && isOnArcDesk(id)
            ? 'Remover da área de trabalho'
            : 'Adicionar à área de trabalho';
    }

    _toggleOnDesk() {
        const id = this._deskId();
        if (!id)
            return;
        if (isOnArcDesk(id))
            removeFromArcDesk(id);
        else
            addToArcDesk(id);
    }

    /* Chamado pela base imediatamente antes de menu.toggle(), então é
     * obrigatoriamente síncrono: entra placeholder e a enumeração real
     * corre por fora, preenchendo a seção quando (e se) voltar. */
    _populateMenu() {
        this._updateDeskItem();
        this._cancelMenuIo();
        this._contentSection.removeAll();
        this._contentSection.addMenuItem(
            _disabledItem(this._reachable === false ? 'Pasta não encontrada' : 'Carregando…'));

        const cancellable = new Gio.Cancellable();
        this._menuCancellable = cancellable;
        this._enumerate(this._targetToken, cancellable);
    }

    _enumerate(token, cancellable) {
        Gio.File.new_for_path(this._path).enumerate_children_async(
            CHILD_ATTRS,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (file, res) => {
                let enumerator = null;
                try {
                    enumerator = file.enumerate_children_finish(res);
                } catch (e) {
                    this._onEnumerateError(e, token, cancellable);
                    return;
                }
                if (!this._isCurrentMenuJob(token, cancellable)) {
                    _closeEnumerator(enumerator);
                    return;
                }
                this._readBatch(enumerator, token, cancellable, []);
            });
    }

    _readBatch(enumerator, token, cancellable, entries) {
        enumerator.next_files_async(
            ENUMERATE_BATCH,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, res) => {
                let infos = [];
                try {
                    infos = source.next_files_finish(res);
                } catch (e) {
                    _closeEnumerator(source);
                    this._onEnumerateError(e, token, cancellable);
                    return;
                }
                if (!this._isCurrentMenuJob(token, cancellable)) {
                    _closeEnumerator(source);
                    return;
                }

                for (const info of infos) {
                    if (info.get_is_hidden())
                        continue;
                    entries.push({
                        name: info.get_display_name() || info.get_name(),
                        isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
                        // get_uri() do GFile: nunca concatenar 'file://' +
                        // path, que quebra com espaço e acento.
                        uri: source.get_child(info).get_uri(),
                    });
                }

                const done = infos.length === 0;
                const truncated = !done && entries.length >= ENUMERATE_HARD_CAP;
                if (!done && !truncated) {
                    this._readBatch(source, token, cancellable, entries);
                    return;
                }
                _closeEnumerator(source);
                this._reachable = true;
                this._fillContent(entries, truncated);
            });
    }

    _fillContent(entries, truncated) {
        entries.sort((a, b) => {
            if (a.isDir !== b.isDir)
                return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        this._contentSection.removeAll();
        if (!entries.length) {
            this._contentSection.addMenuItem(_disabledItem('Pasta vazia'));
            return;
        }

        for (const entry of entries.slice(0, MENU_ITEM_CAP)) {
            const item = new PopupMenu.PopupMenuItem(entry.name);
            item.connect('activate', () => _launchUri(entry.uri));
            this._contentSection.addMenuItem(item);
        }

        const extra = entries.length - MENU_ITEM_CAP;
        if (extra > 0) {
            const noun = extra === 1 ? 'item' : 'itens';
            this._contentSection.addMenuItem(_disabledItem(
                truncated ? `… mais de ${extra} ${noun}` : `… mais ${extra} ${noun}`));
        }
    }

    _onEnumerateError(error, token, cancellable) {
        if (!this._isCurrentMenuJob(token, cancellable))
            return;
        this._reachable = false;
        this._contentSection.removeAll();
        this._contentSection.addMenuItem(_disabledItem(_errorLabel(error)));
    }

    // --- Ações ---

    _onPrimaryActivate() {
        triggerPressBounce(this);
        this._openFolder();
    }

    _openFolder() {
        _launchUri(Gio.File.new_for_path(this._path).get_uri());
    }

    // --- Validade / cleanup ---

    /** Objeto vivo, mesma pasta e I/O não cancelado. */
    _isCurrentJob(token, cancellable) {
        return !this._destroyed
            && token === this._targetToken
            && !cancellable.is_cancelled();
    }

    _isCurrentMenuJob(token, cancellable) {
        return this._isCurrentJob(token, cancellable)
            && this._menuCancellable === cancellable
            && !!this._contentSection;
    }

    _cancelInfoIo() {
        // Cancellable não se reusa depois de cancelado — quem precisa de
        // um novo I/O cria outro.
        this._infoCancellable?.cancel();
        this._infoCancellable = null;
    }

    _cancelMenuIo() {
        this._menuCancellable?.cancel();
        this._menuCancellable = null;
    }

    destroy() {
        this._destroyed = true;
        this._cancelInfoIo();
        this._cancelMenuIo();
        this._signals?.disconnectAll();
        this._signals = null;
        this._contentSection = null;
        this._icon = null;
        this._onRemove = null;
        super.destroy();
    }
});

function _basenameOf(path) {
    return Gio.File.new_for_path(path).get_basename() || path;
}

function _fallbackGicon() {
    // Único lugar onde 'folder' é hardcoded: placeholder até o gicon real
    // chegar, e rede de segurança para pasta ilegível.
    return new Gio.ThemedIcon({ name: 'folder' });
}

function _disabledItem(text) {
    const item = new PopupMenu.PopupMenuItem(text, {
        reactive: false,
        activate: false,
        hover: false,
        can_focus: false,
    });
    item.setSensitive(false);
    return item;
}

function _errorLabel(error) {
    if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
        return 'Pasta não encontrada';
    if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
        return 'Sem permissão de acesso';
    if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_DIRECTORY))
        return 'Não é uma pasta';
    return 'Não foi possível ler a pasta';
}

function _launchUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        // Sem handler padrão pro tipo do arquivo não é falha do dock.
        console.warn(`[ArcDock] não foi possível abrir ${uri}: ${e.message}`);
    }
}

function _closeEnumerator(enumerator) {
    // Fecha sem cancellable: o close nunca deve ser abortado junto com a
    // enumeração, senão o fd fica aberto até o GC.
    enumerator?.close_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
        try {
            source.close_finish(res);
        } catch (_) {}
    });
}
