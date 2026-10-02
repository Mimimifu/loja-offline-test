/**
 * @file views/StoreView.ts
 * @description Vitrine pública: grade de produtos com busca, filtro por
 * categoria e ordenação.
 *
 * O estado de filtro é sincronizado com a query string, de modo que a busca é
 * compartilhável por link e sobrevive ao recarregamento da página.
 */

import { Component, html, raw, SafeHtml } from '../core/dom';
import { AppState } from '../core/appState';
import { AppStateData, Product, ProductCategory } from '../core/types';
import { ProductRepository } from '../data/productRepository';
import { CATEGORY_LABELS, renderProductCard } from '../ui/ProductCard';
import { Router } from '../core/router';
import { debounce } from '../core/utils';

/** Vitrine. */
export class StoreView extends Component {
    private readonly repository: ProductRepository;
    private readonly router: Router;
    private readonly appState: AppState<AppStateData>;

    private query = '';
    private category: ProductCategory | 'todas' = 'todas';
    private sortBy: 'recent' | 'price-asc' | 'price-desc' | 'title' = 'recent';

    constructor(appState: AppState<AppStateData>, repository: ProductRepository, router: Router) {
        super('div', 'page store-view');
        this.appState = appState;
        this.repository = repository;
        this.router = router;

        // Restaura filtros da URL.
        const params = router.getCurrentContext().query;
        this.query = params.get('q') ?? '';
        this.category = (params.get('categoria') as ProductCategory | null) ?? 'todas';
        this.sortBy = (params.get('ordem') as typeof this.sortBy | null) ?? 'recent';

        // Reage a mudanças no catálogo (ex: após importar um backup).
        appState.subscribe((_state, changedKeys) => {
            if (changedKeys.includes('products')) this.update();
        });

        this.onSearchInput = debounce((value: string) => {
            this.query = value;
            this.syncUrl();
            this.update();
        }, 220);
    }

    /** Versão debounced do handler de busca. */
    private readonly onSearchInput: (value: string) => void;

    protected render(): SafeHtml {
        const products = this.repository.list({
            query: this.query,
            category: this.category,
            sortBy: this.sortBy,
        });

        const counts = this.repository.countByCategory();

        return html`
            <div class="page-header">
                <div class="page-header__text">
                    <h2>Vitrine de produtos digitais</h2>
                    <p class="page-header__subtitle">
                        PDFs, músicas, planilhas e cursos — tudo funcionando offline e salvo no seu navegador.
                    </p>
                </div>
                <div class="page-header__actions">
                    <a class="btn btn--primary" href="/admin/novo">➕ Novo produto</a>
                </div>
            </div>

            ${this.renderStats()}

            <div class="toolbar">
                <div class="toolbar__search">
                    <span class="toolbar__search-icon" aria-hidden="true">🔍</span>
                    <label class="visually-hidden" for="store-search">Buscar produtos</label>
                    <input
                        type="search"
                        id="store-search"
                        class="form-control"
                        placeholder="Buscar por título, descrição ou tag…"
                        value="${this.query}"
                        data-role="search-input"
                        autocomplete="off"
                    >
                </div>

                <div class="filter-chips" role="group" aria-label="Filtrar por categoria">
                    ${this.renderCategoryChip('todas', counts, 'Todas')}
                    ${Object.keys(CATEGORY_LABELS).map((key) =>
                        this.renderCategoryChip(key as ProductCategory, counts, CATEGORY_LABELS[key as ProductCategory]),
                    )}
                </div>

                <label class="visually-hidden" for="store-sort">Ordenar por</label>
                <select class="select-inline" id="store-sort" data-role="sort-select">
                    <option value="recent" ${this.sortBy === 'recent' ? raw('selected') : ''}>Mais recentes</option>
                    <option value="title" ${this.sortBy === 'title' ? raw('selected') : ''}>Título (A–Z)</option>
                    <option value="price-asc" ${this.sortBy === 'price-asc' ? raw('selected') : ''}>Menor preço</option>
                    <option value="price-desc" ${this.sortBy === 'price-desc' ? raw('selected') : ''}>Maior preço</option>
                </select>
            </div>

            <div class="product-grid" data-density="${this.appState.select('settings').gridDensity}">
                ${products.length === 0 ? this.renderEmptyState() : products.map((product) => renderProductCard(product))}
            </div>
        `;
    }

