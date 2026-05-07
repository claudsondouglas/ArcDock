# ArcDock — instruções para Claude

Extensão GNOME Shell minimalista (estilo macOS Tahoe) que mostra apenas apps em execução, com auto-hide, na borda inferior da tela primária.

## Como recarregar após editar JS

- **Xorg (preferido para dev):** `Alt+F2` → `r` → `Enter`. Reinicia o gnome-shell e força reimport do módulo. Este é o caminho usado neste projeto.
- **Wayland:** `gnome-extensions disable arcdock@claudson; gnome-extensions enable arcdock@claudson` *pode* funcionar, mas em GNOME 46+ o cache de módulos ESM frequentemente reusa o módulo em memória — JS edits ficam invisíveis. Se logs novos não aparecerem após enable, o único caminho confiável é logout/login.
- CSS-only (`stylesheet.css`) recarrega junto com o shell. Não há truque mais barato confiável.

## Arquitetura

```
extension.js              — entry point: ArcDockExtension.enable/disable, instancia Dock.
src/
├── config.js             — SIZE, ANIM, TIMING, State (constantes Object.freeze).
├── trackers.js           — SignalTracker, TimeoutTracker.
├── cursor.js             — helpers de cursor (setPointer/setDefault).
├── iconAnimation.js      — attachHoverPress(button): cursor + tooltip no hover.
├── dockIcon.js           — DockIcon (St.Button por app, click/middle-click).
├── showAppsIcon.js       — ShowAppsIcon (St.Button do menu, abre overview).
├── autoHide.js           — AutoHide (anima translation_y, polling de pointer).
└── dock.js               — Dock (chrome container + panel + Map<appId, DockIcon>; layout).
```

Uma classe = um arquivo = uma responsabilidade. **Nada que precise de cleanup vive solto fora de um tracker.**

### Regras de import
- Imports externos (`gi://`, `resource:///`) primeiro.
- Linha em branco.
- Imports relativos (`./config.js` etc.) depois.
- `extension.js` na raiz é o único arquivo cujo path é fixado pelo GNOME — todo o resto vive em `src/` para deixar claro o que é entry point e o que é módulo interno.
- Caminhos relativos sempre com extensão `.js` explícita (ESM no GJS exige).

## Convenções de código

### Nomeação e visibilidade
- Public surface da classe: nomes sem prefixo (`destroy`, `state`, `setHideDistance`).
- Privado: prefixo `_` (`_show`, `_isInLiveArea`, `_panelSize`).
- Constantes top-level em UPPER_SNAKE agrupadas em objetos `Object.freeze({...})` por categoria (`SIZE`, `ANIM`, `TIMING`, `State`).

### Estado
- Strings mágicas para estado (`'hidden'`, `'showing'`, etc.) **nunca soltas** — sempre via enum congelado (`State.HIDDEN`).
- Comparações sempre contra a constante: `if (state === State.SHOWN)`.

### Lifecycle
- Toda classe que conecta signals, registra timeouts, ou aloca actors **deve ter `destroy()`** que limpe **tudo** que criou. Sem exceção.
- `destroy()` é idempotente quando possível (checar `null` antes de destruir).
- Trackers (`SignalTracker`, `TimeoutTracker`) preferíveis a campos `_xxxId` soltos — reduzem chance de vazamento ao adicionar nova conexão.
- Em GNOME Shell, esquecer um `disconnect` ou `source_remove` causa: callbacks rodando após `disable()`, exceptions de actor destruído, e logs poluídos. **Cleanup é parte do contrato, não detalhe.**

### Animações Clutter
- Sempre `actor.remove_all_transitions()` antes de iniciar uma nova `ease()` que pode entrar em conflito com a anterior.
- Estado lógico (`_state`) muda em `onComplete` — não no momento de chamar `ease`. Isso evita que o estado divergeo do que o usuário está vendo.
- Easing por contexto: `EASE_OUT_QUAD` para entrada (rápido no fim), `EASE_IN_QUAD` para saída (rápido no início).

