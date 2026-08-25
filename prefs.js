import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { DockItemsStore, ItemType, makeId, parseId } from "./src/dockItemsStore.js";

const ICON_SIZE = Object.freeze({
  MIN: 32,
  MAX: 96,
  STEP: 1,
  PAGE: 8,
});

// Limites idênticos aos <range> das keys "magnification-scale" e
// "magnification-falloff" no gschema (e a MAGNIFICATION em src/config.js):
// um Gtk.Adjustment fora do range escreveria um valor que o GSettings
// recusa.
const MAGNIFY = Object.freeze({
  SCALE_MIN: 1.1,
  SCALE_MAX: 2.0,
  SCALE_STEP: 0.05,
  SCALE_PAGE: 0.1,
  FALLOFF_MIN: 50,
  FALLOFF_MAX: 400,
  FALLOFF_STEP: 10,
  FALLOFF_PAGE: 50,
});

// Limites idênticos ao <range> da key "apps-launcher-columns" no gschema
// (e a LAUNCHER.MIN/MAX_COLUMNS em src/config.js).
const LAUNCHER_COLUMNS = Object.freeze({
  MIN: 4,
  MAX: 12,
  DEFAULT: 7,
  STEP: 1,
  PAGE: 2,
});

const ICON = Object.freeze({
  ITEMS_PAGE: "folder-symbolic",
  FOLDER: "folder-symbolic",
  REMOVE: "user-trash-symbolic",
});

const TOAST = Object.freeze({
  TIMEOUT_S: 3,
});

// Ordem desta lista = ordem do Adw.ComboRow; o índice selecionado indexa
// os `value`, que precisam bater com os choices do gschema.
const DOCK_THEMES = Object.freeze([
  Object.freeze({
    value: "light",
    title: "Light",
    subtitle: "Translucent white glass, dark running indicators.",
  }),
  Object.freeze({
    value: "dark",
    title: "Dark",
    subtitle: "Translucent dark glass, light running indicators.",
  }),
]);

// Ordem desta lista = ordem do Adw.ComboRow; o índice selecionado indexa
// os `value`, que precisam bater com os choices do gschema.
const INDICATOR_STYLES = Object.freeze([
  Object.freeze({
    value: "dot",
    title: "Single dot",
    subtitle: "One dot under every running app.",
  }),
  Object.freeze({
    value: "dots",
    title: "Dot per window",
    subtitle: "One dot for each open window, up to four.",
  }),
  Object.freeze({
    value: "bar",
    title: "Bar",
    subtitle: "A horizontal bar under every running app.",
  }),
]);

