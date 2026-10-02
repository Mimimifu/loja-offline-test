/**
 * @file views/AdminView.ts
 * @description Painel administrativo: estatísticas, busca, tabela de produtos
 * com ações editar/duplicar/publicar/excluir e acesso aos backups.
 *
 * Substitui o `confirm()` nativo da v4 por um diálogo acessível e oferece
 * "desfazer" para exclusões acidentais.
 */

import { Component, html, raw, SafeHtml } from '../core/dom';
import { AppState } from '../core/appState';
import { AppStateData, Product } from '../core/types';
import { ProductRepository } from '../data/productRepository';
import { CATEGORY_LABELS, categoryIcon } from '../ui/ProductCard';
import { confirmDialog } from '../ui/modal';
import { toast } from '../ui/toast';
import { Router } from '../core/router';
import { debounce, formatCurrency, formatDate, truncate } from '../core/utils';
import { ProductCategory } from '../core/types';

/** Painel administrativo. */
export class AdminView extends Component {
    private readonly appState: AppState<AppStateData>;
    private readonly repository: ProductRepository;
    private readonly router: Router;

    private query = '';
    private categoryFilter: ProductCategory | 'todas' = 'todas';
    private statusFilter: 'todos' | 'publicados' | 'rascunhos' = 'todos';

    /** Snapshot do último item excluído, para permitir desfazer. */
    private lastDeleted: { product: Product; index: number } | null = null;

    constructor(appState: AppState<AppStateData>, repository: ProductRepository, router: Router) {
        super('div', 'page admin-view');
        this.appState = appState;
        this.repository = repository;
        this.router = router;

        appState.subscribe((_state, changedKeys) => {
            if (changedKeys.includes('products')) this.update();
        });

        this.onSearchInput = debounce((value: string) => {
            this.query = value;
            this.update();
        }, 220);
    }

    private readonly onSearchInput: (value: string) => void;

    protected render(): SafeHtml {
        const stats = this.repository.getStats();
        const products = this.filteredProducts();

        return html`
            <div class="page-header">
                <div class="page-header__text">
                    <h2>Gerenciar produtos</h2>
                    <p class="page-header__subtitle">
                        Cadastre, edite e publique os itens da sua vitrine. Tudo é salvo automaticamente no navegador.
                    </p>
                </div>
                <div class="page-header__actions">
                    <a class="btn btn--primary" href="/admin/novo">➕ Novo produto</a>
                    <button type="button" class="btn btn--outline" data-action="export">⬇️ Exportar</button>
                    <button type="button" class="btn btn--outline" data-action="import">⬆️ Importar</button>
                </div>
            </div>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-card__label">Total</div>
                    <div class="stat-card__value">${stats.total}</div>
                    <div class="stat-card__hint">produtos cadastrados</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card__label">Publicados</div>
                    <div class="stat-card__value">${stats.published}</div>
                    <div class="stat-card__hint">visíveis na vitrine</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card__label">Rascunhos</div>
                    <div class="stat-card__value">${stats.drafts}</div>
                    <div class="stat-card__hint">ocultos do público</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card__label">Soma dos preços</div>
                    <div class="stat-card__value" style="font-size: 1.35rem;">${formatCurrency(stats.inventoryCents)}</div>
                    <div class="stat-card__hint">valor do catálogo</div>
                </div>
            </div>

            ${this.lastDeleted ? this.renderUndoBar() : ''}

            <div class="toolbar">
                <div class="toolbar__search">
                    <span class="toolbar__search-icon" aria-hidden="true">🔍</span>
                    <label class="visually-hidden" for="admin-search">Buscar produtos</label>
                    <input
                        type="search"
                        id="admin-search"
                        class="form-control"
                        placeholder="Buscar por título, descrição ou tag…"
                        value="${this.query}"
                        data-role="search-input"
                        autocomplete="off"
                    >
                </div>

                <label class="visually-hidden" for="admin-category">Filtrar por categoria</label>
                <select class="select-inline" id="admin-category" data-role="category-select">
                    <option value="todas" ${this.categoryFilter === 'todas' ? raw('selected') : ''}>Todas as categorias</option>
                    ${Object.entries(CATEGORY_LABELS).map(
                        ([value, label]) => html`
                            <option value="${value}" ${this.categoryFilter === value ? raw('selected') : ''}>${label}</option>
                        `,
                    )}
                </select>

                <div class="filter-chips" role="group" aria-label="Filtrar por status">
                    ${(['todos', 'publicados', 'rascunhos'] as const).map(
                        (status) => html`
                            <button
                                type="button"
                                class="chip"
                                data-action="setStatus"
                                data-status="${status}"
                                aria-pressed="${this.statusFilter === status ? 'true' : 'false'}"
                            >${capitalize(status)}</button>
                        `,
                    )}
                </div>
            </div>

            ${products.length === 0 ? this.renderEmpty() : this.renderTable(products)}
        `;
    }

