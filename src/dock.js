import Clutter from "gi://Clutter";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as DND from "resource:///org/gnome/shell/ui/dnd.js";

import {
  SIZE,
  ANIM,
  State,
  BLUR_INSET,
  IndicatorStyle,
  INDICATOR,
  DockTheme,
  RECENT,
  MAGNIFICATION,
  LAUNCHER,
} from "./config.js";
import { SignalTracker } from "./trackers.js";
import { DockIcon } from "./dockIcon.js";
import { FolderIcon } from "./folderIcon.js";
import { IconButton } from "./iconButton.js";
import { ShowAppsIcon } from "./showAppsIcon.js";
import { OverviewDashHider } from "./overviewDashHider.js";
import { AutoHide } from "./autoHide.js";
import { Magnification } from "./magnification.js";
import { InputCatcher } from "./inputCatcher.js";
import { WindowAnimations } from "./windowAnimations.js";
import { FullscreenWatcher } from "./fullscreenWatcher.js";
import { AppsLauncher } from "./appsLauncher/launcher.js";
import {
  DockItemsStore,
  ItemType,
  makeId,
  parseId,
} from "./dockItemsStore.js";
import { RecentAppsHistory } from "./recentAppsHistory.js";
import * as Cursor from "./cursor.js";
import { applyGlass } from "./glassEffect.js";
import { resetHoverPress, setTooltipTheme } from "./iconAnimation.js";
import { AttentionTracker } from "./attentionTracker.js";

