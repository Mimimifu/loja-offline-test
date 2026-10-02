/**
 * @file ui/DynamicForm.ts
 * @description Formulário gerado a partir do esquema JSON.
 *
 * O formulário não conhece o domínio: ele pergunta ao esquema quais campos
 * existem e devolve os valores brutos. A conversão para `Product` acontece em
 * `core/schema.ts`, mantendo esta camada testável e reutilizável.
 */

import { Component, html, raw, SafeHtml } from '../core/dom';
import { FieldSchema, FormSchema } from '../core/types';

/** Dependências e callbacks do formulário. */
export interface DynamicFormOptions {
    schema: FormSchema;
    /** Valores iniciais por `field.id`. */
    values: Record<string, string>;
    /** Rótulo do botão de envio. */
    submitLabel: string;
    /** Executado ao enviar com os valores brutos. */
    onSubmit: (values: Record<string, string>) => void | Promise<void>;
    /** Executado ao cancelar. */
    onCancel: () => void;
    /** Texto auxiliar opcional no topo. */
    intro?: string;
}

/** Formulário dinâmico. */
export class DynamicForm extends Component {
    private readonly options: DynamicFormOptions;
    private values: Record<string, string>;
    private fieldErrors: Record<string, string> = {};
    private submitting = false;

    constructor(options: DynamicFormOptions) {
        super('div', 'dynamic-form');
        this.options = options;
        this.values = { ...options.values };
    }

    /**
     * Aplica erros de validação por campo e re-renderiza.
     * @param errors Mapa `field.id` → mensagem.
     */
    setFieldErrors(errors: Record<string, string>): void {
        this.fieldErrors = errors;
        this.update();
        this.focusFirstError();
    }

    protected render(): SafeHtml {
        return html`
            <form class="form" novalidate data-role="form">
                ${this.options.intro ? html`<p class="text-muted">${this.options.intro}</p>` : ''}

                ${this.options.schema.fields.map((field) => this.renderField(field))}

                <div class="form-actions">
                    <button type="submit" class="btn btn--primary" ${this.submitting ? raw('disabled') : ''}>
                        ${this.submitting ? '⏳ Salvando…' : this.options.submitLabel}
                    </button>
                    <button type="button" class="btn btn--outline" data-action="cancel">Cancelar</button>
                </div>
            </form>
        `;
    }

    /** Renderiza um campo conforme o tipo definido no esquema. */
    private renderField(field: FieldSchema): SafeHtml {
        const value = this.values[field.id] ?? '';
        const error = this.fieldErrors[field.id];
        const inputId = `field-${field.id}`;
        const errorId = `${inputId}-error`;
        const describedBy = [field.help ? `${inputId}-help` : null, error ? errorId : null].filter(Boolean).join(' ');

        return html`
            <div class="form-group">
                ${field.type === 'checkbox'
                    ? html`
                          <label class="form-check" for="${inputId}">
                              <input
                                  type="checkbox"
                                  id="${inputId}"
                                  data-field="${field.id}"
                                  ${value === 'true' ? raw('checked') : ''}
                              >
                              <span class="form-label">${field.label}</span>
                          </label>
                      `
                    : html`
                          <label class="form-label" for="${inputId}">
                              ${field.label}${field.required ? html`<span class="form-label__required" aria-hidden="true">*</span>` : ''}
                          </label>
                          ${this.renderControl(field, value, inputId, describedBy, Boolean(error))}
                      `}

                ${field.help ? html`<span class="form-help" id="${inputId}-help">${field.help}</span>` : ''}

                <span class="form-error" id="${errorId}" role="alert">${error ?? ''}</span>
            </div>
        `;
    }