    /** Barra de "desfazer" após exclusão. */
    private renderUndoBar(): SafeHtml {
        const title = this.lastDeleted?.product.title ?? '';

        return html`
            <div class="callout callout--warning" style="margin-bottom: 1rem; align-items: center;">
                <span class="callout__icon" aria-hidden="true">🗑️</span>
                <div style="flex: 1;">
                    "<strong>${title}</strong>" foi excluído.
                </div>
                <button type="button" class="btn btn--outline btn--sm" data-action="undoDelete">Desfazer</button>
                <button type="button" class="btn btn--ghost btn--sm" data-action="dismissUndo">Dispensar</button>
            </div>
        `;
    }

    /** Tabela de produtos. */
    private renderTable(products: Product[]): SafeHtml {
        return html`
            <div class="table-wrapper">
                <table class="data-table">
                    <caption class="visually-hidden">Lista de produtos cadastrados</caption>
                    <thead>
                        <tr>
                            <th scope="col"><span class="visually-hidden">Imagem</span></th>
                            <th scope="col">Produto</th>
                            <th scope="col">Categoria</th>
                            <th scope="col">Preço</th>
                            <th scope="col">Status</th>
                            <th scope="col">Atualizado</th>
                            <th scope="col" style="text-align: right;">Ações</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${products.map((product) => this.renderRow(product))}
                    </tbody>
                </table>
            </div>
        `;
    }

    /** Uma linha da tabela. */
    private renderRow(product: Product): SafeHtml {
        const detailHref = `/produto/${encodeURIComponent(product.id)}`;

        return html`
            <tr data-product-id="${product.id}">
                <td>
                    ${product.image
                        ? html`<img class="data-table__thumb" src="${product.image}" alt="" loading="lazy">`
                        : html`<span class="data-table__thumb" style="display:grid;place-items:center;" aria-hidden="true">
                              ${raw(categoryIcon(product.category))}
                          </span>`}
                </td>
                <td>
                    <div class="data-table__title">
                        <a href="${detailHref}">${truncate(product.title, 48)}</a>
                    </div>
                    <div class="text-muted" style="font-size: 0.8rem;">${truncate(product.description, 64)}</div>
                </td>
                <td><span class="badge">${CATEGORY_LABELS[product.category]}</span></td>
                <td>${product.priceCents === 0 ? html`<span class="badge badge--success">Grátis</span>` : formatCurrency(product.priceCents)}</td>
                <td>
                    ${product.published
                        ? html`<span class="badge badge--success">Publicado</span>`
                        : html`<span class="badge badge--warning">Rascunho</span>`}
                </td>
                <td class="text-muted" style="font-size: 0.82rem; white-space: nowrap;">${formatDate(product.updatedAt)}</td>
                <td>
                    <div class="data-table__actions">
                        <button
                            type="button"
                            class="btn btn--outline btn--sm"
                            data-action="togglePublish"
                            data-id="${product.id}"
                            title="${product.published ? 'Despublicar' : 'Publicar'}"
                            aria-label="${product.published ? 'Despublicar' : 'Publicar'} ${product.title}"
                        >${product.published ? '🙈' : '👁️'}</button>

                        <button
                            type="button"
                            class="btn btn--outline btn--sm"
                            data-action="duplicate"
                            data-id="${product.id}"
                            title="Duplicar"
                            aria-label="Duplicar ${product.title}"
                        >⧉</button>

                        <a
                            class="btn btn--outline btn--sm"
                            href="/admin/editar/${encodeURIComponent(product.id)}"
                            title="Editar"
                            aria-label="Editar ${product.title}"
                        >✏️</a>

                        <button
                            type="button"
                            class="btn btn--danger btn--sm"
                            data-action="delete"
                            data-id="${product.id}"
                            title="Excluir"
                            aria-label="Excluir ${product.title}"
                        >🗑️</button>
                    </div>
                </td>
            </tr>
        `;
    }