export class Dock {
  constructor(params = {}) {
    this._appSystem = Shell.AppSystem.get_default();
    // Sem settings (o extension.js recria a dock em várias situações e
    // nem sempre temos o Gio.Settings em mãos) a dock degrada para "só
    // apps rodando" em vez de não subir.
    this._items = params.settings ? new DockItemsStore(params.settings) : null;
    this._itemsUnsubscribe = null;
    // Snapshot da última lista que NÓS escrevemos no store, usado para
    // ignorar o eco do nosso próprio set_strv — ver _onItemsChanged().
    this._pendingSelfWrite = null;
    this._size = {
      ...SIZE,
      ICON: params.iconSize ?? SIZE.ICON,
    };
    this._useThemeRunningDotColor = !!params.useThemeRunningDotColor;
    this._indicatorStyle = params.indicatorStyle ?? IndicatorStyle.DOT;
    this._clickToMinimize = params.clickToMinimize ?? false;
    this._showAppsButton = params.showAppsButton ?? true;
    this._showRecentApps = params.showRecentApps ?? true;
    this._magnificationParams = params.magnification ?? null;
    this._magnification = null;
    // Bloco ausente (dock construída sem ele) conta como desligado: o
    // botão Applications volta ao overview sozinho, que é o fallback do
    // ShowAppsIcon.
    this._appsLauncherParams = params.appsLauncher ?? null;
    this._appsLauncher = null;
    // Reclampeado aqui pelo mesmo motivo documentado em config.js para
    // magnification-scale: o valor vem de uma key do gschema e uma key
    // adulterada (dconf na mão, backup de outra versão) não pode pedir
    // uma grade de 400 colunas nem de uma só.
    this._appsLauncherColumns = Math.min(
      LAUNCHER.MAX_COLUMNS,
      Math.max(
        LAUNCHER.MIN_COLUMNS,
        this._appsLauncherParams?.columns ?? LAUNCHER.DEFAULT_COLUMNS,
      ),
    );
    // Guardado à parte do módulo porque _reposition() precisa dele para
    // reservar headroom ANTES (e depois) de o efeito existir; 1 significa
    // "sem magnificação" e some do cálculo.
    this._magnificationScale = this._magnificationParams?.enabled
      ? Math.min(
          MAGNIFICATION.MAX_SCALE,
          Math.max(
            MAGNIFICATION.MIN_SCALE,
            this._magnificationParams.scale ?? MAGNIFICATION.DEFAULT_SCALE,
          ),
        )
      : 1;
    // O histórico é gravado SEMPRE, mesmo com a seção desligada: quem
    // religa a preferência encontra a seção já populada em vez de uma
    // fila vazia esperando os próximos três apps.
    this._recents = params.settings
      ? new RecentAppsHistory(params.settings)
      : null;
    // Qualquer valor desconhecido (key de uma versão futura) cai no
    // claro: um tema não reconhecido não pode deixar a dock sem estilo.
    this._theme =
      params.theme === DockTheme.DARK ? DockTheme.DARK : DockTheme.LIGHT;
    // Dock sem NENHUM conteúdo visível (nem ícone de app/pasta, nem o
    // botão Applications) não deve subir: seria só uma pílula de vidro
    // vazia. Ver _syncContentVisibility().
    this._isEmpty = false;
    this._overviewShown = false;
    // Janela em tela cheia no monitor primário (jogo, vídeo, F11): a
    // dock some inteira, borda quente incluída. Ver FullscreenWatcher.
    this._fullscreenActive = false;
    this._fullscreenWatcher = null;
    // Grade de apps aberta: muda o visual do painel e tira o input
    // catcher de cena (ver _setLauncherOpen()).
    this._launcherOpen = false;
    this._icons = new Map();
    // Map SEPARADO do _icons: os recentes não entram em _iconOrder, nem
    // no DnD, nem na ordem persistida — são uma vitrine derivada do
    // histórico, não itens da dock.
    this._recentIcons = new Map();
    this._iconOrder = [];
    this._watchedWindows = new Set();
    this._signals = new SignalTracker();
    // SignalTracker dedicado para 'windows-changed' por app — re-bound a
    // cada _refresh() pra acompanhar a lista atual de apps rodando.
    this._appWindowSignals = new SignalTracker();
    this._panelSize = { w: 0, h: 0 };
    this._showAppsIcon = null;
    this._overviewDashHider = new OverviewDashHider();
    this._attentionTracker = new AttentionTracker();
    this._attentionTracker.addListener(() => this._notifyAttention());

    this._container = new St.Bin({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
      can_focus: false,
      reactive: true,
    });
    // Defesa: se um clique cair na área do container mas não acertar
    // nenhum filho reactive (ex: pixel "vazio" do headroom), consumimos
    // o evento aqui pra que ele não vaze pra janela atrás do dock.
    // Só consumimos o evento quando ele nasceu no próprio container (o
    // pixel "vazio" do headroom). Se nasceu num filho, precisa propagar:
    // no GNOME 49+ o St.Button detecta clique via ClutterClickGesture, e
    // um EVENT_STOP vindo do ancestral cancela o gesture antes de virar
    // 'clicked' — o que deixava todo o dock sem resposta ao botão 1.
    const stopIfOwnPixel = (actor, event) => {
      const onSelf = event.get_source?.() === actor;
      return onSelf ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    };
    this._container.connect("button-press-event", stopIfOwnPixel);
    // No release, esse mesmo pixel vazio também FECHA a grade de apps
    // quando ela está aberta: o container tem a largura inteira do
    // monitor, então a faixa ao lado da pílula é "fora da dock" para
    // qualquer efeito — e o gesto de fechar clicando fora não pode morrer
    // só porque o clique caiu nessa faixa em vez de no overlay. O
    // EVENT_STOP continua valendo: o clique não pode vazar para a janela
    // atrás.
    this._container.connect("button-release-event", (actor, event) => {
      if (stopIfOwnPixel(actor, event) === Clutter.EVENT_PROPAGATE)
        return Clutter.EVENT_PROPAGATE;
      this._appsLauncher?.close();
      return Clutter.EVENT_STOP;
    });

    this._panel = new St.BoxLayout({
      style_class: "arcdock-panel",
      vertical: false,
      reactive: true,
      track_hover: true,
    });
    // O tema escuro é só uma classe A MAIS no painel: o CSS do claro
    // continua valendo e o escuro entra como override, inclusive para os
    // filhos (dots, barra, badge, indicador de drop) via seletor
    // descendente. Ver stylesheet.css.
    if (this._theme === DockTheme.DARK)
      this._panel.add_style_class_name("arcdock-panel-dark");
    // O tooltip é adicionado ao uiGroup, não ao painel — nenhum seletor
    // descendente o alcança, então o tema vai por aqui (ver iconAnimation).
    setTooltipTheme(this._theme);

    // O blur vive num actor próprio ATRÁS do painel, recuado BLUR_INSET
    // em todos os lados (ver config.js): como Shell.BlurEffect pinta um
    // retângulo e ignora o border-radius, aplicá-lo direto no painel
    // fazia o borrão escapar pelos cantos e desenhar um quadrado atrás
    // da dock. Recuado, o retângulo do blur cabe inteiro dentro do
    // contorno arredondado e nada aparece para fora dele.
    this._blurBackdrop = new St.Widget({
      style_class: "arcdock-blur-backdrop",
      reactive: false,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    applyGlass(this._blurBackdrop);

    // O alinhamento vai NO FILHO, não no St.Bin: desde o St-18 (GNOME 49)
    // StBin não tem mais as properties x-align/y-align, então o
    // `y_align: END` do container caía no Clutter.Actor do PRÓPRIO Bin —
    // um chrome de posição fixa, onde não significa nada. O glassHost
    // ficava sem âncora e o headroom reservado para o tooltip/magnificação
    // (totalH − altura do painel) sobrava EMBAIXO da pílula, não em cima:
    // é isso, e não o BOTTOM_MARGIN, que abria a distância até a borda
    // da tela. Com END o painel encosta no fundo do container, que
    // _reposition() já coloca a BOTTOM_MARGIN do fim do monitor — a
    // mesma geometria que _liveRect() e _iconRectForWindow() assumem.
    const glassHost = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      reactive: false,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
    });
    glassHost.add_child(this._blurBackdrop);
    glassHost.add_child(this._panel);
    this._container.set_child(glassHost);

    // Três seções, na ordem do macOS:
    //
    //   apps (fixados ou rodando) | recentes | pastas + botão Applications
    //
    // O botão é o FIM da dock, não uma seção própria: fica colado nas
    // pastas e nunca ganha divisor. Cada divisor só aparece quando há
    // conteúdo dos dois lados (ver _syncContentVisibility), então sem
    // recentes a fila vira "apps | pastas + botão" e sem pastas
    // "apps + botão".
    //
    // Apps e pastas são caixas SEPARADAS, e não uma só ordenada por
    // _iconOrder, porque a seção de recentes entra no meio delas — um
    // único BoxLayout não tem como abrir espaço aí. _iconOrder continua
    // sendo uma lista só (é a ordem persistida no store) e cada caixa
    // consome dela apenas os ids do seu tipo.
    this._appsBox = new St.BoxLayout({ vertical: false });
    this._appsBox._delegate = this._dropDelegate(this._appsBox);
    this._panel.add_child(this._appsBox);

    this._recentsSeparator = this._createSeparator();
    this._panel.add_child(this._recentsSeparator);

    // Os recentes não recebem `_delegate`: são voláteis, não estão em
    // _iconOrder e não têm posição para guardar, então nada pode ser
    // solto aqui.
    this._recentsBox = new St.BoxLayout({ vertical: false, visible: false });
    this._panel.add_child(this._recentsBox);

    this._foldersSeparator = this._createSeparator();
    this._panel.add_child(this._foldersSeparator);

    this._foldersBox = new St.BoxLayout({ vertical: false, visible: false });
    this._foldersBox._delegate = this._dropDelegate(this._foldersBox);
    this._panel.add_child(this._foldersBox);

    // Criado ANTES do ShowAppsIcon porque é o botão quem recebe a ação:
    // sem o launcher em mãos não dá para decidir se o clique abre a
    // grade ou cai no overview. Isso o coloca antes de this._autoHide,
    // que só nasce mais adiante no construtor — daí o `?.` no
    // onVisibilityChanged. Na prática o callback só dispara em clique do
    // usuário, muito depois de o construtor terminar; o `?.` é só a
    // garantia de que a ordem aqui nunca vira exceção.
    this._appsLauncher =
      this._appsLauncherParams?.enabled && params.settings
        ? new AppsLauncher({
            settings: params.settings,
            columns: this._appsLauncherColumns,
            theme: this._theme,
            // Enquanto a grade está aberta a dock fica visível, como no
            // macOS: o auto-hide não pode engoli-la por baixo dela.
            onVisibilityChanged: (open) => {
              this._autoHide?.setForceShown(open);
              // ...e visível POR CIMA dela: o launcher se joga para o topo
              // do uiGroup a cada abertura (a ordem de criação entre ele e
              // a chrome da dock não é garantida), então quem abre por
              // último ganha. Subir a dock depois disso é o que mantém a
              // pílula na frente da grade, como no macOS.
              if (open) this._raiseToTop();
              this._setLauncherOpen(open);
            },
            // Altura que a dock ocupa na borda de baixo, para o launcher
            // não desenhar a última linha de ícones debaixo dela.
            dockInset: () => this._launcherDockInset(),
          })
        : null;

    this._showAppsIcon = new ShowAppsIcon({
      iconSize: this._size.ICON,
      // Só quando o launcher existe: sem ele NADA é passado, e o botão
      // usa seu próprio fallback para o overview.
      ...(this._appsLauncher
        ? { onActivate: () => this._appsLauncher.toggle() }
        : {}),
    });
    this._panel.add_child(this._showAppsIcon);
    // O ícone é sempre criado — assim _suppressHover/_resumeHover/destroy
    // seguem sem condicionais — e apenas escondido quando a preferência
    // está desligada: St.BoxLayout não aloca filhos invisíveis, então ele
    // também não ocupa espaço no painel.
    this._showAppsIcon.visible = this._showAppsButton;

    if (this._magnificationParams?.enabled) {
      this._magnification = new Magnification(
        this._panel,
        () => this._magnifiableIcons(),
        {
          scale: this._magnificationScale,
          falloff: this._magnificationParams.falloff,
        },
      );
    }

    Main.layoutManager.addChrome(this._container, {
      affectsStruts: false,
      trackFullscreen: false,
    });

    this._inputCatcher = new InputCatcher(() => this._autoHide.hideNow());

    this._raiseToTop();

    this._autoHide = new AutoHide(
      this._container,
      (state) => this._liveRect(state),
      () => {
        const hasWindow = this._hasVisibleWindowOnPrimary();
        this._updateInputCatcher(hasWindow);
        return hasWindow;
      },
    );

    // Criada ANTES dos signals que chamam _reposition(): é lá que a
    // geometria dos ícones é reenviada às janelas. Sem settings a classe
    // não teria como observar a própria key, então a dock degrada para as
    // animações padrão do Shell em vez de amarrá-las a nada.
    this._windowAnimations = params.settings
      ? new WindowAnimations(params.settings, (window) =>
          this._iconRectForWindow(window),
        )
      : null;

    // Criado DEPOIS do AutoHide: o estado inicial é aplicado na hora, e
    // sem settings a dock simplesmente nunca se esconde por fullscreen.
    if (params.settings) {
      this._fullscreenWatcher = new FullscreenWatcher(
        params.settings,
        (active) => {
          this._fullscreenActive = active;
          this._updateForceHidden();
        },
      );
      this._fullscreenActive = this._fullscreenWatcher.active;
      this._updateForceHidden();
    }

    this._signals.connect(this._container, "notify::visible", () => {
      this._updateInputCatcher(this._hasVisibleWindowOnPrimary());
    });

    this._signals.connect(Main.layoutManager, "monitors-changed", () =>
      this._reposition(),
    );
    this._signals.connect(this._panel, "notify::height", () =>
      this._reposition(),
    );
    this._signals.connect(this._appSystem, "app-state-changed", (_sys, app) => {
      this._recordRecentApp(app);
      this._refresh();
    });
    this._signals.connect(this._appSystem, "installed-changed", () =>
      this._refresh(),
    );
    this._signals.connect(global.display, "window-created", () =>
      this._refresh(),
    );
    this._signals.connect(global.display, "restacked", () =>
      this._raiseToTop(),
    );
    this._signals.connect(Main.overview, "showing", () =>
      this._setOverviewShown(true),
    );
    this._signals.connect(Main.overview, "shown", () =>
      this._setOverviewShown(true),
    );
    this._signals.connect(Main.overview, "hidden", () =>
      this._setOverviewShown(false),
    );
    if (Main.overview.visible) this._setOverviewShown(true);

    // Mudança feita nas preferências (outro processo) chega por aqui e
    // vira um _refresh() incremental — nada de recriar a dock.
    this._itemsUnsubscribe =
      this._items?.onChanged(() => this._onItemsChanged()) ?? null;

    this._refresh();
  }

