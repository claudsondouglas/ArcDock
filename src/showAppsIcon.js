import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as OverviewControls from "resource:///org/gnome/shell/ui/overviewControls.js";

import { SIZE } from "./config.js";
import * as Cursor from "./cursor.js";
import {
  attachHoverPress,
  playEntry,
  triggerPressBounce,
} from "./iconAnimation.js";

export const ShowAppsIcon = GObject.registerClass(
  class ShowAppsIcon extends St.Button {
    _init(params = {}) {
      super._init({
        style_class: "arcdock-icon arcdock-menu-icon",
        reactive: true,
        can_focus: true,
        track_hover: true,
      });
      this._iconSize = params.iconSize ?? SIZE.ICON;
      this._tooltipText = "Applications";
      // Ação opcional: quando a dock tem um launcher próprio, ela injeta
      // aqui o toggle dele. O botão não conhece o launcher — só sabe que
      // existe "alguma coisa" a chamar no clique.
      this._onActivate = params.onActivate ?? null;

      // Nome SEM sufixo -symbolic de propósito: em temas estilo macOS
      // (WhiteSur & cia) "view-app-grid" resolve para o Launchpad
      // fullcolor — a grade colorida sobre o quadrado claro arredondado.
      // Esse fundo claro é o corpo do ícone, não um artefato da dock.
      // Quem não tiver a variante fullcolor cai no symbolic do próprio
      // tema, recolorido pelo `color` de .arcdock-menu-icon-texture.
      const icon = new St.Icon({
        icon_name: "view-app-grid",
        icon_size: this._iconSize,
        style_class: "arcdock-icon-texture arcdock-menu-icon-texture",
      });
      icon.set_style?.(`icon-size: ${this._iconSize}px;`);
      const stage = new St.Bin({
        style_class: "arcdock-icon-stage",
        width: this._iconSize,
        height: this._iconSize,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      stage.set_child(icon);
      const host = new St.Widget({
        style_class: "arcdock-icon-host",
        width: this._iconSize,
        height: this._iconSize + 8,
        // Mesmo motivo do IconButton: com a largura fixada pela
        // magnificação, o FILL padrão esticaria o host e jogaria o ícone
        // para a esquerda do slot.
        x_align: Clutter.ActorAlign.CENTER,
      });
      host.add_child(stage);
      const dot = new St.Widget({
        style_class: "arcdock-running-dot arcdock-menu-dot",
        reactive: false,
      });
      dot.set_position(Math.floor((this._iconSize - 5) / 2), this._iconSize - 1);
      host.add_child(dot);
      this._tooltipHost = host;
      // Mesmo nome do getter do IconButton: é por ele que a magnificação
      // acha o actor que deve escalar, e este botão magnifica junto com
      // os outros (no macOS o Launchpad também incha).
      this._host = host;
      this._hoverActor = icon;
      // Mesmo contrato do IconButton: as animações vivem no stage, para
      // não arrastarem o dot (irmão do stage dentro do host) junto.
      this._animActor = stage;
      this.set_child(host);

      this.connect("clicked", this._onClicked.bind(this));
      attachHoverPress(this);
      playEntry(this);
    }

    /** Host com overlay livre — mesma superfície pública do IconButton. */
    get host() {
      return this._host;
    }

    _onClicked() {
      // O bounce vem SEMPRE, antes de decidir o destino: o feedback de
      // clique pertence ao botão, não à ação que ele dispara.
      triggerPressBounce(this);
      // Fallback obrigatório: a dock pode ser construída sem settings
      // (extension.js a recria em várias situações) ou com o launcher
      // desligado na preferência, e nesses casos ninguém passa
      // onActivate. Sem o overview aqui o botão viraria um botão morto —
      // visível, com tooltip e bounce, e sem abrir coisa alguma.
      if (this._onActivate) this._onActivate();
      else Main.overview.show(OverviewControls.ControlsState.APP_GRID);
    }

    destroy() {
      if (this.hover) Cursor.setDefault();
      super.destroy();
    }
  },
);
