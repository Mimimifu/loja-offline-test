/**
 * @file core/dom.ts
 * @description Utilitários de DOM, construídos sobre `innerHTML`, `textContent`
 * e `addEventListener`.
 *
 * Decisão de projeto: usar HTML como template (em vez de `createElement` para
 * cada nó) mantém os componentes legíveis, desde que:
 *  1. todo dado interpolado passe por `escapeHtml` (`html` faz isso sozinho);
 *  2. a ligação de eventos seja declarativa via `data-action`, resolvida por
 *     delegação — evitando listeners órfãos após re-render.
 */

import { escapeHtml } from './utils';

/** Valor aceito por uma interpolação: já-escapado (`SafeHtml`) ou texto puro. */
declare const safeHtmlBrand: unique symbol;

/** Marca de conteúdo pré-escapado — impede escape duplo. */
export interface SafeHtml {
    readonly [safeHtmlBrand]: true;
    readonly value: string;
}

/**
 * Marca uma string como HTML seguro (confiável, já sanitizado).
 * Só use com conteúdo que você mesmo controla.
 * @param value HTML confiável.
 */
export function raw(value: string): SafeHtml {
    return { value } as SafeHtml;
}

type Interpolable = string | number | boolean | null | undefined | SafeHtml | Interpolable[];

/**
 * Template tag que escapa automaticamente toda interpolação.
 *
 * @example
 * const title = '<img src=x onerror=alert(1)>';
 * html`<h2>${title}</h2>` // '<h2>&lt;img src=x onerror=alert(1)&gt;</h2>'
 * @param strings Partes literais do template.
 * @param values Valores interpolados.
 */
export function html(strings: TemplateStringsArray, ...values: Interpolable[]): SafeHtml {
    const result = strings.reduce((acc, literal, index) => {
        const value = values[index];
        return acc + literal + (index < values.length ? stringify(value) : '');
    }, '');

    return raw(result);
}

/** Converte um valor interpolado em string segura. */
function stringify(value: Interpolable): string {
    if (value === null || value === undefined || value === false) return '';
    if (value === true) return '';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return escapeHtml(value);
    if (Array.isArray(value)) return value.map(stringify).join('');

    // `SafeHtml` — já sanitizado.
    if (typeof value === 'object' && 'value' in value) return value.value;

    return escapeHtml(String(value));
}

/** Converte `SafeHtml`/string em string bruta. */
export function toHtmlString(content: SafeHtml | string): string {
    return typeof content === 'string' ? content : content.value;
}

/**
 * Busca tipada de um elemento.
 * @param selector Seletor CSS.
 * @param root Raiz da busca.
 */
export function qs<E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E | null {
    return root.querySelector<E>(selector);
}

/**
 * Busca tipada de uma lista de elementos.
 * @param selector Seletor CSS.
 * @param root Raiz da busca.
 */
export function qsa<E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E[] {
    return Array.from(root.querySelectorAll<E>(selector));
}

/**
 * Manipula `classList` de forma encadeável.
 * @param element Elemento alvo.
 * @param classes Mapa classe → booleano.
 */
export function toggleClasses(element: Element, classes: Record<string, boolean>): void {
    Object.entries(classes).forEach(([className, active]) => {
        element.classList.toggle(className, active);
    });
}

/**
 * Define ou remove atributos.
 * @param element Elemento alvo.
 * @param attributes Mapa atributo → valor (`null` remove).
 */
export function setAttributes(element: Element, attributes: Record<string, string | number | boolean | null>): void {
    Object.entries(attributes).forEach(([name, value]) => {
        if (value === null || value === false) {
            element.removeAttribute(name);
        } else {
            element.setAttribute(name, String(value));
        }
    });
}

/** Contrato de um componente com ciclo de vida. */
export interface IComponent {
    /** Elemento raiz do componente. */
    readonly element: HTMLElement;
    /** Renderiza e insere o componente no container. */
    mount(container: HTMLElement): void;
    /** Remove o componente do DOM e libera recursos. */
    unmount(): void;
}

/**
 * Classe base para componentes reativos.
 *
 * `render()` devolve HTML (via `html`) e é chamado no `mount`. Componentes que
 * precisam atualizar devem chamar `update()`, que re-renderiza e re-aplica os
 * listeners registrados.
 */
export abstract class Component implements IComponent {
    public readonly element: HTMLElement;
    private mounted = false;
    private readonly cleanups: (() => void)[] = [];

