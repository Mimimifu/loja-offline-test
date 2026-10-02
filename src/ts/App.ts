/**
 * @file App.ts
 * @description Componente raiz: compõe o shell, registra as rotas e coordena
 * os serviços globais (sincronização, backup, atalhos).
 *
 * Correção estrutural em relação à v4: as rotas são declaradas **antes** de o
 * roteador iniciar, e cada view é criada dentro do handler da rota com o
 * contexto correto (`params`, `query`). Na v4, o `main.ts` registrava rotas que
 * só faziam `console.log` e o `App` decidia a view olhando
 * `window.location.pathname` — duas fontes de verdade que podiam divergir.
 */

import { Component, html, qs, SafeHtml } from './core/dom';
import { AppState } from './core/appState';
import { AppStateData, BackupEnvelope } from './core/types';
import { RouteContext, Router } from './core/router';
import { StorageAdapter } from './core/storage';
import { ProductRepository } from './data/productRepository';
import { createBackup, parseBackup } from './data/backupService';
import { Header } from './ui/Header';
import { Sidebar } from './ui/Sidebar';
import { StoreView } from './views/StoreView';
import { ProductDetailView } from './views/ProductDetailView';
import { AdminView } from './views/AdminView';
import { ProductFormView } from './views/ProductFormView';
import { SettingsView, applyColorblindMode } from './views/SettingsView';
import { confirmDialog, openModal } from './ui/modal';
import { toast } from './ui/toast';
import { AppError } from './core/errors';
import { downloadJson, readFileAsText } from './core/utils';
import { HttpClient } from './core/http';
import { TestSummary } from './tests';

/** Dependências injetadas no App. */
export interface AppDeps {
    appState: AppState<AppStateData>;
    router: Router;
    storage: StorageAdapter;
    repository: ProductRepository;
    /** Cliente HTTP usado pela sincronização opcional. */
    http: HttpClient;
    /** Base da API de sincronização (vazia = sincronização simulada). */
    apiBaseUrl: string;
}

/** Aplicação raiz. */
export class App extends Component {
    private readonly deps: AppDeps;
    private readonly header: Header;
    private readonly sidebar: Sidebar;

    /** View atualmente montada no `<main>`. */
    private currentView: Component | null = null;
    private unsubscribeRouter: (() => void) | null = null;
    private unsubscribeState: (() => void) | null = null;
    private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
    /** Observa o DOM para reescrever links internos em modo hash. */
    private linkObserver: MutationObserver | null = null;

    constructor(deps: AppDeps) {
        super('div', 'app-shell');
        this.deps = deps;

        this.header = new Header({
            appState: deps.appState,
            router: deps.router,
            onSync: () => void this.sync(),
            onShowTests: () => this.showTestResults(),
            onToggleMobileSidebar: () => this.toggleMobileSidebar(),
        });

        this.sidebar = new Sidebar(deps.appState, deps.router, () => this.closeMobileSidebar());
    }

    /* ------------------------------------------------------------ render --- */

    protected render(): SafeHtml {
        // O shell é montado uma única vez; header/sidebar são componentes
        // próprios inseridos depois, para não perdê-los a cada re-render.
        return html`
            <main class="app-shell__main" id="main-content" tabindex="-1"></main>
        `;
    }

    /** Inicializa o shell, as rotas e os listeners globais. */
    init(root: HTMLElement): void {
        this.mount(root);

        // Header e Sidebar entram como irmãos, respeitando as grid-areas.
        this.header.mount(this.element);
        this.element.insertBefore(this.sidebar.element, this.element.firstChild);
        this.sidebar.mount(this.element as HTMLElement);

        this.registerRoutes();
        this.applySettings();
        this.bindGlobalEvents();
        this.setupLinkRewriting();

        this.deps.router.start();
    }