    /** Controle de entrada conforme o tipo do campo. */
    private renderControl(field: FieldSchema, value: string, inputId: string, describedBy: string, hasError: boolean): SafeHtml {
        const common = raw(
            `id="${inputId}" data-field="${field.id}" class="form-control"` +
                (field.required ? ' required' : '') +
                (describedBy ? ` aria-describedby="${describedBy}"` : '') +
                (hasError ? ' aria-invalid="true"' : ''),
        );

        switch (field.type) {
            case 'textarea':
                return html`<textarea ${common} placeholder="${field.placeholder ?? ''}">${value}</textarea>`;

            case 'select':
                return html`
                    <select ${common}>
                        <option value="">Selecione…</option>
                        ${(field.options ?? []).map(
                            (option) => html`
                                <option value="${option.value}" ${option.value === value ? raw('selected') : ''}>
                                    ${option.label}
                                </option>
                            `,
                        )}
                    </select>
                `;

            case 'checkbox':
                return html`<input type="checkbox" ${common} ${value === 'true' ? raw('checked') : ''}>`;

            case 'number':
                // Campos monetários (scale 100) usam `type="text"` + `inputmode="decimal"`:
                // um `input[type=number]` rejeita a vírgula decimal usada no pt-BR
                // ("19,90" seria descartado silenciosamente), e o navegador
                // exibiria um campo vazio. O parse de "19,90" / "1.234,56" é feito
                // por `parsePriceToCents`, que já lida com os dois formatos.
                if (field.scale === 100) {
                    return html`
                        <input
                            type="text"
                            inputmode="decimal"
                            autocomplete="off"
                            ${common}
                            value="${value}"
                            placeholder="${field.placeholder ?? '0,00'}"
                        >
                    `;
                }

                return html`
                    <input
                        type="number"
                        step="any"
                        ${common}
                        value="${value}"
                        placeholder="${field.placeholder ?? ''}"
                    >
                `;

            case 'url':
                return html`
                    <input type="url" ${common} value="${value}" placeholder="${field.placeholder ?? 'https://…'}">
                `;

            default:
                return html`
                    <input type="text" ${common} value="${value}" placeholder="${field.placeholder ?? ''}">
                `;
        }
    }

    protected override afterRender(): void {
        this.delegate('click');

        const form = this.element.querySelector<HTMLFormElement>('[data-role="form"]');
        if (form) {
            this.listen(form, 'submit', (event) => {
                event.preventDefault();
                void this.handleSubmit();
            });

            // Mantém os valores em memória para sobreviver a re-renders
            // (ex: quando erros de validação chegam do servidor).
            form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field]').forEach((input) => {
                const fieldId = input.dataset.field;
                if (!fieldId) return;

                const sync = (): void => {
                    this.values[fieldId] = input.type === 'checkbox' ? String((input as HTMLInputElement).checked) : input.value;
                };

                this.listen(input, 'input', sync);
                this.listen(input, 'change', sync);
            });
        }
    }

    /** Coleta e envia os valores. */
    private async handleSubmit(): Promise<void> {
        if (this.submitting) return;

        const form = this.element.querySelector<HTMLFormElement>('[data-role="form"]');
        if (!form) return;

        // Sincroniza antes de enviar, cobrindo campos não tocados.
        form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field]').forEach((input) => {
            const fieldId = input.dataset.field;
            if (!fieldId) return;
            this.values[fieldId] = input.type === 'checkbox' ? String((input as HTMLInputElement).checked) : input.value;
        });

        this.fieldErrors = {};
        this.submitting = true;
        this.update();

        try {
            await this.options.onSubmit({ ...this.values });
        } finally {
            this.submitting = false;
            this.update();
        }
    }

    /** Move o foco para o primeiro campo com erro (acessibilidade). */
    private focusFirstError(): void {
        const firstErrorId = Object.keys(this.fieldErrors)[0];
        if (!firstErrorId) return;

        this.element.querySelector<HTMLElement>(`[data-field="${firstErrorId}"]`)?.focus();
    }

    /* -------------------------------------------------------------- ações -- */

    private onCancel(): void {
        this.options.onCancel();
    }
}
