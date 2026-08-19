import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { ANIM, TIMING, State } from './config.js';
import { TimeoutTracker } from './trackers.js';

export class AutoHide {
    constructor(
        container,
        liveRectProvider,
        shouldHideProvider = () => true
    ) {
        this._container = container;
        this._liveRectProvider = liveRectProvider;
        this._shouldHideProvider = shouldHideProvider;
        this._state = State.HIDDEN;
        this._hideDistance = 0;
        this._hideTimeoutId = 0;
        this._showTimeoutId = 0;
        this._forceHidden = false;
        this._forceShown = false;
        this._timeouts = new TimeoutTracker();

        this._container.hide();
        this._timeouts.add(TIMING.POINTER_POLL_MS, () => {
            const [x, y] = global.get_pointer();
            this._tick(x, y);
            return GLib.SOURCE_CONTINUE;
        });
    }

    setHideDistance(distance) {
        this._hideDistance = distance;
        if (this._state === State.HIDDEN)
            this._container.translation_y = distance;
    }

    hideNow() {
        this._cancelShow();
        this._hide();
    }

    setForceShown(forced) {
        this._forceShown = forced;
        if (forced) {
            this._cancelHide();
            if (this._state === State.HIDDEN || this._state === State.HIDING)
                this._show();
        }
    }

    setForceHidden(forced) {
        this._forceHidden = forced;
        if (forced) {
            this._cancelHide();
            this._cancelShow();
            this._container.remove_all_transitions();
            this._state = State.HIDDEN;
            this._container.translation_y = this._hideDistance;
            this._container.hide();
        }
    }

    get state() {
        return this._state;
    }

    destroy() {
        this._timeouts.removeAll();
        this._hideTimeoutId = 0;
        this._showTimeoutId = 0;
        this._container.remove_all_transitions();
    }

    _tick(x, y) {
        if (this._forceHidden)
            return;

        if (this._forceShown) {
            this._cancelHide();
            if (this._state === State.HIDDEN || this._state === State.HIDING)
                this._show();
            return;
        }

        if (!this._shouldHideProvider()) {
            this._cancelHide();
            if (this._state === State.HIDDEN || this._state === State.HIDING)
                this._show();
            return;
        }

        const inLive = this._isInLiveArea(x, y);
        if (inLive) {
            this._cancelHide();
            // Entrar da borda quente custa a espera do SHOW_DELAY_MS;
            // interromper um hide, não. No segundo caso a dock ainda está
            // na tela e o ponteiro voltou atrás de um alvo que ele está
            // vendo — segurar meio segundo aí seria só teimosia.
            if (this._state === State.HIDING)
                this._show();
            else if (this._state === State.HIDDEN)
                this._scheduleShow();
        } else {
            this._cancelShow();
            if (this._state === State.SHOWN || this._state === State.SHOWING) {
                if (!this._hideTimeoutId)
                    this._scheduleHide();
            }
        }
    }

    _isInLiveArea(x, y) {
        const rects = this._liveRectProvider(this._state);
        if (!rects)
            return false;

        return (Array.isArray(rects) ? rects : [rects]).some(rect =>
            rect !== null
            && x >= rect.x && x < rect.x + rect.w
            && y >= rect.y && y < rect.y + rect.h);
    }

    _show() {
        if (this._forceHidden)
            return;
        if (this._state === State.SHOWN || this._state === State.SHOWING)
            return;
        this._cancelHide();
        this._cancelShow();
        // Interromper um hide no meio do caminho não pode teleportar a
        // dock para baixo antes de subir: ela continua de onde está.
        const interrupted = this._state === State.HIDING;
        this._state = State.SHOWING;
        this._container.remove_all_transitions();
        this._container.show();
        if (!interrupted)
            this._container.translation_y = this._hideDistance;

        this._container.ease({
            translation_y: 0,
            duration: this._travelDuration(
                ANIM.SHOW_MS, this._container.translation_y),
            // Espelho do hide (EASE_IN_CUBIC): sobe distribuindo o
            // percurso e desacelera na chegada. Quem paga o
            // SHOW_DELAY_MS já esperou pela dock — chegar com o estalo
            // do EASE_OUT_EXPO depois da espera lia como sobressalto.
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { this._state = State.SHOWN; },
        });
    }

    _hide() {
        if (this._state === State.HIDDEN || this._state === State.HIDING)
            return;
        this._cancelHide();
        this._cancelShow();
        this._state = State.HIDING;
        this._container.remove_all_transitions();
        this._container.ease({
            translation_y: this._hideDistance,
            duration: this._travelDuration(
                ANIM.HIDE_MS,
                this._hideDistance - this._container.translation_y),
            // Saída acelera para fora (rápido no fim) e é mais curta que
            // a entrada: sumir não merece a mesma cerimônia de aparecer.
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                this._state = State.HIDDEN;
                this._container.hide();
            },
        });
    }

    /**
     * Duração proporcional ao trecho que ainda falta percorrer. Sem isso,
     * uma animação interrompida perto do fim gastaria a duração cheia
     * para andar 3px e pareceria travada; o piso TRAVEL_MIN_RATIO evita
     * o extremo oposto (um percurso curto virar um piscar).
     */
    _travelDuration(baseMs, delta) {
        if (this._hideDistance <= 0)
            return baseMs;
        const ratio = Math.min(1, Math.abs(delta) / this._hideDistance);
        return Math.max(
            Math.round(baseMs * ANIM.TRAVEL_MIN_RATIO),
            Math.round(baseMs * ratio));
    }

    _scheduleHide() {
        this._cancelHide();
        this._hideTimeoutId = this._timeouts.add(TIMING.HIDE_DELAY_MS, () => {
            this._hideTimeoutId = 0;
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Só agenda: o ponteiro é reconferido na hora em que o timeout
     * dispara, e não apenas nos ticks. Sem isso uma saída ocorrida nos
     * últimos milissegundos da espera ainda subiria a dock — o tick que
     * cancelaria só viria até POINTER_POLL_MS depois — e ela apareceria
     * já para descer.
     */
    _scheduleShow() {
        if (this._showTimeoutId)
            return;
        this._showTimeoutId = this._timeouts.add(TIMING.SHOW_DELAY_MS, () => {
            this._showTimeoutId = 0;
            const [x, y] = global.get_pointer();
            if (this._isInLiveArea(x, y))
                this._show();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelShow() {
        if (this._showTimeoutId) {
            this._timeouts.remove(this._showTimeoutId);
            this._showTimeoutId = 0;
        }
    }

    _cancelHide() {
        if (this._hideTimeoutId) {
            this._timeouts.remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
    }
}
