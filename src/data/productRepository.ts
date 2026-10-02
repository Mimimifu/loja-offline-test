/**
 * @file data/productRepository.ts
 * @description Repositório de produtos sobre o `AppState`.
 *
 * Isola as regras de coleção (criar, atualizar, remover, filtrar) da camada de
 * estado e da UI — nenhum componente manipula o array diretamente.
 *
 * Toda mutação também registra uma entrada em `pendingOps` (padrão *outbox*),
 * permitindo que o botão de sincronização saiba exatamente o que enviar à API.
 */

import { AppState } from '../core/appState';
import { Product, ProductCategory } from '../core/types';
import { AppStateData, PendingOperation } from '../core/types';
import { NotFoundError } from '../core/errors';
import { matchesSearch, normalizeForSearch, uid } from '../core/utils';
import { findByIdLoose, idsMatch } from '../core/routeParams';

/** Filtros aceitos na listagem. */
export interface ProductFilter {
    query?: string;
    category?: ProductCategory | 'todas';
    /** Inclui itens não publicados (visão de administração). */
    includeUnpublished?: boolean;
    sortBy?: 'recent' | 'price-asc' | 'price-desc' | 'title';
}

/**
 * Repositório de produtos.
 */
export class ProductRepository {
    private readonly appState: AppState<AppStateData>;

    /** @param appState Estado global. */
    constructor(appState: AppState<AppStateData>) {
        this.appState = appState;
    }

    /** Todos os produtos. */
    getAll(): Product[] {
        return this.appState.select('products');
    }

    /**
     * Busca por id.
     *
     * A comparação é tolerante a tipo e caixa (`42` casa com `"42"`) porque ids
     * vindos de backups antigos podem ser numéricos, enquanto os ids gerados
     * agora são UUIDs em texto. Comparar com `===` era a causa do bug relatado
     * no log do projeto: "a parte de edição não carregou os dados".
     *
     * @param id Identificador procurado.
     * @returns O produto ou `null`.
     */
    getById(id: string): Product | null {
        return findByIdLoose(this.getAll(), id);
    }

    /**
     * Busca por id, lançando se não existir.
     * @throws {NotFoundError}
     */
    requireById(id: string): Product {
        const product = this.getById(id);
        if (!product) throw new NotFoundError(`Produto "${id}" não encontrado.`);
        return product;
    }

    /**
     * Aplica filtros/paginação local.
     * @param filter Critérios de filtro e ordenação.
     */
    list(filter: ProductFilter = {}): Product[] {
        const { query = '', category = 'todas', includeUnpublished = false, sortBy = 'recent' } = filter;

        const filtered = this.getAll().filter((product) => {
            if (!includeUnpublished && !product.published) return false;
            if (category !== 'todas' && product.category !== category) return false;

            if (query.trim()) {
                const haystack = [product.title, product.description, product.category, product.tags.join(' ')].join(' ');
                if (!matchesSearch(haystack, query)) return false;
            }
            return true;
        });

        return this.sort(filtered, sortBy);
    }

    /** Ordena uma lista de produtos. */
    private sort(products: Product[], sortBy: NonNullable<ProductFilter['sortBy']>): Product[] {
        const copy = [...products];

        switch (sortBy) {
            case 'price-asc':
                return copy.sort((a, b) => a.priceCents - b.priceCents);
            case 'price-desc':
                return copy.sort((a, b) => b.priceCents - a.priceCents);
            case 'title':
                return copy.sort((a, b) => normalizeForSearch(a.title).localeCompare(normalizeForSearch(b.title), 'pt-BR'));
            case 'recent':
            default:
                return copy.sort((a, b) => b.updatedAt - a.updatedAt);
        }
    }

    /** Contagem por categoria (usada nos filtros da vitrine). */
    countByCategory(): Record<string, number> {
        return this.getAll().reduce<Record<string, number>>((acc, product) => {
            acc[product.category] = (acc[product.category] ?? 0) + 1;
            return acc;
        }, {});
    }

    /** Estatísticas para o painel administrativo. */
    getStats(): { total: number; published: number; drafts: number; avgPriceCents: number; inventoryCents: number } {
        const products = this.getAll();
        const published = products.filter((product) => product.published);
        const totalCents = products.reduce((sum, product) => sum + product.priceCents, 0);

        return {
            total: products.length,
            published: published.length,
            drafts: products.length - published.length,
            avgPriceCents: products.length === 0 ? 0 : Math.round(totalCents / products.length),
            inventoryCents: totalCents,
        };
    }

    /**
     * Cria um produto (id e timestamps já definidos por `formValuesToProduct`).
     * @param product Produto validado.
     */
    create(product: Product): void {
        const withId: Product = { ...product, id: product.id || uid() };
        this.appState.setState({
            products: [...this.getAll(), withId],
        });
        this.enqueue('create', withId.id);
    }

    /**
     * Atualiza um produto existente.
     * @param product Produto com o id a sobrescrever.
     * @throws {NotFoundError}
     */
    update(product: Product): void {
        const existing = this.requireById(product.id);

        this.appState.setState({
            // Preserva o id original: evita criar um registro duplicado caso o
            // formulário devolva o id com caixa diferente ("AbC" vs "abc").
            products: this.getAll().map((current) => (idsMatch(current.id, existing.id) ? { ...product, id: existing.id } : current)),
        });
        this.enqueue('update', existing.id);
    }

    /**
     * Remove um produto.
     * @param id Identificador.
     * @throws {NotFoundError}
     */
    remove(id: string): void {
        const existing = this.requireById(id);

        this.appState.setState({
            products: this.getAll().filter((product) => !idsMatch(product.id, existing.id)),
        });
        this.enqueue('delete', existing.id);
    }

    /**
     * Duplica um produto como rascunho não publicado.
     * @param id Id do produto de origem.
     * @returns O novo produto.
     */
    duplicate(id: string): Product {
        const source = this.requireById(id);
        const copy: Product = {
            ...source,
            id: uid(),
            title: `${source.title} (cópia)`,
            published: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        this.appState.setState({ products: [...this.getAll(), copy] });
        this.enqueue('create', copy.id);
        return copy;
    }

    /**
     * Substitui toda a coleção (usado na importação de backup).
     * @param products Nova coleção.
     */
    replaceAll(products: Product[]): void {
        this.appState.setState({ products });
    }

    /** Registra a operação na fila de sincronização. */
    private enqueue(kind: PendingOperation['kind'], productId: string): void {
        const pending = this.appState.select('pendingOps');
        const operation: PendingOperation = { id: uid(), kind, productId, createdAt: Date.now() };
        this.appState.setState({ pendingOps: [...pending, operation] });
    }
}