  destroy() {
    // Cada passo em try/catch isolado: se um falhar (ex: signal já
    // desconectado pelo shell durante session-mode change), os passos
    // críticos seguintes — especialmente removeChrome — ainda rodam.
    // Sem isso, uma exception em qualquer ponto deixa chrome zumbi
    // que faz o enable() seguinte falhar e a extensão fica INACTIVE.
    const safe = (fn) => { try { fn(); } catch (_) {} };

    safe(() => Cursor.setDefault());
    safe(() => this._hideDropIndicator());
    // PRIMEIRO de todos, e a dock é destruída e recriada o tempo todo
    // (qualquer preferência, monitors-changed, wake, a série de reparo)
    // — inclusive com a grade ABERTA na tela, o que aqui é rotina e não
    // exceção. Enquanto o launcher existe ele pode ter um grab modal de
    // pé e pode chamar de volta callbacks que resolvem contra actors da
    // dock (o onVisibilityChanged toca o auto-hide). Destruí-lo depois
    // do resto é a receita para grab órfão e exceção em callback
    // pós-destroy; destruí-lo aqui fecha tudo isso com a dock ainda
    // inteira por baixo.
    safe(() => this._appsLauncher?.destroy());
    this._appsLauncher = null;
    safe(() => this._autoHide?.destroy());
    this._autoHide = null;
    // Antes dos ícones: enquanto o patch do predicado de animação estiver
    // de pé o Shell ainda pode perguntar por um retângulo, e o destroy
    // dele é justamente quem desfaz o patch e limpa a geometria já
    // enviada às janelas.
    safe(() => this._windowAnimations?.destroy());
    this._windowAnimations = null;
    safe(() => this._fullscreenWatcher?.destroy());
    this._fullscreenWatcher = null;
    // Antes dos ícones: o destroy dele desfaz escala e largura em cada um
    // deles, e depois de destruídos não haveria em quem desfazer.
    safe(() => this._magnification?.destroy());
    this._magnification = null;
    safe(() => this._signals.disconnectAll());
    safe(() => this._appWindowSignals.disconnectAll());
    safe(() => this._itemsUnsubscribe?.());
    this._itemsUnsubscribe = null;
    safe(() => this._items?.destroy());
    this._items = null;
    safe(() => this._recents?.destroy());
    this._recents = null;
    for (const icon of this._icons.values()) safe(() => icon.destroy());
    this._icons.clear();
    for (const icon of this._recentIcons.values()) safe(() => icon.destroy());
    this._recentIcons.clear();
    safe(() => this._showAppsIcon?.destroy());
    this._showAppsIcon = null;
    safe(() => this._overviewDashHider?.destroy());
    this._overviewDashHider = null;
    safe(() => this._attentionTracker?.destroy());
    this._attentionTracker = null;
    safe(() => this._inputCatcher?.destroy());
    this._inputCatcher = null;
    safe(() => {
      if (this._container) {
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
      }
    });
    this._container = null;
    // Destruídos junto com o container (subtree), só soltamos a referência.
    this._blurBackdrop = null;
    this._recentsBox = null;
    this._foldersBox = null;
    this._recentsSeparator = null;
    this._foldersSeparator = null;
  }

