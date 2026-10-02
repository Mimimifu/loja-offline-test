/**
 * @file views/ProductFormView.ts
 * @description Criar/editar produto usando o formulário gerado por esquema.
 *
 * Também embute o editor de esquema JSON (aba "Esquema do formulário"), que era
 * solicitado no projeto: o próprio usuário pode alterar a configuração do
 * formulário dentro da SPA.
 */

import { Component, html, raw, SafeHtml } from '../core/dom';
import { AppState } from '../core/appState';
import { AppStateData, Product } from '../core/types';
import { ProductRepository } from '../data/productRepository';
import { DynamicForm } from '../ui/DynamicForm';
import { formValuesToProduct, productToFormValues, validateSchemaShape } from '../core/schema';
import { AppError, ValidationError } from '../core/errors';
import { toast } from '../ui/toast';
import { Router } from '../core/router';
import { idFromRouteParam } from '../core/routeParams';
import { escapeHtml } from '../core/utils';

/** Modo do formulário. */
type FormMode = 'create' | 'edit';

/** Formulário de produto (criar/editar). */
export class ProductFormView extends Component {
    private readonly appState: AppState<AppStateData>;
    private readonly repository: ProductRepository;
    private readonly router: Router;
    private readonly mode: FormMode;
    private readonly productId: string | null;

    /** Instância do formulário dinâmico (substituída a cada montagem). */
    private form: DynamicForm | null = null;
    private baseProduct: Product | null = null;
    private schemaError: string | null = null;
    /** `true` quando a URL pediu edição de um produto que não existe mais. */
    private notFound = false;

    constructor(appState: AppState<AppStateData>, repository: ProductRepository, router: Router, rawId?: string) {
        super('div', 'page product-form-view');
        this.appState = appState;
        this.repository = repository;
        this.router = router;

        // O parâmetro vem da URL e pode estar percent-encoded (ids com acento/espaço).
        const decodedId = rawId ? idFromRouteParam(rawId) : null;

        if (decodedId) {
            this.baseProduct = repository.getById(decodedId);

            if (this.baseProduct) {
                this.mode = 'edit';
                this.productId = String(this.baseProduct.id);
            } else {
                // A URL pedia edição, mas o registro sumiu (ex: excluído em outra aba).
                this.mode = 'create';
                this.productId = null;
                this.notFound = true;
            }
        } else {
            this.mode = 'create';
            this.productId = null;
        }
    }

    protected render(): SafeHtml {
        // Produto inexistente: exibe aviso em vez de um formulário vazio enganoso.
        if (this.notFound) {
            return html`
                <div class="empty-state">
                    <div class="empty-state__icon" aria-hidden="true">🔍</div>
                    <h3 class="empty-state__title">Produto não encontrado</h3>
                    <p class="empty-state__text">
                        Não encontramos o produto solicitado. Ele pode ter sido excluído em outra aba.
                    </p>
                    <a class="btn btn--primary" href="/admin">← Voltar ao gerenciador</a>
                </div>
            `;
        }

        const isEdit = this.mode === 'edit';

        return html`
            <nav class="breadcrumbs" aria-label="Trilha de navegação">
                <a href="/admin">Gerenciar</a>
                <span class="breadcrumbs__sep" aria-hidden="true">/</span>
                <span aria-current="page">${isEdit ? 'Editar produto' : 'Novo produto'}</span>
            </nav>

            <div class="page-header">
                <div class="page-header__text">
                    <h2>${isEdit ? 'Editar produto' : 'Novo produto'}</h2>
                    <p class="page-header__subtitle">
                        Os campos abaixo são gerados dinamicamente a partir do esquema JSON.
                        ${isEdit ? '' : 'Itens novos nascem publicados na vitrine.'}
                    </p>
                </div>
                <div class="page-header__actions">
                    <button type="button" class="btn btn--outline" data-action="toggleSchema">
                        ⚙️ Esquema do formulário
                    </button>
                </div>
            </div>

            <div class="form-section" data-role="form-host">
                <p class="text-muted">Carregando formulário…</p>
            </div>

            <div class="form-section hidden" data-role="schema-host" style="margin-top: 1.5rem;">
                ${this.renderSchemaEditor()}
            </div>
        `;
    }

