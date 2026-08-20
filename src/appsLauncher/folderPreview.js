import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Lado da mini-grade: 3x3, como no Launchpad. As pastas do GNOME desenham
// 2x2, e a diferença não é decorativa — com 4 vagas a capa de uma pasta de
// oito apps mostra metade do conteúdo, e duas pastas diferentes acabam com
// a mesma cara. Nove vagas cobrem o tamanho típico de uma pasta inteira.
const GRID_SIDE = 3;
const GRID_CELLS = GRID_SIDE * GRID_SIDE;

// Geometria interna da capa, em FRAÇÕES do lado do ladrilho — nunca em px
// fixos: a mesma função desenha a capa em qualquer tamanho de ícone, e um
// respiro de 9px que é discreto num ladrilho de 88px come um terço de um
// de 28px.
//
// O respiro interno (o que separa a mini-grade da borda arredondada) é
// mais largo que o vão entre os mini-ícones de propósito: é ele que faz o
// conjunto ler como "conteúdo dentro de uma caixa" em vez de ícones
// colados na moldura. O ladrilho tem o tamanho de um ícone da grade, então
// os dois números são pequenos por natureza.
const TILE_PADDING_FRACTION = 0.10;
const GRID_SPACING_FRACTION = 0.04;

/**
 * Fração do lado do ladrilho que UM mini-ícone ocupa (~0.24).
 *
 * Derivada, e não um terceiro número solto: o que sobra do lado depois do
 * respiro das duas bordas e dos dois vãos, dividido pelas três colunas.
 * Exportada porque é o tamanho da mini-arte da pasta — quem precisar
 * desenhar a mesma capa fora da célula (proxy de arraste, cabeçalho do
 * painel) tem que chegar ao MESMO mini-ícone, e refazer a conta lá seria
 * duas fontes de verdade para a mesma geometria.
 */
export const FOLDER_PREVIEW_SUBICON_FRACTION =
    (1 - 2 * TILE_PADDING_FRACTION - (GRID_SIDE - 1) * GRID_SPACING_FRACTION) /
    GRID_SIDE;

/** Quantos apps cabem na capa; o resto da pasta não aparece nela. */
export const FOLDER_PREVIEW_MAX_APPS = GRID_CELLS;

/**
 * Miniatura da pasta: a "capa" que aparece na célula da grade.
 *
 * PURA: não conecta sinal, não registra timeout, não toca em disco e não
 * guarda estado em lugar nenhum. Tudo que ela cria pendura no actor
 * devolvido, então destruir esse actor (o que a célula já faz com todos os
 * filhos dela) é a limpeza inteira — não há destroy() a chamar aqui.
 *
 * @param {Shell.App[]} apps  apps da pasta, na ordem do usuário
 * @param {number} size  lado do quadrado, em px (é o mesmo tamanho de um ícone de app da grade)
 * @returns {St.Widget}
 */
export function createFolderPreview(apps, size) {
    const spacing = Math.max(1, Math.round(size * GRID_SPACING_FRACTION));
    const padding = Math.max(1, Math.round(size * TILE_PADDING_FRACTION));
    // Piso: o arredondamento acima pode ter engordado vão e respiro em até
    // meio pixel cada, e o mini-ícone é o que absorve a diferença — é ele
    // que precisa CABER, e não os dois números que o cercam.
    const subSize = Math.max(
        1,
        Math.floor(
            (size - 2 * padding - (GRID_SIDE - 1) * spacing) / GRID_SIDE
        )
    );

    const layout = new Clutter.GridLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        // Homogêneo nos dois eixos: sem isto, uma linha cujas três vagas
        // estão vazias encolheria para a altura mínima do St.Bin e as
        // linhas de cima subiriam — a posição de um app na capa mudaria
        // conforme a pasta tem 4 ou 7 membros.
        row_homogeneous: true,
        column_homogeneous: true,
        row_spacing: spacing,
        column_spacing: spacing,
    });

    const grid = new St.Widget({
        layout_manager: layout,
        reactive: false,
        // A grade é CENTRALIZADA dentro do ladrilho em vez de esticada: o
        // subSize acima foi arredondado para baixo, então sobram alguns
        // pixels, e centralizar os divide igualmente entre os dois lados.
        // Com o FILL padrão a sobra iria toda para a direita e para baixo,
        // e a mini-grade sairia visivelmente descentralizada.
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const shown = (apps ?? []).slice(0, GRID_CELLS);
    for (let i = 0; i < GRID_CELLS; i++) {
        const app = shown[i] ?? null;
        // Vaga vazia continua sendo ALOCADA (um St.Bin do tamanho do
        // mini-ícone, sem filho): é o que preserva a posição das vagas
        // usadas. Preenchimento por LINHA, da esquerda para a direita —
        // é como o Launchpad empilha, e é a única ordem em que uma pasta
        // de dois apps não fica torta: os dois ficam no canto superior
        // esquerdo, lidos como "o começo de uma grade", enquanto
        // qualquer tentativa de centralizar os poucos membros faria a
        // capa mudar de arranjo a cada app adicionado.
        const cell = new St.Bin({
            width: subSize,
            height: subSize,
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (app) cell.set_child(_createTexture(app, subSize));
        layout.attach(cell, i % GRID_SIDE, Math.floor(i / GRID_SIDE), 1, 1);
    }

    // O ladrilho é um St.Bin de lado EXPLÍCITO: ele ocupa exatamente a
    // caixa de um ícone da grade, então a célula de pasta e a célula de app
    // têm a mesma largura e a linha continua alinhada. O vidro (fundo,
    // borda e sombra) vem do CSS; o que está aqui é só a geometria.
    const tile = new St.Bin({
        style_class: 'arcdock-launcher-folder-tile',
        width: size,
        height: size,
        reactive: false,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    tile.set_child(grid);
    return tile;
}

function _createTexture(app, size) {
    // Mesmo contrato do appGridIcon: create_icon_texture() resolve o tema
    // de ícones (inclusive o fallback por wm_class) e só devolve null com
    // um .desktop sem ícone nenhum — e aí a vaga ainda precisa de algo do
    // tamanho certo, ou a mini-grade desaba naquela posição.
    const texture = app?.create_icon_texture?.(size) ?? null;
    if (texture) return texture;
    return new St.Icon({
        icon_name: 'application-x-executable',
        icon_size: size,
    });
}
