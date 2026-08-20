import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DESKTOP_SUFFIX = '.desktop';

// Permissão do atalho criado. O GNOME (Nautilus, gnome-shell) recusa
// EXECUTAR um .desktop solto na área de trabalho que não seja executável —
// ele vira um arquivo de texto com ícone genérico. rwxr-xr-x é o mesmo modo
// que o Nautilus grava em "Permitir execução".
const EXEC_MODE = 0o755;

// A OUTRA metade da mesma exigência: além do bit de execução, o Nautilus só
// lança um .desktop marcado como confiável. O atributo vive no backend de
// metadados do GIO (gvfs-metadata), não no inode — por isso ele é gravado
// numa chamada separada e o fracasso dele não invalida o atalho.
const TRUSTED_ATTR = 'metadata::trusted';
const MODE_ATTR = 'unix::mode';

// Quantos sufixos numéricos são tentados antes de desistir. O laço é
// LIMITADO de propósito: cada tentativa é um create_async, e um diretório
// patológico (ou um erro EXISTS que não é sobre o nome) transformaria isto
// numa fila infinita de I/O dentro do processo do compositor.
const MAX_NAME_ATTEMPTS = 64;

/**
 * Cria atalhos `.desktop` na área de trabalho do usuário.
 *
 * REGRA QUE DOMINA O ARQUIVO: nada de I/O síncrono. Isto roda dentro do
 * processo do compositor — um `query_info()`/`copy()` numa HOME em NFS
 * morta congela a sessão inteira. Todo passo é `*_async` com um
 * `Gio.Cancellable`, e todo callback confere antes de tocar em qualquer
 * coisa se o trabalho dele ainda é o trabalho vigente.
 *
 * Uma instância só, viva enquanto o launcher viver, e não uma por ícone: a
 * grade destrói e recria centenas de células a cada remontagem, e um
 * cancellable pendurado em cada uma delas cancelaria a cópia em curso na
 * primeira reordenação depois do clique.
 */
export class DesktopShortcut {
    constructor() {
        // Cancellables dos trabalhos em voo. Set (e não um campo único)
        // porque nada impede dois cliques seguidos em apps diferentes, e o
        // segundo não pode cancelar o primeiro.
        this._jobs = new Set();
        this._destroyed = false;
    }

    /**
     * Copia o `.desktop` de `app` para a área de trabalho, torna-o
     * executável e confiável.
     *
     * Não devolve nada e não bloqueia: o sucesso é o arquivo aparecendo (a
     * notificação seria ruído para uma ação que o usuário está vendo
     * acontecer) e a falha vira notificação de erro, porque um item de menu
     * que não faz NADA visível se lê como quebrado.
     *
     * @param {Shell.App|null} app
     */
    create(app) {
        if (this._destroyed) return;

        const appInfo = app?.get_app_info?.() ?? app?.appInfo ?? null;
        const sourcePath = appInfo?.get_filename?.() ?? null;
        if (!sourcePath) {
            this._fail(
                `no .desktop file for ${app?.get_id?.() ?? 'app'}`,
                'Este aplicativo não tem um arquivo .desktop para copiar.');
            return;
        }

        // Sem pasta de área de trabalho configurada (XDG_DESKTOP_DIR
        // apontando para a própria HOME é uma configuração comum), o atalho
        // vai para a HOME. Devolver erro seria pior: a pasta que o usuário
        // chama de "área de trabalho" é essa.
        const targetDir =
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ??
            GLib.get_home_dir();
        if (!targetDir) {
            this._fail(
                'no desktop directory and no home directory',
                'Não foi possível localizar a área de trabalho.');
            return;
        }

        const cancellable = new Gio.Cancellable();
        const job = {
            cancellable,
            targetDir,
            baseName: this._baseNameOf(sourcePath),
            appName: app?.get_name?.() ?? '',
        };
        this._jobs.add(job);

        Gio.File.new_for_path(sourcePath).load_contents_async(
            cancellable,
            (file, res) => {
                let contents = null;
                try {
                    // [ok, contents, etag] — o conteúdo é um Uint8Array. É
                    // uma CÓPIA byte a byte de propósito: sintetizar o ini à
                    // mão perderia Icon, Exec com campos %U, as actions e
                    // todas as traduções do arquivo real.
                    const [, bytes] = file.load_contents_finish(res);
                    contents = bytes;
                } catch (e) {
                    this._failJob(job, e, 'Não foi possível ler o aplicativo.');
                    return;
                }
                if (!this._alive(job)) return;
                if (!contents) {
                    this._failJob(job, null, 'O arquivo do aplicativo está vazio.');
                    return;
                }
                this._createFile(job, new GLib.Bytes(contents), 0);
            });
    }