### Layout / posicionamento
- Para ler dimensão antes da allocation, usar `actor.get_preferred_height(forWidth)` / `get_preferred_width(forHeight)`. **Não confiar em `actor.height` ou `actor.width`** logo após adicionar children — retorna 0 ou stale.
- Reposicionar em `notify::height` do panel (não em `idle_add`) — dispara automaticamente quando children mudam.

### Pointer / hover detection
- `St.Widget` com `track_hover` + `notify::hover` é frágil para áreas pequenas em chrome (Wayland especialmente). Para auto-hide, **prefira polling via `GLib.timeout_add` + `global.get_pointer()`** com cálculo geométrico explícito da área de interesse — funciona em qualquer compositor, qualquer estado de fullscreen.
- 100ms é cadência razoável (10Hz) — imperceptível para o usuário e baixíssimo overhead.

### Chrome (`Main.layoutManager.addChrome`)
- `affectsInputRegion: true` — necessário para receber events com janelas maximizadas.
- `affectsStruts: false` — não reservar área no workspace (é overlay, não dock fixo).
- `trackFullscreen: true` — escondido automaticamente em apps fullscreen.
- Sempre `removeChrome` antes de `destroy()` no actor.

### O que **não** fazer
- Não usar `console.log` para output que precisa aparecer sempre — em algumas versões fica filtrado abaixo de `notice`. Use `console.warn` (warning level) ou `logError` para erros.
- Não chamar `Edit`/`refresh` em loop sem early-return — refresh já agrega adds/removes idempotentemente, mas chamadas recursivas via signals podem causar loop.
- Não usar `St.Widget` invisível como hot edge — pointer watcher é mais robusto.
- Não esquecer `set_pivot_point` ao escalar (sem ele, o scale cresce a partir do top-left, não do centro/baixo).

## Testando uma mudança

1. Editar `extension.js`.
2. `Alt+F2 → r → Enter`.
3. Conferir no journal: `journalctl --user -f -o cat _COMM=gnome-shell` — não deve haver `[ArcDock]` warnings/errors. Warnings de CSS shadow são pre-existentes (múltiplas shadows não suportadas em GNOME CSS).
4. Smoke test:
   - Encostar mouse na borda inferior → dock anima subindo.
   - Mover mouse para fora → após ~350ms desce.
   - Click esquerdo num ícone → ativa app.
   - Middle-click → fecha app.
   - Hover num ícone → tooltip acima do ícone.

## Arquivos

- `extension.js` — entry point. Mantenha **fino**: só instanciamento e cleanup de `Dock`.
- `src/*.js` — módulos por responsabilidade (ver árvore acima).
- `stylesheet.css` — visual (gradiente translúcido, border, shadow). Inner highlight via `inset` + outer glow em uma única `box-shadow` com vírgulas (o GNOME CSS warna sobre múltiplas, é só warning).
- `metadata.json` — UUID, version, GNOME shell-version compat.

## Tunables (constantes em `src/config.js`)

| Constante | Default | O que faz |
|---|---|---|
| `SIZE.ICON` | 48 | px do ícone do app |
| `SIZE.BOTTOM_MARGIN` | 12 | gap entre dock e borda inferior |
| `SIZE.HOT_EDGE` | 4 | espessura da faixa que dispara show |
| `SIZE.LIVE_BUFFER` | 8 | tolerância em px ao redor do dock visível antes de iniciar hide |
| `ANIM.HOVER_SCALE` | 1 | mantido para cálculo de headroom; sem scale no hover |
| `ANIM.HOVER_LIFT` | 0 | mantido para cálculo de headroom; sem lift no hover |
| `ANIM.HOVER_IN_MS` / `HOVER_OUT_MS` | 140 / 120 | legado; hover visual atual usa tooltip sem scale/lift |
| `ANIM.SHOW_MS` / `HIDE_MS` | 220 | duração das animações do dock |
| `TIMING.POINTER_POLL_MS` | 100 | frequência do polling de pointer |
| `TIMING.HIDE_DELAY_MS` | 350 | atraso antes de esconder após mouse sair |