export default class ArcDockPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const appearancePage = new Adw.PreferencesPage({
      title: "Appearance",
      icon_name: "preferences-desktop-appearance-symbolic",
    });
    window.add(appearancePage);

    const styleGroup = new Adw.PreferencesGroup({
      title: "Dock style",
    });
    appearancePage.add(styleGroup);
    styleGroup.add(this._makeThemeRow(settings));

    const group = new Adw.PreferencesGroup({
      title: "Icons",
    });
    appearancePage.add(group);

    const row = new Adw.ActionRow({
      title: "Icon size",
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

    appearancePage.add(this._makeMagnificationGroup(settings));

    const indicatorGroup = new Adw.PreferencesGroup({
      title: "Running app indicator",
    });
    appearancePage.add(indicatorGroup);

    const dotRow = new Adw.ActionRow({
      title: "Use theme color",
      subtitle:
        "When enabled, the running-app dot adapts its color to the system theme. When disabled, it uses the dock's default color.",
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

    indicatorGroup.add(this._makeIndicatorStyleRow(settings));

    const behaviorGroup = new Adw.PreferencesGroup({
      title: "Behavior",
    });
    appearancePage.add(behaviorGroup);

    const minimizeRow = new Adw.ActionRow({
      title: "Click to minimize",
      subtitle:
        "Clicking the focused app minimizes it. With several windows open, the click first cycles through the ones still visible.",
    });
    behaviorGroup.add(minimizeRow);

    const minimizeSwitch = new Gtk.Switch({
      active: settings.get_boolean("click-to-minimize"),
      valign: Gtk.Align.CENTER,
    });
    minimizeSwitch.connect("notify::active", () => {
      if (settings.get_boolean("click-to-minimize") !== minimizeSwitch.active)
        settings.set_boolean("click-to-minimize", minimizeSwitch.active);
    });
    minimizeRow.add_suffix(minimizeSwitch);
    minimizeRow.activatable_widget = minimizeSwitch;

    const tooltipsRow = new Adw.ActionRow({
      title: "Show tooltips",
      subtitle:
        "Show the name of the app or folder in a bubble above the icon while the pointer is over it.",
    });
    behaviorGroup.add(tooltipsRow);

    const tooltipsSwitch = new Gtk.Switch({
      active: settings.get_boolean("show-tooltips"),
      valign: Gtk.Align.CENTER,
    });
    tooltipsSwitch.connect("notify::active", () => {
      if (settings.get_boolean("show-tooltips") !== tooltipsSwitch.active)
        settings.set_boolean("show-tooltips", tooltipsSwitch.active);
    });
    tooltipsRow.add_suffix(tooltipsSwitch);
    tooltipsRow.activatable_widget = tooltipsSwitch;

    const windowAnimationsRow = new Adw.ActionRow({
      title: "Window animations",
      subtitle: "Open and minimize windows animate from the dock icon.",
    });
    behaviorGroup.add(windowAnimationsRow);

    const windowAnimationsSwitch = new Gtk.Switch({
      active: settings.get_boolean("window-animations-enabled"),
      valign: Gtk.Align.CENTER,
    });
    windowAnimationsSwitch.connect("notify::active", () => {
      if (
        settings.get_boolean("window-animations-enabled") !==
        windowAnimationsSwitch.active
      )
        settings.set_boolean(
          "window-animations-enabled",
          windowAnimationsSwitch.active,
        );
    });
    windowAnimationsRow.add_suffix(windowAnimationsSwitch);
    windowAnimationsRow.activatable_widget = windowAnimationsSwitch;

    const showAppsRow = new Adw.ActionRow({
      title: "Show Applications button",
      subtitle: "Display the app grid launcher at the end of the dock.",
    });
    behaviorGroup.add(showAppsRow);

    const showAppsSwitch = new Gtk.Switch({
      active: settings.get_boolean("show-apps-button"),
      valign: Gtk.Align.CENTER,
    });
    showAppsSwitch.connect("notify::active", () => {
      if (settings.get_boolean("show-apps-button") !== showAppsSwitch.active)
        settings.set_boolean("show-apps-button", showAppsSwitch.active);
    });
    showAppsRow.add_suffix(showAppsSwitch);
    showAppsRow.activatable_widget = showAppsSwitch;

    const fullscreenRow = new Adw.ActionRow({
      title: "Stay out of the way in fullscreen",
      subtitle:
        "Disable the dock and its bottom hot edge while a window is fullscreen — games, video, F11. Maximized windows are not affected.",
    });
    behaviorGroup.add(fullscreenRow);

    const fullscreenSwitch = new Gtk.Switch({
      active: settings.get_boolean("hide-in-fullscreen"),
      valign: Gtk.Align.CENTER,
    });
    fullscreenSwitch.connect("notify::active", () => {
      if (
        settings.get_boolean("hide-in-fullscreen") !== fullscreenSwitch.active
      )
        settings.set_boolean("hide-in-fullscreen", fullscreenSwitch.active);
    });
    fullscreenRow.add_suffix(fullscreenSwitch);
    fullscreenRow.activatable_widget = fullscreenSwitch;

    const recentAppsRow = new Adw.ActionRow({
      title: "Show recent applications",
      subtitle:
        "Keep the last six opened apps next to the Applications button.",
    });
    behaviorGroup.add(recentAppsRow);

    const recentAppsSwitch = new Gtk.Switch({
      active: settings.get_boolean("show-recent-apps"),
      valign: Gtk.Align.CENTER,
    });
    recentAppsSwitch.connect("notify::active", () => {
      if (settings.get_boolean("show-recent-apps") !== recentAppsSwitch.active)
        settings.set_boolean("show-recent-apps", recentAppsSwitch.active);
    });
    recentAppsRow.add_suffix(recentAppsSwitch);
    recentAppsRow.activatable_widget = recentAppsSwitch;

    appearancePage.add(this._makeAppsLauncherGroup(settings));

    this._buildItemsPage(window, settings);

    const communityPage = new Adw.PreferencesPage({
      title: "Community",
      icon_name: "system-users-symbolic",
    });
    window.add(communityPage);

    const communityGroup = new Adw.PreferencesGroup({
      title: "Contribute your way",
    });
    communityPage.add(communityGroup);

    const text = new Gtk.Label({
      label:
        "Linux thrives because the community builds, tests, documents and shares. Not every contribution has to be as big as the kernel: a dock, a translation, a bug report or a well-explained idea all help the whole ecosystem.",
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

  /**
   * Grupo "Applications launcher": o interruptor da grade própria e o
   * número de colunas dela.
   *
   * Fica logo depois de "Behavior" porque é a row "Show Applications
   * button" que decide se o botão existe — este grupo só decide o que ele
   * abre. Colunas subordinadas ao switch pelo mesmo `sensitive` do grupo
   * de Magnification.
   */
  _makeAppsLauncherGroup(settings) {
    const group = new Adw.PreferencesGroup({ title: "Applications launcher" });

    const toggleRow = new Adw.ActionRow({
      title: "Applications launcher",
      subtitle:
        "The Applications button opens a full-screen app grid with search, instead of the GNOME overview.",
    });
    group.add(toggleRow);

    const toggle = new Gtk.Switch({
      active: settings.get_boolean("apps-launcher-enabled"),
      valign: Gtk.Align.CENTER,
    });
    toggle.connect("notify::active", () => {
      if (settings.get_boolean("apps-launcher-enabled") !== toggle.active)
        settings.set_boolean("apps-launcher-enabled", toggle.active);
    });
    toggleRow.add_suffix(toggle);
    toggleRow.activatable_widget = toggle;

    const columnsRow = this._makeSliderRow({
      title: "Apps per row",
      subtitle: "How many applications fit side by side in the grid.",
      lower: LAUNCHER_COLUMNS.MIN,
      upper: LAUNCHER_COLUMNS.MAX,
      step: LAUNCHER_COLUMNS.STEP,
      page: LAUNCHER_COLUMNS.PAGE,
      digits: 0,
      marks: [LAUNCHER_COLUMNS.MIN, LAUNCHER_COLUMNS.DEFAULT, LAUNCHER_COLUMNS.MAX],
      value: settings.get_int("apps-launcher-columns"),
      format: (value) => `${Math.round(value)}`,
      onChanged: (value) => {
        const rounded = Math.round(value);
        if (settings.get_int("apps-launcher-columns") !== rounded)
          settings.set_int("apps-launcher-columns", rounded);
      },
    });
    group.add(columnsRow);

    // Mesmo padrão do grupo de Magnification: SYNC_CREATE já acerta o
    // estado inicial, e o bind segue o switch — inclusive quando a key
    // muda por fora (dconf, outra janela de prefs).
    toggle.bind_property(
      "active",
      columnsRow,
      "sensitive",
      GObject.BindingFlags.SYNC_CREATE,
    );

    return group;
  }

  /**
   * Grupo "Magnification": o interruptor do efeito e os dois knobs dele.
   *
   * Grupo próprio (e não mais duas rows soltas em "Icons") porque as
   * rows de escala e falloff só fazem sentido subordinadas ao switch —
   * juntas elas leem como um bloco, e o `sensitive` amarrado ao switch
   * mostra isso sem precisar de texto explicando.
   */
  _makeMagnificationGroup(settings) {
    const group = new Adw.PreferencesGroup({ title: "Magnification" });

    const toggleRow = new Adw.ActionRow({
      title: "Magnification",
      subtitle: "Icons grow as the pointer approaches, like the macOS Dock.",
    });
    group.add(toggleRow);

    const toggle = new Gtk.Switch({
      active: settings.get_boolean("magnification-enabled"),
      valign: Gtk.Align.CENTER,
    });
    toggle.connect("notify::active", () => {
      if (settings.get_boolean("magnification-enabled") !== toggle.active)
        settings.set_boolean("magnification-enabled", toggle.active);
    });
    toggleRow.add_suffix(toggle);
    toggleRow.activatable_widget = toggle;

    const scaleRow = this._makeSliderRow({
      title: "Maximum scale",
      subtitle: "How big the icon right under the pointer gets.",
      lower: MAGNIFY.SCALE_MIN,
      upper: MAGNIFY.SCALE_MAX,
      step: MAGNIFY.SCALE_STEP,
      page: MAGNIFY.SCALE_PAGE,
      digits: 2,
      marks: [MAGNIFY.SCALE_MIN, 1.5, MAGNIFY.SCALE_MAX],
      value: settings.get_double("magnification-scale"),
      // toFixed corta o lixo binário do passo de 0.05; Number() tira o
      // zero à direita, para ler "1.5×" e não "1.50×".
      format: (value) => `${Number(value.toFixed(2))}×`,
      onChanged: (value) => {
        const rounded = Number(value.toFixed(2));
        if (
          Math.abs(settings.get_double("magnification-scale") - rounded) > 0.001
        )
          settings.set_double("magnification-scale", rounded);
      },
    });
    group.add(scaleRow);

    const falloffRow = this._makeSliderRow({
      title: "Falloff distance",
      subtitle: "How far from the pointer the effect still reaches.",
      lower: MAGNIFY.FALLOFF_MIN,
      upper: MAGNIFY.FALLOFF_MAX,
      step: MAGNIFY.FALLOFF_STEP,
      page: MAGNIFY.FALLOFF_PAGE,
      digits: 0,
      marks: [MAGNIFY.FALLOFF_MIN, 150, MAGNIFY.FALLOFF_MAX],
      value: settings.get_int("magnification-falloff"),
      format: (value) => `${Math.round(value)} px`,
      onChanged: (value) => {
        const rounded = Math.round(value);
        if (settings.get_int("magnification-falloff") !== rounded)
          settings.set_int("magnification-falloff", rounded);
      },
    });
    group.add(falloffRow);

    // SYNC_CREATE já deixa o estado inicial certo, então não há um
    // `row.sensitive = ...` inicial para esquecer de atualizar. O bind
    // segue o switch, e o switch segue a key — inclusive quando ela muda
    // por fora (dconf, outra janela de prefs).
    for (const row of [scaleRow, falloffRow]) {
      toggle.bind_property(
        "active",
        row,
        "sensitive",
        GObject.BindingFlags.SYNC_CREATE,
      );
    }

    return group;
  }

  /** Row com Gtk.Scale + rótulo do valor, no formato da row "Icon size". */
  _makeSliderRow(params) {
    const row = new Adw.ActionRow({
      title: params.title,
      subtitle: params.subtitle ?? "",
    });

    const valueLabel = new Gtk.Label({ width_chars: 6, xalign: 1 });

    const adjustment = new Gtk.Adjustment({
      lower: params.lower,
      upper: params.upper,
      step_increment: params.step,
      page_increment: params.page,
      value: params.value,
    });

    const scale = new Gtk.Scale({
      adjustment,
      digits: params.digits,
      draw_value: false,
      hexpand: true,
      width_request: 220,
      valign: Gtk.Align.CENTER,
    });
    for (const mark of params.marks ?? [])
      scale.add_mark(mark, Gtk.PositionType.BOTTOM, null);

    const updateLabel = () => {
      valueLabel.label = params.format(adjustment.value);
    };
    updateLabel();

    adjustment.connect("value-changed", () => {
      updateLabel();
      params.onChanged(adjustment.value);
    });

    const controls = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER });
    controls.append(scale);
    controls.append(valueLabel);
    row.add_suffix(controls);
    row.activatable_widget = scale;

    return row;
  }

  /** Combo com o tema (claro/escuro) do vidro da dock. */
  _makeThemeRow(settings) {
    const row = new Adw.ComboRow({
      title: "Theme",
      model: Gtk.StringList.new(DOCK_THEMES.map((theme) => theme.title)),
    });

    const current = settings.get_string("dock-theme");
    const index = DOCK_THEMES.findIndex((theme) => theme.value === current);
    // -1 só acontece se a key trouxer um valor de uma versão futura;
    // cair no primeiro item é melhor do que deixar o combo em branco.
    row.selected = index === -1 ? 0 : index;
    row.subtitle = DOCK_THEMES[row.selected].subtitle;

    row.connect("notify::selected", () => {
      const theme = DOCK_THEMES[row.selected];
      if (!theme)
        return;
      row.subtitle = theme.subtitle;
      if (settings.get_string("dock-theme") !== theme.value)
        settings.set_string("dock-theme", theme.value);
    });

    return row;
  }

  /** Combo com o estilo do indicador de app rodando. */
  _makeIndicatorStyleRow(settings) {
    const row = new Adw.ComboRow({
      title: "Indicator style",
      model: Gtk.StringList.new(INDICATOR_STYLES.map((style) => style.title)),
    });

    const current = settings.get_string("running-indicator-style");
    const index = INDICATOR_STYLES.findIndex((style) => style.value === current);
    // -1 só acontece se a key trouxer um valor de uma versão futura;
    // cair no primeiro item é melhor do que deixar o combo em branco.
    row.selected = index === -1 ? 0 : index;
    row.subtitle = INDICATOR_STYLES[row.selected].subtitle;

    row.connect("notify::selected", () => {
      const style = INDICATOR_STYLES[row.selected];
      if (!style)
        return;
      row.subtitle = style.subtitle;
      if (settings.get_string("running-indicator-style") !== style.value)
        settings.set_string("running-indicator-style", style.value);
    });

    return row;
  }

  /**
   * Página "Items": pastas fixadas na dock, persistidas na key `dock-items`.
   *
   * prefs.js roda em outro processo, então escrever na key já é o suficiente:
   * a dock escuta `changed::dock-items` e se reconstrói sozinha.
   */
  _buildItemsPage(window, settings) {
    const store = new DockItemsStore(settings);

    const page = new Adw.PreferencesPage({
      title: "Items",
      icon_name: ICON.ITEMS_PAGE,
    });
    window.add(page);

    const folderGroup = new Adw.PreferencesGroup({
      title: "Pinned folders",
      description:
        "Folders pinned to the dock. Apps are pinned from the dock itself, using the icon's context menu.",
    });
    page.add(folderGroup);

    const addButton = new Gtk.Button({
      icon_name: "list-add-symbolic",
      tooltip_text: "Add folder…",
      valign: Gtk.Align.CENTER,
    });
    addButton.add_css_class("flat");
    addButton.connect("clicked", () => this._pickFolder(window, store));
    folderGroup.set_header_suffix(addButton);

    // Rows são recriadas do zero a partir de store.list(): a lista tem poucas
    // dezenas de itens e a mutação incremental erraria a ordem com facilidade.
    let rows = [];
    let disposed = false;

    const rebuild = () => {
      if (disposed)
        return;
      for (const row of rows)
        folderGroup.remove(row);
      rows = [];

      const paths = store
        .list()
        .map((id) => parseId(id))
        .filter((parsed) => parsed?.type === ItemType.FOLDER)
        .map((parsed) => parsed.value);

      if (paths.length === 0) {
        rows.push(this._makeEmptyRow());
      } else {
        for (const path of paths)
          rows.push(this._makeFolderRow(path, store));
      }

      for (const row of rows)
        folderGroup.add(row);
    };

    rebuild();

    // A dock pode desafixar uma pasta pelo menu de contexto com a janela de
    // prefs aberta; sem isto a lista mostraria estado obsoleto.
    const unsubscribe = store.onChanged(rebuild);

    // close-request (e não unmap, que dispara em qualquer ocultação da janela)
    // é o ponto certo do encerramento pela mão do usuário; `destroy` cobre a
    // janela derrubada por fora, ex: extensão recarregada. O cleanup é
    // idempotente, então os dois caminhos podem coexistir.
    const cleanup = () => {
      if (disposed)
        return;
      disposed = true;
      unsubscribe();
      store.destroy();
    };
    window.connect("close-request", () => {
      cleanup();
      return false;
    });
    window.connect("destroy", cleanup);
  }

  _makeEmptyRow() {
    const row = new Adw.ActionRow({
      title: "No folders pinned",
      subtitle: "Use the + button above to pin a folder to the dock.",
    });
    row.add_prefix(new Gtk.Image({ icon_name: ICON.FOLDER }));
    row.add_css_class("dim-label");
    return row;
  }

  _makeFolderRow(path, store) {
    const row = new Adw.ActionRow({
      title: GLib.path_get_basename(path) || path,
      subtitle: this._displayPath(path),
      // Caminhos longos não devem esticar a janela.
      subtitle_lines: 1,
    });

    const image = new Gtk.Image();
    const gicon = this._folderGicon(path);
    if (gicon)
      image.set_from_gicon(gicon);
    else
      image.icon_name = ICON.FOLDER;
    row.add_prefix(image);

    const removeButton = new Gtk.Button({
      icon_name: ICON.REMOVE,
      tooltip_text: "Unpin this folder",
      valign: Gtk.Align.CENTER,
    });
    removeButton.add_css_class("flat");
    // A remoção dispara changed::dock-items, que reconstrói as rows.
    removeButton.connect("clicked", () => store.remove(makeId(ItemType.FOLDER, path)));
    row.add_suffix(removeButton);

    return row;
  }

  _pickFolder(window, store) {
    // Gtk.FileDialog (GTK 4.10+) no lugar de Gtk.FileChooserNative, deprecado.
    const dialog = new Gtk.FileDialog({
      title: "Add folder to dock",
      modal: true,
    });
    dialog.set_initial_folder(Gio.File.new_for_path(GLib.get_home_dir()));

    dialog.select_folder(window, null, (source, result) => {
      let file = null;
      try {
        file = source.select_folder_finish(result);
      } catch (_) {
        // Cancelar/fechar o diálogo chega como exceção: não é erro, só sair.
        return;
      }

      // Pastas remotas (gvfs) podem não ter caminho local; a dock só lida com
      // caminhos de arquivo, então nada a fixar.
      const path = file?.get_path();
      if (!path) {
        this._toast(window, "That location cannot be pinned.");
        return;
      }

      const id = makeId(ItemType.FOLDER, path);
      if (store.has(id)) {
        this._toast(window, "That folder is already pinned.");
        return;
      }

      store.add(id);
    });
  }

  /** Caminho com `~` no lugar do home, como o usuário está acostumado a ler. */
  _displayPath(path) {
    const home = GLib.get_home_dir();
    if (!home)
      return path;
    if (path === home)
      return "~";
    if (path.startsWith(`${home}/`))
      return `~${path.slice(home.length)}`;
    return path;
  }

  /** Ícone real da pasta (Downloads, Music...), null se indisponível. */
  _folderGicon(path) {
    try {
      const info = Gio.File.new_for_path(path).query_info(
        "standard::symbolic-icon",
        Gio.FileQueryInfoFlags.NONE,
        null,
      );
      return info.get_symbolic_icon();
    } catch (_) {
      // Pasta removida, sem permissão ou montagem lenta: cai no fallback.
      return null;
    }
  }

  _toast(window, message) {
    if (typeof window.add_toast !== "function")
      return;
    window.add_toast(new Adw.Toast({ title: message, timeout: TOAST.TIMEOUT_S }));
  }
}