    destroy() {
        this._destroyed = true;
        for (const job of this._jobs) {
            try {
                job.cancellable.cancel();
            } catch (_) {}
        }
        this._jobs.clear();
    }

    // --- Passos ---

    /**
     * Cria o arquivo de destino em modo EXCLUSIVO, tentando o próximo
     * sufixo quando o nome já existe.
     *
     * `create_async` e não `replace_contents_async`: a criação exclusiva é
     * o próprio teste de existência, feita pelo kernel num passo só. Um
     * `query_info` seguido de escrita seria duas viagens e ainda deixaria a
     * janela em que outro processo cria o arquivo entre elas — e o
     * resultado desse azar é sobrescrever um atalho que o usuário editou à
     * mão.
     */
    _createFile(job, bytes, attempt) {
        if (!this._alive(job)) return;
        if (attempt >= MAX_NAME_ATTEMPTS) {
            this._failJob(job, null, 'Já existem atalhos demais com esse nome.');
            return;
        }

        const path = GLib.build_filenamev([
            job.targetDir,
            this._nameForAttempt(job.baseName, attempt),
        ]);
        Gio.File.new_for_path(path).create_async(
            Gio.FileCreateFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            job.cancellable,
            (file, res) => {
                let stream = null;
                try {
                    stream = file.create_finish(res);
                } catch (e) {
                    if (!this._alive(job)) return;
                    if (e instanceof GLib.Error &&
                        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                        this._createFile(job, bytes, attempt + 1);
                        return;
                    }
                    this._failJob(job, e, 'Não foi possível criar o arquivo.');
                    return;
                }
                if (!this._alive(job)) {
                    _closeStream(stream, null);
                    return;
                }
                job.file = file;
                this._write(job, stream, bytes, 0);
            });
    }

    /**
     * Escreve o que falta, em laço.
     *
     * `write_bytes_async` pode escrever MENOS do que foi pedido — é um
     * write curto, não um erro — e um .desktop truncado é pior do que
     * atalho nenhum: ele existe, tem ícone e não abre nada. O laço é o que
     * transforma "escreveu um pedaço" em "escreveu tudo".
     */
    _write(job, stream, bytes, written) {
        const total = bytes.get_size();
        if (written >= total) {
            _closeStream(stream, job.cancellable, () => this._markExecutable(job));
            return;
        }
        const chunk = written === 0
            ? bytes
            : GLib.Bytes.new_from_bytes(bytes, written, total - written);

        stream.write_bytes_async(
            chunk,
            GLib.PRIORITY_DEFAULT,
            job.cancellable,
            (source, res) => {
                let count = 0;
                try {
                    count = source.write_bytes_finish(res);
                } catch (e) {
                    _closeStream(stream, null);
                    this._failJob(job, e, 'Não foi possível gravar o atalho.');
                    return;
                }
                if (!this._alive(job)) {
                    _closeStream(stream, null);
                    return;
                }
                if (count <= 0) {
                    _closeStream(stream, null);
                    this._failJob(job, null, 'A gravação do atalho parou no meio.');
                    return;
                }
                this._write(job, stream, bytes, written + count);
            });
    }

    _markExecutable(job) {
        if (!this._alive(job)) return;
        const info = new Gio.FileInfo();
        info.set_attribute_uint32(MODE_ATTR, EXEC_MODE);
        job.file.set_attributes_async(
            info,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            job.cancellable,
            (file, res) => {
                try {
                    file.set_attributes_finish(res);
                } catch (e) {
                    // Falhar aqui é falhar de verdade: sem o bit de
                    // execução o arquivo aparece na área de trabalho como
                    // texto e o clique não abre nada — exatamente o
                    // resultado que o usuário leria como "o menu é quebrado".
                    this._failJob(job, e,
                        'O atalho foi criado, mas não pôde ser marcado como executável.');
                    return;
                }
                if (!this._alive(job)) return;
                this._markTrusted(job);
            });
    }

