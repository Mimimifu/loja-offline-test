/**
 * @file ui/Sidebar.ts
 * @description Navegação lateral com estado ativo derivado do roteador.
 *
 * Diferença em relação à v4: a v4 criava elementos `<a href>` e interceptava o
 * clique manualmente, sem nunca marcar o item ativo (o usuário não sabia onde
 * estava). Aqui o item ativo é derivado do path atual e anunciado via
 * `aria-current="page"`.
 */

import { Component, html, raw, SafeHtml } from '../core/dom';
import { AppState } from '../core/appState';
import { AppStateData } from '../core/types';
import { Router } from '../core/router';

/** Item de navegação. */
interface NavItem {
    label: string;
    path: string;
    icon: string;
    /** Chave numérica exibida como badge (ex: total de produtos). */
    badgeKey?: 'products' | 'drafts' | 'pending';
    /** Rota exige correspondência exata (evita ativar "/admin" em "/admin/editar/1"). */
    exact?: boolean;
}

/** Navegação lateral. */
export class Sidebar extends Component {
    private readonly appState: AppState<AppStateData>;
    private readonly items: NavItem[];
    /** Callback invocado após uma navegação (fecha o drawer no mobile). */
    private readonly onNavigated: () => void;

    /**
     * @param appState Estado global (para os badges).
     * @param router Roteador (para marcar o item ativo).
     * @param onNavigate Callback executado após navegar (fecha o drawer no mobile).
     */
    constructor(appState: AppState<AppStateData>, router: Router, onNavigate: () => void) {
        super('nav', 'sidebar app-shell__sidebar');
        this.appState = appState;
        this.onNavigated = onNavigate;

        this.element.setAttribute('aria-label', 'Navegação principal');

        this.items = [
            { label: 'Vitrine', path: '/', icon: '🏪', exact: true },
            { label: 'Produtos', path: '/produtos', icon: '📦', badgeKey: 'products' },
            { label: 'Gerenciar', path: '/admin', icon: '🗂️', badgeKey: 'drafts' },
            { label: 'Novo produto', path: '/admin/novo', icon: '➕' },
            { label: 'Configurações', path: '/config', icon: '⚙️' },
        ];

        // Re-renderiza ao mudar de rota para atualizar o item ativo.
        router.subscribe(() => this.update());
        // Re-renderiza quando os dados mudam para atualizar os badges.
        appState.subscribe(() => this.update());
    }

    protected render(): SafeHtml {
        const currentPath = this.resolveCurrentPath();

        return html`
            <div class="sidebar__section-label">Navegação</div>

            ${this.items.map((item) => this.renderItem(item, currentPath))}

            <div class="sidebar__footer">
                <button type="button" class="nav-item" data-action="exportBackup">
                    <span class="nav-item__icon" aria-hidden="true">⬇️</span>
                    <span class="nav-item__label">Exportar backup</span>
                </button>
                <button type="button" class="nav-item" data-action="showShortcuts">
                    <span class="nav-item__icon" aria-hidden="true">⌨️</span>
                    <span class="nav-item__label">Atalhos</span>
                </button>
            </div>
        `;
    }

    /** Um item de navegação. */
    private renderItem(item: NavItem, currentPath: string): SafeHtml {
        const isActive = item.exact ? currentPath === item.path : currentPath === item.path || currentPath.startsWith(`${item.path}/`);

        const badge = item.badgeKey ? this.badgeValue(item.badgeKey) : null;

        return html`
            <a
                class="nav-item ${isActive ? 'is-active' : ''}"
                href="${item.path}"
                data-action="navigate"
                data-path="${item.path}"
                ${isActive ? raw('aria-current="page"') : ''}
            >
                <span class="nav-item__icon" aria-hidden="true">${raw(item.icon)}</span>
                <span class="nav-item__label">${item.label}</span>
                ${badge !== null ? html`<span class="nav-item__badge">${badge}</span>` : ''}
            </a>
        `;
    }

    /** Valor numérico do badge. */
    private badgeValue(key: NonNullable<NavItem['badgeKey']>): number | null {
        const state = this.appState.getState();

        switch (key) {
            case 'products':
                return state.products.length;
            case 'drafts':
                return state.products.filter((product) => !product.published).length || null;
            case 'pending':
                return state.pendingOps.length || null;
            default:
                return null;
        }
    }

    /** Path atual lido do `window.location` (a sidebar apenas reflete a URL). */
    private resolveCurrentPath(): string {
        const raw = window.location.pathname || '/';
        return raw.length > 1 ? raw.replace(/\/+$/, '') : '/';
    }

    protected override afterRender(): void {
        this.delegate('click');
    }

    /* -------------------------------------------------------------- ações -- */

    /**
     * Navegação por link.
     * O roteador já intercepta cliques em `<a href>` internos; aqui apenas
     * sinalizamos o fechamento do drawer no mobile.
     */
    private onNavigate(element: HTMLElement): void {
        if (element.dataset.path) this.onNavigated();
    }

    private onExportBackup(): void {
        this.element.dispatchEvent(new CustomEvent('sidebar:export', { bubbles: true }));
    }

    private onShowShortcuts(): void {
        this.element.dispatchEvent(new CustomEvent('sidebar:shortcuts', { bubbles: true }));
    }
}
