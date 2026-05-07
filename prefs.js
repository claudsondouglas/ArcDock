import Adw from "gi://Adw";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const ICON_SIZE = Object.freeze({
  MIN: 32,
  MAX: 96,
  STEP: 1,
  PAGE: 8,
});

export default class ArcDockPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const appearancePage = new Adw.PreferencesPage({
      title: "Aparência",
      icon_name: "preferences-desktop-appearance-symbolic",
    });
    window.add(appearancePage);

    const group = new Adw.PreferencesGroup({
      title: "Ícones",
    });
    appearancePage.add(group);

    const row = new Adw.ActionRow({
      title: "Tamanho do ícone",
    });
    group.add(row);

    const valueLabel = new Gtk.Label({
      width_chars: 5,
      xalign: 1,
    });

    const adjustment = new Gtk.Adjustment({
      lower: ICON_SIZE.MIN,
      upper: ICON_SIZE.MAX,
      step_increment: ICON_SIZE.STEP,
      page_increment: ICON_SIZE.PAGE,
      value: settings.get_int("icon-size"),
    });

    const scale = new Gtk.Scale({
      adjustment,
      digits: 0,
      draw_value: false,
      hexpand: true,
      width_request: 220,
      valign: Gtk.Align.CENTER,
    });
    scale.add_mark(ICON_SIZE.MIN, Gtk.PositionType.BOTTOM, null);
    scale.add_mark(56, Gtk.PositionType.BOTTOM, null);
    scale.add_mark(ICON_SIZE.MAX, Gtk.PositionType.BOTTOM, null);

    const updateLabel = (value) => {
      valueLabel.label = `${Math.round(value)} px`;
    };
    updateLabel(adjustment.value);

    adjustment.connect("value-changed", () => {
      const value = Math.round(adjustment.value);
      updateLabel(value);
      if (settings.get_int("icon-size") !== value)
        settings.set_int("icon-size", value);
    });

    const controls = new Gtk.Box({
      spacing: 12,
      valign: Gtk.Align.CENTER,
    });
    controls.append(scale);
    controls.append(valueLabel);
    row.add_suffix(controls);
    row.activatable_widget = scale;

    const indicatorGroup = new Adw.PreferencesGroup({
      title: "Indicador de app aberto",
    });
    appearancePage.add(indicatorGroup);

    const dotRow = new Adw.ActionRow({
      title: "Usar cor do tema",
      subtitle:
        "Quando ligado, a bolinha de app aberto adapta a cor ao tema do sistema. Desligado, usa a cor padrão da dock.",
    });
    indicatorGroup.add(dotRow);

    const dotSwitch = new Gtk.Switch({
      active: settings.get_boolean("running-dot-theme-color"),
      valign: Gtk.Align.CENTER,
    });
    dotSwitch.connect("notify::active", () => {
      if (settings.get_boolean("running-dot-theme-color") !== dotSwitch.active)
        settings.set_boolean("running-dot-theme-color", dotSwitch.active);
    });
    dotRow.add_suffix(dotSwitch);
    dotRow.activatable_widget = dotSwitch;

    const communityPage = new Adw.PreferencesPage({
      title: "Comunidade",
      icon_name: "system-users-symbolic",
    });
    window.add(communityPage);

    const communityGroup = new Adw.PreferencesGroup({
      title: "Contribua do seu jeito",
    });
    communityPage.add(communityGroup);

    const text = new Gtk.Label({
      label:
        "O Linux cresce porque a comunidade cria, testa, documenta e compartilha. Nem toda contribuição precisa ser grande como o kernel: uma dock, uma tradução, um bug report ou uma ideia bem explicada também ajudam o ecossistema inteiro.",
      wrap: true,
      xalign: 0,
    });
    text.add_css_class("dim-label");

    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      margin_top: 12,
      margin_bottom: 12,
      margin_start: 12,
      margin_end: 12,
    });
    box.append(text);
    box.append(new Gtk.LinkButton({
      label: "GNOME Developer Documentation",
      uri: "https://developer.gnome.org/documentation/",
      halign: Gtk.Align.START,
    }));

    communityGroup.add(box);
  }
}
