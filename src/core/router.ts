/**
 * @file core/router.ts
 * @description Roteador SPA com **dois modos** de operação.
 *
 * ## Modos
 *
 * | Ambiente | Modo | Motivo |
 * |---|---|---|
 * | `http(s)://` | `history` | URLs limpas (`/produto/42`) via History API |
 * | `file://` | `hash` | `history.pushState` lança `SecurityError` com origem `null` |
 *
 * A aplicação é distribuída como arquivo único para ser aberta direto do disco.
 * Nesse cenário `location.pathname` é o caminho do arquivo
 * (`/home/user/dist/index.html`), não uma rota, e a History API é inutilizável —
 * sem o modo hash, nenhuma rota resolveria e a página ficaria em branco.
 *
 * A detecção é automática; nenhuma configuração é necessária.
 *
 * O acesso a `location`/`history` passa por `RouterEnv` (ver `routerEnv.ts`).
 * Isso torna o roteador testável sem tocar na URL real: testar contra `window`
 * mudava a URL da página, disparava `hashchange` da aplicação em execução e
 * **quebrava a app durante a própria suíte de testes**.
 *
 * ## Outras garantias
 *
 * - rotas com parâmetros (`/produto/:id`), com decodificação tolerante;
 * - query string exposta em `context.query`;
 * - `dispatch()` notifica listeners **e** executa o handler, tanto em navegação
 *   programática quanto no botão voltar;
 * - falhas de `pushState` degradam para o modo hash em vez de quebrar a app.
 */

import { NavigationEventType, RouterEnv, createBrowserEnv } from './routerEnv';

/** Parâmetros extraídos da rota. */
export type RouteParams = Record<string, string>;

/** Contexto entregue ao handler de uma rota. */
export interface RouteContext {
    path: string;
    params: RouteParams;
    query: URLSearchParams;
    /** Rota registrada que casou (ex: `/produto/:id`). */
    pattern: string;
}

/** Handler executado quando uma rota casa. */
export type RouteHandler = (context: RouteContext) => void | Promise<void>;

/** Modo de roteamento em uso. */
export type RouterMode = 'history' | 'hash';

/** Contrato do roteador. */
export interface IRouter {
    addRoute(pattern: string, handler: RouteHandler): void;
    navigate(path: string, options?: { replace?: boolean }): void;
    subscribe(listener: (context: RouteContext) => void): () => void;
    start(): void;
    stop(): void;
    getCurrentPath(): string;
    getCurrentContext(): RouteContext;
}

/** Opções de construção do roteador. */
export interface RouterOptions {
    /** Força um modo específico (testes). */
    mode?: RouterMode;
    /** Ambiente de navegação injetado (testes). */
    env?: RouterEnv;
}

interface RegisteredRoute {
    pattern: string;
    /** Segmentos pré-compilados (estáticos ou `:variavel`). */
    segments: string[];
    handler: RouteHandler;
}

/**
 * Roteador com resolução de padrões estilo `/produto/:id`.
 */
export class Router implements IRouter {
    private readonly routes: RegisteredRoute[] = [];
    private readonly listeners = new Set<(context: RouteContext) => void>();
    private readonly env: RouterEnv;
    private readonly basePath: string;
    private readonly navigationHandler: () => void;

    private currentContext: RouteContext;
    private started = false;
    private mode: RouterMode;

    /**
     * @param basePath Prefixo removido antes do matching (SPA em subdiretório).
     *   Ignorado em modo hash.
     * @param options Modo forçado e/ou ambiente injetado.
     */
    constructor(basePath = '', options: RouterOptions = {}) {
        this.basePath = basePath.replace(/\/$/, '');
        this.env = options.env ?? createBrowserEnv();
        this.mode = options.mode ?? detectMode(this.env);
        this.currentContext = this.buildContext(this.readLocationPath());

        this.navigationHandler = () => {
            this.currentContext = this.buildContext(this.readLocationPath());
            void this.dispatch(this.currentContext);
        };
    }

    /** Modo em uso (útil para diagnóstico e para reescrever links). */
    get modeName(): RouterMode {
        return this.mode;
    }

    /** Caminho atual (sem query string). */
    getCurrentPath(): string {
        return this.currentContext.path;
    }

    /** Contexto atual completo. */
    getCurrentContext(): RouteContext {
        return this.currentContext;
    }

    /**
     * Registra uma rota.
     * @param pattern Padrão, ex: `/`, `/produtos`, `/produto/:id`.
     * @throws {Error} Se o padrão já estiver registrado.
     */
    addRoute(pattern: string, handler: RouteHandler): void {
        const normalized = this.normalizePattern(pattern);

        if (this.routes.some((route) => route.pattern === normalized)) {
            throw new Error(`Rota duplicada: "${normalized}".`);
        }

        this.routes.push({
            pattern: normalized,
            segments: this.splitSegments(normalized),
            handler,
        });
    }

