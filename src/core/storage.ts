/**
 * @file core/storage.ts
 * @description Camada de persistência offline-first.
 *
 * Estratégia: **IndexedDB primeiro, LocalStorage como fallback transparente**.
 * A escrita é *write-through* — grava em todos os drivers disponíveis — para que
 * uma falha de IndexedDB não deixe a aplicação sem os dados.
 *
 * Correções relevantes em relação à v4:
 *  - `init()` é aguardado de forma determinística (a v4 abria o banco no
 *    construtor sem `await`, e a primeira leitura podia perder a corrida e cair
 *    no LocalStorage, retornando `null`);
 *  - erros de cota são propagados como `QuotaExceededError` em vez de mascarados
 *    pelo fallback;
 *  - `openIndexedDB` rejeita por timeout, evitando promessas penduradas em
 *    navegadores com IDB bloqueado (modo privado do Safari, por exemplo).
 */

import { AppError, NotFoundError, QuotaExceededError, toAppError } from './errors';

/** Contrato de um driver de armazenamento. */
export interface IStorageDriver {
    readonly name: string;
    isAvailable(): Promise<boolean>;
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    clear(): Promise<void>;
    keys(): Promise<string[]>;
}

/** Interface pública consumida pela aplicação. */
export interface IStorage {
    init(): Promise<void>;
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
    clear(): Promise<void>;
    keys(): Promise<string[]>;
    /** Nome do driver efetivamente ativo (para diagnóstico na UI). */
    readonly activeDriver: string;
    /** Executa uma atualização atômica (read-modify-write) sobre uma chave. */
    update<T>(key: string, updater: (current: T | null) => T): Promise<T>;
}

/** Configuração do adaptador. */
export interface StorageConfig {
    dbName: string;
    storeName: string;
    version?: number;
}

/** Tempo máximo para abrir o IndexedDB antes de considerar o driver indisponível. */
const IDB_OPEN_TIMEOUT_MS = 3000;

/** Driver IndexedDB. */
export class IndexedDbDriver implements IStorageDriver {
    public readonly name = 'IndexedDB';
    private readonly dbName: string;
    private readonly storeName: string;
    private readonly version: number;
    private db: IDBDatabase | null = null;

    constructor(config: StorageConfig) {
        this.dbName = config.dbName;
        this.storeName = config.storeName;
        this.version = config.version ?? 1;
    }

    async isAvailable(): Promise<boolean> {
        if (typeof indexedDB === 'undefined') return false;
        try {
            this.db = await this.open();
            return true;
        } catch {
            this.db = null;
            return false;
        }
    }

    private open(): Promise<IDBDatabase> {
        return new Promise<IDBDatabase>((resolve, reject) => {
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new AppError('STORAGE_UNAVAILABLE', 'Timeout ao abrir o IndexedDB.'));
            }, IDB_OPEN_TIMEOUT_MS);

            const finish = (fn: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn();
            };

            let request: IDBOpenDBRequest;
            try {
                request = indexedDB.open(this.dbName, this.version);
            } catch (error) {
                finish(() => reject(toAppError(error)));
                return;
            }

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };

            request.onsuccess = () => finish(() => resolve(request.result));
            request.onerror = () => finish(() => reject(toAppError(request.error)));
            request.onblocked = () =>
                finish(() => reject(new AppError('STORAGE_UNAVAILABLE', 'IndexedDB bloqueado por outra aba.')));
        });
    }

    private requireDb(): IDBDatabase {
        if (!this.db) throw new AppError('STORAGE_UNAVAILABLE', 'IndexedDB não inicializado.');
        return this.db;
    }

    private run<T>(
        mode: IDBTransactionMode,
        operation: (store: IDBObjectStore) => IDBRequest<T>,
    ): Promise<T> {
        const db = this.requireDb();

        return new Promise<T>((resolve, reject) => {
            const transaction = db.transaction([this.storeName], mode);
            const store = transaction.objectStore(this.storeName);

            transaction.onabort = () => reject(toAppError(transaction.error));
            transaction.onerror = () => reject(toAppError(transaction.error));

            let request: IDBRequest<T>;
            try {
                request = operation(store);
            } catch (error) {
                reject(toAppError(error));
                return;
            }

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(toAppError(request.error));
        });
    }

    async get<T>(key: string): Promise<T | null> {
        const result = await this.run<T | undefined>('readonly', (store) => store.get(key));
        return result ?? null;
    }

    async set<T>(key: string, value: T): Promise<void> {
        // `put` faz upsert: mantém a chave e substitui o valor.
        await this.run('readwrite', (store) => store.put(value, key));
    }

    async remove(key: string): Promise<void> {
        await this.run('readwrite', (store) => store.delete(key));
    }

    async clear(): Promise<void> {
        await this.run('readwrite', (store) => store.clear());
    }

    async keys(): Promise<string[]> {
        const keys = await this.run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
        return keys.map(String);
    }
}

/** Driver LocalStorage (fallback e camada de redundância). */
export class LocalStorageDriver implements IStorageDriver {
    public readonly name = 'LocalStorage';
    private readonly prefix: string;

    constructor(prefix = 'dsp5:') {
        this.prefix = prefix;
    }

    async isAvailable(): Promise<boolean> {
        try {
            if (typeof localStorage === 'undefined') return false;
            const probe = `${this.prefix}__probe__`;
            localStorage.setItem(probe, '1');
            localStorage.removeItem(probe);
            return true;
        } catch {
            return false;
        }
    }