  _refresh() {
    // Reescuta 'windows-changed' em todos os apps rodando. Esse é o
    // signal que dispara quando o WindowTracker termina de associar uma
    // janela recém-criada ao seu Shell.App — sem isso, o dot só aparece
    // depois de outro signal coincidir (workspace change, focus, etc).
    this._appWindowSignals.disconnectAll();
    const runningApps = this._appSystem.get_running();
    for (const app of runningApps) {
      this._appWindowSignals.connect(app, "windows-changed", () =>
        this._refresh(),
      );
    }

    const windowsByApp = new Map();
    for (const app of runningApps) {
      for (const window of app.get_windows()) {
        if (window.is_skip_taskbar()) continue;
        if (window.get_window_type() !== Meta.WindowType.NORMAL) continue;
        this._watchWindow(window);
        const appId = app.get_id();
        if (!windowsByApp.has(appId)) windowsByApp.set(appId, []);
        windowsByApp.get(appId).push({ window, app });
      }
    }
    for (const windows of windowsByApp.values())
      windows.sort((a, b) => this._windowSortKey(b.window) - this._windowSortKey(a.window));

    const entries = [];
    const pinnedSet = new Set();
    for (const id of this._items?.list() ?? []) {
      const parsed = parseId(id);
      // Id malformado ou de tipo que ainda não sabemos renderizar
      // (ItemType.GROUP é a etapa 2) é pulado em silêncio: não pode
      // quebrar a dock nem ser removido do store por isso.
      if (!parsed) continue;
      if (parsed.type === ItemType.APP) {
        const appId = parsed.value;
        pinnedSet.add(appId);
        const app = this._appSystem.lookup_app(appId);
        if (!app) continue;
        const runningWindows = windowsByApp.get(appId) ?? [];
        const running = runningWindows[0] ?? {};
        entries.push({
          id,
          kind: "app",
          window: running.window ?? null,
          windows: runningWindows.map(({ window }) => window),
          app,
          pinned: true,
          running: !!running.window,
        });
      } else if (parsed.type === ItemType.FOLDER) {
        entries.push({ id, kind: "folder", path: parsed.value });
      }
    }

    for (const windows of windowsByApp.values()) {
      const { window, app } = windows[0];
      const appId = app.get_id();
      if (pinnedSet.has(appId)) continue;
      entries.push({
        id: this._appIconId(appId),
        kind: "app",
        window,
        windows: windows.map(({ window }) => window),
        app,
        pinned: false,
        running: true,
      });
    }

    const seen = new Set();
    for (const entry of entries) {
      const { id } = entry;
      seen.add(id);
      const existing = this._icons.get(id);
      if (existing) {
        // As duas classes têm setTarget com assinaturas diferentes; o
        // tipo vem do id, então nunca chamamos a errada.
        if (entry.kind === "folder") existing.setTarget(entry.path);
        else
          existing.setTarget(
            entry.window,
            entry.windows,
            entry.app,
            entry.pinned,
            entry.running,
          );
        continue;
      }
      const icon =
        entry.kind === "folder"
          ? this._createFolderIcon(entry)
          : this._createAppIcon(entry);
      this._connectIcon(icon);
      this._icons.set(id, icon);
      // Nasce já na caixa da sua seção; _applyOrder() logo abaixo só
      // acerta a posição dentro dela.
      this._boxForId(id).add_child(icon);
    }
    for (const [id, icon] of this._icons) {
      if (!seen.has(id)) {
        icon.destroy();
        this._icons.delete(id);
      }
    }
    this._syncOrder(seen);
    this._applyOrder();
    // Depois do _applyOrder: os recentes são exatamente o que a seção
    // principal NÃO mostra, então precisam do conjunto já resolvido.
    this._refreshRecents(seen);
    this._syncContentVisibility();
    this._reposition();
  }

  /**
   * Registra no histórico o app que ACABOU de passar a rodar.
   *
   * Vem do 'app-state-changed' e não de um diff do conjunto de apps
   * rodando entre dois _refresh(): o diff precisaria de um snapshot, e o
   * snapshot nasce vazio a cada dock nova — e esta dock é recriada a cada
   * mudança de preferência, troca de monitor, wake e série de reparo do
   * enable(). O primeiro refresh depois de cada uma dessas recriações
   * carimbaria TODOS os apps já abertos como "acabou de abrir",
   * reembaralhando o histórico sem que nada tenha sido aberto. O sinal
   * fala de transições, então só dispara quando algo realmente abriu.
   *
   * RUNNING (e não STARTING) é o estado em que o Shell.App já tem a
   * primeira janela associada — é o "abriu de verdade" do macOS.
   */
  _recordRecentApp(app) {
    if (!app || app.state !== Shell.AppState.RUNNING) return;
    const appId = app.get_id();
    if (appId) this._recents?.push(appId);
  }

  /**
   * Reconstrói a seção de recentes com o mesmo refresh incremental da
   * seção principal (atualiza os que ficam, cria os que entram, destrói
   * os que saem) — recriar tudo faria a animação de entrada tocar de novo
   * em ícones que nunca saíram da tela.
   */
  _refreshRecents(mainIds) {
    const entries = this._recentEntries(mainIds);
    const wanted = new Set(entries.map((entry) => entry.id));
    for (const [id, icon] of this._recentIcons) {
      if (wanted.has(id)) continue;
      icon.destroy();
      this._recentIcons.delete(id);
    }
    entries.forEach((entry, index) => {
      const existing = this._recentIcons.get(entry.id);
      if (existing) {
        existing.setTarget(null, [], entry.app, false, false);
        this._recentsBox.set_child_at_index(existing, index);
        return;
      }
      const icon = this._createAppIcon(entry);
      this._connectIcon(icon);
      this._recentIcons.set(entry.id, icon);
      this._recentsBox.insert_child_at_index(icon, index);
    });
  }

  /** Os até RECENT.VISIBLE primeiros do histórico que cabem na vitrine. */
  _recentEntries(mainIds) {
    if (!this._showRecentApps) return [];

    const pinnedIds = new Set(this._items?.list() ?? []);
    const entries = [];
    for (const appId of this._recents?.list() ?? []) {
      if (entries.length >= RECENT.VISIBLE) break;
      const id = this._appIconId(appId);
      // Fixado ou já desenhado na seção principal (rodando como volátil):
      // o app já tem um ícone, e um segundo aqui só confundiria. Quando
      // ele fecha, some de lá e cai naturalmente nesta seção.
      if (pinnedIds.has(id) || mainIds.has(id)) continue;
      const app = this._appSystem.lookup_app(appId);
      // Desinstalado: pulado só na EXIBIÇÃO. Removê-lo do histórico
      // apagaria a memória de um app que pode voltar em minutos (um
      // flatpak no meio de um update não resolve em lookup_app).
      if (!app) continue;
      // Rodando sem janela normal (só ícone de bandeja, janela
      // skip-taskbar) não chega em mainIds, mas também não é "recente".
      if (app.state !== Shell.AppState.STOPPED) continue;
      entries.push({
        id,
        kind: "app",
        window: null,
        windows: [],
        app,
        pinned: false,
        running: false,
      });
    }
    return entries;
  }

  _createAppIcon(entry) {
    return new DockIcon(entry.window, entry.app, {
      id: entry.id,
      iconSize: this._size.ICON,
      windows: entry.windows,
      pinned: entry.pinned,
      running: entry.running,
      useThemeRunningDotColor: this._useThemeRunningDotColor,
      indicatorStyle: this._indicatorStyle,
      indicatorDotSize:
        this._theme === DockTheme.DARK
          ? INDICATOR.DOT_SIZE
          : INDICATOR.DOT_SIZE_LIGHT,
      clickToMinimize: this._clickToMinimize,
      onTogglePinned: (source) => this._togglePinned(source.app),
      onMenuStateChanged: (isOpen) => this._onIconMenuStateChanged(isOpen),
      attentionTracker: this._attentionTracker,
    });
  }