    _markTrusted(job) {
        const info = new Gio.FileInfo();
        info.set_attribute_string(TRUSTED_ATTR, 'true');
        job.file.set_attributes_async(
            info,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            job.cancellable,
            (file, res) => {
                try {
                    file.set_attributes_finish(res);
                } catch (e) {
                    // Último passo, e o único cujo fracasso NÃO vira
                    // notificação: metadata:: mora no gvfs-metadata, que
                    // pode simplesmente não estar rodando. O atalho está
                    // criado e executável; o que se perde é o Nautilus
                    // abri-lo sem perguntar. Fica no journal e mais nada.
                    if (this._alive(job))
                        logError(e, '[ArcDock] desktop shortcut trust failed');
                }
                this._finish(job);
            });
    }

    // --- Ciclo de vida dos trabalhos ---

    /**
     * O trabalho ainda vale a pena? Três perguntas, e todas as três
     * precisam ser feitas em TODO callback: o objeto pode ter sido
     * destruído (extensão desabilitada), o cancellable pode ter sido
     * cancelado, e o trabalho pode já ter terminado por outro caminho.
     */
    _alive(job) {
        return !this._destroyed &&
            this._jobs.has(job) &&
            !job.cancellable.is_cancelled();
    }

    _finish(job) {
        this._jobs.delete(job);
    }

    _failJob(job, error, message) {
        // Cancelamento não é falha: quem cancelou foi o destroy(), e uma
        // notificação de erro subindo depois que a extensão foi desabilitada
        // é ruído puro.
        const cancelled = job.cancellable.is_cancelled() ||
            (error instanceof GLib.Error &&
                error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
        this._finish(job);
        if (cancelled || this._destroyed) return;
        this._fail(error, message);
    }

    _fail(error, message) {
        if (error instanceof GLib.Error || error instanceof Error)
            logError(error, '[ArcDock] desktop shortcut failed');
        else if (error)
            console.warn(`[ArcDock] desktop shortcut failed: ${error}`);

        try {
            Main.notifyError('Não foi possível criar o atalho', message);
        } catch (e) {
            // A bandeja de notificações pode não estar montada (sessão
            // subindo, unlock em curso). Perder o aviso é aceitável; deixar
            // a exceção subir para dentro do handler do menu não é.
            logError(e, '[ArcDock] desktop shortcut notify failed');
        }
    }

    // --- Nomes ---

    _baseNameOf(path) {
        const name = GLib.path_get_basename(path);
        return name && name !== '.' && name !== '/'
            ? name
            : `atalho${DESKTOP_SUFFIX}`;
    }

    /** `firefox.desktop`, `firefox-1.desktop`, `firefox-2.desktop`, … */
    _nameForAttempt(baseName, attempt) {
        if (attempt === 0) return baseName;
        // O sufixo entra antes da extensão, não depois: `firefox.desktop-1`
        // deixaria de ser um .desktop e viraria um arquivo qualquer.
        const dot = baseName.lastIndexOf('.');
        const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
        const ext = dot > 0 ? baseName.slice(dot) : DESKTOP_SUFFIX;
        return `${stem}-${attempt}${ext}`;
    }
}

/**
 * Fecha o stream sem deixar nada escapar.
 *
 * `cancellable` null de propósito nos caminhos de erro: o fechamento é a
 * última coisa a fazer com um arquivo pela metade, e passar um cancellable
 * já cancelado faria o próprio close falhar — deixando o descritor aberto
 * dentro do processo do compositor.
 */
function _closeStream(stream, cancellable, onClosed = null) {
    if (!stream) {
        onClosed?.();
        return;
    }
    stream.close_async(GLib.PRIORITY_DEFAULT, cancellable, (source, res) => {
        try {
            source.close_finish(res);
        } catch (e) {
            logError(e, '[ArcDock] desktop shortcut close failed');
        }
        onClosed?.();
    });
}
