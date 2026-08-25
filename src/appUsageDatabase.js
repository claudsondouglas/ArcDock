import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DATABASE_PATH = GLib.build_filenamev([
    GLib.get_home_dir(),
    'Documents',
    'arc',
    'apps.db',
]);

function helperPath() {
    const source = Gio.File.new_for_uri(import.meta.url);
    return source.get_parent().get_parent()
        .get_child('scripts')
        .get_child('app_usage_db.py')
        .get_path();
}

/**
 * Gravador assíncrono do uso de apps no ArcDock.
 *
 * O GNOME Shell não expõe SQLite pelo GObject Introspection nesta máquina,
 * então um helper curto usa o sqlite3 da biblioteca padrão do Python. Cada
 * gravação roda fora da thread do compositor; um disco lento nunca congela
 * clique, animação ou abertura de janela.
 */
export class AppUsageDatabase {
    constructor() {
        this.path = DATABASE_PATH;
        this._python = GLib.find_program_in_path('python3');
        this._helper = helperPath();
        this._warnedUnavailable = false;
        this._queue = [];
        this._running = false;
        this._enqueue(['init']);
    }

    recordClick(app, source) {
        const appId = app?.get_id?.() ?? '';
        return this.recordClickById(
            appId,
            app?.get_name?.() ?? '',
            source
        );
    }

    /** Registra um clique vindo de uma fronteira que não compartilha Shell.App. */
    recordClickById(appId, appName, source) {
        if (typeof appId !== 'string' || !appId) return false;
        return this._enqueue([
            'click',
            appId,
            typeof appName === 'string' ? appName : '',
            typeof source === 'string' ? source : '',
        ]);
    }

    recordOpened(app) {
        const appId = app?.get_id?.() ?? '';
        if (!appId) return;
        this._enqueue(['open', appId, app.get_name?.() ?? '']);
    }

    _enqueue(args) {
        if (!this._python || !this._helper) {
            if (!this._warnedUnavailable) {
                console.warn('[ArcDock] Python 3 indisponível; apps.db não será atualizado');
                this._warnedUnavailable = true;
            }
            return false;
        }
        this._queue.push(args);
        this._drain();
        return true;
    }

    _drain() {
        if (this._running || this._queue.length === 0) return;
        const args = this._queue.shift();
        this._running = true;

        let process;
        try {
            process = Gio.Subprocess.new(
                [this._python, this._helper, this.path, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            logError(error, '[ArcDock] não foi possível iniciar o gravador de uso');
            this._running = false;
            this._queue.length = 0;
            return;
        }

        process.communicate_utf8_async(null, null, (completed, result) => {
            try {
                const [, , stderr] = completed.communicate_utf8_finish(result);
                if (!completed.get_successful()) {
                    console.warn(
                        `[ArcDock] apps.db não foi atualizado: ${stderr?.trim() || 'erro desconhecido'}`
                    );
                }
            } catch (error) {
                logError(error, '[ArcDock] falha ao atualizar apps.db');
            } finally {
                this._running = false;
                this._drain();
            }
        });
    }
}