  /**
   * O fio vertical que separa duas seções do painel. Nasce invisível:
   * quem decide é _syncContentVisibility(), e só há o que separar quando
   * as duas seções vizinhas têm conteúdo.
   */
  _createSeparator() {
    const separator = new St.Widget({
      style_class: "arcdock-separator",
      reactive: false,
      width: RECENT.SEPARATOR_WIDTH,
      height: Math.round(this._size.ICON * RECENT.SEPARATOR_HEIGHT_RATIO),
      // Sem isto o BoxLayout estica o fio até a altura total da linha,
      // que inclui o espaço do indicador de app rodando.
      y_expand: false,
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
    });
    // translation_y e não margem: é um deslocamento de pintura, não muda
    // a alocação nem a altura pedida pelo painel.
    separator.translation_y = RECENT.SEPARATOR_Y_OFFSET;
    return separator;
  }

  _createFolderIcon(entry) {
    return new FolderIcon(entry.path, {
      id: entry.id,
      iconSize: this._size.ICON,
      onRemove: (source) => this._removeItem(source.id),
      onMenuStateChanged: (isOpen) => this._onIconMenuStateChanged(isOpen),
    });
  }

  /**
   * Menu de contexto de um ícone abriu ou fechou.
   *
   * Além de travar o auto-hide enquanto ele está aberto (o ponteiro sai
   * da live area da dock para ir até o item), a ABERTURA fecha a grade de
   * apps: o actor do menu nasce no uiGroup junto com o ícone, ou seja
   * ABAIXO do overlay do launcher no z-order, e apareceria escondido
   * atrás dele — com um grab próprio de pé e nada na tela.
   */
  _onIconMenuStateChanged(isOpen) {
    this._autoHide?.setForceShown(isOpen);
    if (isOpen) this._appsLauncher?.close();
  }

  // Vale para qualquer IconButton (app ou pasta): sem isso o hover
  // continuaria ativo durante o arrasto e o indicador de drop ficaria
  // órfão no fim dele. O clique é conectado aqui pelo mesmo motivo de
  // ser um só lugar para as duas seções (principal e recentes).
  _connectIcon(icon) {
    // Clique que ATIVA (esquerdo ou meio; o direito abre menu e nem chega
    // a emitir 'clicked') fecha a grade, como no macOS: o app vem para a
    // frente e o Launchpad sai de cena. Conectado depois do handler
    // interno do IconButton, então roda com a ativação já feita — quem
    // devolve o teclado para a janela é o popModal do close().
    this._signals.connect(icon, "clicked", () => this._appsLauncher?.close());
    this._signals.connect(icon._draggable, "drag-begin", () =>
      this._suppressHover(),
    );
    this._signals.connect(icon._draggable, "drag-end", () => {
      this._hideDropIndicator();
      this._resumeHover();
    });
    this._signals.connect(icon._draggable, "drag-cancelled", () => {
      this._hideDropIndicator();
      this._resumeHover();
    });
  }

  _removeItem(id) {
    if (!id) return;
    this._items?.remove(id);
    this._refresh();
  }

  // O store notifica também as escritas feitas por nós mesmos. Refazer
  // o layout por causa do próprio eco é, na melhor das hipóteses,
  // trabalho perdido; no pior — durante o drop — recalcularia a ordem
  // no meio do arrasto. Ignoramos exatamente UMA notificação idêntica
  // ao que acabamos de escrever e zeramos o snapshot em seguida, para
  // que uma mudança externa posterior (mesmo que volte ao mesmo valor)
  // volte a ser processada normalmente.
  _onItemsChanged() {
    if (this._pendingSelfWrite !== null) {
      const pending = this._pendingSelfWrite;
      this._pendingSelfWrite = null;
      if (this._serializeItems(this._items?.list() ?? []) === pending) return;
    }
    this._refresh();
  }

  _serializeItems(ids) {
    return ids.join("\u001f");
  }

  _watchWindow(window) {
    const id = window.get_stable_sequence();
    if (this._watchedWindows.has(id)) return;
    this._watchedWindows.add(id);
    this._signals.connect(window, "unmanaged", () => {
      this._watchedWindows.delete(id);
      this._refresh();
    });
  }

  _notifyAttention() {
    for (const icon of this._allIcons())
      icon.refreshAttention?.();
  }

  /** Todo ícone de app/pasta vivo, das duas seções. */
  _allIcons() {
    return [...this._icons.values(), ...this._recentIcons.values()];
  }

  /**
   * Botões que a magnificação infla, na ORDEM VISUAL — ela reconstrói a
   * geometria de repouso a partir dessa ordem.
   *
   * Lido dos children das caixas (e não de _iconOrder) porque é a ordem
   * que está de fato na tela: cobre o indicador de drop, os recentes e
   * qualquer ícone criado no meio de um _refresh(). O separador fica de
   * fora: só ícone incha.
   */
  _magnifiableIcons() {
    const icons = [];
    for (const box of [this._appsBox, this._recentsBox, this._foldersBox]) {
      for (const child of box?.get_children() ?? [])
        if (child instanceof IconButton) icons.push(child);
    }
    if (this._showAppsIcon?.visible) icons.push(this._showAppsIcon);
    return icons;
  }

  _togglePinned(app) {
    const appId = app.get_id();
    if (!appId) return;
    this._items?.toggle(makeId(ItemType.APP, appId));
    this._refresh();
  }

  _appIconId(appId) {
    return makeId(ItemType.APP, appId);
  }

  _windowSortKey(window) {
    if (typeof window.get_user_time === "function") {
      const userTime = window.get_user_time();
      if (userTime) return userTime;
    }
    return window.get_stable_sequence();
  }

  // Duas camadas de "vazio": uma caixa sem ícones some (senão o painel
  // ficaria com o padding dela); sem ícone NENHUM e sem o botão
  // Applications o painel inteiro não teria nada dentro, e uma pílula de
  // vidro vazia subindo na borda da tela é pior do que dock nenhuma.
  //
  // Esconder o _container à mão brigaria com o AutoHide, que faz
  // show()/hide() nele a cada tick; o mecanismo próprio dele para "não
  // apareça" é setForceHidden(). Como o overview usa o mesmo interruptor,
  // os dois motivos passam por _updateForceHidden() e nenhum desliga o
  // outro ao sair.
  _syncContentVisibility() {
    let folders = 0;
    // Pelo id, a mesma fonte que _boxForId usa para decidir a caixa —
    // contar por classe de ícone poderia divergir dela.
    for (const id of this._icons.keys())
      if (this._boxForId(id) === this._foldersBox) folders++;
    const hasApps = this._icons.size - folders > 0;
    const hasFolders = folders > 0;
    const hasRecents = this._recentIcons.size > 0;

    this._appsBox.visible = hasApps;
    this._recentsBox.visible = hasRecents;
    this._foldersBox.visible = hasFolders;
    // Um divisor só existe entre duas seções COM conteúdo: sem nada à
    // esquerda ele vira um fio solto na borda do painel, e sem nada à
    // direita ele fica encostado no botão Applications separando o botão
    // do nada.
    this._recentsSeparator.visible = hasApps && hasRecents;
    this._foldersSeparator.visible = hasFolders && (hasApps || hasRecents);
    this._isEmpty =
      !hasApps && !hasRecents && !hasFolders && !this._showAppsButton;
    this._updateForceHidden();
  }

