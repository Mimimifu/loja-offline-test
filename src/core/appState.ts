/**
 * @file core/appState.ts
 * @description Estado global observável (fonte única da verdade).
 *
 * Responsabilidades:
 *  - manter o snapshot do estado;
 *  - persistir mudanças no `IStorage`;
 *  - notificar assinantes de forma resiliente (um assinante com erro não
 *    impede os demais de serem notificados).
 *
 * Correções relevantes em relação à v4:
 *  - persistência não-bloqueante e *coalescida*: várias chamadas de `setState`
 *    no mesmo tick geram uma única escrita;
 *  - erros de persistência são reportados sem reverter o estado em memória
 *    (a v4 desfazia a mudança, deixando a UI dessincronizada do que o usuário viu);
 *  - `isObject` inexistente na v4 (bug de runtime em `isEmpty`) foi removido.
 */

import { IStorage } from './storage';
import { AppStateData, Settings } from './types';
import { toAppError } from './errors';
import { deepFreeze } from './utils';

/** Callback de observação do estado. */
export type StateSubscriber<T> = (state: T, changedKeys: readonly string[]) => void;

/** Callback de erro de persistência. */
export type StateErrorHandler = (error: unknown) => void;

/** Chave usada para persistir o estado no storage. */
export const APP_STATE_KEY = 'app_state';

/** Estado inicial padrão. */
export function createInitialState(): AppStateData {
    return {
        products: [],
        settings: defaultSettings(),
        formSchema: defaultFormSchema(),
        lastSyncAt: null,
        pendingOps: [],
        isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    };
}

/** Preferências padrão. */
export function defaultSettings(): Settings {
    return {
        version: 1,
        theme: 'light',
        sidebarSide: 'left',
        sidebarCollapsed: false,
        accentColor: '#2563eb',
        gridDensity: 'comfortable',
    };
}

/**
 * Esquema de formulário padrão (fallback).
 * Mantido aqui — e não em `schema.ts` — para quebrar a dependência circular
 * entre `appState` e `schema`.
 */
function defaultFormSchema(): AppStateData['formSchema'] {
    return {
        version: 1,
        fields: [
            { id: 'title', label: 'Título', type: 'text', required: true, path: 'title', placeholder: 'Ex: Guia de Mixagem' },
            {
                id: 'category',
                label: 'Categoria',
                type: 'select',
                required: true,
                path: 'category',
                options: [
                    { value: 'pdf', label: 'PDF / E-book' },
                    { value: 'musica', label: 'Música / Áudio' },
                    { value: 'planilha', label: 'Planilha' },
                    { value: 'curso', label: 'Curso' },
                    { value: 'template', label: 'Template' },
                    { value: 'outro', label: 'Outro' },
                ],
            },
            { id: 'priceCents', label: 'Preço (R$)', type: 'number', required: true, path: 'priceCents', scale: 100, help: 'Use 0 para item gratuito.' },
            { id: 'description', label: 'Descrição', type: 'textarea', required: true, path: 'description' },
            { id: 'image', label: 'Imagem (URL ou Base64)', type: 'url', path: 'image' },
            { id: 'paymentLink', label: 'Link de pagamento / doação', type: 'url', path: 'paymentLink' },
            { id: 'paymentLabel', label: 'Texto do botão de pagamento', type: 'text', path: 'paymentLabel', placeholder: 'Comprar' },
            { id: 'downloadLink', label: 'Link de download', type: 'url', path: 'downloadLink' },
            { id: 'tags', label: 'Tags', type: 'tags', path: 'tags', help: 'Separe por vírgula.' },
            { id: 'published', label: 'Publicado na vitrine', type: 'checkbox', path: 'published' },
        ],
    };
}

/**
 * Gerenciador de estado observável.
 * @template T Forma do estado (por padrão `AppStateData`).
 */
export class AppState<T extends object = AppStateData> {
    private state: T;
    private readonly storage: IStorage;
    private readonly storageKey: string;
    private readonly subscribers = new Set<StateSubscriber<T>>();
    private readonly errorHandlers = new Set<StateErrorHandler>();
    private persistScheduled = false;
    private persistPromise: Promise<void> | null = null;