    /** Resumo numérico do catálogo. */
    private renderStats(): SafeHtml {
        const stats = this.repository.getStats();

        return html`
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-card__label">Publicados</div>
                    <div class="stat-card__value">${stats.published}</div>
                    <div class="stat-card__hint">${stats.drafts} rascunho(s)</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card__label">Categorias</div>
                    <div class="stat-card__value">${Object.keys(this.repository.countByCategory()).length}</div>
                    <div class="stat-card__hint">ativas no catálogo</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card__label">Preço médio</div>
                    <div class="stat-card__value">${formatShortCurrency(stats.avgPriceCents)}</div>
                    <div class="stat-card__hint">entre os itens cadastrados</div>
                </div>
            </div>
        `;
    }

    /** Chip de filtro de categoria. */
    private renderCategoryChip(category: ProductCategory | 'todas', counts: Record<string, number>, label: string): SafeHtml {
        const isActive = this.category === category;
        const count = category === 'todas' ? Object.values(counts).reduce((sum, value) => sum + value, 0) : (counts[category] ?? 0);

        return html`
            <button
                type="button"
                class="chip"
                data-action="setCategory"
                data-category="${category}"
                aria-pressed="${isActive ? 'true' : 'false'}"
            >${label}${count > 0 ? html` <span aria-hidden="true">(${count})</span>` : ''}</button>
        `;
    }

    /** Estado vazio, adaptado para "sem produtos" vs. "sem resultados". */
    private renderEmptyState(): SafeHtml {
        const hasFilter = this.query.trim() !== '' || this.category !== 'todas';

        if (hasFilter) {
            return html`
                <div class="empty-state">
                    <div class="empty-state__icon" aria-hidden="true">🔍</div>
                    <h3 class="empty-state__title">Nenhum produto encontrado</h3>
                    <p class="empty-state__text">
                        Nenhum item corresponde aos filtros atuais. Tente outro termo ou remova os filtros.
                    </p>
                    <button type="button" class="btn btn--outline" data-action="clearFilters">Limpar filtros</button>
                </div>
            `;
        }

        return html`
            <div class="empty-state">
                <div class="empty-state__icon" aria-hidden="true">📦</div>
                <h3 class="empty-state__title">Sua vitrine está vazia</h3>
                <p class="empty-state__text">
                    Cadastre seu primeiro produto digital — ou importe um backup JSON se já tinha dados nas versões anteriores.
                </p>
                <div class="row" style="justify-content: center;">
                    <a class="btn btn--primary" href="/admin/novo">➕ Cadastrar produto</a>
                    <a class="btn btn--outline" href="/config">Importar backup</a>
                </div>
            </div>
        `;
    }

    protected override afterRender(): void {
        this.delegate('click');
        this.bindInputs();
    }

    /** Liga busca (com debounce) e seletor de ordenação. */
    private bindInputs(): void {
        const searchInput = this.element.querySelector<HTMLInputElement>('[data-role="search-input"]');
        if (searchInput) {
            this.listen(searchInput, 'input', () => this.onSearchInput(searchInput.value));
        }

        const sortSelect = this.element.querySelector<HTMLSelectElement>('[data-role="sort-select"]');
        if (sortSelect) {
            this.listen(sortSelect, 'change', () => {
                this.sortBy = sortSelect.value as typeof this.sortBy;
                this.syncUrl();
                this.update();
            });
        }
    }

    /** Reflete os filtros atuais na query string. */
    private syncUrl(): void {
        const params = new URLSearchParams();
        if (this.query.trim()) params.set('q', this.query.trim());
        if (this.category !== 'todas') params.set('categoria', this.category);
        if (this.sortBy !== 'recent') params.set('ordem', this.sortBy);

        const search = params.toString();
        this.router.navigate(`/${search ? `?${search}` : ''}`, { replace: true });
    }

    /* -------------------------------------------------------------- ações -- */

    private onSetCategory(element: HTMLElement): void {
        this.category = (element.dataset.category as ProductCategory | 'todas') ?? 'todas';
        this.syncUrl();
        this.update();
    }

    private onClearFilters(): void {
        this.query = '';
        this.category = 'todas';
        this.sortBy = 'recent';
        this.syncUrl();
        this.update();
    }
}

/** Formata valores grandes de forma compacta (ex: R$ 1,2 mil). */
function formatShortCurrency(cents: number): string {
    const reais = cents / 100;
    if (reais < 1000) return `R$ ${reais.toFixed(2).replace('.', ',')}`;
    return `R$ ${(reais / 1000).toFixed(1).replace('.', ',')} mil`;
}

/** Reexporta o tipo para uso das views que montam a vitrine. */
export type { Product };
