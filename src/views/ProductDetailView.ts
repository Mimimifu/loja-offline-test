/**
 * @file views/ProductDetailView.ts
 * @description Página de detalhe de um produto, com o fluxo de conversão:
 *
 *   Selecionado  →  Pagamento  →  Download liberado
 *
 * Limitação honesta: sem backend, é impossível confirmar um pagamento real.
 * A v4 simplesmente exibia o link de download lado a lado com o de pagamento,
 * o que anula o propósito da vitrine. Aqui o download só é liberado após o
 * usuário declarar que pagou ("Já efetuei o pagamento"), e essa confirmação
 * fica registrada localmente por produto.
 *
 * Para vender de verdade, o `paymentLink` deve apontar para um checkout
 * (Mercado Pago, Hotmart, Gumroad, Stripe) que entregue o arquivo após a
 * confirmação — ou a aplicação precisa de um endpoint de validação, que o
 * `HttpClient` de `core/http.ts` já está pronto para consumir.
 */

import { Component, html, raw, SafeHtml } from '../core/dom';
import { AppState } from '../core/appState';
import { AppStateData, Product } from '../core/types';
import { ProductRepository } from '../data/productRepository';
import { CATEGORY_LABELS } from '../ui/ProductCard';
import { formatCurrency, formatDate, truncate } from '../core/utils';
import { toast } from '../ui/toast';
import { Router } from '../core/router';

/** Estado da conversão para um produto. */
type FlowState = 'selecionado' | 'pago';

/** Página de detalhe. */
export class ProductDetailView extends Component {
    private readonly appState: AppState<AppStateData>;
    private readonly repository: ProductRepository;
    private readonly router: Router;
    private readonly productId: string;
    private flowState: FlowState = 'selecionado';

    constructor(appState: AppState<AppStateData>, repository: ProductRepository, router: Router, productId: string) {
        super('div', 'page product-detail-view');
        this.appState = appState;
        this.repository = repository;
        this.router = router;
        this.productId = productId;
        this.flowState = readPurchaseState(productId) ? 'pago' : 'selecionado';
    }

    protected render(): SafeHtml {
        const product = this.repository.getById(this.productId);

        if (!product) return this.renderNotFound();

        return html`
            <nav class="breadcrumbs" aria-label="Trilha de navegação">
                <a href="/">Vitrine</a>
                <span class="breadcrumbs__sep" aria-hidden="true">/</span>
                <a href="/produtos">Produtos</a>
                <span class="breadcrumbs__sep" aria-hidden="true">/</span>
                <span aria-current="page">${truncate(product.title, 42)}</span>
            </nav>

            <div class="product-detail">
                <div class="product-detail__media">
                    ${product.image
                        ? html`<img src="${product.image}" alt="Imagem de ${product.title}">`
                        : html`<span class="product-detail__placeholder" aria-hidden="true">📦</span>`}
                </div>

                <div>
                    <div class="product-detail__meta">
                        <span class="badge">${CATEGORY_LABELS[product.category]}</span>
                        ${product.published ? '' : html`<span class="badge badge--warning">Rascunho</span>`}
                        ${product.priceCents === 0 ? html`<span class="badge badge--success">Gratuito</span>` : ''}
                    </div>

                    <h2>${product.title}</h2>

                    <div class="product-detail__price">
                        ${product.priceCents === 0 ? 'Grátis' : formatCurrency(product.priceCents)}
                    </div>

                    ${this.renderFlowSteps()}

                    <p class="product-detail__description">${product.description}</p>

                    ${product.tags.length > 0
                        ? html`<div class="tag-list" style="margin-bottom: 1.25rem;">
                              ${product.tags.map((tag) => html`<span class="badge badge--neutral">${tag}</span>`)}
                          </div>`
                        : ''}

                    <div class="product-detail__actions">${this.renderActions(product)}</div>

                    <p class="text-muted" style="font-size: 0.8rem; margin-top: 1rem;">
                        Atualizado em ${formatDate(product.updatedAt)}
                    </p>
                </div>
            </div>

            ${this.renderTechnicalNotice()}
        `;
    }

    /** Indicador visual das três etapas da conversão. */
    private renderFlowSteps(): SafeHtml {
        const steps: { label: string; state: FlowState | 'done' }[] = [
            { label: '1. Escolher', state: 'selecionado' },
            { label: '2. Pagar', state: this.flowState === 'pago' ? 'done' : 'selecionado' },
            { label: '3. Baixar', state: this.flowState === 'pago' ? 'done' : 'selecionado' },
        ];

        return html`
            <div class="flow-steps" role="list" aria-label="Etapas da compra">
                ${steps.map((step, index) => {
                    const isActive = this.flowState === 'selecionado' ? index === 0 : index === 2;
                    const state = step.state === 'done' && !isActive ? 'done' : isActive ? 'active' : 'idle';
                    return html`
                        <div class="flow-step" role="listitem" data-state="${state}">
                            <span aria-hidden="true">${state === 'done' ? '✔' : '○'}</span>
                            <span>${step.label}</span>
                        </div>
                    `;
                })}
            </div>
        `;
    }

