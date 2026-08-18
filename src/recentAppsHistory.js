import { RECENT } from './config.js';

const KEY_RECENT = 'recent-apps';

/**
 * Histórico "abertos recentemente" (os últimos apps que passaram a rodar),
 * persistido na key `recent-apps` para sobreviver a um restart do shell.
 *
 * Deliberadamente SEM sinais: ninguém escuta `changed::recent-apps`, nem
 * aqui nem no extension.js. Um app abrindo grava no histórico, e se essa
 * escrita voltasse como notificação ela dispararia o _refresh()/restart que
 * a originou — um laço alimentado por qualquer app que abra. A dock lê o
 * histórico dentro do _refresh() que ela já faz por outros motivos.
 */
export class RecentAppsHistory {
    /** @param {Gio.Settings|null} settings */
    constructor(settings) {
        this._settings = settings ?? null;
    }

    /** Lista ORDENADA, do mais recente para o mais antigo. */
    list() {
        if (!this._settings)
            return [];
        return this._settings.get_strv(KEY_RECENT).filter(appId => appId);
    }

    /** Põe o appId na frente da fila (dedupe + cap). */
    push(appId) {
        if (!this._settings || typeof appId !== 'string' || !appId)
            return;
        const current = this.list();
        // Já é o primeiro: reescrever gravaria exatamente a mesma lista no
        // dconf a cada janela nova do mesmo app, de graça.
        if (current[0] === appId)
            return;
        const next = [appId, ...current.filter(id => id !== appId)];
        if (next.length > RECENT.HISTORY_MAX)
            next.length = RECENT.HISTORY_MAX;
        this._settings.set_strv(KEY_RECENT, next);
    }

    destroy() {
        this._settings = null;
    }
}
