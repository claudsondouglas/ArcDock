export const SIZE = Object.freeze({
  ICON: 56,
  BOTTOM_MARGIN: 2,
  HOT_EDGE: 4,
  LIVE_BUFFER: 8,
  // Precisa acompanhar o border-radius de .arcdock-panel no CSS.
  PANEL_RADIUS: 24,
});

// Shell.BlurEffect sempre pinta um RETÂNGULO — ele não conhece o
// border-radius do St, então o borrão vazava para fora dos cantos
// arredondados e aparecia como um quadrado atrás da dock. A correção é
// aplicar o blur num actor recuado o suficiente para caber inteiro
// dentro do retângulo arredondado: o canto do retângulo inscrito toca o
// arco quando o recuo é r * (1 - 1/√2).
export const BLUR_INSET = Math.ceil(SIZE.PANEL_RADIUS * (1 - Math.SQRT1_2));

// Estilos do indicador de app rodando. Valores idênticos aos choices da
// key "running-indicator-style" no gschema — mudar um exige mudar o outro.
export const IndicatorStyle = Object.freeze({
  DOT: "dot",
  DOTS: "dots",
  BAR: "bar",
});

// Tema do vidro da dock. Valores idênticos aos choices da key
// "dock-theme" no gschema — mudar um exige mudar o outro.
export const DockTheme = Object.freeze({
  LIGHT: "light",
  DARK: "dark",
});

// Seção "abertos recentemente", espelhando o "Show recent applications in
// Dock" do macOS.
export const RECENT = Object.freeze({
  // Três, como no macOS: o suficiente para "aquele app que acabei de
  // fechar" e pouco o bastante para não virar uma segunda dock.
  VISIBLE: 3,
  // O histórico guarda MUITO mais do que aparece: só entram na exibição os
  // que não estão fixados nem rodando, então a fila precisa de folga para
  // ainda ter três candidatos quando os primeiros estiverem todos abertos.
  HISTORY_MAX: 10,
  // Divisor: um fio de 1px com ~60% da altura do ícone.
  SEPARATOR_WIDTH: 1,
  SEPARATOR_HEIGHT_RATIO: 0.6,
  // A caixa de cada ícone tem 8px extras embaixo (espaço do indicador de
  // app rodando, ver iconButton.js), então o centro da linha do painel
  // fica 4px ABAIXO do centro ótico dos ícones. O divisor sobe esses 4px
  // para se alinhar com os ícones, não com a caixa.
  SEPARATOR_Y_OFFSET: -4,
});

// Magnificação estilo macOS: o ícone sob o ponteiro incha e empurra os
// vizinhos. MIN/MAX precisam bater com o <range> das keys
// "magnification-scale" e "magnification-falloff" no gschema — os valores
// que chegam de lá são reclampeados aqui, para que uma key adulterada não
// possa pedir um ícone de 10x.
export const MAGNIFICATION = Object.freeze({
  MIN_SCALE: 1.1,
  MAX_SCALE: 2.0,
  DEFAULT_SCALE: 1.5,
  // Distância, em px, a partir da qual o ícone fica no tamanho normal.
  MIN_FALLOFF: 50,
  MAX_FALLOFF: 400,
  DEFAULT_FALLOFF: 150,
  // Único trecho ANIMADO do efeito: a volta ao repouso quando o ponteiro
  // sai do painel. Durante o movimento a escala segue o ponteiro sem
  // ease — um easing ali viraria borracha atrasada.
  RELAX_MS: 150,
});

export const INDICATOR = Object.freeze({
  DOT_SIZE: 5,
  DOT_SPACING: 3,
  // Além disso a contagem vira ruído visual: quatro pontos já ocupam
  // metade da largura do ícone e ninguém conta acima disso de relance.
  MAX_DOTS: 4,
  BAR_HEIGHT: 3,
  BAR_MIN_WIDTH: 14,
  BAR_WIDTH_RATIO: 0.45,
  // Centro vertical do indicador, medido a partir da base do ícone. O
  // dot de 5px do layout original ficava em iconSize - 2, ou seja com o
  // centro em iconSize + 0.5; manter esse centro faz barra e pontos
  // aparecerem na mesma linha, independentemente da altura de cada um.
  CENTER_Y_OFFSET: 0.5,
});

// Altura do primeiro quique de lançamento. Fica fora do Object.freeze
// porque ANIM precisa usá-la DUAS vezes: como amplitude da animação e
// como HOVER_LIFT — o knob que o Dock._reposition() lê para reservar o
// headroom acima do painel. Amarrar os dois ao mesmo número garante que
// o quique nunca suba mais alto do que o espaço reservado para ele.
const BOUNCE_HEIGHT = 14;

export const ANIM = Object.freeze({
  // HOVER_SCALE/HOVER_LIFT não animam nada por si — existem para o
  // cálculo de headroom em Dock._reposition(). HOVER_LIFT cobre o quique
  // de lançamento; HOVER_SCALE fica em 1 porque a escala de press e a de
  // entrada partem do stage e nunca ultrapassam o tamanho do ícone por
  // margem relevante (o overshoot do BACK cabe no +8 fixo do headroom).
  HOVER_SCALE: 1,
  HOVER_LIFT: -BOUNCE_HEIGHT,
  HOVER_IN_MS: 140,
  HOVER_OUT_MS: 120,

  // Show/hide do dock. O show é EASE_OUT_EXPO: quase todo o caminho é
  // percorrido no começo e o fim é um deslize — é o que dá a sensação
  // de "o dock saltou para a mão" do macOS. O hide é mais curto e
  // acelera para fora, porque sair de cena não merece a mesma cerimônia.
  SHOW_MS: 280,
  HIDE_MS: 200,
  // Piso da duração quando a animação é interrompida no meio: sem ele um
  // resto de 3px ainda gastaria SHOW_MS inteiro e pareceria travado.
  TRAVEL_MIN_RATIO: 0.45,

  // Feedback de clique: o ícone afunda enquanto o botão está apertado e
  // volta com um leve overshoot (EASE_OUT_BACK) ao soltar.
  PRESS_SCALE: 0.9,
  PRESS_IN_MS: 90,
  PRESS_OUT_MS: 240,

  // Quique. TAP_LIFT é o pulinho único de "abri alguma coisa" (pasta,
  // grade de apps); BOUNCE_* é o quique de lançamento de app.
  TAP_LIFT: 6,
  BOUNCE_HEIGHT,
  BOUNCE_HOPS: 2,
  BOUNCE_UP_MS: 200,
  BOUNCE_DOWN_MS: 180,
  // Cada quique tem metade da altura do anterior. A duração encolhe pela
  // RAIZ disso (queda livre: t ∝ √h), senão o segundo quique parece
  // flutuar em câmera lenta.
  BOUNCE_DECAY: 0.5,

  // Entrada de um ícone novo no dock.
  ENTRY_SCALE: 0.5,
  ENTRY_MS: 200,

  // Duração da animação customizada de abertura de janela a partir do
  // ícone da dock (window-animations-enabled).
  WINDOW_OPEN_MS: 250,

  // Tooltip: fade + deslize de baixo para cima.
  TOOLTIP_SLIDE: 4,
  TOOLTIP_FADE_IN_MS: 150,
  TOOLTIP_FADE_OUT_MS: 100,
});

export const TIMING = Object.freeze({
  POINTER_POLL_MS: 100,
  HIDE_DELAY_MS: 350,
});

export const State = Object.freeze({
  HIDDEN: "hidden",
  SHOWING: "showing",
  SHOWN: "shown",
  HIDING: "hiding",
});