    /**
     * Reescreve links internos para o modo de roteamento ativo.
     *
     * As views escrevem sempre `href="/produtos"`. Sob `file://` o roteador opera
     * em modo hash, e um `href="/produtos"` dispararia navegação real para
     * `file:///produtos` (inexistente). Aqui os links passam a `#/produtos`.
     *
     * Um `MutationObserver` cuida disso automaticamente para os nós criados
     * depois (re-renders de componentes), sem que cada view precise saber o modo.
     */
    private setupLinkRewriting(): void {
        if (this.deps.router.modeName !== 'hash') return;

        const rewrite = (root: ParentNode): void => {
            root.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach((anchor) => {
                const href = anchor.getAttribute('href');
                if (href) anchor.setAttribute('href', `#${href}`);
            });
        };

        rewrite(this.element);

        const observer = new MutationObserver((records) => {
            records.forEach((record) => {
                record.addedNodes.forEach((node) => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;

                    const element = node as HTMLElement;
                    if (element.matches?.('a[href^="/"]')) {
                        element.setAttribute('href', `#${element.getAttribute('href')}`);
                    }
                    rewrite(element);
                });
            });
        });

        observer.observe(this.element, { childList: true, subtree: true });
        this.linkObserver = observer;
    }

    /* ------------------------------------------------------------- rotas --- */

    /** Declara todas as rotas da aplicação. */
    private registerRoutes(): void {
        const { router } = this.deps;

        router.addRoute('/', () => this.setView(new StoreView(this.deps.appState, this.deps.repository, router)));
        router.addRoute('/produtos', () => this.setView(new StoreView(this.deps.appState, this.deps.repository, router)));

        router.addRoute('/produto/:id', (context) =>
            this.setView(new ProductDetailView(this.deps.appState, this.deps.repository, router, context.params.id)),
        );

        router.addRoute('/admin', () => this.setView(new AdminView(this.deps.appState, this.deps.repository, router)));
        router.addRoute('/admin/novo', () =>
            this.setView(new ProductFormView(this.deps.appState, this.deps.repository, router)),
        );
        router.addRoute('/admin/editar/:id', (context) =>
            this.setView(new ProductFormView(this.deps.appState, this.deps.repository, router, context.params.id)),
        );

        router.addRoute('/config', () =>
            this.setView(
                new SettingsView(this.deps.appState, this.deps.repository, this.deps.storage, (file) => this.importFile(file)),
            ),
        );

        // Rota de fallback: qualquer caminho desconhecido volta para a vitrine.
        router.subscribe((context: RouteContext) => {
            if (context.pattern === '' && context.path !== '/') {
                console.warn(`[App] Rota desconhecida "${context.path}" — redirecionando para a vitrine.`);
                router.navigate('/', { replace: true });
            }
        });
    }

    /** Troca a view montada no `<main>`. */
    private setView(view: Component): void {
        const main = qs('#main-content', this.element);
        if (!main) return;

        this.currentView?.unmount();
        main.innerHTML = '';
        this.currentView = view;
        view.mount(main);

        // Move o foco para o conteúdo — anuncia a mudança de página (A11y).
        main.focus({ preventScroll: false });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /* ---------------------------------------------------- configurações ---- */

    /** Aplica preferências ao shell sempre que mudam. */
    private applySettings(): void {
        const apply = (): void => {
            const settings = this.deps.appState.select('settings');

            document.documentElement.setAttribute('data-theme', settings.theme);
            document.documentElement.style.setProperty('--accent-color', settings.accentColor);

            this.element.setAttribute('data-sidebar-side', settings.sidebarSide);
            this.element.setAttribute('data-collapsed', String(settings.sidebarCollapsed));

            this.header.update();
        };

        apply();
        this.unsubscribeState = this.deps.appState.subscribe((_state, changedKeys) => {
            if (changedKeys.includes('settings')) apply();
            else this.header.update();
        });
    }

    /* ------------------------------------------------- eventos globais ----- */

    /** Liga listeners de conectividade, atalhos e eventos das views. */
    private bindGlobalEvents(): void {
        const handleOnline = (): void => {
            this.deps.appState.setState({ isOnline: true });
            toast.success('Conexão restabelecida.', 'Online');
        };

        const handleOffline = (): void => {
            this.deps.appState.setState({ isOnline: false });
            toast.warning('Você está offline. As alterações continuam salvas localmente.', 'Sem conexão');
        };

        this.listen(window, 'online', handleOnline);
        this.listen(window, 'offline', handleOffline);

        // Eventos emitidos pelas views (desacopla views dos serviços globais).
        this.listen(this.element, 'admin:export', () => this.exportBackup());
        this.listen(this.element, 'admin:import', () => this.triggerImport());
        this.listen(this.element, 'sidebar:export', () => this.exportBackup());
        this.listen(this.element, 'sidebar:shortcuts', () => this.showShortcuts());

        // Garante que a última escrita não se perca ao fechar a aba.
        this.listen(window, 'beforeunload', () => {
            void this.deps.appState.flush();
        });

        this.keydownHandler = (event: KeyboardEvent) => this.handleShortcut(event);
        document.addEventListener('keydown', this.keydownHandler);

        // Erros de persistência viram aviso visível (ex: cota excedida).
        this.deps.appState.onPersistError((error) => {
            const appError = error instanceof AppError ? error : null;

            if (appError?.code === 'QUOTA_EXCEEDED') {
                toast.error(
                    'O navegador ficou sem espaço para salvar. Exporte um backup e remova imagens grandes ou itens antigos.',
                    'Armazenamento cheio',
                );
                return;
            }

            toast.error(appError?.message ?? 'Falha ao salvar os dados localmente.', 'Não foi possível salvar');
        });

        applyColorblindMode(localStorage.getItem('dsp5:colorblind') ?? '');
    }

    /** Atalhos de teclado globais. */
    private handleShortcut(event: KeyboardEvent): void {
        // Ignora atalhos simples enquanto o usuário digita.
        const target = event.target as HTMLElement | null;
        const isTyping = target?.matches('input, textarea, select, [contenteditable="true"]');

        if (event.key === 'Escape' && this.isMobileSidebarOpen()) {
            this.closeMobileSidebar();
            return;
        }

        if (isTyping) return;

        // `Alt` evita conflito com atalhos do navegador e leitores de tela.
        if (event.altKey && event.key.toLowerCase() === 'n') {
            event.preventDefault();
            this.deps.router.navigate('/admin/novo');
            return;
        }

        if (event.altKey && event.key.toLowerCase() === 'p') {
            event.preventDefault();
            this.deps.router.navigate('/produtos');
            return;
        }

        if (event.altKey && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            this.deps.router.navigate('/admin');
            return;
        }

        if (event.altKey && event.key.toLowerCase() === 'c') {
            event.preventDefault();
            this.deps.router.navigate('/config');
        }
    }

    /** Modal com a lista de atalhos. */
    private showShortcuts(): void {
        openModal({
            title: 'Atalhos de teclado',
            content: html`
                <div class="table-wrapper">
                    <table class="data-table" style="min-width: 0;">
                        <tbody>
                            <tr><td><kbd class="mono">Alt</kbd> + <kbd class="mono">N</kbd></td><td>Novo produto</td></tr>
                            <tr><td><kbd class="mono">Alt</kbd> + <kbd class="mono">P</kbd></td><td>Ir para a vitrine</td></tr>
                            <tr><td><kbd class="mono">Alt</kbd> + <kbd class="mono">A</kbd></td><td>Gerenciar produtos</td></tr>
                            <tr><td><kbd class="mono">Alt</kbd> + <kbd class="mono">C</kbd></td><td>Configurações</td></tr>
                            <tr><td><kbd class="mono">Esc</kbd></td><td>Fechar diálogos e menus</td></tr>
                            <tr><td><kbd class="mono">Tab</kbd> / <kbd class="mono">Shift+Tab</kbd></td><td>Navegar entre campos</td></tr>
                        </tbody>
                    </table>
                </div>
            `,
            confirmLabel: 'Entendi',
        });
    }

    /* ------------------------------------------------------------- testes -- */

    /** Recebe o resumo da suíte e atualiza o indicador. */
    setTestSummary(summary: TestSummary): void {
        this.header.setTestSummary(summary);
        if (this.currentView instanceof SettingsView) this.currentView.setTestSummary(summary);
    }

    /** Abre o painel de resultados dos testes. */
    private showTestResults(): void {
        const summary = this.lastSummary;

        if (!summary) {
            toast.info('A suíte de testes ainda está executando. Aguarde alguns instantes.');
            return;
        }

        const grouped = new Map<string, typeof summary.results[number][]>();
        summary.results.forEach((result) => {
            const list = grouped.get(result.suite) ?? [];
            list.push(result);
            grouped.set(result.suite, list);
        });

        openModal({
            title: `Testes: ${summary.passed}/${summary.total} passaram`,
            content: html`
                <div class="test-results">
                    ${[...grouped.entries()].map(([suite, cases]) => {
                        const failures = cases.filter((testCase) => !testCase.passed).length;
                        return html`
                            <div class="test-suite">
                                <div class="test-suite__header">
                                    ${suite}
                                    <span class="badge ${failures === 0 ? 'badge--success' : 'badge--danger'}" style="margin-left:0.5rem;">
                                        ${cases.length - failures}/${cases.length}
                                    </span>
                                </div>
                                ${cases.map(
                                    (testCase) => html`
                                        <div class="test-case">
                                            <span aria-hidden="true">${testCase.passed ? '✅' : '❌'}</span>
                                            <div>
                                                <div>${testCase.name}</div>
                                                ${testCase.error ? html`<div class="test-case__error">${testCase.error}</div>` : ''}
                                            </div>
                                        </div>
                                    `,
                                )}
                            </div>
                        `;
                    })}
                </div>
            `,
            confirmLabel: 'Fechar',
        });
    }

    /** Guarda o último resumo para o modal de resultados. */
    private lastSummary: TestSummary | null = null;

    /** Atualiza o resumo interno e a UI. */
    updateTestSummary(summary: TestSummary): void {
        this.lastSummary = summary;
        this.setTestSummary(summary);
    }

    /* -------------------------------------------------------------- sync --- */

    /**
     * Sincroniza a fila de operações pendentes com a API.
     *
     * Sem `apiBaseUrl` configurada, o comportamento é *graceful*: consolida os
     * dados localmente e informa o usuário, mantendo a aplicação utilizável
     * offline (a v4 oferecia o botão mas não fazia nada nem avisava).
     */
    private async sync(): Promise<void> {
        const state = this.deps.appState.getState();

        if (!state.isOnline) {
            toast.warning('Sem conexão. As alterações permanecem salvas localmente.', 'Offline');
            return;
        }

        this.header.setSyncing(true);

        try {
            if (!this.deps.apiBaseUrl) {
                // Modo local: apenas marca a fila como consolidada.
                await new Promise((resolve) => window.setTimeout(resolve, 400));
                this.deps.appState.setState({ pendingOps: [], lastSyncAt: Date.now() });

                toast.success(
                    state.pendingOps.length > 0
                        ? `${state.pendingOps.length} operação(ões) consolidadas localmente.`
                        : 'Nada pendente — dados já estão atualizados.',
                    'Sincronização local',
                );
                return;
            }

            // Modo API: envia o snapshot e absorve a resposta.
            const response = await this.deps.http.post<{ products?: unknown[] }>('/sync', {
                products: state.products,
                lastSyncAt: state.lastSyncAt,
            });

            this.deps.appState.setState({ pendingOps: [], lastSyncAt: Date.now() });

            if (Array.isArray(response.data?.products)) {
                this.deps.repository.replaceAll(parseBackup(response.data.products).products);
            }

            toast.success('Dados sincronizados com o servidor.', 'Sincronizado');
        } catch (error) {
            const message = error instanceof AppError ? error.message : 'Falha desconhecida na sincronização.';
            toast.error(`${message} Os dados continuam salvos localmente.`, 'Não foi possível sincronizar');
        } finally {
            this.header.setSyncing(false);
        }
    }

    /* ------------------------------------------------------------ backup --- */

    /** Exporta o backup completo. */
    private exportBackup(): void {
        const backup = createBackup(this.deps.appState.getState());
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

        downloadJson(`digital-store-backup-${stamp}.json`, backup);
        toast.success(`${backup.state.products.length} produto(s) exportado(s).`, 'Backup gerado');
    }

    /** Abre o seletor de arquivo para importação. */
    private triggerImport(): void {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.style.display = 'none';

        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (file) void this.importFile(file);
            input.remove();
        });

        document.body.appendChild(input);
        input.click();
    }

    /**
     * Importa um backup validado, com escolha entre substituir e mesclar.
     * @param file Arquivo JSON selecionado.
     */
    private async importFile(file: File): Promise<void> {
        try {
            const text = await readFileAsText(file);
            const parsed: unknown = JSON.parse(text);
            const backup = parseBackup(parsed);

            if (backup.products.length === 0) {
                toast.warning('O arquivo não contém produtos.', 'Backup vazio');
                return;
            }

            const existing = this.deps.repository.getAll().length;
            const replace = await this.confirmImportMode(backup.products.length, existing);

            const products = replace ? backup.products : this.mergeProducts(backup.products);
            this.deps.repository.replaceAll(products);

            if (backup.settings) {
                this.deps.appState.setState({ settings: backup.settings });
            }
            if (backup.formSchema) {
                this.deps.appState.setState({ formSchema: backup.formSchema });
            }

            toast.success(
                `${backup.products.length} produto(s) importado(s)${replace ? '' : ' (mesclados)'}.` +
                    (backup.exportedAt ? ` Backup de ${new Date(backup.exportedAt).toLocaleString('pt-BR')}.` : ''),
                'Importação concluída',
            );

            this.currentView?.update();
        } catch (error) {
            if (error instanceof SyntaxError) {
                toast.error('O arquivo não é um JSON válido.', 'Arquivo inválido');
                return;
            }

            const message = error instanceof AppError ? error.message : 'Não foi possível importar o backup.';
            toast.error(message, 'Falha na importação');
        }
    }

    /** Pergunta se o usuário quer substituir ou mesclar. */
    private async confirmImportMode(incoming: number, existing: number): Promise<boolean> {
        if (existing === 0) return true;

        return confirmDialog({
            title: 'Importar backup',
            message:
                `O arquivo contém ${incoming} produto(s) e você já tem ${existing} cadastrado(s). ` +
                'Confirmar substitui tudo; cancelar mescla os itens do arquivo com os atuais (mantendo os seus).',
            confirmLabel: 'Substituir',
            cancelLabel: 'Mesclar',
        });
    }

    /** Mescla produtos importados, renomeando ids em conflito. */
    private mergeProducts(incoming: AppStateData['products']): AppStateData['products'] {
        const existing = this.deps.repository.getAll();
        const existingIds = new Set(existing.map((product) => String(product.id).toLowerCase()));

        const merged = [...existing];

        incoming.forEach((product) => {
            if (existingIds.has(String(product.id).toLowerCase())) {
                // Id duplicado: gera um novo para não sobrescrever dados do usuário.
                merged.push({ ...product, id: `imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` });
            } else {
                merged.push(product);
            }
        });

        return merged;
    }

    /* ------------------------------------------------------------ mobile --- */

    private toggleMobileSidebar(): void {
        const isOpen = this.element.getAttribute('data-mobile-open') === 'true';
        this.element.setAttribute('data-mobile-open', String(!isOpen));
    }

    private isMobileSidebarOpen(): boolean {
        return this.element.getAttribute('data-mobile-open') === 'true';
    }

    private closeMobileSidebar(): void {
        this.element.removeAttribute('data-mobile-open');
    }

    /** Libera recursos globais. */
    destroy(): void {
        this.unsubscribeRouter?.();
        this.unsubscribeState?.();
        this.linkObserver?.disconnect();
        if (this.keydownHandler) document.removeEventListener('keydown', this.keydownHandler);
        this.deps.router.stop();
        this.currentView?.unmount();
    }
}

/** Reexporta o tipo do envelope de backup para consumidores externos. */
export type { BackupEnvelope };
