import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/**
 * Uma action do .desktop que já É "abrir uma janela nova".
 *
 * O nome da action é livre, mas na prática o ecossistema convergiu em
 * `new-window` / `new_window` / `NewWindow`, e é por isso que o teste é um
 * sufixo e não uma igualdade: `new-private-window` do Firefox NÃO pode
 * casar (ela abre outra coisa), mas `open-new-window` tem que casar.
 */
const NEW_WINDOW_ACTION = /new[-_]?window$/i;

/**
 * Preenche uma PopupMenuSection com as ações de um Shell.App: "Nova
 * janela" quando cabe, mais as actions declaradas no .desktop.
 *
 * Vive fora de dockIcon.js porque a grade do launcher mostra exatamente as
 * mesmas ações, com a mesma ordem e as mesmas armadilhas — duas cópias
 * disto seriam duas versões da regra de de-duplicação para manter em
 * sincronia.
 *
 * Sempre chamada NA ABERTURA do menu, nunca uma vez só na construção: a
 * lista muda com o tempo. `can_open_new_window()` de vários apps só passa a
 * ser verdadeira depois que o app está rodando (é o D-Bus dele que
 * responde), e um menu montado no nascimento do ícone nunca mostraria o
 * item.
 *
 * @param {PopupMenu.PopupMenuSection} section seção a repopular (o
 *   conteúdo anterior é descartado aqui dentro)
 * @param {Shell.App|null} app
 * @param {object} [params]
 * @param {() => void} [params.onLaunch] chamado ANTES de um item que lança
 *   alguma coisa — é por onde o launcher fecha a grade. A ordem é a mesma
 *   armadilha de `AppsLauncher._launch()`: o overlay segura um grab modal
 *   do seat, e uma janela nova não consegue tomar o foco enquanto ele
 *   estiver de pé. Lançar primeiro e fechar depois dá uma janela que abre
 *   sem foco.
 * @param {boolean} [params.trailingSeparator=true] fecha a seção com um
 *   separador quando ela tem conteúdo. Faz parte da seção de propósito:
 *   um separador criado por fora ficaria órfão no topo do menu justamente
 *   nos apps que não têm ação nenhuma.
 * @returns {number} quantos itens a seção ficou tendo (separador incluso)
 */
export function fillAppActionsSection(section, app, params = {}) {
    if (!section) return 0;
    section.removeAll();
    if (!app) return 0;

    const onLaunch = params.onLaunch ?? null;
    // Lista as actions do .desktop ANTES: é ela que diz se já existe uma
    // "new window" declarada, e sem essa consulta prévia o nosso item
    // apareceria duplicado logo acima da action homônima do próprio app.
    const appInfo = app.get_app_info?.() ?? app.appInfo;
    const desktopActions = appInfo?.list_actions?.() ?? [];
    const hasNewWindowAction = desktopActions.some(action =>
        NEW_WINDOW_ACTION.test(action));

    if (app.can_open_new_window?.() && !hasNewWindowAction) {
        const item = new PopupMenu.PopupMenuItem('Nova janela');
        item.connect('activate', () => {
            onLaunch?.();
            app.open_new_window(-1);
        });
        section.addMenuItem(item);
    }

    for (const action of desktopActions) {
        const name = appInfo.get_action_name(action);
        const item = new PopupMenu.PopupMenuItem(name);
        item.connect('activate', () => {
            onLaunch?.();
            // O launch context carrega timestamp e workspace: sem ele a
            // janela nova nasce sem "user time" e o Mutter a trata como
            // não solicitada — ela abre atrás, com demands-attention.
            const ctx = global.create_app_launch_context(0, -1);
            appInfo.launch_action(action, ctx);
        });
        section.addMenuItem(item);
    }

    if (params.trailingSeparator !== false && section.numMenuItems > 0)
        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    return section.numMenuItems;
}
