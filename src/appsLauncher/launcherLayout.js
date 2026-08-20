import GLib from 'gi://GLib';

const KEY_ORDER = 'launcher-layout';
const KEY_FOLDERS = 'launcher-folders';

const ID_SEPARATOR = ':';

export const LauncherItemType = Object.freeze({
    APP: 'app',
    FOLDER: 'folder',
});

const KNOWN_TYPES = new Set(Object.values(LauncherItemType));

/** Nome de uma pasta recém-criada, antes de o usuário renomear. */
export const DEFAULT_FOLDER_NAME = 'Pasta';

/** makeLauncherId('app', 'firefox.desktop') -> 'app:firefox.desktop' */
export function makeLauncherId(type, value) {
    return `${type}${ID_SEPARATOR}${value}`;
}

/**
 * parseLauncherId('app:firefox.desktop') -> { type: 'app', value: 'firefox.desktop' }
 *
 * Retorna null para id malformado OU de tipo desconhecido — os dois casos
 * significam a mesma coisa para quem chama: "isto não é meu, não mexa".
 * É o que permite a regra de preservação de ids de versões futuras.
 */
export function parseLauncherId(id) {
    if (typeof id !== 'string')
        return null;
    // Split no PRIMEIRO ':' apenas, como em dockItemsStore.parseId: o value
    // é um appId (ou um uuid) e pode conter ':' à vontade.
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
 * Modelo + persistência do arranjo do launcher: a ordem escolhida pelo
 * usuário e as pastas ao estilo Launchpad. Não desenha nada.
 *
 * Duas keys, e não uma:
 *   - `launcher-layout` (`as`) é a ORDEM de ids tipados `type:value` do
 *     primeiro nível;
 *   - `launcher-folders` (`s`) é um JSON com o conteúdo das pastas.
 * JSON num `s` pelo mesmo motivo de `dock-groups`: a{sa{sv}} aninhado é
 * doloroso de manipular, e aqui o valor é uma lista dentro de um registro
 * dentro de um mapa.
 *
 * As chaves DENTRO do JSON são os uuids CRUS, sem o prefixo `folder:`. O
 * prefixo existe só onde um id precisa conviver com ids de outro tipo —
 * a lista de ordem e a API pública. Repetir o prefixo no mapa seria
 * gravá-lo em todo registro para nunca desambiguar nada, e ainda daria
 * duas grafias possíveis para a mesma pasta.
 *
 * Diferente de DockItemsStore, aqui HÁ cache em memória (`_order`,
 * `_folders`): estas duas keys não são editadas pelo prefs.js nem por
 * ninguém fora desta classe, então não existe escritor concorrente cuja
 * mudança pudesse ficar invisível. O cache é o que permite normalizar,
 * comparar com o que está gravado e só escrever quando algo mudou de fato.
 */
export class LauncherLayout {
    /** @param {Gio.Settings|null} settings */
    constructor(settings) {
        this._settings = settings ?? null;
        /** @type {string[]} ordem persistida, inclusive ids não renderizáveis. */
        this._order = [];
        /** @type {Object<string, {name: string, apps: string[]}>} por uuid CRU. */
        this._folders = {};
        /**
         * Ids efetivamente emitidos pelo último build(), na ordem em que o
         * usuário os vê. É o espaço de coordenadas de indexOf()/moveTo():
         * um app desinstalado continua ocupando uma posição em `_order` e
         * nenhuma na tela, então os dois índices divergem.
         */
        this._visible = [];
        this.reload();
    }

    /** Relê as duas keys para a memória, descartando registros malformados. */
    reload() {
        this._order = this._readOrder();
        this._folders = this._readFolders();
    }

    /**
     * Normaliza o arranjo contra os apps realmente instalados e devolve as
     * entradas a desenhar. Persiste se a normalização mudou alguma coisa.
     *
     * Ninguém escuta `changed::` nestas duas keys — e não pode passar a
     * escutar: build() roda em resposta a um app ser instalado ou removido
     * e termina gravando, então um listener devolveria essa escrita como
     * notificação e ela dispararia o rebuild que a originou. Mesmo laço de
     * `recent-apps`, mesma decisão.
     *
     * @param {Shell.App[]} installedApps já ordenados A–Z por getInstalledApps()
     * @returns {Array<Object>} entradas de app e de pasta, na ordem de exibição
     */
    build(installedApps) {
        const byId = new Map();
        for (const app of Array.isArray(installedApps) ? installedApps : []) {
            const appId = app?.get_id?.();
            if (appId)
                byId.set(appId, app);
        }

        const order = [...this._order];
        const folders = this._cloneFolders();

        // 1. Registros órfãos (uuid sem entrada na ordem) são descartados
        // ANTES de qualquer outra coisa: enquanto o registro existir, seus
        // apps contam como "dentro de uma pasta" e ficariam invisíveis para
        // sempre, numa pasta que não está em lugar nenhum.
        const referenced = new Set();
        for (const id of order) {
            const parsed = parseLauncherId(id);
            if (parsed?.type === LauncherItemType.FOLDER)
                referenced.add(parsed.value);
        }
        for (const uuid of Object.keys(folders)) {
            if (!referenced.has(uuid))
                delete folders[uuid];
        }

        // 2. Conjunto de membros calculado antes da varredura: um app que
        // está dentro de uma pasta nunca aparece também no primeiro nível,
        // e a decisão precisa valer para pastas que ainda nem foram lidas.
        const members = new Set();
        for (const record of Object.values(folders)) {
            for (const appId of record.apps)
                members.add(appId);
        }

        const entries = [];
        const visible = [];
        const nextOrder = [];
        const emitted = new Set();

        for (const id of order) {
            const parsed = parseLauncherId(id);

            // Tipo desconhecido (ou id malformado): não sabemos desenhar,
            // mas é de uma versão mais nova. Preservado VERBATIM na ordem,
            // exatamente como dockItemsStore faz — o contrário faz a versão
            // antiga apagar em silêncio os itens da nova.
            if (!parsed) {
                nextOrder.push(id);
                continue;
            }

            if (parsed.type === LauncherItemType.APP) {
                const appId = parsed.value;
                // Duplicata ou app que agora vive numa pasta: o id sai da
                // ordem. Aqui não há nada a preservar — a informação
                // continua inteira no outro lugar onde ele aparece.
                if (emitted.has(appId) || members.has(appId))
                    continue;
                emitted.add(appId);
                nextOrder.push(id);

                const app = byId.get(appId);
                // Não instalado: some da tela mas FICA na ordem. Durante uma
                // atualização o .desktop pode desaparecer por alguns
                // segundos, e descartar o id ali destruiria em silêncio o
                // arranjo que o usuário montou à mão.
                if (!app)
                    continue;
                entries.push(this._appEntry(app, appId));
                visible.push(id);
                continue;
            }

            if (parsed.type === LauncherItemType.FOLDER) {
                const record = folders[parsed.value];
                if (!record)
                    continue;

                const apps = [];
                for (const memberId of record.apps) {
                    const app = byId.get(memberId);
                    // Membro não instalado: pulado na entrada, mantido no
                    // registro. Mesmo raciocínio do app de primeiro nível.
                    if (app)
                        apps.push(this._appEntry(app, memberId));
                }

                if (apps.length === 0) {
                    // Pasta sem nada resolvível: some inteira.
                    delete folders[parsed.value];
                    continue;
                }

                if (apps.length === 1) {
                    // "Uma pasta com um app não é pasta": dissolve NA MESMA
                    // posição, virando o app que sobrou. A regra é checada em
                    // todo build e não só ao arrastar para fora, porque a
                    // pasta também encolhe quando um app é desinstalado.
                    const soloId = apps[0].appId;
                    delete folders[parsed.value];
                    if (emitted.has(soloId))
                        continue;
                    emitted.add(soloId);
                    const appId = makeLauncherId(LauncherItemType.APP, soloId);
                    nextOrder.push(appId);
                    entries.push(apps[0]);
                    visible.push(appId);
                    continue;
                }

                nextOrder.push(id);
                entries.push({
                    type: LauncherItemType.FOLDER,
                    id,
                    folderId: id,
                    name: record.name,
                    apps,
                });
                visible.push(id);
            }
        }

        // 3. Instalado e ausente de tudo: entra no fim, na ordem A–Z que
        // getInstalledApps() já entregou. No fim e não no lugar alfabético
        // porque o arranjo do usuário não é alfabético — um app novo tem que
        // aparecer sem empurrar nada do que ele arrumou.
        for (const [appId, app] of byId) {
            if (emitted.has(appId) || members.has(appId))
                continue;
            emitted.add(appId);
            const id = makeLauncherId(LauncherItemType.APP, appId);
            nextOrder.push(id);
            entries.push(this._appEntry(app, appId));
            visible.push(id);
        }

        this._visible = visible;

        // 4. Só grava o que de fato mudou: um build acontece a cada abertura
        // do launcher, e reescrever as mesmas duas keys sempre seria dconf
        // sujo de graça.
        if (!this._sameOrder(nextOrder, this._order)) {
            this._order = nextOrder;
            this._writeOrder();
        }
        const nextJson = this._serializeFolders(folders);
        if (nextJson !== this._serializeFolders(this._folders)) {
            this._folders = folders;
            this._writeFolders();
        }

        return entries;
    }

    /** Cópia da ordem persistida (inclui ids invisíveis e desconhecidos). */
    get order() {
        return [...this._order];
    }

    /**
     * Posição do id na ordem VISÍVEL — o mesmo espaço de índices que
     * moveTo() e removeFromFolder() esperam. -1 se não está visível.
     */
    indexOf(id) {
        // Antes do primeiro build() não há ordem visível; a persistida é a
        // melhor aproximação e as duas coincidem até algo ser desinstalado.
        const list = this._visible.length > 0 ? this._visible : this._order;
        return list.indexOf(id);
    }

    /**
     * Move um id existente para `index` na ordem visível.
     * @returns {boolean} houve mudança
     */
    moveTo(id, index) {
        const at = this._order.indexOf(id);
        if (at === -1)
            return false;

        const slot = this._orderSlot(index, id);
        // O slot foi calculado com o id ainda dentro do array; remover
        // primeiro deslocaria tudo à direita dele.
        const target = slot > at ? slot - 1 : slot;
        if (target === at)
            return false;

        this._order.splice(at, 1);
        this._order.splice(target, 0, id);

        const visAt = this._visible.indexOf(id);
        if (visAt !== -1) {
            this._visible.splice(visAt, 1);
            const visTarget = Math.max(0, Math.min(index, this._visible.length));
            this._visible.splice(visTarget, 0, id);
        }

        this._writeOrder();
        return true;
    }

    /**
     * Cria uma pasta com dois apps, na posição do ALVO — o ícone sobre o
     * qual o usuário soltou: foi ali que ele apontou onde a pasta deve ficar.
     * Membros na ordem [alvo, origem], pelo mesmo motivo.
     * @returns {string|null} o id prefixado da pasta, ou null se recusado
     */
    createFolder(targetAppId, sourceAppId) {
        const target = parseLauncherId(targetAppId);
        const source = parseLauncherId(sourceAppId);
        if (target?.type !== LauncherItemType.APP || source?.type !== LauncherItemType.APP)
            return null;
        if (target.value === source.value)
            return null;

        const uuid = GLib.uuid_string_random();
        const folderId = makeLauncherId(LauncherItemType.FOLDER, uuid);
        this._folders[uuid] = {
            name: DEFAULT_FOLDER_NAME,
            apps: [target.value, source.value],
        };

        const at = this._order.indexOf(targetAppId);
        if (at === -1)
            this._order.push(folderId);
        else
            this._order[at] = folderId;

        const sourceAt = this._order.indexOf(sourceAppId);
        if (sourceAt !== -1)
            this._order.splice(sourceAt, 1);

        this._replaceVisible(targetAppId, folderId);
        this._removeVisible(sourceAppId);

        this._writeOrder();
        this._writeFolders();
        return folderId;
    }

    /**
     * Põe um app no fim de uma pasta existente.
     * @returns {boolean} houve mudança
     */
    addToFolder(folderId, appId) {
        const folder = parseLauncherId(folderId);
        const app = parseLauncherId(appId);
        if (folder?.type !== LauncherItemType.FOLDER || app?.type !== LauncherItemType.APP)
            return false;

        const record = this._folders[folder.value];
        if (!record || record.apps.includes(app.value))
            return false;

        // O app pode estar vindo de OUTRA pasta. Tirar dali é obrigatório
        // (um app em duas pastas apareceria duas vezes); a pasta de origem
        // ficando com um membro só se resolve sozinha no próximo build,
        // que é onde a regra de dissolução vive.
        for (const [uuid, other] of Object.entries(this._folders)) {
            if (uuid === folder.value)
                continue;
            const memberAt = other.apps.indexOf(app.value);
            if (memberAt !== -1)
                other.apps.splice(memberAt, 1);
        }

        record.apps.push(app.value);

        const at = this._order.indexOf(appId);
        if (at !== -1)
            this._order.splice(at, 1);
        this._removeVisible(appId);

        this._writeOrder();
        this._writeFolders();
        return true;
    }

    /**
     * Tira um app da pasta e o devolve ao primeiro nível, em `insertIndex`
     * (índice na ordem visível; -1 = logo depois da pasta).
     * Se sobrarem menos de dois membros, a pasta dissolve no lugar.
     * @returns {boolean} houve mudança
     */
    removeFromFolder(folderId, appId, insertIndex = -1) {
        const folder = parseLauncherId(folderId);
        const app = parseLauncherId(appId);
        if (folder?.type !== LauncherItemType.FOLDER || app?.type !== LauncherItemType.APP)
            return false;

        const record = this._folders[folder.value];
        if (!record)
            return false;
        const memberAt = record.apps.indexOf(app.value);
        if (memberAt === -1)
            return false;
        record.apps.splice(memberAt, 1);

        // A posição da pasta é lida ANTES de inserir o app: com -1 o destino
        // é relativo a ela, e o splice seguinte já desloca tudo à direita.
        const folderAt = this._order.indexOf(folderId);
        const outId = makeLauncherId(LauncherItemType.APP, app.value);
        const slot = insertIndex >= 0
            ? this._orderSlot(insertIndex, outId)
            : (folderAt === -1 ? this._order.length : folderAt + 1);
        this._order.splice(slot, 0, outId);

        if (record.apps.length < 2) {
            delete this._folders[folder.value];
            // indexOf de novo: o splice acima pode ter empurrado a pasta.
            const at = this._order.indexOf(folderId);
            if (at !== -1) {
                if (record.apps.length === 1)
                    this._order[at] = makeLauncherId(LauncherItemType.APP, record.apps[0]);
                else
                    this._order.splice(at, 1);
            }
        }

        // A ordem visível é reconstruída pelo próximo build(): a dissolução
        // pode trocar uma pasta por um app, e reproduzir isso aqui seria
        // duplicar a normalização inteira fora dela.
        this._visible = [];

        this._writeOrder();
        this._writeFolders();
        return true;
    }

    /**
     * Renomeia a pasta. Nome só de espaços é recusado: uma pasta sem
     * rótulo nenhum vira um ícone que o usuário não consegue mais nomear.
     * @returns {boolean} houve mudança
     */
    renameFolder(folderId, name) {
        const folder = parseLauncherId(folderId);
        if (folder?.type !== LauncherItemType.FOLDER)
            return false;
        const record = this._folders[folder.value];
        if (!record)
            return false;

        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed || trimmed === record.name)
            return false;

        record.name = trimmed;
        this._writeFolders();
        return true;
    }

    /**
     * Sem sinais para desconectar: como RecentAppsHistory, esta classe não
     * escuta nada (ver o comentário de build() sobre por que não pode).
     * Só solta a referência ao Gio.Settings.
     */
    destroy() {
        this._settings = null;
        this._order = [];
        this._folders = {};
        this._visible = [];
    }

    // --- interno ---

    _appEntry(app, appId) {
        return {
            type: LauncherItemType.APP,
            id: makeLauncherId(LauncherItemType.APP, appId),
            appId,
            app,
            name: app.get_name() ?? '',
        };
    }

    /**
     * Índice na ordem persistida correspondente a `visibleIndex` na ordem
     * visível, ignorando `movingId`.
     *
     * A conversão é pela ÂNCORA (o id que ocupa o slot de destino) e não por
     * aritmética de índices: entre dois itens visíveis pode haver qualquer
     * número de ids invisíveis — apps desinstalados, itens de uma versão
     * mais nova — e só a âncora diz de que lado deles o item deve cair.
     */
    _orderSlot(visibleIndex, movingId) {
        const visible = this._visible.filter(id => id !== movingId);
        const index = Number.isFinite(visibleIndex) ? visibleIndex : visible.length;
        const clamped = Math.max(0, Math.min(index, visible.length));
        if (clamped >= visible.length)
            return this._order.length;
        const at = this._order.indexOf(visible[clamped]);
        return at === -1 ? this._order.length : at;
    }

    _replaceVisible(id, nextId) {
        const at = this._visible.indexOf(id);
        if (at !== -1)
            this._visible[at] = nextId;
    }

    _removeVisible(id) {
        const at = this._visible.indexOf(id);
        if (at !== -1)
            this._visible.splice(at, 1);
    }

    _cloneFolders() {
        const copy = {};
        for (const [uuid, record] of Object.entries(this._folders))
            copy[uuid] = { name: record.name, apps: [...record.apps] };
        return copy;
    }

    _sameOrder(a, b) {
        return a.length === b.length && a.every((id, index) => id === b[index]);
    }

    /**
     * JSON com as chaves em ordem estável — é usado para COMPARAR o mapa
     * novo com o gravado, e a ordem de iteração de um objeto não é garantia
     * suficiente para isso.
     */
    _serializeFolders(folders) {
        const sorted = {};
        for (const uuid of Object.keys(folders).sort())
            sorted[uuid] = { name: folders[uuid].name, apps: folders[uuid].apps };
        return JSON.stringify(sorted);
    }

    _readOrder() {
        if (!this._settings)
            return [];
        // Array bruto, sem filtro por tipo: ids desconhecidos precisam
        // sobreviver ao round-trip leitura -> escrita.
        return this._settings.get_strv(KEY_ORDER).filter(id => id);
    }

    _readFolders() {
        if (!this._settings)
            return {};

        let parsed = null;
        try {
            parsed = JSON.parse(this._settings.get_string(KEY_FOLDERS));
        } catch (error) {
            // JSON corrompido não pode derrubar o launcher — começa vazio.
            // console.warn e não console.log: log é filtrado abaixo de
            // notice em algumas versões, e perder justamente o aviso de
            // "seu arranjo de pastas foi descartado" é o pior caso.
            console.warn(`[ArcDock] launcher-folders inválido, ignorando: ${error}`);
            return {};
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};

        const folders = {};
        for (const [uuid, record] of Object.entries(parsed)) {
            if (!uuid || !record || typeof record !== 'object' || Array.isArray(record))
                continue;
            // Registro é validado campo a campo aqui e nunca de novo: build()
            // e os mutadores tratam `name` como string e `apps` como array de
            // strings sem checar, e é esta porta de entrada que garante isso.
            const apps = Array.isArray(record.apps)
                ? record.apps.filter(appId => typeof appId === 'string' && appId)
                : [];
            folders[uuid] = {
                name: typeof record.name === 'string' && record.name
                    ? record.name
                    : DEFAULT_FOLDER_NAME,
                apps,
            };
        }
        return folders;
    }

    _writeOrder() {
        this._settings?.set_strv(KEY_ORDER, this._order);
    }

    _writeFolders() {
        this._settings?.set_string(KEY_FOLDERS, this._serializeFolders(this._folders));
    }
}