    /** Botões de ação conforme o estado da conversão. */
    private renderActions(product: Product): SafeHtml {
        const isFree = product.priceCents === 0;

        if (this.flowState === 'pago' || isFree) {
            return html`
                ${product.downloadLink
                    ? html`
                          <a
                              class="btn btn--success btn--block"
                              href="${product.downloadLink}"
                              target="_blank"
                              rel="noopener noreferrer"
                              download
                          >⬇️ Baixar agora</a>
                      `
                    : html`
                          <div class="callout callout--warning">
                              <span class="callout__icon" aria-hidden="true">⚠️</span>
                              <div>Este produto ainda não tem link de download configurado. Avise quem o cadastrou.</div>
                          </div>
                      `}
                ${!isFree && readPurchaseState(product.id)
                    ? html`<button type="button" class="btn btn--ghost btn--sm" data-action="resetPurchase">
                          Já baixei — reiniciar fluxo
                      </button>`
                    : ''}
            `;
        }

        if (!product.paymentLink) {
            return html`
                <div class="callout callout--warning">
                    <span class="callout__icon" aria-hidden="true">⚠️</span>
                    <div>Este produto não tem link de pagamento configurado.</div>
                </div>
            `;
        }

        return html`
            <a
                class="btn btn--primary btn--block"
                href="${product.paymentLink}"
                target="_blank"
                rel="noopener noreferrer"
                data-action="goToPayment"
            >💳 ${product.paymentLabel || 'Comprar'}</a>

            <button type="button" class="btn btn--outline btn--block" data-action="confirmPayment">
                ✔ Já efetuei o pagamento
            </button>

            <p class="text-muted" style="font-size: 0.8rem; text-align: center;">
                O botão de pagamento abre em uma nova aba. Volte aqui e confirme para liberar o download.
            </p>
        `;
    }

    /** Aviso sobre o escopo da validação de pagamento. */
    private renderTechnicalNotice(): SafeHtml {
        return html`
            <div class="callout callout--info" style="margin-top: 2rem;">
                <span class="callout__icon" aria-hidden="true">ℹ️</span>
                <div>
                    <strong>Sobre a entrega:</strong> esta é uma aplicação 100% offline, sem servidor.
                    A confirmação de pagamento é declarada pelo próprio comprador e fica salva apenas neste navegador.
                    Para cobrar de verdade, aponte o link de pagamento para um checkout
                    (Mercado Pago, Gumroad, Stripe, Hotmart) que libere o arquivo após a confirmação.
                </div>
            </div>
        `;
    }

    /** Estado de produto inexistente. */
    private renderNotFound(): SafeHtml {
        return html`
            <div class="empty-state">
                <div class="empty-state__icon" aria-hidden="true">🔍</div>
                <h3 class="empty-state__title">Produto não encontrado</h3>
                <p class="empty-state__text">
                    O item que você procura não existe ou foi removido do catálogo.
                </p>
                <a class="btn btn--primary" href="/">← Voltar para a vitrine</a>
            </div>
        `;
    }

    protected override afterRender(): void {
        this.delegate('click');
    }

    /* -------------------------------------------------------------- ações -- */

    private onGoToPayment(): void {
        // O clique segue o link normalmente; este hook existe para telemetria futura.
    }

    private onConfirmPayment(): void {
        writePurchaseState(this.productId, true);
        this.flowState = 'pago';
        this.update();
        toast.success('Download liberado. Bom proveito!', 'Pagamento confirmado');
    }

    private onResetPurchase(): void {
        writePurchaseState(this.productId, false);
        this.flowState = 'selecionado';
        this.update();
        toast.info('Fluxo reiniciado para este produto.');
    }
}

/** Chave de armazenamento das compras confirmadas localmente. */
const PURCHASE_KEY = 'dsp5:purchases';

/** Lê o mapa de compras confirmadas. */
function readPurchaseMap(): Record<string, number> {
    try {
        const raw = localStorage.getItem(PURCHASE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
    } catch {
        return {};
    }
}

/** Verifica se um produto já foi marcado como pago. */
export function readPurchaseState(productId: string): boolean {
    return Boolean(readPurchaseMap()[productId]);
}

/** Grava/limpa a marcação de pago de um produto. */
function writePurchaseState(productId: string, paid: boolean): void {
    const map = readPurchaseMap();

    if (paid) {
        map[productId] = Date.now();
    } else {
        delete map[productId];
    }

    try {
        localStorage.setItem(PURCHASE_KEY, JSON.stringify(map));
    } catch {
        // Falha de cota aqui não é crítica: o fluxo continua funcionando em memória.
    }
}

/** Reexporta o router para manter o tipo acessível às views vizinhas. */
export type { Router };
