import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const ARCDESK_UUID = 'ArcDesk@claudson';
// Contrato PÚBLICO do ArcDesk (ver a description da key no gschema dele):
// lista ordenada de ids tipados, `app:firefox.desktop` / `path:/home/u/x`.
// Basta acrescentar o id — quem escolhe a casa livre é o ArcDesk.
const KEY_DESK_ITEMS = 'desk-items';
const KEY_ITEM_NAMES = 'desk-item-names';
const KEY_ITEM_ICONS = 'desk-item-icons';

/* Ponte para a extensão irmã ArcDesk.
 *
 * Uma extensão falando com outra tem três armadilhas, e as três estão
 * resolvidas aqui — nenhum chamador precisa saber delas:
 *
 * 1. PRESENÇA é `state === ACTIVE`, nunca "o objeto existe". O Shell não
 *    consegue reimportar um módulo ESM, então uma extensão que foi ligada
 *    uma vez guarda o `stateObj` PARA SEMPRE, mesmo depois de desligada —
 *    `Extension.lookupByUUID(uuid) !== null` continuaria verdadeiro com o
 *    ArcDesk desligado, e o menu ofereceria "adicionar à área de trabalho"
 *    para uma área de trabalho que não está desenhada em lugar nenhum.
 *
 * 2. NADA é cacheado, nem o stateObj nem o Gio.Settings. O
 *    `_callExtensionDisableWithRebase()` do gerenciador derruba e remonta
 *    toda extensão ordenada DEPOIS da que está sendo ligada/desligada, e
 *    faz isso sem avisar ninguém: uma referência guardada entre duas
 *    chamadas apontaria para um objeto já destruído. Cada função reconsulta.
 *
 * 3. NUNCA a partir do `enable()` da dock. A ordem de carga do Shell é
 *    pela quantidade de session-modes, e o `["user","unlock-dialog"]` do
 *    ArcDock o coloca ANTES do `["user"]` do ArcDesk — no nosso enable() o
 *    ArcDesk ainda não está de pé e a resposta seria um "não existe"
 *    falso. Tudo aqui é chamado só a partir de ação do usuário (abrir um
 *    menu, clicar num item).
 *
 * Não há código de notificação: o GSettings entrega `changed::` a TODA
 * instância ligada ao schema, inclusive dentro do mesmo processo, então o
 * ArcDesk vê a escrita na hora, de graça. */

/** O ArcDesk está realmente de pé nesta sessão? */
export function isArcDeskActive() {
    try {
        return Main.extensionManager?.lookup(ARCDESK_UUID)?.state
            === ExtensionState.ACTIVE;
    } catch (e) {
        logError(e, '[ArcDock] verificação de presença do ArcDesk falhou');
        return false;
    }
}

/** @param {string} id id tipado, já no formato `app:…` ou `path:…` */
export function isOnArcDesk(id) {
    try {
        const settings = _deskSettings();
        if (!settings || !_isValidId(id))
            return false;
        return settings.get_strv(KEY_DESK_ITEMS).includes(id);
    } catch (e) {
        logError(e, '[ArcDock] leitura de desk-items falhou');
        return false;
    }
}

/**
 * Acrescenta o id à área de trabalho. Idempotente: adicionar duas vezes é
 * no-op e devolve true.
 *
 * @param {string} id id tipado, já no formato `app:…` ou `path:…`
 * @returns {boolean} a área de trabalho contém o id ao fim da chamada
 */
export function addToArcDesk(id) {
    try {
        const settings = _deskSettings();
        if (!settings || !_isValidId(id))
            return false;
        // Ler-modificar-escrever num ÚNICO turno síncrono: sem await no
        // meio, nada do Shell roda entre o get_strv e o set_strv, então
        // não há como perder uma escrita alheia feita nesse intervalo.
        const items = settings.get_strv(KEY_DESK_ITEMS);
        if (items.includes(id))
            return true;
        items.push(id);
        settings.set_strv(KEY_DESK_ITEMS, items);
        return true;
    } catch (e) {
        logError(e, '[ArcDock] escrita em desk-items falhou');
        return false;
    }
}

