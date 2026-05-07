# ArcDock

Uma tentativa de trazer o visual do **Dock do macOS Tahoe** para o GNOME Shell.

Extensão minimalista escrita do zero, focada em recriar a sensação do dock da
Apple — vidro fosco, tooltip no hover, aparição suave
quando o cursor toca a borda inferior — usando apenas as APIs nativas do
GNOME Shell (Clutter, St, Shell.BlurEffect).

![ArcDock screenshot](https://i.postimg.cc/L51nJHVk/Captura-de-tela-de-2026-05-06-21-49-58.png)

## Características

- **Auto-hide** com hot-edge na borda inferior e polling de cursor.
- **Vidro translúcido** via `Shell.BlurEffect` em modo background.
- **Tooltip no hover** acima dos ícones, sem scale/lift.
- **Apenas apps em execução** — sem favoritos fixos, similar ao comportamento
  padrão do dock do macOS.
- **Botão Show Apps** que abre o app grid do overview.
- **Sem vazamento de cliques**: overlay reativo full-screen abaixo do dock
  garante que cliques fora dos ícones nunca caiam na janela atrás.

## Requisitos

- GNOME Shell **46**

## Instalação

### 1. Clone o repositório no diretório de extensões do GNOME

O nome da pasta **precisa** ser exatamente `ArcDock@claudson` (é o UUID declarado em `metadata.json`):

```bash
git clone https://github.com/claudsondouglas/ArcDock.git \
  ~/.local/share/gnome-shell/extensions/ArcDock@claudson
```

> Se preferir SSH: `git@github.com:claudsondouglas/ArcDock.git`.

### 2. Recarregue o GNOME Shell

Para que o shell descubra a nova extensão:

- **Xorg:** `Alt+F2`, digite `r`, `Enter`.
- **Wayland:** logout e login novamente (não há reload do shell em runtime).

### 3. Ative a extensão

```bash
gnome-extensions enable ArcDock@claudson
```

Ou pelo app **Extensions** (`gnome-extensions-app`) — procure por *ArcDock* e ligue o switch.

### 4. Verifique

Encoste o cursor na borda inferior da tela primária — o dock deve subir suavemente. Se nada acontecer, confira o journal:

```bash
journalctl --user -f -o cat _COMM=gnome-shell | grep -i arcdock
```

### Atualizar

```bash
cd ~/.local/share/gnome-shell/extensions/ArcDock@claudson
git pull
```

Depois recarregue o shell (passo 2).

### Desinstalar

```bash
gnome-extensions disable ArcDock@claudson
rm -rf ~/.local/share/gnome-shell/extensions/ArcDock@claudson
```

## Status

Projeto experimental, em evolução. Documentação técnica e arquitetura em
[`CLAUDE.md`](./CLAUDE.md).

## Licença

MIT.
