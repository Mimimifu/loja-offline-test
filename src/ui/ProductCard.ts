/**
 * @file ui/ProductCard.ts
 * @description Renderização do card de produto, compartilhada entre a vitrine
 * e o painel administrativo.
 *
 * Segurança: todo dado do usuário passa pela template tag `html`, que escapa
 * cada interpolação. A v4 interpolava títulos e descrições diretamente em
 * `innerHTML`, permitindo XSS armazenado via cadastro de produto.
 */

import { html, raw, SafeHtml } from '../core/dom';
import { Product } from '../core/types';
import { ProductCategory } from '../core/types';
import { formatCurrency, truncate } from '../core/utils';

/** Rótulos legíveis das categorias. */
export const CATEGORY_LABELS: Record<ProductCategory, string> = {
    pdf: 'PDF / E-book',
    musica: 'Música',
    planilha: 'Planilha',
    curso: 'Curso',
    template: 'Template',
    outro: 'Outro',
};

/** Ícones por categoria, usados como placeholder sem imagem. */
const CATEGORY_ICONS: Record<ProductCategory, string> = {
    pdf: '📄',
    musica: '🎵',
    planilha: '📊',
    curso: '🎓',
    template: '🧩',
    outro: '📦',
};

/** Opções de renderização do card. */
export interface ProductCardOptions {
    /** Exibe selo de rascunho e ações administrativas. */
    admin?: boolean;
    /** Conteúdo extra no rodapé (ex: botões de editar/excluir). */
    extraActions?: SafeHtml;
}

/**
 * Renderiza um card de produto.
 * @param product Produto a exibir.
 * @param options Ajustes de contexto (vitrine vs. admin).
 */
export function renderProductCard(product: Product, options: ProductCardOptions = {}): SafeHtml {
    const { admin = false, extraActions } = options;
    const href = `/produto/${encodeURIComponent(product.id)}`;
    const isFree = product.priceCents === 0;

    return html`
        <article class="product-card" data-product-id="${product.id}">
            <a class="product-card__media" href="${href}" tabindex="-1" aria-hidden="true">
                ${product.image
                    ? html`<img src="${product.image}" alt="" loading="lazy" decoding="async">`
                    : html`<span class="product-card__placeholder" aria-hidden="true">${raw(CATEGORY_ICONS[product.category])}</span>`}
            </a>

            <div class="product-card__body">
                <div class="row" style="justify-content: space-between;">
                    <span class="badge">${CATEGORY_LABELS[product.category]}</span>
                    ${admin && !product.published ? html`<span class="badge badge--warning">Rascunho</span>` : ''}
                </div>

                <h3 class="product-card__title">
                    <a href="${href}">${product.title}</a>
                </h3>

                <p class="product-card__desc">${truncate(product.description, 110)}</p>

                ${product.tags.length > 0
                    ? html`<div class="tag-list">
                          ${product.tags.slice(0, 3).map((tag) => html`<span class="badge badge--neutral">${tag}</span>`)}
                      </div>`
                    : ''}

                <div class="product-card__footer">
                    <span class="product-card__price ${isFree ? 'product-card__price--free' : ''}">
                        ${isFree ? 'Grátis' : formatCurrency(product.priceCents)}
                    </span>
                    <div class="product-card__actions">
                        ${extraActions ?? ''}
                        <a class="btn btn--primary btn--sm" href="${href}">Ver</a>
                    </div>
                </div>
            </div>
        </article>
    `;
}

/** Ícone de uma categoria (usado em outros lugares). */
export function categoryIcon(category: ProductCategory): string {
    return CATEGORY_ICONS[category];
}