  _setOverviewShown(shown) {
    this._overviewShown = shown;
    this._updateForceHidden();
  }

  _updateForceHidden() {
    this._autoHide?.setForceHidden(
      this._overviewShown || this._isEmpty || this._fullscreenActive,
    );
  }

  // _iconOrder cobre TODOS os ícones visíveis, inclusive apps rodando
  // não fixados (voláteis); o store cobre só os persistidos. Ids novos
  // que o store conhece entram na posição que a ordem persistida lhes
  // dá em relação aos vizinhos já presentes; os voláteis vão para o fim.
  _syncOrder(currentIds) {
    this._iconOrder = this._iconOrder.filter((id) => currentIds.has(id));
    const inOrder = new Set(this._iconOrder);
    const newIds = [...currentIds].filter((id) => !inOrder.has(id));
    if (!newIds.length) return;

    const storeIndex = new Map(
      (this._items?.list() ?? []).map((id, idx) => [id, idx]),
    );
    const volatileIds = [];
    const persistedIds = newIds
      .filter((id) => storeIndex.has(id))
      .sort((a, b) => storeIndex.get(a) - storeIndex.get(b));
    for (const id of newIds) if (!storeIndex.has(id)) volatileIds.push(id);

    for (const id of persistedIds) {
      const myIdx = storeIndex.get(id);
      let after = -1;
      let before = -1;
      this._iconOrder.forEach((other, i) => {
        const otherIdx = storeIndex.get(other);
        if (otherIdx === undefined) return;
        if (otherIdx < myIdx) after = i;
        else if (before === -1) before = i;
      });
      if (after !== -1) this._iconOrder.splice(after + 1, 0, id);
      else if (before !== -1) this._iconOrder.splice(before, 0, id);
      else this._iconOrder.push(id);
    }
    this._iconOrder.push(...volatileIds);
  }

  // Uma lista de ordem, duas caixas: _iconOrder mistura apps e pastas
  // (é a ordem que o store persiste), mas cada tipo mora na sua seção.
  // Cada caixa tem o seu próprio contador, então o que _iconOrder dita
  // aqui é a ordem RELATIVA dentro de cada seção.
  _applyOrder() {
    const nextIndex = new Map();
    for (const id of this._iconOrder) {
      const icon = this._icons.get(id);
      if (!icon) continue;
      const box = this._boxForId(id);
      const idx = nextIndex.get(box) ?? 0;
      nextIndex.set(box, idx + 1);
      const parent = icon.get_parent();
      if (parent !== box) {
        parent?.remove_child(icon);
        box.insert_child_at_index(icon, idx);
      } else {
        box.set_child_at_index(icon, idx);
      }
      icon.show();
      icon.opacity = 255;
    }
  }

  // A seção onde um id mora, decidida pelo TIPO do id e não pela classe
  // do ícone: isso vale antes de o ícone existir (_refresh) e depois de
  // ele morrer (_reorder mexe em ids).
  _boxForId(id) {
    return parseId(id)?.type === ItemType.FOLDER
      ? this._foldersBox
      : this._appsBox;
  }

  /**
   * Alvo de drop de UMA caixa.
   *
   * Cada caixa precisa do seu porque o DND entrega ao handleDragOver as
   * coordenadas já convertidas para o espaço do alvo mas não entrega o
   * alvo: com o mesmo `this` nas duas caixas, `x` seria ambíguo — os
   * mesmos 40px podem cair sobre o segundo app ou sobre a primeira pasta.
   */
  _dropDelegate(box) {
    return {
      handleDragOver: (source, _actor, x) =>
        this._handleDragOver(box, source, x),
      acceptDrop: (source, _actor, x) => this._acceptDrop(box, source, x),
    };
  }

  _handleDragOver(box, source, x) {
    if (!this._acceptsDrop(box, source)) return DND.DragMotionResult.NO_DROP;
    this._showDropIndicator(box);
    this._moveDropIndicator(this._dropIndexAt(box, x));
    return DND.DragMotionResult.MOVE_DROP;
  }

  _acceptDrop(box, source, x) {
    if (!this._acceptsDrop(box, source)) return false;
    const targetIndex = this._dropIndexAt(box, x);
    this._hideDropIndicator();
    this._reorder(source.id, targetIndex, box);
    return true;
  }

  /**
   * Uma seção só aceita o que é dela: arrastar um app sobre a caixa de
   * pastas (ou o contrário) recusa o drop, porque a seção é dada pelo
   * tipo do item e mudá-la por arrasto não significa nada.
   */
  _acceptsDrop(box, source) {
    return this._isReorderable(source) && this._boxForId(source.id) === box;
  }

  /**
   * IconButton e não DockIcon: ícones de pasta (e futuros grupos) também
   * precisam poder ser reordenados; sources externos ao dock continuam
   * barrados.
   *
   * O teste de _iconOrder cobre os recentes. Um IconButton é arrastável
   * por construção (o próprio _init chama makeDraggable e não oferece
   * como desligar), então quem tem de recusar é o alvo do drop: sem isso
   * arrastar um recente desenharia o indicador prometendo uma posição na
   * caixa principal que _reorder() ignoraria — o id nunca está em
   * _iconOrder. NO_DROP dá o cursor certo e devolve o ícone ao lugar.
   */
  _isReorderable(source) {
    return source instanceof IconButton && this._iconOrder.includes(source.id);
  }

  _suppressHover() {
    // A magnificação sai de cena junto com o hover: durante o arrasto os
    // ícones precisam estar na largura natural, que é a base de
    // _dropIndexAt(), e um painel que se remexe sob o cursor tornaria o
    // alvo do drop imprevisível.
    this._magnification?.setEnabled(false);
    for (const a of this._hoverTargets()) {
      resetHoverPress(a);
      a.track_hover = false;
    }
    Cursor.setDefault();
  }

  _resumeHover() {
    for (const a of this._hoverTargets()) a.track_hover = true;
    this._magnification?.setEnabled(true);
  }

  _hoverTargets() {
    const targets = this._allIcons();
    if (this._showAppsIcon) targets.push(this._showAppsIcon);
    return targets;
  }

  _showDropIndicator(box) {
    if (this._dropIndicator?.get_parent() === box) return;
    // Trocou de caixa no meio do arrasto: o indicador é recriado no lugar
    // certo em vez de reparentado, para não deixar rastro na caixa antiga.
    this._hideDropIndicator();
    // y_expand:false + y_align:CENTER impede que o BoxLayout estique o
    // indicador para a altura total do ícone (que inclui o espaço do
    // running dot abaixo), mantendo-o como um quadrado perfeito.
    this._dropIndicator = new St.Widget({
      style_class: "arcdock-drop-indicator",
      width: this._size.ICON,
      height: this._size.ICON,
      y_expand: false,
      y_align: Clutter.ActorAlign.START,
    });
    box.add_child(this._dropIndicator);
  }