    /** Editor do esquema JSON. */
    private renderSchemaEditor(): SafeHtml {
        const schemaJson = JSON.stringify(this.appState.select('formSchema'), null, 2);

        return html`
            <h3 style="margin-bottom: 0.5rem;">Esquema do formulário (JSON)</h3>
            <p class="text-muted" style="margin-bottom: 1rem; font-size: 0.88rem;">
                Edite os campos, tipos e validações. O formulário de cadastro se adapta imediatamente.
                Alterar o esquema não modifica os produtos já cadastrados.
            </p>

            ${this.schemaError
                ? html`
                      <div class="callout callout--danger" style="margin-bottom: 1rem;">
                          <span class="callout__icon" aria-hidden="true">⛔</span>
                          <div><strong>Esquema inválido.</strong><br>${this.schemaError}</div>
                      </div>
                  `
                : ''}

            <label class="visually-hidden" for="schema-editor">JSON do esquema do formulário</label>
            <textarea
                class="form-control code-editor"
                id="schema-editor"
                spellcheck="false"
                data-role="schema-editor"
            >${schemaJson}</textarea>

            <div class="form-actions">
                <button type="button" class="btn btn--primary" data-action="saveSchema">Salvar esquema</button>
                <button type="button" class="btn btn--outline" data-action="resetSchema">Restaurar padrão</button>
            </div>
        `;
    }

    protected override afterRender(): void {
        this.delegate('click');
        this.mountForm();
    }

    /** Cria e insere o formulário dinâmico no host. */
    private mountForm(): void {
        const host = this.element.querySelector<HTMLElement>('[data-role="form-host"]');
        if (!host) return;

        // Evita duplicar o formulário em re-renders.
        if (this.form && host.contains(this.form.element)) return;

        host.innerHTML = '';
        this.form?.unmount();

        const schema = this.appState.select('formSchema');
        const isEdit = this.mode === 'edit';

        this.form = new DynamicForm({
            schema,
            values: productToFormValues(schema, this.baseProduct),
            submitLabel: isEdit ? 'Salvar alterações' : 'Cadastrar produto',
            intro: isEdit ? `Editando: ${this.baseProduct?.title ?? ''}` : undefined,
            onSubmit: (values) => this.handleSubmit(values),
            onCancel: () => this.router.navigate('/admin'),
        });

        this.form.mount(host);
    }

    /** Processa o envio do formulário. */
    private async handleSubmit(values: Record<string, string>): Promise<void> {
        const schema = this.appState.select('formSchema');

        try {
            const product = formValuesToProduct(schema, values, this.baseProduct);

            if (this.mode === 'edit' && this.baseProduct) {
                this.repository.update({ ...product, id: this.baseProduct.id });
                toast.success(`"${product.title}" foi atualizado.`, 'Alterações salvas');
            } else {
                this.repository.create(product);
                toast.success(`"${product.title}" foi cadastrado.`, 'Produto criado');
            }

            this.router.navigate('/admin');
        } catch (error) {
            if (error instanceof ValidationError) {
                this.form?.setFieldErrors(error.fieldErrors);
                toast.error('Corrija os campos destacados antes de salvar.', 'Dados inválidos');
                return;
            }

            const appError = error instanceof AppError ? error : null;
            toast.error(appError?.message ?? 'Não foi possível salvar o produto.', 'Erro ao salvar');
        }
    }

    /* -------------------------------------------------------------- ações -- */

    private onToggleSchema(): void {
        const host = this.element.querySelector<HTMLElement>('[data-role="schema-host"]');
        host?.classList.toggle('hidden');

        if (host && !host.classList.contains('hidden')) {
            host.querySelector<HTMLTextAreaElement>('[data-role="schema-editor"]')?.focus();
        }
    }

    private onSaveSchema(): void {
        const editor = this.element.querySelector<HTMLTextAreaElement>('[data-role="schema-editor"]');
        if (!editor) return;

        try {
            const parsed: unknown = JSON.parse(editor.value);
            const schema = validateSchemaShape(parsed);

            this.appState.setState({ formSchema: schema });
            this.schemaError = null;

            toast.success('O formulário foi regenerado com o novo esquema.', 'Esquema salvo');
            this.update();
        } catch (error) {
            if (error instanceof SyntaxError) {
                this.schemaError = `JSON inválido: ${escapeHtml(error.message)}`;
            } else if (error instanceof ValidationError) {
                this.schemaError = escapeHtml(error.message);
            } else {
                this.schemaError = 'Esquema inválido.';
            }

            this.update();
            toast.error('O esquema não pôde ser aplicado. Veja os detalhes na tela.', 'JSON inválido');
        }
    }

    private async onResetSchema(): Promise<void> {
        const { confirmDialog } = await import('../ui/modal');
        const confirmed = await confirmDialog({
            title: 'Restaurar esquema padrão',
            message: 'Isso substitui o esquema atual pelo padrão de fábrica. Os produtos cadastrados não serão alterados.',
            confirmLabel: 'Restaurar',
            danger: true,
        });

        if (!confirmed) return;

        // Recarrega o padrão a partir de um estado inicial descartável.
        const { createInitialState } = await import('../core/appState');
        this.appState.setState({ formSchema: createInitialState().formSchema });
        this.schemaError = null;

        toast.success('Esquema restaurado para o padrão.', 'Restaurado');
        this.update();
    }
}

/** Reexporta `raw` para manter o tipo utilizado no template acessível. */
export { raw };
