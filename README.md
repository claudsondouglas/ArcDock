# MahoeDock

Uma tentativa de trazer o visual do **Dock do macOS Tahoe** para o GNOME Shell.

Extensão minimalista escrita do zero, focada em recriar a sensação do dock da
Apple — vidro fosco, ícones que levantam ao passar o mouse, aparição suave
quando o cursor toca a borda inferior — usando apenas as APIs nativas do
GNOME Shell (Clutter, St, Shell.BlurEffect).

## Características

- **Auto-hide** com hot-edge na borda inferior e polling de cursor.
- **Liquid glass** via `Shell.BlurEffect` em modo background.
- **Hover lift + scale** dos ícones com easing `EASE_OUT_QUART` (assimétrico:
  entrada mais suave, saída mais rápida).
- **Apenas apps em execução** — sem favoritos fixos, similar ao comportamento
  padrão do dock do macOS.
- **Botão Show Apps** que abre o app grid do overview.
- **Sem vazamento de cliques**: overlay reativo full-screen abaixo do dock
  garante que cliques fora dos ícones nunca caiam na janela atrás.

## Requisitos

- GNOME Shell **46**

## Instalação

```bash
git clone git@github.com:claudsondouglas/mahoedock.git \
  ~/.local/share/gnome-shell/extensions/MahoeDock@claudson
```

Ative com:

```bash
gnome-extensions enable MahoeDock@claudson
```

No Wayland: faça logout/login. No Xorg: `Alt+F2 → r → Enter`.

## Status

Projeto experimental, em evolução. Documentação técnica e arquitetura em
[`CLAUDE.md`](./CLAUDE.md).

## Licença

MIT.