    /** Estado vazio. */
    private renderEmpty(): SafeHtml {
        const hasFilters = this.query.trim() !== '' || this.categoryFilter !== 'todas' || this.statusFilter !== 'todos';

        if (hasFilters) {
            return html`
                <div class="empty-state">
                    <div class="empty-state__icon" aria-hidden="true">🔍</div>
                    <h3 class="empty-state__title">Nenhum produto corresponde aos filtros</h3>
                    <p class="empty-state__text">Ajuste a busca ou os filtros para ver seus produtos.</p>
                    <button type="button" class="btn btn--outline" data-action="clearFilters">Limpar filtros</button>
                </div>
            `;
        }

        return html`
            <div class="empty-state">
                <div class="empty-state__icon" aria-hidden="true">🗂️</div>
                <h3 class="empty-state__title">Nenhum produto cadastrado</h3>
                <p class="empty-state__text">Comece cadastrando um produto ou importe um backup JSON existente.</p>
                <div class="row" style="justify-content: center;">
                    <a class="btn btn--primary" href="/admin/novo">➕ Cadastrar produto</a>
                    <button type="button" class="btn btn--outline" data-action="import">⬆️ Importar backup</button>
                </div>
            </div>
        `;
    }

    /** Produtos após aplicar busca/filtros. */
    private filteredProducts(): Product[] {
        let products = this.repository.list({
            query: this.query,
            category: this.categoryFilter,
            includeUnpublished: true,
            sortBy: 'recent',
        });

        if (this.statusFilter === 'publicados') products = products.filter((product) => product.published);
        if (this.statusFilter === 'rascunhos') products = products.filter((product) => !product.published);

        return products;
    }

    protected override afterRender(): void {
        this.delegate('click');
        this.bindInputs();
    }

    private bindInputs(): void {
        const searchInput = this.element.querySelector<HTMLInputElement>('[data-role="search-input"]');
        if (searchInput) this.listen(searchInput, 'input', () => this.onSearchInput(searchInput.value));

        const categorySelect = this.element.querySelector<HTMLSelectElement>('[data-role="category-select"]');
        if (categorySelect) {
            this.listen(categorySelect, 'change', () => {
                this.categoryFilter = categorySelect.value as ProductCategory | 'todas';
                this.update();
            });
        }
    }

    /* -------------------------------------------------------------- ações -- */

    private onSetStatus(element: HTMLElement): void {
        this.statusFilter = (element.dataset.status as typeof this.statusFilter) ?? 'todos';
        this.update();
    }

    private onClearFilters(): void {
        this.query = '';
        this.categoryFilter = 'todas';
        this.statusFilter = 'todos';
        this.update();
    }

    private onTogglePublish(element: HTMLElement): void {
        const id = element.dataset.id;
        if (!id) return;

        const product = this.repository.getById(id);
        if (!product) return;

        this.repository.update({ ...product, published: !product.published, updatedAt: Date.now() });
        toast.success(
            product.published ? `"${product.title}" saiu da vitrine.` : `"${product.title}" está publicado.`,
            'Status atualizado',
        );
    }

    private onDuplicate(element: HTMLElement): void {
        const id = element.dataset.id;
        if (!id) return;

        const copy = this.repository.duplicate(id);
        toast.success(`Cópia criada como rascunho: "${copy.title}".`, 'Duplicado');
    }

    private async onDelete(element: HTMLElement): Promise<void> {
        const id = element.dataset.id;
        if (!id) return;

        const product = this.repository.getById(id);
        if (!product) return;

        const confirmed = await confirmDialog({
            title: 'Excluir produto',
            message: `Tem certeza que deseja excluir "${product.title}"? Você poderá desfazer em seguida.`,
            confirmLabel: 'Excluir',
            danger: true,
        });

        if (!confirmed) return;

        const index = this.repository.getAll().findIndex((item) => item.id === id);
        this.repository.remove(id);
        this.lastDeleted = { product, index };
        this.update();

        toast.warning(`"${product.title}" foi excluído.`, 'Produto removido');
    }

    private onUndoDelete(): void {
        if (!this.lastDeleted) return;

        const { product, index } = this.lastDeleted;
        const products = [...this.repository.getAll()];
        products.splice(Math.max(0, index), 0, product);
        this.repository.replaceAll(products);

        this.lastDeleted = null;
        toast.success(`"${product.title}" foi restaurado.`, 'Desfeito');
    }

    private onDismissUndo(): void {
        this.lastDeleted = null;
        this.update();
    }

    private onExport(): void {
        this.element.dispatchEvent(new CustomEvent('admin:export', { bubbles: true }));
    }

    private onImport(): void {
        this.element.dispatchEvent(new CustomEvent('admin:import', { bubbles: true }));
    }
}

/** Capitaliza a primeira letra. */
function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
