/**
 * @file ui/toast.ts
 * @description Notificações não-bloqueantes com acessibilidade (`role="status"`).
 *
 * Substitui o `alert()`/`confirm()` espalhado na v4 — que bloqueia a thread,
 * não é estilizável e não anuncia nada para leitores de tela.
 */

import { raw, toHtmlString, html, SafeHtml } from '../core/dom';

/** Tipos visuais de notificação. */
export type ToastKind = 'info' | 'success' | 'warning' | 'danger';

/** Opções de exibição. */
export interface ToastOptions {
    kind?: ToastKind;
    title?: string;
    /** Duração em ms. Use `0` para exigir fechamento manual. */
    durationMs?: number;
}

const ICONS: Record<ToastKind, string> = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    danger: '⛔',
};

const DEFAULT_DURATION_MS = 5000;

/**
 * Gerencia a região de notificações da aplicação.
 */
export class ToastManager {
    private region: HTMLElement | null = null;

    /** Garante que a região `aria-live` exista no DOM. */
    private ensureRegion(): HTMLElement {
        if (this.region && document.body.contains(this.region)) return this.region;

        const region = document.createElement('div');
        region.className = 'toast-region';
        // `polite` para não interromper o leitor de tela no meio de uma frase.
        region.setAttribute('role', 'status');
        region.setAttribute('aria-live', 'polite');
        document.body.appendChild(region);

        this.region = region;
        return region;
    }

    /**
     * Exibe uma notificação.
     * @param message Texto principal.
     * @param options Configuração visual e duração.
     * @returns Função que fecha a notificação antecipadamente.
     */
    show(message: string, options: ToastOptions = {}): () => void {
        const { kind = 'info', title, durationMs = DEFAULT_DURATION_MS } = options;
        const region = this.ensureRegion();

        const element = document.createElement('div');
        element.className = `toast toast--${kind}`;
        element.innerHTML = toHtmlString(this.renderContent(kind, message, title));

        const close = (): void => {
            element.style.transition = 'opacity 220ms ease, transform 220ms ease';
            element.style.opacity = '0';
            element.style.transform = 'translateX(24px)';
            window.setTimeout(() => element.remove(), 240);
        };

        element.querySelector('[data-toast-close]')?.addEventListener('click', close);
        region.appendChild(element);

        if (durationMs > 0) {
            // Pausa a contagem quando o usuário interage (ex: foco no link de ação).
            let timer = window.setTimeout(close, durationMs);
            const pause = (): void => {
                window.clearTimeout(timer);
            };
            const resume = (): void => {
                timer = window.setTimeout(close, 1500);
            };

            element.addEventListener('mouseenter', pause);
            element.addEventListener('mouseleave', resume);
            element.addEventListener('focusin', pause);
            element.addEventListener('focusout', resume);
        }

        return close;
    }

    /** Atalho para notificação de sucesso. */
    success(message: string, title = 'Sucesso'): void {
        this.show(message, { kind: 'success', title });
    }

    /** Atalho para notificação de erro. */
    error(message: string, title = 'Erro'): void {
        this.show(message, { kind: 'danger', title, durationMs: 9000 });
    }

    /** Atalho para notificação de aviso. */
    warning(message: string, title = 'Atenção'): void {
        this.show(message, { kind: 'warning', title, durationMs: 7000 });
    }

    /** Atalho para notificação informativa. */
    info(message: string, title?: string): void {
        this.show(message, { kind: 'info', title });
    }

    private renderContent(kind: ToastKind, message: string, title?: string): SafeHtml {
        return html`
            <span class="toast__icon" aria-hidden="true">${raw(ICONS[kind])}</span>
            <div class="toast__content">
                ${title ? html`<div class="toast__title">${title}</div>` : ''}
                <div class="toast__message">${message}</div>
            </div>
            <button
                type="button"
                class="toast__close"
                data-toast-close
                aria-label="Fechar notificação"
            >×</button>
        `;
    }
}

/** Instância compartilhada. */
export const toast = new ToastManager();