    /**
     * Navega programaticamente.
     * @param path Destino (pode incluir query string).
     * @param options `replace: true` substitui a entrada do histórico.
     */
    navigate(path: string, options: { replace?: boolean } = {}): void {
        if (this.mode === 'hash') {
            this.navigateHash(path, options);
            return;
        }

        try {
            this.navigateHistory(path, options);
        } catch (error) {
            // Ambiente restritivo (ex: `file://`, iframe sandboxed): alterna para
            // hash e repete. Uma restrição de segurança não deve inutilizar a UI.
            console.warn('[Router] History API indisponível, alternando para modo hash.', error);
            this.mode = 'hash';
            this.navigateHash(path, options);
        }
    }

    /** Observa mudanças de rota. @returns Função de cancelamento. */
    subscribe(listener: (context: RouteContext) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Liga o roteador e resolve a rota atual. Idempotente. */
    start(): void {
        if (this.started) return;
        this.started = true;

        // Ouvimos ambos os eventos: o modo pode mudar para hash durante a
        // execução (após `SecurityError`), e o roteador precisa reagir.
        (['popstate', 'hashchange'] as NavigationEventType[]).forEach((type) => {
            this.env.addListener(type, this.navigationHandler);
        });

        // Delegação de cliques: intercepta links internos para navegar sem reload.
        document.addEventListener('click', this.interceptLinkClick);

        void this.dispatch(this.currentContext);
    }

    /** Desliga o roteador e libera listeners globais. */
    stop(): void {
        if (!this.started) return;
        this.started = false;

        (['popstate', 'hashchange'] as NavigationEventType[]).forEach((type) => {
            this.env.removeListener(type, this.navigationHandler);
        });
        document.removeEventListener('click', this.interceptLinkClick);
        this.listeners.clear();
    }

    /**
     * Converte um path interno em `href` utilizável no modo atual.
     *
     * Views escrevem sempre `href="/produtos"`; o App reescreve para `#/produtos`
     * em modo hash, mantendo o código das views agnóstico ao ambiente.
     *
     * @param path Path interno.
     */
    hrefFor(path: string): string {
        return this.mode === 'hash' ? `#${path.startsWith('/') ? path : `/${path}`}` : path;
    }

    /* --------------------------------------------------------- navegação --- */

    /** Navegação via History API. */
    private navigateHistory(path: string, options: { replace?: boolean }): void {
        const target = this.withBase(path);
        const currentUrl = `${this.env.getPathname()}${this.env.getSearch()}`;

        // Mesmo destino: re-executa a rota sem empilhar entrada no histórico.
        if (!options.replace && currentUrl === target) {
            this.currentContext = this.buildContext(this.readLocationPath());
            void this.dispatch(this.currentContext);
            return;
        }

        if (options.replace) {
            this.env.replace(target);
        } else {
            this.env.push(target);
        }

        this.currentContext = this.buildContext(this.readLocationPath());
        void this.dispatch(this.currentContext);
    }

    /** Navegação via fragmento (`#/rota`). */
    private navigateHash(path: string, options: { replace?: boolean }): void {
        const target = `#${path.startsWith('/') ? path : `/${path}`}`;

        // Mesmo fragmento: re-executa sem reatribuir `location.hash` (evita
        // entrada extra no histórico e `hashchange` redundante).
        if (this.env.getHash() === target) {
            this.currentContext = this.buildContext(this.readLocationPath());
            void this.dispatch(this.currentContext);
            return;
        }

        if (options.replace) {
            // `history.replaceState` não funciona em `file://`; trocar apenas o
            // fragmento não recarrega o documento.
            const base = `${this.env.getPathname()}${this.env.getSearch()}`;
            this.env.replace(`${base}${target}`);
        }

        this.env.setHash(target);

        this.currentContext = this.buildContext(this.readLocationPath());
        void this.dispatch(this.currentContext);
    }

    /** Intercepta cliques em `<a href>` internos (delegação de eventos). */
    private readonly interceptLinkClick = (event: MouseEvent): void => {
        // Respeita modificadores e botões não primários (abrir em nova aba etc).
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        if (anchor.target && anchor.target !== '_self') return;
        if (anchor.hasAttribute('download')) return;

        const href = anchor.getAttribute('href') ?? '';
        if (!href) return;

        // Âncoras (`#/rota`) — modo hash, ou links já reescritos pelo App.
        if (href.startsWith('#')) {
            const path = href.slice(1) || '/';
            // Âncoras internas da mesma página (ex: `#main-content`) ficam com
            // o navegador; apenas rotas (`#/…`) são tratadas pelo roteador.
            if (!path.startsWith('/')) return;
            if (path === this.getCurrentPath()) return;

            event.preventDefault();
            this.navigate(path);
            return;
        }

        if (!href.startsWith('/')) return;

        // Links externos mantêm o comportamento nativo.
        try {
            const base = this.env.getHref();
            const url = new URL(anchor.href, base);
            if (url.origin !== new URL(base).origin) return;

            event.preventDefault();
            this.navigate(`${url.pathname}${url.search}`);
        } catch {
            // `href` não absolutizável: deixa o navegador resolver.
        }
    };

    /* ------------------------------------------------------------ leitura -- */

    /**
     * Lê o path atual conforme o modo, preservando a query string.
     *
     * Em modo hash, `#/produto/1?x=2` vira `/produto/1?x=2`. Em modo history, o
     * `basePath` é removido. Sob `file://` o pathname é o caminho do arquivo,
     * então o fragmento é a única fonte confiável de rota.
     */
    private readLocationPath(): string {
        if (this.mode === 'hash' || this.env.protocol === 'file:') {
            const rawHash = (this.env.getHash() || '').replace(/^#/, '');
            return rawHash || '/';
        }

        const raw = this.env.getPathname() || '/';
        const search = this.env.getSearch() || '';

        if (this.basePath && raw.startsWith(this.basePath)) {
            return `${raw.slice(this.basePath.length) || '/'}${search}`;
        }
        return `${raw}${search}`;
    }

    /** Adiciona o basePath a um destino (apenas em modo history). */
    private withBase(path: string): string {
        const normalized = path.startsWith('/') ? path : `/${path}`;
        if (!this.basePath) return normalized;
        return `${this.basePath}${normalized}`;
    }

    /** Monta o contexto (path, params, query, pattern) para um path bruto. */
    private buildContext(rawPath: string): RouteContext {
        const [pathname, search = ''] = rawPath.split('?');
        const path = this.normalizePath(pathname);

        return {
            path,
            params: this.matchParams(path),
            query: new URLSearchParams(search),
            pattern: this.matchPattern(path),
        };
    }

    /** Encontra a rota que casa e extrai os parâmetros. */
    private resolve(path: string): { route: RegisteredRoute; params: RouteParams } | null {
        const targetSegments = this.splitSegments(path);

        for (const route of this.routes) {
            if (route.segments.length !== targetSegments.length) continue;

            const params: RouteParams = {};
            const matched = route.segments.every((segment, index) => {
                const value = targetSegments[index];
                if (segment.startsWith(':')) {
                    params[segment.slice(1)] = decodeParam(value);
                    return true;
                }
                return segment === value;
            });

            if (matched) return { route, params };
        }
        return null;
    }

    private matchParams(path: string): RouteParams {
        return this.resolve(path)?.params ?? {};
    }

    private matchPattern(path: string): string {
        return this.resolve(path)?.route.pattern ?? '';
    }

    /** Notifica listeners e executa o handler da rota resolvida. */
    private async dispatch(context: RouteContext): Promise<void> {
        this.listeners.forEach((listener) => {
            try {
                listener(context);
            } catch (error) {
                console.error('[Router] Erro em listener de rota:', error);
            }
        });

        const resolved = this.resolve(context.path);
        if (!resolved) {
            if (context.path !== '/') {
                console.warn(`[Router] Nenhuma rota registrada para "${context.path}".`);
            }
            return;
        }

        const matchedPattern = resolved.route.pattern;

        try {
            await resolved.route.handler({ ...context, params: resolved.params, pattern: matchedPattern });
        } catch (error) {
            console.error(`[Router] Erro no handler da rota "${matchedPattern}":`, error);
        }
    }

    /* ---------------------------------------------------------- utilidades - */

    private normalizePattern(pattern: string): string {
        const normalized = this.normalizePath(pattern);
        return normalized === '' ? '/' : normalized;
    }

    private normalizePath(path: string): string {
        const withSlash = path.startsWith('/') ? path : `/${path}`;
        if (withSlash === '/') return '/';

        return withSlash.replace(/\/+$/, '') || '/';
    }

    private splitSegments(path: string[] | string): string[] {
        return String(path).split('/').filter(Boolean);
    }
}

/**
 * Detecta o modo de roteamento apropriado ao ambiente.
 *
 * `file://` exige modo hash: a origem é `null`, `history.pushState` lança
 * `SecurityError` e o pathname é o caminho do arquivo no disco.
 *
 * @param env Ambiente de navegação (usa o do navegador por padrão).
 * @returns `'hash'` sob `file://` ou com a History API bloqueada.
 */
export function detectMode(env: RouterEnv = createBrowserEnv()): RouterMode {
    if (typeof window === 'undefined') return 'history';
    if (env.protocol === 'file:') return 'hash';

    // Alguns navegadores bloqueiam a History API (iframe sandboxed, por exemplo).
    try {
        env.replace(env.getHref());
        return 'history';
    } catch {
        return 'hash';
    }
}

/**
 * Decodifica um parâmetro de rota de forma tolerante.
 *
 * `decodeURIComponent` lança `URIError` com entrada malformada (ex: `%E0%A4%A`),
 * o que quebraria a renderização inteira.
 *
 * @param value Valor bruto do segmento.
 */
function decodeParam(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