    /**
     * @param tagName Tag do elemento raiz.
     * @param className Classe CSS aplicada ao elemento raiz.
     */
    constructor(tagName = 'div', className = '') {
        this.element = document.createElement(tagName);
        if (className) this.element.className = className;
    }

    /** HTML do componente. */
    protected abstract render(): SafeHtml;

    /** Executado após cada render (ligação de eventos, foco, etc). */
    protected afterRender(): void {
        /* sobrescrever quando necessário */
    }

    /** @inheritdoc */
    mount(container: HTMLElement): void {
        container.appendChild(this.element);
        this.mounted = true;
        this.update();
    }

    /** Re-renderiza o conteúdo preservando o elemento raiz. */
    update(): void {
        if (!this.mounted) return;

        this.runCleanups();
        this.element.innerHTML = toHtmlString(this.render());
        this.afterRender();
    }

    /** @inheritdoc */
    unmount(): void {
        this.runCleanups();
        this.mounted = false;
        this.element.remove();
    }

    /**
     * Registra um listener cujo ciclo de vida é o do componente.
     * @param target Alvo do evento.
     * @param type Tipo do evento.
     * @param handler Callback.
     * @param options Opções do `addEventListener`.
     */
    protected listen(
        target: EventTarget,
        type: string,
        handler: (event: Event) => void,
        options?: AddEventListenerOptions,
    ): void {
        target.addEventListener(type, handler, options);
        this.cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    /**
     * Registra um timeout cujo ciclo de vida é o do componente.
     * @param handler Callback.
     * @param delayMs Atraso.
     */
    protected setTimeout(handler: () => void, delayMs: number): void {
        const id = window.setTimeout(handler, delayMs);
        this.cleanups.push(() => window.clearTimeout(id));
    }

    /**
     * Delegação de eventos por `data-action`.
     * @param eventName Nome do evento (ex: `click`, `submit`, `change`).
     */
    protected delegate(eventName: string): void {
        this.listen(this.element, eventName, (event) => {
            const target = event.target as Element | null;
            const actionElement = target?.closest?.('[data-action]') as HTMLElement | null;
            if (!actionElement || !this.element.contains(actionElement)) return;

            const action = actionElement.dataset.action;
            if (!action) return;

            const handler = (this as unknown as Record<string, unknown>)[`on${capitalize(action)}`];
            if (typeof handler === 'function') {
                (handler as (el: HTMLElement, ev: Event) => void).call(this, actionElement, event);
            } else {
                console.warn(`[Component] Ação sem handler: "${action}".`);
            }
        });
    }

    private runCleanups(): void {
        while (this.cleanups.length > 0) {
            const cleanup = this.cleanups.pop();
            try {
                cleanup?.();
            } catch (error) {
                console.error('[Component] Erro ao limpar recurso:', error);
            }
        }
    }
}

/** Capitaliza a primeira letra. */
function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Move o foco para o primeiro elemento focável de um container (A11y).
 * @param container Container alvo.
 */
export function focusFirst(container: HTMLElement): void {
    const focusable = container.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
}

/**
 * Mantém o foco preso dentro de um container (focus trap para modais).
 * @param container Container do modal.
 * @returns Função de limpeza.
 */
export function createFocusTrap(container: HTMLElement): () => void {
    const selector =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const onKeydown = (event: KeyboardEvent): void => {
        if (event.key !== 'Tab') return;

        const focusables = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
            (el) => el.offsetParent !== null || el === document.activeElement,
        );
        if (focusables.length === 0) return;

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    container.addEventListener('keydown', onKeydown);
    return () => container.removeEventListener('keydown', onKeydown);
}

/** Anuncia uma mensagem para leitores de tela (aria-live). */
export function announce(message: string, politeness: 'polite' | 'assertive' = 'polite'): void {
    let region = document.getElementById('a11y-announcer');
    if (!region) {
        region = document.createElement('div');
        region.id = 'a11y-announcer';
        region.className = 'visually-hidden';
        region.setAttribute('role', 'status');
        document.body.appendChild(region);
    }

    region.setAttribute('aria-live', politeness);
    // Reatribuir o mesmo texto não dispara o leitor de tela; o tick limpa antes.
    region.textContent = '';
    window.setTimeout(() => {
        region!.textContent = message;
    }, 50);
}