    /**
     * @param storage Adaptador de persistência.
     * @param initialState Estado padrão usado quando não há nada salvo.
     * @param storageKey Chave de persistência.
     */
    constructor(storage: IStorage, initialState: T, storageKey: string = APP_STATE_KEY) {
        this.storage = storage;
        this.state = deepFreeze(initialState);
        this.storageKey = storageKey;
    }

    /**
     * Restaura o estado persistido, fazendo merge sobre o estado inicial para
     * que campos novos de versões futuras não quebrem a aplicação.
     */
    async init(): Promise<void> {
        const saved = await this.storage.get<Partial<T>>(this.storageKey).catch(() => null);

        if (saved && typeof saved === 'object') {
            const merged = { ...this.state, ...saved } as T;

            // `settings` precisa de merge profundo: um objeto antigo salvo sem
            // novos campos deixaria `undefined` na UI.
            if ('settings' in (this.state as Record<string, unknown>) && 'settings' in (saved as Record<string, unknown>)) {
                (merged as Record<string, unknown>).settings = {
                    ...(this.state as unknown as AppStateData).settings,
                    ...(saved as { settings?: Partial<Settings> }).settings,
                };
            }
            this.state = deepFreeze(merged);
        }
    }

    /**
     * Snapshot do estado.
     *
     * O objeto retornado é congelado em profundidade, então tentativas de mutar
     * arrays/objetos aninhados (`state.products.push(...)`) lançam em strict mode
     * em vez de corromper silenciosamente o estado interno. Toda mudança deve
     * passar por `setState`.
     */
    getState(): T {
        return this.state;
    }

    /** Valor atual de uma chave. */
    select<K extends keyof T>(key: K): T[K] {
        return this.state[key];
    }

    /**
     * Aplica um patch parcial e notifica os assinantes.
     * A persistência é agendada no mesmo tick e pode ser aguardada com `flush()`.
     * @param patch Campos a mesclar ao estado atual.
     */
    setState(patch: Partial<T>): void {
        const changedKeys = Object.keys(patch);
        if (changedKeys.length === 0) return;

        this.state = deepFreeze({ ...this.state, ...patch });
        this.notify(changedKeys);
        this.schedulePersist();
    }

    /**
     * Substitui o estado por completo.
     * @param next Estado completo.
     */
    replaceState(next: T): void {
        this.state = deepFreeze(next);
        this.notify(Object.keys(next));
        this.schedulePersist();
    }

    /** Registra um observador. @returns Função de cancelamento. */
    subscribe(subscriber: StateSubscriber<T>): () => void {
        this.subscribers.add(subscriber);
        return () => {
            this.subscribers.delete(subscriber);
        };
    }

    /** Registra um handler para falhas de persistência. @returns Função de cancelamento. */
    onPersistError(handler: StateErrorHandler): () => void {
        this.errorHandlers.add(handler);
        return () => {
            this.errorHandlers.delete(handler);
        };
    }

    /** Aguarda a persistência pendente (útil antes de fechar a página ou em testes). */
    async flush(): Promise<void> {
        if (this.persistPromise) await this.persistPromise;
    }

    /** Agenda uma escrita coalescida no próximo microtask. */
    private schedulePersist(): void {
        if (this.persistScheduled) return;
        this.persistScheduled = true;

        this.persistPromise = Promise.resolve()
            .then(() => {
                this.persistScheduled = false;
                return this.storage.set(this.storageKey, this.state);
            })
            .catch((error: unknown) => {
                // Não revertemos o estado: o usuário já viu a mudança na tela.
                // Reportamos para que a UI possa exibir um aviso de "não salvo".
                const appError = toAppError(error);
                this.errorHandlers.forEach((handler) => handler(appError));
                console.error('[AppState] Falha ao persistir estado:', appError.message);
            })
            .finally(() => {
                this.persistPromise = null;
            });
    }

    /** Notifica os assinantes, isolando falhas individuais. */
    private notify(changedKeys: readonly string[]): void {
        const snapshot = this.getState();
        this.subscribers.forEach((subscriber) => {
            try {
                subscriber(snapshot, changedKeys);
            } catch (error) {
                console.error('[AppState] Erro em assinante:', toAppError(error).message);
            }
        });
    }
}