/**
 * Tira o id da área de trabalho. Idempotente: remover o que não está lá é
 * no-op e devolve true.
 *
 * @param {string} id id tipado, já no formato `app:…` ou `path:…`
 * @returns {boolean} a área de trabalho não contém o id ao fim da chamada
 */
export function removeFromArcDesk(id) {
    try {
        const settings = _deskSettings();
        if (!settings || !_isValidId(id))
            return false;
        const items = settings.get_strv(KEY_DESK_ITEMS);
        const index = items.indexOf(id);
        if (index === -1)
            return true;
        items.splice(index, 1);
        settings.set_strv(KEY_DESK_ITEMS, items);
        return true;
    } catch (e) {
        logError(e, '[ArcDock] escrita em desk-items falhou');
        return false;
    }
}

/** Aparência compartilhada do atalho, mesmo quando ele ainda não está no desktop. */
export function getArcDeskAppearance(id) {
    const settings = _deskSettings();
    if (!settings || !_isValidId(id)) return { name: null, icon: null };
    return {
        name: _readMap(settings, KEY_ITEM_NAMES)[id] ?? null,
        icon: _readMap(settings, KEY_ITEM_ICONS)[id] ?? null,
    };
}

export function setArcDeskName(id, name) {
    const value = typeof name === 'string' ? name.trim() : '';
    return value ? _setMapValue(KEY_ITEM_NAMES, id, value) : false;
}

export function setArcDeskIcon(id, path) {
    const value = typeof path === 'string' ? path.trim() : '';
    return value ? _setMapValue(KEY_ITEM_ICONS, id, value) : false;
}

/** Assina alterações externas de aparência; devolve uma função de limpeza. */
export function watchArcDeskAppearance(callback) {
    if (typeof callback !== 'function') return () => {};
    let settings = null;
    let ids = [];
    const disconnectSettings = () => {
        for (const id of ids) {
            try { settings?.disconnect(id); } catch (_) {}
        }
        ids = [];
        settings = null;
    };
    const reconnect = () => {
        disconnectSettings();
        settings = _deskSettings();
        if (settings) {
            ids = [KEY_ITEM_NAMES, KEY_ITEM_ICONS].map(key =>
                settings.connect(`changed::${key}`, callback));
            callback();
        }
    };
    reconnect();
    let managerId = 0;
    try {
        managerId = Main.extensionManager?.connect('extension-state-changed', reconnect) ?? 0;
    } catch (_) {}
    return () => {
        disconnectSettings();
        if (managerId) {
            try { Main.extensionManager.disconnect(managerId); } catch (_) {}
            managerId = 0;
        }
    };
}

/**
 * Gio.Settings do ArcDesk, ou null se ele não estiver ativo.
 *
 * Pelo `Extension.lookupByUUID(...).getSettings()` e não por um
 * `Gio.SettingsSchemaSource` montado à mão: é o próprio ArcDesk quem
 * resolve o diretório de schemas dele, então a dock não precisa saber onde
 * o arquivo compilado mora — nem quebrar se ele for instalado noutro
 * prefixo. Nunca guardado: ver o item 2 do cabeçalho.
 */
function _deskSettings() {
    if (!isArcDeskActive())
        return null;
    return Extension.lookupByUUID(ARCDESK_UUID)?.getSettings() ?? null;
}

function _isValidId(id) {
    return typeof id === 'string' && id.length > 0;
}

function _readMap(settings, key) {
    try {
        const value = JSON.parse(settings.get_string(key));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}

function _setMapValue(key, id, value) {
    try {
        const settings = _deskSettings();
        if (!settings || !_isValidId(id)) return false;
        const map = _readMap(settings, key);
        if (map[id] === value) return true;
        map[id] = value;
        const sorted = {};
        for (const itemId of Object.keys(map).sort()) sorted[itemId] = map[itemId];
        settings.set_string(key, JSON.stringify(sorted));
        return true;
    } catch (e) {
        logError(e, `[ArcDock] escrita em ${key} falhou`);
        return false;
    }
}
