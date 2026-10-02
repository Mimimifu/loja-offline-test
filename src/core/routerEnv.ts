/**
 * @file core/routerEnv.ts
 * @description Abstração do ambiente de navegação usado pelo `Router`.
 *
 * Motivo: o roteador precisa de `location`, `history` e dos eventos
 * `popstate`/`hashchange`. Acessar `window` diretamente torna os testes
 * impossíveis de isolar — na prática, testar o roteador mudava a URL da página
 * real, disparava `hashchange` da aplicação em execução e **quebrava a app**.
 *
 * Com esta indireção:
 *  - produção usa `createBrowserEnv()` (fino invólucro sobre `window`);
 *  - testes usam `createFakeEnv()` (estado em memória, zero efeitos globais).
 */

/** Contrato mínimo de navegação exigido pelo roteador. */
export interface RouterEnv {
    /** Protocolo da página (ex: `https:`, `file:`). */
    protocol: string;
    /** Pathname atual. */
    getPathname(): string;
    /** Query string atual (com `?`, ou vazio). */
    getSearch(): string;
    /** Fragmento atual (com `#`, ou vazio). */
    getHash(): string;
    /** Empilha uma entrada no histórico. */
    push(url: string): void;
    /** Substitui a entrada atual do histórico. */
    replace(url: string): void;
    /** Define o fragmento (`#/rota`) sem recarregar o documento. */
    setHash(hash: string): void;
    /** Registra listener de navegação (`popstate`/`hashchange`). */
    addListener(type: NavigationEventType, handler: () => void): void;
    /** Remove listener de navegação. */
    removeListener(type: NavigationEventType, handler: () => void): void;
    /** Href absoluto da localização atual (usado para comparar origens). */
    getHref(): string;
}

/** Eventos de navegação observados. */
export type NavigationEventType = 'popstate' | 'hashchange';

/**
 * Ambiente real do navegador.
 * @returns Implementação sobre `window.history` e `window.location`.
 */
export function createBrowserEnv(): RouterEnv {
    return {
        get protocol(): string {
            return window.location.protocol;
        },
        getPathname: () => window.location.pathname || '/',
        getSearch: () => window.location.search || '',
        getHash: () => window.location.hash || '',
        push: (url) => window.history.pushState({}, '', url),
        replace: (url) => window.history.replaceState({}, '', url),
        setHash: (hash) => {
            // Atribuir `location.hash` não recarrega o documento — essencial sob
            // `file://`, onde `replaceState` lança `SecurityError`.
            window.location.hash = hash;
        },
        addListener: (type, handler) => window.addEventListener(type, handler),
        removeListener: (type, handler) => window.removeEventListener(type, handler),
        getHref: () => window.location.href,
    };
}

/** Estado de navegação em memória, para testes. */
export interface FakeEnv extends RouterEnv {
    /** URL completa simulada (ex: `https://localhost/`). */
    setUrl(url: string): void;
    /** Fragmento atual simulado. */
    currentHash(): string;
    /** Pathname atual simulado. */
    currentPathname(): string;
    /** Quantas entradas foram empilhadas no histórico. */
    pushCount(): number;
    /** Dispara manualmente um evento de navegação. */
    emit(type: NavigationEventType): void;
}

/**
 * Ambiente em memória — nenhum efeito sobre a página real.
 *
 * Modela `location.hash` com a semântica do navegador: atribuir `#/x` substitui
 * o fragmento sem recarregar e **dispara `hashchange`** (o roteador filtra
 * emissões redundantes, então o comportamento é fiel).
 *
 * @param protocol Protocolo simulado (use `file:` para exercitar o modo hash).
 * @param pathname Caminho inicial.
 * @returns Ambiente falso com utilitários de inspeção.
 */
export function createFakeEnv(protocol = 'https:', pathname = '/', search = ''): FakeEnv {
    let currentPathname = pathname;
    let currentSearch = search;
    let currentHash = '';
    let pushes = 0;

    const listeners: Record<NavigationEventType, Set<() => void>> = {
        popstate: new Set(),
        hashchange: new Set(),
    };

    return {
        protocol,
        getPathname: () => currentPathname,
        getSearch: () => currentSearch,
        getHash: () => currentHash,
        push: (url) => {
            pushes += 1;
            const index = url.indexOf('#');
            if (index >= 0) {
                currentHash = url.slice(index);
            } else {
                const [path, query = ''] = url.split('?');
                currentPathname = path;
                currentSearch = query ? `?${query}` : '';
            }
        },
        replace: (url) => {
            const index = url.indexOf('#');
            if (index >= 0) {
                currentHash = url.slice(index);
            } else {
                const [path, query = ''] = url.split('?');
                currentPathname = path;
                currentSearch = query ? `?${query}` : '';
            }
        },
        setHash: (hash) => {
            currentHash = hash;
            listeners.hashchange.forEach((handler) => handler());
        },
        addListener: (type, handler) => {
            listeners[type].add(handler);
        },
        removeListener: (type, handler) => {
            listeners[type].delete(handler);
        },
        getHref: () => `${protocol === 'file:' ? 'file://' : 'https://local'}${currentPathname}${currentSearch}${currentHash}`,

        setUrl: (url) => {
            const hashIndex = url.indexOf('#');
            const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
            currentHash = hashIndex >= 0 ? url.slice(hashIndex) : '';

            const pathStart = withoutHash.indexOf('/', withoutHash.indexOf('://') + 3);
            const rest = pathStart >= 0 ? withoutHash.slice(pathStart) : '/';
            const [path, query = ''] = rest.split('?');

            currentPathname = path || '/';
            currentSearch = query ? `?${query}` : '';
        },
        currentHash: () => currentHash,
        currentPathname: () => currentPathname,
        pushCount: () => pushes,
        emit: (type) => listeners[type].forEach((handler) => handler()),
    };
}