  _hideDropIndicator() {
    this._dropIndicator?.destroy();
    this._dropIndicator = null;
  }

  _moveDropIndicator(visualIndex) {
    const box = this._dropIndicator?.get_parent();
    if (!box) return;
    // Converte índice visual (só ícones visíveis) em índice absoluto de children.
    const children = box.get_children()
      .filter(c => c !== this._dropIndicator);
    let visCount = 0;
    for (let i = 0; i < children.length; i++) {
      if (!children[i].visible) continue;
      if (visCount === visualIndex) {
        box.set_child_at_index(this._dropIndicator, i);
        return;
      }
      visCount++;
    }
    box.set_child_at_index(this._dropIndicator, children.length);
  }

  // Índice DENTRO da seção `box` — não é índice de _iconOrder.
  _dropIndexAt(box, x) {
    let idx = 0;
    for (const child of box.get_children()) {
      if (child === this._dropIndicator) continue;
      if (!child.visible) continue; // ignora source (hidden durante drag)
      const center = child.x + child.width / 2;
      if (x < center) return idx;
      idx++;
    }
    return idx;
  }

  /**
   * `targetIndex` é a posição dentro da SEÇÃO que recebeu o drop;
   * _iconOrder é global e mistura as duas. A conversão é feita pelo
   * vizinho: o id que ocupa esse slot na seção marca o ponto de inserção
   * global, e um destino além do último slot vai logo depois do último id
   * da seção — assim o item nunca atravessa a fronteira entre seções.
   */
  _reorder(sourceId, targetIndex, box) {
    const fromIndex = this._iconOrder.indexOf(sourceId);
    if (fromIndex === -1) return;
    this._iconOrder.splice(fromIndex, 1);
    // Depois do splice, como o próprio targetIndex: o ícone arrastado
    // está escondido e _dropIndexAt() não o conta.
    const sectionIds = this._iconOrder.filter(
      (id) => this._boxForId(id) === box,
    );
    let at;
    if (!sectionIds.length) at = fromIndex; // era o único da seção
    else if (targetIndex >= sectionIds.length)
      at = this._iconOrder.indexOf(sectionIds[sectionIds.length - 1]) + 1;
    else at = this._iconOrder.indexOf(sectionIds[targetIndex]);
    this._iconOrder.splice(at, 0, sourceId);
    this._applyOrder();
    this._persistOrder();
  }

  // Persiste a nova ordem RELATIVA dos ids que o store já contém.
  // Arrastar nunca promove nada: um app rodando não fixado é volátil e
  // não entra no store. Ids que o store tem mas o dock não renderiza
  // (group:, ids futuros) ficam ancorados nas suas posições atuais —
  // reordenar não pode fazê-los desaparecer.
  _persistOrder() {
    if (!this._items) return;
    const storeIds = this._items.list();
    const inStore = new Set(storeIds);
    const reordered = this._iconOrder.filter((id) => inStore.has(id));
    if (reordered.length < 2) return;

    // Os slots permutados são exatamente as posições ocupadas por ids de
    // `reordered`, então a contagem casa por construção.
    const permuted = new Set(reordered);
    let next = 0;
    const merged = storeIds.map((id) =>
      permuted.has(id) ? reordered[next++] : id,
    );
    if (this._serializeItems(merged) === this._serializeItems(storeIds)) return;

    this._pendingSelfWrite = this._serializeItems(merged);
    this._items.setAll(merged);
  }

  _reposition() {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const [, naturalH] = this._panel.get_preferred_height(monitor.width);
    const h = Math.max(naturalH, this._size.ICON + 24);
    // A magnificação FIXA larguras maiores nos botões, então a largura
    // preferida do painel já vem com a folga do momento embutida. Tudo
    // que sai daqui (blur, live area, input catcher) é geometria de
    // REPOUSO — sem descontar a folga, um _refresh() disparado com o
    // ponteiro sobre a dock congelaria o retângulo do blur no tamanho
    // inflado e ele apareceria como um borrão maior que a pílula.
    const [, preferredW] = this._panel.get_preferred_width(h);
    const naturalW = Math.max(
      0,
      preferredW - (this._magnification?.extraWidth ?? 0),
    );

    // Headroom acima do panel: mantém espaço para affordances de hover
    // renderizadas fora do panel, como tooltip.
    //
    // A magnificação escala o host com pivot na base, então o ícone
    // cresce (S−1)·altura_do_host para CIMA do topo do painel. Somamos
    // esse termo aqui em vez de mexer em ANIM.HOVER_SCALE: aquele knob
    // vale para todo mundo, e este só existe quando o efeito está ligado.
    const magHeadroom =
      this._magnificationScale > 1
        ? Math.ceil((this._magnificationScale - 1) * this._size.ICON)
        : 0;
    const headroom =
      Math.abs(ANIM.HOVER_LIFT) +
      Math.ceil((ANIM.HOVER_SCALE - 1) * h) +
      magHeadroom +
      8;
    const totalH = h + headroom;

    this._container.set_size(monitor.width, totalH);
    this._panelSize = { w: naturalW, h };
    // O recuo vale nos QUATRO lados e sai da altura REAL da pílula
    // (naturalH), nunca de `h`: `h` carrega o piso ICON+24, bem maior que
    // o painel, e h - 2*BLUR_INSET dava de volta quase a altura inteira da
    // pílula — recuo vertical ~zero. Com isso os cantos do retângulo do
    // blur ficavam FORA do arco de PANEL_RADIUS e apareciam como um
    // quadrado quase transparente atrás da dock. O recuo r*(1-1/√2) só
    // inscreve o retângulo no canto redondo se valer nos dois eixos.
    this._blurBackdrop.set_size(
      Math.max(0, naturalW - 2 * BLUR_INSET),
      Math.max(0, naturalH - 2 * BLUR_INSET),
    );
    this._container.set_position(
      monitor.x,
      monitor.y + monitor.height - totalH - SIZE.BOTTOM_MARGIN,
    );
    this._autoHide.setHideDistance(h + SIZE.BOTTOM_MARGIN);
    this._inputCatcher?.fitBelow(
      monitor.x + (monitor.width - naturalW) / 2,
      monitor.y + monitor.height - h - SIZE.BOTTOM_MARGIN - 4,
      naturalW,
    );
    this._raiseToTop();
    Main.layoutManager.queueUpdateRegions?.();
    // Único ponto de sincronia da geometria de ícone: TODO caminho que
    // move ícone termina aqui — _refresh() fecha com _reposition(), e
    // 'monitors-changed' e o notify::height do painel estão ligados
    // direto nele. Chamar também no fim do _refresh() seria varrer as
    // janelas duas vezes pelo mesmo motivo.
    this._windowAnimations?.syncIconGeometry();
  }

