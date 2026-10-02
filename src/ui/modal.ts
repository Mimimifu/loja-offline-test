/**
 * @file ui/modal.ts
 * @description Diálogos modais acessíveis, com focus trap e retorno de foco.
 *
 * Regras de acessibilidade aplicadas:
 *  - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`;
 *  - foco move para o primeiro elemento focável ao abrir;
 *  - `Tab`/`Shift+Tab` circulam dentro do modal (focus trap);
 *  - `Esc` fecha;
 *  - o foco retorna ao elemento que abriu o modal ao fechar.
 */

import { createFocusTrap, focusFirst, html, raw, toHtmlString, SafeHtml } from '../core/dom';

/** Conteúdo de um modal: HTML já sanitizado ou texto. */
export interface ModalOptions {
    title: string;
    /** Corpo do modal (use `html` para compor, ou forneça um `HTMLElement`). */
    content: SafeHtml | HTMLElement;
    /** Rótulo do botão primário. Se omitido, nenhum botão de ação é renderizado. */
    confirmLabel?: string;
    cancelLabel?: string;
    /** Aplica estilo destrutivo ao botão de confirmação. */
    danger?: boolean;
    /** Permite fechar clicando no backdrop. Padrão: `true`. */
    closeOnBackdrop?: boolean;
}

/** Handle de um modal aberto. */
export interface ModalHandle {
    close(): void;
    element: HTMLElement;
}

/** Pilha de modais abertos (para saber quem recebe o `Esc`). */
const stack: HTMLElement[] = [];
let listenerAttached = false;

/** Controla o overflow do body de acordo com a pilha. */
function syncBodyScroll(): void {
    document.body.style.overflow = stack.length > 0 ? 'hidden' : '';
}

/** Instala o listener global de `Escape` uma única vez. */
function attachGlobalListener(): void {
    if (listenerAttached) return;
    listenerAttached = true;

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || stack.length === 0) return;

        const topmost = stack[stack.length - 1];
        const closeButton = topmost.querySelector<HTMLButtonElement>('[data-modal-close]');
        // Um modal sem botão de fechar é considerado não-dismissável (ex: carregando).
        if (!closeButton) return;

        event.preventDefault();
        closeButton.click();
    });
}

/**
 * Abre um modal.
 * @param options Configuração do diálogo.
 * @param onConfirm Callback do botão primário (pode ser assíncrono).
 * @returns Handle para fechamento programático.
 */
export function openModal(options: ModalOptions, onConfirm?: () => void | Promise<void>): ModalHandle {
    const {
        title,
        content,
        confirmLabel,
        cancelLabel = 'Cancelar',
        danger = false,
        closeOnBackdrop = true,
    } = options;

    attachGlobalListener();

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const bodyContent = content instanceof HTMLElement ? content.outerHTML : toHtmlString(content);

    backdrop.innerHTML = toHtmlString(html`
        <div
            class="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="${titleId}"
        >
            <header class="modal__header">
                <h2 class="modal__title" id="${titleId}">${title}</h2>
                <button
                    type="button"
                    class="btn btn--ghost btn--icon"
                    data-modal-close
                    aria-label="Fechar diálogo"
                >×</button>
            </header>

            <div class="modal__body" data-modal-body>${raw(bodyContent)}</div>

            ${confirmLabel
                ? html`
                      <footer class="modal__footer">
                          <button type="button" class="btn btn--outline" data-modal-close>${cancelLabel}</button>
                          <button
                              type="button"
                              class="btn ${danger ? 'btn--danger' : 'btn--primary'}"
                              data-modal-confirm
                          >${confirmLabel}</button>
                      </footer>
                  `
                : ''}
        </div>
    `);

    const modalElement = backdrop.querySelector<HTMLElement>('.modal') as HTMLElement;
    const releaseTrap = createFocusTrap(modalElement);

    let closed = false;

    const close = (): void => {
        if (closed) return;
        closed = true;

        releaseTrap();
        const index = stack.indexOf(modalElement);
        if (index >= 0) stack.splice(index, 1);

        backdrop.remove();
        syncBodyScroll();

        // Devolve o foco ao gatilho — requisito de acessibilidade.
        previouslyFocused?.focus?.();
    };

    backdrop.querySelectorAll('[data-modal-close]').forEach((button) => {
        button.addEventListener('click', close);
    });

    backdrop.querySelector('[data-modal-confirm]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;

        try {
            await onConfirm?.();
            close();
        } catch (error) {
            button.disabled = false;
            console.error('[Modal] Falha na ação de confirmação:', error);
        }
    });

    if (closeOnBackdrop) {
        backdrop.addEventListener('mousedown', (event) => {
            if (event.target === backdrop) close();
        });
    }

    document.body.appendChild(backdrop);
    stack.push(modalElement);
    syncBodyScroll();

    // Aguarda o próximo frame para que as transições CSS já estejam aplicadas.
    window.requestAnimationFrame(() => focusFirst(modalElement));

    return { close, element: modalElement };
}

/**
 * Exibe um diálogo de confirmação.
 * @param options Título, mensagem e rótulos.
 * @returns `true` se confirmado.
 */
export function confirmDialog(options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
}): Promise<boolean> {
    const { title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = options;

    return new Promise<boolean>((resolve) => {
        let confirmed = false;

        const handle = openModal(
            {
                title,
                content: html`<p>${message}</p>`,
                confirmLabel,
                cancelLabel,
                danger,
            },
            () => {
                confirmed = true;
            },
        );

        // Resolve quando o modal sair do DOM, seja por confirmar ou cancelar.
        const observer = new MutationObserver(() => {
            if (!document.body.contains(handle.element)) {
                observer.disconnect();
                resolve(confirmed);
            }
        });
        observer.observe(document.body, { childList: true });
    });
}
