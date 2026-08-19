import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {
    NO_MATCH,
    SEARCH,
    charMask,
    makeFields,
    normalizeText,
    scoreFields,
    scoreFieldsWithTypo,
} from './fuzzyMatch.js';

/**
 * Cache dos campos já normalizados, chaveado pelo próprio Shell.App.
 *
 * WeakMap e não Map: filterApps() roda a cada tecla e normalizar os campos
 * (nome, nome genérico, descrição, keywords) de algumas centenas de apps por
 * tecla é trabalho puramente repetido. O WeakMap não segura referência forte,
 * então um app desinstalado morre junto com o Shell.App que o representava —
 * sem escuta de `installed-changed`, sem lifecycle e sem destroy(), que este
 * módulo (funções soltas, sem dono) não teria onde colocar.
 *
 * O valor é o objeto de makeFields(): além do nome e dos metadados
 * normalizados ele carrega o vetor de inícios de palavra e as máscaras de
 * caractere, que são exatamente o que a pontuação difusa consulta no laço
 * quente. Tudo isso é calculado UMA vez por app, aqui.
 *
 * @type {WeakMap<Shell.App, ReturnType<typeof makeFields>>}
 */
const fieldsCache = new WeakMap();

/**
 * Todos os apps instalados que devem aparecer para o usuário, ordenados
 * A–Z pela locale corrente.
 * @returns {Shell.App[]}
 */
export function getInstalledApps() {
    const appSystem = Shell.AppSystem.get_default();
    const apps = [];

    for (const appInfo of appSystem.get_installed()) {
        // should_show() cobre NoDisplay, Hidden e OnlyShowIn/NotShowIn de uma
        // vez — é o mesmo critério que o overview do Shell usa.
        if (!appInfo.should_show())
            continue;
        const id = appInfo.get_id();
        if (!id)
            continue;
        // Um .desktop malformado aparece em get_installed() mas não vira
        // Shell.App; sem isso o launcher receberia null na lista.
        const app = appSystem.lookup_app(id);
        if (app)
            apps.push(app);
    }

    // Colação de locale, nunca `<`/`>` de string crua: em pt-BR a comparação
    // por code point manda "Álbum" para depois de "Zoom".
    apps.sort((a, b) => GLib.utf8_collate(_name(a), _name(b)));
    return apps;
}

/**
 * Subconjunto de `apps` que casa com `query`, do melhor para o pior
 * casamento. Query vazia/só espaços devolve `apps` inalterado (mesma
 * referência é aceitável).
 * @param {Shell.App[]} apps
 * @param {string} query
 * @returns {Shell.App[]}
 */
export function filterApps(apps, query) {
    if (!Array.isArray(apps))
        return [];

    const needle = normalizeText(query).trim();
    if (!needle)
        return apps;

    // Uma vez por tecla, nunca por app: a máscara da query é constante
    // durante a varredura inteira.
    const needleMask = charMask(needle);

    const matches = [];
    for (let index = 0; index < apps.length; index++) {
        const app = apps[index];
        if (!app)
            continue;
        const score = scoreFields(needle, needleMask, _fieldsOf(app));
        if (score === NO_MATCH)
            continue;
        // Guarda o índice de entrada para desempatar: com a mesma pontuação o
        // resultado tem que manter o A–Z que getInstalledApps() já produziu.
        matches.push({ app, score, index });
    }

    // Passada tolerante a erro de digitação: SÓ quando a busca exata não
    // achou nada. Enquanto houver qualquer resultado, o custo dela é zero —
    // e o usuário que digitou certo nunca paga pelo usuário que digitou
    // errado, o que é o ponto de fazer disso um último recurso.
    if (matches.length === 0 &&
        needle.length >= SEARCH.TYPO_MIN_QUERY &&
        needle.length <= SEARCH.TYPO_MAX_QUERY) {
        for (let index = 0; index < apps.length; index++) {
            const app = apps[index];
            if (!app)
                continue;
            const score = scoreFieldsWithTypo(needle, needleMask, _fieldsOf(app));
            if (score === NO_MATCH)
                continue;
            matches.push({ app, score, index });
        }
    }

    // Ordena por [pontuação desc, índice original] em vez de confiar na
    // estabilidade do sort: ela é garantida pela spec, mas o desempate
    // explícito é o que documenta a intenção aqui.
    matches.sort((a, b) => b.score - a.score || a.index - b.index);
    return matches.map(match => match.app);
}

/** Nome do app como string, nunca null (get_name() pode falhar no .desktop). */
function _name(app) {
    const name = app?.get_name();
    return typeof name === 'string' ? name : '';
}

/**
 * Campos normalizados do app, do cache quando possível.
 *
 * O nome cru fica guardado junto e é revalidado a cada consulta: um .desktop
 * editado no disco pode mudar o nome sem que o Shell.App seja recriado, e
 * uma comparação de string é ordens de grandeza mais barata do que as
 * normalizações, as máscaras e o vetor de inícios de palavra que ela evita.
 */
function _fieldsOf(app) {
    const rawName = _name(app);
    const cached = fieldsCache.get(app);
    if (cached && cached.rawName === rawName)
        return cached;

    // Pode ser null em apps que só existem por causa de uma janela aberta,
    // sem .desktop por trás.
    const appInfo = app.get_app_info?.() ?? null;
    const metadata = [
        appInfo?.get_generic_name(),
        appInfo?.get_description(),
        // get_keywords() devolve null quando a chave Keywords não existe.
        ...(appInfo?.get_keywords() ?? []),
    ]
        .filter(part => typeof part === 'string' && part)
        .join(' ');

    const fields = makeFields(rawName, metadata);
    fieldsCache.set(app, fields);
    return fields;
}
