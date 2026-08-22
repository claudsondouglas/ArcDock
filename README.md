# ArcDock

Uma tentativa de trazer o visual da **dock do macOS Tahoe** para o GNOME Shell, escrita do zero
e usando só APIs nativas (Clutter, St, `Shell.BlurEffect`).

Faz parte do **Project Arc**, uma suíte de quatro extensões que refazem a interface do GNOME. É
um projeto pessoal: foi feito pra resolver o que eu precisava, funciona porque é simples, e não
tenta cobrir todos os cenários.

![ArcDock](https://i.postimg.cc/L51nJHVk/Captura-de-tela-de-2026-05-06-21-49-58.png)

## As três seções do painel

O painel são três caixas, com um divisor entre elas e o botão de Aplicativos colado no fim da
última:

```
apps (fixados ou em execução) | abertos recentemente | pastas + Aplicativos
```

O botão é o fim da dock, não uma seção: ele nunca ganha divisor próprio. E um **divisor só
aparece entre duas seções que ambas tenham conteúdo**. Sem recentes a linha fica
`apps | pastas + botão`; sem pastas, `apps + botão`. Se tudo estiver vazio e o botão desligado,
a dock some inteira: nada de hot-edge, nada de camada de clique.

- **Apps.** Os fixados ficam sempre; um app aberto que não está fixado aparece enquanto roda e
  sai quando fecha.
- **Abertos recentemente.** Espelha o "Show recent applications in Dock" do macOS: até três
  apps abertos há pouco que não estão fixados nem rodando agora. O histórico é gravado sempre,
  mesmo com a seção desligada, pra que ligá-la de volta já encontre a fila cheia.
- **Pastas.** Pastas do sistema de arquivos fixadas na dock, lidas de forma assíncrona (nada de
  I/O síncrono dentro do compositor).

Arrastar reordena dentro da seção: um item nunca atravessa a fronteira entre duas delas, e a
seção de recentes não é alvo de soltura nem entra na ordem persistida.

## O que ela faz

- **Auto-hide com hot-edge** na borda inferior do monitor primário, por sondagem do ponteiro
  (10 Hz) em vez de um actor invisível. Mostrar exige demora: o ponteiro precisa ficar 250 ms
  na faixa antes de a dock subir, então passar reto não invoca nada. Ela desce 350 ms depois
  que o ponteiro sai.
- **Vidro translúcido** via `Shell.BlurEffect` em modo background, em tema claro ou escuro. O
  indicador de execução, os balões e as marcações acompanham o tema escolhido.
- **Magnificação ao passar o mouse**, estilo macOS: o ícone sob o ponteiro cresce e empurra os
  vizinhos, com escala e distância de afastamento configuráveis. A curva é um cosseno ao
  quadrado, que chega derivada zero nas duas pontas, então não há degrau na borda do efeito nem
  tremida quando o ponteiro cruza um ícone. Vem desligada por padrão.
- **Indicador de execução** em três estilos: um ponto, um ponto por janela aberta (até quatro,
  estilo macOS) ou uma barra horizontal.
- **Ponto de atenção** no ícone quando o app tem notificação pendente. Ele lê a bandeja do
  shell além do `demands-attention` da janela, porque apps Electron (Discord, Slack) não marcam
  a janela de forma confiável no Wayland.
- **Clique para minimizar** (opcional): clicar no ícone do app em foco recolhe as janelas em
  vez de só trazê-las pra frente. Com várias janelas, o clique primeiro passeia pelas que ainda
  estão visíveis e só minimiza quando não sobra nada pra levantar.
- **Clique do meio** fecha a janela atual do app. **Clique direito** abre o menu de contexto.
- **Animações de janela** (opcional): a janela abre a partir do ícone da dock e volta voando
  pra ele ao minimizar, como no macOS. Minimizar e restaurar pegam carona na animação nativa do
  Mutter (a dock só mantém a `icon_geometry` de cada janela apontando pro ícone certo); só a
  abertura é animação própria.
- **Some em tela cheia** (opcional): com uma janela em tela cheia no monitor primário, a dock é
  desligada por inteiro, hot-edge e camada de clique incluídos. O critério é tela cheia de
  verdade, nunca "é um jogo": maximizado não conta, e qualquer jogo em fullscreen exclusivo ou
  sem borda passa por esse caminho sozinho.
- **Arrastar para reordenar.** O ícone arrastado deixa um buraco, os vizinhos deslizam pra
  abrir a célula reservada, exatamente uma célula fica acesa (a que vai receber o item) e, ao
  soltar, a arte voa até ela antes de a linha ser refeita. A ordem só é gravada quando a viagem
  termina.
- **Sem vazamento de clique**: uma camada reativa logo abaixo da dock consome os cliques que
  caem fora dos ícones, então nada chega à janela de baixo, e o clique também esconde a dock.
- **Esconde a dash do GNOME no overview**, e a própria dock sai da tela enquanto o overview
  está aberto.
- **Aguenta a rotina da sessão**: suspender e acordar, trocar de monitor, bloquear e
  desbloquear. Em cada um desses eventos a dock é reconstruída, e nada é desenhado na tela de
  bloqueio.

### Menus de contexto

No ícone de um app: as ações do próprio `.desktop` e "Nova janela", a lista de janelas quando
há mais de uma, "Fixar na dock" / "Desafixar da dock", os itens da ArcDesk (veja abaixo) e
"Fechar".

No ícone de uma pasta: o conteúdo dela (pastas antes, alfabético, até doze entradas mais um
resumo "… mais N"), "Abrir pasta", "Remover da dock" e os itens da ArcDesk. O menu abre na hora
com um "Carregando…" e o conteúdo real chega por callback.

## A grade de aplicativos

O botão de Aplicativos abre uma sobreposição em tela cheia no estilo Launchpad, com a lista dos
apps instalados. Dá pra desligá-la e fazer o botão voltar a abrir a visão de aplicativos do
overview do GNOME.

- **Busca difusa** com pontuação por relevância. Digitar qualquer letra devolve o foco ao campo
  de busca. A busca é um modo à parte: ela lista apps de forma plana, inclusive os que moram
  dentro de pastas (procurar um app nunca deveria exigir lembrar em qual pasta ele parou), e o
  arrastar-e-soltar fica desligado enquanto ela está ativa.
- **Paginação**, com a roda do mouse e o touchpad virando página.
- **Ordem sua.** Nada é ordenado de A a Z: a grade desenha o arranjo que você fez arrastando.
  Só um app recém-instalado entra ordenado, no fim da lista.
- **Pastas.** Soltar um app no meio de outro cria uma pasta, com nome editável e painel próprio
  ao abrir. Soltar na borda reordena. Uma pasta que fica com menos de dois membros deixa de ser
  pasta: com um, ele volta pra célula dela; com nenhum, ela some.
- **Reflow e voo**, iguais aos da dock: os vizinhos abrem a célula reservada, uma célula acesa
  mostra onde o ícone vai cair, e a arte voa até lá antes de a grade ser refeita.
- **Menu de contexto** em cada célula: as ações do app, "Fixar na dock" / "Desafixar da dock",
  "Criar atalho na área de trabalho" e os itens da ArcDesk. Pastas não têm menu.
- A grade fecha por três gestos e só por eles: lançar um app, <kbd>Esc</kbd> e o próprio botão
  de Aplicativos. Clicar no fundo vazio não fecha (isso transformava todo drop levemente fora
  de lugar numa dispensa), mas o clique é consumido.

## Itens da dock: ids tipados

Cada item da dock é um id no formato `type:value`:

| Id | O que é |
|---|---|
| `app:firefox.desktop` | um aplicativo, pelo id do `.desktop` |
| `folder:/home/u/Downloads` | uma pasta do sistema de arquivos, pelo caminho absoluto |
| `group:<id>` | reservado; reconhecido, preservado, **ainda não é renderizado** |

A separação é no **primeiro** `:` só, porque o valor pode ser um caminho e conter outros.

A lista vive **ordenada** na chave `dock-items` do GSettings. É ela que decide a ordem relativa
dentro de cada seção; apps abertos que não estão fixados são voláteis e não entram nela. Um id
de um tipo que esta versão não sabe desenhar é ignorado na tela mas **preservado na escrita**:
sem isso, uma versão antiga apagaria em silêncio os itens de uma versão nova.

A ideia do `group:` era juntar vários apps num ícone só, tipo pilha do macOS. O `parseId` já o
reconhece e a gravação já o preserva, mas nada desenha um grupo na dock ainda.

## Preferências

```bash
gnome-extensions prefs ArcDock@claudson
```

Três abas: **Appearance** (estilo, ícones, indicador, magnificação, comportamento e a grade de
aplicativos), **Items** (a lista de pastas fixadas, com um seletor de pastas pra acrescentar) e
**Community**.

| Chave | Padrão | O que faz |
|---|---|---|
| `icon-size` | 56 | tamanho do ícone em pixels, de 32 a 96 |
| `dock-theme` | `light` | vidro claro ou escuro; indicadores e balões seguem a escolha |
| `running-indicator-style` | `dot` | `dot`, `dots` (um por janela) ou `bar` |
| `running-dot-theme-color` | desligado | usa a cor de frente do tema do sistema no indicador |
| `click-to-minimize` | ligado | clicar no app em foco minimiza em vez de só levantar |
| `show-apps-button` | ligado | mostra o botão de Aplicativos no fim da dock |
| `apps-launcher-enabled` | ligado | o botão abre a grade própria; desligado, abre o overview |
| `apps-launcher-columns` | 7 | apps por linha na grade, de 4 a 12 |
| `window-animations-enabled` | ligado | janelas abrem e minimizam a partir do ícone |
| `hide-in-fullscreen` | ligado | desliga a dock com uma janela em tela cheia no primário |
| `show-recent-apps` | ligado | mostra a seção de abertos recentemente |
| `magnification-enabled` | desligado | zoom no hover, estilo macOS |
| `magnification-scale` | 1.5 | quanto o ícone sob o ponteiro cresce, de 1.1 a 2.0 |
| `magnification-falloff` | 150 | distância em px onde o zoom morre, de 50 a 400 |

Estas outras são estado interno e não aparecem na tela de preferências: `dock-items`,
`recent-apps`, `launcher-layout`, `launcher-folders`, `dock-groups` e `dock-items-migrated`.
Não são feitas pra edição à mão.

Toda mudança de preferência derruba e remonta a dock, então o efeito é imediato e não há estado
meio aplicado.

## Integração com a ArcDesk

Com a **ArcDesk** instalada e ativa, os menus de contexto da dock ganham *"Adicionar à área de
trabalho"* e *"Remover da área de trabalho"* em três lugares: nos ícones de app, nas pastas
fixadas e nas células da grade de aplicativos.

Os itens só aparecem quando a ArcDesk está **realmente de pé** na sessão, e isso é relido a
cada abertura de menu, nunca guardado: o usuário pode ligar ou desligar a outra extensão entre
dois cliques, e um item apontando pra uma área de trabalho que não existe seria um clique sem
efeito.

A ponte é a chave `desk-items` da ArcDesk. A dock só acrescenta um id; achar um lugar livre é
problema da ArcDesk. Um detalhe de vocabulário: o que a dock chama de `folder:` a ArcDesk chama
de `path:`, porque lá `folder:` é uma pasta **virtual**, um agrupamento de apps que não existe
no disco.

## Requisitos

- **GNOME Shell 46 a 50**
- Wayland ou Xorg

## Instalação

### 1. Clone na pasta de extensões

O nome da pasta **precisa** ser exatamente `ArcDock@claudson`, que é o UUID declarado no
`metadata.json`:

```bash
git clone https://github.com/claudsondouglas/ArcDock.git \
  ~/.local/share/gnome-shell/extensions/ArcDock@claudson
```

> Por SSH: `git@github.com:claudsondouglas/ArcDock.git`.

### 2. Compile o esquema de configuração

Sem isto a extensão não sobe: ela declara `settings-schema` e o `getSettings()` falha com o
esquema não compilado.

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/ArcDock@claudson/schemas/
```

### 3. Recarregue o Shell

- **Xorg:** `Alt+F2`, `r`, `Enter`.
- **Wayland:** faça logout e login. Uma extensão nova só é vista depois disso, porque o
  `ExtensionManager` varre a pasta de extensões uma vez só, na inicialização.

### 4. Ative

```bash
gnome-extensions enable ArcDock@claudson
```

Ou pelo aplicativo **Extensões** (`gnome-extensions-app`): procure por *ArcDock* e ligue a
chave.

### 5. Confira

Leve o ponteiro até a borda inferior do monitor primário e segure ali por um instante: a dock
deve subir. Se nada acontecer, olhe o journal:

```bash
journalctl --user -f -o cat _COMM=gnome-shell | grep -i arcdock
```

## Atualização

```bash
cd ~/.local/share/gnome-shell/extensions/ArcDock@claudson
git pull
glib-compile-schemas schemas/
```

Recarregue o Shell (passo 3). Rode o `glib-compile-schemas` sempre que o `git pull` tocar em
`schemas/`: o arquivo compilado é ignorado pelo git e não vem no clone.

## Desinstalação

```bash
gnome-extensions disable ArcDock@claudson
rm -rf ~/.local/share/gnome-shell/extensions/ArcDock@claudson
```

## Recarregar depois de editar

- **Xorg:** `Alt+F2` → `r` → `Enter`. Reinicia o shell e força a reimportação dos módulos. É o
  caminho usado no desenvolvimento deste projeto.
- **Wayland:** `disable` seguido de `enable` roda o `enable()` de novo, mas o GNOME 46+ mantém
  os módulos ESM em memória, então edições em `src/*.js` costumam ficar invisíveis. **Se uma
  linha de log nova não aparecer depois do enable, você está rodando código velho: faça logout
  e login.** Não existe atalho.
- **CSS** recarrega junto com o shell, então um ajuste de estilo é barato.

## Status

Projeto experimental, em evolução. A documentação técnica (arquitetura, as decisões de projeto
e as armadilhas desta versão do Shell) está no [`CLAUDE.md`](./CLAUDE.md).

## Licença

MIT.