    private key(key: string): string {
        return `${this.prefix}${key}`;
    }

    async get<T>(key: string): Promise<T | null> {
        const raw = localStorage.getItem(this.key(key));
        if (raw === null) return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            // Dado corrompido: melhor descartar do que quebrar o boot.
            localStorage.removeItem(this.key(key));
            return null;
        }
    }

    async set<T>(key: string, value: T): Promise<void> {
        localStorage.setItem(this.key(key), JSON.stringify(value));
    }

    async remove(key: string): Promise<void> {
        localStorage.removeItem(this.key(key));
    }

    async clear(): Promise<void> {
        Object.keys(localStorage)
            .filter((k) => k.startsWith(this.prefix))
            .forEach((k) => localStorage.removeItem(k));
    }

    async keys(): Promise<string[]> {
        return Object.keys(localStorage)
            .filter((k) => k.startsWith(this.prefix))
            .map((k) => k.slice(this.prefix.length));
    }
}

/**
 * Adaptador que orquestra múltiplos drivers.
 *
 * Leitura: primeiro driver disponível (ordem de prioridade).
 * Escrita: todos os drivers disponíveis (write-through), reportando erro
 * apenas se **nenhum** conseguir persistir.
 */
export class StorageAdapter implements IStorage {
    private readonly drivers: IStorageDriver[];
    private readonly available: IStorageDriver[] = [];
    private initialized = false;

    constructor(config: StorageConfig, drivers?: IStorageDriver[]) {
        this.drivers = drivers ?? [new IndexedDbDriver(config), new LocalStorageDriver()];
    }

    get activeDriver(): string {
        return this.available[0]?.name ?? 'nenhum';
    }

    /** Nomes de todos os drivers ativos (usado no painel de diagnóstico). */
    get activeDrivers(): string[] {
        return this.available.map((driver) => driver.name);
    }

    async init(): Promise<void> {
        if (this.initialized) return;

        for (const driver of this.drivers) {
            // Uma falha de um driver não deve impedir os demais de subirem.
            // eslint-disable-next-line no-await-in-loop
            const ok = await driver.isAvailable().catch(() => false);
            if (ok) this.available.push(driver);
        }

        if (this.available.length === 0) {
            throw new AppError(
                'STORAGE_UNAVAILABLE',
                'Nenhum mecanismo de armazenamento disponível. Verifique se o navegador permite armazenamento local.',
            );
        }

        this.initialized = true;
    }

    private assertInitialized(): void {
        if (!this.initialized) {
            throw new AppError('STORAGE_UNAVAILABLE', 'StorageAdapter.init() deve ser aguardado antes do uso.');
        }
    }

    async get<T>(key: string): Promise<T | null> {
        this.assertInitialized();

        for (const driver of this.available) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const value = await driver.get<T>(key);
                if (value !== null && value !== undefined) return value;
            } catch {
                // Tenta o próximo driver.
            }
        }
        return null;
    }

    async set<T>(key: string, value: T): Promise<void> {
        this.assertInitialized();
        await this.writeThrough((driver) => driver.set(key, value));
    }

    async remove(key: string): Promise<void> {
        this.assertInitialized();
        await this.writeThrough((driver) => driver.remove(key));
    }

    async clear(): Promise<void> {
        this.assertInitialized();
        await this.writeThrough((driver) => driver.clear());
    }

    async keys(): Promise<string[]> {
        this.assertInitialized();
        const collected = new Set<string>();

        for (const driver of this.available) {
            try {
                // eslint-disable-next-line no-await-in-loop
                (await driver.keys()).forEach((key) => collected.add(key));
            } catch {
                // Ignora driver com falha na listagem.
            }
        }
        return [...collected].sort();
    }

    /**
     * Executa a operação em todos os drivers, tolerando falhas parciais.
     * Uma cota excedida tem precedência sobre erros genéricos no relatório,
     * pois exige ação do usuário (limpar dados).
     * @param operation Operação a aplicar.
     */
    private async writeThrough(operation: (driver: IStorageDriver) => Promise<void>): Promise<void> {
        const failures: unknown[] = [];

        await Promise.all(
            this.available.map(async (driver) => {
                try {
                    await operation(driver);
                } catch (error) {
                    failures.push(error);
                }
            }),
        );

        if (failures.length === 0) return;
        if (failures.length < this.available.length) return; // Ao menos um driver persistiu.

        const quotaFailure = failures.find((error) => toAppError(error).code === 'QUOTA_EXCEEDED');
        if (quotaFailure) {
            throw new QuotaExceededError(
                'Não foi possível salvar: o limite de armazenamento do navegador foi atingido. ' +
                    'Exporte um backup e remova itens antigos ou imagens grandes.',
            );
        }

        throw toAppError(failures[0]);
    }

    /**
     * Atualização atômica best-effort: lê, transforma e grava.
     * @param key Chave alvo.
     * @param updater Função que recebe o valor atual e devolve o novo.
     * @throws {NotFoundError} Se a chave não existir.
     */
    async update<T>(key: string, updater: (current: T | null) => T): Promise<T> {
        const current = await this.get<T>(key);
        if (current === null) {
            throw new NotFoundError(`Chave "${key}" não encontrada para atualização.`);
        }

        const next = updater(current);
        await this.set(key, next);
        return next;
    }
}