  /**
   * Retângulo do ícone que representa a janela, em coordenadas de stage e
   * na posição de REPOUSO. Roda dentro do predicado de animação do Shell,
   * a cada map/minimize/destroy de qualquer janela da sessão: só buscas em
   * Map e uma leitura de geometria, e nada pode escapar daqui.
   */
  _iconRectForWindow(window) {
    if (!this._container || !window) return null;

    let app;
    try {
      app = Shell.WindowTracker.get_default().get_window_app(window);
    } catch (_) {
      // Janela já unmanaged: o wrapper sobrevive, o objeto não.
      return null;
    }
    const appId = app?.get_id?.();
    if (!appId) return null;

    // Os recentes têm Map próprio e o mesmo formato de id, então a mesma
    // chave serve para os dois — um app minimizado que só aparece na
    // vitrine de recentes também tem para onde encolher.
    const id = this._appIconId(appId);
    const icon = this._icons.get(id) ?? this._recentIcons.get(id);
    // `visible` e não `mapped`: com a dock escondida pelo auto-hide o
    // ícone está desmapeado, mas continua sendo o alvo certo. O que
    // precisa recusar é o ícone escondido pelo próprio drag.
    if (!icon?.visible) return null;

    const [x, y] = icon.get_transformed_position();
    const [width, height] = icon.get_transformed_size();
    if (!(width > 0) || !(height > 0)) return null;

    // O auto-hide anima translation_y no _container, e a posição
    // transformada já vem com ela embutida: escondida, a dock está
    // _hideDistance abaixo. Descontar devolve o lugar onde o usuário vê o
    // ícone quando a dock sobe — que é para onde a janela deve encolher,
    // mesmo minimizada com a dock em baixo.
    return {
      x,
      y: y - this._container.translation_y,
      width,
      height,
    };
  }

  /**
   * Espaço que a dock ocupa na borda de baixo do monitor, em px.
   *
   * Geometria de REPOUSO (`_panelSize.h`, que _reposition() já grava sem
   * a folga da magnificação) mais a margem até a borda — é a altura que o
   * usuário vê, e não a do container, que inclui o headroom invisível de
   * tooltip e zoom. Dock sem conteúdo não reserva nada: ela não sobe (ver
   * _syncContentVisibility()), então reservar espaço deixaria uma faixa
   * vazia embaixo da grade.
   */
  _launcherDockInset() {
    if (this._isEmpty) return 0;
    return (this._panelSize?.h ?? 0) + SIZE.BOTTOM_MARGIN;
  }

  /**
   * Grade de apps abriu ou fechou.
   *
   * A dock continua clicável por cima dela (o launcher toma o grab modal
   * no uiGroup, ver launcher.js), mas perde o corpo de vidro: sobram os
   * ícones flutuando, como o Dock do macOS sobre o Launchpad. São dois
   * caminhos porque são duas camadas diferentes — o painel troca de
   * classe e o CSS tira fundo, rim e sombra; o backdrop sai por
   * OPACIDADE, porque o que ele pinta é um Shell.BlurEffect, efeito de
   * actor que nenhum seletor alcança.
   *
   * A ida usa a duração da abertura da grade e a volta a do fechamento:
   * as duas coisas são o mesmo gesto e têm de andar juntas.
   */
  _setLauncherOpen(open) {
    this._launcherOpen = open;
    if (this._panel) {
      if (open) this._panel.add_style_class_name("arcdock-panel-transparent");
      else this._panel.remove_style_class_name("arcdock-panel-transparent");
    }
    if (this._blurBackdrop) {
      this._blurBackdrop.remove_all_transitions();
      this._blurBackdrop.ease({
        opacity: open ? 0 : 255,
        duration: open ? LAUNCHER.OPEN_MS : LAUNCHER.CLOSE_MS,
        mode: open
          ? Clutter.AnimationMode.EASE_IN_QUAD
          : Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    }
    this._updateInputCatcher(this._hasVisibleWindowOnPrimary());
  }

  _raiseToTop() {
    const parent = this._container?.get_parent();
    parent?.set_child_above_sibling(this._container, null);
    this._inputCatcher?.placeBelow(this._container);
  }

  _liveRect(state) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return null;

    const hotEdgeRect = {
      x: monitor.x,
      y: monitor.y + monitor.height - SIZE.HOT_EDGE,
      w: monitor.width,
      h: SIZE.HOT_EDGE,
    };

    if (state === State.SHOWN || state === State.SHOWING) {
      const horizontalBounds = this._dockHorizontalBounds(monitor);
      if (!horizontalBounds) return hotEdgeRect;

      const { h } = this._panelSize;
      if (!h) return hotEdgeRect;

      const cy = monitor.y + monitor.height - h - SIZE.BOTTOM_MARGIN;
      const dockRect = {
        x: horizontalBounds.x,
        y: cy - SIZE.LIVE_BUFFER,
        w: horizontalBounds.w,
        h: monitor.y + monitor.height - cy + SIZE.LIVE_BUFFER,
      };
      return [dockRect, hotEdgeRect];
    }

    return hotEdgeRect;
  }

  // Só a horizontal precisa de correção para a magnificação. Na VERTICAL
  // o retângulo atual já basta: o efeito só existe enquanto o ponteiro
  // está SOBRE o painel, e o painel inteiro (mais LIVE_BUFFER) está
  // dentro do retângulo — o ícone inflado sobe além dele, mas o ponteiro
  // que subir junto já saiu do painel e, por definição, deixou de
  // magnificar. Na horizontal a história é outra: o painel de fato fica
  // mais LARGO (as larguras dos ícones crescem e o BoxLayout cresce
  // junto), e _panelSize.w continua sendo o de repouso — só é recalculado
  // em _reposition(). Sem somar a folga, seguir com o ponteiro o último
  // ícone, que se afastou do centro, cairia fora da live area e agendaria
  // o auto-hide com o ponteiro ainda em cima da dock.
  _dockHorizontalBounds(monitor) {
    const { w } = this._panelSize;
    if (!w) return null;

    // O painel é centrado, então a folga se reparte igualmente nos dois
    // lados — basta ampliar a largura e recentrar.
    const live = w + (this._magnification?.extraWidth ?? 0);
    const x = monitor.x + Math.round((monitor.width - live) / 2);
    return {
      x: x - SIZE.LIVE_BUFFER,
      w: live + 2 * SIZE.LIVE_BUFFER,
    };
  }

  _updateInputCatcher(_hasWindow) {
    if (!this._inputCatcher) return;
    // Com a grade de apps aberta o catcher fica ACIMA do overlay dela (é
    // colado logo embaixo da dock no z-order), e um clique nele chamaria
    // hideNow() — a dock desceria por baixo da grade que a mantém à
    // vista. Enquanto a grade está aberta quem barra o clique fora da
    // dock é o escudo do launcher.
    if (this._launcherOpen || !this._container?.visible)
      this._inputCatcher.hide();
    else this._inputCatcher.show();
  }

  _hasVisibleWindowOnPrimary() {
    const workspace = global.workspace_manager.get_active_workspace();
    const primaryIndex = Main.layoutManager.primaryIndex;
    if (!workspace || primaryIndex === -1) return false;

    return workspace
      .list_windows()
      .some(
        (window) =>
          !window.minimized &&
          !window.is_skip_taskbar() &&
          window.get_monitor() === primaryIndex,
      );
  }
}
