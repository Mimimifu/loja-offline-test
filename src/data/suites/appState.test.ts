/**
 * @file tests/suites/appState.test.ts
 * @description Testes do estado global observável.
 *
 * Regressões cobertas (bugs da v4):
 *  - a v4 revertia o estado em memória quando a persistência falhava, deixando
 *    a UI mostrando algo diferente do estado real;
 *  - a v4 persistia a cada `setState` sem coalescer, multiplicando escritas.
 */

import { assert, testRunner } from '../testRunner';
import { AppState, APP_STATE_KEY, createInitialState } from '../../core/appState';
import { StorageAdapter, IStorageDriver } from '../../core/storage';
import { AppStateData } from '../../core/types';

/** Driver em memória com contadores de escrita para validar coalescência. */
class CountingDriver implements IStorageDriver {
    public readonly name = 'Counting';
    public writes = 0;
    public failNextWrite = false;
    private readonly map = new Map<string, string>();

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async get<T>(key: string): Promise<T | null> {
        const raw = this.map.get(key);
        return raw === undefined ? null : (JSON.parse(raw) as T);
    }

    async set<T>(key: string, value: T): Promise<void> {
        if (this.failNextWrite) {
            this.failNextWrite = false;
            throw new Error('escrita simulada falhou');
        }
        this.writes += 1;
        this.map.set(key, JSON.stringify(value));
    }

    async remove(key: string): Promise<void> {
        this.map.delete(key);
    }

    async clear(): Promise<void> {
        this.map.clear();
    }

    async keys(): Promise<string[]> {
        return [...this.map.keys()];
    }
}

/** Cria um adaptador de estado isolado para um teste. */
async function createHarness(): Promise<{ state: AppState<AppStateData>; driver: CountingDriver }> {
    const driver = new CountingDriver();
    const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [driver]);
    await storage.init();

    const state = new AppState<AppStateData>(storage, createInitialState());
    await state.init();

    return { state, driver };
}

/** Registra a suíte de estado. */
export function registerAppStateSuite(): void {
    testRunner.describe('🧠 [AppState] Estado observável', () => {
        testRunner.it('estado inicial contém todas as chaves esperadas', async () => {
            const { state } = await createHarness();
            const snapshot = state.getState();

            assert.ok(Array.isArray(snapshot.products), 'products deve ser array');
            assert.ok(Array.isArray(snapshot.pendingOps), 'pendingOps deve ser array');
            assert.ok(snapshot.formSchema.fields.length > 0, 'esquema padrão deve ter campos');
            assert.equal(snapshot.lastSyncAt, null, 'lastSyncAt inicia nulo');
        });

        testRunner.it('setState notifica assinantes com as chaves alteradas', async () => {
            const { state } = await createHarness();

            let receivedKeys: readonly string[] = [];
            let calls = 0;
            state.subscribe((_snapshot, changedKeys) => {
                calls += 1;
                receivedKeys = changedKeys;
            });

            state.setState({ lastSyncAt: 12345 });

            assert.equal(calls, 1, 'deve notificar uma vez');
            assert.deepEqual(receivedKeys, ['lastSyncAt'], 'deve informar a chave alterada');
            assert.equal(state.select('lastSyncAt'), 12345, 'valor deve estar aplicado');
        });

        testRunner.it('assinante com erro não impede os demais de serem notificados', async () => {
            const { state } = await createHarness();

            let secondCalled = false;
            state.subscribe(() => {
                throw new Error('assinante quebrado');
            });
            state.subscribe(() => {
                secondCalled = true;
            });

            state.setState({ lastSyncAt: 1 });
            assert.ok(secondCalled, 'o segundo assinante deve ter sido chamado mesmo assim');
        });

        testRunner.it('getState devolve estado congelado — mutação externa é rejeitada', async () => {
            const { state } = await createHarness();
            const snapshot = state.getState();

            // A v4 devolvia uma cópia rasa: `state.products.push(...)` mutava o
            // array interno, porque a cópia mantinha a mesma referência.
            // Agora o estado é congelado em profundidade e a mutação lança.
            await assert.throws(
                () => snapshot.products.push({ id: 'injetado' } as never),
                'mutar o array exposto deveria falhar',
            );

            assert.equal(state.select('products').length, 0, 'estado interno não deve ser afetado');
        });

        testRunner.it('getState congela objetos aninhados (settings)', async () => {
            const { state } = await createHarness();
            const snapshot = state.getState();

            await assert.throws(
                () => {
                    (snapshot.settings as { theme: string }).theme = 'dark';
                },
                'mutar settings aninhado deveria falhar',
            );

            assert.equal(state.select('settings').theme, 'light', 'preferência interna intacta');
        });

        testRunner.it('múltiplos setState no mesmo tick geram uma única escrita (coalescência)', async () => {
            const { state, driver } = await createHarness();
            const baseline = driver.writes;

            state.setState({ lastSyncAt: 1 });
            state.setState({ lastSyncAt: 2 });
            state.setState({ lastSyncAt: 3 });
            await state.flush();

            assert.equal(state.select('lastSyncAt'), 3, 'último valor deve prevalecer');
            assert.equal(driver.writes - baseline, 1, 'deve coalescer em uma única persistência');
        });

        testRunner.it('falha de persistência mantém o estado em memória e notifica o handler', async () => {
            const { state, driver } = await createHarness();

            let captured: unknown = null;
            state.onPersistError((error) => {
                captured = error;
            });

            driver.failNextWrite = true;
            state.setState({ lastSyncAt: 999 });
            await state.flush();

            assert.equal(state.select('lastSyncAt'), 999, 'valor deve permanecer visível para o usuário');
            assert.ok(captured !== null, 'handler de erro deve ter sido chamado');
        });

        testRunner.it('init() restaura estado salvo e faz merge de settings', async () => {
            const driver = new CountingDriver();
            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [driver]);
            await storage.init();

            // Simula um estado legado salvo sem os campos novos de `settings`.
            await storage.set(APP_STATE_KEY, {
                products: [],
                settings: { version: 1, theme: 'dark' },
                lastSyncAt: 555,
            });

            const state = new AppState<AppStateData>(storage, createInitialState());
            await state.init();
            const snapshot = state.getState();

            assert.equal(snapshot.settings.theme, 'dark', 'preferência salva deve ser restaurada');
            assert.equal(snapshot.settings.sidebarSide, 'left', 'campos ausentes usam o padrão');
            assert.equal(snapshot.lastSyncAt, 555, 'dados salvos devem ser restaurados');
            assert.ok(snapshot.formSchema.fields.length > 0, 'esquema padrão não deve ser apagado');
        });

        testRunner.it('subscribe devolve função de cancelamento que funciona', async () => {
            const { state } = await createHarness();

            let calls = 0;
            const unsubscribe = state.subscribe(() => {
                calls += 1;
            });

            state.setState({ lastSyncAt: 1 });
            unsubscribe();
            state.setState({ lastSyncAt: 2 });

            assert.equal(calls, 1, 'não deve notificar após o cancelamento');
        });
    });
}
