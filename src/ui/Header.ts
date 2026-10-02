/**
 * @file ui/Header.ts
 * @description Cabeçalho fixo: marca, indicador de conectividade, status dos
 * testes e controles globais (tema, sidebar, sincronização).
 */

import { Component, html, raw, SafeHtml } from '../core/dom';
import { AppState } from '../core/appState';
import { AppStateData } from '../core/types';
import { TestSummary } from '../tests';
import { Router } from '../core/router';

/** Dependências do cabeçalho. */
export interface HeaderDeps {
    appState: AppState<AppStateData>;
    router: Router;
    /** Dispara a sincronização com a API externa. */
    onSync: () => void;
    /** Abre o painel de status dos testes. */
    onShowTests: () => void;
    /** Abre/fecha a sidebar no mobile. */
    onToggleMobileSidebar: () => void;
}

/** Cabeçalho da aplicação. */
export class Header extends Component {
    private readonly deps: HeaderDeps;
    private testSummary: TestSummary | null = null;
    private syncing = false;

    constructor(deps: HeaderDeps) {
        super('header', 'header app-shell__header');
        this.deps = deps;
    }

    /** Atualiza o resumo de testes exibido no indicador. */
    setTestSummary(summary: TestSummary): void {
        this.testSummary = summary;
        this.update();
    }

    /** Marca visualmente que uma sincronização está em andamento. */
    setSyncing(syncing: boolean): void {
        this.syncing = syncing;
        this.update();
    }

    protected render(): SafeHtml {
        const { settings, pendingOps, isOnline, lastSyncAt } = this.deps.appState.getState();
        const pendingCount = pendingOps.length;

        return html`
            <button
                type="button"
                class="btn btn--icon mobile-only-toggle"
                data-action="toggleMobileSidebar"
                aria-label="Abrir menu de navegação"
            >☰</button>

            <div class="header__brand">
                <span class="header__logo" aria-hidden="true">◆</span>
                <span>Digital Store Pro</span>
                <span class="badge badge--neutral">v5</span>
            </div>

            <div class="header__spacer"></div>

            <span class="header__title" data-test-slot>
                ${this.describeSyncState(pendingCount, lastSyncAt)}
            </span>

            ${this.renderConnectivity(isOnline)}

            <button
                type="button"
                class="test-status"
                data-action="showTests"
                data-state="${this.testState()}"
                aria-label="Ver resultados dos testes automatizados"
            >${this.testLabel()}</button>

            <div class="header__actions">
                <button
                    type="button"
                    class="btn btn--icon"
                    data-action="sync"
                    aria-label="Sincronizar com a API"
                    title="${pendingCount > 0 ? `${pendingCount} operação(ões) pendente(s)` : 'Sincronizar'}"
                    ${this.syncing || !isOnline ? raw('disabled') : ''}
                >${this.syncing ? '⏳' : '⟳'}${pendingCount > 0 ? html`<span aria-hidden="true">•</span>` : ''}</button>

                <button
                    type="button"
                    class="btn btn--icon"
                    data-action="toggleTheme"
                    aria-label="Alternar tema ${settings.theme === 'light' ? 'escuro' : 'claro'}"
                    title="Alternar tema"
                >${settings.theme === 'light' ? '🌙' : '☀️'}</button>

                <button
                    type="button"
                    class="btn btn--icon"
                    data-action="toggleSidebar"
                    aria-label="${settings.sidebarCollapsed ? 'Expandir' : 'Recolher'} menu lateral"
                    title="Recolher/expandir menu"
                >${settings.sidebarCollapsed ? '»' : '«'}</button>
            </div>
        `;
    }

    protected override afterRender(): void {
        this.delegate('click');
    }

    /** Texto do indicador de sincronização. */
    private describeSyncState(pendingCount: number, lastSyncAt: number | null): string {
        if (pendingCount > 0) return `${pendingCount} alteração(ões) pendente(s)`;

        if (lastSyncAt) {
            const minutes = Math.floor((Date.now() - lastSyncAt) / 60000);
            if (minutes < 1) return 'Sincronizado agora';
            if (minutes < 60) return `Sincronizado há ${minutes} min`;
            return `Sincronizado há ${Math.floor(minutes / 60)} h`;
        }

        return 'Dados salvos localmente';
    }

    /** Badge de conectividade. */
    private renderConnectivity(isOnline: boolean): SafeHtml {
        return html`
            <span class="connectivity" data-state="${isOnline ? 'online' : 'offline'}">
                <span class="connectivity__dot" aria-hidden="true"></span>
                ${isOnline ? 'Online' : 'Offline'}
            </span>
        `;
    }

    /** Estado do indicador de testes para o CSS. */
    private testState(): string {
        if (!this.testSummary) return 'running';
        return this.testSummary.failed === 0 ? 'pass' : 'fail';
    }

    /** Rótulo do indicador de testes. */
    private testLabel(): string {
        if (!this.testSummary) return '⏳ testes…';
        const { passed, total, failed } = this.testSummary;
        return failed === 0 ? `✅ ${passed}/${total}` : `❌ ${failed}/${total}`;
    }

    /* -------------------------------------------------------------- ações -- */

    private onToggleTheme(): void {
        const current = this.deps.appState.select('settings');
        this.deps.appState.setState({
            settings: { ...current, theme: current.theme === 'light' ? 'dark' : 'light' },
        });
    }

    private onToggleSidebar(): void {
        const current = this.deps.appState.select('settings');
        this.deps.appState.setState({
            settings: { ...current, sidebarCollapsed: !current.sidebarCollapsed },
        });
    }

    private onToggleMobileSidebar(): void {
        this.deps.onToggleMobileSidebar();
    }

    private onSync(): void {
        this.deps.onSync();
    }

    private onShowTests(): void {
        this.deps.onShowTests();
    }
}
